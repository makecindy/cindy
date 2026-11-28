import { describe, expect, it } from 'vitest';

import type { SessionSendResult } from './session.js';
import { assertSendDispatched, toSessionDispatchOutcome } from './session-send-outcome.js';

describe('session send outcome', () => {
  it('maps accepted send result to dispatched outcome', () => {
    const result: SessionSendResult = { accepted: true };

    expect(toSessionDispatchOutcome(result, 'scheduler/session-1/send')).toEqual({
      dispatched: true,
    });
  });

  it('preserves cancelled reason and context with stable message', () => {
    const result: SessionSendResult = {
      accepted: false,
      reason: 'cancelled-before-dispatch',
    };
    const context = 'feishu/session-2/user-turn';

    expect(toSessionDispatchOutcome(result, context)).toEqual({
      dispatched: false,
      reason: 'cancelled-before-dispatch',
      context,
      message: 'Session send was cancelled before vendor dispatch: feishu/session-2/user-turn',
    });
  });

  it('preserves an explicit provider rejection as safely undispatched', () => {
    const result: SessionSendResult = {
      accepted: false,
      reason: 'provider-rejected-before-dispatch',
    };
    const context = 'goal/session-2/continuation';

    expect(toSessionDispatchOutcome(result, context)).toEqual({
      dispatched: false,
      reason: 'provider-rejected-before-dispatch',
      context,
      message: 'Provider rejected the Session send before dispatch: goal/session-2/continuation',
    });
    expect(() => assertSendDispatched(result, context)).toThrow(
      'Provider rejected the Session send before dispatch: goal/session-2/continuation',
    );
  });

  // #12924, unit: a Pi history read that the upstream refused is a definite
  // non-dispatch. The outcome must say "not sent" and keep the bounded cause
  // so the UI can explain it instead of showing the generic "reply failed".
  it('names a failed Pi history read with its bounded upstream status', () => {
    const result: SessionSendResult = {
      accepted: false,
      reason: 'provider-rejected-before-dispatch',
      diagnostic: 'pi-retry-history-unavailable',
      upstreamStatus: 550,
    };
    const context = 'pi/session-9/retry';

    expect(toSessionDispatchOutcome(result, context)).toEqual({
      dispatched: false,
      reason: 'provider-rejected-before-dispatch',
      context,
      message: '[PI_RETRY_HISTORY_UNAVAILABLE] Your message was not sent. Pi could not read the history needed to send it (status 550). You can retry, or continue in a new task.',
    });
  });

  it('keeps a failed Pi history read actionable without an upstream status', () => {
    const result: SessionSendResult = {
      accepted: false,
      reason: 'provider-rejected-before-dispatch',
      diagnostic: 'pi-retry-history-unavailable',
    };

    expect(toSessionDispatchOutcome(result, 'pi/session-10/retry')).toEqual({
      dispatched: false,
      reason: 'provider-rejected-before-dispatch',
      context: 'pi/session-10/retry',
      message: '[PI_RETRY_HISTORY_UNAVAILABLE] Your message was not sent. Pi could not read the history needed to send it. You can retry, or continue in a new task.',
    });
  });

  it('asserts dispatched only when send result was accepted', () => {
    const accepted: SessionSendResult = { accepted: true };
    const cancelled: SessionSendResult = {
      accepted: false,
      reason: 'cancelled-before-dispatch',
    };

    expect(() => assertSendDispatched(accepted, 'orca/session-3/ready')).not.toThrow();
    expect(() => assertSendDispatched(cancelled, 'orca/session-3/ready')).toThrow(
      'Session send was cancelled before vendor dispatch: orca/session-3/ready',
    );
  });
});
