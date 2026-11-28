import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { ForkRequest, ForkReceipt, ForkTarget, ForkOutcome } from '@cindy/maker-shared/fork-request';
import { getDbClient } from '../localDb/client/current';
import { isDbTransportOutcomeUnknown } from '../localDb/client/DbTransport';
import { sessions } from '../localDb/schema';
import { sessionToCamel } from '../localDb/mapper';
import { activeDataOwnerId, ownerGeneration, isOwnerBoundaryPending, ownerScopedPath } from '../ownerContext';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context';
import { assertTaskActionCurrent, taskActionCallerKey } from '../maker-ipc/taskActionAuthorization';
import { throwIpcError } from '../utils/ipcValidate';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile';
import { forkSessionAtMessage } from './fork';
import type { Session } from '../../renderer/lib/ccAgent.types';

interface RecordV1 {
  version: 1;
  fingerprint: string;
  childId: string;
  phase: 'preparing' | 'native-write' | 'failed' | 'unknown' | 'complete';
  snapshot?: string;
  outcome?: ForkOutcome;
}

// This is a write-ahead receipt, not a backup or a transcript. One bounded file per
// explicit request; no scans, polling, cleanup timers or expiration that permits replay.
// Keep unknown receipts across restarts: an external native write cannot be rolled back.
const inFlight = new Map<string, { fingerprint: string; operation: Promise<ForkReceipt<Session>> }>();
let admitTarget: ((target: ForkTarget, childId: string) => Promise<ForkTarget>) | undefined;
export function configureForkTargetAdmission(admit: NonNullable<typeof admitTarget>): void {
  admitTarget = admit;
}

export function forkRequestCapabilities() {
  return { forkRequestVersion: 1, historyHandoff: Boolean(admitTarget) };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The caller identity comes from the admitted transport/tool, never wire fields. */
export async function runForkRequest(request: ForkRequest): Promise<ForkReceipt<Session>> {
  await assertTaskActionCurrent();
  const owner = activeDataOwnerId();
  const generation = ownerGeneration();
  if (!owner || isOwnerBoundaryPending()) throwIpcError('PERMISSION_DENIED', 'The task owner is unavailable');
  const client = getDbClient();
  const caller = getDeviceLinkInvokeContext()?.controllerDeviceId ?? taskActionCallerKey() ?? 'renderer';
  const key = digest([owner, caller, request.requestId]);
  const file = ownerScopedPath('fork-requests', `${key}.json`);
  const fingerprint = digest([request.sourceSessionId, request.messageClientId, request.target ?? null]);
  const assertCurrent = async () => {
    await assertTaskActionCurrent();
    if (activeDataOwnerId() !== owner || ownerGeneration() !== generation || isOwnerBoundaryPending()
      || getDbClient() !== client) throwIpcError('PERMISSION_DENIED', 'The task owner changed');
  };
  const running = inFlight.get(key);
  if (running) {
    if (running.fingerprint !== fingerprint) throwIpcError('INVALID_PARAMS', 'Fork request does not match its original source, message or target');
    return { state: 'pending' };
  }
  const read = async (): Promise<RecordV1 | null> => {
    try {
      const bytes = await readBoundedFileNoFollow(file, 32_768, { nonBlocking: true, rejectHardLinks: true });
      if (!bytes) {
        // The bounded reader returns null for absent, linked or oversized files.
        // Only proven absence permits a new request; never overwrite an uncertain receipt.
        try { await fs.lstat(file); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
        throwIpcError('PRECONDITION_FAILED', 'The fork receipt cannot be read safely');
      }
      const data = bytes.toString('utf8');
      const record = JSON.parse(data) as RecordV1;
      if (record.version !== 1 || record.fingerprint !== fingerprint || !record.childId
        || !['preparing', 'native-write', 'failed', 'unknown', 'complete'].includes(record.phase)) {
        throwIpcError('INVALID_PARAMS', 'Fork request does not match its original source, message or target');
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const result = async (record: RecordV1): Promise<ForkReceipt<Session>> => {
    await assertCurrent();
    const [source] = await client.drizzle.select({ id: sessions.id, status: sessions.status }).from(sessions)
      .where(eq(sessions.id, request.sourceSessionId)).limit(1);
    if (!source || source.status === 'deleted') throwIpcError('NOT_FOUND', 'Source task is unavailable');
    const [child] = await client.drizzle.select().from(sessions).where(eq(sessions.id, record.childId)).limit(1);
    await assertCurrent();
    if (child) {
      if (child.parentSessionId !== request.sourceSessionId || child.forkedAtMessageId !== request.messageClientId
        || child.status === 'deleted') throwIpcError('NOT_FOUND', 'Fork result is unavailable');
      const counts = await client.queryOne<{ n: number }>('SELECT count(*) AS n FROM messages WHERE session_id = ? AND rewind_at IS NULL', [child.id]);
      await assertCurrent();
      return { state: 'complete', session: sessionToCamel({ ...child, messageCount: counts?.n ?? 0 }),
        outcome: record.outcome ?? (child.sdkSessionId ? 'native' : 'history-handoff') };
    }
    return { state: record.phase === 'failed' ? 'failed' : inFlight.has(key) ? 'pending' : 'unknown' };
  };
  const existing = await read();
  await assertCurrent();
  if (request.action === 'status') return existing ? result(existing) : { state: 'not-sent' };
  if (existing && existing.phase !== 'failed') return result(existing);
  // A simultaneous status/retry never awaits the long native write or submits it again.
  if (inFlight.has(key)) return { state: 'pending' };
  const operation = (async (): Promise<ForkReceipt<Session>> => {
    let record: RecordV1 = existing ?? { version: 1, fingerprint, childId: randomUUID(), phase: 'preparing' };
    let nativeWriteStarted = false;
    const write = async () => {
      await assertCurrent();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
        await assertCurrent();
        await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    };
    if (!existing) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await assertCurrent();
      // Exclusive reservation prevents a restarted/second writer from replaying a request.
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const winner = await read();
        if (!winner) throw error;
        return result(winner);
      }
    }
    record.phase = 'preparing';
    try {
      const session = await forkSessionAtMessage(request.sourceSessionId, request.messageClientId, {
        childId: record.childId,
        ...(request.target ? { target: request.target,
          admitTarget: async target => {
            if (!admitTarget) throwIpcError('UNSUPPORTED_CAPABILITY', 'History handoff is unavailable');
            const admitted = await admitTarget(target, record.childId);
            await assertCurrent();
            return admitted;
          } } : {}),
        assertCurrent,
        onPrepared: async snapshot => {
          if (record.snapshot && record.snapshot !== digest(snapshot)) {
            throwIpcError('PRECONDITION_FAILED', 'Source history changed; choose the fork point again');
          }
          record.snapshot = digest(snapshot);
          await write();
        },
        beforeNativeWrite: async () => {
          record.phase = 'native-write';
          await write();
          await assertCurrent();
          nativeWriteStarted = true;
        },
        onOutcome: async outcome => {
          // Persist the mode before the DB commit. Even if its acknowledgement
          // is lost, a later first turn must not relabel a handoff as native.
          record.outcome = outcome;
          await write();
        },
      });
      await assertCurrent();
      record.phase = 'complete';
      record.outcome = session.forkOutcome;
      // DB is the commit witness. A lost receipt write must not turn a completed
      // child into failure; status resolves the reserved child ID after restart.
      await write().catch(() => undefined);
      return { state: 'complete', session, outcome: session.forkOutcome };
    } catch (error) {
      const completed = await result(record);
      if (completed.state === 'complete') return completed;
      record.phase = nativeWriteStarted || isDbTransportOutcomeUnknown(error) ? 'unknown' : 'failed';
      await write();
      if (record.phase === 'unknown') return { state: 'unknown' };
      throw error;
    }
  })();
  inFlight.set(key, { fingerprint, operation });
  try { return await operation; } finally { if (inFlight.get(key)?.operation === operation) inFlight.delete(key); }
}
