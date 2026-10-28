import type Database from 'better-sqlite3';

/** Credential values never cross the database worker boundary. */
export interface CustomMcpCommit {
  id: string;
  name: string;
  transport: string;
  url: string;
  headers: string;
  credentialRef: string | null;
  expectedRevision: number | null;
  now: number;
  credentialFormat?: 1 | 2;
  receipt?: { operationId: string; sessionId: string };
}
export function commitCustomMcp(
  db: Database.Database,
  input: CustomMcpCommit,
): { revision: number } {
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT updated_at FROM custom_mcp_servers WHERE id = ?')
      .get(input.id) as { updated_at: number } | undefined;
    if (
      input.expectedRevision === null
        ? existing !== undefined
        : existing?.updated_at !== input.expectedRevision
    )
      throw new Error('CONFIG_CONFLICT');
    const revision = Math.max(input.now, (existing?.updated_at ?? 0) + 1);
    if (existing) {
      db.prepare(
        'UPDATE custom_mcp_servers SET name=?, transport=?, url=?, headers=?, credential_format=?, credential_ref=?, updated_at=? WHERE id=? AND updated_at=?',
      ).run(
        input.name,
        input.transport,
        input.url,
        input.headers,
        input.credentialFormat ?? 1,
        input.credentialRef,
        revision,
        input.id,
        input.expectedRevision,
      );
    } else {
      db.prepare(
        'INSERT INTO custom_mcp_servers (id,name,transport,url,headers,credential_format,credential_ref,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM custom_mcp_servers),?,?)',
      ).run(
        input.id,
        input.name,
        input.transport,
        input.url,
        input.headers,
        input.credentialFormat ?? 1,
        input.credentialRef,
        revision,
        revision,
      );
    }
    if (input.receipt)
      db.prepare(
        'INSERT INTO custom_mcp_setup_receipts (operation_id, session_id, server_id, created_at) VALUES (?,?,?,?)',
      ).run(input.receipt.operationId, input.receipt.sessionId, input.id, revision);
    return { revision };
  })();
}
