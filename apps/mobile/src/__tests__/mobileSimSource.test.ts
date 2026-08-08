import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitSourceIdentity,
  isDedicatedMetroProcessGroup,
  terminateMetro,
} from '../../scripts/sim-metro.mjs';

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
  it('recognizes only dedicated Metro process groups', () => {
    expect(isDedicatedMetroProcessGroup([
      'pnpm mobile:sim:start',
      'node expo start --dev-client --port 8081',
    ])).toBe(true);
    expect(isDedicatedMetroProcessGroup([
      'pnpm mobile:sim:start',
      'Cindy.app/Contents/MacOS/Cindy Helper',
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

  it('falls back to the listener PID when the group is unavailable', async () => {
    const run = vi.fn();
    const stopped = await terminateMetro(123, {
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
