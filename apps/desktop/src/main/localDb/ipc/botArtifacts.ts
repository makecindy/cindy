/**
 * 每伙伴「交付物仓库」的只读投影。
 * ---------------------------------------------------------------------------
 * 纯派生,不新增 schema、不新增写入路径。三条来源(见 shared/botArtifact.ts):
 *
 *   1. `bot_delegations.output_artifacts_json`,按 **targetBotId** 归属 —— 产物是
 *      被委派方做出来的,不是发起方。
 *   2. 伙伴名下 Session(canonical / route / history)里的 `tool_use` 新建文件。
 *   3. 同批 Session 消息里的文件附件(`content.files[]`)。
 *
 * 存在性门槛:有本机绝对路径的交付物在返回前 `stat` 一次,不存在 / 非普通文件的
 * 直接摘掉(DESIGN.md §14.5 「本机会话走真实存在性检查」)。协议引用类(cindy-media://
 * / xdt-*://)不 stat —— 媒体仓绝对路径不出主进程,存在性由协议 handler 自己兜底。
 *
 * 已知降级(如实登记,不隐藏):
 *   - SSH 远端 workingDir 的伙伴会话:`stat` 打在本机,一律失败 → 该会话的
 *     generated / attachment 交付物不出现。委派产物(协议引用)不受影响。
 *   - device-link 远程会话:本 channel **不进** REMOTE_INVOKE_ALLOWLIST,远端不可读;
 *     renderer 侧对应地隐藏仓库面板。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { ipcMain } from 'electron';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { describeToolUse } from '@cindy/maker-shared/tool-use-descriptor';

import { getDbClient, tryGetDbClient } from '../client/current';
import { botDelegations, botProfiles, botSessionLinks, messages, sessions } from '../schema';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { parseBotOutputArtifacts } from '../../../shared/botOutputArtifact.js';
import {
  BOT_ARTIFACT_LIMIT,
  BOT_ARTIFACT_MESSAGE_SCAN_LIMIT,
  botArtifactDisplayName,
  makeBotArtifact,
  type BotArtifactItem,
  type BotArtifactProjection,
} from '../../../shared/botArtifact.js';

/** 委派行扫描上限。与消息扫描分开:委派表小得多,不必占消息预算。 */
const DELEGATION_SCAN_LIMIT = 300;

/** 每返回 1 件就最多 stat 这么多候选,给存在性过滤留余量,同时封住磁盘开销。 */
const STAT_CANDIDATE_FACTOR = 4;

interface MessageRowLike {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
}

function parseContent(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `tool_use` 消息 → 本条新建的文件原始路径(与 generatedFiles.ts 同口径:只收新建)。 */
export function createdPathsFromToolUseContent(content: Record<string, unknown>): string[] {
  const toolName = typeof content.toolName === 'string' ? content.toolName : '';
  if (!toolName) return [];
  const descriptor = describeToolUse(toolName, content.input ?? null);
  if (descriptor.kind === 'file') {
    return descriptor.action === 'create' && descriptor.filePath ? [descriptor.filePath] : [];
  }
  if (descriptor.kind === 'fileChange') {
    return descriptor.changes
      .filter((change) => change.action === 'add' && change.path)
      .map((change) => change.path);
  }
  return [];
}

/** 消息 `content.files[]`(FileRef:{ name, path, size?, sha256? })→ 附件条目原料。 */
export function attachmentRefsFromContent(
  content: Record<string, unknown>,
): Array<{ name: string; path: string; size: number | null }> {
  const files = content.files;
  if (!Array.isArray(files)) return [];
  const out: Array<{ name: string; path: string; size: number | null }> = [];
  for (const entry of files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const candidate = entry as { name?: unknown; path?: unknown; size?: unknown };
    if (typeof candidate.path !== 'string' || !candidate.path) continue;
    const name = typeof candidate.name === 'string' && candidate.name
      ? candidate.name
      : botArtifactDisplayName(candidate.path);
    out.push({
      name,
      path: candidate.path,
      size:
        typeof candidate.size === 'number' && Number.isFinite(candidate.size) && candidate.size >= 0
          ? candidate.size
          : null,
    });
  }
  return out;
}

/** 相对路径按会话 workingDir 解析;拿不到 workingDir 时保持原样(后续 stat 会摘掉)。 */
function resolveArtifactPath(rawPath: string, workingDir: string | null): string {
  if (!rawPath) return rawPath;
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) return rawPath;
  if (!workingDir) return rawPath;
  return path.resolve(workingDir, rawPath);
}

/**
 * 同一件东西可能被多条来源看到 —— 保留**最早**的那次交付时间(那才是「做出来的
 * 时刻」),但让来源优先级高的条目决定展示信息:generated > attachment > delegation。
 */
const SOURCE_RANK: Record<BotArtifactItem['source'], number> = {
  generated: 0,
  attachment: 1,
  delegation: 2,
};

export function mergeBotArtifacts(items: BotArtifactItem[]): BotArtifactItem[] {
  const byKey = new Map<string, BotArtifactItem>();
  for (const item of items) {
    if (!item.id) continue;
    const existing = byKey.get(item.id);
    if (!existing) {
      byKey.set(item.id, item);
      continue;
    }
    const winner = SOURCE_RANK[item.source] < SOURCE_RANK[existing.source] ? item : existing;
    const loser = winner === item ? existing : item;
    byKey.set(item.id, {
      ...winner,
      createdAt: Math.min(winner.createdAt, loser.createdAt),
      sizeBytes: winner.sizeBytes ?? loser.sizeBytes,
      sessionId: winner.sessionId ?? loser.sessionId,
      delegationId: winner.delegationId ?? loser.delegationId,
    });
  }
  return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** 存在性过滤 + 用 stat 补齐体积。协议引用直接放行。 */
async function keepExistingFiles(items: BotArtifactItem[]): Promise<BotArtifactItem[]> {
  const checked = await Promise.all(
    items.map(async (item) => {
      if (!item.path) return item;
      try {
        const stat = await fs.stat(item.path);
        if (!stat.isFile()) return null;
        return item.sizeBytes === null ? { ...item, sizeBytes: stat.size } : item;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((item): item is BotArtifactItem => item !== null);
}

export interface ListBotArtifactsInput {
  botId?: string;
  sessionId?: string;
  limit?: number;
}

/**
 * 解析归属伙伴:显式 botId 优先,否则用会话反查 `bot_session_links`。
 * 两者都给不出 → NOT_FOUND(不猜、不回落到「全部伙伴」)。
 */
async function resolveBotId(input: ListBotArtifactsInput): Promise<string> {
  const db = getDbClient().drizzle;
  if (typeof input.botId === 'string' && input.botId) {
    const [profile] = await db
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(eq(botProfiles.id, input.botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    return profile.id;
  }
  if (typeof input.sessionId === 'string' && input.sessionId) {
    const [link] = await db
      .select({ botId: botSessionLinks.botId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, input.sessionId))
      .limit(1);
    if (!link) throwIpcError('NOT_FOUND', '该任务不属于任何伙伴');
    return link.botId;
  }
  return throwIpcError('INVALID_PARAMS', 'botId 或 sessionId 至少给一个');
}

export async function listBotArtifacts(
  input: ListBotArtifactsInput,
): Promise<BotArtifactProjection> {
  const botId = await resolveBotId(input);
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(BOT_ARTIFACT_LIMIT, Math.floor(input.limit)))
    : BOT_ARTIFACT_LIMIT;
  const db = getDbClient().drizzle;

  // ── 来源 1:委派回传的协议引用(按被委派方归属)。
  const delegationRows = await db
    .select({
      id: botDelegations.id,
      childSessionId: botDelegations.childSessionId,
      outputArtifactsJson: botDelegations.outputArtifactsJson,
      completedAt: botDelegations.completedAt,
      updatedAt: botDelegations.updatedAt,
    })
    .from(botDelegations)
    .where(eq(botDelegations.targetBotId, botId))
    .orderBy(desc(botDelegations.updatedAt))
    .limit(DELEGATION_SCAN_LIMIT);

  const raw: BotArtifactItem[] = [];
  for (const row of delegationRows) {
    for (const artifact of parseBotOutputArtifacts(row.outputArtifactsJson)) {
      raw.push(
        makeBotArtifact({
          source: 'delegation',
          target: artifact.ref,
          isRef: true,
          createdAt: row.completedAt ?? row.updatedAt,
          sessionId: row.childSessionId,
          delegationId: row.id,
        }),
      );
    }
  }

  // ── 来源 2 / 3:伙伴名下会话的消息。
  const links = await db
    .select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.botId, botId));
  const sessionIds = links.map((link) => link.sessionId);

  if (sessionIds.length > 0) {
    const workdirRows = await db
      .select({ id: sessions.id, workingDir: sessions.workingDir })
      .from(sessions)
      .where(inArray(sessions.id, sessionIds));
    const workdirBySession = new Map(workdirRows.map((row) => [row.id, row.workingDir]));

    const messageRows: MessageRowLike[] = await db
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(inArray(messages.sessionId, sessionIds), isNull(messages.rewindAt)))
      .orderBy(desc(messages.createdAt))
      .limit(BOT_ARTIFACT_MESSAGE_SCAN_LIMIT);

    for (const row of messageRows) {
      const content = parseContent(row.content);
      if (!content) continue;
      const workingDir = workdirBySession.get(row.sessionId) ?? null;
      if (row.role === 'tool_use') {
        for (const rawPath of createdPathsFromToolUseContent(content)) {
          raw.push(
            makeBotArtifact({
              source: 'generated',
              target: resolveArtifactPath(rawPath, workingDir),
              isRef: false,
              createdAt: row.createdAt,
              sessionId: row.sessionId,
              delegationId: null,
            }),
          );
        }
        continue;
      }
      for (const file of attachmentRefsFromContent(content)) {
        raw.push(
          makeBotArtifact({
            source: 'attachment',
            target: resolveArtifactPath(file.path, workingDir),
            isRef: false,
            name: file.name,
            sizeBytes: file.size,
            createdAt: row.createdAt,
            sessionId: row.sessionId,
            delegationId: null,
          }),
        );
      }
    }
  }

  const merged = mergeBotArtifacts(raw);
  // stat 是这条链上唯一的磁盘开销,不能跟着历史长度线性增长。列表已按时间倒序,
  // 只核验够填满一屏上限的那批候选(留出被存在性过滤掉的余量)。
  const candidates = merged.slice(0, limit * STAT_CANDIDATE_FACTOR);
  const existing = await keepExistingFiles(candidates);
  return {
    botId,
    items: existing.slice(0, limit),
    truncated: existing.length > limit || merged.length > candidates.length,
  };
}

export function registerBotArtifactIpc(): void {
  ipcMain.handle('local-db:bots:artifacts', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!tryGetDbClient()) {
      return { botId: '', items: [], truncated: false } satisfies BotArtifactProjection;
    }
    const body = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    return listBotArtifacts({
      ...(typeof body.botId === 'string' ? { botId: body.botId.slice(0, 128) } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId.slice(0, 128) } : {}),
      ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
    });
  });
}
