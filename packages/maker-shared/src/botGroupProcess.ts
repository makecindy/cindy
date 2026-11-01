import { buildMessageToolResultPairing, parseMessageToolUse } from './messageNormalize';
import { segmentTeammateWork, type ProjectableWorkChild, type WorkActivityMessageLike } from './workActivityProjection';

/** Only a locator is posted to the group. Notes and tool data stay on the execution host. */
export interface BotGroupProcessRef {
  groupId: string;
  executionId: string;
  sessionId: string;
  clientId: string;
  /** Execution host, independent of the companion's current home. */
  deviceId?: string;
  durationMs?: number;
}
export function botGroupProcessCard(ref: BotGroupProcessRef) {
  return { type: 'card', namespace: 'cindy.work-record', schemaRevision: 1, fallback: '', data: { ...ref } };
}
export function readBotGroupProcessCard(value: unknown): BotGroupProcessRef | null {
  if (!value || typeof value !== 'object') return null;
  const block = value as Record<string, unknown>;
  if (block.type !== 'card' || block.namespace !== 'cindy.work-record' || block.schemaRevision !== 1
    || !block.data || typeof block.data !== 'object') return null;
  return parseBotGroupProcessRef(block.data);
}
export function parseBotGroupProcessRef(value: unknown): BotGroupProcessRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!['groupId', 'executionId', 'sessionId', 'clientId'].every(key => typeof data[key] === 'string'
    && (data[key] as string).length > 0 && (data[key] as string).length <= 500)) return null;
  return { groupId: data.groupId as string, executionId: data.executionId as string,
    sessionId: data.sessionId as string, clientId: data.clientId as string,
    ...(typeof data.deviceId === 'string' && data.deviceId.length > 0 && data.deviceId.length <= 500
      ? { deviceId: data.deviceId } : {}),
    ...(typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0
      ? { durationMs: data.durationMs } : {}) };
}
export interface BotGroupProcessMessage {
  clientId: string;
  role: string;
  content: unknown;
  createdAt?: string;
  toolUseId?: string | null;
  agentMeta?: { assistantPhase?: unknown; botPrivateReply?: unknown; failedSamplingAttempt?: unknown;
    turnCompleted?: unknown; isSyntheticTrigger?: unknown } | null;
}
export interface BotGroupProcessNote { id: string; text: string }
/** Walk existing bounded history windows, stopping at this exact turn's end. No task-wide fallback. */
export async function readBotGroupProcessMessages(
  ref: BotGroupProcessRef,
  read: (clientId: string) => Promise<readonly BotGroupProcessMessage[]>,
  cancelled: () => boolean,
): Promise<BotGroupProcessMessage[]> {
  const messages: BotGroupProcessMessage[] = [];
  const seen = new Set<string>();
  let cursor = ref.clientId;
  for (;;) {
    const page = await read(cursor);
    if (cancelled()) return [];
    const anchor = page.findIndex(row => row.clientId === cursor);
    if (anchor < 0) return messages;
    if (!messages.length) messages.push(page[anchor]!);
    const tail = page.slice(anchor + 1).filter(row => !seen.has(row.clientId));
    if (!tail.length) return messages;
    for (const row of tail) {
      seen.add(row.clientId);
      const meta = row.agentMeta;
      if (row.role === 'user' && meta?.isSyntheticTrigger !== true) return messages;
      if (!meta?.botPrivateReply && !meta?.failedSamplingAttempt) {
        // Preserve timing but never copy reasoning/final-answer text into process prose.
        messages.push(row.role === 'thinking' || row.role === 'assistant'
          && (meta?.assistantPhase === 'final_answer' || meta?.turnCompleted === true && meta?.assistantPhase !== 'commentary')
          ? { ...row, content: '' } : row);
      }
      if (meta?.turnCompleted === true && !meta.failedSamplingAttempt) return messages;
    }
    cursor = tail[tail.length - 1]!.clientId;
  }
}

/** Public notes only compatibility accessor; the richer projection stays owner-local. */
export async function readBotGroupProcessNotes(
  ref: BotGroupProcessRef, read: (clientId: string) => Promise<readonly BotGroupProcessMessage[]>, cancelled: () => boolean,
): Promise<BotGroupProcessNote[]> {
  const messages = await readBotGroupProcessMessages(ref, read, cancelled);
  return projectBotGroupProcess(messages, false).segments.flatMap(segment =>
    segment.kind === 'content' ? [{ id: segment.key, text: segment.item.text ?? '' }] : []);
}

export type BotGroupProcessChild = ProjectableWorkChild & { text?: string };
export function projectBotGroupProcess(messages: readonly BotGroupProcessMessage[], running: boolean) {
  const visible = messages.filter(row => !row.agentMeta?.botPrivateReply && !row.agentMeta?.failedSamplingAttempt);
  const pairing = buildMessageToolResultPairing(visible);
  const items: BotGroupProcessChild[] = [];
  // Pi and legacy providers do not label commentary. Subsequent work proves that
  // their earlier text is a stage note; an unsealed active tail remains visible.
  const lastWork = visible.findLastIndex(row => ['assistant', 'thinking', 'tool_use', 'tool_result'].includes(row.role));
  for (const [index, row] of visible.entries()) {
    const key = row.clientId;
    if (row.role === 'thinking') items.push({ kind: 'thinking', key, message: { clientId: key, content: '' } });
    else if (row.role === 'tool_use') {
      const tool = parseMessageToolUse(row);
      const result = pairing.resultContentFor(row, tool);
      const message: WorkActivityMessageLike = { clientId: key, content: '', toolName: tool.toolName, toolInput: tool.input };
      items.push({ kind: 'tools', key, toolCalls: [message],
        resultMap: result === undefined ? new Map() : new Map([[key, result]]),
        settledIds: pairing.hasResultFor(row, tool) ? new Set([key]) : new Set() });
    } else if (row.role === 'assistant' && (row.agentMeta?.assistantPhase === 'commentary'
      || !row.agentMeta?.assistantPhase && row.agentMeta?.turnCompleted !== true && (running || index < lastWork))) {
      const text = botGroupProcessText(row.content).trim();
      if (text && !/^(?:NO_REPLY|SILENT)$/i.test(text)) items.push({ kind: 'text', key, text });
    }
  }
  const times = visible.map(row => Date.parse(row.createdAt ?? '')).filter(Number.isFinite);
  const startedAtMs = times.length ? Math.min(...times) : undefined;
  const durationMs = startedAtMs === undefined ? undefined : Math.max(...times) - startedAtMs;
  return { segments: segmentTeammateWork(items, item => item.kind !== 'text'), startedAtMs, durationMs, running };
}

export function botGroupProcessText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(botGroupProcessText).filter(Boolean).join('\n');
  if (content && typeof content === 'object') {
    const block = content as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}
