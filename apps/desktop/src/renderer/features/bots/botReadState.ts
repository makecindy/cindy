/**
 * botReadState — per-Bot read position for the Bots list unread badges.
 * ---------------------------------------------------------------------------
 * 设计取舍:
 *   - **读位是 renderer 状态,不进 SQLite**。它是「这台机器上的这个人看到哪儿了」,
 *     不是 Bot 的权威数据;新增 schema/migration 的代价远大于收益。main 侧只在
 *     `local-db:bots:list` 的入参里收下这张表,算完 unreadCount 就丢,不落盘。
 *   - 存储位置与 `userPromptStore` / `composerDraftStore` 同源(localStorage),
 *     key 按数据主人分命名空间,换账号不串读位(见 `setBotReadStateOwner`,
 *     由 AuthContext 在 owner 切换时调用)。
 *   - 已知局限:同一台机器同一账号的多个窗口共享读位(localStorage 语义如此);
 *     跨设备不同步——手机端看过不清桌面端角标。
 *   - 读位只前进不后退(`markBotRead` 单调),避免乱序事件把已读退回未读。
 */

import type { BotGroupSummary } from '../../../shared/botGroupChat';

const STORAGE_KEY_PREFIX = 'cindy.bots.readState.v1';

type ReadStateMap = Record<string, number>;

let activeOwnerId: string | null = null;
let cache: ReadStateMap | null = null;
let sessionReads: ReadStateMap = {};
let sessionSeeds: ReadStateMap = {};
const subscribers = new Set<() => void>();

function storageKey(): string {
  return `${STORAGE_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

// Explicit acknowledgements are immutable facts, not competing whole-map writes.
function markPrefix(): string {
  return `${STORAGE_KEY_PREFIX}.mark.${JSON.stringify(activeOwnerId ?? 'signed-out')}.`;
}
function storedMarks(): { key: string; botId: string; at: number; initial: boolean }[] {
  const prefix = markPrefix();
  const marks: { key: string; botId: string; at: number; initial: boolean }[] = [];
  for (const key of Object.keys(window.localStorage)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const row: unknown = JSON.parse(key.slice(prefix.length));
      if (Array.isArray(row) && (row.length === 2 || (row.length === 3 && row[2] === 'initial')) && typeof row[0] === 'string' && row[0]
        && typeof row[1] === 'number' && Number.isFinite(row[1]) && row[1] > 0
        && window.localStorage.getItem(key) === '1') marks.push({ key, botId: row[0], at: row[1], initial: row.length === 3 });
    } catch { /* Ignore malformed display-cache entries. */ }
  }
  return marks;
}

// Legacy values remain acknowledgements. Automatic baselines are separate
// immutable facts: concurrent discoveries choose the earliest baseline, while
// explicit acknowledgements always advance to the greatest timestamp.
function legacyReads(): ReadStateMap {
  const next: ReadStateMap = {};
  const raw = window.localStorage.getItem(storageKey());
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* Ignore corrupt legacy cache. */ }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [botId, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && Number.isFinite(at) && at > 0) next[botId] = at;
    }
  }
  return next;
}
function readStorage(refresh = false, observedMarks?: ReturnType<typeof storedMarks>): ReadStateMap {
  if (cache && !refresh) return cache;
  const seeds = { ...sessionSeeds };
  const next = { ...sessionReads };
  try {
    for (const [id, at] of Object.entries(legacyReads())) next[id] = Math.max(next[id] ?? 0, at);
    for (const mark of storedMarks()) {
      observedMarks?.push(mark);
      if (mark.initial) seeds[mark.botId] = Math.min(seeds[mark.botId] ?? Infinity, mark.at);
      else next[mark.botId] = Math.max(next[mark.botId] ?? 0, mark.at);
    }
  } catch {
    // Preserve known reads and newly seeded session state if storage is blocked.
    for (const [id, at] of Object.entries(cache ?? {})) next[id] = Math.max(next[id] ?? 0, at);
  }
  for (const [id, at] of Object.entries(seeds)) next[id] ??= at;
  cache = next;
  return next;
}

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}
function seedRead(botId: string, at: number): void {
  sessionSeeds[botId] = Math.min(sessionSeeds[botId] ?? Infinity, at);
  try {
    window.localStorage.setItem(markPrefix() + JSON.stringify([botId, at, 'initial']), '1');
  } catch { /* Preserve the session baseline when storage is unavailable. */ }
}
function writeStorage(next: ReadStateMap, removed: readonly string[], observedMarks: ReturnType<typeof storedMarks>): void {
  const previous = cache ?? {};
  cache = next;
  for (const id of removed) { delete sessionSeeds[id]; delete sessionReads[id]; }
  try {
    const removedIds = new Set(removed);
    // Remove only facts used in this decision; another window may have added
    // an earlier initial baseline since that read.
    const marks = observedMarks.filter(mark => removedIds.has(mark.botId));
    const legacy = legacyReads();
    for (const id of removed) if (legacy[id] <= (previous[id] ?? 0)) delete legacy[id];
    // Never promote automatic baselines into the legacy acknowledgement map.
    window.localStorage.setItem(storageKey(), JSON.stringify(legacy));
    for (const mark of marks) window.localStorage.removeItem(mark.key);
  } catch { /* Keep the in-memory value for this session. */ }
  notify();
}

/** Select the owner namespace used by this renderer's Bot read positions. */
export function setBotReadStateOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  cache = null;
  sessionReads = {};
  sessionSeeds = {};
  for (const subscriber of subscribers) subscriber();
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
  const current = readStorage(true);
  const previous = current[botId] ?? 0;
  if (at < previous) return false;
  at = Math.floor(at);
  sessionReads[botId] = Math.max(sessionReads[botId] ?? 0, at);
  try {
    window.localStorage.setItem(markPrefix() + JSON.stringify([botId, at]), '1');
    // Only older facts for this identity can be discarded. A concurrent newer
    // acknowledgement or another conversation is never a cleanup candidate.
    for (const mark of storedMarks()) {
      if (!mark.initial && mark.botId === botId && mark.at < at) window.localStorage.removeItem(mark.key);
    }
  } catch { /* Keep the session watermark when storage is unavailable. */ }
  const updated = readStorage(true);
  cache = { ...updated, [botId]: Math.max(updated[botId] ?? 0, at) };
  for (const subscriber of subscribers) subscriber();
  return at > previous;
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
  const current = readStorage(true);
  const next = { ...current };
  let changed = false;
  for (const botId of botIds) {
    if (!botId || next[botId] !== undefined) continue;
    next[botId] = Math.floor(at);
    seedRead(botId, next[botId]);
    changed = true;
  }
  if (changed) { readStorage(true); notify(); }
  return changed;
}

/** Drop read positions for Bots that no longer exist, keeping the map bounded. */
export function pruneBotReadState(botIds: readonly string[], observed?: Readonly<ReadStateMap>): boolean {
  const observedMarks: ReturnType<typeof storedMarks> = [];
  const current = readStorage(true, observedMarks);
  const alive = new Set(botIds);
  const next: ReadStateMap = {};
  let changed = false;
  for (const [botId, at] of Object.entries(current)) {
    if (botId.startsWith('group:') || botId.startsWith('thread:') || alive.has(botId)
      || (observed && observed[botId] !== at)) next[botId] = at;
    else changed = true;
  }
  if (changed) writeStorage(next, Object.keys(current).filter(key => next[key] === undefined), observedMarks);
  return changed;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== storageKey() && !event.key.startsWith(markPrefix())) return;
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
  sessionReads = {};
  sessionSeeds = {};
  subscribers.clear();
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
export function seedBotGroupReadState(groups: readonly GroupReadSummary[], prune: boolean | Readonly<ReadStateMap> = true): void {
  const observedMarks: ReturnType<typeof storedMarks> = [];
  const current = readStorage(true, observedMarks);
  const next = { ...current };
  const alive = new Set(groups.map(group => botGroupReadKey(group.id)));
  // An async list may prune only unchanged reads it observed before the request.
  // A visibility mutation supplies only its own identity, never the whole mirror.
  if (prune) for (const key of Object.keys(next)) {
    if (key.startsWith('group:') && !alive.has(key)
      && (prune === true || (prune[key] !== undefined && prune[key] === current[key]))) delete next[key];
  }
  for (const group of groups) {
    const key = botGroupReadKey(group.id);
    if (next[key] === undefined) {
      next[key] = Math.max(1, latestGroupReplyAt(group));
      seedRead(key, next[key]);
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    const removed = Object.keys(current).filter(key => next[key] === undefined);
    if (removed.length) writeStorage(next, removed, observedMarks);
    readStorage(true);
    notify();
  }
}

/** Private-chat topics use the same owner-scoped, monotonic local read positions, per topic Session. */
export const botDmThreadReadKey = (threadSessionId: string) => `thread:${threadSessionId}`;

/** A topic has a companion reply the reader has not seen in its panel. */
export function isBotDmThreadUnread(thread: { sessionId: string; lastAssistantAt: number | null }): boolean {
  if (thread.lastAssistantAt === null) return false;
  const readAt = getBotLastReadAt(botDmThreadReadKey(thread.sessionId));
  return readAt === null || thread.lastAssistantAt > readAt;
}
