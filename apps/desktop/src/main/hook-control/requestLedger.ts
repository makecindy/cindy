/**
 * Durable terminal state and outbox for hook requests.
 *
 * Hook servers may redeliver a requestId after reconnecting. The dispatcher
 * keeps a fast in-memory ACK cache, but that cache and its offline turn.end
 * buffer disappear when Desktop restarts. This owner-scoped ledger persists
 * the original ACK plus terminal payload so reconnect/replay can finish the
 * same request without invoking the agent again.
 */

import { Buffer } from 'node:buffer';

import {
  HOOK_PROTOCOL_VERSION,
  parseHookMessage,
  type TaskAckPayload,
  type TurnEndPayload,
} from '@cindy/slack-hook-protocol';

import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

const FILE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 2_000;
/** Terminal text and identifiers are bounded so the main-thread JSON store stays small. */
const MAX_ENTRY_BYTES = 8_000_000;
/** Bound synchronous read/write work on Electron's main thread. */
const DEFAULT_MAX_FILE_BYTES = 32_000_000;
/**
 * How long a completed answer stays worth delivering (≈24h).
 *
 * Each terminal result plays two roles, and only one of them should expire:
 *  - tombstone (`get`): "this request was already answered, do not invoke the
 *    agent again". Worth keeping as long as capacity allows.
 *  - outbox item (`listPending`, plus the dispatcher's in-memory queues): "this
 *    answer still needs a transport attempt". Worth keeping only while sending
 *    it is still useful.
 *
 * Binding the two together is what lets an outbox item become immortal: a
 * connection that never comes back (unbound account, deleted bot, replaced
 * machine) leaves a `pending` record that nothing can ever settle, and the
 * eviction loop below refuses to reclaim undelivered entries. Enough of those
 * and every subsequent write fails, silently dropping the whole ledger back to
 * in-memory dedupe — the exact regression this store exists to prevent.
 *
 * The horizon matches x-hook-server's reply horizon (OUTBOX_MAX_ATTEMPTS ×
 * OUTBOX_MAX_DELAY_MS): the server already gives up on publishing a reply this
 * old, so a client that reconnects later has nothing useful left to hand over.
 *
 * INVARIANT: a terminal frame past the horizon is never sent — no exceptions,
 * whoever asked. The exits are easy to miss one at a time:
 *  1. the durable outbox here (`listPending`);
 *  2. the dispatcher's ACK retry timer (`sendPendingDelivery`);
 *  3. its offline `turn.end` buffer, replayed on reconnect;
 *  4. its ACK buffer on reconnect — which has *two* consumers, the ACK replay and
 *     the capability-downgrade fallback that sends the frame directly;
 *  5. the dispatcher's replay of a persisted terminal when the server explicitly
 *     re-dispatches the same requestId.
 *
 * Because of (4) the age check belongs where the frames are *taken* (a sweep at
 * the top of `onConnected`), not at each consumer: guarding consumers one by one
 * is what let the downgrade branch through, and the next consumer added would
 * slip through the same way. Guarding only (1) additionally makes the behaviour
 * depend on whether the process happened to restart during the outage.
 *
 * (5) briefly carried an exemption — "the server is asking, so answer it" — and
 * that exemption is why this rule is now unconditional. It had no place in the
 * persisted record (there is no provenance field here), so every path that could
 * queue or re-queue a frame had to propagate it by hand, and three consecutive
 * review rounds each found one more path that had not. Dropping the exemption
 * deletes that whole class of defect. The cost is bounded: the ACK is still
 * replayed, so the server learns the requestId was handled and never re-invokes
 * the agent; it only misses a terminal it had already given up publishing
 * (server-side give-up is the same ≈24h, and a result is always younger than its
 * request, so a re-dispatch this old is already past the server's own horizon).
 */
export const HOOK_TERMINAL_DELIVERY_TTL_MS = 24 * 60 * 60_000;

/**
 * The single age predicate behind that invariant. Exported so the dispatcher's
 * in-memory queues judge staleness exactly like the durable outbox does.
 *
 * A clock that moved backwards yields a negative age and keeps the result live,
 * which is the safe direction (delivering late beats discarding an answer that
 * is actually fresh).
 */
export function terminalDeliveryExpired(
  completedAt: number,
  nowMs: number,
  ttlMs: number = HOOK_TERMINAL_DELIVERY_TTL_MS,
): boolean {
  return nowMs - completedAt > ttlMs;
}

export interface HookTerminalRecord {
  connectionId: string;
  requestId: string;
  ack: TaskAckPayload;
  /** Rejected requests have no turn.end; accepted/queued terminal records always do. */
  turnEnd?: TurnEndPayload;
  /** pending = durable outbox still needs a transport attempt; sent = already attempted. */
  delivery: 'pending' | 'sent';
  /** Wall clock at persist time; also the age used to expire the outbox role. */
  completedAt: number;
}

export interface HookRequestLedger {
  get(connectionId: string, requestId: string): HookTerminalRecord | null;
  /** Undelivered answers still worth sending; entries past the horizon are omitted. */
  listPending(connectionId: string): HookTerminalRecord[];
  /** Returns false when persistence failed; callers must fall back to in-memory delivery. */
  set(record: HookTerminalRecord): boolean;
  markSent(connectionId: string, requestId: string): boolean;
}

interface LedgerFile {
  version: typeof FILE_VERSION;
  entries: HookTerminalRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAck(value: unknown): value is TaskAckPayload {
  const parsed = parseHookMessage({
    v: HOOK_PROTOCOL_VERSION,
    type: 'task.ack',
    id: 'hook-request-ledger-validation',
    ts: 0,
    payload: value,
  });
  return parsed.ok && parsed.message.type === 'task.ack';
}

function isTurnEnd(value: unknown): value is TurnEndPayload {
  const parsed = parseHookMessage({
    v: HOOK_PROTOCOL_VERSION,
    type: 'turn.end',
    id: 'hook-request-ledger-validation',
    ts: 0,
    payload: value,
  });
  return parsed.ok && parsed.message.type === 'turn.end';
}

function isTerminalRecord(value: unknown): value is HookTerminalRecord {
  if (!isRecord(value)) return false;
  if (
    typeof value.connectionId !== 'string' ||
    value.connectionId.length === 0 ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    !isAck(value.ack) ||
    (value.turnEnd !== undefined && !isTurnEnd(value.turnEnd)) ||
    (value.delivery !== 'pending' && value.delivery !== 'sent') ||
    typeof value.completedAt !== 'number' ||
    !Number.isFinite(value.completedAt)
  ) {
    return false;
  }
  if (value.ack.requestId !== value.requestId) return false;
  if (value.ack.result === 'rejected') {
    return value.turnEnd === undefined && value.delivery === 'sent';
  }
  return (
    value.turnEnd !== undefined &&
    value.turnEnd.requestId === value.requestId &&
    value.turnEnd.sessionId === value.ack.sessionId
  );
}

function safeErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  if (error instanceof SyntaxError) return 'invalid-json';
  return error instanceof Error ? error.name : 'unknown-error';
}

function sameRequest(
  entry: Pick<HookTerminalRecord, 'connectionId' | 'requestId'>,
  connectionId: string,
  requestId: string,
): boolean {
  return entry.connectionId === connectionId && entry.requestId === requestId;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function createHookRequestLedger(deps: {
  filePath: string;
  log: { warn(msg: string): void };
  maxEntries?: number;
  maxFileBytes?: number;
  pendingTtlMs?: number;
  now?: () => number;
}): HookRequestLedger {
  const maxEntries = Math.max(1, Math.floor(deps.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxFileBytes = Math.max(1_024, Math.floor(deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  const pendingTtlMs = Math.max(0, Math.floor(deps.pendingTtlMs ?? HOOK_TERMINAL_DELIVERY_TTL_MS));
  const now = deps.now ?? Date.now;
  let cachedEntries: HookTerminalRecord[] | undefined;

  /**
   * A `pending` entry past the horizon is no longer an outbox item: nothing will
   * be delivered from it.
   */
  function pendingExpired(entry: HookTerminalRecord, nowMs: number): boolean {
    return (
      entry.delivery === 'pending' &&
      terminalDeliveryExpired(entry.completedAt, nowMs, pendingTtlMs)
    );
  }

  /**
   * Capacity may be reclaimed from any entry whose only remaining value is
   * dedupe — already delivered, or undeliverable by age. Live undelivered
   * answers stay protected.
   */
  function reclaimable(entry: HookTerminalRecord, nowMs: number): boolean {
    return entry.delivery === 'sent' || pendingExpired(entry, nowMs);
  }

  function readEntries(): HookTerminalRecord[] | null {
    if (cachedEntries !== undefined) return cachedEntries;
    let raw: string | null;
    try {
      raw = readAtomicFileSync(deps.filePath);
    } catch (error) {
      deps.log.warn(`read hook request ledger failed (${safeErrorCode(error)})`);
      return null;
    }
    if (raw === null) {
      cachedEntries = [];
      return cachedEntries;
    }
    if (utf8ByteLength(raw) > maxFileBytes) {
      deps.log.warn('read hook request ledger failed (file-too-large)');
      cachedEntries = [];
      return cachedEntries;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      deps.log.warn('read hook request ledger failed (invalid-json)');
      cachedEntries = [];
      return cachedEntries;
    }
    if (!isRecord(parsed) || parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries)) {
      deps.log.warn('read hook request ledger failed (invalid-shape)');
      cachedEntries = [];
      return cachedEntries;
    }
    cachedEntries = parsed.entries.filter(isTerminalRecord);
    return cachedEntries;
  }

  function writeRecord(record: HookTerminalRecord): boolean {
    if (!isTerminalRecord(record)) {
      deps.log.warn('write hook request ledger skipped (invalid-record)');
      return false;
    }
    const entries = readEntries();
    if (entries === null) return false;
    const recordSerialized = JSON.stringify(record);
    if (utf8ByteLength(recordSerialized) > MAX_ENTRY_BYTES) {
      deps.log.warn('write hook request ledger skipped (record-too-large)');
      return false;
    }

    const nowMs = now();
    const next = entries.filter(
      (entry) => !sameRequest(entry, record.connectionId, record.requestId),
    );
    next.push(record);
    let data: LedgerFile = { version: FILE_VERSION, entries: next };
    let serialized = JSON.stringify(data);
    while (next.length > maxEntries || utf8ByteLength(serialized) > maxFileBytes) {
      // Never evict a *live* undelivered outbox entry to make room. Reclaim the
      // oldest entry that is only holding a tombstone — already sent, or pending
      // past the delivery horizon. Only a burst of live undelivered answers can
      // still fail this write, and the horizon keeps that bounded instead of
      // letting unsettleable entries accumulate forever.
      //
      // "Oldest" means oldest `completedAt`, not lowest index: an updated record
      // is re-appended (see the filter + push above, and `markSent`), so array
      // order tracks the last write rather than age. Picking by index would evict
      // fresher tombstones while keeping stale ones — the retained tombstone is
      // the one a redelivery is *least* likely to need.
      let removable = -1;
      let oldest = Number.POSITIVE_INFINITY;
      for (let index = 0; index < next.length; index += 1) {
        const entry = next[index];
        if (!reclaimable(entry, nowMs)) continue;
        if (sameRequest(entry, record.connectionId, record.requestId)) continue;
        if (entry.completedAt >= oldest) continue;
        oldest = entry.completedAt;
        removable = index;
      }
      if (removable < 0) {
        deps.log.warn('write hook request ledger skipped (pending-outbox-limit)');
        return false;
      }
      next.splice(removable, 1);
      data = { version: FILE_VERSION, entries: next };
      serialized = JSON.stringify(data);
    }

    try {
      atomicWriteFileSync(deps.filePath, `${serialized}\n`);
      cachedEntries = next;
      return true;
    } catch (error) {
      deps.log.warn(`write hook request ledger failed (${safeErrorCode(error)})`);
      return false;
    }
  }

  return {
    get(connectionId, requestId) {
      const entries = readEntries();
      if (entries === null) return null;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (sameRequest(entry, connectionId, requestId)) return entry;
      }
      return null;
    },

    listPending(connectionId) {
      const entries = readEntries();
      if (entries === null) return [];
      const nowMs = now();
      return entries
        .filter(
          (entry) =>
            entry.connectionId === connectionId &&
            entry.delivery === 'pending' &&
            // Past the horizon this answer is no longer worth sending. Replaying
            // it would post a reply to a conversation that moved on a day ago —
            // and after a long outage there would be a burst of them at once.
            !pendingExpired(entry, nowMs),
        )
        .sort((a, b) => a.completedAt - b.completedAt);
    },

    set: writeRecord,

    markSent(connectionId, requestId) {
      const entries = readEntries();
      if (entries === null) return false;
      const record = entries.findLast((entry) => sameRequest(entry, connectionId, requestId));
      if (!record) return false;
      if (record.delivery === 'sent') return true;
      return writeRecord({ ...record, delivery: 'sent' });
    },
  };
}
