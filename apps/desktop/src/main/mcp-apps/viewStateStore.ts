import type { DbClient } from '../localDb/client/DbClient.js';
import type { ViewStateBinding, ViewStateRow } from '../localDb/worker/opHandlers/mcpAppViewState.js';
import { viewStateCardSql, assertViewStateCard } from '../localDb/worker/opHandlers/mcpAppViewState.js';
import { createLogger } from '../logger.js';
import { viewStateError, viewStateSnapshot, type ViewStateStorage } from './viewState.js';

/** The client is captured once; a queued operation never resolves another account's database. */
export function createViewStateStorage(client: DbClient, binding: ViewStateBinding, assertCurrent: () => void): ViewStateStorage {
  const error = (cause: unknown): never => {
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    throw viewStateError(code === 'MCP_APP_CARD_UNAVAILABLE' || code === 'CINDY_VIEW_STATE_QUOTA_EXCEEDED'
      ? code : 'CINDY_VIEW_STATE_STORAGE_UNAVAILABLE');
  };
  return {
    async read() {
      try {
        assertCurrent();
        const row = await client.queryOne<ViewStateRow>(viewStateCardSql(), [binding.sessionId, binding.clientId]);
        assertCurrent();
        assertViewStateCard(row, binding);
        const state: unknown = row.stateJson === null ? null : JSON.parse(row.stateJson);
        viewStateSnapshot(state);
        return state;
      } catch (cause) { return error(cause); }
    },
    async save(snapshot) {
      try {
        assertCurrent();
        await client.tx('mcpApps.viewState.save', { binding, ...snapshot });
        // A completed commit must not be reported as a rolled-back failure.
        // Existing View/owner guards control whether the reply can still be delivered.
      } catch (cause) { error(cause); }
    },
  };
}

const reconciled = new WeakSet<DbClient>();
/** One owner-scoped startup attempt, never on card reads or polls. */
export async function reconcileDeletedTaskViewState(client: DbClient, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent() || reconciled.has(client)) return;
  reconciled.add(client);
  try {
    await client.exec("DELETE FROM mcp_app_view_states WHERE session_id IN (SELECT id FROM sessions WHERE status = 'deleted')");
  } catch {
    createLogger('mcp-apps').warn('CINDY_VIEW_STATE_CLEANUP_UNAVAILABLE');
  }
}
