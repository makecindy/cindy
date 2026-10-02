import { createHash, randomUUID } from 'node:crypto';
import type { DbClient } from '../localDb/client/DbClient.js';
import { SessionAdmissionError } from './controller.js';

/** Stable wire intent; correlation request IDs and process generations are not
 * part of a business key. Reordered object fields do not change the intent. */
export function sessionIntentFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

interface ReservationRow {
  key: string; fingerprint: string; sessionId: string; inputId: string | null; receipt: string | null;
}
export interface SessionRequestIdentity {
  /** Constructed by host policy from authenticated source device/caller. */
  callerKey: string;
  businessKey: string;
  operation: 'createRecord' | 'send';
  targetSessionId?: string;
  intent: unknown;
}

/** Reserves exactly once in the existing account DB before any effect. A crash
 * between reservation and receipt is UNKNOWN_OUTCOME, never permission to issue
 * the effect again. Reconciliation consults the owning record/input store.
 * Only the acceptance response is saved; ongoing runtime state is never stored here. */
export function createSessionRequestLedger(db: Pick<DbClient, 'exec' | 'queryOne'>, assertCurrent: () => void) {
  const identity = (request: SessionRequestIdentity) => {
    if (!request.businessKey || request.businessKey.length > 256 || !request.callerKey
      || (request.operation === 'send' && !request.targetSessionId)) {
      throw new SessionAdmissionError('INVALID_ARGS', 'A business key and host caller are required');
    }
    return {
      key: sessionIntentFingerprint([request.callerKey, request.operation, request.targetSessionId ?? null, request.businessKey]),
      fingerprint: sessionIntentFingerprint(request.intent),
    };
  };
  const read = async (request: SessionRequestIdentity): Promise<ReservationRow | null> => {
    assertCurrent();
    const { key, fingerprint } = identity(request);
    const row = await db.queryOne<ReservationRow>(
      'SELECT key, fingerprint, session_id AS sessionId, input_id AS inputId, receipt FROM session_control_requests WHERE key = ?', [key]);
    assertCurrent();
    if (row && row.fingerprint !== fingerprint) throw new SessionAdmissionError('CONFLICT', 'Business key was already used for a different intent');
    return row ?? null;
  };
  return {
    read,
    async run<T>(request: SessionRequestIdentity, execute: (identity: { sessionId: string; inputId: string | null }) => Promise<T>,
      reconcile: (identity: { sessionId: string; inputId: string | null }) => Promise<T | undefined>): Promise<T> {
      assertCurrent();
      const { key, fingerprint } = identity(request);
      const sessionId = request.targetSessionId ?? randomUUID();
      const inputId = request.operation === 'send' ? randomUUID() : null;
      const reserved = await db.exec(
        'INSERT INTO session_control_requests (key, fingerprint, session_id, input_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING',
        [key, fingerprint, sessionId, inputId, Date.now()]);
      assertCurrent();
      if (!reserved.changes) {
        const row = await read(request);
        if (!row) throw new SessionAdmissionError('UNKNOWN_OUTCOME', 'Request reservation is unavailable');
        if (row.receipt !== null) return JSON.parse(row.receipt) as T;
        const outcome = await reconcile(row);
        assertCurrent();
        if (outcome !== undefined) return outcome;
        throw new SessionAdmissionError('UNKNOWN_OUTCOME', 'Request was reserved; reconcile with the same business key');
      }
      const result = await execute({ sessionId, inputId });
      assertCurrent();
      await db.exec('UPDATE session_control_requests SET receipt = ? WHERE key = ? AND fingerprint = ?',
        [JSON.stringify(result), key, fingerprint]);
      assertCurrent();
      return result;
    },
  };
}
