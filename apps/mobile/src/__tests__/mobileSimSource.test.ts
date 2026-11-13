import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import {
  gitSourceIdentity,
  isDedicatedMetroProcessGroup,
  isInside,
  inspectMetroListeners,
  parseWindowsNetstatListener,
  terminateMetro,
} from '../../scripts/sim-metro.mjs';

// Regression 2026-10-29: whoami ran six slow lsof processes and treated timeout
// as no Metro. Unit fixtures exercise the real discovery/parser without sockets.
describe('mobile simulator listener discovery', () => {
  it('reads all requested ports from one socket snapshot, including IPv6', () => {
    const run = vi.fn(() => 'p101\nf12\nn127.0.0.1:8081\nf13\nn[::1]:8082\np202\nf14\nn*:8084\nn*:9090\n');
    expect(inspectMetroListeners([8081, 8082, 8083, 8084], { platform: 'darwin', run }))
      .toEqual({ healthy: true, code: 'ready', pids: { 8081: '101', 8082: '101', 8084: '202' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses the same snapshot contract on Windows', () => {
    const run = () => 'TCP 0.0.0.0:8081 0.0.0.0:0 LISTENING 42\nTCP 127.0.0.1:8082 0.0.0.0:0 ESTABLISHED 99';
    expect(inspectMetroListeners([8081, 8082], { platform: 'win32', run }))
      .toEqual({ healthy: true, code: 'ready', pids: { 8081: '42' } });
  });

  it.each([
    [{ status: 1, stderr: '', stdout: '' }, true, 'ready'],
    [{ code: 'ETIMEDOUT', stderr: 'private' }, false, 'METRO_LISTENERS_TIMEOUT'],
    [{ code: 'ENOENT' }, false, 'METRO_LISTENERS_UNAVAILABLE'],
    [{ status: 1, stderr: 'private failure' }, false, 'METRO_LISTENERS_UNAVAILABLE'],
  ])('distinguishes no listeners from failed discovery: %j', (error, healthy, code) => {
    expect(inspectMetroListeners([8081], { platform: 'darwin', run: () => { throw error; } }))
      .toEqual({ healthy, code, pids: {} });
  });
});

describe('mobile simulator source identity', () => {
  it('uses branch and commit for a clean worktree', () => {
    expect(gitSourceIdentity('/repo', {
      execFile: fakeGit({ status: '', diff: '' }),
    })).toBe('carol/feature@abc123456');
  });

  it('changes when dirty tracked content changes without a commit', () => {
    const first = gitSourceIdentity('/repo', {
      execFile: fakeGit({ status: ' M file.ts', diff: '-old\n+one' }),
    });
    const second = gitSourceIdentity('/repo', {
      execFile: fakeGit({ status: ' M file.ts', diff: '-old\n+two' }),
    });

    expect(first).toMatch(/^carol\/feature@abc123456\+[a-f0-9]{10}$/);
    expect(second).not.toBe(first);
  });

  it('changes when untracked file content changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-mobile-source-'));
    try {
      const filePath = join(root, 'new.ts');
      writeFileSync(filePath, 'one\n');
      const first = gitSourceIdentity(root, {
        execFile: fakeGit({ status: '?? new.ts\0', diff: '' }),
      });
      writeFileSync(filePath, 'two\n');
      const second = gitSourceIdentity(root, {
        execFile: fakeGit({ status: '?? new.ts\0', diff: '' }),
      });

      expect(second).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mobile simulator Metro takeover', () => {
  it.each([
    ['C:\\repo', 'C:\\repo', true],
    ['C:\\repo', 'c:\\repo\\apps\\mobile', true],
    ['C:\\repo', 'C:\\repo\\..notes', true],
    ['C:\\repo', 'D:\\repo\\apps\\mobile', false],
    ['C:\\repo', 'C:\\repo-other\\apps\\mobile', false],
    ['C:\\repo', 'C:\\repo\\..\\other\\apps\\mobile', false],
    ['C:\\repo', 'C:\\', false],
    ['\\\\server\\repo', '\\\\server\\other\\apps\\mobile', false],
    ['\\\\server\\repo', '\\\\other\\repo\\apps\\mobile', false],
    ['\\\\server\\repo', '\\\\server\\repo\\apps\\mobile', true],
  ])('checks Windows Metro worktree boundaries: %s -> %s', (root, cwd, expected) => {
    expect(isInside(root, cwd, win32)).toBe(expected);
  });

  it.each([
    ['/repo', '/repo', true],
    ['/repo', '/repo/apps/mobile', true],
    ['/repo', '/repo/..notes', true],
    ['/repo', '/repo-other/apps/mobile', false],
    ['/repo', '/repo/../other/apps/mobile', false],
    ['/repo', '/', false],
  ])('checks POSIX Metro worktree boundaries: %s -> %s', (root, cwd, expected) => {
    expect(isInside(root, cwd, posix)).toBe(expected);
  });

  it('parses a Windows netstat listener without accepting another port', () => {
    const output = [
      '  TCP    0.0.0.0:8081    0.0.0.0:0    LISTENING    4242',
      '  TCP    0.0.0.0:8082    0.0.0.0:0    LISTENING    4343',
    ].join('\r\n');
    expect(parseWindowsNetstatListener(output, 8081)).toBe('4242');
    expect(parseWindowsNetstatListener(output, 8083)).toBeNull();
  });

  it('recognizes only dedicated Metro process groups', () => {
    expect(isDedicatedMetroProcessGroup([
      'pnpm mobile:sim:start',
      'node expo start --dev-client --port 8081',
    ])).toBe(true);
    expect(isDedicatedMetroProcessGroup([
      'pnpm mobile:sim:start',
      'Cindy.app/Contents/MacOS/Cindy Helper',
    ])).toBe(false);
    expect(isDedicatedMetroProcessGroup([
      'pnpm test',
      'node expo start --dev-client --port 8081',
    ])).toBe(false);
  });

  it('requires every process group member to stay in the Metro worktree', () => {
    expect(isDedicatedMetroProcessGroup([
      { command: 'pnpm mobile:sim:start', cwd: '/repo' },
      { command: 'node expo start --dev-client --port 8081', cwd: '/repo/apps/mobile' },
    ], '/repo')).toBe(true);
    expect(isDedicatedMetroProcessGroup([
      { command: 'pnpm mobile:sim:start', cwd: '/repo' },
      { command: 'node expo start --dev-client --port 8081', cwd: '/other/apps/mobile' },
    ], '/repo')).toBe(false);
  });

  it('signals the Metro process group and waits for the listener to exit', async () => {
    const run = vi.fn();
    let alive = true;
    const stopped = await terminateMetro(123, {
      platform: 'darwin',
      execFile: run,
      groupId: '456',
      currentGroupId: '789',
      groupEntries: [
        'pnpm mobile:sim:start',
        'node expo start --dev-client --port 8081',
      ],
      isAlive: () => alive,
      wait: async () => { alive = false; },
      timeoutMs: 100,
      pollMs: 10,
    });

    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledWith('kill', ['-TERM', '-456']);
  });

  it('uses taskkill tree termination for a confirmed Windows launcher', async () => {
    const run = vi.fn();
    let alive = true;
    const stopped = await terminateMetro(123, {
      platform: 'win32',
      execFile: run,
      isAlive: () => alive,
      wait: async () => { alive = false; },
      timeoutMs: 100,
      pollMs: 10,
    });

    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '123', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
  });

  it('falls back to the listener PID when the group is unavailable', async () => {
    const run = vi.fn();
    const stopped = await terminateMetro(123, {
      platform: 'darwin',
      execFile: run,
      groupId: null,
      currentGroupId: '789',
      isAlive: () => false,
    });

    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledWith('kill', ['-TERM', '123']);
  });

  it('falls back to the listener PID when the current process group is unknown', async () => {
    const run = vi.fn();
    const stopped = await terminateMetro(123, {
      platform: 'darwin',
      execFile: run,
      groupId: '456',
      currentGroupId: null,
      groupEntries: ['pnpm mobile:sim:start'],
      isAlive: () => false,
    });

    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledWith('kill', ['-TERM', '123']);
  });

  it('falls back to the listener PID for a process group with unrelated members', async () => {
    const run = vi.fn();
    const stopped = await terminateMetro(123, {
      platform: 'darwin',
      execFile: run,
      groupId: '456',
      currentGroupId: '789',
      groupEntries: ['pnpm mobile:sim:start', 'Cindy.app/Contents/MacOS/Cindy Helper'],
      isAlive: () => false,
    });

    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledWith('kill', ['-TERM', '123']);
  });

  it('returns success when the listener exits before kill', async () => {
    const run = vi.fn(() => { throw new Error('ESRCH'); });
    const stopped = await terminateMetro(123, {
      platform: 'darwin',
      execFile: run,
      groupId: null,
      isAlive: () => false,
    });

    expect(stopped).toBe(true);
  });

  it('rejects invalid polling intervals', async () => {
    await expect(terminateMetro(123, { pollMs: 0 })).rejects.toThrow(/轮询间隔/);
  });

  it('times out instead of claiming a process was stopped', async () => {
    const stopped = await terminateMetro(123, {
      platform: 'darwin',
      execFile: vi.fn(),
      groupId: null,
      isAlive: () => true,
      wait: async () => {},
      timeoutMs: 20,
      pollMs: 10,
    });

    expect(stopped).toBe(false);
  });
});

function fakeGit({ status, diff }: { status: string; diff: string }) {
  return (_command: string, args: string[]) => {
    if (args[0] === 'branch') return 'carol/feature\n';
    if (args[0] === 'rev-parse') return 'abc123456\n';
    if (args[0] === 'status') return status;
    if (args[0] === 'diff') return diff;
    throw new Error(`Unexpected git args: ${args.join(' ')}`);
  };
}
