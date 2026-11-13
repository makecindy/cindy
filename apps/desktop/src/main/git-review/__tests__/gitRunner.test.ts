import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitRunError, runGit, runGitBuffer, withGitExecutionBackend } from '../gitRunner';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const dubiousStderr = [
  "fatal: detected dubious ownership in repository at '/tmp/repo'",
  "To add an exception for this directory, call:",
  '',
  "\tgit config --global --add safe.directory '/tmp/repo'",
  '',
].join('\n');

function failedGitChild(stderr: string): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  setImmediate(() => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 128);
  });
  return child;
}

function spawnedArgs(): readonly string[][] {
  return vi.mocked(spawn).mock.calls.map((call) => call[1] as string[]);
}

describe('git-review gitRunner', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('throws dubious ownership errors without writing global safe.directory', async () => {
    vi.mocked(spawn).mockImplementation(() => failedGitChild(dubiousStderr) as never);

    await expect(runGit(['status'], { cwd: '/tmp/repo' })).rejects.toMatchObject({
      name: 'GitRunError',
      stderr: dubiousStderr,
    } satisfies Partial<GitRunError>);

    expect(spawnedArgs()).toEqual([['status']]);
    expect(spawnedArgs().some((args) => args.includes('--global') || args.includes('safe.directory'))).toBe(false);
  });

  it('throws dubious ownership buffer errors without writing global safe.directory', async () => {
    vi.mocked(spawn).mockImplementation(() => failedGitChild(dubiousStderr) as never);

    await expect(runGitBuffer(['cat-file', 'blob', 'HEAD:file.txt'], { cwd: '/tmp/repo' })).rejects.toMatchObject({
      name: 'GitRunError',
      stderr: dubiousStderr,
    } satisfies Partial<GitRunError>);

    expect(spawnedArgs()).toEqual([['cat-file', 'blob', 'HEAD:file.txt']]);
    expect(spawnedArgs().some((args) => args.includes('--global') || args.includes('safe.directory'))).toBe(false);
  });

  // 2026-11-13 group checkout stall: `git pull` timed out but the runner waited ~8 more minutes,
  // because the `fetch` it started still held the output pipes. A timeout now settles at once and
  // ends the whole process group when asked to. Unit: the real runner over a child that never closes.
  it('settles a timeout at once and ends the process group', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: { end: vi.fn() }, kill: vi.fn(), pid: 4242 });
      vi.mocked(spawn).mockReturnValueOnce(child as never);
      const pulled = runGit(['pull'], { cwd: '/tmp/repo', timeoutMs: 1000, killProcessGroup: true });
      const settled = expect(pulled).rejects.toMatchObject({ message: 'git pull timed out after 1000ms' });
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
      expect(vi.mocked(spawn).mock.calls.at(-1)![2]).toMatchObject(process.platform === 'win32' ? {} : { detached: true });
      if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('isolates request-scoped execution backends from the local runner', async () => {
    const backend = {
      run: vi.fn().mockResolvedValue({ stdout: 'remote', stderr: '', exitCode: 0 }),
      runBuffer: vi.fn().mockResolvedValue({ stdout: Buffer.from([0, 255]), stderr: '', exitCode: 0 }),
    };

    await expect(withGitExecutionBackend(backend, () => runGit(['status'], { cwd: '/remote/repo' })))
      .resolves.toMatchObject({ stdout: 'remote' });
    await expect(withGitExecutionBackend(backend, () => runGitBuffer(['cat-file', 'blob', 'abc'], { cwd: '/remote/repo' })))
      .resolves.toMatchObject({ stdout: Buffer.from([0, 255]) });

    expect(backend.run).toHaveBeenCalledWith(['status'], { cwd: '/remote/repo' });
    expect(backend.runBuffer).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });
});
