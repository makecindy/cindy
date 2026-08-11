import { describe, expect, it, vi } from 'vitest';

import { runGit as runScopedGit, runGitBuffer as runScopedGitBuffer } from '../gitRunner';
import {
  lstatReviewWorktreePath,
  readReviewWorktreeFile,
  readReviewWorktreePrefix,
} from '../reviewFileRunner';
import {
  __sshReviewBackendTesting,
  assertReadOnlyRemoteGitArgs,
  buildRemoteGitCommand,
  createSshPreviewReaderDeps,
  type SshReviewBackendDeps,
  type SshReviewHost,
  withSessionReviewExecution,
} from '../sshReviewBackend';
import { defaultScopeResolverDeps } from '../scopeResolver';
import type { ReviewScope } from '../types';

function remoteDeps(
  host: SshReviewHost,
  fileBrowser: SshReviewBackendDeps['getFileBrowser'] extends () => infer T ? T : never = {
    request: vi.fn(),
  },
  patch: Partial<SshReviewBackendDeps> = {},
): SshReviewBackendDeps {
  return {
    getSessionRow: vi.fn().mockResolvedValue({
      id: 's1',
      workingDir: '/srv/project',
      worktreePath: null,
      remoteHostId: 'host-1',
    }),
    ensureHostReady: vi.fn().mockResolvedValue(undefined),
    getHost: vi.fn().mockReturnValue(host),
    getFileBrowser: vi.fn().mockReturnValue(fileBrowser),
    ...patch,
  };
}

function execResult(
  bytes: Buffer | string,
  patch: Partial<Awaited<ReturnType<SshReviewHost['exec']>>> = {},
) {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  return {
    stdout: buffer.toString('base64'),
    stderr: '',
    exitCode: 0,
    signal: null,
    ...patch,
  };
}

describe('SSH git-review backend', () => {
  it('pins local session routing for the complete review request too', async () => {
    const row = {
      id: 'local-1',
      workingDir: 'C:\\repo',
      worktreePath: null,
      remoteHostId: null,
    };
    const deps = remoteDeps(
      { exec: vi.fn() },
      { request: vi.fn() },
      { getSessionRow: vi.fn().mockResolvedValue(row) },
    );

    const resolved = await withSessionReviewExecution(
      'local-1',
      () => defaultScopeResolverDeps().getSessionRow('local-1'),
      deps,
    );

    expect(resolved).toEqual(row);
    expect(deps.ensureHostReady).not.toHaveBeenCalled();
  });

  it('keeps the remote cwd and Git args out of shell syntax', () => {
    const cwd = "/srv/a repo/with ' quote";
    const gitArg = "file with ' quote.txt";
    const command = buildRemoteGitCommand(cwd, ['diff', '--', gitArg]);

    expect(command).toContain("bash -c '");
    expect(command).not.toContain(cwd);
    expect(command).not.toContain(gitArg);
    expect(command).toContain(Buffer.from(cwd).toString('base64'));
    expect(command).toContain(Buffer.from(gitArg).toString('base64'));
  });

  it('runs Git on the authoritative SSH host and preserves binary stdout', async () => {
    const raw = Buffer.from([0, 1, 2, 0, 255]);
    const host: SshReviewHost = {
      exec: vi.fn().mockResolvedValue(execResult(raw)),
    };
    const deps = remoteDeps(host);

    const result = await withSessionReviewExecution(
      's1',
      () => runScopedGitBuffer(['cat-file', 'blob', 'abc1234'], { cwd: '/srv/project' }),
      deps,
    );

    expect(result.stdout).toEqual(raw);
    expect(deps.ensureHostReady).toHaveBeenCalledWith('host-1');
    expect(deps.getHost).toHaveBeenCalledWith('host-1');
    expect(host.exec).toHaveBeenCalledOnce();
    const [command, options] = vi.mocked(host.exec).mock.calls[0];
    expect(command).not.toContain('/srv/project');
    expect(options).toMatchObject({ label: 'git-review-read', timeoutMs: 30_000 });
  });

  it('rejects mutating commands and unsafe diff options before opening an SSH channel', async () => {
    const host: SshReviewHost = { exec: vi.fn() };
    const deps = remoteDeps(host);

    await expect(
      withSessionReviewExecution(
        's1',
        () => runScopedGit(['add', 'file.txt'], { cwd: '/srv/project' }),
        deps,
      ),
    ).rejects.toThrow(/read-only Git operations/);
    expect(() =>
      assertReadOnlyRemoteGitArgs(['diff', '--output=/tmp/leak'], { cwd: '/srv/project' }),
    ).toThrow(/external side effects/);
    expect(() =>
      assertReadOnlyRemoteGitArgs(['cat-file', '--filters', 'HEAD:file.txt'], {
        cwd: '/srv/project',
      }),
    ).toThrow(/external side effects/);
    expect(host.exec).not.toHaveBeenCalled();
  });

  it('forces repository-configured diff helpers off on the controlled side', () => {
    expect(__sshReviewBackendTesting.hardenedRemoteGitArgs(['diff', '--numstat']))
      .toEqual(['diff', '--no-ext-diff', '--no-textconv', '--numstat']);
    expect(__sshReviewBackendTesting.hardenedRemoteGitArgs(['log', '--format=%H']))
      .toEqual(['log', '--no-ext-diff', '--no-textconv', '--format=%H']);
  });

  it('redacts the remote workspace path from command failures', async () => {
    const host: SshReviewHost = {
      exec: vi.fn().mockResolvedValue(
        execResult('', {
          stderr: "fatal: unsafe repository at '/srv/project'",
          exitCode: 128,
        }),
      ),
    };

    await expect(
      withSessionReviewExecution(
        's1',
        () => runScopedGit(['status'], { cwd: '/srv/project' }),
        remoteDeps(host),
      ),
    ).rejects.toSatisfy((err: Error) => {
      expect(err.message).toContain('<workspace>');
      expect(err.message).not.toContain('/srv/project');
      return true;
    });
  });

  it('redacts an ancestor repo root when the remote workspace is a subdirectory', async () => {
    const host: SshReviewHost = {
      exec: vi.fn().mockResolvedValue(
        execResult('', {
          stderr: "fatal: unsafe repository at '/Users/david/project'; cwd '/Users/david/project/subdir'",
          exitCode: 128,
        }),
      ),
    };
    const deps = remoteDeps(
      host,
      { request: vi.fn() },
      {
        getSessionRow: vi.fn().mockResolvedValue({
          id: 's1',
          workingDir: '/Users/david/project/subdir',
          worktreePath: null,
          remoteHostId: 'host-1',
        }),
      },
    );

    await expect(
      withSessionReviewExecution(
        's1',
        () => runScopedGit(['rev-parse', '--show-toplevel'], {
          cwd: '/Users/david/project/subdir',
        }),
        deps,
      ),
    ).rejects.toSatisfy((err: Error) => {
      expect(err.message).toContain('<workspace>');
      expect(err.message).not.toContain('/Users/david/project');
      expect(err.message).not.toContain('/Users/david/project/subdir');
      return true;
    });
  });

  it('keeps concurrent SSH review requests isolated by session', async () => {
    const makeDeps = (sessionId: string, hostId: string, output: string): SshReviewBackendDeps => {
      const host: SshReviewHost = {
        exec: vi.fn(async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return execResult(output);
        }),
      };
      return remoteDeps(
        host,
        { request: vi.fn() },
        {
          getSessionRow: vi.fn().mockResolvedValue({
            id: sessionId,
            workingDir: `/srv/${sessionId}`,
            worktreePath: null,
            remoteHostId: hostId,
          }),
        },
      );
    };

    const [one, two] = await Promise.all([
      withSessionReviewExecution(
        's1',
        () => runScopedGit(['status'], { cwd: '/srv/s1' }),
        makeDeps('s1', 'h1', 'one'),
      ),
      withSessionReviewExecution(
        's2',
        () => runScopedGit(['status'], { cwd: '/srv/s2' }),
        makeDeps('s2', 'h2', 'two'),
      ),
    ]);

    expect(one.stdout).toBe('one');
    expect(two.stdout).toBe('two');
  });

  it('reads guarded worktree previews through the controlled-side file service', async () => {
    const bytes = Buffer.from('remote markdown', 'utf8');
    const request = vi.fn(
      async (_hostId: string, method: string, params: Record<string, unknown>) => {
        expect(params).toMatchObject({ workdir: '/srv/project', relPath: 'docs/readme.md' });
        if (method === 'stat') return { type: 'file', size: bytes.length, mtimeMs: 123 };
        return {
          dataBase64: bytes.toString('base64'),
          eof: true,
          size: bytes.length,
          mtimeMs: 123,
        };
      },
    );
    const scope = {
      sessionId: 's1',
      workingDir: '/srv/project',
      repoRoot: '/srv/project',
      source: 'remote',
    } as ReviewScope;
    const deps = remoteDeps({ exec: vi.fn() }, { request });

    const result = await withSessionReviewExecution(
      's1',
      async () => {
        const preview = createSshPreviewReaderDeps(scope);
        const stat = await preview.stat('/srv/project/docs/readme.md');
        const content = await preview.readFile('/srv/project/docs/readme.md');
        return { stat, content };
      },
      deps,
    );

    expect(result.stat.isFile()).toBe(true);
    expect(result.content).toEqual(bytes);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('routes ordinary diff metadata and content reads through the controlled-side file service', async () => {
    const bytes = Buffer.from('line one\nline two\n', 'utf8');
    const request = vi.fn(
      async (_hostId: string, method: string, params: Record<string, unknown>) => {
        expect(params).toMatchObject({ workdir: '/srv/project', relPath: 'new.txt' });
        if (method === 'stat') return { type: 'file', size: bytes.length, mtimeMs: 123 };
        const length = params.length as number;
        return {
          dataBase64: bytes.subarray(0, length).toString('base64'),
          eof: length >= bytes.length,
          size: bytes.length,
          mtimeMs: 123,
        };
      },
    );

    const result = await withSessionReviewExecution(
      's1',
      async () => ({
        stat: await lstatReviewWorktreePath('/srv/project', 'new.txt'),
        prefix: await readReviewWorktreePrefix('/srv/project', 'new.txt', 8),
        content: await readReviewWorktreeFile('/srv/project', 'new.txt', 1024),
      }),
      remoteDeps({ exec: vi.fn() }, { request }),
    );

    expect(result.stat).toEqual({ size: bytes.length, isSymlink: false });
    expect(result.prefix).toEqual(bytes.subarray(0, 8));
    expect(result.content).toEqual(bytes);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects oversized decoded chunks even when the controlled side claims eof', async () => {
    const oversized = Buffer.alloc(9, 1);
    const request = vi.fn().mockResolvedValue({
      dataBase64: oversized.toString('base64'),
      eof: true,
      size: 1,
      mtimeMs: 123,
    });

    await expect(
      withSessionReviewExecution(
        's1',
        () => readReviewWorktreeFile('/srv/project', 'new.txt', 8),
        remoteDeps({ exec: vi.fn() }, { request }),
      ),
    ).rejects.toThrow(/oversized/);
  });

  it('rejects oversized prefix responses before returning them to preview readers', async () => {
    const oversized = Buffer.alloc(9, 1);
    const request = vi.fn().mockResolvedValue({
      dataBase64: oversized.toString('base64'),
      eof: true,
      size: oversized.length,
      mtimeMs: 123,
    });

    await expect(
      withSessionReviewExecution(
        's1',
        () => readReviewWorktreePrefix('/srv/project', 'new.txt', 8),
        remoteDeps({ exec: vi.fn() }, { request }),
      ),
    ).rejects.toThrow(/oversized/);
  });

  it('redacts SSH setup details before review errors leave Main', async () => {
    const deps = remoteDeps(
      { exec: vi.fn() },
      { request: vi.fn() },
      {
        ensureHostReady: vi.fn().mockRejectedValue(
          new Error('[SSH_AUTH_FAILED] Identity file C:\\Users\\alice\\.ssh\\id_ed25519'),
        ),
      },
    );

    await expect(withSessionReviewExecution('s1', async () => null, deps))
      .rejects.toThrow('[SSH_AUTH_FAILED] SSH workspace review could not connect to the remote host');
  });

  it('rejects remote preview traversal before calling the file service', () => {
    expect(() =>
      __sshReviewBackendTesting.remoteRelativePath('/srv/project', '/srv/secret.txt'),
    ).toThrow(/outside the repository/);
  });
});
