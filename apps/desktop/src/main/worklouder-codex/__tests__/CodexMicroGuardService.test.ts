import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GuardCommandResult, GuardCommandRunner } from '../codexMicroGuardCore.js';
import type { CodexMicroGuardProcess } from '../codexMicroGuardProcesses.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

import { CodexMicroGuardService } from '../CodexMicroGuardService.js';

const roots: string[] = [];

class EnvironmentRunner implements GuardCommandRunner {
  nodeOptions: string | null;
  readonly commands: string[][] = [];
  failNextMutation = false;

  constructor(nodeOptions: string | null) {
    this.nodeOptions = nodeOptions;
  }

  async run(arguments_: readonly string[]): Promise<GuardCommandResult> {
    this.commands.push([...arguments_]);
    if (arguments_[0] === 'print') {
      return {
        status: 0,
        stdout: printEnvironment(this.nodeOptions),
        stderr: '',
      };
    }
    if (this.failNextMutation) {
      this.failNextMutation = false;
      return { status: 7, stdout: '', stderr: 'failed' };
    }
    if (arguments_[0] === 'setenv') this.nodeOptions = arguments_[2] ?? '';
    if (arguments_[0] === 'unsetenv') this.nodeOptions = null;
    return { status: 0, stdout: '', stderr: '' };
  }
}

function printEnvironment(nodeOptions: string | null): string {
  return `gui/501 = {\n\tenvironment = {\n\t\tPATH => /bin\n${
    nodeOptions === null ? '' : `\t\tNODE_OPTIONS =>${nodeOptions ? ` ${nodeOptions}` : ''}\n`
  }\t}\n}\n`;
}

function paths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-guard-service-'));
  roots.push(root);
  return {
    supportPath: path.join(root, 'support'),
    settingsPath: path.join(root, 'settings.json'),
  };
}

function service(
  paths_: ReturnType<typeof paths>,
  runner: GuardCommandRunner,
  listProcesses: () => Promise<CodexMicroGuardProcess[]> = async () => [],
): CodexMicroGuardService {
  return new CodexMicroGuardService({
    platform: 'darwin',
    ...paths_,
    launchctlDomain: 'gui/501',
    runner,
    listProcesses,
    hookContents: '// safe test hook\n',
    heartbeatIntervalMs: 5_000,
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CodexMicroGuardService', () => {
  const runningCodex = () => ({
    pid: 101,
    startedAt: Date.now() - 60_000,
    executable: '/Applications/Codex.app/Contents/MacOS/Codex',
  });

  it('clears the restart hint on exit or restart through the existing heartbeat', async () => {
    vi.useFakeTimers();
    let processes = [runningCodex()];
    const instance = service(paths(), new EnvironmentRunner(null), async () => processes);
    const listener = vi.fn();
    instance.subscribe(listener);
    expect(await instance.setEnabled(true)).toMatchObject({ restartRequired: true });
    processes = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'protecting', enabled: true, restartRequired: false }),
    );
    processes = [{ ...runningCodex(), startedAt: Date.now(), pid: 102 }];
    expect(await instance.getState()).toMatchObject({
      status: 'protecting',
      restartRequired: false,
    });
    await instance.dispose();
  });

  it('does not remind when Codex is absent, the launch is ambiguous, or detection fails', async () => {
    const list = vi.fn(async (): Promise<CodexMicroGuardProcess[]> => []);
    const instance = service(paths(), new EnvironmentRunner(null), list);
    expect(await instance.setEnabled(true)).toMatchObject({ restartRequired: false });
    list.mockResolvedValue([
      { ...runningCodex(), startedAt: Math.floor(Date.now() / 1000) * 1000 },
    ]);
    expect(await instance.getState()).toMatchObject({ restartRequired: false });
    list.mockRejectedValue(new Error('ps unavailable'));
    expect(await instance.getState()).toMatchObject({ enabled: true, restartRequired: false });
    await instance.dispose();
  });

  it('keeps applied protection evidence across toggles and Cindy restarts, but rejects reused PIDs', async () => {
    const locations = paths();
    const runner = new EnvironmentRunner(null);
    let processes = [runningCodex()];
    const list = async () => processes;
    const first = service(locations, runner, list);
    await first.setEnabled(true);
    const receiptPath = path.join(locations.supportPath, 'receipt-101.json');
    fs.writeFileSync(receiptPath, JSON.stringify(processes[0]), { mode: 0o600 });
    expect(await first.getState()).toMatchObject({ restartRequired: false });
    await first.setEnabled(false);
    expect(await first.setEnabled(true)).toMatchObject({ restartRequired: false });
    await first.dispose();
    const second = service(locations, runner, list);
    expect(await second.getState()).toMatchObject({ restartRequired: false });
    processes = [{ ...processes[0], startedAt: processes[0].startedAt + 10_000 }];
    expect(await second.getState()).toMatchObject({ restartRequired: true });
    fs.writeFileSync(receiptPath, '{broken');
    expect(await second.getState()).toMatchObject({ enabled: true, restartRequired: true });
    expect(await second.setEnabled(false)).toMatchObject({ restartRequired: false });
    await second.dispose();
  });

  it('reports unsupported without touching launchctl on other platforms', async () => {
    const locations = paths();
    const runner = new EnvironmentRunner('--trace-warnings');
    const instance = new CodexMicroGuardService({
      platform: 'win32',
      ...locations,
      runner,
      hookContents: '// hook\n',
    });

    expect(await instance.getState()).toEqual({
      supported: false,
      enabled: false,
      status: 'unsupported',
    });
    expect(runner.commands).toEqual([]);
    await instance.dispose();
  });

  it('persists an override, reports interception, and restores on graceful quit', async () => {
    const locations = paths();
    const runner = new EnvironmentRunner('--trace-warnings');
    const instance = service(locations, runner);

    expect(await instance.getState()).toMatchObject({ enabled: false, status: 'disabled' });
    expect(await instance.setEnabled(true)).toMatchObject({ enabled: true, status: 'protecting' });
    expect(runner.nodeOptions).toBe(
      `--trace-warnings --require=${path.join(locations.supportPath, 'guard-hook.cjs')}`,
    );
    expect(JSON.parse(fs.readFileSync(locations.settingsPath, 'utf8'))).toEqual({ enabled: true });

    fs.writeFileSync(
      path.join(locations.supportPath, 'receipt.json'),
      JSON.stringify({ interceptedAt: Date.now() / 1_000, service: 'service-fixture.js' }),
      { mode: 0o600 },
    );
    expect(await instance.getState()).toMatchObject({ status: 'intercepted' });

    await instance.dispose();
    expect(runner.nodeOptions).toBe('--trace-warnings');
    // Graceful quit restores the environment but preserves the user's setting,
    // so the next Cindy launch resumes protection.
    expect(JSON.parse(fs.readFileSync(locations.settingsPath, 'utf8'))).toEqual({ enabled: true });
  });

  it('keeps shared protection until the final live instance exits', async () => {
    const locations = paths();
    const runner = new EnvironmentRunner(null);
    const first = service(locations, runner);
    const second = service(locations, runner);
    const token = `--require=${path.join(locations.supportPath, 'guard-hook.cjs')}`;

    await first.setEnabled(true);
    expect(await second.getState()).toMatchObject({ enabled: true, status: 'protecting' });

    await first.dispose();
    expect(runner.nodeOptions).toBe(token);
    expect(fs.existsSync(path.join(locations.supportPath, 'enabled'))).toBe(true);
    expect(await second.getState()).toMatchObject({ enabled: true, status: 'protecting' });

    await second.dispose();
    expect(runner.nodeOptions).toBeNull();
    expect(fs.existsSync(path.join(locations.supportPath, 'enabled'))).toBe(false);
  });

  it('re-enables a persisted preference on startup and recover turns it off', async () => {
    const locations = paths();
    fs.writeFileSync(locations.settingsPath, JSON.stringify({ enabled: true }));
    const runner = new EnvironmentRunner(null);
    const instance = service(locations, runner);

    expect(await instance.getState()).toMatchObject({ enabled: true, status: 'protecting' });
    expect(runner.nodeOptions).toBe(
      `--require=${path.join(locations.supportPath, 'guard-hook.cjs')}`,
    );

    expect(await instance.recover()).toMatchObject({ enabled: false, status: 'disabled' });
    expect(runner.nodeOptions).toBeNull();
    expect(fs.existsSync(locations.settingsPath)).toBe(false);
    await instance.dispose();
  });

  it('serializes rapid toggles and preserves the original environment', async () => {
    const locations = paths();
    const runner = new EnvironmentRunner('--trace-warnings');
    const instance = service(locations, runner);

    const enable = instance.setEnabled(true);
    const disable = instance.setEnabled(false);
    await Promise.all([enable, disable]);

    expect(await instance.getState()).toMatchObject({ enabled: false, status: 'disabled' });
    expect(runner.nodeOptions).toBe('--trace-warnings');
    expect(fs.existsSync(locations.settingsPath)).toBe(false);
    await instance.dispose();
  });

  it('deactivates markers and exposes recovery when restoration fails', async () => {
    const locations = paths();
    const runner = new EnvironmentRunner(null);
    const instance = service(locations, runner);
    await instance.setEnabled(true);
    runner.failNextMutation = true;

    await expect(instance.setEnabled(false)).rejects.toThrow();
    expect(await instance.getState()).toMatchObject({
      enabled: false,
      status: 'recovery-required',
    });
    expect(fs.existsSync(path.join(locations.supportPath, 'enabled'))).toBe(false);
    await instance.recover();
    await instance.dispose();
  });
});
