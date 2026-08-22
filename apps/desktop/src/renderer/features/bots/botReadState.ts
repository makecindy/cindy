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
  let changed = false;
  for (const botId of botIds) {
    if (!botId || next[botId] !== undefined) continue;
    next[botId] = Math.floor(at);
    changed = true;
  }
  if (changed) writeStorage(next);
  return changed;
}

/** Drop read positions for Bots that no longer exist, keeping the map bounded. */
export function pruneBotReadState(botIds: readonly string[]): boolean {
  const current = readStorage();
  const alive = new Set(botIds);
  const next: ReadStateMap = {};
  let changed = false;
  for (const [botId, at] of Object.entries(current)) {
    if (alive.has(botId)) next[botId] = at;
    else changed = true;
  }
  if (changed) writeStorage(next);
  return changed;
}

export function subscribeBotReadState(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Test-only reset so suites do not leak owner/cache state into each other. */
export function resetBotReadStateForTests(): void {
  activeOwnerId = null;
  cache = null;
  subscribers.clear();
}
