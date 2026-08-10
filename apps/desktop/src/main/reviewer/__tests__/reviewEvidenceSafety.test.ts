import { describe, expect, it } from 'vitest';

import type { FileDiff, ReviewDiffBucket } from '../../../shared/gitReviewWire.js';
import type { TurnChangeSetDetail } from '../../../shared/turnChangeSet.js';
import { sanitizeReviewChangeSet, sanitizeReviewDiffBucket } from '../reviewEvidenceSafety.js';

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    id: 'file-1',
    source: 'unstaged',
    path: 'src/a.ts',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: 12,
    additions: 1,
    deletions: 1,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: 'diff --git a/src/a.ts b/src/a.ts',
    rawPatch: '@@ -1 +1 @@\n-old\n+new',
    hunks: [],
    error: null,
    ...overrides,
  };
}

describe('review Git evidence safety', () => {
  it('removes sensitive staged, unstaged, renamed, and capped paths', () => {
    const bucket: ReviewDiffBucket = {
      staged: [
        fileDiff({ source: 'staged', path: '.env.local', rawPatch: '+SECRET=value' }),
        fileDiff({ source: 'staged', id: 'safe', path: 'src/safe.ts' }),
      ],
      unstaged: [
        fileDiff({
          id: 'renamed-secret',
          path: 'notes.txt',
          oldPath: 'credentials.json',
          status: 'renamed',
        }),
      ],
      capped: {
        staged: {
          reason: 'file-count',
          stats: { fileCount: 2, totalChangedLines: 2, totalChangedBytes: 20 },
          files: [
            {
              id: 'key',
              source: 'staged',
              path: 'private.pem',
              oldPath: null,
              status: 'modified',
              additions: 1,
              deletions: 0,
              changedLines: 1,
              changedBytes: 10,
              isBinary: false,
              isSubmodule: false,
            },
          ],
        },
        unstaged: null,
      },
    };

    const result = sanitizeReviewDiffBucket(bucket);

    expect(result.value.staged.map((diff) => diff.path)).toEqual(['src/safe.ts']);
    expect(result.value.unstaged).toEqual([]);
    expect(result.value.capped?.staged?.files).toEqual([]);
    expect(result.omittedSensitiveFiles).toBe(3);
    expect(JSON.stringify(result.value)).not.toContain('SECRET=value');
    expect(JSON.stringify(result.value)).not.toContain('credentials.json');
  });

  it('marks the latest-turn fallback partial when sensitive diffs are omitted', () => {
    const changeSet: TurnChangeSetDetail = {
      id: 'turn-1',
      sessionId: 'source-1',
      anchorClientId: 'message-1',
      provider: 'codex',
      providerTurnId: null,
      cwd: '/repo',
      state: 'complete',
      workspaceState: 'applied',
      isReversible: true,
      incompleteReasons: [],
      createdAt: 1,
      completedAt: 2,
      files: [
        {
          id: 'secret',
          path: '.env',
          oldPath: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
        },
      ],
      fileCount: 1,
      additions: 1,
      deletions: 0,
      diffs: [fileDiff({ path: '.env', rawPatch: '+TOKEN=secret' })],
    };

    const result = sanitizeReviewChangeSet(changeSet);

    expect(result.value?.diffs).toEqual([]);
    expect(result.value?.files).toEqual([]);
    expect(result.value?.incompleteReasons).toContain('sensitive-file');
    expect(JSON.stringify(result.value)).not.toContain('TOKEN=secret');
  });
});
