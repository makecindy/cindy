import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitExecMock = vi.hoisted(() => vi.fn());

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
}));

import {
  isolatedGitExec,
  snapshotGitIsolationArgs,
  SnapshotGitIsolationError,
} from '../git-snapshot/isolatedGitExec';

describe('isolatedGitExec', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
    gitExecMock.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('disables repository-local fsmonitor, hooks, and LFS filters including required', async () => {
    await isolatedGitExec(['status', '--porcelain=v1', '-z'], '/repo');

    expect(gitExecMock).toHaveBeenCalledTimes(2);
    const listArgs = gitExecMock.mock.calls[0][0] as string[];
    expect(listArgs.slice(-4)).toEqual(['config', '--null', '--name-only', '--list']);
    const [args, cwd] = gitExecMock.mock.calls[1] as [string[], string];
    expect(cwd).toBe('/repo');
    expect(args).toContain('core.fsmonitor=');
    expect(args).toContain('core.useBuiltinFSMonitor=false');
    expect(args).toContain('filter.lfs.clean=');
    expect(args).toContain('filter.lfs.smudge=');
    expect(args).toContain('filter.lfs.process=');
    expect(args).toContain('filter.lfs.required=false');
    expect(args.some((arg) => arg.startsWith('core.hooksPath='))).toBe(true);
    expect(args[args.length - 3]).toBe('status');
    expect(args.slice(-2)).toEqual(['--porcelain=v1', '-z']);
  });

  it('overrides arbitrary discovered filter and textconv drivers', async () => {
    gitExecMock.mockImplementation(async (args: readonly string[]) => {
      if (args.includes('config')) {
        return {
          stdout: [
            'filter.evil.process',
            'filter.evil.required',
            'filter.evil=x.process',
            'diff.evil.textconv',
            'filter.lfs.required',
            'user.name',
          ].join('\0'),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    await isolatedGitExec(['add', '-A'], '/repo');

    const commandArgs = gitExecMock.mock.calls[1][0] as string[];
    expect(commandArgs).toContain('filter.evil.process=');
    expect(commandArgs).toContain('filter.evil.required=false');
    expect(commandArgs).toContain('filter.evil=x.process=');
    expect(commandArgs).toContain('diff.evil.textconv=');
    expect(commandArgs).toContain('filter.lfs.required=false');
    expect(commandArgs.slice(-2)).toEqual(['add', '-A']);
  });

  it('injects --no-textconv and --no-ext-diff for snapshot diffs', async () => {
    await isolatedGitExec(['diff', '--cached'], '/repo');
    const commandArgs = gitExecMock.mock.calls[1][0] as string[];
    expect(commandArgs).toContain('diff.external=');
    expect(commandArgs.slice(-4)).toEqual(['diff', '--no-textconv', '--no-ext-diff', '--cached']);
  });

  it('aborts when repository config cannot be listed', async () => {
    gitExecMock.mockRejectedValueOnce(new Error('maxBuffer length exceeded'));
    await expect(isolatedGitExec(['add', '-A'], '/repo')).rejects.toBeInstanceOf(
      SnapshotGitIsolationError,
    );
    expect(gitExecMock).toHaveBeenCalledTimes(1);
    expect((gitExecMock.mock.calls[0][0] as string[]).slice(-4)).toEqual([
      'config',
      '--null',
      '--name-only',
      '--list',
    ]);
  });

  it('keeps isolation args ahead of the git subcommand', () => {
    const args = snapshotGitIsolationArgs('/tmp/empty-hooks');
    expect(args.indexOf('core.fsmonitor=')).toBeLessThan(args.length);
    expect(args[1]).toBe('core.hooksPath=/tmp/empty-hooks');
    expect(args).toContain('filter.lfs.required=false');
  });
});
