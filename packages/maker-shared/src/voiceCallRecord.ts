export type VoiceCallTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  complete: boolean;
  failed?: boolean;
};
export type VoiceCallHandoff = {
  id: string;
  inputId: string;
  text: string;
  state: "sending" | "accepted" | "failed" | "completed";
  result?: string;
};
export type VoiceCallRecord = {
  version: 1;
  callId: string;
  startedAt: number;
  endedAt?: number;
  turns: VoiceCallTurn[];
  handoffs: VoiceCallHandoff[];
};

/** Persisted metadata can come from an older or incomplete history projection. */
export function readVoiceCallRecord(value: unknown): VoiceCallRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<VoiceCallRecord>;
  if (record.version !== 1 || typeof record.callId !== 'string'
    || (typeof record.startedAt !== 'number' || !Number.isFinite(new Date(record.startedAt).getTime()))
    || (record.endedAt !== undefined && !Number.isFinite(record.endedAt))
    || !Array.isArray(record.turns) || record.turns.length > 2_000
    || !Array.isArray(record.handoffs) || record.handoffs.length > 2_000) return null;
  if (!record.turns.every(turn => turn && typeof turn.id === 'string'
    && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string'
    && Number.isFinite(turn.createdAt) && typeof turn.complete === 'boolean')) return null;
  if (!record.handoffs.every(task => task && typeof task.id === 'string'
    && typeof task.inputId === 'string' && typeof task.text === 'string'
    && ['sending', 'accepted', 'failed', 'completed'].includes(task.state))) return null;
  return record as VoiceCallRecord;
}

export function hasVoiceCallContent(record: VoiceCallRecord): boolean {
  return record.turns.some((turn) => turn.text.trim().length > 0) || record.handoffs.length > 0;
}
