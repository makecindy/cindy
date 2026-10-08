import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { DwsCommandError, DWS_NOT_INSTALLED } from '@cindy/im';

import { createDwsRunner, dwsBinaryCandidates, findDwsBinary } from '../dwsRunner';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

describe('dws binary lookup', () => {
  it('prefers the official installer location on Windows and only resolves .exe', () => {
    const candidates = dwsBinaryCandidates(
      { PATH: 'C:\\Tools;relative\\dir', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      'win32',
      'C:\\Users\\u',
    );
    expect(candidates[0]).toBe('C:\\Users\\u\\.local\\bin\\dws.exe');
    expect(candidates).toContain('C:\\Tools\\dws.exe');
    expect(candidates).toContain(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\dingtalk-workspace-cli\\vendor\\dws.exe',
    );
    expect(candidates.every((candidate) => candidate.endsWith('dws.exe'))).toBe(true);
    // 相对 PATH 项不参与解析，避免在任务目录里误命中同名程序。
    expect(candidates.some((candidate) => candidate.startsWith('relative'))).toBe(false);
  });

  it('honours DWS_INSTALL_DIR first', () => {
    const candidates = dwsBinaryCandidates(
      { PATH: '/usr/bin', DWS_INSTALL_DIR: '/opt/dws' },
      'darwin',
      '/Users/u',
    );
    expect(candidates[0]).toBe('/opt/dws/dws');
    expect(candidates).toContain('/usr/bin/dws');
  });

  it('returns the first executable candidate or null', () => {
    const found = findDwsBinary({
      env: { PATH: '/a:/b' },
      platform: 'linux',
      home: '/home/u',
      isExecutableFile: (candidate) => candidate === '/b/dws',
    });
    expect(found).toBe('/b/dws');
    expect(
      findDwsBinary({ env: {}, platform: 'linux', home: '/home/u', isExecutableFile: () => false }),
    ).toBeNull();
  });
});

describe('createDwsRunner', () => {
  it('rejects with DWS_NOT_INSTALLED when no binary is found', async () => {
    const runner = createDwsRunner({
      resolveBinary: () => null,
      spawnProcess: vi.fn(),
      killTree: vi.fn(),
    });
    await expect(runner.isAvailable()).resolves.toBe(false);
    await expect(runner.runJson(['auth', 'status'])).rejects.toThrow(DWS_NOT_INSTALLED);
  });

  it('passes argv without a shell and parses JSON output', async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const runner = createDwsRunner({
      resolveBinary: () => '/bin/dws',
      spawnProcess,
      killTree: vi.fn(),
    });
    const pending = runner.runJson(['chat', '+messages-send', '--text', 'a & b | c'], {
      cwd: '/work',
    });
    child.stdout.end('{"success":true}');
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ success: true });
    expect(spawnProcess).toHaveBeenCalledWith(
      '/bin/dws',
      ['chat', '+messages-send', '--text', 'a & b | c'],
      { cwd: '/work' },
    );
  });

  it('surfaces dws error objects as DwsCommandError', async () => {
    const child = fakeChild();
    const runner = createDwsRunner({
      resolveBinary: () => '/bin/dws',
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: vi.fn(),
    });
    const pending = runner.runJson(['dingtalk-tag', 'manage', 'list']);
    child.stdout.end(
      JSON.stringify({
        error: { server_error_code: 'DIGITAL_EMPLOYEE_NOT_ENABLED', message: 'not enabled' },
      }),
    );
    child.emit('close', 1);
    await expect(pending).rejects.toBeInstanceOf(DwsCommandError);
    await expect(pending).rejects.toMatchObject({ code: 'DIGITAL_EMPLOYEE_NOT_ENABLED' });
  });

  it('kills the process tree on timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const killTree = vi.fn();
    const runner = createDwsRunner({
      resolveBinary: () => '/bin/dws',
      spawnProcess: () => child as unknown as ChildProcess,
      killTree,
    });
    const pending = runner.runJson(['auth', 'status'], { timeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(killTree).toHaveBeenCalledWith(child);
    vi.useRealTimers();
  });

  it('exposes a stream whose graceful stop closes stdin', () => {
    const child = fakeChild();
    const killTree = vi.fn();
    const runner = createDwsRunner({
      resolveBinary: () => '/bin/dws',
      spawnProcess: () => child as unknown as ChildProcess,
      killTree,
    });
    const stream = runner.spawnStream(['event', 'consume']);
    const onExit = vi.fn();
    stream.onExit(onExit);
    const stdinEnded = vi.fn();
    child.stdin.on('finish', stdinEnded);
    stream.closeStdin();
    child.emit('exit', 0);
    expect(onExit).toHaveBeenCalledWith(0);
    stream.forceKill();
    expect(killTree).toHaveBeenCalledWith(child);
  });
});
