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
  it.each(['preparing', 'running'] as const)(
    'offers only task navigation while %s',
    (lifecycle) => {
      expect(makeHistoryActions({ ...ready, lifecycle })).toEqual(['open']);
    },
  );
  it('offers integration only for verified completed edits, without duplicate Open and Continue controls', () => {
    expect(makeHistoryActions(ready)).toEqual(['continue', 'test', 'integrate', 'end']);
    expect(makeHistoryActions({ ...ready, integration: 'unknown' })).toEqual(['open', 'end']);
    expect(makeHistoryActions({ ...ready, integration: 'unchanged' })).toEqual(['continue', 'end']);
    expect(makeHistoryActions({ ...ready, completed: false, lifecycle: 'editing' })).toEqual([
      'open',
      'end',
    ]);
  });
  it('shows Undo after integration, Reapply after undo, and does not offer first-time integration twice', () => {
    expect(makeHistoryActions({ ...ready, integration: 'integrated', hasReceipts: true })).toEqual([
      'continue',
      'test',
      'end',
      'revert',
    ]);
    expect(makeHistoryActions({ ...ready, integration: 'reverted', hasReceipts: true })).toEqual([
      'continue',
      'test',
      'end',
      'reapply',
    ]);
    expect(
      makeHistoryActions({
        ...ready,
        integration: 'reverted',
        hasReceipts: true,
        newChanges: true,
      }),
    ).toEqual(['continue', 'test', 'integrate', 'end']);
    expect(
      makeHistoryActions({
        ...ready,
        lifecycle: 'ended',
        workspaceAvailable: false,
        integration: 'reverted',
        hasReceipts: true,
      }),
    ).toEqual(['open', 'reapply']);
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
    ).toEqual(['open', 'revert']);
    expect(makeHistoryActions({ ...ready, lifecycle: 'ended', workspaceAvailable: false })).toEqual(
      ['open', 'integrate'],
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
      'build',
      'integrate',
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
});
