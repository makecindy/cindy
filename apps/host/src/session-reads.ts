import type { DbClient } from '../../desktop/src/main/localDb/client/DbClient.js';
import {
  flattenSessionReadRow,
  projectSessionReadResult,
  selectOrdinarySessionListRows,
  selectSessionWithCount,
} from '../../desktop/src/main/localDb/sessionQueries.js';

/** The authenticated Host entry supplies the current owner's database. */
export async function readHostSessionList(db: DbClient['drizzle'], body?: Record<string, unknown> | null) {
  const status = body?.status;
  const statusFilter = status === 'active' || status === 'archived' ? status : null;
  const cap = typeof body?.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
    ? Math.min(Math.max(Math.floor(body.limit), 1), 1000)
    : 1000;
  const options = body?.options;
  const includePinned = !!(options && typeof options === 'object'
    && (options as { includePinned?: unknown }).includePinned === true);
  // Do not forward desktop-only privileged cursor / ID / usage-history reads.
  const rows = await selectOrdinarySessionListRows(db, { cap, statusFilter, includePinned });
  return rows.map(row => projectSessionReadResult(flattenSessionReadRow(row)));
}

export async function readHostSession(db: DbClient['drizzle'], sessionId: string) {
  const row = await selectSessionWithCount(db, sessionId);
  if (!row || row.status === 'deleted') throw new Error('session not found');
  return projectSessionReadResult(row);
}
