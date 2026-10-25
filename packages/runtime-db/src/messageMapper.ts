import type { StoredMessage, MessageRole } from '@cindy/maker-shared/stored-message';
import { stripInternalWebCitations } from '@cindy/maker-shared/internal-citation';
import { projectMcpAppContent } from '@cindy/maker-shared/mcp-apps';
import type { messages } from './schema.js';
type MessageRow = typeof messages.$inferSelect;
type MessageInsert = typeof messages.$inferInsert;

export function messageToCamel<AgentMeta = Record<string, unknown>>(row: MessageRow): StoredMessage<AgentMeta> {
  let content: unknown = row.content;
  try {
    content = JSON.parse(row.content);
  } catch {
    // 容错：极端情况下 content 可能不是合法 JSON（例如旧手工写入），保留原字符串
    content = row.content;
  }
  if (row.role === 'assistant' && typeof content === 'string') {
    content = stripInternalWebCitations(content);
  }
  // agent_meta 列存的是 JSON.stringify 后的字符串，老消息为 NULL。
  // 解析失败时返回 null 而非抛——容错保证历史消息能正常加载。
  let agentMeta: AgentMeta | null = null;
  if (row.agentMeta !== null && row.agentMeta !== undefined) {
    try {
      agentMeta = JSON.parse(row.agentMeta) as AgentMeta;
    } catch {
      agentMeta = null;
    }
  }
  return {
    id: row.id,
    clientId: row.clientId,
    sessionId: row.sessionId,
    role: row.role as MessageRole,
    content: projectMcpAppContent(content, (agentMeta as { mcpApp?: boolean } | null)?.mcpApp === true),
    toolUseId: row.toolUseId,
    agentMeta,
    agentKind: (row.agentKind as 'cc' | 'codex' | 'pi' | null) ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export function messageCreateToRow<AgentMeta = Record<string, unknown>>(
  id: string,
  sessionId: string,
  body: {
    clientId: string;
    role: MessageRole;
    content: unknown;
    toolUseId?: string;
    agentMeta?: AgentMeta | null;
    agentKind?: 'cc' | 'codex' | 'pi' | null;
    createdAt?: number;
  },
  now: number,
): MessageInsert {
  return {
    id,
    clientId: body.clientId,
    sessionId,
    role: body.role as MessageInsert['role'],
    content: safeStringify(body.content),
    toolUseId: body.toolUseId ?? null,
    agentMeta:
      body.agentMeta === undefined || body.agentMeta === null
        ? null
        : safeStringify(body.agentMeta),
    agentKind: body.agentKind ?? null,
    createdAt: body.createdAt ?? now,
  };
}

export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

