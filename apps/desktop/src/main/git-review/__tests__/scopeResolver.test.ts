import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  defaultScopeResolverDeps,
  resolveReviewScope,
  type ScopeResolverDeps,
  withSessionReviewRowSnapshot,
} from '../scopeResolver';
import { GitRunError, type GitRunResult } from '../gitRunner';

function deps(patch: Partial<ScopeResolverDeps> = {}): ScopeResolverDeps {
  return {
    getSessionRow: vi.fn().mockResolvedValue({
      id: 's1',
      workingDir: '/repo/main',
      worktreePath: '/repo/wt-db',
      remoteHostId: null,
    }),
    getManagedWorktreePath: vi.fn().mockReturnValue('/repo/wt-store'),
    resolveSessionDir: vi.fn().mockResolvedValue({
      workdir: '/repo/wt-store',
      head: { kind: 'branch', branch: 'xdt/task', shortSha: 'abc1234' },
      source: 'worktree',
    }),
    git: vi.fn().mockImplementation(async (args: readonly string[]): Promise<GitRunResult> => {
      if (args.includes('--show-toplevel')) return { stdout: '/repo/wt-store\n', stderr: '', exitCode: 0 };
      if (args.includes('--verify')) return { stdout: 'abcdef\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    ...patch,
  };
}

describe('git-review scopeResolver', () => {
  it('prefers managed WorktreeStore path over DB snapshot fallback', async () => {
    const d = deps();
    const scope = await resolveReviewScope('s1', d);

    expect(d.resolveSessionDir).toHaveBeenCalledWith({
      sessionId: 's1',
      fallbackWorktreePath: '/repo/wt-store',
      fallbackWorkingDir: '/repo/main',
    });
    // 生产侧会对 workdir/repoRoot 做 path.resolve,win32 下补盘符,期望值同样 resolve。
    expect(scope).toMatchObject({
      workdir: path.resolve('/repo/wt-store'),
      repoRoot: path.resolve('/repo/wt-store'),
      branch: 'xdt/task',
      disabledReason: null,
    });
  });

  it('resolves an SSH session with remote POSIX paths without probing local paths', async () => {
    const d = deps({
      getSessionRow: vi.fn().mockResolvedValue({
        id: 's1',
        workingDir: '/remote/project/subdir',
        worktreePath: null,
        remoteHostId: 'host-1',
      }),
      git: vi.fn().mockImplementation(async (args: readonly string[]): Promise<GitRunResult> => {
        if (args.includes('--show-toplevel')) return { stdout: '/remote/project\n', stderr: '', exitCode: 0 };
        if (args.includes('--verify')) return { stdout: '0123456789abcdef\n', stderr: '', exitCode: 0 };
        if (args[0] === 'symbolic-ref') return { stdout: 'feature/ssh-review\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });

    const scope = await resolveReviewScope('s1', d);

    expect(scope).toMatchObject({
      workdir: '/remote/project/subdir',
      repoRoot: '/remote/project',
      source: 'remote',
      branch: 'feature/ssh-review',
      headOid: '0123456789abcdef',
      isDetached: false,
      disabledReason: null,
    });
    expect(d.resolveSessionDir).not.toHaveBeenCalled();
  });

  it('marks a remote HEAD without a symbolic branch as detached', async () => {
    const d = deps({
      getSessionRow: vi.fn().mockResolvedValue({
        id: 's1',
        workingDir: '/remote/project',
        worktreePath: null,
        remoteHostId: 'host-1',
      }),
      git: vi.fn().mockImplementation(async (args: readonly string[]): Promise<GitRunResult> => {
        if (args.includes('--show-toplevel')) return { stdout: '/remote/project\n', stderr: '', exitCode: 0 };
        if (args.includes('--verify')) return { stdout: '0123456789abcdef\n', stderr: '', exitCode: 0 };
        throw new GitRunError({ args, cwd: '/remote/project', exitCode: 1, stdout: '', stderr: '' });
      }),
    });

    await expect(resolveReviewScope('s1', d)).resolves.toMatchObject({
      branch: null,
      headOid: '0123456789abcdef',
      isDetached: true,
    });
  });

  it('reuses the request session-row snapshot instead of querying a second routing identity', async () => {
    const snapshot = {
      id: 's1',
      workingDir: '/remote/project',
      worktreePath: null,
      remoteHostId: 'host-1',
    };

    const row = await withSessionReviewRowSnapshot(
      snapshot,
      () => defaultScopeResolverDeps().getSessionRow('s1'),
    );

    expect(row).toEqual(snapshot);
  });

  it('distinguishes missing Git on the SSH host from a non-Git directory', async () => {
    const d = deps({
      getSessionRow: vi.fn().mockResolvedValue({
        id: 's1',
        workingDir: '/remote/project',
        worktreePath: null,
        remoteHostId: 'host-1',
      }),
      git: vi.fn().mockRejectedValue(new GitRunError({
        args: ['rev-parse'],
        cwd: '/remote/project',
        exitCode: 127,
        stdout: '',
        stderr: 'git: command not found',
      })),
    });

    const scope = await resolveReviewScope('s1', d);

    expect(scope.disabledReason).toBe('git-unavailable');
    expect(scope.disabledMessage).toBe('Git is not available on the SSH host');
  });

  it('propagates SSH transport failures during the remote repository probe', async () => {
    const failure = new Error('SSH channel closed while probing Git');
    const d = deps({
      getSessionRow: vi.fn().mockResolvedValue({
        id: 's1',
        workingDir: '/remote/project',
        worktreePath: null,
        remoteHostId: 'host-1',
      }),
      git: vi.fn().mockRejectedValue(failure),
    });

    await expect(resolveReviewScope('s1', d)).rejects.toBe(failure);
  });

  it('falls back to non-git disabled scope when no workdir resolves', async () => {
    const d = deps({
      resolveSessionDir: vi.fn().mockResolvedValue({ workdir: null, head: null, source: null }),
    });

    const scope = await resolveReviewScope('s1', d);

    expect(scope.disabledReason).toBe('non-git');
    expect(scope.resolutionChain.map((item) => item.source)).toEqual(['telemetry', 'worktree', 'workingDir']);
  });
});
