import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  providerShareGuestPeer,
  providerShareHostPeer,
  type ProviderShareOwned,
  type ProviderShareReceived,
} from '@cindy/device-link';

const state = vi.hoisted(() => ({
  authenticated: true,
  scope: 'cloud:owner:1',
  remoteControl: true,
  allowed: new Set<string>(['anthropic']),
  owned: [] as ProviderShareOwned[],
  received: [] as ProviderShareReceived[],
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.scope,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ isAuthenticated: state.authenticated }),
  getDeviceId: () => 'host-device',
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://device-link.cindy.app' }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({
  isRemoteProviderInvocationAllowed: (id: string) => state.allowed.has(id),
}));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: state.remoteControl }) }));
vi.mock('../providerShareApi.js', () => ({
  providerShareApi: {
    listOwned: async () => state.owned,
    listReceived: async () => state.received,
  },
  fetchIdentityCard: vi.fn(),
  sha256Hex: (value: string) => value,
  providerShareOwnerKey: () => state.scope,
}));

import {
  applyLocalMemberChange,
  providerShareGuestAccess,
  providerShareGuestDenial,
  providerShareMemberMatcher,
  refreshProviderShareHost,
  startProviderShareHost,
  stopProviderShareHost,
} from '../providerShareHost';
import {
  describeProviderShareDevice,
  isProviderShareRefusal,
  parseProviderShareAgentDeviceId,
  providerShareAgentDeviceId,
  resolveRemoteAgentTarget,
  resolveRemoteAgentTargetWhenReady,
  startProviderShareGuest,
  stopProviderShareGuest,
} from '../providerShareGuest';

const person = { displayName: 'Lizi', avatarUrl: null, region: 'global' as const };
const share = (members: ProviderShareOwned['members'], requests: ProviderShareOwned['requests'] = []): ProviderShareOwned => ({
  shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'host-device', createdAt: '2026-10-01T00:00:00.000Z',
  members, requests,
});
const member = (memberId: string, status: 'active' | 'paused' = 'active') => ({ ...person, memberId, status, joinedAt: '2026-10-01T00:00:00.000Z' });
const guest = (memberId: string, device = 'laptop') => providerShareGuestPeer('share-1', memberId, device);

function events() {
  return { changed: vi.fn(), requested: vi.fn(), revoked: vi.fn(), reconcile: vi.fn() };
}

beforeEach(() => {
  state.authenticated = true;
  state.scope = 'cloud:owner:1';
  state.remoteControl = true;
  state.allowed = new Set(['anthropic']);
  state.owned = [];
  state.received = [];
});
afterEach(() => {
  stopProviderShareHost();
  stopProviderShareGuest();
});

describe('provider share host snapshot', () => {
  it('admits only active members while remote control and remote use stay on', async () => {
    state.owned = [share([member('m1'), member('m2', 'paused')])];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('test');
    expect(providerShareGuestAccess(guest('m1'))).toEqual({ shareId: 'share-1', memberId: 'm1', providerId: 'anthropic' });
    expect(providerShareGuestAccess(guest('m2'))).toBeNull();
    expect(providerShareGuestAccess(guest('m1', 'host-device'))).toBeNull();
    expect(providerShareGuestAccess(providerShareHostPeer('share-1', 'laptop'))).toBeNull();
    expect(providerShareGuestAccess('laptop')).toBeNull();
    state.allowed.clear();
    expect(providerShareGuestAccess(guest('m1'))).toBeNull();
    state.allowed.add('anthropic');
    state.remoteControl = false;
    expect(providerShareGuestAccess(guest('m1'))).toBeNull();
    state.remoteControl = true;
    state.scope = 'cloud:other:2';
    expect(providerShareGuestAccess(guest('m1'))).toBeNull();
  });

  it('names the reason a guest is refused, for the diagnostic log', async () => {
    expect(providerShareGuestDenial(guest('m1'))).toBe('host-not-running');
    state.owned = [share([member('m1'), member('m2', 'paused')])];
    startProviderShareHost(events());
    expect(providerShareGuestDenial(guest('m1'))).toBe('snapshot-not-loaded');
    await refreshProviderShareHost('test');
    expect(providerShareGuestDenial(guest('m1'))).toBeNull();
    expect(providerShareGuestDenial(guest('m2'))).toBe('member-not-active');
    expect(providerShareGuestDenial(providerShareGuestPeer('share-9', 'm1', 'laptop'))).toBe('share-unknown');
    expect(providerShareGuestDenial(guest('m1', 'host-device'))).toBe('self-device');
    state.allowed.clear();
    expect(providerShareGuestDenial(guest('m1'))).toBe('provider-not-remote');
    state.allowed.add('anthropic');
    state.remoteControl = false;
    expect(providerShareGuestDenial(guest('m1'))).toBe('remote-control-off');
    state.remoteControl = true;
    state.scope = 'cloud:other:2';
    expect(providerShareGuestDenial(guest('m1'))).toBe('host-scope-stale');
  });

  it('announces pending requests once and reconciles stale guests on the first snapshot', async () => {
    const request = { ...person, requestId: 'r1', pairingCode: '0427', createdAt: 'x', expiresAt: 'y' };
    state.owned = [share([member('m1')], [request])];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('test');
    await refreshProviderShareHost('again');
    expect(ev.requested).toHaveBeenCalledTimes(1);
    expect(ev.requested.mock.calls[0][0]).toEqual(request);
    expect(ev.reconcile).toHaveBeenCalledTimes(1);
    const owned = ev.reconcile.mock.calls[0][0] as Map<string, Set<string>>;
    expect([...owned.get('share-1')!]).toEqual(['m1']);
  });

  it('revokes on pause and purges on removal, locally and from the server snapshot', async () => {
    state.owned = [share([member('m1'), member('m2'), member('m3')])];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('test');
    applyLocalMemberChange('m1', 'paused');
    expect(ev.revoked).toHaveBeenLastCalledWith({ shareId: 'share-1', memberId: 'm1' }, false);
    expect(providerShareGuestAccess(guest('m1'))).toBeNull();
    applyLocalMemberChange('m2', 'removed');
    expect(ev.revoked).toHaveBeenLastCalledWith({ shareId: 'share-1', memberId: 'm2' }, true);
    state.owned = [share([member('m1', 'paused')])];
    await refreshProviderShareHost('left');
    expect(ev.revoked).toHaveBeenLastCalledWith({ shareId: 'share-1', memberId: 'm3' }, true);
    const match = providerShareMemberMatcher({ shareId: 'share-1', memberId: 'm3' });
    expect(match(guest('m3', 'desktop-2'))).toBe(true);
    expect(match(guest('m1'))).toBe(false);
    expect(match('m3')).toBe(false);
  });
});

describe('provider share host purge after pause', () => {
  it('still purges a member that was paused before being removed or leaving', async () => {
    state.owned = [share([member('m1'), member('m2')])];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('test');
    applyLocalMemberChange('m1', 'paused');
    applyLocalMemberChange('m1', 'removed');
    expect(ev.revoked.mock.calls).toEqual([
      [{ shareId: 'share-1', memberId: 'm1' }, false],
      [{ shareId: 'share-1', memberId: 'm1' }, true],
    ]);
    applyLocalMemberChange('m2', 'paused');
    state.owned = [share([])];
    await refreshProviderShareHost('left');
    expect(ev.revoked).toHaveBeenLastCalledWith({ shareId: 'share-1', memberId: 'm2' }, true);
  });
});

describe('provider share guest routing', () => {
  const received = (status: 'active' | 'paused'): ProviderShareReceived => ({
    shareId: 'share-1', memberId: 'm1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'owner-mac',
    deviceName: "Magi's Mac Mini", owner: { displayName: 'Magi', avatarUrl: null, region: 'global' }, status,
    hostOnline: true, hostCapable: true,
  });

  it('keeps task ids within the device id limit and maps them to the owner computer', async () => {
    expect(providerShareAgentDeviceId('share-1')).toBe('share:share-1');
    expect(() => providerShareAgentDeviceId('x'.repeat(123))).toThrow();
    expect(parseProviderShareAgentDeviceId('share:share-1')).toBe('share-1');
    expect(parseProviderShareAgentDeviceId('owner-mac')).toBeNull();
    expect(resolveRemoteAgentTarget('owner-mac')).toBe('owner-mac');

    state.received = [received('active')];
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
    await expect(resolveRemoteAgentTargetWhenReady('share:share-1')).resolves.toBe(providerShareHostPeer('share-1', 'owner-mac'));
    expect(describeProviderShareDevice('share:share-1')).toBe("Magi's Mac Mini");
    expect(() => resolveRemoteAgentTarget('share:share-2')).toThrow(/REMOTE_AGENT_SHARE_REMOVED/);
  });

  it('reports a paused share instead of routing to it', async () => {
    state.received = [received('paused')];
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
    await expect(resolveRemoteAgentTargetWhenReady('share:share-1')).rejects.toThrow(/REMOTE_AGENT_SHARE_PAUSED/);
  });

  it('treats a missing runtime as not connected rather than removed', async () => {
    await expect(resolveRemoteAgentTargetWhenReady('share:share-1')).rejects.toThrow(/DEVICE_LINK_NOT_CONNECTED/);
  });

  it('recognises the owner computer refusing a guest, including remote control turned off', () => {
    expect(isProviderShareRefusal('ACCESS_REVOKED', '')).toBe(true);
    expect(isProviderShareRefusal('REMOTE_DISABLED', 'remote control disabled')).toBe(true);
    expect(isProviderShareRefusal('IPC_ERROR', '[REMOTE_AGENT_PROVIDER_NOT_ALLOWED] off')).toBe(true);
    expect(isProviderShareRefusal('IPC_ERROR', 'boom')).toBe(false);
    expect(isProviderShareRefusal('DEVICE_OFFLINE', '')).toBe(false);
    expect(isProviderShareRefusal('TIMEOUT', '')).toBe(false);
  });
});
