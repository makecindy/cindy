/**
 * botReadState — per-Bot read position for the Bots list unread badges.
 * ---------------------------------------------------------------------------
 * 设计取舍:
 *   - **权威读位在这台电脑的 main**(`main/maker-ipc/botReadStateStore.ts`,按账号落盘)。
 *     手机与其他电脑经伙伴的远程资源 `read` 动作推进同一份读位,所以在哪台设备看过,
 *     其他设备的角标都会清掉(docs/product-rules/cindy-bots-runtime.md「导航未读与系统角标」)。
 *   - renderer 保留一份 localStorage 副本:首帧同步可读、同机多窗口经 storage 事件即时更新,
 *     main 不可用时退回本机语义。key 按数据主人分命名空间(见 `setBotReadStateOwner`,
 *     由 AuthContext 在 owner 切换时调用)。
 *   - 两边只按「取较新」合并:本地推进时上报 main(`mark`),新伙伴的初始读位按「没有才写」
 *     上报(`seed`);切换账号后把本地副本作为 seed 交给 main(升级时迁移旧读位,
 *     已有的读位不被覆盖),再把 main 的读位合并回来;main 的变化推送同样合并。
 *   - 读位只前进不后退(`markBotRead` 单调),避免乱序事件把已读退回未读。
 */

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupSummary } from '../../../shared/botGroupChat';

const STORAGE_KEY_PREFIX = 'cindy.bots.readState.v1';

type ReadStateMap = Record<string, number>;

let activeOwnerId: string | null = null;
let cache: ReadStateMap | null = null;
const subscribers = new Set<() => void>();

function storageKey(): string {
  return `${STORAGE_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

function readStorage(): ReadStateMap {
  if (cache) return cache;
  const next: ReadStateMap = {};
  try {
    const raw = window.localStorage.getItem(storageKey());
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [botId, at] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) next[botId] = at;
      }
    }
  } catch {
    // Corrupt or unavailable storage degrades to "nothing read yet", which only
    // costs a badge — never a crash in the sidebar.
  }
  cache = next;
  return next;
}

type HostReadState = { ownerId: string | null; positions: Record<string, number> };
type HostReadApi = {
  get: () => Promise<HostReadState>;
  update: (body: { ownerId: string; mark?: ReadStateMap; seed?: ReadStateMap; prune?: { botIds?: string[]; groupIds?: string[] } }) => Promise<HostReadState>;
  onChanged: (callback: (payload: unknown, ownerStamp?: unknown) => void) => () => void;
};

function hostApi(): HostReadApi | undefined {
  return (window as unknown as { electronAPI?: { localDb?: { bots?: { readState?: HostReadApi } } } })
    .electronAPI?.localDb?.bots?.readState;
}

let hostUnsubscribe: (() => void) | null = null;

/** Fold host positions in, newest wins; never rewinds a local position. */
function mergeHostPositions(ownerId: string, value: unknown): void {
  if (ownerId !== activeOwnerId || !value || typeof value !== 'object' || Array.isArray(value)) return;
  const current = readStorage();
  let next: ReadStateMap | null = null;
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at <= (current[key] ?? 0)) continue;
    next ??= { ...current };
    next[key] = Math.floor(at);
  }
  if (next) writeStorage(next);
}

function applyHostState(state: HostReadState | null | undefined): void {
  if (state?.ownerId) mergeHostPositions(state.ownerId, state.positions);
}

/** Report to the host ledger; a failure keeps the local position (next report carries it). */
function reportToHost(body: { mark?: ReadStateMap; seed?: ReadStateMap; prune?: { botIds?: string[]; groupIds?: string[] } }): void {
  const api = hostApi();
  const ownerId = activeOwnerId;
  if (!api || !ownerId) return;
  void api.update({ ownerId, ...body }).then(applyHostState, () => undefined);
}

function bindHost(): void {
  const api = hostApi();
  if (!api || hostUnsubscribe) return;
  hostUnsubscribe = api.onChanged((payload, ownerStamp) => {
    if (!isDataOwnerPushCurrent(ownerStamp)) return;
    applyHostState(payload as HostReadState);
  });
}

/** After an owner switch: hand the local copy over as seeds (upgrade migration), then fold the host in. */
function syncWithHost(): void {
  const ownerId = activeOwnerId;
  if (!ownerId) return;
  bindHost();
  const local = readStorage();
  if (Object.keys(local).length) reportToHost({ seed: { ...local } });
  else void hostApi()?.get().then(applyHostState, () => undefined);
}

function writeStorage(next: ReadStateMap): void {
  cache = next;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // Keep the in-memory value so the current session still behaves correctly.
  }
  for (const subscriber of subscribers) subscriber();
}

/** Select the owner namespace used by this renderer's Bot read positions. */
export function setBotReadStateOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  cache = null;
  for (const subscriber of subscribers) subscriber();
  syncWithHost();
}

/** Snapshot handed to `local-db:bots:list` so main can count unread replies. */
export function getBotLastReadAtMap(): ReadStateMap {
  return { ...readStorage() };
}

export function getBotLastReadAt(botId: string): number | null {
  return readStorage()[botId] ?? null;
}

/**
 * Mark a Bot conversation read up to `at`. Returns whether the stored position
 * actually moved — callers use that to avoid redundant list refreshes.
 */
export function markBotRead(botId: string, at: number = Date.now()): boolean {
  if (!botId || !Number.isFinite(at) || at <= 0) return false;
  const current = readStorage();
  const previous = current[botId] ?? 0;
  if (at <= previous) return false;
  writeStorage({ ...current, [botId]: Math.floor(at) });
  reportToHost({ mark: { [botId]: Math.floor(at) } });
  return true;
}

/**
 * Give Bots we have never tracked a read position of "now".
 *
 * Without this, shipping unread badges would light up every existing Bot with
 * its entire back catalogue the first time the list loads. A Bot the user has
 * never seen before starts read; only messages that arrive afterwards count.
 */
export function seedMissingBotReadState(botIds: readonly string[], at: number = Date.now()): boolean {
  if (!Number.isFinite(at) || at <= 0) return false;
  const current = readStorage();
  const next = { ...current };
  const seeded: ReadStateMap = {};
  for (const botId of botIds) {
    if (!botId || next[botId] !== undefined) continue;
    next[botId] = seeded[botId] = Math.floor(at);
  }
  const changed = Object.keys(seeded).length > 0;
  if (changed) {
    writeStorage(next);
    reportToHost({ seed: seeded });
  }
  return changed;
}

/** Drop read positions for Bots that no longer exist, keeping the map bounded. */
export function pruneBotReadState(botIds: readonly string[]): boolean {
  const current = readStorage();
  const alive = new Set(botIds);
  const next: ReadStateMap = {};
  let changed = false;
  for (const [botId, at] of Object.entries(current)) {
    if (botId.startsWith('group:') || botId.startsWith('thread:') || alive.has(botId)) next[botId] = at;
    else changed = true;
  }
  if (changed) writeStorage(next);
  // The host may also hold positions this window never had (read on the phone).
  reportToHost({ prune: { botIds: [...alive] } });
  return changed;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== storageKey()) return;
  cache = null;
  for (const subscriber of subscribers) subscriber();
}

export function subscribeBotReadState(listener: () => void): () => void {
  if (subscribers.size === 0) window.addEventListener('storage', onStorage);
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** Test-only reset so suites do not leak owner/cache state into each other. */
export function resetBotReadStateForTests(): void {
  activeOwnerId = null;
  cache = null;
  subscribers.clear();
  hostUnsubscribe?.();
  hostUnsubscribe = null;
  window.removeEventListener('storage', onStorage);
}

/** Group replies use the same owner-scoped, monotonic local read positions. */
export const botGroupReadKey = (groupId: string) => `group:${groupId}`;
type GroupReadSummary = Pick<BotGroupSummary, 'id' | 'lastReplyAt'> & Partial<Pick<BotGroupSummary, 'lastMessage' | 'serverUnread'>> & {
  /**
   * ISO times of the group's latest (up to 99) messages from others — Bots and other humans,
   * never the reader's own or notices — oldest first. Older hosts omit it.
   */
  incomingMessageTimes?: readonly string[];
};

function latestGroupReplyAt(group: GroupReadSummary): number {
  // Older hosts may omit lastReplyAt; other humans count just like companions.
  const last = group.lastMessage;
  return Math.max(group.lastReplyAt ?? 0,
    last && last.authorKind !== 'system' && (last.authorKind === 'bot' || last.isSelf === false) ? last.createdAt : 0);
}

/**
 * Messages from others after the local read mark: counted from `incomingMessageTimes` (so at
 * most 99); a host without the list only says whether anything is new (1).
 */
export function botGroupUnreadCount(group: GroupReadSummary): number {
  if (group.serverUnread) return group.serverUnread.count;
  const readAt = getBotLastReadAt(botGroupReadKey(group.id));
  if (readAt === null) return 0;
  const latestUnread = latestGroupReplyAt(group) > readAt ? 1 : 0;
  const times = group.incomingMessageTimes;
  if (!Array.isArray(times)) return latestUnread;
  let count = 0;
  for (const time of times) {
    const at = Date.parse(time);
    if (Number.isFinite(at) && at > readAt) count += 1;
  }
  return Math.max(count, latestUnread);
}

export function isBotGroupUnread(group: GroupReadSummary): boolean {
  return botGroupUnreadCount(group) > 0;
}
export function seedBotGroupReadState(groups: readonly GroupReadSummary[]): void {
  const current = readStorage();
  const next = { ...current };
  const alive = new Set(groups.map(group => botGroupReadKey(group.id)));
  for (const key of Object.keys(next)) if (key.startsWith('group:') && !alive.has(key)) delete next[key];
  const seeded: ReadStateMap = {};
  for (const group of groups) {
    const key = botGroupReadKey(group.id);
    if (next[key] === undefined) next[key] = seeded[key] = Math.max(1, latestGroupReplyAt(group));
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) writeStorage(next);
  reportToHost({ ...(Object.keys(seeded).length ? { seed: seeded } : {}), prune: { groupIds: groups.map(group => group.id) } });
}

/** Private-chat topics use the same owner-scoped, monotonic local read positions, per topic Session. */
export const botDmThreadReadKey = (threadSessionId: string) => `thread:${threadSessionId}`;

/** A topic has a companion reply the reader has not seen in its panel. */
export function isBotDmThreadUnread(thread: { sessionId: string; lastAssistantAt: number | null }): boolean {
  if (thread.lastAssistantAt === null) return false;
  const readAt = getBotLastReadAt(botDmThreadReadKey(thread.sessionId));
  return readAt === null || thread.lastAssistantAt > readAt;
}
