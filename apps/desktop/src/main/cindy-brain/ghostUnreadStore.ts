/**
 * ghostUnreadStore.ts — 意识未读角标的落盘账本(badge 槽,2026-08-03)。
 * ---------------------------------------------------------------------------
 * 未读点必须**跨重启存活**:意识在后台点亮了角标,用户关掉 app 再打开,那条
 * 「有新内容」不该凭空消失(否则未读机制退化成一次性 toast,与 notify 无异)。
 *
 * 归属:与 ghostRecentUsageStore 同款,落在 `ownerScopedUserDataPath()` 下,
 * 天然按账号隔离——账号 A 的未读不会在账号 B 的界面上点亮。
 *
 * 存的是**主机自己判定过的事实**:summary 在写入前已由 badgeSlot 净化限长,
 * 这里只做形状归一(损坏配置不阻断插件页首屏,读失败一律降级成"无未读")。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import Store from 'electron-store';

import { GHOST_BADGE_SUMMARY_MAX_CHARS, isValidGhostId } from '../../shared/ghost.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

/** 一条未读记录(ghostId → 最近一次点亮的摘要与时刻)。 */
export interface GhostUnreadEntry {
  ghostId: string;
  /** 意识给的一句话摘要(已净化限长;缺省 = 只点亮不带文案)。 */
  summary?: string;
  /** 点亮时刻(epoch ms;插件卡按它排"最新一条")。 */
  at: number;
}

interface GhostUnreadShape {
  entries: Record<string, { summary?: string; at: number }>;
}

/** 账本条目上限:未读是"当前还亮着的",不是历史流水,不该无限长。 */
const MAX_UNREAD_ENTRIES = 200;

let storeInstance: Store<GhostUnreadShape> | null = null;
let storePath: string | null = null;

function getStore(): Store<GhostUnreadShape> {
  const currentPath = ownerScopedUserDataPath();
  if (!storeInstance || storePath !== currentPath) {
    storeInstance = new Store<GhostUnreadShape>({
      name: 'ghost-unread',
      cwd: currentPath,
      defaults: { entries: {} },
      schema: { entries: { type: 'object' } },
      clearInvalidConfig: true,
    });
    storePath = currentPath;
  }
  return storeInstance;
}

/**
 * 落盘形状归一:非法 id / 非法时刻整条丢弃,summary 非字符串或超限时**只丢
 * summary 不丢点**——角标本身是"有新内容"这条事实,不该被一段坏文案连坐。
 * 按 at 倒序截断到上限。
 */
export function normalizeGhostUnreadEntries(value: unknown): GhostUnreadEntry[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const entries: GhostUnreadEntry[] = [];
  for (const [ghostId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidGhostId(ghostId)) continue;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const at = (raw as { at?: unknown }).at;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    const summary = (raw as { summary?: unknown }).summary;
    const keepSummary =
      typeof summary === 'string' &&
      summary.length > 0 &&
      summary.length <= GHOST_BADGE_SUMMARY_MAX_CHARS;
    entries.push({ ghostId, ...(keepSummary ? { summary: summary as string } : {}), at });
  }
  entries.sort((a, b) => b.at - a.at);
  return entries.slice(0, MAX_UNREAD_ENTRIES);
}

function persist(entries: GhostUnreadEntry[]): void {
  const shape: GhostUnreadShape['entries'] = {};
  for (const entry of entries) {
    shape[entry.ghostId] = { ...(entry.summary ? { summary: entry.summary } : {}), at: entry.at };
  }
  getStore().set('entries', shape);
}

/**
 * 这次清除是否**陈旧**(账本里的记录比请求方看到的那条新)。抽成导出的纯函数
 * 是为了能直测:clearGhostUnread 本身要 electron-store,单测碰不到。
 */
export function isStaleGhostUnreadClear(entryAt: number, seenAt?: number): boolean {
  return seenAt !== undefined && entryAt > seenAt;
}

/** 当前还亮着的全部未读(最新在前)。 */
export function loadGhostUnread(): GhostUnreadEntry[] {
  return normalizeGhostUnreadEntries(getStore().get('entries', {}));
}

/** 某意识当前的未读记录(没有则 null)。停用后重新启用时靠它把点找回来。 */
export function readGhostUnread(ghostId: string): GhostUnreadEntry | null {
  return loadGhostUnread().find((entry) => entry.ghostId === ghostId) ?? null;
}

/**
 * 点亮一条未读(同一意识重复点亮 = 覆盖摘要并刷新时刻,不堆叠——角标是
 * 幂等的"有/无",不是消息队列)。
 *
 * 返回 `evicted` = 因触到上限而被挤掉的 ghostId。调用方**必须**为它们补一条
 * `unread:false` 广播:只推新点亮那一条的话,renderer 的表里会留着已被账本
 * 删掉的条目,那颗点和聚合入口点会一直亮到重启或下一次全量快照(codex review)。
 */
export function markGhostUnread(
  ghostId: string,
  summary: string | undefined,
  at: number,
): { entries: GhostUnreadEntry[]; evicted: string[] } {
  const result = applyGhostUnreadMark(loadGhostUnread(), {
    ghostId,
    ...(summary ? { summary } : {}),
    at,
  });
  persist(result.entries);
  return result;
}

/**
 * markGhostUnread 的纯函数内核(抽出来只为可测:落盘那层要 electron-store)。
 * 同 id 覆盖而不堆叠,按时刻倒序,超出上限的挤出去并如实报给调用方。
 */
export function applyGhostUnreadMark(
  current: GhostUnreadEntry[],
  entry: GhostUnreadEntry,
  max = MAX_UNREAD_ENTRIES,
): { entries: GhostUnreadEntry[]; evicted: string[] } {
  const sorted = [entry, ...current.filter((candidate) => candidate.ghostId !== entry.ghostId)].sort(
    (a, b) => b.at - a.at,
  );
  return {
    entries: sorted.slice(0, max),
    evicted: sorted.slice(max).map((candidate) => candidate.ghostId),
  };
}

/**
 * 熄灭一条未读。返回 null = 没有发生变化(调用方据此免掉一次无意义广播,
 * 别让"打开面板"每次都刷一轮全窗口推送)。
 *
 * `seenAt` = **请求方当时实际看到的那条**的点亮时刻。给了就做条件删除:账本里
 * 的记录比它新时不动。用户已读是针对他看见的那条内容,而 renderer 的清除请求
 * 与插件的新点亮走的是两条独立 IPC——"新点亮先到、旧清除后到"的顺序完全可能
 * 发生,无条件按 ghostId 删会把用户还没看到的新摘要一并抹掉(codex review)。
 * 不给 seenAt 则是主机侧的无条件熄灭(停用 / 卸载 / 能力撤销),那些场景没有
 * "看见了哪一条"可言。
 */
export function clearGhostUnread(ghostId: string, seenAt?: number): GhostUnreadEntry[] | null {
  const current = loadGhostUnread();
  const entry = current.find((candidate) => candidate.ghostId === ghostId);
  if (!entry) return null;
  if (isStaleGhostUnreadClear(entry.at, seenAt)) return null;
  const next = current.filter((candidate) => candidate.ghostId !== ghostId);
  persist(next);
  return next;
}
