// @vitest-environment jsdom
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderShareReceived } from '@cindy/device-link';
import type { ProviderShareCommand } from '../../shared/providerShare';

const server = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
const ownerStamp = { dataOwnerId: 'recipient', ownerGeneration: 1 };

vi.mock('../../main/serverApiClient.desktop.js', async () => {
  const { createServerApiClient } = await import('../../main/serverApiClient.js');
  return { serverApiFetch: createServerApiClient({
    fetch: (...args) => server.fetch(...args),
    locale: () => 'en',
    auth: { getAccessToken: () => null, refresh: async () => false, invalidateSession: async () => {} },
    log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) };
});
vi.mock('../../main/device-link/providerShareApi.js', async () => {
  const { createProviderShareApi } = await import('@cindy/device-link');
  const { serverApiFetch } = await import('../../main/serverApiClient.desktop.js');
  return {
    providerShareApi: createProviderShareApi({
      captureScope: () => ({ key: 'recipient', isCurrent: () => true }),
      request: (url, { method, body }) => serverApiFetch(url, { method, body, baseUrl: 'https://local.example' }),
    }),
    providerShareOwnerKey: () => 'recipient',
    fetchIdentityCard: async () => 'test-card',
    rethrowProviderShareError: (error: unknown) => { throw error; },
    sha256Hex: () => '0'.repeat(64),
  };
});
vi.mock('../../main/authManager.js', () => ({
  getAuthState: () => ({ isAuthenticated: true }),
  getActiveAuthRealm: () => 'cn',
  getCurrentUserId: () => 'recipient',
  getDeviceId: () => 'guest-device',
}));
vi.mock('../../main/appSessionState.js', () => ({
  isAppSessionBoundaryPending: () => false,
  getActiveDataOwnerPushStamp: () => ownerStamp,
}));
vi.mock('../../main/clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://local.example',
  getClientEndpointForRealm: () => 'https://peer.example',
  loadClientEndpointsForRealm: async () => {},
}));
vi.mock('../../main/logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../main/device-link/directLink.js', () => ({ desktopDirectRuntime: {} }));
vi.mock('../../main/device-link/deviceName.js', () => ({ deviceName: () => 'Test device' }));
vi.mock('../../main/device-link/linkWebSocket.desktop.js', () => ({ openLinkWebSocket: vi.fn() }));
vi.mock('../../main/device-link/providerMetadataContinuity.js', () => ({ invalidateProviderMetadataContinuity: vi.fn() }));
vi.mock('../../main/device-link/agentNetSharing.js', () => ({ hasAgentNetProviderGuestRoute: () => false }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  hasDeviceProvidersInterest: () => false,
  getCachedDeviceProviders: () => null,
  isSubscriptionShareCatalogStale: () => false,
}));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: vi.fn(async () => {}) }));

import {
  findReceivedShare, findReceivedShareForExecution, getReceivedSharesSnapshot, leaveProviderShare, refreshReceivedShares, resolveRemoteAgentTarget,
  skipsReceivedShareCredentialConsent, startProviderShareGuest, stopProviderShareGuest,
} from '../../main/device-link/providerShareGuest';
import { refreshProviderShareCrossRegion } from '../../main/device-link/providerShareCrossRegion';
import {
  configureProviderShareGuestPrefs, flushProviderShareGuestPrefs, resetProviderShareGuestPrefsForTests,
  setProviderShareCredentialConsent,
} from '../../main/device-link/providerShareGuestPrefs';
import { ExecutorGate } from '../../main/remote-agent/executor/gate';
import { ExecutorWorkspace } from '../../main/remote-agent/executor/workspace';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ensureProviderShareReceivedStarted, resetProviderShareStoreForTests } from '@/features/provider-share/providerShareStore';
import { __resetForTest, accessHostModelFavorites, setModelFavoritesOwner, useModelFavorites } from '@/state/modelFavorites';
import { providerShareFavoriteSource, useProviderShareFavorites } from '@/state/providerShareFavorites';

const shared: ProviderShareReceived = {
  shareId: 'shared', memberId: 'member', providerId: 'anthropic', providerLabel: 'Anthropic',
  hostDeviceId: 'host', deviceName: 'Host', status: 'active', hostOnline: true, hostCapable: true,
  owner: { displayName: 'Owner', avatarUrl: null, region: 'cn' },
};
const peer = { ...shared, shareId: 'peer', memberId: 'peer-member', owner: { ...shared.owner, region: 'global' as const } };
const device = `share:${shared.shareId}`;

afterEach(() => {
  cleanup();
  resetProviderShareStoreForTests();
  vi.unstubAllGlobals();
});

// Unit tier, with the process boundary bridged in memory. The 0.1.141 incident
// requires a real HTTP error → Main snapshot → Renderer cleanup/visibility path;
// isolated store tests cannot show whether a failed list also disables live consent.
// Minimal input: one trusted share and one favorite, interrupted by one response.
it('suspends availability through a denial or missing row and cleans only on confirmed termination', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-share-flow-'));
  const prefs = path.join(dir, 'prefs.json');
  let local: { status: number; shares: ProviderShareReceived[]; authorityIncomplete?: true } = { status: 200, shares: [shared] };
  let push: ((shares: readonly ProviderShareReceived[]) => void) | undefined;
  server.fetch.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/leave')) {
      local = { status: 503, shares: [] }; // Receipt alone must be enough.
      return Response.json({ status: 'left', memberId: shared.memberId });
    }
    if (url.hostname === 'peer.example') return Response.json({}, { status: 429 });
    return Response.json({ shares: local.shares, authorityIncomplete: local.authorityIncomplete }, { status: local.status });
  });
  configureProviderShareGuestPrefs({ resolvePath: () => prefs });
  __resetForTest();
  setDataOwnerGeneration(ownerStamp.dataOwnerId, ownerStamp.ownerGeneration);
  setModelFavoritesOwner(ownerStamp.dataOwnerId);
  vi.stubGlobal('electronAPI', { providerShare: {
    command: async (command: ProviderShareCommand) => {
      if (command.action === 'received-snapshot') return getReceivedSharesSnapshot(command.favoriteRecovery);
      if (command.action === 'leave') return leaveProviderShare(command.memberId);
      throw new Error('Unexpected provider share command');
    },
    onReceivedChanged: (listener: typeof push) => { push = listener; return () => { push = undefined; }; },
  } });
  const consent = new ExecutorGate(new ExecutorWorkspace({ workingDir: dir }), 'full', Date.now, {
    confirmCredentials: () => !skipsReceivedShareCredentialConsent(device),
  });
  const needsConsent = () => consent.needsCredentialConsent({ kind: 'read', path: path.join(dir, '.env') });
  const savedTrust = async (id: string) => JSON.parse(await fs.readFile(prefs, 'utf8')).shares[id]?.skipCredentialConsent === true;
  const savedFavorites = () => accessHostModelFavorites(ownerStamp.dataOwnerId);
  const poll = (status: number, shares: ProviderShareReceived[], authorityIncomplete?: true) => act(async () => {
    local = { status, shares, authorityIncomplete };
    await refreshReceivedShares('poll');
    await flushProviderShareGuestPrefs();
  });
  try {
    await setProviderShareCredentialConsent(peer.shareId, 'global', true);
    accessHostModelFavorites(ownerStamp.dataOwnerId, { kind: 'add', item: {
      providerId: providerShareFavoriteSource(peer), modelId: 'opus', agent: 'cc',
    } });
    await act(async () => {
      ensureProviderShareReceivedStarted();
      startProviderShareGuest({ changed: shares => push?.(shares), settled: vi.fn() }, { userDataDir: dir });
      await refreshReceivedShares('initial');
      await refreshProviderShareCrossRegion('global');
      await setProviderShareCredentialConsent(shared.shareId, 'cn', true);
    });
    const view = renderHook(() => useProviderShareFavorites(device, useModelFavorites()));
    const favorite = { providerId: shared.providerId, modelId: 'opus', agent: 'cc' as const };
    act(() => view.result.current.store.add(favorite));
    const [visible] = view.result.current.items;
    const stored = savedFavorites();
    expect(visible).toMatchObject(favorite);
    expect(needsConsent()).toBe(false);

    for (const [status, incomplete] of [[401], [403], [503], [200, true]] as const) {
      await poll(status, [], incomplete);
      expect(() => resolveRemoteAgentTarget(device)).toThrow();
      expect(findReceivedShareForExecution(shared.shareId)).toBeNull();
      if (status === 503) expect(findReceivedShare(shared.shareId, { existingLease: true })).toEqual(shared);
      expect(needsConsent()).toBe(true);
      expect(view.result.current.items).toEqual([]);
      expect(await savedTrust(shared.shareId)).toBe(true);
      expect(savedFavorites()).toEqual(stored);
      await poll(200, [shared]);
      expect(needsConsent()).toBe(false);
      expect(view.result.current.items).toEqual([visible]);
    }
    // While the list is 401, the owner removes and reapproves the same guest.
    // The server preserves the member identity; the received API omits the new
    // approval epoch. The recovered response is intentionally indistinguishable.
    await poll(401, []);
    expect(needsConsent()).toBe(true);
    const reapproved = { ...shared };
    await poll(200, [reapproved]);
    expect(await savedTrust(reapproved.shareId)).toBe(true);
    expect(needsConsent()).toBe(false);
    expect(view.result.current.items).toEqual([visible]);

    await poll(200, []);
    expect(await savedTrust(shared.shareId)).toBe(false);
    expect(savedFavorites()).toEqual(stored);
    expect(view.result.current.items).toEqual([]);

    await poll(200, [shared]);
    expect(needsConsent()).toBe(true);
    expect(view.result.current.items).toEqual([visible]);
    await setProviderShareCredentialConsent(shared.shareId, 'cn', true);
    const unavailableStorage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    try {
      await act(() => leaveProviderShare(shared.memberId));
      expect(getReceivedSharesSnapshot().leftMemberIds).toEqual([shared.memberId]);
      expect(savedFavorites()).toEqual(stored);
      await act(async () => {
        stopProviderShareGuest();
        startProviderShareGuest({ changed: shares => push?.(shares), settled: vi.fn() }, { userDataDir: dir });
        await refreshReceivedShares('after-device-link-restart');
      });
      await poll(200, [shared]);
      expect(view.result.current.items).toEqual([]);
      expect(getReceivedSharesSnapshot().leftMemberIds).toEqual([shared.memberId]);
    } finally {
      unavailableStorage.mockRestore();
    }
    await poll(200, [shared]);
    expect(getReceivedSharesSnapshot().leftMemberIds).toBeUndefined();
    expect(await savedTrust(shared.shareId)).toBe(false);
    expect(savedFavorites()).toEqual([stored[0]]);
    act(() => view.result.current.store.add(favorite));
    expect(view.result.current.items).toEqual([expect.objectContaining(favorite)]);
    await setProviderShareCredentialConsent(shared.shareId, 'cn', true);
    await poll(200, [{ ...shared, memberId: 'replacement' }]);
    expect(await savedTrust(shared.shareId)).toBe(false);
    expect(needsConsent()).toBe(true);
    expect(view.result.current.items).toEqual([]);
    expect(savedFavorites()).toEqual([stored[0]]);
    expect(await savedTrust(peer.shareId)).toBe(true);
    expect(getReceivedSharesSnapshot().confirmedRegions).not.toContain('global');
  } finally {
    stopProviderShareGuest();
    await flushProviderShareGuestPrefs();
    resetProviderShareGuestPrefsForTests();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
