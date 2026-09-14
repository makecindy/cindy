import { createHash } from 'node:crypto';

/** Raw ordered prefix used for both the recovery handoff and the copied history. */
export interface ForkSourceMessage {
  client_id: string;
  role: string;
  content: string;
  tool_use_id: string | null;
  agent_meta: string | null;
  agent_kind: string | null;
  created_at: number;
}

/** Transaction precondition only; never persisted or derived from the truncated handoff. */
export function computeForkSourceMessagesDigest(rows: readonly ForkSourceMessage[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(JSON.stringify([
      row.client_id, row.role, row.content, row.tool_use_id ?? null,
      row.agent_meta ?? null, row.agent_kind ?? null, row.created_at,
    ])).update('\n');
  }
  return hash.digest('hex');
}
