import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FileDiff, ReviewDiffBucket } from '../../../shared/gitReviewWire.js';
import type { TurnChangeSetDetail } from '../../../shared/turnChangeSet.js';
import {
  reviewChangeSetContentPaths,
  sanitizeReviewChangeSet,
  sanitizeReviewDiffBucket,
} from '../reviewEvidenceSafety.js';

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

describe('review change set content paths', () => {
  // path.resolve keeps expectations platform-native: '/repo' becomes 'D:\repo'
  // on the Windows CI runner, matching what a real change set records there.
  const abs = (...segments: string[]) => path.resolve(...segments);

  function changeSet(
    files: TurnChangeSetDetail['files'],
    cwd = '/repo',
    overrides: Partial<TurnChangeSetDetail> = {},
  ): TurnChangeSetDetail {
    return {
      id: 'turn-1',
      sessionId: 'source-1',
      anchorClientId: 'message-1',
      provider: 'codex',
      providerTurnId: null,
      cwd,
      state: 'complete',
      workspaceState: 'applied',
      isReversible: true,
      incompleteReasons: [],
      createdAt: 1,
      completedAt: 2,
      files,
      fileCount: files.length,
      additions: 0,
      deletions: 0,
      diffs: [],
      ...overrides,
    };
  }

  function file(path: string, oldPath: string | null = null): TurnChangeSetDetail['files'][number] {
    return { id: path, path, oldPath, status: 'modified', additions: 1, deletions: 0 };
  }

  it('resolves changed and renamed-from paths against the recorded cwd', () => {
    expect(
      reviewChangeSetContentPaths(
        changeSet([file('src/a.ts'), file('docs/new.md', 'docs/old.md')]),
        '/other',
      ).paths.sort(),
    ).toEqual(
      [abs('/repo', 'docs/new.md'), abs('/repo', 'docs/old.md'), abs('/repo', 'src/a.ts')].sort(),
    );
  });

  it('returns nothing when there is no change set', () => {
    expect(reviewChangeSetContentPaths(null, '/repo')).toEqual({ paths: [], truncated: false });
  });

  it('falls back to the working directory when the change set has no cwd', () => {
    expect(
      reviewChangeSetContentPaths(changeSet([file('src/a.ts')], ''), '/fallback').paths,
    ).toEqual([abs('/fallback', 'src/a.ts')]);
  });

  it('refuses escapes, absolute paths and credential files', () => {
    expect(
      reviewChangeSetContentPaths(
        changeSet([
          file('../outside.ts'),
          file('a/../../outside.ts'),
          file('/etc/passwd'),
          file('.env'),
          file('config/credentials.json'),
        ]),
        '/repo',
      ).paths,
    ).toEqual([]);
  });

  it('keeps a confined new path when only its rename source is unsafe', () => {
    // Each side is validated on its own: the file really did change and belongs
    // in the baseline, while the escaping rename source is simply dropped.
    expect(
      reviewChangeSetContentPaths(changeSet([file('renamed.ts', '../secret.ts')]), '/repo').paths,
    ).toEqual([abs('/repo', 'renamed.ts')]);
  });

  it('deduplicates paths reached through more than one entry', () => {
    expect(
      reviewChangeSetContentPaths(changeSet([file('src/a.ts'), file('src/a.ts')]), '/repo').paths,
    ).toEqual([abs('/repo', 'src/a.ts')]);
  });

  it('recovers files that the summarized list dropped but the patch still names', () => {
    // Persisted details are rebuilt through toSummary(), which caps `files` at
    // 50 while `diffs` keeps the full patch. Reading only `files` would leave
    // the 51st file onward outside the baseline.
    const result = reviewChangeSetContentPaths(
      changeSet([file('kept.ts')], '/repo', {
        fileCount: 2,
        diffs: [fileDiff({ path: 'dropped.ts' })],
      }),
      '/repo',
    );

    expect(result.paths.sort()).toEqual(
      [abs('/repo', 'dropped.ts'), abs('/repo', 'kept.ts')].sort(),
    );
    expect(result.truncated).toBe(false);
  });

  it('reports truncation when the change set names fewer files than it counts', () => {
    const result = reviewChangeSetContentPaths(
      changeSet([file('kept.ts')], '/repo', { fileCount: 51 }),
      '/repo',
    );

    expect(result.paths).toEqual([abs('/repo', 'kept.ts')]);
    expect(result.truncated).toBe(true);
  });

  it('does not treat a rename as two files when judging truncation', () => {
    // A rename contributes two names for one recorded file; counting raw
    // entries would hide a real truncation or invent one.
    expect(
      reviewChangeSetContentPaths(changeSet([file('new.ts', 'old.ts')], '/repo'), '/repo')
        .truncated,
    ).toBe(false);
  });
});
