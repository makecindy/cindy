/**
 * dynamicSessionTitle —— 「动态任务标题」的唯一实现(main 侧)。
 *
 * 产品行为(设置 settings.sessionTitle,默认关):开启后,任务每轮收尾
 * (last_turn_ended_at 落库通知)自动把标题更新成 MMDD｜TYPE｜Topic ——
 * MMDD 由本侧按 Asia/Shanghai 从 created_at 计算,TYPE 取封闭词表英文码,
 * Topic 由 title oneShot 模型按当前对话实质概括。让侧边栏只看标题就能分辨
 * 任务的实质与进度,而不是停在「第一句话」。
 *
 * 保护与节制:
 *  - 用户手动改过名的任务永不覆盖(进程内记号 + userData 持久化);
 *  - 开关打开后会覆盖首条自动起名(例如「你好」)和本模式历史标题;
*  - per-session 冷却窗,连续短 turn 不放大模型调用;
 *  - 解析失败 / 模型无结果 / 供应商不可用 → 保留原标题,fire-and-forget,
 *    绝不阻塞 turn 主流程,也不向用户暴露失败。
 */

import type { AgentKind } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import {
  persistSessionTitleIfStillDraft,
  setOnSessionTurnEndedTitleRefresh,
} from '../localDb/ipc/sessions.js';
import {
  regenerateTitleMaterial,
  type RegenerateTitleMaterial,
} from '../localDb/latestMessageText.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { createLogger } from '../logger.js';
import { readSessionTitleSettings } from '../session-title-settings-store.js';
import { hasPersistedManualSessionTitleRename } from '../session-title-user-renames-store.js';
import { hasSessionBeenManuallyRenamed } from './sessionAutoTitle.js';
import {
  buildDynamicSessionTitle,
  parseDynamicTitleModelOutput,
  shouldAttemptDynamicTitle,
} from './dynamicSessionTitle.logic.js';
import { buildDynamicTitlePrompt } from './title-prompt.js';
import { generateDynamicTitleViaProvider } from './title.js';
import type { TitleOneShotResult } from '../maker-host/title-one-shot.js';

const log = createLogger('maker-ipc/session-dynamic-title');

/** 素材窗口与截断口径与 Magic 重命名一致(开场锚定主题,最近窗口反映进展)。 */
const RECENT_WINDOW = 8;
const OPENING_SLICE = 300;
const USER_SLICE = 300;
const ASSISTANT_SLICE = 400;

/** per-session 冷却窗:连续短 turn 不放大标题模型调用。 */
export const DYNAMIC_TITLE_MIN_INTERVAL_MS = 3 * 60 * 1000;

export interface DynamicTitleSessionRow {
  title: string;
  createdAt: number | null;
  agentKind: string;
  source: string;
  orcaRole: string | null;
  status: string;
}

export type DynamicTitleEligibility =
  | { ok: true; expectedTitle: string; createdAtMs: number; agentKind: AgentKind }
  | { ok: false; reason: string };

/**
 * 刷新资格:开关打开 = Cindy 可以改标题,除非用户手动改过名。
 * 首条自动起名(「你好」这类)必须能被覆盖,否则开关对真实任务永远不生效。
 */
export function resolveDynamicTitleEligibility(
  row: DynamicTitleSessionRow,
  manuallyRenamed: boolean,
): DynamicTitleEligibility {
  if (manuallyRenamed) return { ok: false, reason: 'manually-renamed' };
  if (row.status === 'deleted' || row.status === 'archived') {
    return { ok: false, reason: 'status' };
  }
  if (!(DESKTOP_VISIBLE_SESSION_SOURCES as readonly string[]).includes(row.source)) {
    return { ok: false, reason: 'source' };
  }
  if (row.orcaRole === 'worker') return { ok: false, reason: 'orca-worker' };
  if (row.createdAt == null) return { ok: false, reason: 'no-created-at' };
  const agentKind =
    row.agentKind === 'codex' || row.agentKind === 'pi' ? row.agentKind : 'claude-code';
  return {
    ok: true,
    expectedTitle: row.title,
    createdAtMs: row.createdAt,
    agentKind,
  };
}

export interface DynamicTitleDeps {
  readSettings: () => { dynamicTitleEnabled: boolean };
  readSessionRow: (sessionId: string) => Promise<DynamicTitleSessionRow | null>;
  collectMaterial: (
    sessionId: string,
    recentLimit: number,
  ) => Promise<RegenerateTitleMaterial>;
  generateTitle: (
    sessionId: string,
    agentKind: AgentKind,
    prompt: string,
  ) => Promise<TitleOneShotResult>;
  persistTitle: (sessionId: string, title: string, expectedTitle: string) => Promise<boolean>;
  hasBeenManuallyRenamed: (sessionId: string) => boolean;
  now: () => number;
}

async function readDynamicTitleSessionRowFromDb(
  sessionId: string,
): Promise<DynamicTitleSessionRow | null> {
  try {
    const [row] = await getDbClient()
      .drizzle.select({
        title: sessions.title,
        createdAt: sessions.createdAt,
        agentKind: sessions.agentKind,
        source: sessions.source,
        orcaRole: sessions.orcaRole,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    return {
      title: row.title ?? '',
      createdAt: row.createdAt ?? null,
      agentKind: row.agentKind,
      source: row.source,
      orcaRole: row.orcaRole ?? null,
      status: row.status,
    };
  } catch (err) {
    log.warn('dynamic title session read failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const defaultDeps: DynamicTitleDeps = {
  readSettings: () => readSessionTitleSettings(),
  readSessionRow: readDynamicTitleSessionRowFromDb,
  collectMaterial: (sessionId, recentLimit) => regenerateTitleMaterial(sessionId, recentLimit),
  generateTitle: generateDynamicTitleViaProvider,
  persistTitle: persistSessionTitleIfStillDraft,
  hasBeenManuallyRenamed: (sessionId) =>
    hasSessionBeenManuallyRenamed(sessionId) || hasPersistedManualSessionTitleRename(sessionId),
  now: () => Date.now(),
};

/** 每会话最近一次尝试时刻(含失败尝试,避免抖动放大调用)。 */
const lastAttemptAt = new Map<string, number>();

export async function refreshSessionDynamicTitle(
  sessionId: string,
  deps: DynamicTitleDeps = defaultDeps,
): Promise<{ applied: boolean }> {
  if (!sessionId) return { applied: false };
  if (!deps.readSettings().dynamicTitleEnabled) return { applied: false };

  const nowMs = deps.now();
  if (
    !shouldAttemptDynamicTitle({
      nowMs,
      lastAttemptMs: lastAttemptAt.get(sessionId) ?? null,
      minIntervalMs: DYNAMIC_TITLE_MIN_INTERVAL_MS,
    })
  ) {
    return { applied: false };
  }
  lastAttemptAt.set(sessionId, nowMs);

  const row = await deps.readSessionRow(sessionId);
  if (!row) return { applied: false };
  const eligibility = resolveDynamicTitleEligibility(
    row,
    deps.hasBeenManuallyRenamed(sessionId),
  );
  if (!eligibility.ok) {
    log.info('dynamic title refresh skipped', { sessionId, reason: eligibility.reason });
    return { applied: false };
  }

  try {
    const material = await deps.collectMaterial(sessionId, RECENT_WINDOW);
    if (material.recent.length === 0) return { applied: false };
    const openingInWindow =
      material.opening.rowid != null &&
      material.recent.some((message) => message.rowid === material.opening.rowid);
    const openingText =
      !openingInWindow && material.opening.text
        ? material.opening.text.slice(0, OPENING_SLICE)
        : null;
    const transcript = material.recent
      .map((message) =>
        message.role === 'user'
          ? 'User: ' + message.text.slice(0, USER_SLICE)
          : 'Assistant: ' + message.text.slice(0, ASSISTANT_SLICE),
      )
      .join('\n');

    const generated = await deps.generateTitle(
      sessionId,
      eligibility.agentKind,
      buildDynamicTitlePrompt(openingText, transcript),
    );
    if (generated.status !== 'ok') {
      log.warn('dynamic title generation failed', { sessionId, reason: generated.status });
      return { applied: false };
    }
    const parsed = parseDynamicTitleModelOutput(generated.title);
    if (!parsed) {
      log.warn('dynamic title rejected model output', { sessionId });
      return { applied: false };
    }
    const title = buildDynamicSessionTitle({
      createdAtMs: eligibility.createdAtMs,
      typeLabel: parsed.typeLabel,
      topic: parsed.topic,
    });
    if (!title || title === eligibility.expectedTitle) return { applied: false };

    const applied = await deps.persistTitle(sessionId, title, eligibility.expectedTitle);
    if (applied) log.info('dynamic title applied', { sessionId, title });
    return { applied };
  } catch (err) {
    log.warn('dynamic title refresh failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { applied: false };
  }
}

/** fire-and-forget 版:turn 收尾路径调用,不等待结果。 */
export function scheduleSessionDynamicTitle(
  sessionId: string,
  deps: DynamicTitleDeps = defaultDeps,
): void {
  void refreshSessionDynamicTitle(sessionId, deps).catch((err) => {
    log.warn('dynamic title schedule failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** 接上 turn ended 落库通知。register 时调用一次(重复调用幂等,后者覆盖)。 */
export function registerSessionDynamicTitleHooks(): void {
  setOnSessionTurnEndedTitleRefresh((sessionId) => scheduleSessionDynamicTitle(sessionId));
}

/** 测试专用:清空冷却表。 */
export function __resetSessionDynamicTitleStateForTest(): void {
  lastAttemptAt.clear();
}
