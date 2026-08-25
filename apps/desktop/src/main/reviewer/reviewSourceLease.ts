import { createId } from '@paralleldrive/cuid2';

import { readReviewRunOwner, type ReviewRunOwner } from '../../shared/reviewRun.js';
import type { DbClient } from '../localDb/client/DbClient.js';

/** One hidden row per source task makes the cross-process Review gate atomic. */
export const REVIEW_SOURCE_LEASE_CLIENT_ID = 'review:source-lease:v1';

export interface ReviewSourceLease {
  version: 1;
  runId: string;
  owner: ReviewRunOwner;
}

export interface PersistedReviewSourceLeaseRow {
  id: string;
  sourceSessionId: string;
  lease: ReviewSourceLease | null;
}

function reviewSourceLeaseAgentMeta(lease: ReviewSourceLease): string {
  return JSON.stringify({ reviewSourceLease: lease });
}

function reviewSourceLeaseToken(lease: ReviewSourceLease): string {
  return JSON.stringify({
    version: lease.version,
    runId: lease.runId,
    ownerInstanceId: lease.owner.instanceId,
  });
}

export function readReviewSourceLeaseFromAgentMeta(value: unknown): ReviewSourceLease | null {
  let envelope = value;
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope) as unknown;
    } catch {
      return null;
    }
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const valueRecord = (envelope as Record<string, unknown>).reviewSourceLease;
  if (!valueRecord || typeof valueRecord !== 'object' || Array.isArray(valueRecord)) return null;
  const lease = valueRecord as Record<string, unknown>;
  const owner = lease.owner;
  if (
    lease.version !== 1 ||
    typeof lease.runId !== 'string' ||
    !lease.runId ||
    !owner ||
    typeof owner !== 'object' ||
    Array.isArray(owner)
  ) {
    return null;
  }
  if (!readReviewRunOwner(owner)) return null;
  return valueRecord as unknown as ReviewSourceLease;
}

/**
 * The unique messages(session_id, client_id) index is the compare-and-insert.
 * A rewound assistant row stays out of history, FTS, prompts, and Review context.
 */
export async function tryAcquireReviewSourceLease(
  dbClient: Pick<DbClient, 'exec'>,
  input: {
    sourceSessionId: string;
    runId: string;
    owner: ReviewRunOwner;
    createdAt: number;
  },
): Promise<boolean> {
  const lease: ReviewSourceLease = {
    version: 1,
    runId: input.runId,
    owner: input.owner,
  };
  const result = await dbClient.exec(
    `INSERT INTO messages (
       id, client_id, session_id, role, content, agent_meta, created_at, rewind_at
     ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)
     ON CONFLICT(session_id, client_id) DO NOTHING`,
    [
      createId(),
      REVIEW_SOURCE_LEASE_CLIENT_ID,
      input.sourceSessionId,
      reviewSourceLeaseToken(lease),
      reviewSourceLeaseAgentMeta(lease),
      input.createdAt,
      input.createdAt,
    ],
  );
  return result.changes === 1;
}

/** Delete only the exact lease acquired by this run, never a newer successor. */
export async function releaseReviewSourceLease(
  dbClient: Pick<DbClient, 'exec'>,
  input: {
    sourceSessionId: string;
    runId: string;
    owner: ReviewRunOwner;
  },
): Promise<boolean> {
  const lease: ReviewSourceLease = {
    version: 1,
    runId: input.runId,
    owner: input.owner,
  };
  const result = await dbClient.exec(
    `DELETE FROM messages
      WHERE session_id = ? AND client_id = ? AND content = ?`,
    [input.sourceSessionId, REVIEW_SOURCE_LEASE_CLIENT_ID, reviewSourceLeaseToken(lease)],
  );
  return result.changes === 1;
}

/** Read one task's lease through the existing (session_id, client_id) index. */
export async function readPersistedReviewSourceLease(
  dbClient: Pick<DbClient, 'query'>,
  sourceSessionId: string,
): Promise<PersistedReviewSourceLeaseRow | null> {
  const rows = await dbClient.query<{
    id: string;
    sourceSessionId: string;
    agentMeta: unknown;
  }>(
    `SELECT id, session_id AS sourceSessionId, agent_meta AS agentMeta
       FROM messages
      WHERE session_id = ? AND client_id = ?
      LIMIT 1`,
    [sourceSessionId, REVIEW_SOURCE_LEASE_CLIENT_ID],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        sourceSessionId: row.sourceSessionId,
        lease: readReviewSourceLeaseFromAgentMeta(row.agentMeta),
      }
    : null;
}

/** Remove a malformed legacy/corrupt row only if its immutable id still matches. */
export async function discardInvalidReviewSourceLease(
  dbClient: Pick<DbClient, 'exec'>,
  row: Pick<PersistedReviewSourceLeaseRow, 'id' | 'sourceSessionId'>,
): Promise<boolean> {
  const result = await dbClient.exec(
    `DELETE FROM messages
      WHERE id = ? AND session_id = ? AND client_id = ?`,
    [row.id, row.sourceSessionId, REVIEW_SOURCE_LEASE_CLIENT_ID],
  );
  return result.changes === 1;
}
