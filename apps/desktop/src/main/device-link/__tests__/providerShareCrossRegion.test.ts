/**
 * 跨区域受邀者(P3)：只认两个官方区域；不把本区域 Access Token 发给对方区域，也不会因对方区域的
 * 401 登出本账号；只有发过申请或加入过分享的账号才会联系对方区域；凭证只在内存里。
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
  userId: 'user-1',
  identityCards: [] as string[],
}));

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
vi.mock('ws', () => ({ default: class {} }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: () => false,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: state.userId, ownerGeneration: 1 }),
}));
vi.mock('../../authManager.js', () => ({
  getActiveAuthRealm: () => 'cn',
  getAuthState: () => ({ isAuthenticated: true }),
  getCurrentUserId: () => state.userId,
  getDeviceId: () => 'device-1',
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => LOCAL,
  loadClientEndpointsForRealm: async () => ({}),
  getClientEndpointForRealm: (region: string) => (region === 'global' ? PEER : LOCAL),
}));
vi.mock('../../maker-host/outbound-fetch.js', () => ({ createOutboundHttpAgent: async () => undefined }));
vi.mock('../deviceName.js', () => ({ deviceName: () => 'Laptop' }));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: async (apiPath: string, opts: Record<string, unknown>) => {
    state.calls.push({ path: apiPath, opts });
    const key = apiPath.replace('/api/device-link/provider-shares/x', '');
    if (!state.responses.has(key)) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    return state.responses.get(key);
  },
}));
vi.mock('../providerShareApi.js', () => ({
  providerShareOwnerKey: () => state.userId,
  providerShareApi: {
    listReceived: async () => {
      if (state.localReceivedError) throw new Error('local unavailable');
      return [{ ...share, shareId: 'share-local', memberId: 'member-local', owner: { ...share.owner, region: 'cn' } }];
    },
  },
  fetchIdentityCard: async (purpose: string, nonce: string) => {
    state.identityCards.push(purpose);
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
  },
}));

import {
  __testing,
  crossRegionOfIntent,
  crossRegionSendRequest,
  getCrossRegionReceived,
  getConfirmedCrossRegionReceivedRegions,
  isCrossRegionReceivedReady,
  refreshProviderShareCrossRegion,
  isCrossRegionProviderShareTarget,
  startProviderShareCrossRegion,
  stopProviderShareCrossRegion,
} from '../providerShareCrossRegion';
import { providerShareHostPeer } from '@cindy/device-link';
import { getReceivedSharesSnapshot, isReceivedSharesReady, refreshReceivedShares, startProviderShareGuest, stopProviderShareGuest } from '../providerShareGuest';

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

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-x-'));
  __testing.setUserDataDir(dir);
  state.calls = [];
  state.responses = new Map();
  state.clients = [];
  state.localReceivedError = false;
  state.userId = 'user-1';
  state.identityCards = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  stopProviderShareGuest();
  stopProviderShareCrossRegion();
  __testing.setUserDataDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cross-region provider share', () => {
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

  it('does not send identity cards for forged favorite hints or another account history', async () => {
    const probe = async () => {
      startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
      await refreshReceivedShares('test');
      for (let i = 0; i < 3; i += 1) {
        getReceivedSharesSnapshot({ ownerStamp: { dataOwnerId: state.userId, ownerGeneration: 1 }, regions: ['global'] });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.identityCards).toEqual([]);
      expect(state.calls).toEqual([]);
      expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
      stopProviderShareGuest();
    };
    await probe();
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    const oldHistory = __testing.readMarkers();
    fs.writeFileSync(path.join(dir, 'remote-agent', 'provider-share-regions.json'), JSON.stringify({ version: 1, accounts: {}, knownAccounts: oldHistory }));
    state.calls = [];
    state.identityCards = [];
    await probe(); // 历史往来不能作为联网资格，也不能被当作服务端空名单。
    state.userId = 'user-2';
    state.calls = [];
    state.identityCards = [];
    await probe();
  });

  it('restores confirmed empty membership locally after restart without granting favorite hints network access', async () => {
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
      // 首次读取即可清理失败残留；之后伪造收藏、多窗口查询和再重启也不会发身份名片。
      expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn', 'global']);
      expect(getReceivedSharesSnapshot(recovery).confirmedRegions).toEqual(['cn', 'global']);
      getReceivedSharesSnapshot(recovery);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.calls).toEqual([]);
      expect(state.identityCards).toEqual([]);
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

  it.each([true, false])('waits for a marked peer region before reporting received shares ready (empty=%s)', async (empty) => {
    expect(isCrossRegionReceivedReady()).toBe(true);
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    expect(isReceivedSharesReady()).toBe(false);
    await refreshReceivedShares('test');
    expect(isReceivedSharesReady()).toBe(true);
    expect(state.calls).toEqual([]);
    stopProviderShareGuest();

    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    const session = deferred<unknown>();
    state.responses.set('/session', session.promise);
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
    expect(isCrossRegionReceivedReady()).toBe(false);
    expect(isReceivedSharesReady()).toBe(false);
    session.resolve({
      credential: empty ? null : CREDENTIAL,
      expiresAt: empty ? null : new Date(Date.now() + 86_400_000).toISOString(),
      shares: empty ? [] : [share],
    });
    await refreshProviderShareCrossRegion('global');
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

  it('contacts the peer region only for marked accounts, then connects with the share credential', async () => {
    startProviderShareCrossRegion({ changed: vi.fn() }, { userDataDir: dir });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.calls).toHaveLength(0);
    stopProviderShareCrossRegion();

    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.calls = [];
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
