import type { AgentEvent } from '../../types/events.js';

// Host-private evidence. Never serialize the receipt, response ID or credential scope.
export type PiResponsesCompletion = (providerId: string, fingerprint: string) => boolean;
const completions = new WeakMap<AgentEvent, PiResponsesCompletion>();

export function markPiResponsesCompletion(event: AgentEvent, proof: PiResponsesCompletion): void {
  completions.set(event, proof);
}

export function verifyPiResponsesCompletion(event: AgentEvent, providerId: string, fingerprint: string): boolean {
  return completions.get(event)?.(providerId, fingerprint) === true;
}

// Shared with the embedded bridge; require the SDK's real final Responses status,
// not merely HTTP 200, a text delta, or a usable connection-test result.
export function completedPiResponsesMessage(message: any): boolean {
  return message?.role === 'assistant' && message.api === 'openai-responses'
    && message.rawStopReason === 'completed' && message.stopReason === 'stop'
    && typeof message.responseId === 'string' && message.responseId.length > 0
    && Number.isSafeInteger(message.usage?.output) && message.usage.output > 0
    && Array.isArray(message.content)
    && message.content.some((part: any) => part?.type === 'text'
      && typeof part.text === 'string' && part.text.trim().length > 0);
}
