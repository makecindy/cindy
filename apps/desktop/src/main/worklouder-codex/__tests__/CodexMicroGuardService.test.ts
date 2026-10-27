import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { CodexMicroGuardService } from '../CodexMicroGuardService.js';
import { CodexMicroGuardStore } from '../codexMicroGuardCore.js';
import { createCodexMicroGuardIpc } from '../codexMicroGuardIpc.js';
import { GuardEnvironmentRunner, seedLegacyGuard } from './guardRecoveryFixture';

const roots: string[] = [];
const services: CodexMicroGuardService[] = [];
const PAUSED = { supported: true, enabled: false, status: 'paused', restartRequired: false };

function fixture(legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-guard-service-'));
  roots.push(root);
  const supportPath = path.join(root, 'CindyCodexMicroGuard', 'aaaaaaaaaaaa');
  const store = new CodexMicroGuardStore(supportPath);
  const runner = new GuardEnvironmentRunner(legacy ? seedLegacyGuard(store) : null);
  const environment = { NODE_OPTIONS: runner.nodeOptions ?? '' };
  const make = (overrides: ConstructorParameters<typeof CodexMicroGuardService>[0] = {}) => {
    const service = new CodexMicroGuardService({
      platform: 'darwin',
      supportPath,
      launchctlDomain: 'gui/501',
      runner,
      environment,
      ...overrides,
    });
    services.push(service);
    return service;
  };
  return { root, supportPath, store, runner, environment, make };
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CodexMicroGuardService suspension', () => {
  it('starts paused without installing a hook, setting NODE_OPTIONS or scheduling a heartbeat', async () => {
    const f = fixture();
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      expect(await f.make().getState()).toEqual(PAUSED);
      expect(f.runner.commands).toEqual([['print', 'gui/501']]);
      expect(fs.existsSync(f.store.hookPath)).toBe(false);
      expect(interval).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
    }
  });

  it.each(['{"enabled":true}', '{"enabled":false}', 'broken'])(
    'retires previous protection regardless of legacy preference %s and preserves that file',
    async (preference) => {
      const f = fixture(true);
      const settingsPath = path.join(f.root, 'codex-micro-guard.json');
      fs.writeFileSync(settingsPath, preference);
      const service = f.make();
      expect(await service.getState()).toEqual(PAUSED);
      expect(f.runner.nodeOptions).toBeNull();
      expect(f.environment.NODE_OPTIONS).toBeUndefined();
      expect(f.store.isFresh()).toBe(false);
      expect(fs.existsSync(f.store.hookPath)).toBe(true);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(preference);
      await service.dispose();
      expect(await f.make().getState()).toEqual(PAUSED);
      expect(f.runner.commands.filter(([command]) => command === 'setenv')).toEqual([]);
    },
  );

  it('cannot reactivate through old IPC enable requests, rapid toggles or subsequent startup', async () => {
    const f = fixture();
    const service = f.make();
    const assertTrustedSender = vi.fn();
    const ipc = createCodexMicroGuardIpc({
      assertTrustedSender,
      getState: () => service.getState(),
      setEnabled: (enabled) => service.setEnabled(enabled),
      recover: () => service.recover(),
    });
    const results = await Promise.all([
      ipc.setEnabled({}, true),
      ipc.setEnabled({}, false),
      ipc.setEnabled({}, true),
    ]);
    expect(results).toEqual([PAUSED, PAUSED, PAUSED]);
    expect(assertTrustedSender).toHaveBeenCalledTimes(3);
    await service.dispose();
    expect(await f.make().getState()).toEqual(PAUSED);
    expect(f.runner.commands.every(([command]) => command === 'print')).toBe(true);
    expect(fs.existsSync(f.store.hookPath)).toBe(false);
  });

  it('exposes failed restoration and broadcasts the paused state after a manual retry', async () => {
    const f = fixture(true);
    f.runner.failNextMutation = true;
    const service = f.make();
    const listener = vi.fn();
    service.subscribe(listener);
    expect(await service.getState()).toMatchObject({ enabled: false, status: 'recovery-required' });
    expect(f.store.readState()).not.toBeNull();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'recovery-required' }),
    );
    expect(await service.recover()).toEqual(PAUSED);
    expect(listener).toHaveBeenLastCalledWith(PAUSED);
    expect(f.runner.nodeOptions).toBeNull();
  });

  it('keeps failed recovery visible through IPC instead of treating the request as completed', async () => {
    const f = fixture(true);
    f.runner.ignoreMutations = true;
    const service = f.make();
    const ipc = createCodexMicroGuardIpc({
      assertTrustedSender: () => undefined,
      getState: () => service.getState(),
      setEnabled: (enabled) => service.setEnabled(enabled),
      recover: () => service.recover(),
    });
    expect(await ipc.get({})).toMatchObject({ status: 'recovery-required' });
    await expect(ipc.recover({})).rejects.toThrow('INTERNAL');
    expect(await service.getState()).toMatchObject({ status: 'recovery-required' });
    f.runner.ignoreMutations = false;
  });

  it('retries failed recovery on normal exit and on a later launch', async () => {
    const f = fixture(true);
    f.runner.ignoreMutations = true;
    const first = f.make();
    expect(await first.getState()).toMatchObject({ status: 'recovery-required' });
    await first.dispose();
    expect(f.runner.commands.filter(([command]) => command === 'unsetenv')).toHaveLength(2);
    f.runner.ignoreMutations = false;
    expect(await f.make().getState()).toEqual(PAUSED);
    expect(f.runner.nodeOptions).toBeNull();
  });

  it.each(['current', 'previous'] as const)(
    'rechecks late injection from the %s profile on normal exit after successful startup cleanup',
    async (profile) => {
      const testFixture = fixture(true);
      const service = testFixture.make();
      expect(await service.getState()).toEqual(PAUSED);
      expect(testFixture.runner.nodeOptions).toBeNull();
      const legacyStore =
        profile === 'current'
          ? testFixture.store
          : new CodexMicroGuardStore(
              path.join(path.dirname(testFixture.supportPath), 'bbbbbbbbbbbb'),
            );
      const externalOptions = '--trace-warnings --require=unrelated-preload.cjs';
      const token = seedLegacyGuard(legacyStore, externalOptions);
      testFixture.runner.nodeOptions = `${externalOptions} ${token}`;
      expect(await service.getState()).toEqual(PAUSED);

      await service.dispose();

      expect(testFixture.runner.nodeOptions).toBe(externalOptions);
      expect(legacyStore.isFresh()).toBe(false);
      expect(legacyStore.readState()).toBeNull();
      expect(fs.existsSync(legacyStore.hookPath)).toBe(true);
      const commandCount = testFixture.runner.commands.length;
      await service.dispose();
      expect(testFixture.runner.commands).toHaveLength(commandCount);
    },
  );

  it('preserves failed late-injection recovery for the next startup without blocking exit', async () => {
    const testFixture = fixture(true);
    const service = testFixture.make();
    expect(await service.getState()).toEqual(PAUSED);
    const token = seedLegacyGuard(testFixture.store);
    testFixture.runner.nodeOptions = token;
    testFixture.runner.failNextMutation = true;

    await expect(service.dispose()).resolves.toBeUndefined();

    expect(testFixture.runner.nodeOptions).toBe(token);
    expect(testFixture.store.readState()).not.toBeNull();
    expect(await service.getState()).toMatchObject({ status: 'recovery-required' });
    expect(await testFixture.make().getState()).toEqual(PAUSED);
    expect(testFixture.runner.nodeOptions).toBeNull();
    expect(testFixture.store.readState()).toBeNull();
  });

  it('cleans old profiles on an upgrade with no current-profile recovery state', async () => {
    const f = fixture();
    const previous = new CodexMicroGuardStore(
      path.join(path.dirname(f.supportPath), 'bbbbbbbbbbbb'),
    );
    f.runner.nodeOptions = seedLegacyGuard(previous);
    expect(await f.make().getState()).toEqual(PAUSED);
    expect(f.runner.nodeOptions).toBeNull();
    expect(previous.isFresh()).toBe(false);
    expect(previous.readState()).toBeNull();
  });

  it('allows multiple new instances to start and exit without reinstalling any preload', async () => {
    const f = fixture(true);
    const first = f.make();
    const second = f.make();
    expect(await Promise.all([first.getState(), second.getState()])).toEqual([PAUSED, PAUSED]);
    await first.dispose();
    expect(await second.getState()).toEqual(PAUSED);
    expect(f.runner.nodeOptions).toBeNull();
    expect(f.runner.commands.filter(([command]) => command === 'unsetenv')).toHaveLength(1);
  });

  it.each(['win32', 'linux'] as const)(
    'leaves the environment and filesystem alone on %s',
    async (platform) => {
      const f = fixture();
      f.runner.nodeOptions = '--trace-warnings';
      f.environment.NODE_OPTIONS = '--require=' + f.store.hookPath;
      const service = f.make({ platform });
      expect(await service.getState()).toEqual({
        supported: false,
        enabled: false,
        status: 'unsupported',
      });
      expect(await service.setEnabled(true)).toMatchObject({ status: 'unsupported' });
      await service.dispose();
      expect(f.runner.commands).toEqual([]);
      expect(f.environment.NODE_OPTIONS).toBe('--require=' + f.store.hookPath);
      expect(fs.existsSync(path.dirname(f.supportPath))).toBe(false);
    },
  );
});
