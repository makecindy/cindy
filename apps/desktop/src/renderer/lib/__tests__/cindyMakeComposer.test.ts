import { describe, expect, it } from 'vitest';
import { getCindyMakeComposerPhase } from '../cindyMakeComposer';
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

describe('Cindy Make composer lifecycle', () => {
  it('locks from preparation through accepted dispatch until the first product turn ends', () => {
    expect(getCindyMakeComposerPhase(input)).toBe('dependencies');
    expect(getCindyMakeComposerPhase({ ...input, report: dispatched })).toBe('executing');
    expect(getCindyMakeComposerPhase({ ...input, report: dispatched, busy: true })).toBe(
      'executing',
    );
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: dispatched,
        session: { ...session, lastTurnEndedAt: 123 },
      }),
    ).toBeNull();
  });

  it('does not unlock just because a question or plan temporarily pauses streaming', () => {
    const messages: ChatMessage[] = [
      card(dispatched),
      { clientId: 'ask', role: 'assistant', content: 'Choose', askUserStatus: 'pending' },
      { clientId: 'plan', role: 'assistant', content: 'Plan', planReviewStatus: 'pending' },
    ];
    expect(getCindyMakeComposerPhase({ ...input, report: dispatched, messages, busy: false })).toBe(
      'executing',
    );
  });

  it('restores the lock from the saved card after remount and supports remote history', () => {
    expect(
      getCindyMakeComposerPhase({
        ...input,
        report: undefined,
        messages: [card(dispatched)],
        busy: true,
      }),
    ).toBe('executing');
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

  it('uses a persisted top-level terminal before session metadata arrives, not a subagent terminal', () => {
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
    ).toBe('executing');
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
