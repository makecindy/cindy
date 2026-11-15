import type { DbClient } from '../localDb/client/DbClient.js';
import { supplementalConversationEstimates } from '@cindy/maker-shared/usage-cost-details';
import { readPriorUserRoundCost } from '../localDb/ipc/messages.js';
import {
  addCompatibleRegionalMoney,
  asValueEstimateMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
} from '../../shared/regionalMoney.js';
import type { MessageTurnCostPayload } from '../../shared/turnCostPayload.js';
import { buildTurnUsageDetails, normalizeTurnUsageDetails } from '../../shared/turnUsageDetails.js';

const realUser = `m.role = 'user' AND CASE WHEN json_valid(m.agent_meta)
  THEN json_extract(m.agent_meta, '$.autoResume') END IS NOT 1`;

/** Run in the message persistence FIFO before dispatch, while this turn owns the tool call. */
export async function captureMediaUserTurn(db: DbClient, sessionId: string) {
  const row = await db.queryOne<{ clientId: string; agentMeta: string | null }>(
    `SELECT m.client_id AS clientId, m.agent_meta AS agentMeta FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = ? AND ${realUser} AND m.rewind_at IS NULL
        AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
    [sessionId],
  );
  if (!row) return null;
  let scheduleId: string | undefined;
  try {
    const origin = JSON.parse(row.agentMeta ?? '{}')?.origin;
    if (origin?.kind === 'scheduler' && typeof origin.scheduleId === 'string') {
      scheduleId = origin.scheduleId;
    }
  } catch {
    /* metadata without a scheduler origin */
  }
  return { clientId: row.clientId, scheduleId };
}

/** Refresh an already finished response too, without moving a late fee into the next user turn. */
export async function refreshMediaUserTurnCost(
  db: DbClient,
  sessionId: string,
  userClientId: string,
): Promise<MessageTurnCostPayload | null> {
  const row = await db.queryOne<{ clientId: string; agentMeta: string | null }>(
    `SELECT a.client_id AS clientId, a.agent_meta AS agentMeta FROM messages a
      JOIN messages u ON u.session_id = a.session_id AND u.client_id = ? AND u.role = 'user'
      JOIN sessions s ON s.id = a.session_id
      WHERE a.session_id = ? AND a.role = 'assistant' AND a.rewind_at IS NULL
        AND u.rewind_at IS NULL AND (s.cleared_at IS NULL OR u.created_at > s.cleared_at)
        AND (a.created_at, a.rowid) > (u.created_at, u.rowid)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = a.session_id
          AND ${realUser} AND m.rewind_at IS NULL
          AND (m.created_at, m.rowid) > (u.created_at, u.rowid)
          AND (m.created_at, m.rowid) <= (a.created_at, a.rowid))
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    [userClientId, sessionId],
  );
  if (!row) return null;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.agentMeta ?? '{}') ?? {};
  } catch {
    /* legacy metadata */
  }
  const prior = await readPriorUserRoundCost(sessionId, row.clientId, db);
  const raw =
    normalizeRegionalMoney(meta.turnCost) ??
    (typeof meta.turnCostUsd === 'number' &&
    Number.isFinite(meta.turnCostUsd) &&
    meta.turnCostUsd > 0
      ? legacyUsdMoney(meta.turnCostUsd)
      : null);
  const current = raw && meta.turnCostIsEstimate === true ? asValueEstimateMoney(raw) : raw;
  const money = addCompatibleRegionalMoney(
    [...(prior.money ? [prior.money] : []), ...(current ? [current] : []), ...supplementalConversationEstimates(meta)],
    current?.currency,
  );
  if (!money) return null;
  const isEstimate = money.kind === 'value-estimate' ||
    supplementalConversationEstimates(meta).some(value => value.currency === money.currency) ||
    (prior.money?.currency === money.currency && prior.hasEstimatedValue) ||
    (current?.currency === money.currency && current.kind === 'value-estimate');
  const patch = {
    turnUsageDetails: buildTurnUsageDetails({ ...normalizeTurnUsageDetails(meta.turnUsageDetails),
      additionalCosts: prior.additionalCosts }),
    userTurnCost: money,
    userTurnCostIsEstimate: isEstimate,
    // JSON merge patch removes a stale USD compatibility projection for CNY.
    userTurnCostUsd: money.currency === 'USD' ? money.amount : null,
  };
  await db.exec(
    `UPDATE messages SET agent_meta = json_patch(
    CASE WHEN json_valid(agent_meta) THEN agent_meta ELSE '{}' END, ?)
    WHERE session_id = ? AND client_id = ? AND rewind_at IS NULL`,
    [JSON.stringify(patch), sessionId, row.clientId],
  );
  return {
    sessionId,
    clientId: row.clientId,
    ...(patch.turnUsageDetails ? { turnUsageDetails: patch.turnUsageDetails } : {}),
    userTurnMoney: money,
    userTurnCostIsEstimate: isEstimate,
    ...(money.currency === 'USD' ? { userTurnCostUsd: money.amount } : {}),
  };
}
