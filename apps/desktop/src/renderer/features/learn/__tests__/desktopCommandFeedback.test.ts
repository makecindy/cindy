import { describe, expect, it } from 'vitest';
import { resolveLearnDesktopCommandFeedback } from '../desktopCommandFeedback';

describe('resolveLearnDesktopCommandFeedback', () => {
  it.each([
    ['learn-usage', 'warning', 'learn.toast.usage'],
    ['learn-busy', 'warning', 'learn.toast.busy'],
    ['learn-failed', 'error', 'learn.toast.failed'],
    ['remote-unsupported', 'warning', 'commands.toast.remoteUnsupported'],
  ] as const)('maps %s to a visible %s toast', (error, level, i18nKey) => {
    expect(resolveLearnDesktopCommandFeedback({ error })).toEqual({
      kind: 'toast',
      level,
      i18nKey,
    });
  });

  it('restores the status card for a successful Desktop fallback', () => {
    expect(resolveLearnDesktopCommandFeedback({ learnRunId: 'run-1' })).toEqual({
      kind: 'insert-card',
      runId: 'run-1',
    });
  });

  it('ignores successful Agent Skill invocations that have no Desktop payload', () => {
    expect(resolveLearnDesktopCommandFeedback({})).toBeNull();
  });
});
