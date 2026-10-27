import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginMarketSnapshot } from '../../../shared/pluginMarket';
import { defaultMarketPluginSyncOutcome, refreshForegroundMarketPlugins } from '../registerIpc';

const foreground = vi.hoisted(() => ({
  pending: false,
  refresh: vi.fn<() => Promise<'completed' | 'failed'>>(),
  snapshot: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../service.js', () => ({ getPluginMarketService: () => ({
  refreshCatalogForForeground: foreground.refresh,
  hasPendingRemovalNotice: () => foreground.pending,
  snapshot: foreground.snapshot,
}) }));
vi.mock('../../cindy-brain/index.js', () => ({
  sendToTrustedAppWindows: foreground.notify,
  createWindowGhostInstallConsentPrompt: vi.fn(),
  getGhostManager: vi.fn(),
  setGhostUninstallLedgerPreparer: vi.fn(),
}));

beforeEach(() => {
  foreground.pending = false;
  foreground.refresh.mockReset().mockResolvedValue('completed');
  foreground.snapshot.mockReset();
  foreground.notify.mockReset();
});

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

// PR #6667: foreground removals used to bypass the trusted notification path.
// Exercise the production entry with no additional snapshot or scan to signal a notice.
describe('foreground removal notification', () => {
  it.each(['completed', 'failed', 'rejected'] as const)('signals an existing removal notice after %s maintenance', async (outcome) => {
    const error = new Error('maintenance failed after removal');
    foreground.refresh.mockImplementationOnce(async () => {
      foreground.pending = true;
      if (outcome === 'rejected') throw error;
      return outcome;
    });
    const refresh = refreshForegroundMarketPlugins();
    if (outcome === 'rejected') await expect(refresh).rejects.toBe(error);
    else await expect(refresh).resolves.toBe(outcome);
    expect(foreground.notify).toHaveBeenCalledExactlyOnceWith('plugin-market:removal-notice-available', undefined);
    expect(foreground.snapshot).not.toHaveBeenCalled();
    expect(foreground.pending).toBe(true);
  });

  it('does not broadcast or start an extra snapshot when the catalog is unchanged', async () => {
    await expect(refreshForegroundMarketPlugins()).resolves.toBe('completed');
    expect(foreground.notify).not.toHaveBeenCalled();
    expect(foreground.snapshot).not.toHaveBeenCalled();
    expect(foreground.refresh).toHaveBeenCalledOnce();
  });
});
