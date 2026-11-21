/** Test value: real Main sharing vault/API + real SDK request signatures.
 * Agent-Net independent/self-hosted parity and credential isolation; old API
 * tests mocked this boundary and SDK tests did not exercise OS-vault selection.
 * Minimal failures: a private relay receives a Bearer token; a conflicting root
 * retargets a saved resource; an account change publishes a late join.
 * Unit: memory filesystem/OS-vault/auth/network boundaries; no user data/I/O.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDelegation, generateIdentity, createPrivateNetwork, issueCertificate, signature, verifyRequestProof } from '@cindy/agent-net-relay';
import { delegationPayload, type Delegation } from '@cindy/agent-net-protocol';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import { buildAgentNetSharingInvitation, parseAgentNetSharingInvitation } from '@cindy/agent-net';
import { RoutedDeviceLinkClient, providerShareGuestPeer, providerShareHostPeer, sharedTaskGuestPeer, sharedTaskHostPeer } from '@cindy/device-link';
const state = vi.hoisted(() => ({ key: 'owner-a', pending: false, api: null as any,
  relay: null as any, config: null as any, allowLegacy: false, privateSharing: false,
  files: new Map<string, string>(), writes: [] as string[], http: vi.fn(), card: vi.fn(), agentNetEnabled: true, onlyEncrypted: false,
  sessionRoute: null as null | ((peer: string) => unknown),
  scopedTarget: vi.fn(),
}));
vi.mock('node:fs', () => ({ default: {
  existsSync: (file: string) => state.files.has(file), statSync: (file: string) => ({ size: state.files.get(file)?.length ?? 0 }),
  readFileSync: (file: string) => state.files.get(file), mkdirSync() {},
  writeFileSync(file: string, data: string) { state.files.set(file, data); state.writes.push(file); },
  renameSync(from: string, to: string) { state.files.set(to, state.files.get(from)!); state.files.delete(from); },
  rmSync: (file: string) => state.files.delete(file),
} }));
vi.mock('electron', () => ({ safeStorage: {
  encryptString: (value: string) => Buffer.from('unit-vault:' + value),
  decryptString: (value: Buffer) => value.toString().slice('unit-vault:'.length),
} }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.key, isAppSessionBoundaryPending: () => state.pending }));
vi.mock('../../authManager.js', () => ({ getCurrentUserId: () => 'account-' + state.key, getDeviceId: () => 'self-device',
  getActiveAuthRealm: () => 'global',
  getAuthState: () => ({ isAuthenticated: true }) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://auth.example.test' }));
vi.mock('../../serverApiClient.desktop.js', () => ({ serverApiFetch: state.card }));
vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({ outboundFetch: state.http }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => null }));
vi.mock('../../localDb/sharedTasks.js', () => ({ createSharedTaskJournal: () => ({ latest: async () => [] }) }));
vi.mock('../selfHostedRelayConfig.js', () => ({ secureStorageAvailable: () => true,
  readRelayConfig: () => state.config,
  relayDataPath: (_area: string, file: string) => '/unit-only-vault/' + state.key + '/' + (file === 'sharing-v3.enc' ? file : 'sharing.enc') }));
vi.mock('../selfHostedRelayRouting.js', () => ({ activeSelfHostedRelay: () => state.relay }));
vi.mock('../settings-store.desktop.js', () => ({ readDeviceLinkSettings: () => ({ agentNetEnabled: state.agentNetEnabled }) }));
// Production accessors refuse a pending account boundary; only the outgoing
// variants used by the handover close still resolve the old owner's client.
vi.mock('../agentNetRuntime.js', () => ({ supportsPrivateAgentNetSharing: () => state.privateSharing, currentAgentNetClient: () => state.pending ? null : state.api, isAgentNetActive: () => true,
  currentAgentNetScopedTarget: state.scopedTarget,
  outgoingAgentNetClient: () => state.api, outgoingAgentNetClientForRelay: () => { throw new Error('AGENT_NET_IDENTITY_MISMATCH'); },
  agentNetAllowsLegacy: () => state.allowLegacy, agentNetOnlyEncryptedByUser: () => state.onlyEncrypted, agentNetSelectionKey: () => 'selected-private', agentNetClientForRelay: () => null,
  openScopedAgentNetAppSocket: vi.fn(), setAgentNetScopedSessionRoute: (route: (peer: string) => unknown) => { state.sessionRoute = route; } }));
import { selectedAgentNetSharingRoute, rememberAgentNetSharingService, requestAgentNetSharing,
  joinAgentNetSharedTask, agentNetSharingRoute, stopAgentNetSharing, captureAgentNetSharingBoundaryClose, bindAgentNetSharing,
  listAgentNetSharedTasks, rememberAgentNetSharingHost, retireAgentNetSharingGuest } from '../agentNetSharing.js';
import { checkProviderShareDelegation, resolveAgentNetProviderShareLink, providerShareApi, providerShareLinkFor, providerShareHiddenByEncryptedOnly } from '../providerShareApi.js';
beforeEach(() => {
  state.key = 'owner-a'; state.pending = false; state.files.clear(); state.writes = [];
  state.relay = null; state.config = null; state.agentNetEnabled = true; state.onlyEncrypted = false; state.allowLegacy = false;
  state.privateSharing = false;
  state.http.mockReset(); state.card.mockReset();
  state.scopedTarget.mockReset();
  const identity = generateIdentity('self-device'), { bootstrap } = createPrivateNetwork('Unit fixture', identity);
  state.api = new AgentNetClient('https://private.example.test', identity, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
  state.card.mockResolvedValue({ card: 'unit-limited-identity-card', expiresAt: new Date(Date.now() + 300_000).toISOString() });
});
afterEach(() => stopAgentNetSharing());

// Unit: the production authorization entry consumes one owner signature
// from the authenticated socket during a business API outage.
it('confirms the signed executor scope without an HTTP authorization request', async () => {
  const owner = generateIdentity('other-owner'), guest = generateIdentity('guest');
  const { root, bootstrap } = createPrivateNetwork('Signature fixture', owner);
  const executor = state.api.identity;
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject,
    identity: executor, role: 'member' });
  state.api = new AgentNetClient(state.api.base, executor, certificate, bootstrap.rootPublicKey);
  const generation = randomUUID(), expiresAt = Date.now() + 25_000;
  const value = createDelegation(owner, bootstrap.ownerCertificate, { kind: 'provider-share', resourceId: 'share',
    guest, scope: { memberId: 'member', guestSubject: 'guest-account', memberVersion: 1 } });
  const plain = { ...value, executors: [{ generation, expiresAt, certificate }] };
  const signed: Delegation = { ...plain, signature: signature(owner.signingPrivateKey, delegationPayload(plain)) };
  state.scopedTarget.mockReturnValue({ delegation: signed });
  state.http.mockRejectedValue(new TypeError('offline'));
  const input = { shareId: 'share', memberId: 'member', guestDeviceId: guest.deviceId, executorDeviceId: executor.deviceId };
  await expect(checkProviderShareDelegation(input, generation)).resolves.toEqual({
    active: true, ownerDeviceId: owner.deviceId, expiresAt, generation, proofId: signed.id,
  });
  expect(state.scopedTarget).toHaveBeenCalledWith(providerShareGuestPeer('share', 'member', guest.deviceId));
  expect(state.card).not.toHaveBeenCalled();
  expect(state.http).not.toHaveBeenCalled();
});

// #11276: a second paired desktop must see the relay owner's task as its own.
// Unit, real directory routing with one same-subject row from the other host.
it('keeps another paired desktop’s private task in the owner’s list', async () => {
  const route = { ...selectedAgentNetSharingRoute('shared-task')!, v: 3 as const };
  rememberAgentNetSharingService(route);
  state.http.mockImplementation(async (url: string, options: RequestInit) => {
    if (!url.endsWith('/private-sharing/shared-tasks')) return Response.json({ sharedTasks: [] });
    expect(new Headers(options.headers).get('x-agent-net-authorization')).toMatch(/^AgentNet /);
    return Response.json({ sharedTasks: [{
      sharedTaskId: 'other-task', hostDeviceId: 'other-device', ownerAccountId: state.api.certificate.subject,
    }] });
  });
  await expect(listAgentNetSharedTasks(vi.fn())).resolves.toMatchObject({
    sharedTasks: [{ sharedTaskId: 'other-task', hostDeviceId: 'other-device', ownerAccountId: 'account-owner-a' }],
  });
  expect(agentNetSharingRoute('shared-task', 'other-task')).toBeNull();
});

// #11276: the real secure-vault writer must leave the rollback-readable v2 file intact.
// Unit, one saved old route plus one new route, with only the OS vault replaced.
it('stores private routes outside the old sharing vault', () => {
  const route = selectedAgentNetSharingRoute('shared-task')!;
  rememberAgentNetSharingHost('shared-task', 'old-task', route);
  const legacyFile = '/unit-only-vault/owner-a/sharing.enc';
  const before = state.files.get(legacyFile);
  rememberAgentNetSharingHost('shared-task', 'private-task', { ...route, v: 3 });
  expect(state.files.get(legacyFile)).toBe(before);
  stopAgentNetSharing();
  expect(agentNetSharingRoute('shared-task', 'old-task')).toMatchObject({ v: 2 });
  expect(agentNetSharingRoute('shared-task', 'private-task')).toMatchObject({ v: 3 });
});

// shared-task-mode: own paired tasks use same-account control, never a guest pin.
// Unit, one verified matching member authority and an invitation to its other host.
it('rejects a private invitation to the current member network', async () => {
  const { server, ...route } = selectedAgentNetSharingRoute('shared-task')!;
  const link = buildAgentNetSharingInvitation({
    ...route, v: 3, resourceId: 'other-task', hostDeviceId: 'other-device', invitation: 'Q'.repeat(43),
  }, server);
  state.http.mockResolvedValueOnce(Response.json({
    sharedTaskId: 'other-task', status: 'joined', memberId: 'guest-member', created: true,
  }));
  await expect(joinAgentNetSharedTask(link, 'Owner')).rejects.toThrow('SHARED_TASK_SELF_JOIN');
  expect(state.http).not.toHaveBeenCalled();
  expect(agentNetSharingRoute('shared-task', 'other-task')).toBeNull();
});

// #11276: an absent preview alias is not a reason to fetch or forward an official card.
// Unit through the real invitation API, with one failed preview and a retry to the pinned relay.
it('keeps a private provider request independent of the first preview', async () => {
  const invitation = buildAgentNetSharingInvitation({
    v: 3, kind: 'provider-share', resourceId: 'provider-share', invitation: 'Q'.repeat(43),
    networkId: 'private:friend', rootPublicKey: state.api.rootPublicKey, hostDeviceId: 'other-device', region: 'global',
  }, 'https://friend.example.test');
  const link = resolveAgentNetProviderShareLink(invitation)!;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  state.http.mockResolvedValueOnce(Response.json({ error: { code: 'UNAVAILABLE' } }, { status: 503 }));
  await expect(link.api.preview(link.invitation)).rejects.toThrow();
  expect(link.identityCard).toBe('private-device');
  state.http.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith('/preview')) return Response.json({ shareId: 'provider-share', providerId: 'claude', providerLabel: 'Remote',
      deviceName: 'Owner', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' }, state: 'unused', expiresAt });
    expect(url).toBe('https://friend.example.test/api/agent-net/private-sharing/provider-shares/requests');
    expect(JSON.parse(String(options.body)).identityCard).toBe('private-device');
    return Response.json({ requestId: 'request', status: 'pending', pairingCode: '1234', expiresAt });
  });
  await expect(link.api.sendRequest(link.invitation, 'unit-official-card')).resolves.toMatchObject({ status: 'pending' });
  expect(state.card).not.toHaveBeenCalled();
});

// #11276: the same capability choice must drive both the card and the creation endpoint.
// Unit through the public createLink API, with one selected self-hosted relay advertising v3.
it('uses the selected relay’s private authorization for new provider links', async () => {
  state.relay = { relayId: state.api.certificate.networkId.slice('private:'.length) };
  state.config = {};
  expect(selectedAgentNetSharingRoute('provider-share')?.v).toBe(2);
  state.privateSharing = true;
  state.http.mockImplementation(async (url: string, options: RequestInit) => {
    expect(url).toBe(state.api.base + '/api/agent-net/private-sharing/provider-shares/links');
    expect(JSON.parse(String(options.body)).identityCard).toBe('private-device');
    return Response.json({
      shareId: 'private-owned', linkId: 'a'.repeat(64), invitation: 'Q'.repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  });
  const result = await providerShareApi.createLink({ providerId: 'claude', providerLabel: 'Claude', deviceName: 'Cindy' });
  expect(parseAgentNetSharingInvitation(providerShareLinkFor(result.invitation), 'provider-share')?.receipt.v).toBe(3);
  expect(state.card).not.toHaveBeenCalled();
});
// The SDK accepts loopback for local development, so its invitation tests did
// not catch the App publishing its own loopback address to another computer.
// Real Main route + request entry, fake OS/network boundaries; unit.
it('publishes the local relay external address while the owner uses its loopback member API', async () => {
  const old = state.api;
  state.api = new AgentNetClient('http://127.0.0.1:3348', old.identity, old.certificate, old.rootPublicKey);
  state.relay = { relayId: old.certificate.networkId.slice('private:'.length) };
  state.config = { active: { origin: 'host' }, host: { listenAll: false, port: 3348, externalUrl: 'https://home.example.test' } };
  const route = selectedAgentNetSharingRoute('provider-share')!;
  expect(route.server).toBe('https://home.example.test');
  const { server, ...receipt } = route;
  expect(parseAgentNetSharingInvitation(buildAgentNetSharingInvitation({ ...receipt, invitation: 'Q'.repeat(43) }, server))?.server)
    .toBe('https://home.example.test');
  state.http.mockResolvedValueOnce(Response.json({ shares: [] }));
  await requestAgentNetSharing(route, '/api/device-link/provider-shares', { method: 'GET' });
  expect(state.http.mock.calls[0][0]).toBe('http://127.0.0.1:3348/api/agent-net/sharing/provider-shares');
  state.config.host.externalUrl = null;
  expect(() => selectedAgentNetSharingRoute('shared-task')).toThrow('AGENT_NET_PUBLIC_SHARING_URL_REQUIRED');
});
// The existing shared-task vault cases cannot catch Provider's opaque request
// IDs being sent to the official API or a retired admission reusing its key.
// Public Main facade + SDK signatures, memory OS/network boundaries; unit.
it('keeps a provider application, approval, transport identity and leave on its invited private root', async () => {
  const receipt = { v: 2 as const, kind: 'provider-share' as const, resourceId: 'private-provider', invitation: 'Q'.repeat(43),
    networkId: state.api.certificate.networkId, rootPublicKey: state.api.rootPublicKey, hostDeviceId: 'remote-host', region: 'global' as const };
  const link = buildAgentNetSharingInvitation(receipt, 'https://friend.example.test');
  const resolved = resolveAgentNetProviderShareLink(link)!;
  state.http.mockResolvedValueOnce(Response.json({ shareId: receipt.resourceId, providerId: 'claude', providerLabel: 'Remote', deviceName: 'Owner',
    owner: { displayName: 'Owner', avatarUrl: null, region: 'global' }, state: 'unused', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await resolved.api.preview(resolved.invitation);
  state.http.mockResolvedValueOnce(Response.json({ requestId: 'private-request', status: 'pending', pairingCode: '1234', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  await providerShareApi.sendRequest(receipt.invitation, 'unit-display-card');
  state.http.mockResolvedValueOnce(Response.json({ requestId: 'private-request', status: 'approved', pairingCode: '1234',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), shareId: receipt.resourceId, memberId: 'private-member' }));
  await providerShareApi.getRequest('private-request');
  const admitted = agentNetSharingRoute('provider-share', receipt.resourceId)!;
  expect(admitted.memberId).toBe('private-member'); expect(admitted.seed).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(parseAgentNetSharingInvitation(providerShareLinkFor(receipt.invitation))?.receipt).toEqual(receipt);
  state.http.mockResolvedValueOnce(Response.json({})); await providerShareApi.leave('private-member');
  expect(agentNetSharingRoute('provider-share', receipt.resourceId)?.retired).toBe(true);
  for (const [url, init] of state.http.mock.calls) {
    expect(url.startsWith('https://friend.example.test/api/agent-net/sharing/provider-shares')).toBe(true);
    expect(new Headers(init.headers).get('authorization')).toMatch(/^AgentNetIdentity /);
  }
  expect(state.card.mock.calls.every(([, opts]) => opts.body.audience === 'cindy-agent-net-sharing')).toBe(true);
});
// Review #10578: a partial outage returns cached rows rather than throwing. Unit,
// real Main API + aggregation + SDK; previous leave tests never populated that
// cache. An older read must not refill it, and a later admission must still work.
it.each([
  { legacy: false, late: false },
  { legacy: false, late: true },
  { legacy: true, late: true },
])('forgets a successful leave from a failed origin cache (legacy=$legacy, late=$late)', async ({ legacy, late }) => {
  state.allowLegacy = legacy;
  const old = state.api;
  state.api = new AgentNetClient(old.base, old.identity, old.certificate, old.rootPublicKey, undefined, { fetch: state.http });
  if (!legacy) rememberAgentNetSharingService({ ...selectedAgentNetSharingRoute('provider-share')!,
    server: 'https://friend.example.test', networkId: 'private:friend' });
  const row = (shareId: string, memberId: string) => ({ shareId, memberId, providerId: 'claude', providerLabel: 'Remote',
    hostDeviceId: 'remote-host', deviceName: 'Owner', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
    status: 'active', hostOnline: true, hostCapable: true });
  const departed = row('left-share', 'left-member'), neighbour = row('neighbour-share', 'neighbour-member');
  const healthy = row('healthy-share', 'healthy-member');
  let mode: 'live' | 'pending' | 'failed' = 'live', reads = 0;
  const response = Promise.withResolvers<{ shares: typeof departed[] }>(), started = Promise.withResolvers<void>();
  const readSource = async () => {
    reads++;
    if (mode === 'failed') throw new Error('source unavailable');
    if (mode === 'pending') { started.resolve(); return response.promise; }
    return { shares: [departed, neighbour] };
  };
  state.http.mockImplementation(async (url: string) => {
    const { hostname, pathname } = new URL(String(url));
    if (pathname.endsWith('/sharing-origins')) return Response.json({ origins: [] });
    if (pathname.endsWith('/leave')) return Response.json({});
    return Response.json(hostname === 'friend.example.test' ? await readSource() : { shares: [healthy] });
  });
  state.card.mockImplementation(async (path: string) => {
    if (path.endsWith('/received')) return readSource();
    if (path.endsWith('/leave')) return {};
    return { card: 'unit-limited-identity-card', expiresAt: new Date(Date.now() + 300_000).toISOString() };
  });
  await providerShareApi.listReceived();
  const neighbourSeed = agentNetSharingRoute('provider-share', 'neighbour-share')?.seed;
  let polling: ReturnType<typeof providerShareApi.listReceived> | undefined;
  try {
    if (late) { mode = 'pending'; polling = providerShareApi.listReceived(); await started.promise; }
    await providerShareApi.leave('left-member');
    mode = 'failed'; response.resolve({ shares: [departed, neighbour] });
    if (polling) expect((await polling).map(share => share.shareId)).not.toContain('left-share');
    const partial = await providerShareApi.listReceived();
    expect(partial.map(share => share.shareId).sort()).toEqual(['healthy-share', 'neighbour-share']);
    expect(partial.authorityIncomplete).toBe(true);
    expect(partial.unavailableShareIds).toContain('neighbour-share');
    if (!legacy) {
      expect(agentNetSharingRoute('provider-share', 'left-share')?.retired).toBe(true);
      expect(agentNetSharingRoute('provider-share', 'neighbour-share')).toMatchObject({ seed: neighbourSeed, retired: false });
    }
    mode = 'live';
    expect((await providerShareApi.listReceived()).map(share => share.shareId)).toContain('left-share');
    if (!legacy) expect(agentNetSharingRoute('provider-share', 'left-share')?.retired).toBe(false);
    expect(reads).toBe(late ? 4 : 3);
  } finally { response.resolve({ shares: [departed, neighbour] }); await polling; }
});
// Bug (real owner, 2026-11-10): origin sync had saved a placeholder service for
// the owner's own relay; the host listing reused it as each share's route, so
// every snapshot poll failed with ROUTE_CONFLICT and a new share was pinned to a
// placeholder host. Real Main listing over that persisted vault shape; unit.
it('lists owned shares whose origin is also saved as a discovered service', async () => {
  const old = state.api;
  state.api = new AgentNetClient(old.base, old.identity, old.certificate, old.rootPublicKey, undefined, { fetch: state.http });
  const route = selectedAgentNetSharingRoute('provider-share')!;
  const placeholder = { ...route, kind: 'shared-task', resourceId: 'origin-discovery', hostDeviceId: 'origin-discovery' };
  const vault = { version: 2, seed: randomBytes(32).toString('base64url'),
    routes: [{ ...route, resourceId: 'owned-share', aliases: { invitations: ['a'.repeat(64)] } }], services: [placeholder] };
  state.files.set('/unit-only-vault/owner-a/sharing.enc', Buffer.from('unit-vault:' + JSON.stringify(vault)).toString('base64'));
  const share = (shareId: string) => ({ shareId, providerId: 'claude', providerLabel: 'Claude', hostDeviceId: 'self-device',
    createdAt: new Date().toISOString(), members: [], requests: [] });
  state.http.mockImplementation(async (url: string) => String(url).includes('/sharing-origins')
    ? Response.json({ origins: [] }) : Response.json({ shares: [share('owned-share'), share('second-share')] }));
  await expect(providerShareApi.listOwned()).resolves.toMatchObject([{ shareId: 'owned-share' }, { shareId: 'second-share' }]);
  expect(agentNetSharingRoute('provider-share', 'owned-share')).toMatchObject({ hostDeviceId: 'self-device', aliases: { invitations: ['a'.repeat(64)] } });
  expect(agentNetSharingRoute('provider-share', 'second-share')).toMatchObject({ hostDeviceId: 'self-device', server: route.server });
  expect(agentNetSharingRoute('provider-share', 'second-share')?.aliases?.invitations ?? []).toEqual([]);
});
/** Admit this device as a guest of another account's private provider share, through the
 * public facade, then bind the routed client the way Main does after login. */
async function admitPrivateGuest(resourceId: string) {
  const old = state.api;
  state.api = new AgentNetClient(old.base, old.identity, old.certificate, old.rootPublicKey, undefined, { fetch: state.http });
  const receipt = { v: 2 as const, kind: 'provider-share' as const, resourceId, invitation: 'Q'.repeat(43),
    networkId: 'private:friend', rootPublicKey: state.api.rootPublicKey, hostDeviceId: 'remote-host', region: 'global' as const };
  const resolved = resolveAgentNetProviderShareLink(buildAgentNetSharingInvitation(receipt, 'https://friend.example.test'))!;
  const later = new Date(Date.now() + 60_000).toISOString(), owner = { displayName: 'Owner', avatarUrl: null, region: 'global' };
  const guest = { status: 'active' };
  state.http.mockImplementation(async (url: string) => {
    const { host, pathname: path } = new URL(String(url));
    if (path.endsWith('/sharing-origins')) return Response.json({ origins: [] });
    if (path.endsWith('/provider-shares/preview')) return Response.json({ shareId: resourceId, providerId: 'claude', providerLabel: 'Remote',
      deviceName: 'Owner', owner, state: 'unused', expiresAt: later });
    if (path.endsWith('/provider-shares/requests')) return Response.json({ requestId: 'guest-request', status: 'pending', pairingCode: '1234', expiresAt: later });
    if (path.includes('/provider-shares/requests/')) return Response.json({ requestId: 'guest-request', status: 'approved', pairingCode: '1234',
      expiresAt: later, shareId: resourceId, memberId: 'guest-member' });
    if (path.includes('/sharing/transport')) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    if (host !== 'friend.example.test') return Response.json({ shares: [] });
    return Response.json({ shares: [{ shareId: resourceId, memberId: 'guest-member', providerId: 'claude', providerLabel: 'Remote',
      hostDeviceId: 'remote-host', deviceName: 'Owner', owner, status: guest.status, hostOnline: true, hostCapable: true }] });
  });
  await resolved.api.sendRequest(resolved.invitation, 'unit-display-card');
  await providerShareApi.getRequest('guest-request');
  const options = { getWsUrl: () => 'wss://unavailable.example.test', getToken: async () => null,
    getHello: () => ({ deviceName: 'Guest', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }),
    createWebSocket: () => { throw new Error('PRIMARY_MUST_NOT_BE_REQUIRED'); } };
  const primary = new RoutedDeviceLinkClient(options), stop = bindAgentNetSharing(primary, options);
  return { primary, stop, guest, peer: providerShareHostPeer(resourceId, receipt.hostDeviceId) };
}
// Bug (real guest, 2026-11-10): a pause bumps the member's admission version, so the relay closes
// the member socket with 4410 and that scoped client stops for good; after resume the share stayed
// "client stopped" until restart. Real Main listing + routed client, 4410 state set on that client; unit.
it('rebuilds a member connection the relay closed once the owner lists the share active again', async () => {
  const { primary, stop, guest, peer } = await admitPrivateGuest('paused-provider');
  const dead = primary.connectionFor(peer);
  expect(dead).not.toBe(primary);
  (dead as unknown as { setConnectionIssue(issue: unknown): void }).setConnectionIssue({ kind: 'device-removed', closeCode: 4410, at: Date.now() });
  guest.status = 'paused'; await providerShareApi.listReceived();
  expect(primary.connectionFor(peer)).toBe(dead);
  guest.status = 'active'; await providerShareApi.listReceived();
  const rebuilt = primary.connectionFor(peer);
  expect(rebuilt).not.toBe(dead); expect(rebuilt).not.toBe(primary); expect(rebuilt.getConnectionIssue()).toBeNull();
  stop();
});
// Bug (real guest, 2026-11-10): with 「新版连接」off the guest could join, be approved and see the
// share as active, yet every use failed with DEVICE_LINK_NOT_CONNECTED because the admission's own
// connection was gated by this device's network toggle. Real routed client start; unit.
it('connects a joined guest admission even when this device has its own Agent-Net network off', async () => {
  state.agentNetEnabled = false;
  const { primary, stop } = await admitPrivateGuest('toggle-off-provider');
  state.http.mockClear();
  primary.start();
  await vi.waitFor(() => expect(state.http.mock.calls.some(([url]) => String(url) === 'https://friend.example.test/api/agent-net/sharing/transport')).toBe(true));
  primary.stop(); stop();
});
// Bug (2026-11-10): with 「仅使用 Agent-Net」on, V1 shares never reach the received list and a task
// using one said the owner removed it. Only a share never pinned to V2 is attributed to the switch.
it('attributes a missing share to the encrypted-only switch only when it was never a V2 share', async () => {
  const { stop } = await admitPrivateGuest('v2-provider');
  state.onlyEncrypted = true;
  expect(providerShareHiddenByEncryptedOnly('legacy-provider')).toBe(true);
  expect(providerShareHiddenByEncryptedOnly('v2-provider')).toBe(false);
  state.onlyEncrypted = false;
  expect(providerShareHiddenByEncryptedOnly('legacy-provider')).toBe(false);
  stop();
});
it('sends a key-bound short-lived card to the private service and persists only via the secure vault', async () => {
  const route = selectedAgentNetSharingRoute('shared-task')!;
  rememberAgentNetSharingService(route);
  state.http.mockImplementation(async (url: string, options: RequestInit) => {
    expect(url).toBe(route.server + '/api/agent-net/sharing/shared-tasks');
    const headers = new Headers(options.headers), auth = headers.get('authorization')!;
    expect(auth.startsWith('AgentNetIdentity ')).toBe(true); expect(auth.includes('Bearer')).toBe(false);
    const envelope = JSON.parse(Buffer.from(auth.slice('AgentNetIdentity '.length), 'base64url').toString());
    expect(envelope.card).toBe('unit-limited-identity-card');
    expect(verifyRequestProof(envelope.signingKey, envelope.proof, 'POST', '/api/agent-net/sharing/shared-tasks',
      Buffer.from(String(options.body)), Date.now())).toBe(true);
    expect(headers.get('x-agent-net-authorization')?.startsWith('AgentNet ')).toBe(true);
    return Response.json({ sharedTaskId: 'created-task', revision: 1 }, { status: 201 });
  });
  await expect(requestAgentNetSharing(route, '/api/device-link/shared-tasks', { method: 'POST', body: { sessionId: 'session', title: 'Unit' } }))
    .resolves.toMatchObject({ sharedTaskId: 'created-task' });
  expect(state.card).toHaveBeenCalledWith('/api/me/identity-card', expect.objectContaining({
    body: { audience: 'cindy-agent-net-sharing', purpose: 'network-session', nonce: expect.stringMatching(/^[a-f0-9]{64}$/) },
  }));
  expect(state.files.size).toBe(1);
  expect([...state.files.values()][0]).not.toContain('unit-limited-identity-card');
  expect(state.writes.every(file => file.startsWith('/unit-only-vault/owner-a/'))).toBe(true);
});
it('pins an explicit guest invitation and rejects a conflicting root before any second join', async () => {
  const receipt = { v: 2 as const, kind: 'shared-task' as const, resourceId: 'guest-task', invitation: randomBytes(32).toString('base64url'),
    networkId: 'private:remote', rootPublicKey: state.api.rootPublicKey, hostDeviceId: 'remote-host', region: 'global' as const };
  state.http.mockResolvedValue(Response.json({ sharedTaskId: receipt.resourceId, memberId: 'guest-member', status: 'joined', created: true }));
  const link = buildAgentNetSharingInvitation(receipt, 'https://friend.example.test');
  await expect(joinAgentNetSharedTask(link, 'Guest')).resolves.toMatchObject({ memberId: 'guest-member' });
  const route = agentNetSharingRoute('shared-task', receipt.resourceId)!;
  expect(route.server).toBe('https://friend.example.test'); expect(route.rootPublicKey).toBe(receipt.rootPublicKey);
  state.api = null; // No official enrollment is available on this guest.
  const options = { getWsUrl: () => 'wss://unavailable.example.test', getToken: async () => null,
    getHello: () => ({ deviceName: 'Guest', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }),
    createWebSocket: () => { throw new Error('PRIMARY_MUST_NOT_BE_REQUIRED'); } };
  const primary = new RoutedDeviceLinkClient(options);
  const stop = bindAgentNetSharing(primary, options);
  expect(primary.connectionFor(sharedTaskHostPeer(receipt.resourceId, receipt.hostDeviceId))).not.toBe(primary);
  stop();
  const { bootstrap } = createPrivateNetwork('Other fixture', generateIdentity('different-host'));
  const conflict = buildAgentNetSharingInvitation({ ...receipt, rootPublicKey: bootstrap.rootPublicKey }, 'https://friend.example.test');
  await expect(joinAgentNetSharedTask(conflict, 'Guest')).rejects.toThrow('ROUTE_CONFLICT');
  expect(state.http).toHaveBeenCalledOnce();
});
// Rule (2026-11-16, cross-account on the Agent-Net session layer): a session is used only where the routed client
// accepts that resource's scoped frames (`acceptsScopedEvent`). A guest who left keeps a retired pin and must get no
// session either; a resource this computer never installed is accepted on the main connection only, as Device Link does.
// Real Main vault, routed client and pins; unit.
it('lets a cross-account session through only where the routed client accepts that resource', async () => {
  const receipt = { v: 2 as const, kind: 'shared-task' as const, resourceId: 'left-task', invitation: randomBytes(32).toString('base64url'),
    networkId: 'private:remote', rootPublicKey: state.api.rootPublicKey, hostDeviceId: 'remote-host', region: 'global' as const };
  state.http.mockResolvedValue(Response.json({ sharedTaskId: receipt.resourceId, memberId: 'guest-member', status: 'joined', created: true }));
  await joinAgentNetSharedTask(buildAgentNetSharingInvitation(receipt, 'https://friend.example.test'), 'Guest');
  const options = { getWsUrl: () => 'wss://unavailable.example.test', getToken: async () => null,
    getHello: () => ({ deviceName: 'Guest', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }),
    createWebSocket: () => { throw new Error('PRIMARY_MUST_NOT_BE_REQUIRED'); } };
  const primary = new RoutedDeviceLinkClient(options), stop = bindAgentNetSharing(primary, options);
  const host = sharedTaskHostPeer(receipt.resourceId, receipt.hostDeviceId);
  // This computer's own task on its main network, and one whose network it cannot reach (registered blocked).
  const selected = selectedAgentNetSharingRoute('shared-task')!;
  rememberAgentNetSharingHost('shared-task', 'own-task', selected);
  rememberAgentNetSharingHost('shared-task', 'unreachable-task', { ...selected, networkId: 'private:other-relay' });
  const visitor = (task: string) => sharedTaskGuestPeer(task, 'guest-member', 'guest-device');
  expect(state.sessionRoute!(visitor('own-task'))).toBe('primary');
  expect(state.sessionRoute!(visitor('unreachable-task'))).toBeNull();
  expect(state.sessionRoute!(visitor('never-installed'))).toBe('primary');
  retireAgentNetSharingGuest('shared-task', receipt.resourceId);
  expect(primary.connectionFor(host)).not.toBe(primary);
  expect(state.sessionRoute!(host)).toBeNull();
  // Stopping leaves those pins retired on the routed client: no session until they are registered again.
  stop();
  expect(state.sessionRoute!(visitor('own-task'))).toBeNull();
});
it('discards a late join after an account boundary without writing into the next owner vault', async () => {
  const receipt = { v: 2 as const, kind: 'shared-task' as const, resourceId: 'late-task', invitation: randomBytes(32).toString('base64url'),
    networkId: 'private:remote', rootPublicKey: state.api.rootPublicKey, hostDeviceId: 'remote-host', region: 'global' as const };
  state.http.mockImplementation(async () => {
    state.key = 'owner-b';
    return Response.json({ sharedTaskId: receipt.resourceId, memberId: 'guest-member', status: 'joined', created: true });
  });
  await expect(joinAgentNetSharedTask(buildAgentNetSharingInvitation(receipt, 'https://friend.example.test'), 'Guest'))
    .rejects.toThrow('OWNER_CHANGED');
  expect(state.writes.every(file => file.startsWith('/unit-only-vault/owner-a/'))).toBe(true);
  expect([...state.files.keys()].some(file => file.includes('owner-b'))).toBe(false);
});
it('closes an already-hosted task through the old owner authority while the account boundary is pending', async () => {
  // Bug #10092: teardown always runs with the boundary pending. Capture went
  // through owner() and threw, aborting every switch after its services were
  // torn down; resolving the host authority with the ordinary accessors would
  // instead capture no member and silently leave the Agent-Net share open.
  const route = selectedAgentNetSharingRoute('shared-task')!;
  rememberAgentNetSharingHost('shared-task', 'hosted-task', route);
  state.pending = true;
  const close = captureAgentNetSharingBoundaryClose('unit-outgoing-access', 'https://auth.example.test');
  state.http.mockResolvedValueOnce(Response.json({ sharedTaskId: 'hosted-task', status: 'closed' }));
  await expect(close('hosted-task')).resolves.toMatchObject({ status: 'closed' });
  expect(state.http.mock.calls.at(-1)?.[0]).toBe(route.server + '/api/agent-net/sharing/shared-tasks/hosted-task/close');
  expect(state.card.mock.calls.at(-1)?.[1]).toMatchObject({ token: 'unit-outgoing-access', skipAutoRefresh: true });
  // The vault on disk is still the outgoing owner's after the session stops.
  stopAgentNetSharing();
  state.http.mockResolvedValueOnce(Response.json({ sharedTaskId: 'hosted-task', status: 'closed' }));
  await expect(captureAgentNetSharingBoundaryClose('unit-outgoing-access', 'https://auth.example.test')('hosted-task'))
    .resolves.toMatchObject({ status: 'closed' });
  expect(state.writes.every(file => file.startsWith('/unit-only-vault/owner-a/'))).toBe(true);
  // Cold vault holding a self-hosted LAN (non-loopback http) host route: its
  // validation must use the outgoing authority too, or the whole vault is
  // rejected and the share is skipped.
  const lan = { ...route, server: 'http://192.168.1.20:3348', resourceId: 'lan-task' };
  state.files.set('/unit-only-vault/owner-a/sharing.enc', Buffer.from('unit-vault:' + JSON.stringify(
    { version: 2, seed: randomBytes(32).toString('base64url'), routes: [lan] })).toString('base64'));
  state.http.mockResolvedValueOnce(Response.json({ sharedTaskId: 'lan-task', status: 'closed' }));
  await expect(captureAgentNetSharingBoundaryClose('unit-outgoing-access', 'https://auth.example.test')('lan-task'))
    .resolves.toMatchObject({ status: 'closed' });
  expect(state.http.mock.calls.at(-1)?.[0]).toBe(state.api.base + '/api/agent-net/sharing/shared-tasks/lan-task/close');
});
it('observes an outgoing committed create and closes it with captured credentials after the account changes', async () => {
  const route = selectedAgentNetSharingRoute('shared-task')!; rememberAgentNetSharingService(route);
  const close = captureAgentNetSharingBoundaryClose('unit-outgoing-access', 'https://auth.example.test');
  let started!: () => void, finish!: (response: Response) => void;
  const sent = new Promise<void>(resolve => { started = resolve; });
  state.http.mockImplementationOnce(() => { started(); return new Promise<Response>(resolve => { finish = resolve; }); });
  const observed = vi.fn();
  const create = requestAgentNetSharing(route, '/api/device-link/shared-tasks', { method: 'POST',
    body: { sessionId: 'session', title: 'Unit' }, observeResponse: observed });
  const rejected = expect(create).rejects.toThrow('OWNER_CHANGED');
  await sent; state.key = 'owner-b'; stopAgentNetSharing();
  finish(Response.json({ sharedTaskId: 'late-created', revision: 1 })); await rejected;
  expect(observed).toHaveBeenCalledWith({ sharedTaskId: 'late-created', revision: 1 });
  state.http.mockResolvedValueOnce(Response.json({ sharedTaskId: 'late-created', status: 'closed' }));
  await expect(close('late-created')).resolves.toMatchObject({ status: 'closed' });
  expect(state.http.mock.calls.at(-1)?.[0]).toBe(route.server + '/api/agent-net/sharing/shared-tasks/late-created/close');
  expect(state.card.mock.calls.at(-1)?.[1]).toMatchObject({ token: 'unit-outgoing-access',
    baseUrl: 'https://auth.example.test', skipAutoRefresh: true, skipSessionInvalidation: true });
  expect(state.writes.every(file => file.startsWith('/unit-only-vault/owner-a/'))).toBe(true);
});
