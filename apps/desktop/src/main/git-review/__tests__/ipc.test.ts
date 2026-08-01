import { describe, expect, it, vi } from 'vitest';

import {
  parseCommitDiffPayload,
  parseHunkPayload,
  parseImagePreviewPayload,
  parseMarkdownPreviewPayload,
  parseOpenFilePayload,
  parseTarget,
  runReviewFileStageOperation,
} from '../ipc';
import type { FileDiff, GitReviewDeps } from '../types';

const HEX_OID = '0123456789abcdef0123456789abcdef01234567';
const SHORT_HEX_OID = 'abc1234';

function baseDiff(patch: Partial<FileDiff> = {}): FileDiff {
  return {
    id: 'unstaged:file.txt',
    source: 'unstaged',
    path: 'file.txt',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: 10,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [{
      index: 0,
      header: '@@ -1 +1 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      section: '',
      lines: [],
      selectableLines: [],
      raw: '',
    }],
    error: null,
    ...patch,
  };
}

describe('git-review IPC payload guards', () => {
  it('rejects unsafe file targets before write operations reach stageOps', () => {
    expect(() => parseTarget({ source: 'unstaged', path: '../secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseTarget({ source: 'unstaged', path: 'C:\\Users\\secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseTarget({ source: 'unstaged', path: 'file.txt', oldPath: '../old.txt' })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('rejects unsafe open-file paths before resolving the worktree file', () => {
    expect(() => parseOpenFilePayload({ sessionId: 's1', path: '../secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseOpenFilePayload({ sessionId: 's1', path: 'C:\\Users\\secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('rejects unsafe hunk diff paths from renderer payloads', () => {
    expect(() => parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff({ path: 'docs/../secret.md' }),
      hunkIndex: 0,
    })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff({ oldPath: '../old.txt' }),
      hunkIndex: 0,
    })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('requires hunk ignoreWhitespace to be a strict boolean when provided', () => {
    expect(parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff(),
      hunkIndex: 0,
      ignoreWhitespace: true,
    }).options).toEqual({ ignoreWhitespace: true });
    expect(() => parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff(),
      hunkIndex: 0,
      ignoreWhitespace: 'true',
    })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('keeps hex diff index oids, including git abbreviations, and drops non-hex revspecs', () => {
    const image = parseImagePreviewPayload({
      sessionId: 's1',
      diff: baseDiff({
        source: 'staged',
        kind: 'binary',
        path: 'asset.png',
        index: { oldOid: SHORT_HEX_OID, newOid: HEX_OID },
      }),
    });
    const markdown = parseMarkdownPreviewPayload({
      sessionId: 's1',
      diff: baseDiff({
        path: 'README.md',
        index: { oldOid: HEX_OID, newOid: 'main:README.md' },
      }),
    });

    expect(image.request.diff.index).toEqual({ oldOid: SHORT_HEX_OID, newOid: HEX_OID });
    expect(markdown.request.diff.index).toEqual({ oldOid: HEX_OID, newOid: null });
  });

  it('rejects non-hex commit ids for commit diffs and preview requests', () => {
    expect(() => parseCommitDiffPayload({ sessionId: 's1', oid: 'HEAD' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseImagePreviewPayload({
      sessionId: 's1',
      diff: baseDiff({ source: 'commit', kind: 'binary', path: 'asset.png' }),
      commitOid: 'HEAD',
    })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseMarkdownPreviewPayload({
      sessionId: 's1',
      diff: baseDiff({ source: 'commit', path: 'README.md' }),
      commitOid: 'feature',
    })).toThrow(/\[INVALID_PARAMS\]/);
  });
});

describe('git-review write busy gate', () => {
  it('rejects queued writes before resolving or touching a repository', async () => {
    const deps: GitReviewDeps = {
      resolveScope: vi.fn(),
      readStatus: vi.fn(),
      readDiffs: vi.fn(),
      isSessionRunning: () => true,
    };

    await expect(runReviewFileStageOperation('s1', 'stage', [
      { source: 'unstaged', path: 'file.txt', oldPath: null },
    ], deps)).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(deps.resolveScope).not.toHaveBeenCalled();
  });
});

describe('git-review hunk IPC serialization', () => {
  function parseSerializedHunk(diff: FileDiff, ignoreWhitespace = false) {
    return parseHunkPayload(JSON.parse(JSON.stringify({
      sessionId: 's1',
      diff,
      hunkIndex: diff.hunks[0].index,
      ignoreWhitespace,
    })));
  }

  it('preserves abbreviated index oids', () => {
    const diff = baseDiff({
      index: { oldOid: SHORT_HEX_OID, newOid: HEX_OID },
    });

    const parsed = parseSerializedHunk(diff);

    expect(parsed.diff.index).toEqual(diff.index);
  });

  it('preserves hidden-whitespace options and line selection', () => {
    const diff = baseDiff({
      hunks: [{
        index: 3,
        header: '@@ -1,2 +1,2 @@',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        section: '',
        lines: [],
        selectableLines: [0, 1],
        raw: '',
      }],
    });

    const parsed = parseSerializedHunk(diff, true);

    expect(parsed.hunkIndex).toBe(3);
    expect(parsed.options).toEqual({ ignoreWhitespace: true });
    expect(parsed.diff.hunks[0].selectableLines).toEqual([0, 1]);
  });
});
