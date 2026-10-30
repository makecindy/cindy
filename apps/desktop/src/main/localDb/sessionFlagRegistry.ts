import { eq, isNotNull, or } from 'drizzle-orm';
import type { DbClient } from './client/DbClient.js';
import * as currentDb from './client/current.js';
import { sessions } from './schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('session-flag-registry');

/**
 * 决定「这个任务要不要发提醒」的两列 per-session 标记的进程内同步索引：
 * - `sessions.hidden_at` 非空：插件后台隐藏任务；
 * - `sessions.notifications_muted` 为真：用户开了「消息免打扰」。
 *
 * Agent 灵动岛、菜单栏运行状态与系统通知走同步事件路径，不能每个事件都查库；
 * 这里按当前账号数据库缓存这两份 id 集合。数据库仍是唯一事实来源：
 * - 账号数据库切换后首次访问会重新加载（加载前按「未隐藏 / 未静音」处理，
 *   宁可多提醒一次）；
 * - 宿主写入这两列的唯一入口同步调用 {@link noteSessionHidden} /
 *   {@link noteSessionNotificationsMuted}。
 */
let owner: DbClient | null = null;
let hiddenIds = new Set<string>();
let mutedIds = new Set<string>();
let loaded = false;
let loading: Promise<void> | null = null;
/** 加载期间已被宿主显式改动的 id（按字段分开记）：加载结果不得覆盖这些更新的事实。 */
let touchedHiddenDuringLoad = new Set<string>();
let touchedMutedDuringLoad = new Set<string>();
/** 加载失败后的重试冷却：同步判定在每个 Agent 事件上调用，不能把失败放大成逐事件查库。 */
const RETRY_AFTER_FAILURE_MS = 30_000;
let failedAt = 0;

function currentClient(): DbClient | null {
  // 与 sessions:list 读快照同一纪律:启动/切账号窗口内读不到就按「无账号库」处理。
  try {
    return currentDb.getCurrentDbClientSnapshot?.()?.client ?? null;
  } catch {
    return null;
  }
}

function adopt(client: DbClient): void {
  if (owner === client) return;
  owner = client;
  hiddenIds = new Set();
  mutedIds = new Set();
  loaded = false;
  loading = null;
  touchedHiddenDuringLoad = new Set<string>();
  touchedMutedDuringLoad = new Set<string>();
  failedAt = 0;
}

/** 当前账号数据库的标记索引尚未加载时启动一次加载；已加载或加载中直接复用。 */
export function ensureSessionFlagRegistryLoaded(): Promise<void> {
  const client = currentClient();
  if (!client) return Promise.resolve();
  adopt(client);
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve();
  let pending: Promise<void> | null = null;
  pending = (async () => {
    try {
      const rows = await client.drizzle
        .select({
          id: sessions.id,
          hiddenAt: sessions.hiddenAt,
          notificationsMuted: sessions.notificationsMuted,
        })
        .from(sessions)
        .where(or(isNotNull(sessions.hiddenAt), eq(sessions.notificationsMuted, true)));
      if (owner !== client) return;
      for (const row of rows) {
        // 两列各管各的：只跳过加载期间真被改过的那个字段，否则「加载中顺手把
        // 另一个字段改一下」会连带丢掉这一行原有的另一个标记。
        if (!touchedHiddenDuringLoad.has(row.id) && row.hiddenAt != null) hiddenIds.add(row.id);
        if (!touchedMutedDuringLoad.has(row.id) && row.notificationsMuted) mutedIds.add(row.id);
      }
      loaded = true;
      touchedHiddenDuringLoad = new Set<string>();
      touchedMutedDuringLoad = new Set<string>();
    } catch (error) {
      if (owner === client) failedAt = Date.now();
      log.warn('load session flags failed', {
        err: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (owner === client && loading === pending) loading = null;
    }
  })();
  loading = pending;
  return pending;
}

/** 同步判断：当前账号下该任务是否为插件后台隐藏任务。未加载时触发加载并按可见处理。 */
export function isSessionHiddenSync(sessionId: string): boolean {
  const client = currentClient();
  if (!client) return false;
  if (owner !== client || !loaded) void ensureSessionFlagRegistryLoaded();
  return owner === client && hiddenIds.has(sessionId);
}

/** 同步判断：当前账号下该任务是否开了「消息免打扰」。未加载时触发加载并按未静音处理。 */
export function isSessionNotificationsMutedSync(sessionId: string): boolean {
  const client = currentClient();
  if (!client) return false;
  if (owner !== client || !loaded) void ensureSessionFlagRegistryLoaded();
  return owner === client && mutedIds.has(sessionId);
}

/** 宿主写入 hidden_at 后同步登记（hidden=true 隐藏，false 恢复可见）。 */
export function noteSessionHidden(sessionId: string, hidden: boolean, client = currentClient()): void {
  if (!client || client !== currentClient()) return;
  adopt(client);
  if (!loaded) touchedHiddenDuringLoad.add(sessionId);
  if (hidden) hiddenIds.add(sessionId);
  else hiddenIds.delete(sessionId);
  if (!loaded) void ensureSessionFlagRegistryLoaded();
}

/** 宿主写入 notifications_muted 后同步登记。 */
export function noteSessionNotificationsMuted(
  sessionId: string,
  muted: boolean,
  client = currentClient(),
): void {
  if (!client || client !== currentClient()) return;
  adopt(client);
  if (!loaded) touchedMutedDuringLoad.add(sessionId);
  if (muted) mutedIds.add(sessionId);
  else mutedIds.delete(sessionId);
  if (!loaded) void ensureSessionFlagRegistryLoaded();
}

/** 仅供测试。 */
export function resetSessionFlagRegistryForTesting(): void {
  owner = null;
  hiddenIds = new Set();
  mutedIds = new Set();
  loaded = false;
  loading = null;
  touchedHiddenDuringLoad = new Set<string>();
  touchedMutedDuringLoad = new Set<string>();
  failedAt = 0;
}
