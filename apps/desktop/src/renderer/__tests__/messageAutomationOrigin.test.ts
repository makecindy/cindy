import { describe, expect, it } from 'vitest';

import { toMessageAutomationOrigin } from '@/lib/messageAutomationOrigin';

describe('toMessageAutomationOrigin', () => {
  it('keeps scheduler origins unchanged', () => {
    const origin = { kind: 'scheduler', scheduleId: 's1', scheduleName: 'Nightly', runId: 'r1' };
    expect(toMessageAutomationOrigin(origin)).toBe(origin);
  });

  it('projects tool-sent session origins with the sender title snapshot', () => {
    expect(
      toMessageAutomationOrigin({
        kind: 'session',
        senderSessionId: 'caller',
        displayText: 'follow-up',
        senderSessionTitle: ' Release checklist ',
      }),
    ).toEqual({
      kind: 'session',
      senderSessionId: 'caller',
      senderSessionTitle: 'Release checklist',
    });
  });

  it('carries the sender teammate identity when the source session belongs to one', () => {
    expect(
      toMessageAutomationOrigin({
        kind: 'session',
        senderSessionId: 'bot-task',
        senderSessionTitle: 'Weekly feedback',
        senderBotId: 'bot-1',
        senderBotName: 'Cindy',
      }),
    ).toEqual({
      kind: 'session',
      senderSessionId: 'bot-task',
      senderSessionTitle: 'Weekly feedback',
      senderBotId: 'bot-1',
      senderBotName: 'Cindy',
    });
  });

  it('links Orca messages to the sending session only when it was recorded', () => {
    expect(
      toMessageAutomationOrigin({ kind: 'orca', senderLabel: 'Lead', senderSessionId: 'lead-1' }),
    ).toEqual({ kind: 'session', senderSessionId: 'lead-1' });
    expect(toMessageAutomationOrigin({ kind: 'orca', senderLabel: 'Lead' })).toBeUndefined();
  });

  it('ignores missing, malformed, and unknown origins', () => {
    expect(toMessageAutomationOrigin(undefined)).toBeUndefined();
    expect(toMessageAutomationOrigin('scheduler')).toBeUndefined();
    expect(toMessageAutomationOrigin({ kind: 'session', senderSessionId: '  ' })).toBeUndefined();
    expect(toMessageAutomationOrigin({ kind: 'desktop' })).toBeUndefined();
  });
});
