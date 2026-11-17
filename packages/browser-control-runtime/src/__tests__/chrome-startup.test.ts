import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchOpenClawChrome } from '../_generated/extension/src/browser/chrome.js';
import { CHROME_STDERR_HINT_MAX_CHARS } from '../_generated/extension/src/browser/cdp-timeouts.js';
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
      statSync: vi.fn(),
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
// Review #10986 regressions additionally cover exit-before-stderr-end, retained
// redacted diagnostics, and the real Linux OOM-wrapper preparation path. The
// previous fake emitted all output before exit and exercised only Windows;
// delayed stream completion and a shell exit 127 are the missing unit inputs.
const userChrome = path.win32.join('C:\\Users\\test\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
const systemChrome = path.win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
let executables: Set<string>;
let preferencesExist: boolean;
type StartupPlan = 'ready' | 'bootstrap' | 'ENOENT' | 'EACCES' | 'exit' | {
  exitCode: number;
  stderr?: string;
  stderrDelayMs?: number;
  keepStderrOpen?: boolean;
  removeExecutable?: boolean;
};
let plans: StartupPlan[];
let statErrors: Map<string, string>;

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
    this.stderr.end();
    this.emit('close', null, signal);
    return true;
  });
}
let children: FakeChrome[];

function launch(executablePath?: string, profileExecutablePath?: string, headless = true) {
  const resolved = resolveBrowserConfig({
    headless,
    executablePath,
    defaultProfile: 'Cindy',
    profiles: { Cindy: { cdpPort: 18800, color: '#00D9C5', executablePath: profileExecutablePath } },
  });
  const profile = resolveProfile(resolved, 'Cindy');
  if (!profile) throw new Error('test profile missing');
  return launchOpenClawChrome(resolved, profile);
}

const linuxChrome = path.posix.join('/usr', 'bin', 'google-chrome');
const linuxAlternative = path.posix.join('/usr', 'bin', 'chromium');
function useLinux() {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  vi.stubEnv('OPENCLAW_CHILD_OOM_SCORE_ADJ', '1');
  vi.stubEnv('DISPLAY', ':99');
  executables = new Set([linuxChrome, linuxAlternative]);
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
  statErrors = new Map();
  vi.mocked(fs.statSync).mockImplementation((candidate) => {
    const file = String(candidate);
    const code = statErrors.get(file);
    if (code || (file !== '/bin/sh' && !executables.has(file))) {
      throw Object.assign(new Error(`stat ${file} ${code ?? 'ENOENT'}`), { code: code ?? 'ENOENT' });
    }
    return { isFile: () => true } as fs.Stats;
  });
  vi.mocked(fs.existsSync).mockImplementation((candidate) => {
    const file = String(candidate);
    if (file.endsWith('Local State') || file.endsWith('Preferences')) return preferencesExist;
    return executables.has(file);
  });
  vi.mocked(readChromeVersion).mockReset().mockResolvedValue({ webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/browser/test' });
  vi.mocked(ensureOutputDirectory).mockReset().mockResolvedValue(undefined);
  vi.mocked(spawn).mockReset().mockImplementation((command, args) => {
    const executable = command === '/bin/sh' ? args?.[2] : command;
    const proc = new FakeChrome();
    const plan = plans.shift() ?? 'ready';
    children.push(proc);
    queueMicrotask(() => {
      if (plan === 'ENOENT' || plan === 'EACCES') {
        if (plan === 'ENOENT') executables.delete(String(executable));
        proc.emit('error', Object.assign(new Error(`spawn ${command} ${plan}`), {
          code: plan, errno: plan === 'ENOENT' ? -2 : -13, syscall: 'spawn',
          path: executable, spawnargs: args,
        }));
        proc.emit('close', -2, null);
      } else {
        proc.pid = 1000 + children.length;
        proc.emit('spawn');
        if (plan === 'bootstrap') preferencesExist = true;
        if (plan === 'exit') {
          proc.exitCode = 1;
          proc.emit('exit', 1, null);
          proc.stderr.end();
          proc.emit('close', 1, null);
        }
        if (typeof plan === 'object') {
          if (plan.removeExecutable) executables.delete(String(executable));
          proc.exitCode = plan.exitCode;
          proc.emit('exit', plan.exitCode, null);
          const finish = () => {
            proc.stderr.end(plan.stderr);
            proc.emit('close', plan.exitCode, null);
          };
          if (!plan.keepStderrOpen) {
            if (plan.stderrDelayMs) setTimeout(finish, plan.stderrDelayMs);
            else finish();
          }
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
    await expect(launch()).rejects.toMatchObject({
      code: 'EACCES', errno: -13, syscall: 'spawn', path: userChrome,
      cause: expect.objectContaining({ code: 'EACCES', errno: -13, path: userChrome }),
    });
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
    plans = [{
      exitCode: 1,
      stderr: 'profile appears to be in use by another chromium process',
      stderrDelayMs: 20,
    }, 'ready'];
    const launching = launch();
    await vi.advanceTimersByTimeAsync(19);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const running = await launching;
    expect(running.pid).toBe(children[1].pid);
    expect(children[0].stderr.destroyed).toBe(true);
    expect(children[0].eventNames()).toEqual([]);
  });

  it('bounds a stderr pipe that stays open after process exit and releases drain listeners', async () => {
    plans = [{ exitCode: 1, keepStderrOpen: true }];
    let failure: unknown;
    const launching = launch().catch((err: unknown) => { failure = err; });
    await vi.advanceTimersByTimeAsync(249);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await launching;
    expect(failure).toMatchObject({ exitCode: 1, cause: expect.objectContaining({ exitCode: 1 }) });
    expect(children[0].stderr.destroyed).toBe(true);
    expect(children[0].stderr.listenerCount('end')).toBe(0);
    expect(children[0].stderr.listenerCount('close')).toBe(0);
    expect(children[0].stderr.listenerCount('error')).toBe(0);
    children[0].emit('close', 1, null);
    expect(children[0].eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('retains redacted, bounded library diagnostics for bootstrap=%s', async (bootstrap) => {
    useLinux();
    preferencesExist = !bootstrap;
    plans = [{
      exitCode: 1,
      stderr: `error while loading shared libraries: libmissing.so\nBearer sensitive-token-12345\n${'x'.repeat(4000)}DIAGNOSTIC_TAIL`,
      stderrDelayMs: 20,
    }];
    let captured: Error | undefined;
    const launching = launch().catch((err: Error) => { captured = err; throw err; });
    const failed = expect(launching).rejects.toMatchObject({
      exitCode: 1,
      cause: expect.objectContaining({ exitCode: 1 }),
      message: expect.stringContaining(bootstrap ? 'profile bootstrap' : 'Chrome CDP'),
    });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(captured?.message).toContain('libmissing.so');
    expect(captured?.message).toContain('port 18800 for profile "Cindy"');
    expect(captured?.message).toContain('Hint: If running in a container or as root');
    expect(captured?.message).toContain('Bearer [redacted]');
    expect(captured?.message).not.toContain('sensitive-token-12345');
    expect(captured?.message).not.toContain('DIAGNOSTIC_TAIL');
    const stderr = captured?.message.split('Chrome stderr:\n')[1];
    expect(stderr).toBeTypeOf('string');
    expect(stderr?.length).toBeLessThanOrEqual(CHROME_STDERR_HINT_MAX_CHARS);
  });

  it.each([false, true])('keeps display hints and full failure context for bootstrap=%s', async (bootstrap) => {
    useLinux();
    preferencesExist = !bootstrap;
    plans = [{ exitCode: 1, stderr: 'Missing X server or $DISPLAY', stderrDelayMs: 20 }];
    const failed = expect(launch(undefined, undefined, false)).rejects.toMatchObject({
      message: expect.stringMatching(/profile "Cindy".*[\s\S]*No DISPLAY\/X server/),
      exitCode: 1,
      cause: expect.objectContaining({ exitCode: 1 }),
    });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
  });

  it.each([false, true])('rediscovers a disappeared Linux wrapped executable for bootstrap=%s', async (bootstrap) => {
    useLinux();
    preferencesExist = !bootstrap;
    plans = [{ exitCode: 127, removeExecutable: true, stderr: 'exec: Chrome: not found', stderrDelayMs: 20 }];
    if (bootstrap) plans.push('bootstrap');
    plans.push('ready');
    const launching = launch();
    await vi.advanceTimersByTimeAsync(20);
    const running = await launching;
    expect(running.exe.path).toBe(linuxAlternative);
    expect(vi.mocked(spawn).mock.calls.map(([command]) => command)).toEqual(
      bootstrap ? ['/bin/sh', '/bin/sh', '/bin/sh'] : ['/bin/sh', '/bin/sh'],
    );
    expect(vi.mocked(spawn).mock.calls[1][1]?.[2]).toBe(linuxAlternative);
    expect(children[0].stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { exitCode: 127, removeExecutable: false, statError: undefined },
    { exitCode: 126, removeExecutable: true, statError: undefined },
    { exitCode: 1, removeExecutable: true, statError: undefined },
    { exitCode: 127, removeExecutable: true, statError: 'EACCES' },
  ])('does not infer missing Chrome from wrapped $exitCode with stat=$statError', async (input) => {
    useLinux();
    if (input.statError) statErrors.set(linuxChrome, input.statError);
    plans = [{ ...input, stderr: 'exec failed' }];
    await expect(launch()).rejects.toMatchObject({
      exitCode: input.exitCode,
      cause: expect.objectContaining({ exitCode: input.exitCode }),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['global', 'profile'] as const)('keeps explicit Linux %s preference after wrapped disappearance', async (scope) => {
    useLinux();
    plans = [{ exitCode: 127, removeExecutable: true, stderr: 'exec: Chrome: not found' }];
    await expect(scope === 'global' ? launch(linuxChrome) : launch(undefined, linuxChrome))
      .rejects.toMatchObject({ exitCode: 127 });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not interpret an unwrapped application exit 127 as a shell exec failure', async () => {
    useLinux();
    vi.stubEnv('OPENCLAW_CHILD_OOM_SCORE_ADJ', '0');
    plans = [{ exitCode: 127, removeExecutable: true, stderr: 'application failed after launch' }];
    await expect(launch()).rejects.toMatchObject({ exitCode: 127 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe(linuxChrome);
  });

  it('bounds rediscovery when the second Linux wrapped installation disappears too', async () => {
    useLinux();
    plans = [
      { exitCode: 127, removeExecutable: true, stderr: 'exec: Chrome: not found' },
      { exitCode: 127, removeExecutable: true, stderr: 'exec: Chromium: not found' },
    ];
    await expect(launch()).rejects.toMatchObject({ exitCode: 127 });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children.every((proc) => proc.stderr.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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
