/**
 * botReadStateStore — the host-side read positions of this computer's companion conversations.
 * ---------------------------------------------------------------------------
 * One account's "seen up to" times for its companions' private chats (`<botId>`), early local
 * groups (`group:<groupId>`) and private-chat topics (`thread:<sessionId>`). The computer that
 * holds the conversation keeps the position, so this Mac's windows, the phone and other Macs
 * that open the companion through device-link all read and advance the same one
 * (docs/product-rules/cindy-bots-runtime.md「导航未读与系统角标」).
 *
 * - Owner-scoped like the other small preference ledgers (`ownerScopedUserDataPath()`), so one
 *   account's positions never light up another's list.
 * - Positions only move forward. Devices report what they actually showed, in host time; an
 *   out-of-order or stale report never turns a read reply unread again.
 * - Seeding is "set if absent": a companion first seen anywhere starts read, and a device that
 *   has never seen it cannot rewind the position another device already advanced.
 * - Server-backed group chats keep their read position on the Chat Server; they are not here.
 */

import Store from 'electron-store';

import { ownerScopedUserDataPath } from '../appSessionState.js';

export type BotReadStateMap = Record<string, number>;

interface BotReadStateShape {
  positions: BotReadStateMap;
}

/** Bounded: companions, local groups and topics of one account, not a history. */
const MAX_BOT_READ_STATE_ENTRIES = 2000;
const KEY_PATTERN = /^(?:group:|thread:)?[A-Za-z0-9_.-]{1,160}$/;

let storeInstance: Store<BotReadStateShape> | null = null;
let storePath: string | null = null;
const listeners = new Set<(changedKeys: readonly string[]) => void>();

function getStore(): Store<BotReadStateShape> {
  const currentPath = ownerScopedUserDataPath();
  if (!storeInstance || storePath !== currentPath) {
    storeInstance = new Store<BotReadStateShape>({
      name: 'bot-read-state',
      cwd: currentPath,
      defaults: { positions: {} },
      schema: { positions: { type: 'object' } },
      clearInvalidConfig: true,
    });
    storePath = currentPath;
  }
  return storeInstance;
}

export function isBotReadStateKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function validAt(at: unknown): at is number {
  return typeof at === 'number' && Number.isFinite(at) && at > 0;
}

/** Drop malformed keys and times; keep the newest positions when over the bound. */
export function normalizeBotReadState(value: unknown): BotReadStateMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: Array<[string, number]> = [];
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (isBotReadStateKey(key) && validAt(at)) entries.push([key, Math.floor(at)]);
  }
  if (entries.length > MAX_BOT_READ_STATE_ENTRIES) {
    entries.sort((left, right) => right[1] - left[1]);
    entries.length = MAX_BOT_READ_STATE_ENTRIES;
  }
  return Object.fromEntries(entries);
}

/**
 * Merge reported positions. `seed` only fills keys that have none; otherwise a position only
 * moves forward. Returns the keys that actually changed.
 */
export function applyBotReadPositions(
  current: BotReadStateMap,
  positions: unknown,
  mode: 'mark' | 'seed',
): { next: BotReadStateMap; changed: string[] } {
  const reported = normalizeBotReadState(positions);
  const next = { ...current };
  const changed: string[] = [];
  for (const [key, at] of Object.entries(reported)) {
    const previous = next[key];
    if (mode === 'seed' ? previous !== undefined : previous !== undefined && previous >= at) continue;
    next[key] = at;
    changed.push(key);
  }
  return { next: changed.length ? normalizeBotReadState(next) : current, changed };
}

/**
 * Forget positions of companions or local groups that no longer exist. A list that is not
 * given leaves that kind untouched; topics are dropped with nothing here (their companion's
 * deletion archives them and the bound keeps the map small).
 */
export function pruneBotReadPositions(
  current: BotReadStateMap,
  alive: { botIds?: readonly string[]; groupIds?: readonly string[] },
): { next: BotReadStateMap; changed: string[] } {
  const bots = alive.botIds ? new Set(alive.botIds) : null;
  const groups = alive.groupIds ? new Set(alive.groupIds.map(id => `group:${id}`)) : null;
  const next: BotReadStateMap = {};
  const changed: string[] = [];
  for (const [key, at] of Object.entries(current)) {
    const dead = key.startsWith('group:') ? groups !== null && !groups.has(key)
      : key.startsWith('thread:') ? false
        : bots !== null && !bots.has(key);
    if (dead) changed.push(key);
    else next[key] = at;
  }
  return { next: changed.length ? next : current, changed };
}

export function loadBotReadState(): BotReadStateMap {
  return normalizeBotReadState(getStore().get('positions', {}));
}

export function readBotReadPosition(key: string): number | null {
  return loadBotReadState()[key] ?? null;
}

function commit(result: { next: BotReadStateMap; changed: string[] }): string[] {
  if (!result.changed.length) return result.changed;
  getStore().set('positions', result.next);
  for (const listener of listeners) {
    try { listener(result.changed); } catch { /* observers never block the write */ }
  }
  return result.changed;
}

/** Advance positions (never back). Returns the changed keys. */
export function markBotReadPositions(positions: unknown): string[] {
  return commit(applyBotReadPositions(loadBotReadState(), positions, 'mark'));
}

/** Give conversations without a position one; existing positions stay. */
export function seedBotReadPositions(positions: unknown): string[] {
  return commit(applyBotReadPositions(loadBotReadState(), positions, 'seed'));
}

export function pruneBotReadState(alive: { botIds?: readonly string[]; groupIds?: readonly string[] }): string[] {
  return commit(pruneBotReadPositions(loadBotReadState(), alive));
}

/** In-process observers (window push, device-link invalidation). */
export function onBotReadStateChanged(listener: (changedKeys: readonly string[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
