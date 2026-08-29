import { createHash } from 'node:crypto';

/**
 * Feishu's native “同时发送到群聊” option can deliver one logical user send as
 * two `im.message.receive_v1` events: a topic message and a main-feed copy.
 * They have different message ids but retain the same sender/chat/create-time,
 * message type, and raw content. This coordinator elects the topic event as the
 * only Agent route and records that its terminal answer needs a parent-chat
 * mirror.
 */

const PAIR_WINDOW_MS = 1_000;
const LATE_COPY_TTL_MS = 25_000;
const CONFIRMED_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PENDING = 512;
const MAX_RECENT = 1_000;
const MAX_CONFIRMED = 2_000;

interface PendingLogicalSend {
  threadMessageId: string | null;
  flatMessageIds: Set<string>;
  decision: Promise<boolean>;
  resolveDecision: (confirmed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  flatLease?: RecentFlatRecord;
}

export interface DualDeliveryInput {
  appId: string;
  chatId: string;
  senderOpenId: string;
  createTime: string;
  messageType: string;
  rawContent: string;
  messageId: string;
  threadId: string;
}

export type DualDeliveryDecision =
  | {
      kind: 'dispatch';
      mirrorKey?: string;
      /**
       * Pairing was already confirmed when this topic/takeover dispatched.
       * Terminal mirrors must not wait on a confirmation map that can be TTL
       * or capacity pruned during a long Agent turn.
       */
      alreadyConfirmed?: boolean;
      /**
       * Unpaired main-feed copies call this after `openThread` returns, and
       * only when the copy is actually about to emit an Agent turn.
       * `false` means a late topic already claimed the route — recall the
       * bot-created opener and abort instead of emitting.
       */
      commitUnpairedFlat?: () => boolean;
      /**
       * Peek without committing. Orphaned / unconfirmed openers that will not
       * dispatch still need to recall when a late topic already took over.
       */
      isUnpairedFlatTakenOver?: () => boolean;
      /** Release an uncommitted flat route that will never emit an Agent turn. */
      abandonUnpairedFlat?: () => void;
    }
  | { kind: 'suppress-main-copy' };

interface RecentFlatRecord {
  ts: number;
  state: 'pending' | 'committed' | 'taken-over' | 'abandoned';
}

const pending = new Map<string, PendingLogicalSend>();
const recentThreads = new Map<string, number>();
const recentFlats = new Map<string, RecentFlatRecord>();
const confirmed = new Map<string, number>();
const deferredMirrors = new Map<string, Array<() => void>>();
/** Logical sends whose Agent turn has not yet consumed the terminal mirror. */
const inflightMirrors = new Set<string>();

function logicalSendKey(input: DualDeliveryInput): string | null {
  if (!input.createTime) return null;
  return createHash('sha256')
    .update(input.appId)
    .update('\0')
    .update(input.chatId)
    .update('\0')
    .update(input.senderOpenId)
    .update('\0')
    .update(input.createTime)
    .update('\0')
    .update(input.messageType)
    .update('\0')
    .update(input.rawContent)
    .digest('hex');
}

function dropDeferredMirrors(key: string): void {
  if (!deferredMirrors.delete(key)) return;
  // Dropped callbacks never run, so their `.finally(release)` cannot fire.
  releaseMirrorConfirmation(key);
}

function pruneTtlMap(map: Map<string, number>, now: number): void {
  for (const [key, ts] of map) {
    if (now - ts <= LATE_COPY_TTL_MS && map.size <= MAX_RECENT) break;
    map.delete(key);
    dropDeferredMirrors(key);
  }
}

function rememberRecent(map: Map<string, number>, key: string, now: number): void {
  map.delete(key);
  map.set(key, now);
  pruneTtlMap(map, now);
}

function pruneRecentFlats(now: number): void {
  // An uncommitted flat record is a live route lease, not a cache entry. It may
  // outlive the normal late-copy TTL while openThread UUID recovery is still
  // deciding whether this path can emit a turn. Only explicit lifecycle
  // transitions make it eligible for eviction.
  for (const [key, rec] of recentFlats) {
    if (rec.state === 'pending') continue;
    if (now - rec.ts > LATE_COPY_TTL_MS) {
      recentFlats.delete(key);
      dropDeferredMirrors(key);
    }
  }
  if (recentFlats.size <= MAX_RECENT) return;
  for (const [key, rec] of recentFlats) {
    if (recentFlats.size <= MAX_RECENT) break;
    if (rec.state === 'pending') continue;
    recentFlats.delete(key);
    dropDeferredMirrors(key);
  }
}

function rememberRecentFlat(key: string, now: number): RecentFlatRecord {
  const rec: RecentFlatRecord = { ts: now, state: 'pending' };
  recentFlats.delete(key);
  recentFlats.set(key, rec);
  pruneRecentFlats(now);
  return rec;
}

function commitUnpairedFlatRoute(key: string, rec: RecentFlatRecord): boolean {
  if (rec.state === 'taken-over' || rec.state === 'abandoned') return false;
  if (rec.state === 'committed') return true;
  rec.state = 'committed';
  rec.ts = Date.now();
  if (recentFlats.get(key) === rec) {
    recentFlats.delete(key);
    recentFlats.set(key, rec);
    pruneRecentFlats(rec.ts);
  }
  return true;
}

function isUnpairedFlatTakenOver(rec: RecentFlatRecord): boolean {
  return rec.state === 'taken-over';
}

function abandonUnpairedFlatRoute(key: string, rec: RecentFlatRecord): void {
  if (rec.state !== 'pending') return;
  rec.state = 'abandoned';
  rec.ts = Date.now();
  if (recentFlats.get(key) === rec) {
    recentFlats.delete(key);
    recentFlats.set(key, rec);
    pruneRecentFlats(rec.ts);
  }
  dropDeferredMirrors(key);
}

function flushDeferredMirrors(key: string): void {
  const scheduled = deferredMirrors.get(key);
  deferredMirrors.delete(key);
  for (const run of scheduled ?? []) {
    try {
      run();
    } catch {
      /* best-effort; caller logs inside the scheduled work */
    }
  }
}

function pruneConfirmed(now: number): void {
  for (const [key, ts] of confirmed) {
    if (inflightMirrors.has(key)) continue;
    if (now - ts <= CONFIRMED_TTL_MS && confirmed.size <= MAX_CONFIRMED) break;
    confirmed.delete(key);
  }
  if (confirmed.size <= MAX_CONFIRMED) return;
  for (const key of confirmed.keys()) {
    if (confirmed.size <= MAX_CONFIRMED) break;
    if (inflightMirrors.has(key)) continue;
    confirmed.delete(key);
  }
}

/** Hold a dispatched mirror key so confirmation cannot expire before terminal copy. */
export function retainMirrorConfirmation(mirrorKey: string): void {
  inflightMirrors.add(mirrorKey);
}

/** Release after the terminal parent-chat copy has been sent or scheduled. */
export function releaseMirrorConfirmation(mirrorKey: string): void {
  inflightMirrors.delete(mirrorKey);
}

function dispatchWithMirror(
  key: string,
  extra: Omit<Extract<DualDeliveryDecision, { kind: 'dispatch' }>, 'kind' | 'mirrorKey' | 'alreadyConfirmed'> = {},
): DualDeliveryDecision {
  return {
    kind: 'dispatch',
    mirrorKey: key,
    ...(confirmed.has(key) ? { alreadyConfirmed: true } : {}),
    ...extra,
  };
}

function settleUnpairedPending(key: string, entry: PendingLogicalSend): void {
  const now = Date.now();
  if (entry.threadMessageId) rememberRecent(recentThreads, key, now);
  else if (entry.flatMessageIds.size > 0) entry.flatLease = rememberRecentFlat(key, now);
  entry.resolveDecision(false);
}

function prunePending(): void {
  while (pending.size > MAX_PENDING) {
    const oldestKey = pending.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    const entry = pending.get(oldestKey);
    pending.delete(oldestKey);
    if (entry) {
      clearTimeout(entry.timer);
      settleUnpairedPending(oldestKey, entry);
    }
  }
}

function createPending(key: string): PendingLogicalSend {
  let resolveDecision!: (confirmed: boolean) => void;
  const decision = new Promise<boolean>((resolve) => {
    resolveDecision = resolve;
  });
  const entry: PendingLogicalSend = {
    threadMessageId: null,
    flatMessageIds: new Set(),
    decision,
    resolveDecision,
    timer: setTimeout(() => {
      if (pending.get(key) !== entry) return;
      pending.delete(key);
      settleUnpairedPending(key, entry);
    }, PAIR_WINDOW_MS),
  };
  pending.set(key, entry);
  prunePending();
  return entry;
}

function confirmLogicalSend(key: string, now: number): void {
  confirmed.delete(key);
  confirmed.set(key, now);
  pruneConfirmed(now);
  flushDeferredMirrors(key);
}

function confirmPair(key: string, entry: PendingLogicalSend): void {
  if (pending.get(key) === entry) pending.delete(key);
  clearTimeout(entry.timer);
  const now = Date.now();
  // Topic already dispatched. Keep a recent-thread tombstone so a later
  // distinct-id main-feed copy cannot mint a second pending/Agent turn after
  // `pending` is deleted. `confirmed` is the durable suppress key; the
  // tombstone is consumed by the first extra flat like other late copies.
  if (entry.threadMessageId) rememberRecent(recentThreads, key, now);
  confirmLogicalSend(key, now);
  entry.resolveDecision(true);
}

export async function coordinateDualDelivery(
  input: DualDeliveryInput,
): Promise<DualDeliveryDecision> {
  const key = logicalSendKey(input);
  if (!key) return { kind: 'dispatch' };

  const now = Date.now();
  pruneTtlMap(recentThreads, now);
  pruneRecentFlats(now);
  pruneConfirmed(now);
  // Once a logical send has paired, every later delivery for the same exact
  // key is a duplicate even when Feishu assigns it a fresh message_id.
  if (confirmed.has(key)) return { kind: 'suppress-main-copy' };
  if (!input.threadId && recentThreads.has(key)) {
    recentThreads.delete(key);
    confirmLogicalSend(key, now);
    return { kind: 'suppress-main-copy' };
  }
  const recentFlat = recentFlats.get(key);
  if (input.threadId && recentFlat) {
    if (recentFlat.state === 'committed' || recentFlat.state === 'taken-over') {
      confirmLogicalSend(key, now);
      rememberRecent(recentThreads, key, now);
      return { kind: 'suppress-main-copy' };
    }
    recentFlat.state = 'taken-over';
    recentFlat.ts = now;
    recentFlats.delete(key);
    recentFlats.set(key, recentFlat);
    confirmLogicalSend(key, now);
    rememberRecent(recentThreads, key, now);
    return dispatchWithMirror(key);
  }
  if (!input.threadId && recentFlat) {
    if (recentFlat.state === 'abandoned') {
      recentFlats.delete(key);
    } else {
      // A live or committed flat route already owns this logical send. Feishu
      // retries normally keep the same message id and are stopped upstream, but
      // a second flat id must not mint a parallel route lease here.
      return { kind: 'suppress-main-copy' };
    }
  }

  let entry = pending.get(key);
  if (!entry) entry = createPending(key);

  if (input.threadId) {
    entry.threadMessageId ??= input.messageId;
    if (entry.flatMessageIds.size > 0) confirmPair(key, entry);
    // Topic input is always the preferred Agent route and must not wait. A flat
    // copy that arrived first is already parked on `entry.decision`; a later
    // flat copy is suppressed through `recentThreads`. A late topic after an
    // unpaired flat takes over unless that flat has already committed.
    return dispatchWithMirror(key);
  }

  entry.flatMessageIds.add(input.messageId);
  if (entry.threadMessageId && entry.threadMessageId !== input.messageId) {
    confirmPair(key, entry);
    return { kind: 'suppress-main-copy' };
  }

  if (await entry.decision) return { kind: 'suppress-main-copy' };
  if (entry.flatMessageIds.values().next().value !== input.messageId) {
    return { kind: 'suppress-main-copy' };
  }
  const lease = entry.flatLease;
  return lease
    ? dispatchWithMirror(key, {
        commitUnpairedFlat: () => commitUnpairedFlatRoute(key, lease),
        isUnpairedFlatTakenOver: () => isUnpairedFlatTakenOver(lease),
        abandonUnpairedFlat: () => abandonUnpairedFlatRoute(key, lease),
      })
    : dispatchWithMirror(key);
}

/** Waits only for the bounded pairing window; Agent execution itself is never delayed. */
export async function waitForMirrorConfirmation(mirrorKey: string): Promise<boolean> {
  pruneConfirmed(Date.now());
  if (confirmed.has(mirrorKey)) return true;
  const entry = pending.get(mirrorKey);
  return entry ? entry.decision : false;
}

/**
 * Run `send` if this logical send is already confirmed, or when a late pair
 * (main-feed copy or committed-flat topic) confirms it inside the late-copy TTL.
 * No-ops once that window has expired.
 *
 * @returns whether `send` ran immediately or was queued for a later confirmation.
 */
export function scheduleMirrorOnConfirmation(mirrorKey: string, send: () => void): boolean {
  const now = Date.now();
  pruneConfirmed(now);
  pruneTtlMap(recentThreads, now);
  pruneRecentFlats(now);
  if (confirmed.has(mirrorKey)) {
    send();
    return true;
  }
  if (
    !pending.has(mirrorKey) &&
    !recentThreads.has(mirrorKey) &&
    !recentFlats.has(mirrorKey)
  ) {
    return false;
  }
  const queued = deferredMirrors.get(mirrorKey) ?? [];
  queued.push(send);
  deferredMirrors.set(mirrorKey, queued);
  return true;
}

/** Test-only: whether terminal-mirror retain is still holding this key. */
export function isMirrorConfirmationRetainedForTest(mirrorKey: string): boolean {
  return inflightMirrors.has(mirrorKey);
}

/** Test-only reset. Production state intentionally survives transport reconnects. */
export function resetDualDeliveryForTest(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolveDecision(false);
  }
  pending.clear();
  recentThreads.clear();
  recentFlats.clear();
  confirmed.clear();
  inflightMirrors.clear();
  deferredMirrors.clear();
}
