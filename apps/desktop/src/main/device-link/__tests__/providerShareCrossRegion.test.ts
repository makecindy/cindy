/**
 * 跨区域受邀者(P3)：只认两个官方区域；不把本区域 Access Token 发给对方区域，也不会因对方区域的
 * 401 登出本账号；登录后自动核验账号的全部分享；凭证只在内存里。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'a'.repeat(43);
const CREDENTIAL = 'c'.repeat(43);
const LOCAL = 'https://device-link.cindy.com.cn';
const PEER = 'https://device-link.cindy.app';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; opts: Record<string, unknown> }>,
  responses: new Map<string, unknown>(),
  clients: [] as Array<{ opts: Record<string, unknown>; started: boolean; stopped: boolean }>,
  localReceivedError: false,
  localHasGroupShare: false,
  localReceivedReads: 0,
  localReceivedGate: null as Promise<void> | null,
  endpointsGate: null as Promise<void> | null,
  endpointHook: null as null | (() => Promise<void>),
  identityHook: null as null | ((purpose: string) => Promise<void>),
  cardOwners: [] as string[],
  userId: 'user-1',
  realm: 'cn' as 'cn' | 'global',
  identityCards: [] as string[],
  invokes: [] as Array<{ target: string; channel: string }>,
}));

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
vi.mock('ws', () => ({ default: class {} }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: () => false,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: state.userId, ownerGeneration: 1 }),
}));
vi.mock('../../authManager.js', () => ({
  getActiveAuthRealm: () => state.realm,
  getAuthState: () => ({ isAuthenticated: true }),
  getCurrentUserId: () => state.userId,
  getDeviceId: () => 'device-1',
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => state.realm === 'cn' ? LOCAL : PEER,
  loadClientEndpointsForRealm: async () => { await state.endpointHook?.(); await state.endpointsGate; return {}; },
  getClientEndpointForRealm: (region: string) => (region === 'global' ? PEER : LOCAL),
}));
vi.mock('../../maker-host/outbound-fetch.js', () => ({ createOutboundHttpAgent: async () => undefined }));
vi.mock('../deviceName.js', () => ({ deviceName: () => 'Laptop' }));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: async (apiPath: string, opts: Record<string, unknown>) => {
    state.calls.push({ path: apiPath, opts });
    const key = apiPath.replace('/api/device-link/provider-shares/x', '');
    if (!state.responses.has(key)) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    const response = await state.responses.get(key);
    if (response instanceof Error) throw response;
    return response;
  },
}));
vi.mock('../providerShareApi.js', () => ({
  providerShareOwnerKey: () => state.userId,
  providerShareApi: {
    listReceived: async () => {
      state.localReceivedReads += 1;
      await state.localReceivedGate;
      if (state.localReceivedError) throw new Error('local unavailable');
      return [
        { ...share, shareId: 'share-local', memberId: 'member-local', owner: { ...share.owner, region: state.realm } },
        ...(state.localHasGroupShare ? [{ ...share, owner: { ...share.owner, region: 'cn' } }] : []),
      ];
    },
  },
  fetchIdentityCard: async (purpose: string, nonce: string) => {
    state.identityCards.push(purpose);
    state.cardOwners.push(state.userId);
    await state.identityHook?.(purpose);
    return `card:${purpose}:${nonce}`;
  },
  rethrowProviderShareError: (error: unknown) => { throw error; },
  sha256Hex: (value: string) => `h(${value})`.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
}));
vi.mock('@cindy/device-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cindy/device-link')>()),
  DeviceLinkClient: class {
    record: { opts: Record<string, unknown>; started: boolean; stopped: boolean };
    constructor(opts: Record<string, unknown>) {
      this.record = { opts, started: false, stopped: false };
      state.clients.push(this.record);
    }
    start() { this.record.started = true; }
    stop() { this.record.stopped = true; }
    async waitUntilOnline() {}
    hasOfflineDirectPath() { return false; }
    isLinkReady() { return false; }
    async openLink() {}
    async invoke(target: string, request: { channel: string }) {
      state.invokes.push({ target, channel: request.channel });
      return { ok: true, result: { providers: [{ id: 'openai' }] } };
    }
  },
}));

import {
  __testing,
  crossRegionOfIntent,
  crossRegionInvoke,
  crossRegionSendRequest,
  getCrossRegionReceived,
  getConfirmedCrossRegionReceivedRegions,
  isCrossRegionReceivedReady,
  refreshProviderShareCrossRegion,
  waitForCrossRegionReceived,
  isCrossRegionProviderShareTarget,
  startProviderShareCrossRegion,
  stopProviderShareCrossRegion,
} from '../providerShareCrossRegion';
import { providerShareHostPeer } from '@cindy/device-link';
import { sha256Hex } from '../providerShareApi';
import { captureProviderShareGroupRecovery, getReceivedSharesSnapshot, isReceivedSharesReady, previewProviderShare, refreshReceivedShares, resolveRemoteAgentTargetWhenReady, sendProviderShareRequest, startProviderShareGuest, stopProviderShareGuest } from '../providerShareGuest';
import { createProviderGroupRemoteClient } from '../../provider-group/remoteClient';

const share = {
  shareId: 'share-x', memberId: 'member-x', providerId: 'openai', providerLabel: 'OpenAI', hostDeviceId: 'owner-pc',
  deviceName: 'Studio', owner: { displayName: 'Ann', avatarUrl: null, region: 'global' }, status: 'active',
  hostOnline: true, hostCapable: true,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Link/group regressions start after an earlier empty account discovery. */
async function startGuestAfterEmptyDiscovery(...args: Parameters<typeof startProviderShareGuest>) {
  const response = state.responses.get('/session');
  const endpointsGate = state.endpointsGate;
  const endpointHook = state.endpointHook;
  const identityHook = state.identityHook;
  const calls = state.calls.length;
  const cards = state.identityCards.length;
  state.responses.set('/session', { credential: null, expiresAt: null, shares: [] });
  state.endpointsGate = null;
  state.endpointHook = null;
  state.identityHook = null;
  try {
    startProviderShareGuest(...args);
    await refreshProviderShareCrossRegion('global');
    await refreshReceivedShares('test');
  } finally {
    if (response === undefined) state.responses.delete('/session');
    else state.responses.set('/session', response);
    state.endpointsGate = endpointsGate;
    state.endpointHook = endpointHook;
    state.identityHook = identityHook;
    // Keep the following scenario's request assertions separate from startup.
    state.calls.splice(calls);
    state.identityCards.splice(cards);
    state.cardOwners.splice(cards);
  }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-x-'));
  __testing.setUserDataDir(dir);
  state.calls = [];
  state.responses = new Map();
  state.clients = [];
  state.localReceivedError = false;
  state.localHasGroupShare = false;
  state.localReceivedReads = 0;
  state.localReceivedGate = null;
  state.endpointsGate = null;
  state.endpointHook = null;
  state.identityHook = null;
  state.cardOwners = [];
  state.userId = 'user-1';
  state.realm = 'cn';
  state.identityCards = [];
  state.invokes = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  stopProviderShareGuest();
  stopProviderShareCrossRegion();
  vi.useRealTimers();
  __testing.setUserDataDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cross-region provider share', () => {
  // Regression 2026-10-30, provider-sharing.md §8: membership belongs to the
  // account, not the accepting computer. Unit: real guest startup must publish
  // existing peer shares without an invitation, a group or a local region marker.
  // Earlier cases only entered discovery through those device-local prerequisites.
  it.each([
    { realm: 'cn', peer: 'global', record: 'missing' },
    { realm: 'global', peer: 'cn', record: 'empty' },
  ] as const)('automatically discovers $realm account shares with a $record local record', async ({ realm, peer, record }) => {
    state.realm = realm;
    if (record === 'empty') await __testing.writeMarker(sha256Hex(`${realm}:user-1`), peer, false, true);
    state.responses.set('/session', {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      shares: [{ ...share, owner: { ...share.owner, region: peer } }],
    });
    const changed = vi.fn();
    startProviderShareGuest({ changed, settled: vi.fn() }, { userDataDir: dir });
    await vi.waitFor(() => expect(getReceivedSharesSnapshot().received.map(item => item.shareId))
      .toEqual(['share-local', 'share-x']));
    // The snapshot precedes async marker persistence, client startup and the
    // changed event. Join automatic discovery without issuing another request.
    await waitForCrossRegionReceived();
    expect(changed).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ shareId: 'share-x' })]));
    expect(state.calls.map(call => call.path)).toEqual(['/api/device-link/provider-shares/x/session']);
    expect(state.calls[0].opts).toMatchObject({ token: null, baseUrl: peer === 'global' ? PEER : LOCAL, skipSessionInvalidation: true });
    expect(state.clients).toHaveLength(1);
    expect(Object.values(__testing.readMarkers())).toEqual([[peer]]);
  });

  it('automatically discovers a first share accepted on another computer after an empty startup', async () => {
    vi.useFakeTimers();
    try {
      state.responses.set('/session', { credential: null, expiresAt: null, shares: [] });
      const changed = vi.fn();
      startProviderShareCrossRegion({ changed }, { userDataDir: dir });
      await refreshProviderShareCrossRegion('global');
      expect(changed).toHaveBeenCalledOnce();
      expect(state.clients).toEqual([]);
      expect(__testing.readMarkers()).toEqual({});
      state.responses.set('/session', {
        credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share],
      });
      const discovered = deferred();
      changed.mockImplementation(() => discovered.resolve());
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await discovered.promise;
      expect(getCrossRegionReceived()).toEqual([share]);
      expect(state.calls.map(call => call.path)).toEqual(Array(2).fill('/api/device-link/provider-shares/x/session'));
      expect(state.clients).toHaveLength(1);
    } finally {
      stopProviderShareCrossRegion();
      vi.useRealTimers();
    }
  });

  it('discards late automatic discovery after another account starts its own discovery', async () => {
    const oldResponse = deferred<unknown>();
    state.responses.set('/session', oldResponse.promise);
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const oldRefresh = refreshProviderShareCrossRegion('global');
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    state.userId = 'user-2';
    const nextShare = { ...share, shareId: 'other-share', memberId: 'other-member' };
    state.responses.set('/session', {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [nextShare],
    });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await vi.waitFor(() => expect(getCrossRegionReceived()).toEqual([nextShare]));
    oldResponse.resolve({ credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] });
    await oldRefresh;
    // The old account settling does not mean the new account finished its I/O.
    await waitForCrossRegionReceived();
    expect(getCrossRegionReceived()).toEqual([nextShare]);
    expect(__testing.readMarkers()).toEqual({ [sha256Hex('cn:user-2')]: ['global'] });
    expect(state.clients).toHaveLength(1);
    expect(state.cardOwners).toEqual(['user-1', 'user-2']);
  });

  // Regression 2026-10-29 (provider-sharing.md sections 4.2 and 8): opening an
  // invitation on a new computer reported existing membership without restoring
  // its list. Existing coverage only restored applications and group references.
  // Unit: public guest preview/send -> peer response -> received list push and
  // persisted region; minimal input is ALREADY_MEMBER with no local marker.
  it.each(['preview', 'send'] as const)('restores existing membership discovered during %s without applying again', async (action) => {
    const memberError = Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' });
    state.responses.set('/preview', action === 'preview' ? memberError : {
      ...share, state: 'unused', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    state.responses.set('/requests', memberError);
    state.responses.set('/session', {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share],
    });
    const changed = vi.fn();
    await startGuestAfterEmptyDiscovery({ changed, settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    const invitation = { invitation: TOKEN, server: PEER };
    await expect(action === 'preview' ? previewProviderShare(invitation) : sendProviderShareRequest(invitation))
      .rejects.toBe(memberError);
    expect(getReceivedSharesSnapshot().received.map((item) => item.shareId)).toEqual(['share-local', 'share-x']);
    expect(changed).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ shareId: 'share-x' })]));
    expect(Object.values(__testing.readMarkers())).toEqual([['global']]);
    expect(state.calls.map((call) => call.path.replace('/api/device-link/provider-shares/x', '')))
      .toEqual(action === 'preview' ? ['/preview', '/session'] : ['/preview', '/requests', '/session']);
    expect(state.clients).toHaveLength(1);
    expect(await resolveRemoteAgentTargetWhenReady('share:share-local')).toBe(providerShareHostPeer('share-local', 'owner-pc'));
  });

  it.each(['preview', 'session'] as const)('ignores a late membership recovery %s after switching accounts', async (phase) => {
    const memberError = Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' });
    const response = deferred<unknown>();
    const session = { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] };
    state.responses.set('/preview', phase === 'preview' ? response.promise : memberError);
    state.responses.set('/session', phase === 'session' ? response.promise : session);
    const changed = vi.fn();
    await startGuestAfterEmptyDiscovery({ changed, settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    const rejected = expect(previewProviderShare({ invitation: TOKEN, server: PEER })).rejects.toBe(memberError);
    await vi.waitFor(() => expect(state.calls.some((call) => call.path.endsWith(`/${phase}`))).toBe(true));
    const markersBeforeSwitch = __testing.readMarkers();
    changed.mockClear();
    state.userId = 'user-2';
    response.resolve(phase === 'preview' ? memberError : session);
    await rejected;
    expect(__testing.readMarkers()).toEqual(markersBeforeSwitch);
    expect(getCrossRegionReceived()).toEqual([]);
    expect(state.clients).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(phase === 'preview' ? 1 : 2);
  });

  // Review regression: guest-entry awaits can outlive an account switch before
  // cross-region recovery captures its runtime; peer-request-only tests missed this.
  it.each(['preview', 'send'] as const)('does not resume an old-account %s after asynchronous link resolution', async (action) => {
    const endpoints = deferred();
    state.endpointsGate = endpoints.promise;
    const memberError = Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' });
    state.responses.set('/preview', memberError);
    state.responses.set('/requests', memberError);
    state.responses.set('/session', {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share],
    });
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const invitation = { invitation: TOKEN, server: PEER };
    const result = (action === 'preview' ? previewProviderShare(invitation) : sendProviderShareRequest(invitation))
      .catch((error: unknown) => error);
    state.userId = 'user-2';
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    endpoints.resolve();
    const error = await result;
    expect(__testing.readMarkers()).toEqual({});
    expect(getCrossRegionReceived()).toEqual([]);
    expect(state.calls).toEqual([]);
    expect(state.clients).toEqual([]);
    expect(error).toMatchObject({ code: 'DEVICE_LINK_NOT_CONNECTED' });
  });

  it('does not send an old-account application after its preview finishes under a new account', async () => {
    const preview = deferred<unknown>();
    state.responses.set('/preview', preview.promise);
    state.responses.set('/requests', Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' }));
    state.responses.set('/session', {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share],
    });
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const result = sendProviderShareRequest({ invitation: TOKEN, server: PEER }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(state.calls.some((call) => call.path.endsWith('/preview'))).toBe(true));
    state.userId = 'user-2';
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    preview.resolve(Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' }));
    const error = await result;
    expect(__testing.readMarkers()).toEqual({});
    expect(getCrossRegionReceived()).toEqual([]);
    expect(state.calls.map((call) => call.path)).toEqual(['/api/device-link/provider-shares/x/preview']);
    expect(state.clients).toEqual([]);
    expect(error).toMatchObject({ code: 'DEVICE_LINK_NOT_CONNECTED' });
  });

  it('refreshes existing membership behind an obsolete empty list', async () => {
    const oldSession = deferred<unknown>();
    const memberError = Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' });
    state.responses.set('/session', oldSession.promise);
    state.responses.set('/preview', memberError);
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const oldRefresh = refreshProviderShareCrossRegion('global');
    await vi.waitFor(() => expect(state.calls.filter((call) => call.path.endsWith('/session'))).toHaveLength(1));
    state.responses.set('/session', {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share],
    });
    const rejected = expect(previewProviderShare({ invitation: TOKEN, server: PEER })).rejects.toBe(memberError);
    try {
      await vi.waitFor(() => expect(Object.values(__testing.readMarkers())).toEqual([['global']]));
    } finally {
      oldSession.resolve({ credential: null, expiresAt: null, shares: [] });
      await oldRefresh;
      await rejected;
    }
    expect(getCrossRegionReceived()).toEqual([share]);
    expect(Object.values(__testing.readMarkers())).toEqual([['global']]);
    expect(__testing.readMarkers('emptyAccounts')).toEqual({});
    expect(state.calls.filter((call) => call.path.endsWith('/session'))).toHaveLength(2);
  });

  it('remembers confirmed membership through a network failure and restores it on restart', async () => {
    const memberError = Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' });
    state.responses.set('/preview', memberError);
    state.responses.set('/session', new Error('network unavailable'));
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    await expect(previewProviderShare({ invitation: TOKEN, server: PEER })).rejects.toBe(memberError);
    expect(Object.values(__testing.readMarkers())).toEqual([['global']]);
    expect(isReceivedSharesReady()).toBe(false);
    await expect(resolveRemoteAgentTargetWhenReady('share:share-local')).resolves.toBe(providerShareHostPeer('share-local', 'owner-pc'));
    stopProviderShareGuest();
    state.responses.set('/session', {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share],
    });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshProviderShareCrossRegion('global');
    expect(getCrossRegionReceived()).toEqual([share]);
    expect(state.calls.filter((call) => !call.path.endsWith('/session'))).toHaveLength(1);
  });

  it('does not restore membership for a used invitation without server confirmation', async () => {
    const usedError = Object.assign(new Error('link used'), { code: 'PROVIDER_SHARE_LINK_USED' });
    state.responses.set('/preview', usedError);
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await expect(previewProviderShare({ invitation: TOKEN, server: PEER })).rejects.toBe(usedError);
    expect(__testing.readMarkers()).toEqual({});
    expect(state.calls.map((call) => call.path)).toEqual(['/api/device-link/provider-shares/x/preview']);
    expect(state.clients).toEqual([]);
  });

  // Regression 2026-10-26: a same-account group can use a cross-region share that this
  // computer has never joined. Existing tests only restored locally marked accounts.
  // Unit: real group view/pick -> guest resolution -> cross-region catalog transport;
  // the minimal input is one authorized shared member and no local region marker.
  function remoteGroup(response?: Promise<unknown>) {
    const member = { key: 'share:share-x:openai', kind: 'share', agentDeviceId: 'share:share-x',
      providerId: 'openai', limit: 4, weight: 1, paused: false };
    const view = { providerId: 'openai', config: { strategy: 'least', autoSwitch: true, members: [member] },
      members: [{ ...member, label: 'Ann', state: 'available', running: 0 }] };
    const client = createProviderGroupRemoteClient(async (_device, _channel, args) => ({
      ok: true,
      result: response ? await response : (args[0] as { action: string }).action === 'pick'
        ? { kind: 'member', member, label: 'Ann' } : view,
    }), { captureShareRecovery: captureProviderShareGroupRecovery });
    return { client, view };
  }

  it.each(['view', 'pick'] as const)('restores an authorized cross-region group member on %s without another invitation', async (action) => {
    state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    expect(__testing.readMarkers()).toEqual({});
    const { client } = remoteGroup();
    if (action === 'view') await Promise.all([client.view('group-owner', 'openai'), client.view('group-owner', 'openai')]);
    else await client.pick('group-owner', { sessionId: 'task', providerId: 'openai', agentKind: 'codex', model: 'model', exclude: [] });
    const target = await resolveRemoteAgentTargetWhenReady('share:share-x');
    expect(target).toBe(providerShareHostPeer('share-x', 'owner-pc'));
    await expect(crossRegionInvoke(target, 'maker:provider:list', []))
      .resolves.toEqual({ ok: true, result: { providers: [{ id: 'openai' }] } });
    expect(state.invokes).toEqual([{ target, channel: 'maker:provider:list' }]);
    expect(state.calls.map((call) => call.path)).toEqual(['/api/device-link/provider-shares/x/session']);
    expect(state.calls[0].opts).toMatchObject({ token: null, baseUrl: PEER, skipSessionInvalidation: true });
    expect(Object.values(__testing.readMarkers())).toEqual([['global']]);
    await client.view('group-owner', 'openai');
    expect(state.calls).toHaveLength(1);
  });

  it('refreshes a newly received same-region group share without contacting the peer region', async () => {
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    state.localHasGroupShare = true;
    await remoteGroup().client.view('group-owner', 'openai');
    const target = await resolveRemoteAgentTargetWhenReady('share:share-x');
    expect(target).toBe(providerShareHostPeer('share-x', 'owner-pc'));
    expect(isCrossRegionProviderShareTarget(target)).toBe(false);
    expect(state.calls).toEqual([]);
    expect(__testing.readMarkers()).toEqual({});
  });

  it.each(['paused', 'removed'] as const)('does not turn a group reference into permission for a %s share', async (status) => {
    state.responses.set('/session', { credential: status === 'removed' ? null : CREDENTIAL,
      expiresAt: status === 'removed' ? null : new Date(Date.now() + 86_400_000).toISOString(),
      shares: status === 'removed' ? [] : [{ ...share, status }] });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const { client } = remoteGroup();
    await client.view('group-owner', 'openai');
    await expect(resolveRemoteAgentTargetWhenReady('share:share-x')).rejects.toThrow(
      status === 'paused' ? 'REMOTE_AGENT_SHARE_PAUSED' : 'REMOTE_AGENT_SHARE_REMOVED');
    expect(state.calls).toHaveLength(1);
    expect(state.invokes).toEqual([]);
    if (status === 'removed') expect(__testing.readMarkers()).toEqual({});
  });

  it('keeps a failed group recovery unavailable, respects retry backoff and leaves local shares usable', async () => {
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const { client } = remoteGroup();
    await client.view('group-owner', 'openai');
    await expect(resolveRemoteAgentTargetWhenReady('share:share-x')).rejects.toThrow('DEVICE_LINK_NOT_CONNECTED');
    const localReads = state.localReceivedReads;
    await client.view('group-owner', 'openai');
    await expect(resolveRemoteAgentTargetWhenReady('share:share-x')).rejects.toThrow('DEVICE_LINK_NOT_CONNECTED');
    expect(state.localReceivedReads).toBe(localReads);
    expect(state.calls).toHaveLength(1);
    await expect(resolveRemoteAgentTargetWhenReady('share:share-local')).resolves.toBe(providerShareHostPeer('share-local', 'owner-pc'));
    expect(state.clients).toEqual([]);
  });

  it('resolves a newly loaded local share while an unrelated cross-region recovery is pending', async () => {
    const local = deferred();
    const peer = deferred<unknown>();
    state.localReceivedGate = local.promise;
    state.responses.set('/session', peer.promise);
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await remoteGroup().client.view('group-owner', 'openai');
    let target: string | undefined;
    const route = resolveRemoteAgentTargetWhenReady('share:share-local').then((value) => { target = value; });
    const peerRoute = resolveRemoteAgentTargetWhenReady('share:share-x').catch(() => undefined);
    local.resolve();
    try {
      await vi.waitFor(() => expect(target).toBe(providerShareHostPeer('share-local', 'owner-pc')));
      expect(getCrossRegionReceived()).toEqual([]);
    } finally {
      peer.resolve({ credential: null, expiresAt: null, shares: [] });
      await Promise.all([route, peerRoute]);
    }
  });

  it.each(['group', 'session'] as const)('does not restore another account from a late %s response', async (phase) => {
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    const response = deferred<unknown>();
    if (phase === 'session') state.responses.set('/session', response.promise);
    const { client, view } = remoteGroup(phase === 'group' ? response.promise : undefined);
    const pending = client.view('group-owner', 'openai');
    let route: Promise<string> | undefined;
    let rejected: Promise<void> | undefined;
    if (phase === 'session') {
      await pending;
      await vi.waitFor(() => expect(state.calls).toHaveLength(1));
      route = resolveRemoteAgentTargetWhenReady('share:share-x');
      rejected = expect(route).rejects.toThrow('DEVICE_LINK_NOT_CONNECTED');
    }
    const markersBeforeSwitch = __testing.readMarkers();
    state.userId = 'user-2';
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    response.resolve(phase === 'group' ? view : {
      credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share],
    });
    await pending;
    await rejected;
    expect(state.calls).toHaveLength(phase === 'group' ? 0 : 1);
    // The old account can retain its own already-written marker; the new account gains none.
    expect(__testing.readMarkers()).toEqual(markersBeforeSwitch);
    expect(getCrossRegionReceived()).toEqual([]);
    expect(state.clients).toEqual([]);
  });

  it('serializes marker read-modify-write across accounts and regions', async () => {
    const firstAccount = 'a'.repeat(64);
    const secondAccount = 'b'.repeat(64);
    await __testing.writeMarker(firstAccount, 'global', true);
    const entered = deferred();
    const release = deferred();
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return rename(...args);
    });
    const first = __testing.writeMarker(firstAccount, 'global', false, true);
    await entered.promise;
    const second = __testing.writeMarker(secondAccount, 'cn', true);
    release.resolve();
    await Promise.all([first, second]);
    expect(__testing.readMarkers()).toEqual({ [secondAccount]: ['cn'] });
    expect(__testing.readMarkers('emptyAccounts')).toEqual({ [firstAccount]: ['global'] });
  });

  it('continues queued marker writes after a storage failure', async () => {
    const account = 'a'.repeat(64);
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('temporary storage failure'));
    const failed = __testing.writeMarker(account, 'global', false, true);
    const next = __testing.writeMarker(account, 'global', true);
    await expect(failed).rejects.toThrow('temporary storage failure');
    await next;
    expect(__testing.readMarkers()).toEqual({ [account]: ['global'] });
    expect(__testing.readMarkers('emptyAccounts')).toEqual({});
  });

  it.each(['response', 'write'] as const)('keeps a new application when the old empty %s completes late', async (phase) => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    const active = __testing.readMarkers();
    const oldResponse = deferred<unknown>();
    const freshResponse = deferred<unknown>();
    const writeEntered = deferred();
    const releaseWrite = deferred();
    state.responses.set('/session', oldResponse.promise);
    const changed = vi.fn();
    startProviderShareCrossRegion({ changed }, { userDataDir: dir });
    const oldRefresh = refreshProviderShareCrossRegion('global');
    await vi.waitFor(() => expect(state.calls.some((call) => call.path.endsWith('/session'))).toBe(true));
    if (phase === 'write') {
      const writeFile = fsp.writeFile.bind(fsp);
      vi.spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
        await writeFile(...args);
        writeEntered.resolve();
        await releaseWrite.promise;
      });
      oldResponse.resolve({ credential: null, expiresAt: null, shares: [] });
      await writeEntered.promise;
    }
    state.responses.set('/session', freshResponse.promise);
    const application = crossRegionSendRequest('global', TOKEN);
    // Request parsing only crosses microtasks before queuing its disk write.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    if (phase === 'response') await application;
    oldResponse.resolve({ credential: null, expiresAt: null, shares: [] });
    releaseWrite.resolve();
    await Promise.all([application, oldRefresh]);
    expect(__testing.readMarkers()).toEqual(active);
    expect(__testing.readMarkers('emptyAccounts')).toEqual({});
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    // A pending application alone must not trigger another empty list lookup.
    expect(state.calls.filter((call) => call.path.endsWith('/session'))).toHaveLength(1);
    freshResponse.resolve({ credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] });
    await refreshProviderShareCrossRegion('global');
    expect(getCrossRegionReceived()).toEqual([share]);
    expect(changed).toHaveBeenCalledOnce();
    expect(__testing.readMarkers()).toEqual(active);
    stopProviderShareCrossRegion();
    startProviderShareCrossRegion({ changed: vi.fn() }, { userDataDir: dir });
    await refreshProviderShareCrossRegion('global');
    expect(getCrossRegionReceived()).toEqual([share]);
  });

  it('keeps existing membership confirmed and refreshes approval behind an obsolete request', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] });
    startProviderShareCrossRegion({ changed: vi.fn() }, { userDataDir: dir });
    await refreshProviderShareCrossRegion('global');
    const staleResponse = deferred<unknown>();
    state.responses.set('/session', staleResponse.promise);
    const pending = refreshProviderShareCrossRegion('global');
    await vi.waitFor(() => expect(state.calls.filter((call) => call.path.endsWith('/session'))).toHaveLength(2));
    await crossRegionSendRequest('global', TOKEN);
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual(['global']);
    const newShare = { ...share, shareId: 'new-share', memberId: 'new-member' };
    state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share, newShare] });
    const approved = refreshProviderShareCrossRegion('global');
    const anotherWindow = refreshProviderShareCrossRegion('global');
    staleResponse.resolve({ credential: null, expiresAt: null, shares: [] });
    await Promise.all([pending, approved, anotherWindow]);
    expect(state.calls.filter((call) => call.path.endsWith('/session'))).toHaveLength(3);
    expect(getCrossRegionReceived()).toEqual([share, newShare]);
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual(['global']);
    expect(__testing.readMarkers('emptyAccounts')).toEqual({});
  });

  it('discovers the account once without letting favorite hints or old history add requests', async () => {
    state.responses.set('/session', { credential: null, expiresAt: null, shares: [] });
    const probe = async () => {
      startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
      await refreshReceivedShares('test');
      await refreshProviderShareCrossRegion('global');
      for (let i = 0; i < 3; i += 1) {
        getReceivedSharesSnapshot({ ownerStamp: { dataOwnerId: state.userId, ownerGeneration: 1 }, regions: ['global'] });
      }
      await expect(resolveRemoteAgentTargetWhenReady('share:unknown')).rejects.toThrow('REMOTE_AGENT_SHARE_REMOVED');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.identityCards).toEqual(['share-session']);
      expect(state.calls.map(call => call.path)).toEqual(['/api/device-link/provider-shares/x/session']);
      expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn', 'global']);
      stopProviderShareGuest();
    };
    await probe();
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    const oldHistory = __testing.readMarkers();
    fs.writeFileSync(path.join(dir, 'remote-agent', 'provider-share-regions.json'), JSON.stringify({ version: 1, accounts: {}, knownAccounts: oldHistory }));
    state.calls = [];
    state.identityCards = [];
    await probe(); // 旧历史不增加自动发现之外的请求，空名单仍取服务端结果。
    state.userId = 'user-2';
    state.calls = [];
    state.identityCards = [];
    await probe();
  });

  it('rechecks a saved empty list on restart without adding favorite-triggered requests', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    // 兼容旧版活动标记；服务端空名单与撤销联网资格在同一次写入中保存。
    fs.writeFileSync(path.join(dir, 'remote-agent', 'provider-share-regions.json'), JSON.stringify({ version: 1, accounts: __testing.readMarkers() }));
    state.responses.set('/session', { credential: null, expiresAt: null, shares: [] });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    await refreshProviderShareCrossRegion('global');
    expect(__testing.readMarkers()).toEqual({});
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'remote-agent', 'provider-share-regions.json'), 'utf8'));
    expect(Object.values(saved.emptyAccounts)).toEqual([['global']]);
    expect(saved.knownAccounts).toBeUndefined();
    state.calls = [];
    state.identityCards = [];
    const recovery = { ownerStamp: { dataOwnerId: 'user-1', ownerGeneration: 1 }, regions: ['global'] as const };
    for (let restart = 0; restart < 3; restart += 1) {
      stopProviderShareGuest();
      startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
      await refreshReceivedShares('test');
      await refreshProviderShareCrossRegion('global');
      // 每次启动按账号核验一次；收藏、多窗口读取不追加发现请求。
      expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn', 'global']);
      expect(getReceivedSharesSnapshot(recovery).confirmedRegions).toEqual(['cn', 'global']);
      getReceivedSharesSnapshot(recovery);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.calls).toHaveLength(restart + 1);
      expect(state.identityCards).toEqual(Array.from({ length: restart + 1 }, () => 'share-session'));
      expect(state.clients).toEqual([]);
    }
    state.userId = 'user-2';
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
  });

  it('invalidates a saved empty list on a new application and never infers revocation from missing credentials', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.responses.set('/session', { credential: null, expiresAt: null, shares: [] });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshProviderShareCrossRegion('global');
    await crossRegionSendRequest('global', TOKEN);
    state.responses.delete('/session');
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    await refreshProviderShareCrossRegion('global');
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
    state.responses.set('/session', { credential: null, expiresAt: null, shares: [share] });
    await refreshProviderShareCrossRegion('global');
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
  });

  it('keeps network backoff when favorite recovery is requested repeatedly', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.calls = [];
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    const recovery = { ownerStamp: { dataOwnerId: 'user-1', ownerGeneration: 1 }, regions: ['global'] as const };
    getReceivedSharesSnapshot(recovery);
    await refreshProviderShareCrossRegion('global');
    expect(state.calls).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) getReceivedSharesSnapshot(recovery);
    await Promise.resolve();
    expect(state.calls).toHaveLength(1);
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
  });

  it.each(['local', 'peer'] as const)('confirms the available region independently when %s list loading fails', async (failed) => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.localReceivedError = failed === 'local';
    if (failed === 'local') state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    await refreshProviderShareCrossRegion('global');
    const snapshot = getReceivedSharesSnapshot();
    expect(isReceivedSharesReady()).toBe(false);
    expect(snapshot.confirmedRegions).toEqual([failed === 'local' ? 'global' : 'cn']);
    expect(snapshot.received.map((item) => item.shareId)).toEqual([failed === 'local' ? 'share-x' : 'share-local']);
    const usable = failed === 'local' ? 'share-x' : 'share-local';
    await expect(resolveRemoteAgentTargetWhenReady(`share:${usable}`)).resolves.toBe(providerShareHostPeer(usable, 'owner-pc'));
  });

  it('does not confirm an incomplete or failed peer list for favorite cleanup', async () => {
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    startProviderShareCrossRegion({ changed: vi.fn() }, { userDataDir: dir });
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    await refreshProviderShareCrossRegion('global');
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    state.responses.set('/session', { credential: null, expiresAt: null, deviceId: 'x:cn:abc', shares: [] });
    await refreshProviderShareCrossRegion('global');
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual(['global']);
    stopProviderShareCrossRegion();
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
  });

  it.each([true, false])('waits for account discovery before reporting received shares ready (empty=%s)', async (empty) => {
    expect(isCrossRegionReceivedReady()).toBe(true);
    const session = deferred<unknown>();
    state.responses.set('/session', session.promise);
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
    expect(isCrossRegionReceivedReady()).toBe(false);
    expect(isReceivedSharesReady()).toBe(false);
    const route = resolveRemoteAgentTargetWhenReady('share:share-x');
    const resolved = empty
      ? expect(route).rejects.toThrow('REMOTE_AGENT_SHARE_REMOVED')
      : expect(route).resolves.toBe(providerShareHostPeer('share-x', 'owner-pc'));
    session.resolve({
      credential: empty ? null : CREDENTIAL,
      expiresAt: empty ? null : new Date(Date.now() + 86_400_000).toISOString(),
      shares: empty ? [] : [share],
    });
    await refreshProviderShareCrossRegion('global');
    await resolved;
    expect(isCrossRegionReceivedReady()).toBe(true);
    expect(isReceivedSharesReady()).toBe(true);
    expect(getReceivedSharesSnapshot().received.map((item) => item.shareId))
      .toEqual(empty ? ['share-local'] : ['share-local', 'share-x']);
  });

  it('only accepts the two official regions', async () => {
    await expect(crossRegionOfIntent({ invitation: TOKEN, server: LOCAL }, LOCAL)).resolves.toBeNull();
    await expect(crossRegionOfIntent({ invitation: TOKEN, server: PEER }, LOCAL)).resolves.toBe('global');
    await expect(crossRegionOfIntent({ invitation: TOKEN, server: 'https://evil.example' }, LOCAL)).rejects.toThrow();
  });

  it('sends requests with an identity card only and remembers the region without secrets', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    const sent = await crossRegionSendRequest('global', TOKEN);
    expect(sent.requestToken).toBe(TOKEN);
    expect(state.calls[0].opts).toMatchObject({ token: null, skipAutoRefresh: true, skipSessionInvalidation: true, baseUrl: PEER });
    expect(state.calls[0].opts.headers).toBeUndefined();
    expect((state.calls[0].opts.body as { identityCard: string }).identityCard).toMatch(/^card:share-request:/);
    const markers = __testing.readMarkers();
    expect(Object.values(markers)).toEqual([['global']]);
    expect(fs.readFileSync(path.join(dir, 'remote-agent', 'provider-share-regions.json'), 'utf8')).not.toContain(TOKEN);
  });

  it('automatically connects with only the account share credential', async () => {
    state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), deviceId: 'x:cn:abc', shares: [share] });
    const changed = vi.fn();
    startProviderShareCrossRegion({ changed }, { userDataDir: dir });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(state.calls[0].path).toBe('/api/device-link/provider-shares/x/session');
    expect(state.calls[0].opts.token).toBeNull();
    expect(getCrossRegionReceived().map((item) => item.shareId)).toEqual(['share-x']);
    expect(isCrossRegionProviderShareTarget(providerShareHostPeer('share-x', 'owner-pc'))).toBe(true);
    expect(isCrossRegionProviderShareTarget(providerShareHostPeer('share-y', 'owner-pc'))).toBe(false);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0].opts.authorizationScheme).toBe('ProviderShareGuest');
    await expect((state.clients[0].opts.getToken as () => Promise<string | null>)()).resolves.toBe(CREDENTIAL);
    expect((state.clients[0].opts.getHello as () => { remoteControlEnabled: boolean })().remoteControlEnabled).toBe(false);

    stopProviderShareCrossRegion();
    expect(state.clients[0].stopped).toBe(true);
    expect(getCrossRegionReceived()).toEqual([]);
  });

  it('forgets the region once the peer reports no shares', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.responses.set('/session', { credential: null, expiresAt: null, deviceId: 'x:cn:abc', shares: [] });
    const changed = vi.fn();
    startProviderShareCrossRegion({ changed }, { userDataDir: dir });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await vi.waitFor(() => expect(__testing.readMarkers()).toEqual({}));
    expect(state.clients).toHaveLength(0);
  });
});

// Unit regression for the 8c ALREADY_MEMBER recovery: public guest requests must
// not issue/send another owner's card after an internal endpoint or identity await.
// Existing cases switch during link resolution/HTTP, missing these inner boundaries.
// Minimal input: one deferred boundary, owner replacement, then its late completion.
// Only endpoint/card/server edges are fake; guest and cross-region control stay real.
describe('cross-region identity request owner boundary', () => {
  it.each([
    { point: 'endpoint', switched: true },
    { point: 'identity', switched: true },
    { point: 'identity', switched: false },
  ] as const)('keeps membership recovery scoped at $point (switched=$switched)', async ({ point, switched }) => {
    const entered = deferred();
    const resume = deferred();
    let endpoints = 0;
    state.endpointHook = async () => {
      if (++endpoints === 3 && point === 'endpoint') { entered.resolve(); await resume.promise; }
    };
    state.identityHook = async purpose => {
      if (purpose === 'share-session' && point === 'identity') { entered.resolve(); await resume.promise; }
    };
    state.responses.set('/preview', Object.assign(new Error('already a member'), { code: 'PROVIDER_SHARE_ALREADY_MEMBER' }));
    state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] });
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const result = previewProviderShare({ invitation: TOKEN, server: PEER }).catch(error => error);
    await entered.promise;
    if (switched) {
      state.userId = 'user-2';
      await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    }
    resume.resolve();
    expect(await result).toMatchObject({ code: 'PROVIDER_SHARE_ALREADY_MEMBER' });
    expect(state.cardOwners).toEqual(point === 'endpoint' ? ['user-1'] : ['user-1', 'user-1']);
    expect(state.calls.map(call => call.path.replace('/api/device-link/provider-shares/x', '')))
      .toEqual(switched ? ['/preview'] : ['/preview', '/session']);
    expect(state.clients).toHaveLength(switched ? 0 : 1);
    expect(getCrossRegionReceived().map(item => item.shareId)).toEqual(switched ? [] : ['share-x']);
  });

  it.each([
    { action: 'preview', point: 'endpoint' }, { action: 'preview', point: 'identity' },
    { action: 'send', point: 'endpoint' }, { action: 'send', point: 'identity' },
  ] as const)('rejects old-owner $action at its $point boundary', async ({ action, point }) => {
    const entered = deferred();
    const resume = deferred();
    let endpoints = 0;
    let cards = 0;
    state.endpointHook = async () => {
      if (++endpoints === (action === 'preview' ? 2 : 3) && point === 'endpoint') { entered.resolve(); await resume.promise; }
    };
    state.identityHook = async () => {
      if (++cards === (action === 'preview' ? 1 : 2) && point === 'identity') { entered.resolve(); await resume.promise; }
    };
    state.responses.set('/preview', { ...share, state: 'unused', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    const input = { invitation: TOKEN, server: PEER };
    const result = (action === 'preview' ? previewProviderShare(input) : sendProviderShareRequest(input)).catch(error => error);
    await entered.promise;
    state.userId = 'user-2';
    await startGuestAfterEmptyDiscovery({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    resume.resolve();
    expect(await result).toMatchObject({ code: 'DEVICE_LINK_NOT_CONNECTED' });
    const issued = (action === 'send' ? 1 : 0) + (point === 'identity' ? 1 : 0);
    expect(state.cardOwners).toEqual(Array.from({ length: issued }, () => 'user-1'));
    expect(state.calls.map(call => call.path.replace('/api/device-link/provider-shares/x', '')))
      .toEqual(action === 'preview' ? [] : ['/preview']);
    expect(__testing.readMarkers()).toEqual({});
    expect(state.clients).toHaveLength(0);
  });
});
