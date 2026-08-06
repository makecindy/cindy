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

export interface HookTerminalRecord {
  connectionId: string;
  requestId: string;
  ack: TaskAckPayload;
  /** Rejected requests have no turn.end; accepted/queued terminal records always do. */
  turnEnd?: TurnEndPayload;
  /** pending = durable outbox still needs a transport attempt; sent = already attempted. */
  delivery: 'pending' | 'sent';
  completedAt: number;
}

export interface HookRequestLedger {
  get(connectionId: string, requestId: string): HookTerminalRecord | null;
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
}): HookRequestLedger {
  const maxEntries = Math.max(1, Math.floor(deps.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxFileBytes = Math.max(1_024, Math.floor(deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  let cachedEntries: HookTerminalRecord[] | undefined;

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

    const next = entries.filter(
      (entry) => !sameRequest(entry, record.connectionId, record.requestId),
    );
    next.push(record);
    let data: LedgerFile = { version: FILE_VERSION, entries: next };
    let serialized = JSON.stringify(data);
    while (next.length > maxEntries || utf8ByteLength(serialized) > maxFileBytes) {
      // Never evict an undelivered outbox entry to make room. Remove the
      // oldest sent result first; if pending entries alone exceed the bound,
      // fail this write and let the dispatcher retain its in-memory fallback.
      const removable = next.findIndex(
        (entry) =>
          entry.delivery === 'sent' && !sameRequest(entry, record.connectionId, record.requestId),
      );
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
      return entries
        .filter((entry) => entry.connectionId === connectionId && entry.delivery === 'pending')
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
