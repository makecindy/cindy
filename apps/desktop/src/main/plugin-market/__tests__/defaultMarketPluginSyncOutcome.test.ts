import { describe, expect, it, vi } from 'vitest';

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
