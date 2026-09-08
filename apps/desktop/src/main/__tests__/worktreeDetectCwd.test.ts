/**
 * worktree-parallel-sessions: detectCwd 的 isInsideWorktree 检测单测。
 *
 * I-1 修复: 不再仅靠托管目录名启发式; 改用
 *   git rev-parse --git-dir   vs   git rev-parse --git-common-dir
 * 不一致即 linked worktree。两种 worktree 都能识别:
 *   1) Cindy 自己创建的 worktree (路径含 .cindy-worktrees；兼容历史目录)
 *   2) 外部工具 (CC Desktop / 手工 git worktree add) 创建的 worktree (路径不含)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { detectCwd } from '../worktree/WorktreeManager';

// ── mock gitExec, 控制 detectCwd 看到的 git 输出 ──────────────────────────
const { gitExecMock } = vi.hoisted(() => ({
  gitExecMock: vi.fn(),
}));
vi.mock('../worktree/gitExec', async () => {
  const actual = await vi.importActual<typeof import('../worktree/gitExec')>('../worktree/gitExec');
  return {
    ...actual,
    gitExec: (args: readonly string[], cwd?: string) => gitExecMock(args, cwd),
  };
});

beforeEach(() => {
  gitExecMock.mockReset();
});

/**
 * 通用 mock builder: 按 args[0] 分派, 让测试用例只关心两个 rev-parse 输出。
 *
 * @param opts
 *   - toplevel: rev-parse --show-toplevel 的输出
 *   - gitDir / gitCommonDir: rev-parse --git-dir / --git-common-dir 的输出
 *   - branch: rev-parse --abbrev-ref HEAD 的输出
 */
function setupGitMock(opts: {
  toplevel: string;
  gitDir: string;
  gitCommonDir: string;
  branch?: string;
}): void {
  gitExecMock.mockImplementation(async (args: readonly string[]) => {
    const a = args.join(' ');
    if (a === '--version') return { stdout: 'git version 2.45.0\n', stderr: '' };
    if (a === 'rev-parse --show-toplevel') return { stdout: `${opts.toplevel}\n`, stderr: '' };
    if (a === 'rev-parse --abbrev-ref HEAD')
      return { stdout: `${opts.branch ?? 'main'}\n`, stderr: '' };
    if (a === 'rev-parse --git-dir') return { stdout: `${opts.gitDir}\n`, stderr: '' };
    if (a === 'rev-parse --git-common-dir') return { stdout: `${opts.gitCommonDir}\n`, stderr: '' };
    throw new Error(`unexpected gitExec call: ${a}`);
  });
}

describe('detectCwd → isInsideWorktree (I-1 fix)', () => {
  it.each([
    ['linked', '/repo/.git/worktrees/feature', '/repo/.git', 'feature', true],
    ['main', '.git', '.git', 'main', false],
    ['detached', '/repo/.git/worktrees/feature', '/repo/.git', 'HEAD', true],
  ])(
    'reads a %s worktree snapshot with one Git process',
    async (_label, gitDir, commonDir, branch, linked) => {
      gitExecMock.mockResolvedValue({ stdout: `/repo\n${branch}\n${gitDir}\n${commonDir}\n` });
      expect(await detectCwd('/repo')).toEqual({
        isGitRepo: true,
        isInsideWorktree: linked,
        gitInstalled: true,
        supportsRecoveryKeyDiscard: true,
        repoRoot: path.resolve('/repo'),
        ...(branch !== 'HEAD' ? { currentBranch: branch } : {}),
      });
      expect(gitExecMock).toHaveBeenCalledOnce();
    },
  );

  it('retains separate queries when combined output has ambiguous newlines', async () => {
    setupGitMock({ toplevel: '/repo', gitDir: '.git', gitCommonDir: '.git' });
    gitExecMock.mockResolvedValueOnce({ stdout: '/repo\nwith-newline\nmain\n.git\n.git\n' });
    expect(await detectCwd('/repo')).toMatchObject({ isGitRepo: true, isInsideWorktree: false });
    expect(gitExecMock).toHaveBeenCalledTimes(6);
  });

  it('returns isInsideWorktree=true for a Cindy-created worktree', async () => {
    const baseRepo = path.resolve('/tmp/repo');
    const wtPath = path.join(baseRepo, '.cindy-worktrees', 'jolly-turing');
    setupGitMock({
      toplevel: wtPath,
      // 在 linked worktree 里, --git-dir 指向主仓库 .git/worktrees/<name>
      gitDir: path.join(baseRepo, '.git', 'worktrees', 'jolly-turing'),
      gitCommonDir: path.join(baseRepo, '.git'),
    });

    const out = await detectCwd(wtPath);
    expect(out.isGitRepo).toBe(true);
    expect(out.isInsideWorktree).toBe(true);
  });

  it('falls back to current managed directory detection when git metadata lookup fails', async () => {
    const baseRepo = path.resolve('/tmp/repo');
    const wtPath = path.join(baseRepo, '.cindy-worktrees', 'jolly-turing');
    gitExecMock.mockImplementation(async (args: readonly string[]) => {
      const a = args.join(' ');
      if (a === '--version') return { stdout: 'git version 2.45.0\n', stderr: '' };
      if (a === 'rev-parse --show-toplevel') return { stdout: `${wtPath}\n`, stderr: '' };
      if (a === 'rev-parse --abbrev-ref HEAD') return { stdout: 'xdt/jolly-turing\n', stderr: '' };
      if (a === 'rev-parse --git-dir' || a === 'rev-parse --git-common-dir') {
        throw new Error('metadata unavailable');
      }
      throw new Error(`unexpected gitExec call: ${a}`);
    });

    const out = await detectCwd(wtPath);
    expect(out.isInsideWorktree).toBe(true);
  });

  it('returns isInsideWorktree=true for an externally-created worktree (path outside managed roots)', async () => {
    // 模拟 CC Desktop 等外部工具用 `git worktree add ../feature-x` 创建的 worktree:
    // 路径完全不含 Cindy 托管目录名,旧的目录名启发式漏检,新逻辑必须正确识别。
    const mainRepo = path.resolve('/tmp/repo');
    const wtPath = path.resolve('/tmp/feature-x');
    setupGitMock({
      toplevel: wtPath,
      gitDir: path.join(mainRepo, '.git', 'worktrees', 'feature-x'),
      gitCommonDir: path.join(mainRepo, '.git'),
    });

    const out = await detectCwd(wtPath);
    expect(out.isGitRepo).toBe(true);
    expect(out.isInsideWorktree).toBe(true);
  });

  it('returns isInsideWorktree=false for the main worktree (git-dir == git-common-dir)', async () => {
    const baseRepo = path.resolve('/tmp/repo');
    setupGitMock({
      toplevel: baseRepo,
      // 主 worktree 里 --git-dir 与 --git-common-dir 一致, 都指向同一个 .git
      gitDir: path.join(baseRepo, '.git'),
      gitCommonDir: path.join(baseRepo, '.git'),
    });

    const out = await detectCwd(baseRepo);
    expect(out.isGitRepo).toBe(true);
    expect(out.isInsideWorktree).toBe(false);
  });
});
