import { beforeEach, describe, expect, it, vi } from 'vitest';

const runGitMock = vi.hoisted(() => vi.fn());

vi.mock('../gitRunner.js', () => ({
  runGit: runGitMock,
}));

import { parsePorcelainV2Status, readStatus } from '../statusReader';
import type { ReviewScope } from '../types';

const scope: ReviewScope = {
  sessionId: 's1',
  workdir: '/repo',
  worktreePath: '/repo',
  workingDir: '/repo',
  repoRoot: '/repo',
  branch: null,
  headOid: null,
  isDetached: false,
  isUnborn: false,
  source: 'worktree',
  aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
  disabledReason: null,
  disabledMessage: null,
  resolutionChain: [],
};

beforeEach(() => {
  runGitMock.mockReset();
});

describe('git-review statusReader', () => {
  it('keeps staged and unstaged state for the same path', () => {
    const status = parsePorcelainV2Status(
      [
        '# branch.oid abcdef',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -1',
        '1 MM N... 100644 100644 100644 abcdef1 abcdef2 src/app.ts',
        '',
      ].join('\0'),
      scope,
    );

    expect(status.scope.branch).toBe('main');
    expect(status.scope.aheadBehind).toMatchObject({ ahead: 2, behind: 1, upstream: 'origin/main' });
    expect(status.files[0]).toMatchObject({
      path: 'src/app.ts',
      indexStatus: 'modified',
      worktreeStatus: 'modified',
      sources: ['staged', 'unstaged'],
    });
    expect(status.stagedCount).toBe(1);
    expect(status.unstagedCount).toBe(1);
  });

  it('parses untracked and unmerged entries', () => {
    const status = parsePorcelainV2Status(
      [
        '? new file.txt',
        '? new-dir/',
        'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.txt',
        '',
      ].join('\0'),
      scope,
    );

    expect(status.files.map((f) => f.path)).toEqual(['new file.txt', 'conflict.txt']);
    expect(status.untrackedCount).toBe(1);
    expect(status.unmergedCount).toBe(1);
    expect(status.writeDisabledReasons).toContain('unmerged');
    // 普通文件冲突不是 submodule;XY 取自记录本身,不再硬编码。
    const conflict = status.files.find((f) => f.path === 'conflict.txt');
    expect(conflict?.isSubmodule).toBe(false);
    expect(conflict?.rawXY).toBe('UU');
  });

  it('keeps submodule identity on unmerged gitlink records (#2463 review)', () => {
    // 顶层 gitlink 的合并冲突:porcelain=2 的 u 记录 sub 字段为 S 开头 ——
    // 丢掉它会让冲突 gitlink 绕过 submodule reader,目录被普通文件指纹器
    // 拒绝、合法冲突无法启动 Review。
    const status = parsePorcelainV2Status(
      [
        'u AA S... 160000 160000 160000 160000 aaaaaaa bbbbbbb ccccccc vendor/lib',
        '',
      ].join('\0'),
      scope,
    );

    const gitlink = status.files.find((f) => f.path === 'vendor/lib');
    expect(gitlink?.isSubmodule).toBe(true);
    expect(gitlink?.isUnmerged).toBe(true);
    expect(gitlink?.rawXY).toBe('AA');
  });

  it('marks SSH workspace status as view-only', () => {
    const status = parsePorcelainV2Status('# branch.head main\0', { ...scope, source: 'remote' });

    expect(status.writeDisabledReasons).toContain('remote-ssh');
  });

  it('guards git status stdout collection with the large diff stdout limit', async () => {
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'status') {
        return {
          stdout: [
            '# branch.oid abcdef',
            '# branch.head main',
            '',
          ].join('\0'),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: `/repo/.git/${args.at(-1) ?? 'marker'}\n`, stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    await readStatus(scope);

    const statusCall = runGitMock.mock.calls.find(([args]) => (args as readonly string[])[0] === 'status');
    expect(statusCall?.[1]).toMatchObject({
      cwd: '/repo',
      maxStdoutBytes: 128 * 1024 * 1024,
    });
  });

  it('passes --ignore-submodules=none so ignore-configured submodules stay visible (#2463 review)', async () => {
    // submodule.<name>.ignore=all/dirty 会让 status 省略脏子仓,dirty 内容进不了
    // Review 发现链;submoduleEvidencePaths() 的 status 兜底显式依赖这个 flag。
    // flag 被静默丢掉时新鲜度绕过会复现,必须有断言拦住。
    runGitMock.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === 'status') {
        return {
          stdout: ['# branch.oid abcdef', '# branch.head main', ''].join('\0'),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: `/repo/.git/${args.at(-1) ?? 'marker'}\n`, stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    await readStatus(scope);

    const statusCall = runGitMock.mock.calls.find(([args]) => (args as readonly string[])[0] === 'status');
    expect(statusCall?.[0]).toContain('--ignore-submodules=none');
  });
});
