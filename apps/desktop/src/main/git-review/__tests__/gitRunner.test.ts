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
