import { beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
  ensureReady: vi.fn(async () => undefined),
  exec: vi.fn(),
}));

vi.mock('../../remote-ssh/index.js', () => ({
  ensureRemoteHostReady: remote.ensureReady,
  getRemoteSshPool: () => ({
    get: () => ({
      getStatus: () => 'ready',
      exec: remote.exec,
    }),
  }),
}));

import {
  inspectRemoteBotWorktree,
  removeRemoteBotWorktree,
} from '../botRemoteWorkspaceService.js';

const input = {
  remoteHostId: 'remote-1',
  baseRepo: '/repo',
  worktreePath: '/repo/.cindy-worktrees/bot-1',
  branch: 'cindy/bot-bot-1',
};

describe('remote Bot workspace ownership', () => {
  beforeEach(() => {
    remote.ensureReady.mockClear();
    remote.exec.mockReset();
  });

  it('treats only an absent path as a missing worktree', async () => {
    remote.exec.mockResolvedValue({ exitCode: 44, stdout: '', stderr: '', truncated: false });

    await expect(inspectRemoteBotWorktree(input)).resolves.toEqual({ exists: false });
  });

  it('does not treat a replaced path as safely released', async () => {
    remote.exec.mockResolvedValue({
      exitCode: 45,
      stdout: '',
      stderr: 'remote path is not a directory',
      truncated: false,
    });

    await expect(inspectRemoteBotWorktree(input)).rejects.toThrow(
      'remote path is not a directory',
    );
  });

  it('makes a repeated remote removal safe after an ambiguous successful delete', async () => {
    remote.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', truncated: false });

    await expect(removeRemoteBotWorktree(input)).resolves.toBeUndefined();
    const options = remote.exec.mock.calls[0]?.[1] as { input?: string } | undefined;
    expect(options?.input).toContain('[ ! -e "$worktree_path" ] && exit 0');
  });
});
