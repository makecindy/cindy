import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  ownedError: false,
  remoteOwned: [] as ProviderShareOwned[],
  received: [] as ProviderShareReceived[],
  receivedError: false,
  boundaryPending: false,
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.scope,
  isAppSessionBoundaryPending: () => state.boundaryPending,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: state.scope, ownerGeneration: 1 }),
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ isAuthenticated: state.authenticated }),
  getActiveAuthRealm: () => 'global',
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
    listOwned: async () => {
      if (state.ownedError) throw new Error('offline');
      return state.owned;
    },
    listReceived: async () => {
      if (state.receivedError) throw new Error('offline');
      return state.received;
    },
    leave: vi.fn(async (memberId: string) => {
      state.received = state.received.filter((share) => share.memberId !== memberId);
    }),
  },
  fetchIdentityCard: vi.fn(),
  sha256Hex: (value: string) => value,
  providerShareOwnerKey: () => state.scope,
  checkProviderShareDelegation: vi.fn(async () => ({ active: false })),
}));
vi.mock('../providerShareCrossRegion.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../providerShareCrossRegion.js')>(),
  crossRegionLeave: vi.fn(async () => false),
}));

import { providerShareApi } from '../providerShareApi';
import { crossRegionLeave } from '../providerShareCrossRegion';
import {
  applyProviderShareDelegation, clearProviderShareDelegations,
  delegatedProviderShareLeases, delegatedProviderShareModelAllowed,
  delegatedProviderShareReceiptAuthority, delegatedProviderShareSessionAllowed,
  delegatedProviderShareTaskAccess, invalidateProviderShareDelegation,
  revokeDelegatedProviderShareGuest,
} from '../providerShareDelegatedAccess';

import {
  applyLocalMemberChange,
  clearProviderShareRequestQuiet,
  forgetWatchedProviderShareRequest,
  getProviderShareHostSnapshot,
  getProviderShareQuietRequestIds,
  getProviderShareWatchedRequests,
  PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS,
  providerShareGuestAccess,
  providerShareGuestDenial,
  providerShareMemberMatcher,
  quietProviderShareRequests,
  refreshProviderShareHost,
  startProviderShareHost,
  stopProviderShareHost,
  watchProviderShareRequests,
  verifyProviderShareMemberGeneration,
} from '../providerShareHost';
import {
  isProviderShareRefusal,
  leaveProviderShare,
  parseProviderShareAgentDeviceId,
  providerShareAgentDeviceId,
  resolveRemoteAgentTarget,
  resolveRemoteAgentTargetWhenReady,
  startProviderShareGuest,
  stopProviderShareGuest,
  getReceivedSharesSnapshot,
  refreshReceivedShares,
} from '../providerShareGuest';
import {
  configureProviderShareGuestPrefs,
  flushProviderShareGuestPrefs,
  isProviderShareCredentialConsentSkipped,
  resetProviderShareGuestPrefsForTests,
  setProviderShareCredentialConsent,
} from '../providerShareGuestPrefs';

const person = { displayName: 'Lizi', avatarUrl: null, region: 'global' as const };
const share = (members: ProviderShareOwned['members'], requests: ProviderShareOwned['requests'] = []): ProviderShareOwned => ({
  shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'host-device', createdAt: '2026-10-01T00:00:00.000Z',
  members, requests,
});
const member = (memberId: string, status: 'active' | 'paused' = 'active') => ({ ...person, memberId, status, joinedAt: '2026-10-01T00:00:00.000Z' });
const guest = (memberId: string, device = 'laptop') => providerShareGuestPeer('share-1', memberId, device);

function events() {
  return { changed: vi.fn(), requested: vi.fn(), watchedRequested: vi.fn(), revoked: vi.fn(), reconcile: vi.fn() };
}
const pendingRequest = (requestId: string) => ({ ...person, requestId, pairingCode: '0427', createdAt: 'x', expiresAt: 'y' });
const otherShare = (requests: ProviderShareOwned['requests'], providerId = 'anthropic'): ProviderShareOwned => ({
  shareId: `share-${providerId}-group`, providerId, providerLabel: 'Anthropic', hostDeviceId: 'group-host',
  createdAt: '2026-10-01T00:00:00.000Z', members: [member('g1')], requests,
});
const readWatchedShares = vi.fn(async (hostDeviceId: string) => state.remoteOwned.filter((item) => item.hostDeviceId === hostDeviceId));
const watchShare = (hostDeviceId: string, providerId: string) =>
  watchProviderShareRequests(hostDeviceId, providerId, () => readWatchedShares(hostDeviceId));

beforeEach(() => {
  state.authenticated = true;
  state.scope = 'cloud:owner:1';
  state.remoteControl = true;
  state.allowed = new Set(['anthropic']);
  state.owned = [];
  state.ownedError = false;
  state.remoteOwned = [];
  readWatchedShares.mockReset().mockImplementation(async (hostDeviceId) =>
    state.remoteOwned.filter((item) => item.hostDeviceId === hostDeviceId));
  state.received = [];
  state.receivedError = false;
  state.boundaryPending = false;
  vi.mocked(crossRegionLeave).mockReset().mockResolvedValue(false);
  vi.mocked(providerShareApi.leave).mockReset().mockImplementation(async (memberId) => {
    state.received = state.received.filter((entry) => entry.memberId !== memberId);
  });
});
afterEach(() => {
  clearProviderShareDelegations();
  stopProviderShareHost();
  stopProviderShareGuest();
});

describe('delegated executor access', () => {
  it('closes every old direct task immediately after owner deletion, then admits a fresh grant', async () => {
    const peer = guest('m1');
    const other = guest('m2');
    const generation = '55555555-5555-4555-8555-555555555555';
    const grant = { op: 'delegate' as const, action: 'grant' as const,
      shareId: 'share-1', memberId: 'm1', guestDeviceId: 'laptop', providerId: 'anthropic',
      model: 'model-one', generation, cleanupEpoch: 1 };
    const check = async () => ({ active: true, ownerDeviceId: 'owner-pc', generation,
      expiresAt: Date.now() + 30 * 60_000 });
    await applyProviderShareDelegation('owner-pc', { ...grant, sessionId: 'old_one' }, check);
    await applyProviderShareDelegation('owner-pc', { ...grant, sessionId: 'old_two' }, check);
    await applyProviderShareDelegation('owner-pc', { ...grant, memberId: 'm2', sessionId: 'other' }, check);
    revokeDelegatedProviderShareGuest('another-owner', peer, 1);
    expect(delegatedProviderShareSessionAllowed(peer, 'old_one')).toBe(true);
    await applyProviderShareDelegation('owner-pc', { ...grant, sessionId: 'new_one', cleanupEpoch: 2 }, check);
    expect(revokeDelegatedProviderShareGuest('owner-pc', peer, 1, true)).toBe(false);
    expect(delegatedProviderShareSessionAllowed(peer, 'new_one')).toBe(true);
    expect(revokeDelegatedProviderShareGuest('owner-pc', peer, 2, true)).toBe(true);
    expect(delegatedProviderShareSessionAllowed(peer, 'old_one')).toBe(false);
    expect(delegatedProviderShareSessionAllowed(peer, 'old_two')).toBe(false);
    expect(delegatedProviderShareSessionAllowed(peer, 'new_one')).toBe(false);
    expect(delegatedProviderShareModelAllowed(peer, 'model-one', 'old_one')).toBe(false);
    expect(delegatedProviderShareReceiptAuthority(peer, 'old_one')).toBeNull();
    expect(delegatedProviderShareSessionAllowed(other, 'other')).toBe(true);
    await applyProviderShareDelegation('owner-pc', { ...grant, sessionId: 'newer_one', cleanupEpoch: 3 }, check);
    expect(delegatedProviderShareSessionAllowed(peer, 'newer_one')).toBe(true);
    expect(delegatedProviderShareSessionAllowed(peer, 'old_one')).toBe(false);
  });

  // One share member can run two tasks on one M whose group entries point at
  // different local providers. Each task must retain its own source and model (unit tier).
  it('keeps concurrent task providers and models isolated on the same guest peer', async () => {
    state.allowed.add('openai');
    const peer = guest('m1');
    const generation = '44444444-4444-4444-8444-444444444444';
    const base = { op: 'delegate' as const, action: 'grant' as const,
      shareId: 'share-1', memberId: 'm1', guestDeviceId: 'laptop', generation };
    const check = async () => ({ active: true, ownerDeviceId: 'owner-pc', generation,
      expiresAt: Date.now() + 30 * 60_000 });
    await applyProviderShareDelegation('owner-pc', { ...base, providerId: 'anthropic',
      sessionId: 'claude_task', model: 'claude-opus' }, check);
    await applyProviderShareDelegation('owner-pc', { ...base, providerId: 'openai',
      sessionId: 'gpt_task', model: 'gpt-5' }, check);
    expect(delegatedProviderShareTaskAccess(peer, 'claude_task')?.providerId).toBe('anthropic');
    expect(delegatedProviderShareTaskAccess(peer, 'gpt_task')?.providerId).toBe('openai');
    expect(delegatedProviderShareTaskAccess(peer, 'unknown_task')).toBeNull();
    expect(delegatedProviderShareModelAllowed(peer, 'claude-opus', 'gpt_task')).toBe(false);
    expect(delegatedProviderShareModelAllowed(peer, 'gpt-5', 'claude_task')).toBe(false);
    expect(delegatedProviderShareModelAllowed(peer, 'gpt-5', 'gpt_task')).toBe(true);
    state.allowed.delete('anthropic');
    expect(delegatedProviderShareTaskAccess(peer, 'claude_task')).toBeNull();
    expect(delegatedProviderShareTaskAccess(peer, 'gpt_task')?.providerId).toBe('openai');
    expect(providerShareGuestAccess(peer)?.providerId).toBe('openai');
  });

  // A turn can finish just after its 30-minute lease ends. The production M→O
  // metering path needs its original generation, while guest admission must close (unit tier).
  it('keeps only short-lived accounting authority after a task lease expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
      const peer = guest('m1');
      const generation = '11111111-1111-4111-8111-111111111111';
      const grant = { op: 'delegate' as const, action: 'grant' as const,
        shareId: 'share-1', memberId: 'm1', guestDeviceId: 'laptop', providerId: 'anthropic',
        sessionId: 'long_task', model: 'model-one', generation };
      await applyProviderShareDelegation('owner-pc', grant, async () => ({ active: true,
        ownerDeviceId: 'owner-pc', generation, expiresAt: Date.now() + 30 * 60_000 }));
      state.remoteControl = false;
      expect(providerShareGuestAccess(peer)).toBeNull();
      expect(delegatedProviderShareReceiptAuthority(peer, 'long_task'))
        .toEqual({ ownerDeviceId: 'owner-pc', generation });
      state.remoteControl = true;
      state.allowed.clear();
      expect(providerShareGuestAccess(peer)).toBeNull();
      expect(delegatedProviderShareReceiptAuthority(peer, 'long_task'))
        .toEqual({ ownerDeviceId: 'owner-pc', generation });
      state.allowed.add('anthropic');
      vi.setSystemTime(new Date(Date.now() + 30 * 60_000 + 1));
      expect(providerShareGuestAccess(peer)).toBeNull();
      expect(delegatedProviderShareLeases()).toEqual([]);
      expect(delegatedProviderShareReceiptAuthority(peer, 'long_task'))
        .toEqual({ ownerDeviceId: 'owner-pc', generation });
      expect(delegatedProviderShareReceiptAuthority(peer, 'other_task')).toBeNull();
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));
      expect(delegatedProviderShareReceiptAuthority(peer, 'long_task')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('clears an expired task accounting authority on account change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
      const peer = guest('m1');
      const generation = '22222222-2222-4222-8222-222222222222';
      await applyProviderShareDelegation('owner-pc', { op: 'delegate', action: 'grant',
        shareId: 'share-1', memberId: 'm1', guestDeviceId: 'laptop', providerId: 'anthropic',
        sessionId: 'long_task', model: 'model-one', generation }, async () => ({ active: true,
        ownerDeviceId: 'owner-pc', generation, expiresAt: Date.now() + 30 * 60_000 }));
      vi.setSystemTime(new Date(Date.now() + 30 * 60_000 + 1));
      expect(delegatedProviderShareReceiptAuthority(peer, 'long_task')).not.toBeNull();
      state.scope = 'cloud:another:1';
      expect(delegatedProviderShareReceiptAuthority(peer, 'long_task')).toBeNull();
      state.scope = 'cloud:owner:1';
      expect(delegatedProviderShareReceiptAuthority(peer, 'long_task')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  // Both O's explicit revoke and M's server recheck can race with a completed
  // turn's done event. They close execution immediately but preserve its receipt (unit tier).
  it('keeps accounting authority briefly when a delegated task is revoked or invalidated', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
      const peer = guest('m1');
      const generation = '33333333-3333-4333-8333-333333333333';
      const grant = { op: 'delegate' as const, action: 'grant' as const,
        shareId: 'share-1', memberId: 'm1', guestDeviceId: 'laptop', providerId: 'anthropic',
        model: 'model-one', generation };
      const check = async () => ({ active: true, ownerDeviceId: 'owner-pc', generation,
        expiresAt: Date.now() + 30 * 60_000 });
      await applyProviderShareDelegation('owner-pc', { ...grant, sessionId: 'revoke_task' }, check);
      await applyProviderShareDelegation('owner-pc', { ...grant, sessionId: 'invalid_task' }, check);
      const invalidNonce = delegatedProviderShareLeases().find((entry) => entry.sessionId === 'invalid_task')!.lease.nonce;
      state.remoteControl = false;
      expect(await applyProviderShareDelegation('owner-pc', { ...grant, action: 'revoke', sessionId: 'revoke_task' }))
        .toBe(true);
      invalidateProviderShareDelegation(peer, 'invalid_task', invalidNonce);
      state.remoteControl = true;
      expect(providerShareGuestAccess(peer)).toBeNull();
      expect(delegatedProviderShareLeases()).toEqual([]);
      expect(delegatedProviderShareReceiptAuthority(peer, 'revoke_task'))
        .toEqual({ ownerDeviceId: 'owner-pc', generation });
      expect(delegatedProviderShareReceiptAuthority(peer, 'invalid_task'))
        .toEqual({ ownerDeviceId: 'owner-pc', generation });
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));
      expect(delegatedProviderShareReceiptAuthority(peer, 'revoke_task')).toBeNull();
      expect(delegatedProviderShareReceiptAuthority(peer, 'invalid_task')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  // Permission boundary: two tasks on one guest device must not revoke each other or acquire owner permissions.
  it('binds concurrent task leases to their approved models and stops on revocation or account change', async () => {
    const peer = guest('m1');
    // The delegated gate itself must fail closed when a caller forgets its
    // host-level authorization check. O's owned-share path is handled there.
    expect(delegatedProviderShareSessionAllowed(peer, 'task_one')).toBe(false);
    expect(delegatedProviderShareModelAllowed(peer, 'model-one', 'task_one')).toBe(false);
    const generation = '11111111-1111-4111-8111-111111111111';
    const base = { op: 'delegate' as const, action: 'grant' as const, shareId: 'share-1',
      memberId: 'm1', guestDeviceId: 'laptop', providerId: 'anthropic', generation };
    const check = async () => ({ active: true, ownerDeviceId: 'owner-pc', expiresAt: Date.now() + 30 * 60_000,
      generation });
    await expect(applyProviderShareDelegation('owner-pc', { ...base, generation: '22222222-2222-4222-8222-222222222222',
      sessionId: 'task_invalid', model: 'model-one' }, check)).rejects.toThrow('REMOTE_AGENT_INVALID');
    await applyProviderShareDelegation('owner-pc', { ...base, sessionId: 'task_one', model: 'model-one' }, check);
    await applyProviderShareDelegation('owner-pc', { ...base, sessionId: 'task_two', model: 'model-two' }, check);
    expect(providerShareGuestAccess(peer)).toMatchObject({ providerId: 'anthropic', memberId: 'm1' });
    expect(delegatedProviderShareSessionAllowed(peer, 'task_one')).toBe(true);
    expect(delegatedProviderShareSessionAllowed(peer, 'unassigned')).toBe(false);
    expect(delegatedProviderShareModelAllowed(peer, 'model-one', 'task_one')).toBe(true);
    expect(delegatedProviderShareModelAllowed(peer, 'model-two', 'task_two')).toBe(true);
    expect(delegatedProviderShareModelAllowed(peer, 'model-two', 'task_one')).toBe(false);
    expect(delegatedProviderShareModelAllowed(peer, 'model-one', 'task_two')).toBe(false);
    expect(delegatedProviderShareModelAllowed(peer, 'other', 'task_one')).toBe(false);
    const renewal = '33333333-3333-4333-8333-333333333333';
    await applyProviderShareDelegation('owner-pc', { ...base, generation: renewal,
      sessionId: 'task_one', model: 'model-one' }, async () => ({ active: true,
      ownerDeviceId: 'owner-pc', expiresAt: Date.now() + 30 * 60_000, generation: renewal }));
    expect(await applyProviderShareDelegation('owner-pc', { ...base, action: 'revoke',
      sessionId: 'task_one', model: 'model-one' })).toBe(false);
    expect(delegatedProviderShareSessionAllowed(peer, 'task_one')).toBe(true);
    expect(await applyProviderShareDelegation('owner-pc', { ...base, action: 'revoke', generation: renewal,
      sessionId: 'task_one', model: 'model-one' })).toBe(true);
    expect(delegatedProviderShareSessionAllowed(peer, 'task_one')).toBe(false);
    expect(delegatedProviderShareSessionAllowed(peer, 'task_two')).toBe(true);
    expect(providerShareGuestAccess(peer)).not.toBeNull();
    state.remoteControl = false;
    expect(providerShareGuestAccess(peer)).toBeNull();
    state.remoteControl = true;
    state.scope = 'cloud:another:1';
    expect(providerShareGuestAccess(peer)).toBeNull();
  });
});

describe('provider share host snapshot', () => {
  // Unit tier: server grant may race a deletion after O's last poll. Its new
  // server epoch does not prove O cleaned the old guest data.
  it('rejects a post-grant incarnation mismatch and fails closed when the fresh read is offline', async () => {
    state.owned = [share([member('g1')])];
    const callbacks = events();
    startProviderShareHost(callbacks);
    await refreshProviderShareHost('test');
    const expected = { shareId: 'share-1', memberId: 'g1', joinedAt: member('g1').joinedAt };
    await expect(verifyProviderShareMemberGeneration(expected)).resolves.toBeUndefined();
    state.ownedError = true;
    await expect(verifyProviderShareMemberGeneration(expected)).rejects.toThrow('offline');
    state.ownedError = false;
    state.owned = [share([{ ...member('g1'), joinedAt: '2026-10-28T01:00:00.000Z' }])];
    await expect(verifyProviderShareMemberGeneration(expected)).rejects.toThrow('membership changed');
    await refreshProviderShareHost('test');
    expect(callbacks.revoked).toHaveBeenCalledWith({ shareId: 'share-1', memberId: 'g1' }, true);
  });

  // Production snapshot entry; a removed member can be reapproved with the same ID
  // while O misses both transitions. Status-only comparison kept the old history (unit).
  it('purges when the server reuses a member ID with a different joinedAt, even if both snapshots are active', async () => {
    state.owned = [share([member('m1')])];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('g1');
    state.ownedError = true;
    await refreshProviderShareHost('offline');
    state.ownedError = false;
    state.owned = [share([{ ...member('m1'), joinedAt: '2026-10-02T00:00:00.000Z' }])];
    await refreshProviderShareHost('g2');
    expect(ev.revoked).toHaveBeenCalledWith({ shareId: 'share-1', memberId: 'm1' }, true);
  });

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
    expect(ev.requested.mock.calls[0][2]).toBe(false);
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

// provider-sharing.md §4.1 第 4 步：审批弹窗跟着生成链接的电脑。
describe('provider share approval follows the computer that generated the link', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps this computer quiet for requests on a link another computer generated, within the window only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    state.owned = [share([member('m1')])];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('test');

    await quietProviderShareRequests('anthropic');
    state.owned = [share([member('m1')], [pendingRequest('r1')])];
    await refreshProviderShareHost('remote-link');
    expect(ev.requested).toHaveBeenLastCalledWith(pendingRequest('r1'), expect.objectContaining({ shareId: 'share-1' }), true);
    expect(getProviderShareQuietRequestIds()).toEqual(['r1']);

    // 窗口期过后才发现的申请照旧由本机弹。
    vi.setSystemTime(new Date(Date.now() + PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS + 1));
    state.owned = [share([member('m1')], [pendingRequest('r1'), pendingRequest('r2')])];
    await refreshProviderShareHost('late');
    expect(ev.requested).toHaveBeenLastCalledWith(pendingRequest('r2'), expect.anything(), false);

    // 处理掉的申请不再记作静默。
    state.owned = [share([member('m1')], [pendingRequest('r2')])];
    await refreshProviderShareHost('handled');
    expect(getProviderShareQuietRequestIds()).toEqual([]);
  });

  it('resumes prompting here once this computer generates its own link', async () => {
    state.owned = [share([member('m1')])];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('test');
    await quietProviderShareRequests('anthropic');
    await clearProviderShareRequestQuiet('anthropic');
    state.owned = [share([member('m1')], [pendingRequest('r1')])];
    await refreshProviderShareHost('local-link');
    expect(ev.requested).toHaveBeenLastCalledWith(pendingRequest('r1'), expect.anything(), false);
    expect(getProviderShareQuietRequestIds()).toEqual([]);
  });

  it('keeps the quiet approval ownership across a host runtime restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    state.owned = [share([member('m1')])];
    const first = events();
    startProviderShareHost(first);
    await refreshProviderShareHost('test');
    await quietProviderShareRequests('anthropic');

    stopProviderShareHost();
    const restarted = events();
    startProviderShareHost(restarted);
    await refreshProviderShareHost('restart');
    state.owned = [share([member('m1')], [pendingRequest('after-restart')])];
    await refreshProviderShareHost('after-restart');

    expect(restarted.requested).toHaveBeenLastCalledWith(
      pendingRequest('after-restart'),
      expect.objectContaining({ shareId: 'share-1' }),
      true,
    );
    expect(getProviderShareQuietRequestIds()).toEqual(['after-restart']);

    // 不让本测试的短期归属影响后续测试。
    vi.setSystemTime(new Date(Date.now() + PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS + 1));
    stopProviderShareHost();
  });

  it('keeps watched approval ownership and de-duplication across a host runtime restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    state.owned = [share([member('m1')])];
    state.remoteOwned = [otherShare([])];
    const first = events();
    startProviderShareHost(first);
    await refreshProviderShareHost('test');
    await watchShare('group-host', 'anthropic');

    state.remoteOwned = [otherShare([pendingRequest('before-restart')])];
    await refreshProviderShareHost('before-restart');
    expect(first.watchedRequested).toHaveBeenCalledTimes(1);

    stopProviderShareHost();
    const restarted = events();
    startProviderShareHost(restarted);
    await refreshProviderShareHost('restart');
    expect(restarted.watchedRequested).not.toHaveBeenCalled();

    state.remoteOwned = [otherShare([pendingRequest('before-restart'), pendingRequest('after-restart')])];
    await refreshProviderShareHost('after-restart');
    expect(restarted.watchedRequested.mock.calls.map(([item]) => item.request.requestId)).toEqual(['after-restart']);

    // 不让本测试的短期归属影响后续测试。
    vi.setSystemTime(new Date(Date.now() + PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS + 1));
    stopProviderShareHost();
  });

  it('prompts here for a watched share on another computer without letting it into this computer\'s snapshot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    state.owned = [share([member('m1')])];
    state.remoteOwned = [otherShare([pendingRequest('w0')]), otherShare([pendingRequest('o1')], 'openai')];
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('test');
    // 没有生成过链接：别的电脑上的申请这里不弹。
    expect(ev.watchedRequested).not.toHaveBeenCalled();

    await watchShare('group-host', 'anthropic');
    state.remoteOwned = [otherShare([pendingRequest('w0'), pendingRequest('w1')]), otherShare([pendingRequest('o1')], 'openai')];
    await refreshProviderShareHost('watch');
    await refreshProviderShareHost('again');
    expect(ev.watchedRequested.mock.calls.map(([item]) => item.request.requestId)).toEqual(['w0', 'w1']);
    expect(ev.watchedRequested.mock.calls[1][0]).toEqual({
      request: pendingRequest('w1'),
      share: { shareId: 'share-anthropic-group', providerId: 'anthropic', providerLabel: 'Anthropic' },
      hostDeviceId: 'group-host',
    });
    // 只用于弹窗：不进本机快照，不放行受邀者。
    expect(getProviderShareHostSnapshot().map((item) => item.shareId)).toEqual(['share-1']);
    expect(ev.requested).not.toHaveBeenCalled();

    // 本机处理后立即移除；处理前发出的那次拉取还带着它也不再弹、不再加回。
    forgetWatchedProviderShareRequest('w1');
    await refreshProviderShareHost('stale');
    expect(getProviderShareWatchedRequests().map((item) => item.request.requestId)).toEqual(['w0']);
    expect(ev.watchedRequested).toHaveBeenCalledTimes(2);

    // 在别处处理、撤回或过期：从快照里消失即移除。
    state.remoteOwned = [otherShare([])];
    await refreshProviderShareHost('gone');
    expect(getProviderShareWatchedRequests()).toEqual([]);

    // 窗口期过后不再关注。
    vi.setSystemTime(new Date(Date.now() + PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS + 1));
    state.remoteOwned = [otherShare([pendingRequest('w2')])];
    await refreshProviderShareHost('late');
    expect(ev.watchedRequested).toHaveBeenCalledTimes(2);
  });

  it('continues polling a watched computer after reconnect even when this computer owns no shares', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    startProviderShareHost(events());
    await refreshProviderShareHost('start');
    await watchShare('group-host', 'anthropic');
    stopProviderShareHost();

    const restarted = events();
    startProviderShareHost(restarted);
    await refreshProviderShareHost('restart');
    state.remoteOwned = [otherShare([pendingRequest('after-reconnect')])];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restarted.watchedRequested).toHaveBeenCalledWith(expect.objectContaining({
      request: pendingRequest('after-reconnect'), hostDeviceId: 'group-host',
    }));
    expect(getProviderShareHostSnapshot()).toEqual([]);
    stopProviderShareHost();
  });

  it('reads watched requests even when the local REST snapshot cannot be fetched', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('start');
    await watchShare('group-host', 'anthropic');
    state.ownedError = true;
    state.remoteOwned = [otherShare([pendingRequest('remote-only')])];
    await refreshProviderShareHost('local-offline');
    expect(ev.watchedRequested).toHaveBeenCalledWith(expect.objectContaining({ request: pendingRequest('remote-only') }));
  });

  it('continues remote polling while a local REST read is still pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    let finishLocal!: (shares: ProviderShareOwned[]) => void;
    const localRead = vi.spyOn(providerShareApi, 'listOwned').mockImplementation(() =>
      new Promise((resolve) => { finishLocal = resolve; }));
    const ev = events();
    startProviderShareHost(ev);
    await watchShare('group-host', 'anthropic');
    state.remoteOwned = [otherShare([pendingRequest('local-still-pending')])];
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ev.watchedRequested).toHaveBeenCalledWith(expect.objectContaining({ request: pendingRequest('local-still-pending') }));
      expect(localRead).toHaveBeenCalledTimes(1);
    } finally {
      finishLocal([]);
      await refreshProviderShareHost('finish-local');
      localRead.mockRestore();
      stopProviderShareHost();
    }
  });

  it('keeps pending requests on a failed computer while applying successful updates from another computer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('start');
    await watchShare('group-host', 'anthropic');
    await watchShare('another-host', 'anthropic');
    state.remoteOwned = [
      otherShare([pendingRequest('keep-offline')]),
      { ...otherShare([pendingRequest('remove-online')]), hostDeviceId: 'another-host' },
    ];
    await refreshProviderShareHost('both-online');
    readWatchedShares.mockImplementation(async (hostDeviceId) => {
      if (hostDeviceId === 'group-host') throw new Error('offline');
      return [{ ...otherShare([pendingRequest('new-online')]), hostDeviceId }];
    });
    await refreshProviderShareHost('one-offline');
    expect(getProviderShareWatchedRequests().map((item) => item.request.requestId).sort()).toEqual(['keep-offline', 'new-online']);
  });

  it('does not let one pending remote read delay local requests or another watched computer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('start');
    await watchShare('group-host', 'anthropic');
    await watchShare('another-host', 'anthropic');
    let finishOffline!: (shares: ProviderShareOwned[]) => void;
    let onlineRequest = 'online';
    readWatchedShares.mockImplementation((hostDeviceId) => hostDeviceId === 'group-host'
      ? new Promise((resolve) => { finishOffline = resolve; })
      : Promise.resolve([{ ...otherShare([pendingRequest(onlineRequest)]), hostDeviceId }]));
    state.owned = [share([], [pendingRequest('local')])];
    const refreshing = refreshProviderShareHost('slow-peer');
    try {
      await vi.waitFor(() => {
        expect(ev.requested).toHaveBeenCalledWith(pendingRequest('local'), expect.anything(), false);
        expect(ev.watchedRequested).toHaveBeenCalledWith(expect.objectContaining({ request: pendingRequest('online') }));
      });
      state.owned = [share([], [pendingRequest('local-next')])];
      onlineRequest = 'online-next';
      await refreshProviderShareHost('next-round-with-slow-peer');
      expect(ev.requested).toHaveBeenLastCalledWith(pendingRequest('local-next'), expect.anything(), false);
      expect(ev.watchedRequested).toHaveBeenLastCalledWith(expect.objectContaining({ request: pendingRequest('online-next') }));
      expect(readWatchedShares.mock.calls.filter(([hostDeviceId]) => hostDeviceId === 'group-host')).toHaveLength(1);
    } finally {
      finishOffline([]);
      await refreshing;
    }
  });

  it('discards a watched snapshot that completes after an account switch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00.000Z'));
    const ev = events();
    startProviderShareHost(ev);
    await refreshProviderShareHost('start');
    await watchShare('group-host', 'anthropic');
    let finish!: (shares: ProviderShareOwned[]) => void;
    readWatchedShares.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const refreshing = refreshProviderShareHost('before-switch');
    state.scope = 'cloud:other:2';
    finish([otherShare([pendingRequest('old-owner')])]);
    await refreshing;
    expect(ev.watchedRequested).not.toHaveBeenCalled();
    expect(getProviderShareWatchedRequests()).toEqual([]);
  });
});

describe('provider share guest routing', () => {
  it('distinguishes an authoritative empty membership list from startup, failure, disconnect and account switch', async () => {
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual([]);
    state.receivedError = true;
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual([]);
    state.receivedError = false;
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot()).toMatchObject({ confirmedRegions: ['global'], received: [], ownerStamp: { dataOwnerId: state.scope } });
    state.scope = 'cloud:other:2';
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual([]);
    stopProviderShareGuest();
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual([]);
  });
  const received = (status: 'active' | 'paused'): ProviderShareReceived => ({
    shareId: 'share-1', memberId: 'm1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'owner-mac',
    deviceName: "Magi's Mac Mini", owner: { displayName: 'Magi', avatarUrl: null, region: 'global' }, status,
    hostOnline: true, hostCapable: true,
  });

  it.each(['account', 'logout', 'boundary', 'stopped'])('does not expose a loaded snapshot after %s invalidation', async (reason) => {
    state.received = [received('active')];
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot().received).toEqual(state.received);
    if (reason === 'account') state.scope = 'cloud:other:2';
    else if (reason === 'logout') state.authenticated = false;
    else if (reason === 'boundary') state.boundaryPending = true;
    else stopProviderShareGuest();
    expect(getReceivedSharesSnapshot().received).toEqual([]);
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

  describe('local credential-consent preference', () => {
    let dir: string;
    const prefsFile = () => path.join(dir, state.scope === 'cloud:owner:1' ? 'account-a' : 'account-b', 'provider-share-guest-prefs.json');
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-guest-prefs-'));
      configureProviderShareGuestPrefs({ resolvePath: prefsFile });
    });
    afterEach(async () => {
      await flushProviderShareGuestPrefs();
      resetProviderShareGuestPrefsForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('survives a failed refresh and a pause, and goes away once the owner removed the share', async () => {
      state.received = [received('active')];
      startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
      await refreshReceivedShares('test');
      await setProviderShareCredentialConsent('share-1', 'global', true);
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

      state.receivedError = true;
      await refreshReceivedShares('test');
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

      state.receivedError = false;
      state.received = [received('paused')];
      await refreshReceivedShares('test');
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

      state.received = [];
      await refreshReceivedShares('test');
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    });

    it('is forgotten when the guest leaves the share', async () => {
      state.received = [received('active')];
      startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
      await refreshReceivedShares('test');
      await setProviderShareCredentialConsent('share-1', 'global', true);

      await leaveProviderShare('m1');
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    });

    it('does not dispatch a same-region leave using the account that replaced the initiating account', async () => {
      state.received = [received('active')];
      startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
      await refreshReceivedShares('test');
      await setProviderShareCredentialConsent('share-1', 'global', true);
      let finishCheck!: (crossRegion: boolean) => void;
      vi.mocked(crossRegionLeave).mockReturnValueOnce(new Promise<boolean>((resolve) => { finishCheck = resolve; }));
      const leaving = leaveProviderShare('m1');
      state.scope = 'cloud:other:2';
      await setProviderShareCredentialConsent('share-1', 'global', true);
      finishCheck(false);

      await expect(leaving).rejects.toThrow('DEVICE_LINK_NOT_CONNECTED');
      expect(providerShareApi.leave).not.toHaveBeenCalled();
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
      state.scope = 'cloud:owner:1';
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
    });

    it.each([false, true])('cleans the initiating account after switching accounts during leave (cross-region: %s)', async (crossRegion) => {
      state.received = [received('active')];
      startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() });
      await refreshReceivedShares('test');
      await setProviderShareCredentialConsent('share-1', 'global', true);
      const initiatingFile = prefsFile();
      let finishLeave!: () => void;
      const response = new Promise<void>((resolve) => { finishLeave = resolve; });
      if (crossRegion) {
        vi.mocked(crossRegionLeave).mockImplementationOnce(async () => {
          await response;
          return true;
        });
      } else {
        vi.mocked(providerShareApi.leave).mockImplementationOnce(() => response);
      }
      const leaving = leaveProviderShare('m1');
      await vi.waitFor(() => expect(crossRegion ? crossRegionLeave : providerShareApi.leave).toHaveBeenCalledWith('m1'));

      stopProviderShareGuest();
      state.scope = 'cloud:other:2';
      const currentEvents = { changed: vi.fn(), settled: vi.fn() };
      startProviderShareGuest(currentEvents);
      await refreshReceivedShares('new-account');
      await setProviderShareCredentialConsent('share-1', 'global', true);
      currentEvents.changed.mockClear();
      finishLeave();
      await leaving;
      await flushProviderShareGuestPrefs();

      expect(JSON.parse(fs.readFileSync(initiatingFile, 'utf8')).shares).toEqual({});
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
      expect(JSON.parse(fs.readFileSync(prefsFile(), 'utf8')).shares).toEqual({
        'share-1': { region: 'global', skipCredentialConsent: true },
      });
      expect(currentEvents.changed).not.toHaveBeenCalled();
    });
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
