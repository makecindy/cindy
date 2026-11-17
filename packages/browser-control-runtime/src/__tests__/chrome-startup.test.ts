import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchOpenClawChrome } from '../_generated/extension/src/browser/chrome.js';
import { readChromeVersion, type ChromeVersion } from '../_generated/extension/src/browser/chrome.diagnostics.js';
import { resolveBrowserConfig, resolveProfile } from '../_generated/extension/src/browser/config.js';
import { ensureOutputDirectory } from '../_generated/extension/src/browser/output-directories.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(),
  execFileSync: vi.fn(() => { throw new Error('no registered default browser'); }),
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      readlinkSync: vi.fn(() => { throw new Error('no singleton lock'); }),
    },
  };
});
vi.mock('../_generated/extension/src/infra/ports.js', () => ({ ensurePortAvailable: vi.fn() }));
vi.mock('../_generated/extension/src/browser/output-directories.js', () => ({ ensureOutputDirectory: vi.fn() }));
vi.mock('../_generated/extension/src/browser/chrome.profile-decoration.js', () => ({
  isProfileDecorated: () => true,
  ensureProfileCleanExit: vi.fn(),
  decorateOpenClawProfile: vi.fn(),
}));
vi.mock('../_generated/extension/src/browser/chrome.diagnostics.js', async (original) => ({
  ...await original<typeof import('../_generated/extension/src/browser/chrome.diagnostics.js')>(),
  readChromeVersion: vi.fn(),
}));

// Issue #10962: launchOpenClawChrome must reject locally, not emit an unhandled
// ENOENT, for both bootstrap and an existing profile. Existing argv/stop tests
// never spawned Chrome. Minimal input: a child that asynchronously emits error.
// Unit tier: in-memory filesystem/processes and virtual time; no user profiles,
// actual executables, sockets or waits. Discovery itself is production Windows
// discovery, not a mocked resolver (paths use the target platform's path API).
const userChrome = path.win32.join('C:\\Users\\test\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
const systemChrome = path.win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
let executables: Set<string>;
let preferencesExist: boolean;
let plans: Array<'ready' | 'bootstrap' | 'ENOENT' | 'EACCES' | 'exit'>;

class FakeChrome extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stderr = new PassThrough();
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  });
}
let children: FakeChrome[];

function launch(executablePath?: string, profileExecutablePath?: string) {
  const resolved = resolveBrowserConfig({
    headless: true,
    executablePath,
    defaultProfile: 'Cindy',
    profiles: { Cindy: { cdpPort: 18800, color: '#00D9C5', executablePath: profileExecutablePath } },
  });
  const profile = resolveProfile(resolved, 'Cindy');
  if (!profile) throw new Error('test profile missing');
  return launchOpenClawChrome(resolved, profile);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\test\\AppData\\Local');
  vi.stubEnv('ProgramFiles', 'C:\\Program Files');
  vi.stubEnv('ProgramFiles(x86)', 'C:\\Program Files (x86)');
  executables = new Set([userChrome, systemChrome]);
  preferencesExist = true;
  plans = [];
  children = [];
  vi.mocked(fs.existsSync).mockImplementation((candidate) => {
    const file = String(candidate);
    if (file.endsWith('Local State') || file.endsWith('Preferences')) return preferencesExist;
    return executables.has(file);
  });
  vi.mocked(readChromeVersion).mockReset().mockResolvedValue({ webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/browser/test' });
  vi.mocked(ensureOutputDirectory).mockReset().mockResolvedValue(undefined);
  vi.mocked(spawn).mockReset().mockImplementation((command) => {
    const proc = new FakeChrome();
    const plan = plans.shift() ?? 'ready';
    children.push(proc);
    queueMicrotask(() => {
      if (plan === 'ENOENT' || plan === 'EACCES') {
        if (plan === 'ENOENT') executables.delete(String(command));
        proc.emit('error', Object.assign(new Error(`spawn ${command} ${plan}`), { code: plan }));
        proc.emit('close', -2, null);
      } else {
        proc.pid = 1000 + children.length;
        proc.emit('spawn');
        if (plan === 'bootstrap') preferencesExist = true;
        if (plan === 'exit') {
          proc.exitCode = 1;
          proc.emit('exit', 1, null);
          proc.emit('close', 1, null);
        }
      }
    });
    return proc as unknown as ChildProcess;
  });
});

afterEach(() => {
  for (const proc of children) {
    if (proc.pid && proc.exitCode == null && proc.signalCode == null) proc.kill('SIGTERM');
    proc.stderr.destroy();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(fs.readlinkSync).mockReset().mockImplementation(() => { throw new Error('no singleton lock'); });
});

describe('managed Chrome startup failures', () => {
  it.each([false, true])('returns bootstrap=%s ENOENT promptly and permits a later operation', async (bootstrap) => {
    preferencesExist = !bootstrap;
    executables.delete(systemChrome);
    plans = ['ENOENT'];
    const startedAt = Date.now();
    await expect(launch()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Date.now()).toBe(startedAt); // Neither preferences nor CDP timeout elapsed.
    expect(readChromeVersion).not.toHaveBeenCalled();
    expect(children[0].eventNames()).toEqual([]);
    expect(children[0].stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    executables.add(systemChrome);
    if (bootstrap) plans = ['bootstrap', 'ready'];
    const retried = await launch();
    expect(retried.exe.path).toBe(systemChrome);
    expect(retried.pid).toBeGreaterThan(0);
  });

  it.each([false, true])('rediscovers the system installation after bootstrap=%s spawn race', async (bootstrap) => {
    preferencesExist = !bootstrap;
    plans = bootstrap ? ['ENOENT', 'bootstrap', 'ready'] : ['ENOENT', 'ready'];
    const running = await launch();
    expect(running.exe.path).toBe(systemChrome);
    expect(vi.mocked(spawn).mock.calls.map(([command]) => command)).toEqual(
      bootstrap ? [userChrome, systemChrome, systemChrome] : [userChrome, systemChrome],
    );
    expect(children[0].eventNames()).toEqual([]);
    if (bootstrap) {
      expect(children[1].eventNames()).toEqual([]);
      expect(children[1].stderr.destroyed).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revalidates an automatic candidate immediately before spawning', async () => {
    vi.mocked(ensureOutputDirectory).mockImplementation(async () => { executables.delete(userChrome); });
    const running = await launch();
    expect(running.exe.path).toBe(systemChrome);
    expect(vi.mocked(spawn).mock.calls.map(([command]) => command)).toEqual([systemChrome]);
  });

  it.each(['global', 'profile'] as const)('does not override an explicit %s path after ENOENT', async (scope) => {
    plans = ['ENOENT'];
    await expect(scope === 'global' ? launch(userChrome) : launch(undefined, userChrome))
      .rejects.toMatchObject({ code: 'ENOENT', message: expect.stringContaining(userChrome) });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports a configured path removed before spawn without choosing another installation', async () => {
    vi.mocked(ensureOutputDirectory).mockImplementation(async () => { executables.delete(userChrome); });
    await expect(launch(userChrome)).rejects.toThrow(`browser.executablePath not found: ${userChrome}`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not turn a permission failure into a fallback launch', async () => {
    plans = ['EACCES'];
    await expect(launch()).rejects.toMatchObject({ code: 'EACCES' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0].eventNames()).toEqual([]);
  });

  it('bounds rediscovery when the alternative installation also disappears', async () => {
    plans = ['ENOENT', 'ENOENT'];
    await expect(launch()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children.every((proc) => proc.eventNames().length === 0)).toBe(true);
  });

  it.each([false, true])('rejects an early bootstrap=%s exit without a readiness timeout', async (bootstrap) => {
    preferencesExist = !bootstrap;
    plans = ['exit'];
    await expect(launch()).rejects.toThrow('Chrome exited before startup completed');
    expect(vi.getTimerCount()).toBe(0);
    expect(children[0].eventNames()).toEqual([]);
  });

  it('interrupts an in-flight CDP probe and clears polling resources on a process error', async () => {
    const probeStarted = Promise.withResolvers<void>();
    const probe = Promise.withResolvers<ChromeVersion>();
    vi.mocked(readChromeVersion).mockImplementation(() => { probeStarted.resolve(); return probe.promise; });
    const launching = launch();
    const failed = expect(launching).rejects.toThrow('Chrome startup failed');
    await probeStarted.promise;
    children[0].emit('error', new Error('Chrome startup failed'));
    await failed;
    probe.reject(new Error('CDP closed'));
    expect(children[0].killed).toBe(true);
    expect(children[0].stderr.destroyed).toBe(true);
    expect(children[0].eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['bootstrap', 'cdp'] as const)('cancels the %s polling timer on a startup error', async (phase) => {
    preferencesExist = phase !== 'bootstrap';
    vi.mocked(readChromeVersion).mockRejectedValue(new Error('CDP not ready'));
    const failed = expect(launch()).rejects.toThrow('startup interrupted');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    children[0].emit('error', new Error('startup interrupted'));
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    expect(children[0].stderr.destroyed).toBe(true);
    expect(children[0].eventNames()).toEqual([]);
  });

  it('preserves stale-singleton recovery when Chrome exits before CDP is ready', async () => {
    vi.mocked(fs.readlinkSync).mockReturnValue('another-host-42');
    vi.mocked(readChromeVersion).mockImplementationOnce(async () => {
      const proc = children[0];
      proc.stderr.write('profile appears to be in use by another chromium process');
      proc.exitCode = 1;
      proc.emit('exit', 1, null);
      proc.emit('close', 1, null);
      throw new Error('CDP closed');
    });
    const running = await launch();
    expect(running.pid).toBe(children[1].pid);
    expect(children[0].stderr.destroyed).toBe(true);
    expect(children[0].eventNames()).toEqual([]);
  });

  it('removes startup listeners on success but consumes later process errors until close', async () => {
    const running = await launch();
    const proc = children[0];
    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('spawn')).toBe(0);
    expect(proc.stderr.listenerCount('data')).toBe(0);
    proc.emit('error', new Error('late kill failure'));
    expect(running.pid).toBe(proc.pid);
    proc.kill('SIGTERM');
    expect(proc.eventNames()).toEqual([]);
  });
});
