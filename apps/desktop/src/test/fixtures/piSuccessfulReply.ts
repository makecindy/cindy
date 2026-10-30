/**
 * Synthetic, non-user content using Pi v0.84.4's RPC wire shape:
 * packages/coding-agent/src/modes/json-event.ts removes `partial` only from
 * message_update; packages/agent/src/agent-loop.ts emits the full message_end.
 * This is a protocol replay, not a capture of the missing frames in #3696.
 */
export const piReplyThinking = '需要先明确用户希望修改的文件。';
export const piReplyText = '请告诉我需要修改哪个 Markdown 文件，以及希望修改的内容。';

export function piSuccessfulReplyFrames({ streamed = true, text = piReplyText } = {}) {
  const message = {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'cindy',
    model: 'z-ai/glm-5.3-flash',
    timestamp: 1_788_179_640_000,
    duration: 20_000,
    stopReason: 'stop',
    content: [
      { type: 'thinking', thinking: piReplyThinking },
      { type: 'text', text },
    ],
    usage: {
      input: 587, output: 684, reasoning: 247, cacheRead: 57_280,
      cacheWrite: 0, totalTokens: 58_551,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const update = (assistantMessageEvent: Record<string, unknown>) => ({
    type: 'message_update', usage: message.usage, assistantMessageEvent,
  });
  return {
    generation: [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_start', message: { ...message, content: [] } },
      update({ type: 'thinking_start', contentIndex: 0 }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: piReplyThinking }),
      update({ type: 'thinking_end', contentIndex: 0, content: piReplyThinking }),
      ...(streamed ? [
        update({ type: 'text_start', contentIndex: 1 }),
        // A deliberately incomplete delta tests authoritative final calibration.
        update({ type: 'text_delta', contentIndex: 1, delta: text.slice(0, 5) }),
      ] : []),
      { type: 'message_end', message },
    ],
    settlement: [
      { type: 'turn_end', message, toolResults: [] },
      { type: 'agent_end', messages: [message] },
      { type: 'agent_settled' },
    ],
  };
}
