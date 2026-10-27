import { isNotNull } from 'drizzle-orm';
import type { DbClient } from './client/DbClient.js';
import * as currentDb from './client/current.js';
import { sessions } from './schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('hidden-session-registry');

/**
 * 插件后台隐藏任务（`sessions.hidden_at` 非空）的进程内同步索引。
 *
 * Agent 灵动岛、菜单栏运行状态与系统通知走同步事件路径，不能每个事件都查库；
 * 这里按当前账号数据库缓存一份隐藏任务 id。数据库仍是唯一事实来源：
 * - 账号数据库切换后首次访问会重新加载（加载前按「未隐藏」处理，宁可多显示一次）；
 * - 宿主写入 hidden_at 的唯一入口（创建 / setHidden / 卸载显示）同步调用 {@link noteSessionHidden}。
 */
let owner: DbClient | null = null;
let hiddenIds = new Set<string>();
let loaded = false;
let loading: Promise<void> | null = null;
/** 加载期间已被宿主显式改动的 id：加载结果不得覆盖这些更新的事实。 */
let touchedDuringLoad = new Set<string>();
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
  loaded = false;
  loading = null;
  touchedDuringLoad = new Set();
  failedAt = 0;
}

/** 当前账号数据库的隐藏任务索引尚未加载时启动一次加载；已加载或加载中直接复用。 */
export function ensureHiddenSessionRegistryLoaded(): Promise<void> {
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
        .select({ id: sessions.id })
        .from(sessions)
        .where(isNotNull(sessions.hiddenAt));
      if (owner !== client) return;
      for (const row of rows) {
        if (!touchedDuringLoad.has(row.id)) hiddenIds.add(row.id);
      }
      loaded = true;
      touchedDuringLoad = new Set();
    } catch (error) {
      if (owner === client) failedAt = Date.now();
      log.warn('load hidden sessions failed', {
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
  if (owner !== client || !loaded) void ensureHiddenSessionRegistryLoaded();
  return owner === client && hiddenIds.has(sessionId);
}

/** 宿主写入 hidden_at 后同步登记（hidden=true 隐藏，false 恢复可见）。 */
export function noteSessionHidden(sessionId: string, hidden: boolean, client = currentClient()): void {
  if (!client || client !== currentClient()) return;
  adopt(client);
  if (!loaded) touchedDuringLoad.add(sessionId);
  if (hidden) hiddenIds.add(sessionId);
  else hiddenIds.delete(sessionId);
  if (!loaded) void ensureHiddenSessionRegistryLoaded();
}

/** 仅供测试。 */
export function resetHiddenSessionRegistryForTesting(): void {
  owner = null;
  hiddenIds = new Set();
  loaded = false;
  loading = null;
  touchedDuringLoad = new Set();
  failedAt = 0;
}
