import { describe, expect, it } from 'vitest';
import { makeHistoryActions } from '../../../shared/cindyMakeHistory';

const ready = {
  lifecycle: 'ready' as const,
  integration: 'unintegrated' as const,
  sessionAvailable: true,
  workspaceAvailable: true,
  sourceAvailable: true,
  completed: true,
  hasReceipts: false,
  busy: false,
  conflict: false,
};
describe('history action admission', () => {
  it('locks editing during launch but lets a ready test stop through Continue', () => {
    expect(makeHistoryActions({ ...ready, busy: true, test: { status: 'starting' } })).toEqual([
      'open',
    ]);
    expect(makeHistoryActions({ ...ready, busy: false, test: { status: 'starting' } })).toEqual([
      'open',
    ]);
    expect(makeHistoryActions({ ...ready, busy: true, test: { status: 'ready' } })).toEqual([
      'open',
      'continue',
    ]);
    expect(
      makeHistoryActions({ ...ready, busy: true, test: { status: 'ready' }, completed: false }),
    ).toEqual(['open']);
  });
  it.each(['preparing', 'running'] as const)(
    'offers only task navigation while %s',
    (lifecycle) => {
      expect(makeHistoryActions({ ...ready, lifecycle })).toEqual(['open']);
    },
  );
  it('keeps Open available and adds Continue for verified completed edits', () => {
    expect(makeHistoryActions(ready)).toEqual([
      'open',
      'continue',
      'test',
      'integrate',
      'end',
      'build',
    ]);
    expect(makeHistoryActions({ ...ready, integration: 'unknown' })).toEqual(['open', 'end']);
    expect(makeHistoryActions({ ...ready, integration: 'unchanged' })).toEqual([
      'open',
      'continue',
      'end',
    ]);
    expect(makeHistoryActions({ ...ready, completed: false, lifecycle: 'editing' })).toEqual([
      'open',
      'end',
    ]);
  });
  it('shows Undo after integration, Reapply after undo, and does not offer first-time integration twice', () => {
    expect(makeHistoryActions({ ...ready, integration: 'integrated', hasReceipts: true })).toEqual([
      'open',
      'continue',
      'test',
      'end',
      'revert',
      'build',
    ]);
    expect(makeHistoryActions({ ...ready, integration: 'reverted', hasReceipts: true })).toEqual([
      'open',
      'continue',
      'test',
      'end',
      'reapply',
      'build',
    ]);
    expect(
      makeHistoryActions({
        ...ready,
        integration: 'reverted',
        hasReceipts: true,
        newChanges: true,
      }),
    ).toEqual(['open', 'continue', 'test', 'integrate', 'end', 'build']);
    expect(
      makeHistoryActions({
        ...ready,
        lifecycle: 'ended',
        workspaceAvailable: false,
        integration: 'reverted',
        hasReceipts: true,
      }),
    ).toEqual(['open', 'reapply', 'build']);
  });
  it('does not offer editing or cleanup again for ended history, but still permits retained undo', () => {
    expect(
      makeHistoryActions({
        ...ready,
        lifecycle: 'ended',
        workspaceAvailable: false,
        integration: 'integrated',
        hasReceipts: true,
      }),
    ).toEqual(['open', 'revert', 'build']);
    expect(makeHistoryActions({ ...ready, lifecycle: 'ended', workspaceAvailable: false })).toEqual(
      ['open', 'integrate', 'build'],
    );
  });
  it('replaces mutations with conflict recovery or the specific failed preparation/cleanup action', () => {
    expect(makeHistoryActions({ ...ready, conflict: true })).toEqual(['open', 'resolve']);
    expect(makeHistoryActions({ ...ready, lifecycle: 'failed' })).toEqual([
      'open',
      'retry-prepare',
      'end',
    ]);
    expect(makeHistoryActions({ ...ready, lifecycle: 'cleanup' })).toEqual([
      'open',
      'retry-cleanup',
    ]);
    expect(makeHistoryActions({ ...ready, lifecycle: 'ended', buildFailed: true })).toEqual([
      'open',
      'integrate',
      'build',
    ]);
    expect(
      makeHistoryActions({
        ...ready,
        lifecycle: 'ended',
        sessionAvailable: false,
        buildFailed: true,
        integration: 'integrated',
      }),
    ).toEqual(['build']);
  });
  it('keeps unrelated cleanup available while global work is busy', () => {
    expect(makeHistoryActions({ ...ready, busy: true, allowCleanupWhileBusy: true })).toEqual([
      'open',
      'end',
    ]);
    expect(
      makeHistoryActions({
        ...ready,
        busy: true,
        allowCleanupWhileBusy: true,
        lifecycle: 'cleanup',
      }),
    ).toEqual(['open', 'retry-cleanup']);
    expect(
      makeHistoryActions({
        ...ready,
        busy: true,
        allowCleanupWhileBusy: true,
        lifecycle: 'running',
      }),
    ).toEqual(['open']);
  });
  it('blocks all writes while busy or when the source no longer supports their receipts', () => {
    expect(makeHistoryActions({ ...ready, busy: true })).toEqual(['open']);
    const actions = makeHistoryActions({
      ...ready,
      sourceAvailable: false,
      integration: 'unknown',
      hasReceipts: true,
    });
    expect(actions).not.toContain('integrate');
    expect(actions).not.toContain('revert');
    expect(actions).not.toContain('reapply');
  });
  it('offers the same generation action before and after a failed generation, never for unfinished new edits', () => {
    expect(makeHistoryActions(ready)).toContain('build');
    expect(makeHistoryActions({ ...ready, buildFailed: true })).toContain('build');
    expect(
      makeHistoryActions({ ...ready, integration: 'changed', completed: false, needsBuild: true }),
    ).not.toContain('build');
    expect(makeHistoryActions({ ...ready, conflict: true, buildFailed: true })).not.toContain(
      'build',
    );
  });
});
