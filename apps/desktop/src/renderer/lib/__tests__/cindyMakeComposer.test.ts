import { describe, expect, it } from 'vitest';
import {
  getCindyMakeTestRecovery,
  getCindyMakeComposerPhase,
  getCindyMakePendingTest,
  getCindyMakePreparation,
} from '../cindyMakeComposer';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor';
import type { ChatMessage } from '../makerChatStore';

const session = {
  id: 'make-session',
  source: 'cindy-make' as const,
  clearedAt: null,
  lastTurnEndedAt: null,
};
const preparing: MakeDoctorReport = {
  runId: 'make-run',
  platform: 'win32',
  arch: 'x64',
  status: 'running',
  checks: [],
  task: { sessionId: session.id, phase: 'dependencies' },
};
const dispatched: MakeDoctorReport = {
  ...preparing,
  status: 'completed',
  task: { ...preparing.task!, phase: 'completed' },
};
const input = {
  session,
  report: preparing,
  messages: [],
  historyLoaded: true,
  busy: false,
  error: null,
};
const card = (report: MakeDoctorReport): ChatMessage => ({
  clientId: 'preparation',
  role: 'assistant',
  content: '',
  systemCardType: 'cindy-make',
  systemCardData: { report },
});

describe('Cindy Make waiting-for-test card', () => {
  const done = (id: string, continuedAt?: number): ChatMessage => ({
    clientId: id,
    role: 'assistant',
    content: '',
    systemCardType: 'cindy-make-complete',
    systemCardData: { reportedAt: 123, commit: 'a'.repeat(40), continuedAt },
  });
  const select = (messages: ChatMessage[], busy = false) =>
    getCindyMakePendingTest({
      session: { ...session, status: 'active' },
      messages,
      busy,
    });
  it('uses a stored completion after reopening, but only when execution has ended', () => {
    expect(select([done('done')])?.completionId).toBe('done');
    expect(select([done('done')], true)).toBeNull();
  });
  it('does not restore older cards after continuing or a new user request', () => {
    expect(select([done('old'), done('new', 456)])).toBeNull();
    expect(
      select([done('old'), { clientId: 'u', role: 'user', content: 'edit again' }]),
    ).toBeNull();
    expect(
      select([
        done('old', 456),
        { clientId: 'u', role: 'user', content: 'edit again' },
        done('new'),
      ])?.completionId,
    ).toBe('new');
  });
  it('leaves ordinary, cleared and archived tasks alone', () => {
    for (const extra of [
      { source: 'desktop' as const },
      { clearedAt: '2026-09-17T10:00:00Z' },
      { status: 'archived' as const },
    ]) {
      expect(
        getCindyMakePendingTest({
          session: { ...session, status: 'active', ...extra },
          messages: [done('done')],
          busy: false,
        }),
      ).toBeNull();
    }
  });
});

describe('Cindy Make test flow recovery', () => {
  const continued: ChatMessage = {
    clientId: 'old-completion',
    role: 'assistant',
    content: '',
    systemCardType: 'cindy-make-complete',
    systemCardData: { reportedAt: 123, commit: 'a'.repeat(40), continuedAt: 456 },
  };
  const request: ChatMessage = { clientId: 'edit', role: 'user', content: 'edit again' };
  const reply: ChatMessage = {
    clientId: 'reply',
    role: 'assistant',
    content: 'Done',
    turnCompleted: true,
  };
  const select = (messages: ChatMessage[]) =>
    getCindyMakeTestRecovery({
      session: { ...session, status: 'active' },
      messages,
      busy: false,
      historyLoaded: true,
    });

  it('offers checks after Continue Editing, including when reopening without another edit', () => {
    expect(
      getCindyMakePendingTest({
        session: { ...session, status: 'active' },
        messages: [continued],
        busy: false,
      }),
    ).toBeNull();
    expect(select([continued])).toBe('old-completion');
  });

  it('recovers a later successful reply without report_complete and yields to a fresh completion', () => {
    expect(select([continued, request])).toBeNull();
    expect(select([continued, request, reply])).toBe('reply');
    const fresh = {
      ...continued,
      clientId: 'new-completion',
      systemCardData: { reportedAt: 789, commit: 'b'.repeat(40) },
    };
    expect(select([continued, request, reply, fresh])).toBeNull();
    expect(select([continued, request, reply, fresh, request, reply])).toBe('reply');
    expect(select([request, reply])).toBe('reply');
  });

  it('does not mistake incomplete, failed, or nested replies for a finished editing turn', () => {
    expect(select([continued, request, { ...reply, turnCompleted: undefined }])).toBeNull();
    expect(select([continued, request, { ...reply, turnCompleted: false }])).toBeNull();
    expect(select([continued, request, { ...reply, parentToolUseId: 'subagent' }])).toBeNull();
    expect(select([continued, request, reply, request])).toBeNull();
  });

  it('waits for loaded idle history and leaves non-active Make tasks alone', () => {
    const base = {
      session: { ...session, status: 'active' as const },
      messages: [continued, request, reply],
      busy: false,
      historyLoaded: true,
    };
    expect(getCindyMakeTestRecovery({ ...base, busy: true })).toBeNull();
    expect(getCindyMakeTestRecovery({ ...base, historyLoaded: false })).toBeNull();
    for (const extra of [
      { source: 'desktop' as const },
      { status: 'archived' as const },
      { clearedAt: '2026-09-19T10:00:00Z' },
    ]) {
      expect(
        getCindyMakeTestRecovery({ ...base, session: { ...base.session, ...extra } }),
      ).toBeNull();
    }
  });

  it('does not reclaim input after Continue Editing until a new result arrives', () => {
    const base = {
      session: { ...session, status: 'active' as const },
      busy: false,
      historyLoaded: true,
    };
    expect(
      getCindyMakeTestRecovery({ ...base, messages: [continued], dismissedId: continued.clientId }),
    ).toBeNull();
    expect(
      getCindyMakeTestRecovery({
        ...base,
        messages: [continued, request, reply],
        dismissedId: continued.clientId,
      }),
    ).toBe(reply.clientId);
    expect(
      getCindyMakeTestRecovery({
        ...base,
        messages: [continued, request, reply],
        dismissedId: reply.clientId,
      }),
    ).toBeNull();
    expect(
      getCindyMakeTestRecovery({
        ...base,
        messages: [continued, request, reply, request, { ...reply, clientId: 'next-reply' }],
        dismissedId: reply.clientId,
      }),
    ).toBe('next-reply');
  });
});

describe('Cindy Make composer lifecycle', () => {
  it('restores the full preparation card and retry request from persisted history', () => {
    const saved = card(preparing);
    saved.systemCardData = { ...saved.systemCardData, request: 'original request' };
    expect(getCindyMakePreparation({ session, messages: [saved] })).toEqual({
      report: preparing,
      request: 'original request',
    });
  });

  it('prefers the live report while preserving the original request for the same run', () => {
    const saved = card(preparing);
    saved.systemCardData = { ...saved.systemCardData, request: 'original request' };
    const live = { ...preparing, status: 'cancelled' as const };
    expect(getCindyMakePreparation({ session, report: live, messages: [saved] })).toEqual({
      report: live,
      request: 'original request',
    });
  });

  it('never borrows a retry request from another run or another task', () => {
    const saved = card(preparing);
    saved.systemCardData = { ...saved.systemCardData, request: 'other request' };
    const nextRun = { ...preparing, runId: 'next-run' };
    expect(getCindyMakePreparation({ session, report: nextRun, messages: [saved] })).toEqual({
      report: nextRun,
      request: undefined,
    });
    expect(
      getCindyMakePreparation({
        session: { ...session, id: 'another-session' },
        report: preparing,
        messages: [saved],
      }),
    ).toBeUndefined();
    const withRequest = { ...nextRun, task: { ...nextRun.task!, request: 'live request' } };
    expect(
      getCindyMakePreparation({ session, report: withRequest, messages: [saved] })?.request,
    ).toBe('live request');
  });

  it('locks only preparation and releases input as soon as first dispatch is accepted', () => {
    expect(getCindyMakeComposerPhase(input)).toBe('dependencies');
    expect(getCindyMakeComposerPhase({ ...input, report: dispatched })).toBeNull();
    expect(getCindyMakeComposerPhase({ ...input, report: dispatched, busy: true })).toBe(null);
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: dispatched,
        session: { ...session, lastTurnEndedAt: 123 },
      }),
    ).toBeNull();
  });

  it('leaves question and plan handling to the ordinary composer after preparation', () => {
    const messages: ChatMessage[] = [
      card(dispatched),
      { clientId: 'ask', role: 'assistant', content: 'Choose', askUserStatus: 'pending' },
      { clientId: 'plan', role: 'assistant', content: 'Plan', planReviewStatus: 'pending' },
    ];
    expect(getCindyMakeComposerPhase({ ...input, report: dispatched, messages, busy: false })).toBe(
      null,
    );
  });

  it('keeps input available after reloading a dispatched preparation', () => {
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: undefined,
        messages: [card(dispatched)],
        busy: true,
      }),
    ).toBeNull();
  });

  it('does not relock later manual turns, including after remount', () => {
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: dispatched,
        busy: true,
        session: { ...session, lastTurnEndedAt: 123 },
      }),
    ).toBeNull();
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps %s preparation unavailable until retry',
    (status) => {
      expect(getCindyMakeComposerPhase({ ...input, report: { ...preparing, status } })).toBe(
        status,
      );
      expect(getCindyMakeComposerPhase(input)).toBe('dependencies');
    },
  );

  it('prefers the live cancellation over stale running history', () => {
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: { ...preparing, status: 'cancelled' },
        messages: [card(preparing)],
      }),
    ).toBe('cancelled');
  });

  it('releases failed or interrupted execution for recovery without waiting for a session patch', () => {
    expect(getCindyMakeComposerPhase({ ...input, report: dispatched, error: 'failed' })).toBeNull();
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: dispatched,
        session: { ...session, interruptedTurnStartedAt: 123 },
      }),
    ).toBeNull();
  });

  it('does not need a terminal message to unlock the first editing turn', () => {
    const terminal: ChatMessage = {
      clientId: 'answer',
      role: 'assistant',
      content: 'Done',
      turnCompleted: true,
    };
    expect(
      getCindyMakeComposerPhase({ ...input, report: dispatched, messages: [terminal] }),
    ).toBeNull();
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: dispatched,
        messages: [{ ...terminal, parentToolUseId: 'subagent' }],
      }),
    ).toBeNull();
  });

  it('leaves ordinary, cleared, legacy and other-session tasks alone', () => {
    expect(
      getCindyMakeComposerPhase({ ...input, session: { ...session, source: 'desktop' } }),
    ).toBeNull();
    expect(
      getCindyMakeComposerPhase({
        ...input,
        session: { ...session, clearedAt: '2026-09-16T12:00:00Z' },
      }),
    ).toBeNull();
    expect(getCindyMakeComposerPhase({ ...input, report: undefined })).toBeNull();
    expect(
      getCindyMakeComposerPhase({
        ...input,
        session: { ...session, id: 'other' },
        messages: [card(preparing)],
      }),
    ).toBeNull();
  });

  it('keeps a new task unavailable until its history arrives', () => {
    expect(getCindyMakeComposerPhase({ ...input, report: undefined, historyLoaded: false })).toBe(
      'waiting',
    );
  });
});
