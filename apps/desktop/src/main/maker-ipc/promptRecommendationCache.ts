/**
 * promptRecommendationCache.ts — 输入框「输入建议」的持久缓存。
 * ---------------------------------------------------------------------------
 * 为什么需要它：打开历史任务时也要补一次下一步建议（issue #6184）。同一完成点
 * （sessionId + lastTurnEndedAt）最多生成一次模型调用，之后重开、重启、从手机看
 * 都直接复用。没有这层缓存，历史补生成会在每次重启后重新付费。
 *
 * 每个会话只保留最新完成点一条；revision 或 workingDir 不匹配即视为失效。
 * 归属：electron-store + `ownerScopedUserDataPath()`，天然按 Cindy 账号隔离。
 * 条目随会话删除清理（见 session 删除入口），容量超过上限时按 createdAt 淘汰最旧。
 *
 * 这是派生 UI 数据，不是业务真相：损坏、读失败、写失败一律降级成「未命中」，
 * 最多让用户多等一次生成，不阻断预测主路径。
 *
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import Store from 'electron-store';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('maker-ipc/prompt-recommendation-cache');

export interface CachedPromptRecommendation {
  /** 生成时该会话的 lastTurnEndedAt；新完成点到来即失效。 */
  revision: number;
  /** 生成时的 workingDir；目录变更后旧结果不适用。 */
  workingDir: string | null;
  prompt: string;
  createdAt: number;
}

interface PromptRecommendationCacheShape {
  sessions: Record<string, CachedPromptRecommendation>;
}

/** 账本条目上限：每个会话只留最新一条，这里限制的是会话数。 */
const MAX_CACHED_SESSIONS = 500;

let storeInstance: Store<PromptRecommendationCacheShape> | null = null;
let storePath: string | null = null;

function getStore(): Store<PromptRecommendationCacheShape> {
  const currentPath = ownerScopedUserDataPath();
  if (!storeInstance || storePath !== currentPath) {
    storeInstance = new Store<PromptRecommendationCacheShape>({
      name: 'prompt-recommendations',
      cwd: currentPath,
      defaults: { sessions: {} },
      schema: { sessions: { type: 'object' } },
      clearInvalidConfig: true,
    });
    storePath = currentPath;
  }
  return storeInstance;
}

function isValidEntry(value: unknown): value is CachedPromptRecommendation {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CachedPromptRecommendation>;
  return (
    typeof entry.revision === 'number' &&
    Number.isSafeInteger(entry.revision) &&
    entry.revision > 0 &&
    (entry.workingDir === null || typeof entry.workingDir === 'string') &&
    typeof entry.prompt === 'string' &&
    entry.prompt.length > 0 &&
    Number.isFinite(entry.createdAt)
  );
}

/** 命中条件 = revision 与 workingDir 都一致；损坏条目按未命中处理。 */
export function pickCachedPrompt(
  sessions: Record<string, unknown>,
  sessionId: string,
  revision: number,
  workingDir: string | null,
): string | null {
  const entry = sessions[sessionId];
  if (!isValidEntry(entry)) return null;
  if (entry.revision !== revision) return null;
  if ((entry.workingDir ?? null) !== (workingDir ?? null)) return null;
  return entry.prompt;
}

/** 超过容量时按 createdAt 淘汰最旧。 */
export function pruneCachedEntries(
  sessions: Record<string, CachedPromptRecommendation>,
  max: number = MAX_CACHED_SESSIONS,
): Record<string, CachedPromptRecommendation> {
  const keys = Object.keys(sessions);
  if (keys.length <= max) return sessions;
  const ordered = keys
    .map((sessionId) => ({ sessionId, createdAt: sessions[sessionId]?.createdAt ?? 0 }))
    .sort((a, b) => a.createdAt - b.createdAt);
  const next = { ...sessions };
  for (const { sessionId } of ordered.slice(0, ordered.length - max)) {
    delete next[sessionId];
  }
  return next;
}

export function readCachedPromptRecommendation(
  sessionId: string,
  revision: number,
  workingDir: string | null,
): string | null {
  try {
    return pickCachedPrompt(getStore().get('sessions'), sessionId, revision, workingDir);
  } catch (error) {
    log.warn('read prompt recommendation cache failed', { sessionId, error });
    return null;
  }
}

export function writeCachedPromptRecommendation(
  sessionId: string,
  recommendation: { revision: number; workingDir: string | null; prompt: string },
): void {
  try {
    const store = getStore();
    const sessions = { ...store.get('sessions') };
    sessions[sessionId] = {
      revision: recommendation.revision,
      workingDir: recommendation.workingDir,
      prompt: recommendation.prompt,
      createdAt: Date.now(),
    };
    store.set('sessions', pruneCachedEntries(sessions));
  } catch (error) {
    // 写失败不阻断本次返回：结果照常展示，只是下次需要再生成。
    log.warn('write prompt recommendation cache failed', { sessionId, error });
  }
}

export function clearCachedPromptRecommendation(sessionId: string): void {
  try {
    const store = getStore();
    const sessions = { ...store.get('sessions') };
    if (!(sessionId in sessions)) return;
    delete sessions[sessionId];
    store.set('sessions', sessions);
  } catch (error) {
    log.warn('clear prompt recommendation cache failed', { sessionId, error });
  }
}

/** 测试用：重置模块级单例，避免跨用例串数据。 */
export function __resetPromptRecommendationCacheForTests(): void {
  storeInstance = null;
  storePath = null;
}

export const __testing = { isValidEntry, MAX_CACHED_SESSIONS };
