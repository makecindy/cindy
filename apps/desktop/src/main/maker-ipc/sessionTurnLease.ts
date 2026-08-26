import { createId } from '@paralleldrive/cuid2';

import { readReviewRunOwner, type ReviewRunOwner } from '../../shared/reviewRun.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { hasReviewOwnerProcessEnded } from '../reviewer/reviewRunRecovery.js';

/** One hidden row per task/process exposes every live turn to shared-userData peers. */
export const SESSION_TURN_LEASE_CLIENT_ID_PREFIX = 'session:turn-lease:v1:';

export interface SessionTurnLease {
  version: 1;
  turnId: string;
  owner: ReviewRunOwner;
}

export interface PersistedSessionTurnLeaseRow {
  id: string;
  clientId: string;
  sessionId: string;
  lease: SessionTurnLease | null;
}

type SilentStopTurnPhase = 'scheduled' | 'handling' | 'settled';

interface SilentStopTurnState {
  turnLeaseId: string;
  phase: SilentStopTurnPhase;
}

/**
 * Binds one current-generation silent-stop terminal to one delayed decision.
 * Duplicate terminals never create a second timer, and an older timer cannot
 * claim a newer generation after another provider turn supersedes it.
 */
export class SilentStopTurnLeaseGate {
  private readonly states = new Map<string, SilentStopTurnState>();
  private readonly eventTurnLeaseIds = new WeakMap<object, string>();

  schedule(sessionId: string, event: object, turnLeaseId: string): boolean {
    const current = this.states.get(sessionId);
    if (current?.turnLeaseId === turnLeaseId) return false;
    this.states.set(sessionId, { turnLeaseId, phase: 'scheduled' });
    this.eventTurnLeaseIds.set(event, turnLeaseId);
    return true;
  }

  turnLeaseIdForEvent(event: object): string | undefined {
    return this.eventTurnLeaseIds.get(event);
  }

  claim(sessionId: string, turnLeaseId: string): boolean {
    const current = this.states.get(sessionId);
    if (current?.turnLeaseId !== turnLeaseId || current.phase !== 'scheduled') return false;
    this.states.set(sessionId, { turnLeaseId, phase: 'handling' });
    return true;
  }

  settle(sessionId: string, turnLeaseId: string): void {
    const current = this.states.get(sessionId);
    if (current?.turnLeaseId !== turnLeaseId) return;
    this.states.set(sessionId, { turnLeaseId, phase: 'settled' });
  }

  supersede(sessionId: string): void {
    this.states.delete(sessionId);
  }

  supersedeOwnedBy(sessionId: string, turnLeaseIdPrefix: string): void {
    const current = this.states.get(sessionId);
    if (current?.turnLeaseId.startsWith(turnLeaseIdPrefix)) this.states.delete(sessionId);
  }
}

type SessionTurnLeaseDb = Pick<DbClient, 'exec' | 'query'>;

function sessionTurnLeaseAgentMeta(lease: SessionTurnLease): string {
  return JSON.stringify({ sessionTurnLease: lease });
}

function sessionTurnLeaseToken(lease: SessionTurnLease): string {
  return JSON.stringify({
    version: lease.version,
    turnId: lease.turnId,
    ownerInstanceId: lease.owner.instanceId,
  });
}

function sessionTurnLeaseClientId(owner: ReviewRunOwner): string {
  return `${SESSION_TURN_LEASE_CLIENT_ID_PREFIX}${owner.instanceId}`;
}

export function readSessionTurnLeaseFromAgentMeta(value: unknown): SessionTurnLease | null {
  let envelope = value;
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope) as unknown;
    } catch {
      return null;
    }
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const valueRecord = (envelope as Record<string, unknown>).sessionTurnLease;
  if (!valueRecord || typeof valueRecord !== 'object' || Array.isArray(valueRecord)) return null;
  const lease = valueRecord as Record<string, unknown>;
  const owner = lease.owner;
  if (
    lease.version !== 1 ||
    typeof lease.turnId !== 'string' ||
    !lease.turnId ||
    !owner ||
    typeof owner !== 'object' ||
    Array.isArray(owner)
  ) {
    return null;
  }
  if (!readReviewRunOwner(owner)) return null;
  return valueRecord as unknown as SessionTurnLease;
}

/** The messages(session_id, client_id) unique index is the atomic compare-and-insert. */
export async function tryAcquireSessionTurnLease(
  dbClient: SessionTurnLeaseDb,
  input: {
    sessionId: string;
    turnId: string;
    owner: ReviewRunOwner;
    createdAt: number;
  },
): Promise<boolean> {
  const lease: SessionTurnLease = { version: 1, turnId: input.turnId, owner: input.owner };
  const result = await dbClient.exec(
    `INSERT INTO messages (
       id, client_id, session_id, role, content, agent_meta, created_at, rewind_at
     ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)
     ON CONFLICT(session_id, client_id) DO NOTHING`,
    [
      createId(),
      sessionTurnLeaseClientId(input.owner),
      input.sessionId,
      sessionTurnLeaseToken(lease),
      sessionTurnLeaseAgentMeta(lease),
      input.createdAt,
      input.createdAt,
    ],
  );
  return result.changes === 1;
}

/** Atomically replace one exact generation without exposing a lease-free gap. */
export async function replaceSessionTurnLease(
  dbClient: Pick<DbClient, 'exec'>,
  input: {
    sessionId: string;
    previousTurnId: string;
    nextTurnId: string;
    owner: ReviewRunOwner;
    createdAt: number;
  },
): Promise<boolean> {
  const previousLease: SessionTurnLease = {
    version: 1,
    turnId: input.previousTurnId,
    owner: input.owner,
  };
  const nextLease: SessionTurnLease = {
    version: 1,
    turnId: input.nextTurnId,
    owner: input.owner,
  };
  const result = await dbClient.exec(
    `UPDATE messages
        SET content = ?, agent_meta = ?, created_at = ?, rewind_at = ?
      WHERE session_id = ? AND client_id = ? AND content = ?`,
    [
      sessionTurnLeaseToken(nextLease),
      sessionTurnLeaseAgentMeta(nextLease),
      input.createdAt,
      input.createdAt,
      input.sessionId,
      sessionTurnLeaseClientId(input.owner),
      sessionTurnLeaseToken(previousLease),
    ],
  );
  return result.changes === 1;
}

/** Refresh one live generation's owner proof without changing its turn identity. */
export async function refreshSessionTurnLeaseOwner(
  dbClient: Pick<DbClient, 'exec'>,
  input: {
    sessionId: string;
    turnId: string;
    owner: ReviewRunOwner;
  },
): Promise<boolean> {
  const lease: SessionTurnLease = {
    version: 1,
    turnId: input.turnId,
    owner: input.owner,
  };
  const result = await dbClient.exec(
    `UPDATE messages
        SET agent_meta = ?
      WHERE session_id = ? AND client_id = ? AND content = ?`,
    [
      sessionTurnLeaseAgentMeta(lease),
      input.sessionId,
      sessionTurnLeaseClientId(input.owner),
      sessionTurnLeaseToken(lease),
    ],
  );
  return result.changes === 1;
}

/** Delete only the exact turn that acquired the row; a delayed end cannot delete its successor. */
export async function releaseSessionTurnLease(
  dbClient: Pick<DbClient, 'exec'>,
  input: { sessionId: string; turnId: string; owner: ReviewRunOwner },
): Promise<boolean> {
  const lease: SessionTurnLease = { version: 1, turnId: input.turnId, owner: input.owner };
  const result = await dbClient.exec(
    `DELETE FROM messages
      WHERE session_id = ? AND client_id = ? AND content = ?`,
    [input.sessionId, sessionTurnLeaseClientId(input.owner), sessionTurnLeaseToken(lease)],
  );
  return result.changes === 1;
}

/** Read and recover turn leases only when that exact task needs them. */
export async function readPersistedSessionTurnLeases(
  dbClient: Pick<DbClient, 'query'>,
  sessionId: string,
): Promise<PersistedSessionTurnLeaseRow[]> {
  const rows = await dbClient.query<{
    id: string;
    clientId: string;
    sessionId: string;
    agentMeta: unknown;
  }>(
    `SELECT id, client_id AS clientId, session_id AS sessionId, agent_meta AS agentMeta
       FROM messages
      WHERE session_id = ? AND client_id LIKE ?`,
    [sessionId, `${SESSION_TURN_LEASE_CLIENT_ID_PREFIX}%`],
  );
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    sessionId: row.sessionId,
    lease: readSessionTurnLeaseFromAgentMeta(row.agentMeta),
  }));
}

/** Remove a malformed row only while its immutable id still identifies the same lease row. */
export async function discardInvalidSessionTurnLease(
  dbClient: Pick<DbClient, 'exec'>,
  row: Pick<PersistedSessionTurnLeaseRow, 'id' | 'clientId' | 'sessionId'>,
): Promise<boolean> {
  const result = await dbClient.exec(
    `DELETE FROM messages
      WHERE id = ? AND session_id = ? AND client_id = ?`,
    [row.id, row.sessionId, row.clientId],
  );
  return result.changes === 1;
}

export interface SessionTurnLeaseTrackerDeps {
  getDbClient(): SessionTurnLeaseDb;
  owner: ReviewRunOwner;
  createTurnId(): string;
  now(): number;
  ownerProcessEnded?(
    owner: ReviewRunOwner,
    currentOwner: ReviewRunOwner,
  ): boolean | Promise<boolean>;
  warn?(message: string, fields: Record<string, unknown>): void;
}

/**
 * Mirrors the in-memory turn boundary into SQLite for shared-userData peers.
 * Writes for one task stay ordered, so a rapid end/start cannot let an old
 * release delete the new lease. The existing active-turn timestamps remain
 * untouched because they have separate interrupted-turn recovery semantics.
 */
export class SessionTurnLeaseTracker {
  private readonly activeTurnIds = new Map<string, string>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionTurnLeaseTrackerDeps) {}

  private enqueue(sessionId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const observed = next
      .catch((error) => {
        this.deps.warn?.('session turn lease write failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.writes.get(sessionId) === observed) this.writes.delete(sessionId);
      });
    this.writes.set(sessionId, observed);
    return next;
  }

  private ownerProcessEnded(owner: ReviewRunOwner): boolean | Promise<boolean> {
    return (this.deps.ownerProcessEnded ?? hasReviewOwnerProcessEnded)(owner, this.deps.owner);
  }

  private async clearRecoverableLease(
    dbClient: SessionTurnLeaseDb,
    row: PersistedSessionTurnLeaseRow,
  ): Promise<boolean> {
    if (!row.lease) return discardInvalidSessionTurnLease(dbClient, row);
    if (row.lease.owner.instanceId === this.deps.owner.instanceId) {
      if (this.activeTurnIds.get(row.sessionId) === row.lease.turnId) return false;
      return releaseSessionTurnLease(dbClient, {
        sessionId: row.sessionId,
        turnId: row.lease.turnId,
        owner: row.lease.owner,
      });
    }
    if (!(await this.ownerProcessEnded(row.lease.owner))) return false;
    return releaseSessionTurnLease(dbClient, {
      sessionId: row.sessionId,
      turnId: row.lease.turnId,
      owner: row.lease.owner,
    });
  }

  markTurnStarted(sessionId: string, requestedTurnId?: string): Promise<void> {
    const turnId = requestedTurnId ?? this.deps.createTurnId();
    const previousTurnId = this.activeTurnIds.get(sessionId);
    if (previousTurnId === turnId) return this.writes.get(sessionId) ?? Promise.resolve();
    this.activeTurnIds.set(sessionId, turnId);
    return this.enqueue(sessionId, async () => {
      try {
        const dbClient = this.deps.getDbClient();
        if (
          previousTurnId &&
          (await replaceSessionTurnLease(dbClient, {
            sessionId,
            previousTurnId,
            nextTurnId: turnId,
            owner: this.deps.owner,
            createdAt: this.deps.now(),
          }))
        ) {
          return;
        }
        if (
          await tryAcquireSessionTurnLease(dbClient, {
            sessionId,
            turnId,
            owner: this.deps.owner,
            createdAt: this.deps.now(),
          })
        ) {
          return;
        }
        const rows = await readPersistedSessionTurnLeases(dbClient, sessionId);
        const ownRow = rows.find(
          (row) => row.clientId === sessionTurnLeaseClientId(this.deps.owner),
        );
        if (!ownRow || !(await this.clearRecoverableLease(dbClient, ownRow))) {
          throw new Error('could not replace the previous turn lease');
        }
        const acquired = await tryAcquireSessionTurnLease(dbClient, {
          sessionId,
          turnId,
          owner: this.deps.owner,
          createdAt: this.deps.now(),
        });
        if (!acquired) throw new Error('turn lease changed while it was being replaced');
      } catch (error) {
        if (this.activeTurnIds.get(sessionId) === turnId) {
          this.activeTurnIds.delete(sessionId);
        }
        throw error;
      }
    });
  }

  markTurnEnded(sessionId: string, expectedTurnId?: string): Promise<void> {
    const turnId = this.activeTurnIds.get(sessionId);
    if (!turnId) return this.writes.get(sessionId) ?? Promise.resolve();
    if (expectedTurnId && turnId !== expectedTurnId) {
      return this.writes.get(sessionId) ?? Promise.resolve();
    }
    this.activeTurnIds.delete(sessionId);
    return this.enqueue(sessionId, async () => {
      await releaseSessionTurnLease(this.deps.getDbClient(), {
        sessionId,
        turnId,
        owner: this.deps.owner,
      });
    });
  }

  /** Add newly available exact-instance liveness to this process's active leases only. */
  async refreshActiveLeaseOwners(): Promise<void> {
    const activeTurns = [...this.activeTurnIds.entries()];
    await Promise.all(
      activeTurns.map(([sessionId, turnId]) =>
        this.enqueue(sessionId, async () => {
          if (this.activeTurnIds.get(sessionId) !== turnId) return;
          const refreshed = await refreshSessionTurnLeaseOwner(this.deps.getDbClient(), {
            sessionId,
            turnId,
            owner: this.deps.owner,
          });
          if (!refreshed && this.activeTurnIds.get(sessionId) === turnId) {
            throw new Error('could not refresh the active turn lease owner');
          }
        }),
      ),
    );
  }

  /** End one exact generation and report whether no local/shared successor remains. */
  async markTurnEndedAndCheckIdle(sessionId: string, expectedTurnId: string): Promise<boolean> {
    await this.markTurnEnded(sessionId, expectedTurnId);
    return !(await this.isTurnActive(sessionId));
  }

  async isTurnActive(sessionId: string): Promise<boolean> {
    await this.writes.get(sessionId);
    if (this.activeTurnIds.has(sessionId)) return true;
    const dbClient = this.deps.getDbClient();
    const rows = await readPersistedSessionTurnLeases(dbClient, sessionId);
    let active = false;
    for (const row of rows) {
      if (!(await this.clearRecoverableLease(dbClient, row))) active = true;
    }
    return active;
  }
}
