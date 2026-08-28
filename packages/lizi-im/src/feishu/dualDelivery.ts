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
const MAX_RECENT_THREADS = 1_000;
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

function pruneRecentThreads(now: number): void {
  for (const [key, ts] of recentThreads) {
    if (now - ts <= LATE_COPY_TTL_MS && recentThreads.size <= MAX_RECENT_THREADS) break;
    recentThreads.delete(key);
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
      if (entry.threadMessageId) {
        recentThreads.delete(key);
        recentThreads.set(key, Date.now());
        pruneRecentThreads(Date.now());
      }
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
}

export async function coordinateDualDelivery(
  input: DualDeliveryInput,
): Promise<DualDeliveryDecision> {
  const key = logicalSendKey(input);
  if (!key) return { kind: 'dispatch' };

  const now = Date.now();
  pruneRecentThreads(now);
  pruneConfirmed(now);
  if (!input.threadId && recentThreads.has(key)) {
    recentThreads.delete(key);
    confirmed.delete(key);
    confirmed.set(key, now);
    return { kind: 'suppress-main-copy' };
  }

  let entry = pending.get(key);
  if (!entry) entry = createPending(key);

  if (input.threadId) {
    entry.threadMessageId ??= input.messageId;
    if (entry.flatMessageIds.size > 0) confirmPair(key, entry);
    // Topic input is always the preferred Agent route and must not wait. A flat
    // copy that arrived first is already parked on `entry.decision`; a later
    // flat copy is suppressed through `recentThreads`.
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

/** Test-only reset. Production state intentionally survives transport reconnects. */
export function resetDualDeliveryForTest(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolveDecision(false);
  }
  pending.clear();
  recentThreads.clear();
  confirmed.clear();
}
