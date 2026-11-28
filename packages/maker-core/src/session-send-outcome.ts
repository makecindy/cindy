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
  if (result.reason === 'provider-rejected-before-dispatch' && result.diagnostic === 'pi-retry-history-frame-too-large') {
    return {
      dispatched: false,
      reason: result.reason,
      context,
      message: '[PI_RETRY_HISTORY_FRAME_TOO_LARGE] Your message was not sent. Pi could not read the history needed to retry after a frame exceeded the local 16 MiB limit. You can continue in a new task.',
    };
  }
  if (result.reason === 'provider-rejected-before-dispatch' && result.diagnostic === 'pi-retry-history-unavailable') {
    // The history read failed for another reason (the upstream refused it).
    // The message never reached the provider: say so, and name the cause so
    // the user is not left with a bare "reply failed".
    const status = typeof result.upstreamStatus === 'number' ? ` (status ${result.upstreamStatus})` : '';
    return {
      dispatched: false,
      reason: result.reason,
      context,
      message: `[PI_RETRY_HISTORY_UNAVAILABLE] Your message was not sent. Pi could not read the history needed to send it${status}. You can retry, or continue in a new task.`,
    };
  }
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
