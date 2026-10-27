import { describe, expect, it } from 'vitest';

import {
  boundWorkbenchSummary,
  cleanWorkbenchTitle,
  deriveWorkbenchAutomationState,
  deriveWorkbenchSessionState,
  isWorkbenchTaskSource,
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

describe('helpers', () => {
  it('accepts only project task sources', () => {
    expect(isWorkbenchTaskSource('desktop')).toBe(true);
    expect(isWorkbenchTaskSource('plugin')).toBe(true);
    expect(isWorkbenchTaskSource(undefined)).toBe(true);
    for (const source of ['bot', 'scheduler', 'telegram', 'learn', 'review', 'shared']) {
      expect(isWorkbenchTaskSource(source)).toBe(false);
    }
  });

  it('bounds summaries', () => {
    expect(boundWorkbenchSummary('  a\n\nb  ')).toBe('a b');
    expect(boundWorkbenchSummary('')).toBeNull();
    expect(boundWorkbenchSummary('x'.repeat(500))).toHaveLength(160);
  });
});

describe('cleanWorkbenchTitle', () => {
  it('drops instruction blocks, markdown and noise, keeping the first readable line', () => {
    expect(
      cleanWorkbenchTitle('<system-reminder>\nYou are operating in a git worktree…\n</system-reminder>\n\n## 把 **图标** 导出来\n第二行'),
    ).toBe('把 图标 导出来');
    expect(cleanWorkbenchTitle('看看 https://github.com/makecindy/cindy/pull/5292 的 review')).toBe(
      '看看 github.com/…/pull/5292 的 review',
    );
    expect(cleanWorkbenchTitle('[PR](https://github.com/a/b) `fix_icons`')).toBe('PR fix_icons');
    expect(cleanWorkbenchTitle('- 列表里的一项')).toBe('列表里的一项');
  });

  it('bounds to 60 characters and falls back when nothing is left', () => {
    expect(cleanWorkbenchTitle('字'.repeat(80))).toHaveLength(60);
    expect(cleanWorkbenchTitle('<command-name>/clear</command-name>', '未命名任务')).toBe('未命名任务');
    expect(cleanWorkbenchTitle('   \n  ', '未命名任务')).toBe('未命名任务');
    expect(cleanWorkbenchTitle(null, '未命名任务')).toBe('未命名任务');
  });
});
