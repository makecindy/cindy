import { describe, expect, it } from 'vitest';

import {
  boundWorkbenchSummary,
  countWorkbenchStates,
  deriveWorkbenchAutomationState,
  deriveWorkbenchSessionState,
  findWorkbenchProject,
  isWorkbenchTaskSource,
  workbenchStateRank,
} from '../botWorkbench';

describe('deriveWorkbenchSessionState', () => {
  it('maps live activity to running / waiting', () => {
    expect(deriveWorkbenchSessionState({ activityPhase: 'running' })).toBe('running');
    expect(deriveWorkbenchSessionState({ activityPhase: 'needs-interaction' })).toBe('waiting');
    // Waiting for the user wins over a turn that is technically still running.
    expect(deriveWorkbenchSessionState({ activityPhase: 'needs-interaction', delegationStatus: 'running' })).toBe('waiting');
  });

  it('only reports stopped on a reliable signal', () => {
    expect(deriveWorkbenchSessionState({ interrupted: true })).toBe('stopped');
    expect(deriveWorkbenchSessionState({ errored: true })).toBe('stopped');
    expect(deriveWorkbenchSessionState({ activityPhase: 'error' })).toBe('stopped');
    expect(deriveWorkbenchSessionState({ delegationStatus: 'failed' })).toBe('stopped');
    expect(deriveWorkbenchSessionState({ delegationStatus: 'timed-out' })).toBe('stopped');
    expect(deriveWorkbenchSessionState({ delegationStatus: 'cancelled' })).toBe('stopped');
    // Idle with no evidence is not guessed as unfinished.
    expect(deriveWorkbenchSessionState({})).toBe('done');
    expect(deriveWorkbenchSessionState({ activityPhase: 'completed' })).toBe('done');
    expect(deriveWorkbenchSessionState({ delegationStatus: 'completed' })).toBe('done');
  });

  it('keeps background-task queue and progress ahead of stale session signals', () => {
    expect(deriveWorkbenchSessionState({ delegationStatus: 'queued', errored: true })).toBe('queued');
    expect(deriveWorkbenchSessionState({ delegationStatus: 'waiting' })).toBe('waiting');
    expect(deriveWorkbenchSessionState({ delegationStatus: 'running', interrupted: true })).toBe('running');
    // A new running turn replaces an old interruption.
    expect(deriveWorkbenchSessionState({ activityPhase: 'running', interrupted: true })).toBe('running');
  });
});

describe('deriveWorkbenchAutomationState', () => {
  it('distinguishes running, queued, disabled and standing by', () => {
    expect(deriveWorkbenchAutomationState({ enabled: true, running: true })).toBe('running');
    expect(deriveWorkbenchAutomationState({ enabled: true, queued: true })).toBe('queued');
    expect(deriveWorkbenchAutomationState({ enabled: false })).toBe('stopped');
    expect(deriveWorkbenchAutomationState({ enabled: true })).toBe('automation');
  });
});

describe('project membership', () => {
  it('matches the same project, its managed worktrees, and nothing else', () => {
    const dirs = ['/Users/me/Code/cindy'];
    expect(findWorkbenchProject('/Users/me/Code/cindy/', dirs, false)).toBe('/Users/me/Code/cindy');
    expect(findWorkbenchProject('/Users/me/Code/cindy/.cindy-worktrees/fix', dirs, false)).toBe('/Users/me/Code/cindy');
    expect(findWorkbenchProject('/Users/me/Code/cindy-old', dirs, false)).toBeNull();
    expect(findWorkbenchProject('/Users/me/Code/cindy/apps', dirs, false)).toBeNull();
    expect(findWorkbenchProject(null, dirs, false)).toBeNull();
  });

  it('folds case for Windows paths only when asked', () => {
    expect(findWorkbenchProject('C:\\Code\\Cindy', ['c:/code/cindy'], true)).toBe('c:/code/cindy');
    expect(findWorkbenchProject('C:\\Code\\Cindy', ['c:/code/cindy'], false)).toBeNull();
  });
});

describe('helpers', () => {
  it('accepts only project task sources', () => {
    expect(isWorkbenchTaskSource('desktop')).toBe(true);
    expect(isWorkbenchTaskSource('plugin')).toBe(true);
    expect(isWorkbenchTaskSource(undefined)).toBe(true);
    for (const source of ['bot', 'scheduler', 'telegram', 'learn', 'review', 'shared']) {
      expect(isWorkbenchTaskSource(source)).toBe(false);
    }
  });

  it('counts, ranks and bounds summaries', () => {
    expect(countWorkbenchStates(['running', 'done', 'done'])).toMatchObject({ running: 1, done: 2, waiting: 0 });
    expect(workbenchStateRank('stopped')).toBeLessThan(workbenchStateRank('automation'));
    expect(workbenchStateRank('automation')).toBeLessThan(workbenchStateRank('done'));
    expect(boundWorkbenchSummary('  a\n\nb  ')).toBe('a b');
    expect(boundWorkbenchSummary('')).toBeNull();
    expect(boundWorkbenchSummary('x'.repeat(500))).toHaveLength(160);
  });
});
