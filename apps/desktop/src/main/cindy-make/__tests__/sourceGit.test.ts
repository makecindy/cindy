import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSourceGitProgress, runSourceGit } from '../sourceGit.js';
import type { MakeSourceGitProgress } from '../../../shared/cindyMakeDoctor.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const workingDirectory = path.resolve('source-checkout');
const environment = { PATH: path.resolve('managed-tools') };

function mockGitProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

describe('Cindy Make Git progress', () => {
  it('parses Git progress without exposing the raw line', () => {
    expect(parseSourceGitProgress('remote: Receiving objects:  42% (123/456)')).toEqual({
      stage: 'receiving',
      percent: 42,
    });
    expect(parseSourceGitProgress('Resolving deltas: 100% (9/9)')).toEqual({
      stage: 'resolving',
      percent: 100,
    });
  });

  it('ignores ordinary output and invalid percentages', () => {
    expect(parseSourceGitProgress('remote: Total 9 (delta 1)')).toBeUndefined();
    expect(parseSourceGitProgress('Receiving objects: 101%')).toBeUndefined();
  });

  it('does not kill Git when stdout exceeds the capture limit', async () => {
    const child = mockGitProcess();
    const signal = new AbortController().signal;
    const result = runSourceGit(environment, ['status'], workingDirectory, signal);
    expect(spawn).toHaveBeenCalledExactlyOnceWith('git', ['status'], {
      cwd: workingDirectory,
      env: { ...environment, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    child.stdout.write('x'.repeat(35_000));
    child.stdout.write('x'.repeat(35_000));
    child.emit('close', 0, null);

    await expect(result).resolves.toBe('x'.repeat(64 * 1024));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retains stderr details when Git fails', async () => {
    const child = mockGitProcess();
    const result = runSourceGit(
      environment,
      ['status'],
      workingDirectory,
      new AbortController().signal,
    );
    child.stderr.write('fatal: test failure\n');
    child.emit('close', 1, null);

    await expect(result).rejects.toMatchObject({
      code: 'gitFailed',
      operation: 'status',
      exitCode: 1,
      exitSignal: null,
      stderr: 'fatal: test failure',
    });
  });

  it('retains a sanitized latest Git progress line for activity feedback', async () => {
    const child = mockGitProcess();
    const progress: MakeSourceGitProgress[] = [];
    const result = runSourceGit(
      environment,
      ['status'],
      workingDirectory,
      new AbortController().signal,
      (value) => progress.push(value),
    );
    child.stderr.write(Buffer.from('remote: Receiv'));
    child.stderr.write(
      Buffer.from('ing objects:  42% (123/456) https://secret.example/x\x1b[0m\r'),
    );
    child.stderr.write('Receiving objects: 100% (456/456)\n');
    child.emit('close', 0, null);

    await expect(result).resolves.toBe('');
    expect(progress).toEqual([
      {
        stage: 'receiving',
        percent: 42,
        message: 'remote: Receiving objects:  42% (123/456) [REDACTED_URL]',
      },
      { stage: 'receiving', percent: 100, message: 'Receiving objects: 100% (456/456)' },
    ]);
  });

  it('bounds stderr to its latest diagnostics and redacts URLs and credentials', async () => {
    const child = mockGitProcess();
    const result = runSourceGit(
      environment,
      ['fetch'],
      workingDirectory,
      new AbortController().signal,
    ).catch((error) => error);
    child.stderr.write('old diagnostic\n' + 'x'.repeat(20_000));
    child.stderr.write('\nfatal: token=abcdefghijklmnop https://secret.example/repository\n');
    child.emit('close', 128, null);

    const failure = await result;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'gitFailed', operation: 'fetch', exitCode: 128 });
    expect(failure.stderr).toMatch(/^\[stderr truncated\] /);
    expect(failure.stderr.length).toBeLessThanOrEqual(16 * 1024 + '[stderr truncated] '.length);
    expect(failure.stderr).toContain('fatal: token=[REDACTED] [REDACTED_URL]');
    expect(failure.stderr).not.toMatch(/old diagnostic|abcdefghijklmnop|secret\.example/);
  });

  it('waits for process close after cancellation before rejecting', async () => {
    const child = mockGitProcess();
    const controller = new AbortController();
    const result = runSourceGit(environment, ['fetch'], workingDirectory, controller.signal);
    const settled = vi.fn();
    void result.then(settled, settled);
    controller.abort();
    child.emit('error', Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    child.stderr.write('fatal: cancelled\n');
    child.emit('close', null, 'SIGTERM');

    await expect(result).rejects.toMatchObject({
      code: 'cancelled',
      operation: 'fetch',
      spawnCode: 'ABORT_ERR',
      exitCode: null,
      exitSignal: 'SIGTERM',
      stderr: 'fatal: cancelled',
    });
  });

  it('does not spawn Git for an already cancelled operation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runSourceGit(environment, ['fetch'], workingDirectory, controller.signal),
    ).rejects.toBe(controller.signal.reason);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports spawn failures after process close', async () => {
    const child = mockGitProcess();
    const result = runSourceGit(
      environment,
      ['status'],
      workingDirectory,
      new AbortController().signal,
    );
    child.emit('error', Object.assign(new Error('Git unavailable'), { code: 'ENOENT' }));
    child.emit('close', null, null);

    await expect(result).rejects.toMatchObject({
      code: 'gitFailed',
      operation: 'status',
      spawnCode: 'ENOENT',
      exitCode: null,
    });
  });
});
