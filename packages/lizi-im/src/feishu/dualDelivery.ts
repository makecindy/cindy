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
  | { kind: 'dispatch'; mirrorKey?: string }
  | { kind: 'suppress-main-copy' };

const pending = new Map<string, PendingLogicalSend>();
const recentThreads = new Map<string, number>();
const recentFlats = new Map<string, number>();
const confirmed = new Map<string, number>();
const deferredMirrors = new Map<string, Array<() => void>>();

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
    deferredMirrors.delete(key);
  }
}

function rememberRecent(map: Map<string, number>, key: string, now: number): void {
  map.delete(key);
  map.set(key, now);
  pruneTtlMap(map, now);
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
    if (now - ts <= CONFIRMED_TTL_MS && confirmed.size <= MAX_CONFIRMED) break;
    confirmed.delete(key);
  }
}

function prunePending(): void {
  while (pending.size > MAX_PENDING) {
    const oldestKey = pending.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    const entry = pending.get(oldestKey);
    pending.delete(oldestKey);
    if (entry) {
      clearTimeout(entry.timer);
      entry.resolveDecision(false);
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
      const now = Date.now();
      if (entry.threadMessageId) rememberRecent(recentThreads, key, now);
      else if (entry.flatMessageIds.size > 0) rememberRecent(recentFlats, key, now);
      entry.resolveDecision(false);
    }, PAIR_WINDOW_MS),
  };
  pending.set(key, entry);
  prunePending();
  return entry;
}

function confirmPair(key: string, entry: PendingLogicalSend): void {
  if (pending.get(key) === entry) pending.delete(key);
  clearTimeout(entry.timer);
  confirmed.delete(key);
  confirmed.set(key, Date.now());
  pruneConfirmed(Date.now());
  entry.resolveDecision(true);
  flushDeferredMirrors(key);
}

export async function coordinateDualDelivery(
  input: DualDeliveryInput,
): Promise<DualDeliveryDecision> {
  const key = logicalSendKey(input);
  if (!key) return { kind: 'dispatch' };

  const now = Date.now();
  pruneTtlMap(recentThreads, now);
  pruneTtlMap(recentFlats, now);
  pruneConfirmed(now);
  if (!input.threadId && recentThreads.has(key)) {
    recentThreads.delete(key);
    confirmed.delete(key);
    confirmed.set(key, now);
    pruneConfirmed(now);
    flushDeferredMirrors(key);
    return { kind: 'suppress-main-copy' };
  }
  if (input.threadId && recentFlats.has(key)) {
    recentFlats.delete(key);
    return { kind: 'suppress-main-copy' };
  }

  let entry = pending.get(key);
  if (!entry) entry = createPending(key);

  if (input.threadId) {
    entry.threadMessageId ??= input.messageId;
    if (entry.flatMessageIds.size > 0) confirmPair(key, entry);
    // Topic input is always the preferred Agent route and must not wait. A flat
    // copy that arrived first is already parked on `entry.decision`; a later
    // flat copy is suppressed through `recentThreads`, and a late topic after
    // an unpaired flat is suppressed through `recentFlats`.
    return { kind: 'dispatch', mirrorKey: key };
  }

  entry.flatMessageIds.add(input.messageId);
  if (entry.threadMessageId && entry.threadMessageId !== input.messageId) {
    confirmPair(key, entry);
    return { kind: 'suppress-main-copy' };
  }

  return (await entry.decision)
    ? { kind: 'suppress-main-copy' }
    : { kind: 'dispatch' };
}

/** Waits only for the bounded pairing window; Agent execution itself is never delayed. */
export async function waitForMirrorConfirmation(mirrorKey: string): Promise<boolean> {
  pruneConfirmed(Date.now());
  if (confirmed.has(mirrorKey)) return true;
  const entry = pending.get(mirrorKey);
  return entry ? entry.decision : false;
}

/**
 * Run `send` if this logical send is already confirmed, or when a late main-feed
 * copy confirms it inside the late-copy TTL. No-ops once that window has expired.
 */
export function scheduleMirrorOnConfirmation(mirrorKey: string, send: () => void): void {
  const now = Date.now();
  pruneConfirmed(now);
  pruneTtlMap(recentThreads, now);
  if (confirmed.has(mirrorKey)) {
    send();
    return;
  }
  if (!pending.has(mirrorKey) && !recentThreads.has(mirrorKey)) return;
  const queued = deferredMirrors.get(mirrorKey) ?? [];
  queued.push(send);
  deferredMirrors.set(mirrorKey, queued);
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
  deferredMirrors.clear();
}
