import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StableOwnerPostCommitCoordinator,
  StableOwnerPostCommitStep,
} from '../stableOwnerPostCommit';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded owner background steps', () => {
  it('times out without releasing a pending writer, then permits recovery after settlement', async () => {
    vi.useFakeTimers();
    const work = deferred<'completed'>();
    const task = vi.fn(() => work.promise);
    const warn = vi.fn();
    const step = new StableOwnerPostCommitStep({ name: 'market', timeoutMs: 100, warn });
    const first = step.run('owner:1', task);
    expect(step.run('owner:1', task)).toBe(first);
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBe('failed');
    await expect(step.run('owner:1', task)).resolves.toBe('failed');
    await expect(step.run('owner:2', task)).resolves.toBe('deferred');
    expect(task).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    work.resolve('completed');
    await vi.advanceTimersByTimeAsync(0);
    const recovered = vi.fn(async () => 'completed' as const);
    await expect(step.run('owner:2', recovered)).resolves.toBe('completed');
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['throw', 'reject', 'late-reject'] as const)(
    'observes %s and remains retryable',
    async (mode) => {
      vi.useFakeTimers();
      const work = deferred<'completed'>();
      const warn = vi.fn();
      const step = new StableOwnerPostCommitStep({ name: 'oauth', timeoutMs: 100, warn });
      const pending = step.run('owner:1', () => {
        if (mode === 'throw') throw new Error('failed');
        return work.promise;
      });
      if (mode === 'late-reject') await vi.advanceTimersByTimeAsync(100);
      if (mode !== 'throw') work.reject(new Error('failed'));
      await expect(pending).resolves.toBe('failed');
      await vi.advanceTimersByTimeAsync(0);
      await expect(step.run('owner:1', async () => 'completed')).resolves.toBe('completed');
      expect(warn).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

// Exercise the actual bootstrap pipeline and its timer/wakeup market entrypoint,
// not a second copy of the orchestration used only by tests.
function pipeline() {
  const source = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
  const setup = source.slice(
    source.indexOf('const ownerBackgroundLog ='),
    source.indexOf('// ── Custom protocol registration'),
  );
  const sync = source.slice(
    source.indexOf('function syncPluginMarketForActiveOwner('),
    source.indexOf('function parseOptionalDeviceLinkDeviceId('),
  );
  const scheduleState = source.slice(
    source.indexOf('let disposeSkillhubAutoSyncAuthListener:'),
    source.indexOf('let startupDatabaseSizeWarningStatus:'),
  );
  let scope = 'cloud:first:1';
  let owner: string | null = 'first';
  const market = deferred<'completed'>();
  const builtin = vi.fn(async () => 'completed' as const);
  const syncMarket = vi.fn(() => market.promise);
  const foreground = vi.fn(async () => 'completed' as const);
  const oauth = vi.fn(async () => true);
  const refreshUsage = vi.fn(async () => undefined);
  const warn = vi.fn();
  const coordinator = new StableOwnerPostCommitCoordinator({
    snapshot: () => ({ scopeKey: scope, dataOwnerId: owner, stable: true }),
    warn,
  });
  const deps = {
    StableOwnerPostCommitStep,
    createLogger: () => ({ warn }),
    authManager: {
      setStableOwnerPostCommitTask: (task: Parameters<typeof coordinator.setTask>[0]) =>
        coordinator.setTask(task),
    },
    isAppSessionBoundaryPending: () => false,
    activeOwnerScopeKey: () => scope,
    getActiveAppSession: () => ({ dataOwnerId: owner }),
    runStableOwnerPostCommitTask: builtin,
    syncDefaultMarketPlugins: syncMarket,
    refreshForegroundMarketPlugins: foreground,
    refreshPluginUsageBindings: refreshUsage,
    reconcileGhostOauthAccountsForActiveOwner: oauth,
  };
  const compiled = transpileModule(
    `
    ${setup}
    ${scheduleState}
    ${sync}
    return { syncPluginMarketForActiveOwner };
  `,
    { compilerOptions: { target: ScriptTarget.ES2022 } },
  ).outputText;
  const entry = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return {
    ...entry,
    coordinator,
    market,
    syncMarket,
    foreground,
    builtin,
    oauth,
    refreshUsage,
    warn,
    switchOwner: (next: string | null) => {
      owner = next;
      scope = `scope:${next}:2`;
    },
  };
}

describe('production background pipeline', () => {
  // PR #6667: foreground metadata checks must not reset the full-maintenance
  // clock or take its writer slot. Fake time verifies the real bootstrap entry
  // without waiting or introducing any plugin/disk work on focus.
  it('keeps periodic maintenance due during continuous foreground checks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const run = pipeline();
    run.market.resolve('completed');
    run.syncPluginMarketForActiveOwner(0, 'periodic');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      run.syncPluginMarketForActiveOwner(30_000, 'foreground');
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(run.foreground).toHaveBeenCalledTimes(6);
    expect(run.syncMarket).toHaveBeenCalledTimes(1);
    run.syncPluginMarketForActiveOwner(30 * 60_000, 'periodic');
    await vi.advanceTimersByTimeAsync(0);
    expect(run.syncMarket).toHaveBeenCalledTimes(2);
    expect(run.syncMarket).toHaveBeenLastCalledWith('periodic');
  });

  it.each(['resume', 'periodic'] as const)('does not let a pending foreground check suppress %s maintenance', async (trigger) => {
    vi.useFakeTimers();
    const run = pipeline();
    const foreground = deferred<'completed'>();
    run.foreground.mockImplementation(() => foreground.promise);
    run.syncPluginMarketForActiveOwner(30_000, 'foreground');
    await vi.advanceTimersByTimeAsync(0);
    run.syncPluginMarketForActiveOwner(30_000, trigger);
    run.syncPluginMarketForActiveOwner(30_000, trigger);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.syncMarket).toHaveBeenCalledExactlyOnceWith(trigger);
    expect(run.foreground).toHaveBeenCalledOnce();
    foreground.resolve('completed');
    run.market.resolve('completed');
    await vi.advanceTimersByTimeAsync(0);
    run.syncPluginMarketForActiveOwner(30_000, trigger);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.syncMarket).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues OAuth after market timeout and shares its pending writer with wakeup/periodic retries', async () => {
    vi.useFakeTimers();
    const run = pipeline();
    const result = run.coordinator.ensure('startup');
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(result).resolves.toBe('failed');
    expect(run.refreshUsage).toHaveBeenCalledTimes(1);
    expect(run.oauth).toHaveBeenCalledTimes(1);
    run.syncPluginMarketForActiveOwner();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.syncMarket).toHaveBeenCalledTimes(1);
    expect(run.oauth).toHaveBeenCalledTimes(2);
    run.market.resolve('completed');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(run.coordinator.ensure('after-recovery')).resolves.toBe('completed');
    expect(run.syncMarket).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not run a later stage under a replaced owner', async () => {
    vi.useFakeTimers();
    const run = pipeline();
    const first = run.coordinator.ensure('first');
    await vi.advanceTimersByTimeAsync(0);
    run.switchOwner('second');
    const second = run.coordinator.ensure('second');
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(first).resolves.toBe('deferred');
    await expect(second).resolves.toBe('deferred');
    expect(run.syncMarket).toHaveBeenCalledTimes(1);
    expect(run.oauth).toHaveBeenCalledTimes(1);
    run.market.resolve('completed');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(run.coordinator.ensure('recovered')).resolves.toBe('completed');
    expect(run.syncMarket).toHaveBeenCalledTimes(2);
  });

  it('bounds builtin and OAuth stages as well, and does not run private stages signed out', async () => {
    vi.useFakeTimers();
    const run = pipeline();
    const builtin = deferred<'completed'>();
    run.builtin.mockImplementation(() => builtin.promise);
    run.oauth.mockImplementation(() => new Promise<boolean>(() => {}));
    run.market.resolve('completed');
    const result = run.coordinator.ensure('startup');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe('failed');
    expect(run.syncMarket).toHaveBeenCalledTimes(1);
    expect(run.oauth).toHaveBeenCalledTimes(1);
    builtin.resolve('completed');
    await vi.advanceTimersByTimeAsync(0);
    run.switchOwner(null);
    const usageRefreshesBeforeSignOut = run.refreshUsage.mock.calls.length;
    await expect(run.coordinator.ensure('signed-out')).resolves.toBe('completed');
    expect(usageRefreshesBeforeSignOut).toBeGreaterThan(0);
    expect(run.refreshUsage).toHaveBeenCalledTimes(usageRefreshesBeforeSignOut);
    expect(run.syncMarket).toHaveBeenCalledTimes(1);
    expect(run.oauth).toHaveBeenCalledTimes(1);
  });
});
