export interface NotificationMessage {
  clientId: string;
  role: string;
  createdAt: number;
  text: string;
  agentMeta: Record<string, unknown>;
  topLevel: boolean;
}

/** Rows are newest first. A current successful seal is required; no legacy fallback. */
export function selectNotificationReply(rows: NotificationMessage[], startedAt: number) {
  for (const row of rows) {
    if (row.createdAt < startedAt || row.role === 'user') return undefined;
    // A sealed pre-tool preamble is not a final reply, even on adapters without phases.
    if (row.role === 'tool_use' || row.role === 'tool_result') return undefined;
    if (row.role !== 'assistant' || !row.topLevel) continue;
    const meta = row.agentMeta;
    if (meta.botCollaboration || meta.botDirectMessage || meta.cindyMakeCompletion || meta.reviewRun) continue;
    if (meta.turnCompleted !== true) continue;
    if (meta.assistantPhase === 'commentary') return undefined;
    return { clientId: row.clientId, text: row.text };
  }
  return undefined;
}
