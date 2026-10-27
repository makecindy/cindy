import type { MobileMessageRenderItem } from '@/session/messageRenderModel';

/**
 * Use the same final-answer projection as the message list. Work groups can
 * retain earlier final markers after recovery/background continuation; only the
 * current top-level answer is eligible, never folded work or subagent text.
 */
export function findVoiceConversationReply(
  items: readonly MobileMessageRenderItem[], clientId: string, running: boolean,
): { id: string; text: string } | null {
  if (!clientId || running) return null;
  const messages = items.flatMap(item => item.type === 'message' ? [item.message] : []);
  const user = messages.findIndex(message => message.kind === 'user' && message.source.clientId === clientId);
  if (user < 0) return null;
  const turn = messages.slice(user + 1);
  // Another input owns the tail now. Do not read its answer as this voice reply.
  if (turn.some(message => message.kind === 'user')) return null;
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const reply = turn[index];
    if (reply.role === 'error') return null;
    if (reply.kind !== 'assistant' || !reply.isTurnFinalAssistant || reply.isStreaming
      || reply.failedSamplingAttempt || !reply.body.trim()) continue;
    // Usage can seal an interrupted message for rendering. A terminal failure
    // must not turn that partial response into a successful spoken answer.
    if (reply.source.agentMeta?.turnCompleted === false) return null;
    // The client identity survives a streamed row becoming a persisted DB row.
    return { id: reply.source.clientId || reply.key, text: reply.body };
  }
  return null;
}
