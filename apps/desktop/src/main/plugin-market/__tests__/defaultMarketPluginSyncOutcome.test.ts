import { describe, expect, it, vi } from 'vitest';
import { app } from 'electron';

import type { PluginMarketSnapshot } from '../../../shared/pluginMarket';
import { defaultMarketPluginSyncOutcome, syncDefaultMarketPlugins } from '../registerIpc';
import * as marketService from '../service';
import * as sessions from '../../appSessionState';

function snapshot(unavailableReason: string | null): PluginMarketSnapshot {
  return {
    items: [],
    unavailableReason,
    customSourceNames: [],
    unavailableCustomSourceNames: [],
  };
}

describe('defaultMarketPluginSyncOutcome', () => {
  it('completes when the official market is available or intentionally not configured', () => {
    expect(defaultMarketPluginSyncOutcome(snapshot(null))).toBe('completed');
    expect(defaultMarketPluginSyncOutcome(snapshot('not-configured'))).toBe('completed');
  });

  it('defers while owner authentication is not stable', () => {
    expect(defaultMarketPluginSyncOutcome(snapshot('session-switching'))).toBe('deferred');
    expect(defaultMarketPluginSyncOutcome(snapshot('authentication-required'))).toBe('deferred');
  });

  it('fails retryably when the configured market request is unavailable', () => {
    expect(defaultMarketPluginSyncOutcome(snapshot('network unavailable'))).toBe('failed');
  });

  it('fails retryably when an individual default install or upgrade failed', () => {
    expect(defaultMarketPluginSyncOutcome(snapshot(null), 'failed')).toBe('failed');
  });

  it.each([
    'PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE',
    'PLUGIN_NAMESPACE_CONFIG_REQUIRED',
    'PLUGIN_FUTURE_REASON',
  ])('keeps retrying while the organization catalog is unavailable with %s', (code) => {
    expect(defaultMarketPluginSyncOutcome({ ...snapshot(null), organizationAccessError: code })).toBe('failed');
  });

  it('does not retry an organization catalog that needs a newer client', () => {
    expect(defaultMarketPluginSyncOutcome({
      ...snapshot(null),
      organizationAccessError: 'PLUGIN_NAMESPACE_CLIENT_REQUIRED',
    })).toBe('completed');
  });
});


describe('startup does not await custom Git network work', () => {
  it.each([false, true])('settles initialization before background work finishes (reject=%s)', async reject => {
    let finish!: () => void;
    const background = new Promise<null>((resolve, fail) => {
      finish = () => reject ? fail(new Error('offline fixture')) : resolve(null);
    });
    const refresh = vi.fn(() => background);
    const owner = vi.spyOn(sessions, 'getActiveAppSession').mockReturnValue({ mode: 'cloud', dataOwnerId: 'user-1', generation: 1 });
    const service = vi.spyOn(marketService, 'getPluginMarketService').mockReturnValue({
      snapshot: vi.fn(async () => snapshot(null)),
      hasPendingRemovalNotice: vi.fn(() => false),
      refreshCustomGitSourcesForBackground: refresh,
    } as never);
    let result: string | undefined;
    const startup = syncDefaultMarketPlugins().then(outcome => { result = outcome; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(refresh).toHaveBeenCalledOnce();
      expect(result).toBe('completed');
    } finally {
      finish();
      await startup;
      await new Promise(resolve => setImmediate(resolve));
      service.mockRestore(); owner.mockRestore();
    }
  });
});

describe('background Git refresh respects shared-passive ownership', () => {
  it.each([
    { name: 'shared passive preview', packaged: false, sharedPassive: '1', schedulerPassive: '1', refreshes: 0 },
    { name: 'primary dev instance', packaged: false, sharedPassive: undefined, schedulerPassive: undefined, refreshes: 2 },
    { name: 'isolated scheduler-passive instance', packaged: false, sharedPassive: undefined, schedulerPassive: '1', refreshes: 2 },
    { name: 'packaged app with ambient passive flags', packaged: true, sharedPassive: '1', schedulerPassive: '1', refreshes: 2 },
  ])('$name preserves reconciliation and permits $refreshes background calls', async scenario => {
    const packagedDescriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged');
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: scenario.packaged });
    vi.stubEnv('XDT_PASSIVE_SHARED_USER_DATA', scenario.sharedPassive);
    vi.stubEnv('XDT_SCHEDULER_PASSIVE', scenario.schedulerPassive);
    const refresh = vi.fn(async () => null);
    const reconcile = vi.fn(async () => snapshot(null));
    const owner = vi.spyOn(sessions, 'getActiveAppSession').mockReturnValue({ mode: 'cloud', dataOwnerId: 'user-1', generation: 1 });
    const service = vi.spyOn(marketService, 'getPluginMarketService').mockReturnValue({
      snapshot: reconcile,
      hasPendingRemovalNotice: vi.fn(() => false),
      refreshCustomGitSourcesForBackground: refresh,
    } as never);
    try {
      // Focus and the periodic task share this entry without the auth startup gate.
      expect(await syncDefaultMarketPlugins()).toBe('completed');
      expect(await syncDefaultMarketPlugins()).toBe('completed');
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledTimes(scenario.refreshes);
    } finally {
      await new Promise(resolve => setImmediate(resolve));
      service.mockRestore(); owner.mockRestore();
      vi.unstubAllEnvs();
      if (packagedDescriptor) Object.defineProperty(app, 'isPackaged', packagedDescriptor);
      else Reflect.deleteProperty(app, 'isPackaged');
    }
  });
});
