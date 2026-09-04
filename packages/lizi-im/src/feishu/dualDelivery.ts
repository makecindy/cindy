import { createHash } from 'node:crypto';

/**
 * Feishu's native “同时发送到群聊” option can deliver one logical user send as
 * two `im.message.receive_v1` events: a topic message and a main-feed copy.
 * They have different message ids but retain the same sender/chat/create-time,
 * message type, and raw content. This coordinator elects the topic event as the
 * only Agent route and suppresses the main-feed copy so it cannot open a second
 * turn. Cindy does not copy the bot reply to the parent group: Feishu never
 * exposes the checkbox on the inbound event.
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
      /**
       * Uncommitted elected-topic routes call this when the Agent event is
       * actually about to emit. `false` means a previous topic delivery already
       * committed — abort instead of starting a second turn.
       */
      commitTopic?: () => boolean;
      /** Release an uncommitted topic route that will never emit an Agent turn. */
      abandonTopic?: () => void;
    }
  | { kind: 'suppress-main-copy' };

interface RecentFlatRecord {
  ts: number;
  state: 'pending' | 'committed' | 'taken-over' | 'abandoned';
}

const pending = new Map<string, PendingLogicalSend>();
const recentThreads = new Map<string, number>();
const recentFlats = new Map<string, RecentFlatRecord>();
const topicLeases = new Map<string, RecentFlatRecord>();
const confirmed = new Map<string, number>();

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

function pruneTtlMap(map: Map<string, number>, now: number): void {
  for (const [key, ts] of map) {
    if (now - ts <= LATE_COPY_TTL_MS && map.size <= MAX_RECENT) break;
    map.delete(key);
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
    }
  }
  if (recentFlats.size <= MAX_RECENT) return;
  for (const [key, rec] of recentFlats) {
    if (recentFlats.size <= MAX_RECENT) break;
    if (rec.state === 'pending') continue;
    recentFlats.delete(key);
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

function pruneTopicLeases(now: number): void {
  for (const [key, rec] of topicLeases) {
    if (rec.state === 'pending') continue;
    if (now - rec.ts > LATE_COPY_TTL_MS) topicLeases.delete(key);
  }
  if (topicLeases.size <= MAX_RECENT) return;
  for (const [key, rec] of topicLeases) {
    if (topicLeases.size <= MAX_RECENT) break;
    if (rec.state === 'pending') continue;
    topicLeases.delete(key);
  }
}

function rememberTopicLease(key: string, now: number): RecentFlatRecord {
  const rec: RecentFlatRecord = { ts: now, state: 'pending' };
  topicLeases.delete(key);
  topicLeases.set(key, rec);
  pruneTopicLeases(now);
  return rec;
}

function commitTopicRoute(key: string, rec: RecentFlatRecord): boolean {
  if (rec.state !== 'pending') return false;
  rec.state = 'committed';
  rec.ts = Date.now();
  if (topicLeases.get(key) === rec) {
    topicLeases.delete(key);
    topicLeases.set(key, rec);
    pruneTopicLeases(rec.ts);
  }
  return true;
}

function abandonTopicRoute(key: string, rec: RecentFlatRecord): void {
  if (rec.state !== 'pending') return;
  rec.state = 'abandoned';
  rec.ts = Date.now();
  if (topicLeases.get(key) === rec) {
    topicLeases.delete(key);
    topicLeases.set(key, rec);
    pruneTopicLeases(rec.ts);
  }
}

function topicRouteCallbacks(
  key: string,
  existingLease?: RecentFlatRecord,
): { commitTopic: () => boolean; abandonTopic: () => void } {
  const existing = existingLease ?? topicLeases.get(key);
  // A committed lease must keep suppressing later topic message ids until
  // `confirmPair`. Replacing it with a fresh pending rec would let a second
  // delivery call `commitTopic()` and start another Agent turn.
  const lease =
    existing?.state === 'pending' || existing?.state === 'committed'
      ? existing
      : rememberTopicLease(key, Date.now());
  return {
    commitTopic: () => commitTopicRoute(key, lease),
    abandonTopic: () => abandonTopicRoute(key, lease),
  };
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
}

function pruneConfirmed(now: number): void {
  for (const [key, ts] of confirmed) {
    if (now - ts <= CONFIRMED_TTL_MS && confirmed.size <= MAX_CONFIRMED) break;
    confirmed.delete(key);
  }
}

function dispatchRoute(
  extra: Omit<Extract<DualDeliveryDecision, { kind: 'dispatch' }>, 'kind'> = {},
): DualDeliveryDecision {
  return {
    kind: 'dispatch',
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
  pruneTopicLeases(now);
  pruneConfirmed(now);
  // Once a logical send has paired, later flats are duplicates even when
  // Feishu assigns a fresh message_id. An elected topic that never committed
  // (inbound claim abandon / reconnect retry) must still be allowed to emit.
  if (confirmed.has(key)) {
    if (input.threadId) {
      const lease = topicLeases.get(key);
      if (lease?.state === 'pending') {
        return dispatchRoute(topicRouteCallbacks(key, lease));
      }
    }
    return { kind: 'suppress-main-copy' };
  }
  if (input.threadId && topicLeases.get(key)?.state === 'committed') {
    return { kind: 'suppress-main-copy' };
  }
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
    return dispatchRoute(topicRouteCallbacks(key));
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
    return dispatchRoute(topicRouteCallbacks(key));
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
    ? dispatchRoute({
        commitUnpairedFlat: () => commitUnpairedFlatRoute(key, lease),
        isUnpairedFlatTakenOver: () => isUnpairedFlatTakenOver(lease),
        abandonUnpairedFlat: () => abandonUnpairedFlatRoute(key, lease),
      })
    : dispatchRoute();
}

/** Test-only: pending elected-topic leases that pruneTopicLeases will not expire. */
export function pendingTopicLeaseCountForTest(): number {
  let count = 0;
  for (const rec of topicLeases.values()) {
    if (rec.state === 'pending') count += 1;
  }
  return count;
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
  topicLeases.clear();
  confirmed.clear();
}
