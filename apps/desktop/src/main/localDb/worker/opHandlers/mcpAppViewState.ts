import type Database from 'better-sqlite3';

export interface ViewStateBinding {
  sessionId: string;
  clientId: string;
  serverId: string;
  serverRevision: string;
  resourceUri: string;
  toolName: string;
  pluginInstance: string | null;
}
export interface ViewStateRow {
  id: string;
  content: string;
  meta: string | null;
  remoteHostId: string | null;
  stateJson: string | null;
  byteLength: number | null;
  serverId: string | null;
  serverRevision: string | null;
  pluginInstance: string | null;
}
// These functions are also embedded in the legacy inline worker.
export function viewStateCardSql(): string {
  return `SELECT m.id, m.content, m.agent_meta AS meta, s.remote_host_id AS remoteHostId,
    v.state_json AS stateJson, v.byte_length AS byteLength, v.server_id AS serverId,
    v.server_revision AS serverRevision, v.plugin_instance AS pluginInstance
    FROM messages m JOIN sessions s ON s.id = m.session_id
    LEFT JOIN mcp_app_view_states v ON v.message_id = m.id
    WHERE m.session_id = ? AND m.client_id = ? AND m.role = 'assistant'
    AND m.rewind_at IS NULL AND s.status = 'active'
    AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at) LIMIT 1`;
}
export function assertViewStateCard(row: ViewStateRow | undefined, binding: ViewStateBinding): asserts row is ViewStateRow {
  let valid = false;
  try {
    const card = row && JSON.parse(row.content)?.mcpApp;
    valid = !!row && JSON.parse(row.meta ?? 'null')?.mcpApp === true && card?.version === 1 &&
      card.serverId === binding.serverId && card.serverRevision === binding.serverRevision &&
      card.resourceUri === binding.resourceUri && card.resourceUri.startsWith('ui://') &&
      card.tool?.name === binding.toolName && card.tool.inputSchema?.type === 'object' &&
      card.arguments && typeof card.arguments === 'object' && !Array.isArray(card.arguments) &&
      (!card.result || Array.isArray(card.result.content)) &&
      !(binding.pluginInstance && row.remoteHostId) &&
      (row.stateJson === null || (row.serverId === binding.serverId &&
        row.serverRevision === binding.serverRevision && row.pluginInstance === binding.pluginInstance));
  } catch { /* Invalid or replaced cards cannot expose saved drafts. */ }
  if (!valid) throw Object.assign(new Error('MCP_APP_CARD_UNAVAILABLE'), { code: 'MCP_APP_CARD_UNAVAILABLE' });
}
export function saveMcpAppViewState(db: Database.Database, args: unknown): void {
  const { binding, json, bytes } = args as { binding: ViewStateBinding; json: string | null; bytes: number };
  db.transaction(() => {
    const row = db.prepare(viewStateCardSql()).get(binding.sessionId, binding.clientId) as ViewStateRow | undefined;
    assertViewStateCard(row, binding);
    const total = db.prepare('SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM mcp_app_view_states WHERE session_id = ?')
      .get(binding.sessionId) as { bytes: number };
    if (total.bytes - (row.byteLength ?? 0) + bytes > 1048576)
      throw Object.assign(new Error('CINDY_VIEW_STATE_QUOTA_EXCEEDED'), { code: 'CINDY_VIEW_STATE_QUOTA_EXCEEDED' });
    if (json === null) db.prepare('DELETE FROM mcp_app_view_states WHERE message_id = ?').run(row.id);
    else db.prepare(`INSERT INTO mcp_app_view_states
      (message_id, session_id, server_id, server_revision, plugin_instance, state_json, byte_length)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET
      state_json = excluded.state_json, byte_length = excluded.byte_length`).run(
      row.id, binding.sessionId, binding.serverId, binding.serverRevision, binding.pluginInstance, json, bytes);
  })();
}

/** Call inside the transaction that marks these tasks deleted; archived tasks retain state. */
export function deleteDeletedSessionViewStates(db: Database.Database, sessionIds: string[]): void {
  if (!sessionIds.length) return;
  const remove = db.prepare(`DELETE FROM mcp_app_view_states WHERE session_id = ?
    AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND status = 'deleted')`);
  for (const sessionId of sessionIds) remove.run(sessionId, sessionId);
}
