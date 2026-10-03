import type { DbClient } from '../localDb/client/DbClient.js';
import { hasAcceptedUserTaskInput, type AcceptedTaskInput } from '../maker-ipc/pluginTaskInput.js';

/** Companion tasks add their profile tools to the ordinary transport's helper surface.
 * Classification is a business-object distinction, not a separate permission tier.
 */
export function classifyHelperSurface(
  source: string | null | undefined,
  hasBotLink: boolean,
  main?: { role: string | null | undefined; status: string | null | undefined; remoteHostId: string | null | undefined },
): 'bot' | 'bot-main' | 'default' {
  if (source !== 'bot' && !hasBotLink) return 'default';
  return source === 'bot' && hasBotLink && main?.role === 'canonical' && main.status === 'active' && !main.remoteHostId
    ? 'bot-main'
    : 'bot';
}

/** Reuse the helper's existing runtime gate; plugin tasks need Orca, not account-wide helper tools. */
export async function resolveHelperSurface(
  db: Pick<DbClient, 'queryOne' | 'drizzle'>,
  sessionId: string,
  readExecution: (sessionId: string) => { executing: boolean; input: AcceptedTaskInput | null },
): Promise<'bot' | 'bot-main' | 'default' | 'restricted'> {
  const execution = readExecution(sessionId);
  const row = await db.queryOne<{
    source: string; botId: string | null; botRole: string | null; status: string | null; remoteHostId: string | null;
    pluginOwned: number; retainedPlugin: number; isWorker: number;
  }>(
    `SELECT s.source AS source, b.bot_id AS botId,
       CASE WHEN b.archived_at IS NULL THEN b.role ELSE NULL END AS botRole, s.status AS status,
       s.remote_host_id AS remoteHostId, w.session_id IS NOT NULL AS isWorker,
       EXISTS (SELECT 1 FROM plugin_task_requests p
         WHERE p.operation = 'create' AND p.id IN (s.id, t.lead_session_id)) AS retainedPlugin,
       EXISTS (
         SELECT 1 FROM plugin_task_requests p
          WHERE p.operation = 'create' AND p.id IN (s.id, t.lead_session_id)
            AND CASE WHEN json_valid(p.payload) THEN
              CASE WHEN json_type(p.payload) = 'object'
                     AND json_type(p.payload, '$.ownershipRevoked') = 'true'
                   THEN 0 ELSE 1 END
              ELSE 1 END = 1
       ) AS pluginOwned
       FROM sessions s
       LEFT JOIN bot_session_links b ON b.session_id = s.id
       LEFT JOIN orca_workers w ON w.session_id = s.id
       LEFT JOIN orca_teams t ON t.id = w.team_id
      WHERE s.id = ? LIMIT 1`,
    [sessionId],
  );
  // Retained Workers inherit the Lead's receipt even after the team ends.
  // Revocation does not make still-executing plugin input a trusted user input.
  // Bad receipts stay restricted; legacy plugin-source tasks have no receipt.
  if (!row || row.pluginOwned) return 'restricted';
  if (row.retainedPlugin) {
    if (execution.executing && !await hasAcceptedUserTaskInput(db, sessionId, execution.input, !!row.isWorker)) return 'restricted';
    // Do not transfer an in-flight tool call to a different accepted input.
    const current = readExecution(sessionId);
    if (current.executing !== execution.executing
      || (['clientId', 'autoResume', 'retrySourceClientId', 'authoredText', 'originKind'] as const)
        .some(key => current.input?.[key] !== execution.input?.[key])) return 'restricted';
  }
  return classifyHelperSurface(row.source, Boolean(row.botId), {
    role: row.botRole,
    status: row.status,
    remoteHostId: row.remoteHostId,
  });
}
