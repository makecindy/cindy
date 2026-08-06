import { describe, expect, it, vi } from 'vitest';

import {
  probeRemoteGitDir,
  resolveAuthoritativeSessionGitTarget,
  resolveReadyRemoteGitHost,
  resolveRemoteSessionGitDir,
  type RemoteGitHost,
} from '../git-context/remoteSessionDirResolver';

function makeHost(stdout: string, opts?: { status?: string; reject?: boolean }) {
  const exec = opts?.reject
    ? vi.fn().mockRejectedValue(new Error('disconnected'))
    : vi.fn().mockResolvedValue({ stdout });
  return {
    host: {
      getStatus: () => opts?.status ?? 'ready',
      exec,
    } satisfies RemoteGitHost,
    exec,
  };
}

describe('probeRemoteGitDir', () => {
  it('读取远端分支并限制 probe 的执行预算', async () => {
    const { host, exec } = makeHost('branch:feature/remote\n');

    await expect(probeRemoteGitDir(host, "/srv/O'Reilly/project")).resolves.toEqual({
      kind: 'branch',
      branch: 'feature/remote',
      shortSha: null,
    });
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("git -C '/srv/O'\\''Reilly/project'"),
      expect.objectContaining({ timeoutMs: 5_000, label: 'git context probe', maxOutputBytes: 1_024 }),
    );
  });

  it('读取 detached HEAD', async () => {
    const { host } = makeHost('detached:deadbeef\n');
    await expect(probeRemoteGitDir(host, '/srv/project')).resolves.toEqual({
      kind: 'detached',
      branch: null,
      shortSha: 'deadbeef',
    });
  });

  it('远端未连接或执行失败时降级为空', async () => {
    await expect(probeRemoteGitDir(makeHost('', { status: 'disconnected' }).host, '/repo')).resolves.toBeNull();
    await expect(probeRemoteGitDir(makeHost('', { reject: true }).host, '/repo')).resolves.toBeNull();
  });
});

describe('resolveReadyRemoteGitHost', () => {
  it('冷启动时先 hydrate/connect,再返回 ready host', async () => {
    const { host } = makeHost('branch:main\n');
    const ensureReady = vi.fn().mockResolvedValue(undefined);
    const getHost = vi.fn().mockReturnValue(host);

    await expect(resolveReadyRemoteGitHost('ssh-1', { ensureReady, getHost })).resolves.toBe(host);
    expect(ensureReady).toHaveBeenCalledWith('ssh-1');
    expect(getHost).toHaveBeenCalledWith('ssh-1');
  });

  it('连接失败时保持 Git context 静默降级为空', async () => {
    const ensureReady = vi.fn().mockRejectedValue(new Error('auth failed'));
    const getHost = vi.fn();

    await expect(resolveReadyRemoteGitHost('ssh-1', { ensureReady, getHost })).resolves.toBeNull();
    expect(getHost).not.toHaveBeenCalled();
  });

  it('ensure 成功但 host 仍未 ready 时不执行 probe', async () => {
    const { host } = makeHost('', { status: 'reconnecting' });

    await expect(
      resolveReadyRemoteGitHost('ssh-1', {
        ensureReady: vi.fn().mockResolvedValue(undefined),
        getHost: vi.fn().mockReturnValue(host),
      }),
    ).resolves.toBeNull();
  });
});

describe('resolveRemoteSessionGitDir', () => {
  it('按 worktree → workingDir 顺序尝试远端路径，并保留 workingDir 低可信来源', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'branch:main\n' });
    const host: RemoteGitHost = { getStatus: () => 'ready', exec };

    await expect(
      resolveRemoteSessionGitDir({
        telemetryPath: null,
        fallbackWorktreePath: '/remote/worktree',
        fallbackWorkingDir: '/remote/repo',
        host,
      }),
    ).resolves.toEqual({
      workdir: '/remote/repo',
      head: { kind: 'branch', branch: 'main', shortSha: null },
      source: 'workingDir',
    });
  });

  it('命中远端 worktree 时保留 remote 可信来源', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'branch:feature/remote\n' });
    const host: RemoteGitHost = { getStatus: () => 'ready', exec };

    await expect(
      resolveRemoteSessionGitDir({
        telemetryPath: null,
        fallbackWorktreePath: '/remote/worktree',
        fallbackWorkingDir: '/remote/repo',
        host,
      }),
    ).resolves.toEqual({
      workdir: '/remote/worktree',
      head: { kind: 'branch', branch: 'feature/remote', shortSha: null },
      source: 'remote',
    });
  });

  it('优先尝试最新 telemetry 路径', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'branch:telemetry\n' });
    const host: RemoteGitHost = { getStatus: () => 'ready', exec };

    await expect(
      resolveRemoteSessionGitDir({
        telemetryPath: '/remote/telemetry',
        fallbackWorktreePath: '/remote/worktree',
        fallbackWorkingDir: '/remote/repo',
        host,
      }),
    ).resolves.toMatchObject({ workdir: '/remote/telemetry', source: 'remote' });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAuthoritativeSessionGitTarget', () => {
  it('直连 SSH 只使用 main 记录的 host 与远端路径', () => {
    expect(
      resolveAuthoritativeSessionGitTarget({
        stored: {
          workingDir: '/stored/repo',
          worktreePath: '/stored/worktree',
          remoteHostId: 'ssh-1',
        },
        requestedRemoteHostId: 'ssh-1',
        isDeviceLink: false,
        liveLocalWorktreePath: '/local/ignored',
      }),
    ).toEqual({
      workingDir: '/stored/repo',
      worktreePath: '/stored/worktree',
      remoteHostId: 'ssh-1',
    });
  });

  it('直连 renderer 不能把 session 切到另一台 SSH host', () => {
    expect(
      resolveAuthoritativeSessionGitTarget({
        stored: {
          workingDir: '/stored/repo',
          worktreePath: '/stored/worktree',
          remoteHostId: 'ssh-1',
        },
        requestedRemoteHostId: 'ssh-forged',
        isDeviceLink: false,
        liveLocalWorktreePath: null,
      }),
    ).toBeNull();
  });

  it('device-link 忽略控制端投影并按被控端 session 选择 live 本地 worktree', () => {
    expect(
      resolveAuthoritativeSessionGitTarget({
        stored: {
          workingDir: '/controlled/repo',
          worktreePath: '/stale/deleted-worktree',
          remoteHostId: null,
        },
        requestedRemoteHostId: 'ssh-forged',
        isDeviceLink: true,
        liveLocalWorktreePath: '/controlled/live-worktree',
      }),
    ).toEqual({
      workingDir: '/controlled/repo',
      worktreePath: '/controlled/live-worktree',
      remoteHostId: null,
    });
  });
});
