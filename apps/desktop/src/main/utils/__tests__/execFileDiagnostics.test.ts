import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    ...logger,
    trace: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import { execFileWithDiagnostics, type DiagnosticExecFile } from '../execFileDiagnostics.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('execFileWithDiagnostics', () => {
  it('does not log successful calls or expose argv and output', async () => {
    const child = new FakeChild();
    const run: DiagnosticExecFile = vi.fn((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, 'private-output', 'private-error'));
      return child as unknown as ChildProcess;
    });

    await expect(
      execFileWithDiagnostics({
        source: 'worktree.git.process-table',
        file: 'private-binary-path',
        args: ['private-argument'],
        options: { timeout: 100 },
        execFileImpl: run,
      }),
    ).resolves.toEqual({ stdout: 'private-output', stderr: 'private-error' });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('turns a stdout ENOTCONN event into a contained rejection', async () => {
    const child = new FakeChild();
    const run: DiagnosticExecFile = vi.fn(() => child as unknown as ChildProcess);
    const result = execFileWithDiagnostics({
      source: 'worktree.git',
      file: 'reg',
      args: [],
      options: { timeout: 100 },
      execFileImpl: run,
    });
    const error = Object.assign(new Error('read ENOTCONN'), {
      code: 'ENOTCONN',
      syscall: 'read',
    });

    child.stdout.emit('error', error);

    await expect(result).rejects.toMatchObject({ code: 'ENOTCONN', syscall: 'read' });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'execFile call failed',
      expect.objectContaining({
        source: 'worktree.git',
        code: 'ENOTCONN',
        syscall: 'read',
      }),
    );
  });

  it('contains synchronous spawn failures', async () => {
    const privatePath = 'C:\\Users\\private-user\\pi.exe';
    const error = Object.assign(new Error('spawn failed'), {
      code: 'ENOENT',
      syscall: `spawn ${privatePath}`,
    });
    const run: DiagnosticExecFile = vi.fn(() => {
      throw error;
    });

    await expect(
      execFileWithDiagnostics({
        source: 'worktree.git',
        file: 'powershell',
        args: [],
        options: { timeout: 100 },
        execFileImpl: run,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logger.warn).toHaveBeenCalledWith(
      'execFile call failed',
      expect.objectContaining({ code: 'ENOENT', syscall: 'spawn' }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(privatePath);
  });
});
