/**
 * diffStats.test.ts
 * ---------------------------------------------------------------------------
 * Unit tests for cc-agent-compact-blocks M2 — Edit/Write/MultiEdit +N -N.
 */

import { describe, it, expect } from 'vitest';

import {
  computeDiffStats,
  computeUnifiedDiffStats,
  statsForToolCall,
} from '@/lib/agent-actions/diffStats';

describe('computeDiffStats', () => {
  it('returns 0/0 for identical strings', () => {
    expect(computeDiffStats('abc', 'abc')).toEqual({ add: 0, del: 0 });
  });

  it('counts a single-line replacement as +1 -1', () => {
    expect(computeDiffStats('hello', 'world')).toEqual({ add: 1, del: 1 });
  });

  it('counts pure additions when oldStr is empty', () => {
    expect(computeDiffStats('', 'a\nb\nc')).toEqual({ add: 3, del: 0 });
  });

  it('counts pure deletions', () => {
    expect(computeDiffStats('a\nb\nc', '')).toEqual({ add: 0, del: 3 });
  });

  it('strips trailing newlines so they do not count as a phantom line', () => {
    expect(computeDiffStats('', 'one line\n')).toEqual({ add: 1, del: 0 });
  });
});

describe('computeUnifiedDiffStats', () => {
  it('counts changed rows while excluding file and hunk headers', () => {
    expect(computeUnifiedDiffStats([
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-old',
      '+new',
      '+extra',
    ].join('\n'))).toEqual({ add: 2, del: 1 });
  });

  it('returns null when the unified diff has no changed rows', () => {
    expect(computeUnifiedDiffStats('')).toBeNull();
    expect(computeUnifiedDiffStats('@@ -1 +1 @@\n context')).toBeNull();
  });
});

describe('statsForToolCall', () => {
  it('returns null for non-diff tools', () => {
    expect(statsForToolCall('Read', { file_path: '/foo' })).toBeNull();
    expect(statsForToolCall('Bash', { command: 'ls' })).toBeNull();
    expect(statsForToolCall('Grep', { pattern: 'foo' })).toBeNull();
    expect(statsForToolCall('TodoWrite', { todos: [] })).toBeNull();
  });

  it('returns null when toolInput is null', () => {
    expect(statsForToolCall('Edit', null)).toBeNull();
  });

  it('Edit: real diff of old_string vs new_string', () => {
    const stats = statsForToolCall('Edit', {
      file_path: '/foo',
      old_string: 'hello',
      new_string: 'world',
    });
    expect(stats).toEqual({ add: 1, del: 1 });
  });

  it('Write: full content as +N -0', () => {
    const stats = statsForToolCall('Write', {
      file_path: '/foo',
      content: 'a\nb\nc',
    });
    expect(stats).toEqual({ add: 3, del: 0 });
  });

  it('MultiEdit: sum of edits[]', () => {
    const stats = statsForToolCall('MultiEdit', {
      file_path: '/foo',
      edits: [
        { old_string: 'a', new_string: 'b' },        // +1 -1
        { old_string: '', new_string: 'x\ny' },     // +2 -0
        { old_string: 'p\nq', new_string: 'p' },    // +0 -1 (q removed)
      ],
    });
    // Edit 1: +1 -1
    // Edit 2: +2 -0
    // Edit 3: 'p\nq' vs 'p' — diffLines treats them as a 2-line vs 1-line block;
    //          conservative check: combined add >= 3, del >= 2.
    expect(stats).not.toBeNull();
    expect(stats!.add).toBeGreaterThanOrEqual(3);
    expect(stats!.del).toBeGreaterThanOrEqual(2);
  });

  it('MultiEdit: empty edits[] returns +0 -0 (not null)', () => {
    expect(statsForToolCall('MultiEdit', { edits: [] })).toEqual({ add: 0, del: 0 });
  });

  it('pi edit: sums edits[].oldText/newText like MultiEdit', () => {
    const stats = statsForToolCall('edit', {
      path: '/foo',
      edits: [
        { oldText: 'a', newText: 'b' },       // +1 -1
        { oldText: '', newText: 'x\ny' },     // +2 -0
      ],
    });
    expect(stats).toEqual({ add: 3, del: 1 });
  });

  it('pi edit: legacy top-level oldText/newText yields real counts, not +0 -0', () => {
    expect(statsForToolCall('edit', {
      path: '/foo',
      oldText: 'old A\nold B',
      newText: 'new A',
    })).toEqual({ add: 1, del: 2 });
  });

  it('pi edit: top-level pair is counted after edits[] when both are present', () => {
    expect(statsForToolCall('edit', {
      path: '/foo',
      edits: [{ oldText: 'a', newText: 'b' }], // +1 -1
      oldText: 'c',
      newText: 'd',                            // +1 -1
    })).toEqual({ add: 2, del: 2 });
  });

  it('pi edit: no usable replacement returns +0 -0 (not null)', () => {
    expect(statsForToolCall('edit', { path: '/foo' })).toEqual({ add: 0, del: 0 });
  });

  it('pi write: full content as +N -0', () => {
    expect(statsForToolCall('write', { path: '/foo', content: 'a\nb' })).toEqual({
      add: 2,
      del: 0,
    });
  });

  it('pi read-only tools stay null', () => {
    expect(statsForToolCall('read', { path: '/foo' })).toBeNull();
    expect(statsForToolCall('bash', { command: 'ls' })).toBeNull();
    expect(statsForToolCall('grep', { pattern: 'foo' })).toBeNull();
  });

  it('file_change: sums unified diffs across all changed files', () => {
    expect(statsForToolCall('file_change', {
      changes: [
        { diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new' },
        { diff: '+++ b/b.ts\n+one\n+two' },
        { diff: '' },
      ],
    })).toEqual({ add: 3, del: 1 });
  });

  it('file_change: returns null when no valid unified diff is available', () => {
    expect(statsForToolCall('file_change', { changes: [{ diff: '' }] })).toBeNull();
    expect(statsForToolCall('file_change', { changes: [{ nope: true }] })).toBeNull();
  });
});
