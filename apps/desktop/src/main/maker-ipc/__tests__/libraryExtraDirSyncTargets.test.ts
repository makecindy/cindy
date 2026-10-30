import { describe, expect, it } from 'vitest';
import { libraryExtraDirSyncTargets } from '../libraryExtraDirSyncTargets.js';

describe('Library directory synchronization targets', () => {
  it('includes live tasks omitted by the visible active DB query without waking dormant tasks', () => {
    const rows = Array.from({ length: 2026 }, (_, i) => ({ id: `dormant-${i}`, extraDirs: '[]' }));
    const live = new Set(['archived-live', 'deleted-live', 'hidden-live']);
    expect([...libraryExtraDirSyncTargets([], live, null)]).toEqual([...live]);
    expect([...libraryExtraDirSyncTargets(rows, live, 'focused')]).toEqual([...live, 'focused']);
  });

  it('does not rewrite 2026 dormant empty tasks on a focus report', () => {
    const rows = Array.from({ length: 2026 }, (_, i) => ({ id: `task-${i}`, extraDirs: '[]' }));
    expect([...libraryExtraDirSyncTargets(rows, new Set(), null)]).toEqual([]);
    expect([...libraryExtraDirSyncTargets(rows, new Set(), 'task-10')]).toEqual(['task-10']);
  });

  it('keeps persisted old grants after restart and live runtimes that may need revocation', () => {
    const rows = [
      { id: 'old-focus', extraDirs: '["cindy-library:/old","/user"]' },
      { id: 'live', extraDirs: '[]' },
      { id: 'user-only', extraDirs: '["/user"]' },
      { id: 'empty', extraDirs: null },
    ];
    expect([...libraryExtraDirSyncTargets(rows, new Set(['live']), 'new-focus')])
      .toEqual(['old-focus', 'live', 'new-focus']);
  });

  it('does not let malformed legacy grants bypass normal cleanup', () => {
    expect([...libraryExtraDirSyncTargets([{ id: 'legacy', extraDirs: '[' }], new Set(), null)])
      .toEqual(['legacy']);
  });
});
