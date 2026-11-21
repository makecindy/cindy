import { describe, expect, it } from 'vitest';

import type { FileDiff, ReviewData } from '@/lib/gitReview.types';
import { buildWorkdirGitMaps } from '@/features/cc-agent/workdir-browse/lib/workdirGitStatus';

// 测试价值：文件树和编辑器依赖同一份路径/目录/行号映射；这里直接从 git-review
// 生产 DTO 构建，覆盖 repo 路径 → workdir 相对路径、目录聚合及混合暂存状态。
// 现有测试只覆盖 review 自身文件树，不覆盖 workdir 浏览器的状态投影。最小失败
// 输入是 src/a.ts 同时有 staged/unstaged diff；tier: unit。
function diff(path: string, source: 'staged' | 'unstaged', lines: number[]): FileDiff {
  return {
    id: `${source}:${path}`,
    source,
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: 1,
    additions: lines.length,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [
      {
        index: 0,
        header: '@@ -0,0 +1,3 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        section: '',
        lines: lines.map((lineNumber, index) => ({
          index,
          type: 'add',
          content: '',
          raw: '',
          oldLineNumber: null,
          newLineNumber: lineNumber,
          originalLineNumber: lineNumber,
          selectable: true,
          noTrailingNewLine: false,
        })),
        selectableLines: [],
        raw: '',
      },
    ],
    error: null,
  };
}

describe('buildWorkdirGitMaps', () => {
  it('maps repository paths, aggregates directories and keeps current worktree lines', () => {
    const data = {
      scope: {
        sessionId: 'session-1',
        workdir: '/repo',
        worktreePath: '/repo',
        workingDir: '/repo',
        repoRoot: '/repo',
        branch: 'main',
        headOid: null,
        isDetached: false,
        isUnborn: false,
        source: 'worktree',
        aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: false },
        disabledReason: null,
        disabledMessage: null,
        resolutionChain: [],
      },
      status: {
        files: [
          {
            path: 'src/a.ts',
            oldPath: null,
            indexStatus: null,
            worktreeStatus: 'modified',
            isUntracked: false,
            isUnmerged: false,
            isSubmodule: false,
            sources: ['unstaged'],
            rawXY: '.M',
          },
          {
            path: 'src/deep/b.ts',
            oldPath: null,
            indexStatus: null,
            worktreeStatus: 'untracked',
            isUntracked: true,
            isUnmerged: false,
            isSubmodule: false,
            sources: ['unstaged'],
            rawXY: '??',
          },
          {
            path: 'README.md',
            oldPath: null,
            indexStatus: 'added',
            worktreeStatus: null,
            isUntracked: false,
            isUnmerged: false,
            isSubmodule: false,
            sources: ['staged'],
            rawXY: 'A.',
          },
        ],
        scope: {} as never,
        stagedCount: 1,
        unstagedCount: 2,
        untrackedCount: 1,
        unmergedCount: 0,
        inProgress: [],
        writeDisabledReasons: [],
        dirty: true,
      },
      diffs: {
        unstaged: [diff('src/a.ts', 'unstaged', [2, 3])],
        staged: [diff('README.md', 'staged', [1]), diff('src/a.ts', 'staged', [9])],
      },
      summary: {} as never,
    } as ReviewData;

    const maps = buildWorkdirGitMaps(data, '/repo');

    expect([...maps.files.keys()].sort()).toEqual(['README.md', 'src/a.ts', 'src/deep/b.ts']);
    expect(maps.files.get('README.md')?.kind).toBe('added');
    expect(maps.files.get('src/deep/b.ts')?.kind).toBe('untracked');
    expect(maps.directories.get('src')).toEqual({ kind: 'modified', count: 2 });
    expect(maps.directories.get('src/deep')).toEqual({ kind: 'untracked', count: 1 });
    expect([...maps.changedLines.get('src/a.ts')!]).toEqual([2, 3]);
    expect([...maps.changedLines.get('README.md')!]).toEqual([1]);
  });
});
