import { describe, expect, it } from 'vitest';

import type { PluginMarketSnapshot } from '../../../shared/pluginMarket';
import { defaultMarketPluginSyncOutcome } from '../registerIpc';

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
