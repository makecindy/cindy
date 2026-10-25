export type MessageRole =
  | 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'ask_user' | 'plan_review' | 'thinking' | 'error' | 'agent_switch';

/** Durable message envelope. Metadata is typed by the consuming runtime. */
export interface StoredMessage<AgentMeta = Record<string, unknown>> {
  id: string;
  clientId: string;
  sessionId: string;
  role: MessageRole;
  content: unknown;
  toolUseId: string | null;
  agentMeta: AgentMeta | null;
  agentKind?: 'cc' | 'codex' | 'pi' | null;
  createdAt: string;
}
