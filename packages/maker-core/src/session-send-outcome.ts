import type { SessionSendResult } from './session.js';

export type SessionDispatchOutcome =
  | { dispatched: true }
  | {
      dispatched: false;
      reason: 'cancelled-before-dispatch' | 'provider-rejected-before-dispatch';
      message: string;
      context: string;
    };

export function toSessionDispatchOutcome(
  result: SessionSendResult,
  context: string,
): SessionDispatchOutcome {
  if (result.accepted) return { dispatched: true };
  const message = result.reason === 'provider-rejected-before-dispatch'
    ? `Provider rejected the Session send before dispatch: ${context}`
    : `Session send was cancelled before vendor dispatch: ${context}`;
  return {
    dispatched: false,
    reason: result.reason,
    context,
    message,
  };
}

export function assertSendDispatched(
  result: SessionSendResult,
  context: string,
): asserts result is { accepted: true } {
  const outcome = toSessionDispatchOutcome(result, context);
  if (!outcome.dispatched) {
    throw new Error(outcome.message);
  }
}
