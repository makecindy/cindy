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

export interface ForkSourceMessageCamelCase {
  clientId: string;
  role: string;
  content: string;
  toolUseId: string | null;
  agentMeta: string | null;
  agentKind: string | null;
  createdAt: number;
}

/** Transaction precondition only; never persisted or derived from the truncated handoff. */
export function computeForkSourceMessagesDigest(
  rows: readonly (ForkSourceMessage | ForkSourceMessageCamelCase)[],
): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    const clientId = 'client_id' in row ? row.client_id : row.clientId;
    const toolUseId = 'tool_use_id' in row ? row.tool_use_id : row.toolUseId;
    const agentMeta = 'agent_meta' in row ? row.agent_meta : row.agentMeta;
    const agentKind = 'agent_kind' in row ? row.agent_kind : row.agentKind;
    const createdAt = 'created_at' in row ? row.created_at : row.createdAt;
    hash.update(JSON.stringify([
      clientId, row.role, row.content, toolUseId ?? null,
      agentMeta ?? null, agentKind ?? null, createdAt,
    ])).update('\n');
  }
  return hash.digest('hex');
}
