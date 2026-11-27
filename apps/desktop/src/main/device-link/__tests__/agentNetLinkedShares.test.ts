/**
 * 测试价值
 * - 生产入口与结果：分享者电脑的登记入口 handleProviderShareAgentNetLink、放行判断 linkedProviderShareAdmission、
 *   成员撤销与分享清理；受邀者的 linkReceivedProviderShares 经真实 bindAgentNetSharing 装上连接后，
 *   agentNetSharing.ts 的会话选路与附件选路给出的实际线路。SDK 的请求签名、放行证校验与 Device Link 客户端都是真的。
 * - Bug／规则依据：2026-11-26 用户要求旧的 Device Link 分享在两边都开 Agent-Net 后无感改走 Agent-Net、不再审批，
 *   附件也要一起走（docs/dev-rules/protocol-compatibility/agent-net-linked-provider-shares.md）。
 * - 现有覆盖缺口：packages/agent-net 的 socket.integration 用真实服务验证了放行证与会话，但分享者电脑「只认登记过的
 *   钥匙」、受邀者「什么时候问、问谁、拿到什么线路才接受、断开后退回哪条线」都在 Desktop 主进程里，没有用例。
 * - 最小失败输入：同一成员换一把没登记的钥匙申请放行证；分享者给出别的服务器地址；连接断开后会话仍指向主连接
 *   （白等 Agent-Net）；旧版分享者回 CHANNEL_NOT_ALLOWED 后每分钟再问一次；控制链路还在 Device Link 上时附件
 *   却改走 Agent-Net；取消登记失败后本机记录已删、服务端登记永远留下。
 * - tier：unit；内存文件系统、系统钥匙串、账号与网络边界替换为桩，无真实网络、无用户数据。
 * - 实测耗时：2026-11-26 本机单独运行约 2.4 秒（测试体 0.2 秒，其余为模块加载）；冷却用例只伪造 Date，没有真实等待。
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDelegation, createPrivateNetwork, generateIdentity, issueCertificate, type Identity } from '@cindy/agent-net-relay';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import type { DelegationRequest } from '@cindy/agent-net-protocol';
import { RoutedDeviceLinkClient, providerShareGuestPeer, providerShareHostPeer, type ProviderShareReceived } from '@cindy/device-link';

const OFFICIAL = 'https://agent-net.example.test';
const state = vi.hoisted(() => ({ key: 'owner-a', files: new Map<string, string>(), http: vi.fn(), card: vi.fn(),
  api: null as any, active: true, agentNetEnabled: true, linkedSupported: true, onlyEncrypted: false,
  sessionRoute: null as null | ((peer: string) => unknown), openSocket: vi.fn(), scopedTarget: vi.fn() }));
vi.mock('node:fs', () => ({ default: {
  existsSync: (file: string) => state.files.has(file), statSync: (file: string) => ({ size: state.files.get(file)?.length ?? 0 }),
  readFileSync: (file: string) => state.files.get(file), mkdirSync() {},
  writeFileSync(file: string, data: string) { state.files.set(file, data); },
  renameSync(from: string, to: string) { state.files.set(to, state.files.get(from)!); state.files.delete(from); },
  rmSync: (file: string) => state.files.delete(file),
} }));
vi.mock('electron', () => ({ safeStorage: {
  encryptString: (value: string) => Buffer.from('unit-vault:' + value),
  decryptString: (value: Buffer) => value.toString().slice('unit-vault:'.length),
} }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }) }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.key, isAppSessionBoundaryPending: () => false }));
vi.mock('../../authManager.js', () => ({ getCurrentUserId: () => 'account-' + state.key, getDeviceId: () => 'self-device',
  getActiveAuthRealm: () => 'global', getAuthState: () => ({ isAuthenticated: true }) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: (key: string) => key === 'agentNetApiBaseUrl' ? OFFICIAL : 'https://auth.example.test' }));
vi.mock('../../serverApiClient.desktop.js', () => ({ serverApiFetch: state.card }));
vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({ outboundFetch: state.http }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => null }));
vi.mock('../../localDb/sharedTasks.js', () => ({ createSharedTaskJournal: () => ({ latest: async () => [] }) }));
vi.mock('../selfHostedRelayConfig.js', () => ({ secureStorageAvailable: () => true, readRelayConfig: () => null,
  relayDataPath: (_area: string, file: string) => '/unit-only-vault/' + state.key + '/' + file }));
vi.mock('../selfHostedRelayRouting.js', () => ({ activeSelfHostedRelay: () => null }));
vi.mock('../settings-store.desktop.js', () => ({ readDeviceLinkSettings: () => ({ agentNetEnabled: state.agentNetEnabled }) }));
vi.mock('../linkWebSocket.desktop.js', () => ({ openLinkWebSocket: () => { throw new Error('NO_REAL_SOCKETS'); } }));
vi.mock('../agentNetOfficial.js', () => ({ officialAgentNetBase: () => OFFICIAL, currentOfficialAgentNetClient: () => state.api,
  outgoingOfficialAgentNetClient: () => state.api }));
vi.mock('../agentNetRuntime.js', () => ({ currentAgentNetClient: () => state.active ? state.api : null, isAgentNetActive: () => state.active,
  supportsLinkedProviderShares: () => state.linkedSupported, agentNetRequiresEncryption: () => state.onlyEncrypted,
  supportsPrivateAgentNetSharing: () => false, currentAgentNetScopedTarget: state.scopedTarget, openScopedAgentNetAppSocket: state.openSocket,
  outgoingAgentNetClient: () => state.api, outgoingAgentNetClientForRelay: () => null, agentNetClientForRelay: () => null,
  agentNetAllowsLegacy: () => true, agentNetSelectionKey: () => 'official', agentNetPeerSnapshot: () => null, agentNetRelayRoute: () => null,
  setAgentNetScopedSessionRoute: (route: (peer: string) => unknown) => { state.sessionRoute = route; } }));
import { bindAgentNetSharing, stopAgentNetSharing } from '../agentNetSharing.js';
import { __testing, handleProviderShareAgentNetLink, linkReceivedProviderShares, linkedProviderShareAdmission,
  linkedProviderShareMediaClient, linkedProviderShareMediaTarget, reconcileLinkedProviderShares,
  revokeLinkedProviderShareGuests, setLinkedShareControlTransport } from '../agentNetLinkedShares.js';
import { PROVIDER_SHARE_AGENT_NET_LINK_CHANNEL } from '../../../shared/providerShareAgentNetLink.js';

/** Account-service identity card shape: a JWT whose iat/exp the sharing client reads for its lifetime. */
function unitIdentityCard() {
  const iat = Math.floor(Date.now() / 1000), exp = iat + 300;
  return { card: ['e30', Buffer.from(JSON.stringify({ iat, exp })).toString('base64url'), 'unit-signature'].join('.'),
    expiresAt: new Date(exp * 1000).toISOString() };
}
function accountNetwork(deviceId: string, subject: string) {
  const identity = generateIdentity(deviceId), { root, bootstrap } = createPrivateNetwork('Unit ' + subject, identity);
  const certificate = issueCertificate(root, { networkId: 'account:' + subject, subject, identity, role: 'owner' });
  return { identity, certificate, rootPublicKey: bootstrap.rootPublicKey };
}
const request = (guest: Identity, overrides: Partial<DelegationRequest> = {}): DelegationRequest => ({ id: '00000000-0000-4000-8000-000000000001',
  kind: 'provider-share', networkId: 'account:account-owner-a', hostDeviceId: 'self-device', resourceId: 'share-1', guestDeviceId: guest.deviceId,
  guestSigningKey: guest.signingKey, guestTransportKey: guest.transportKey, scope: { memberId: 'member-1', guestSubject: 'guest-account', memberVersion: 1 },
  requestedAt: Date.now(), expiresAt: Date.now() + 60_000, ...overrides });
const share = (overrides: Partial<ProviderShareReceived> = {}): ProviderShareReceived => ({ shareId: 'share-1', memberId: 'member-1',
  providerId: 'claude', providerLabel: 'Remote', hostDeviceId: 'remote-host', deviceName: 'Owner',
  owner: { displayName: 'Owner', avatarUrl: null, region: 'global' }, status: 'active', hostOnline: true, hostCapable: true, ...overrides });
const calls = (method: string, suffix: string) => state.http.mock.calls.filter(([url, init]) =>
  String(url).endsWith(suffix) && ((init as RequestInit | undefined)?.method ?? 'GET') === method);

beforeEach(() => {
  state.key = 'owner-a'; state.files.clear(); state.active = true; state.agentNetEnabled = true; state.linkedSupported = true;
  state.onlyEncrypted = false; state.http.mockReset(); state.card.mockReset(); state.openSocket.mockReset(); state.scopedTarget.mockReset();
  state.card.mockImplementation(async () => unitIdentityCard());
  const own = accountNetwork('self-device', 'account-owner-a');
  state.api = new AgentNetClient(OFFICIAL, own.identity, own.certificate, own.rootPublicKey, undefined, { fetch: state.http });
});
afterEach(() => { stopAgentNetSharing(); __testing.reset(); vi.useRealTimers(); });

it('registers a guest key only on a capable official service and admits exactly that key until the member is revoked', async () => {
  const guest = generateIdentity('guest-laptop'), peer = providerShareGuestPeer('share-1', 'member-1', guest.deviceId);
  const keys = { version: 1, signingKey: guest.signingKey, transportKey: guest.transportKey } as const;
  // Agent-Net off, or a service without `linked-provider-shares-v1`: answered locally, nothing sent anywhere.
  state.active = false;
  await expect(handleProviderShareAgentNetLink(peer, keys)).resolves.toEqual({ unavailable: 'agent-net-off' });
  state.active = true; state.linkedSupported = false;
  await expect(handleProviderShareAgentNetLink(peer, keys)).resolves.toEqual({ unavailable: 'relay-unsupported' });
  expect(state.http).not.toHaveBeenCalled();
  state.linkedSupported = true;
  await expect(handleProviderShareAgentNetLink(providerShareHostPeer('share-1', 'self-device'), keys)).rejects.toThrow('INVALID_PARAMS');

  state.http.mockImplementation(async (url: string) => String(url).endsWith('/provider-shares/linked')
    ? Response.json({ shareId: 'share-1', linked: true }) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
  await expect(handleProviderShareAgentNetLink(peer, keys)).resolves.toEqual({ route: { server: OFFICIAL,
    networkId: 'account:account-owner-a', rootPublicKey: state.api.rootPublicKey, hostDeviceId: 'self-device', region: 'global' } });
  const [linked] = calls('POST', '/api/agent-net/sharing/provider-shares/linked');
  expect(JSON.parse(String((linked[1] as RequestInit).body))).toEqual({ shareId: 'share-1' });
  // The service only accepts a certified device of the network for this write.
  expect(new Headers((linked[1] as RequestInit).headers).get('x-agent-net-authorization')).toMatch(/^AgentNet /);

  expect(linkedProviderShareAdmission(request(guest))).toBe(true);
  const other = generateIdentity('guest-laptop');
  expect(linkedProviderShareAdmission(request(guest, { guestSigningKey: other.signingKey, guestTransportKey: other.transportKey }))).toBe(false);
  expect(linkedProviderShareAdmission(request(guest, { scope: { memberId: 'member-2', guestSubject: 'guest-account', memberVersion: 1 } }))).toBe(false);
  expect(linkedProviderShareAdmission(request(guest, { guestDeviceId: 'guest-phone' }))).toBe(false);
  // Not a linked share: the ordinary Agent-Net sharing rule decides.
  expect(linkedProviderShareAdmission(request(guest, { resourceId: 'native-share' }))).toBeNull();
  // The registration is durable: a restart keeps admitting the same key without asking the guest again.
  __testing.reset();
  expect(linkedProviderShareAdmission(request(guest))).toBe(true);
  // Attachments to this guest use Agent-Net only while its control link to this computer came over the session.
  const signed = createDelegation(state.api.identity, state.api.certificate, { kind: 'provider-share', resourceId: 'share-1',
    scope: { memberId: 'member-1', guestSubject: 'guest-account', memberVersion: 1 }, guest });
  state.scopedTarget.mockReturnValue({ relayId: 'guest:' + signed.id, transportKey: guest.transportKey, delegation: signed });
  expect(linkedProviderShareMediaTarget(peer)).toBeNull();
  setLinkedShareControlTransport(controller => controller === peer);
  expect(linkedProviderShareMediaTarget(peer)).toMatchObject({ recipient: 'guest:' + signed.id, grantId: signed.id });

  // Pausing or removing the member forgets its key and withdraws only its signed leases.
  const grant = (id: string, resourceId: string) => ({ id, kind: 'provider-share', resourceId, guestDeviceId: guest.deviceId, scope: { memberId: 'member-1' } });
  state.http.mockImplementation(async (url: string, init?: RequestInit) => String(url).endsWith('/api/agent-net/grants') && init?.method === 'GET'
    ? Response.json({ grants: [grant('11111111-1111-4111-8111-111111111111', 'share-1'), grant('22222222-2222-4222-8222-222222222222', 'share-2')] })
    : Response.json({ deleted: true }));
  revokeLinkedProviderShareGuests(controller => controller === peer);
  expect(linkedProviderShareAdmission(request(guest))).toBe(false);
  await vi.waitFor(() => expect(calls('DELETE', '/api/agent-net/grants/11111111-1111-4111-8111-111111111111')).toHaveLength(1));
  expect(calls('DELETE', '/api/agent-net/grants/22222222-2222-4222-8222-222222222222')).toHaveLength(0);

  // A share deleted from the owner's V1 list is no longer registered on Agent-Net.
  reconcileLinkedProviderShares(new Map([['share-1', new Set(['member-1'])]]));
  expect(calls('POST', '/provider-shares/linked/share-1/remove')).toHaveLength(0);
  reconcileLinkedProviderShares(new Map());
  // Until the service confirms the removal the record stays, admitting nobody and serving no attachments.
  expect(linkedProviderShareAdmission(request(guest))).toBe(false);
  expect(linkedProviderShareMediaTarget(peer)).toBeNull();
  await vi.waitFor(() => expect(calls('POST', '/api/agent-net/sharing/provider-shares/linked/share-1/remove')).toHaveLength(1));
  await vi.waitFor(() => expect(linkedProviderShareAdmission(request(guest))).toBeNull());
});

// Review #13268: the local record used to be deleted before the service removal, so an offline host or a failed request
// left the registration behind for good (each network holds at most 256). Unit; only Date is faked.
it('keeps a deleted share queued for removal until the service confirms, retrying at most every 10 minutes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const guest = generateIdentity('guest-laptop'), peer = providerShareGuestPeer('share-1', 'member-1', guest.deviceId);
  let removal: 'fail' | 'ok' = 'fail';
  state.http.mockImplementation(async (url: string) => String(url).endsWith('/provider-shares/linked') ? Response.json({ shareId: 'share-1', linked: true })
    : String(url).endsWith('/linked/share-1/remove') ? removal === 'ok' ? Response.json({ removed: true })
      : Response.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, { status: 503 }) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
  await handleProviderShareAgentNetLink(peer, { version: 1, signingKey: guest.signingKey, transportKey: guest.transportKey });
  const removals = () => calls('POST', '/api/agent-net/sharing/provider-shares/linked/share-1/remove').length;
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  // Not on Agent-Net at the moment: queued, nothing sent.
  state.active = false;
  reconcileLinkedProviderShares(new Map());
  expect(removals()).toBe(0);
  state.active = true;
  reconcileLinkedProviderShares(new Map());
  await vi.waitFor(() => expect(removals()).toBe(1));
  await settle();
  // The service failed: still queued (and admitting nobody); the next snapshot inside the window does not ask again.
  expect(linkedProviderShareAdmission(request(guest))).toBe(false);
  reconcileLinkedProviderShares(new Map());
  expect(removals()).toBe(1);
  removal = 'ok'; vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
  reconcileLinkedProviderShares(new Map());
  await vi.waitFor(() => expect(removals()).toBe(2));
  await vi.waitFor(() => expect(linkedProviderShareAdmission(request(guest))).toBeNull());
  reconcileLinkedProviderShares(new Map());
  expect(removals()).toBe(2);
});

it('reports an old service when linking returns 404 instead of failing the guest', async () => {
  const guest = generateIdentity('guest-laptop'), peer = providerShareGuestPeer('share-1', 'member-1', guest.deviceId);
  state.http.mockResolvedValue(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
  await expect(handleProviderShareAgentNetLink(peer, { version: 1, signingKey: guest.signingKey, transportKey: guest.transportKey }))
    .resolves.toEqual({ unavailable: 'relay-unsupported' });
  expect(linkedProviderShareAdmission(request(guest))).toBeNull();
});

class FakeSocket extends EventEmitter {
  deviceId = 'self-device'; bufferedAmount = 0; target: unknown = null;
  send() {} terminate() { this.close(); } close() { this.emit('close', 1000); }
  onDrain() {} async replaceClient() {} supports() { return true; } knowsPeer() { return false; } certificateFor() { return undefined; }
  scopedPeerTarget() { return this.target; } pathTo() { return null; } peerSnapshot() { return null; }
}
function bindGuest() {
  const options = { getWsUrl: () => 'wss://unavailable.example.test', getToken: async () => null,
    getHello: () => ({ deviceName: 'Guest', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }),
    createWebSocket: () => { throw new Error('PRIMARY_MUST_NOT_BE_REQUIRED'); } };
  return bindAgentNetSharing(new RoutedDeviceLinkClient(options), options);
}

it('moves an active Device Link share onto Agent-Net once, and routes its sessions and attachments there only while connected', async () => {
  const host = accountNetwork('remote-host', 'remote-owner'), hostPeer = providerShareHostPeer('share-1', 'remote-host');
  const route = { server: OFFICIAL, networkId: 'account:remote-owner', rootPublicKey: host.rootPublicKey, hostDeviceId: 'remote-host', region: 'global' };
  let keys: { signingKey: string; transportKey: string } | null = null;
  const invoke = vi.fn(async (_target: string, _channel: string, args: unknown[]) => {
    keys = args[0] as typeof keys; return { ok: true as const, result: { route } };
  });
  let delegation: ReturnType<typeof createDelegation> | null = null;
  state.http.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/api/agent-net/sharing/transport')) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    const body = JSON.parse(String(init?.body));
    delegation = createDelegation(host.identity, host.certificate, { kind: 'provider-share', resourceId: body.resourceId,
      scope: { memberId: body.memberId, guestSubject: 'account-owner-a', memberVersion: 1 },
      guest: { deviceId: 'self-device', signingKey: body.signingKey, transportKey: body.transportKey } });
    return Response.json({ id: delegation.id, status: 'ready', networkId: route.networkId, rootPublicKey: host.rootPublicKey,
      certificate: host.certificate, delegation });
  });
  const sockets: FakeSocket[] = [];
  state.openSocket.mockImplementation(async () => { const socket = new FakeSocket(); sockets.push(socket); return socket; });
  const stop = bindGuest();
  const input = { received: [share()], confirmedShareIds: new Set(['share-1']), isAgentNetShare: () => false, invoke };
  // Not moved yet: the share keeps its existing rule.
  expect(state.sessionRoute!(hostPeer)).toBe('primary');
  linkReceivedProviderShares(input);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('share:share-1', PROVIDER_SHARE_AGENT_NET_LINK_CHANNEL,
    [{ version: 1, signingKey: keys!.signingKey, transportKey: keys!.transportKey }]);
  // The lease asks for exactly this V1 membership, with the key the host just registered.
  const [transport] = calls('POST', '/api/agent-net/sharing/transport');
  expect(JSON.parse(String((transport[1] as RequestInit).body))).toEqual({ kind: 'provider-share', resourceId: 'share-1', memberId: 'member-1',
    signingKey: keys!.signingKey, transportKey: keys!.transportKey });
  expect(state.sessionRoute!(hostPeer)).toBe(sockets[0]);
  // Another guest peer of the same share is not this computer's session.
  expect(state.sessionRoute!(providerShareGuestPeer('share-1', 'member-1', 'self-device'))).toBe('primary');

  // Attachments follow the same connection, bound to this share and member.
  sockets[0].target = { relayId: 'remote-host', transportKey: host.identity.transportKey, delegation: delegation! };
  // While this computer's control link to the sharer is still on Device Link, attachments stay there with it (review #13268).
  expect(linkedProviderShareMediaTarget(hostPeer)).toBeNull();
  setLinkedShareControlTransport(peer => peer === hostPeer);
  const media = linkedProviderShareMediaTarget(hostPeer);
  expect(media).toMatchObject({ recipient: 'remote-host', grantId: delegation!.id, slot: __testing.mediaSlot(route as never, 'share-1', 'member-1') });
  expect(linkedProviderShareMediaClient(media!.slot, route.networkId, hostPeer)?.delegation?.id).toBe(delegation!.id);
  expect(linkedProviderShareMediaClient(media!.slot, 'account:someone-else', hostPeer)).toBeNull();

  // Polls do not ask again once the share moved.
  linkReceivedProviderShares(input);
  expect(invoke).toHaveBeenCalledTimes(1);
  // While the connection is down, sessions and attachments go back to Device Link together.
  sockets[0].close();
  expect(state.sessionRoute!(hostPeer)).toBeNull();
  expect(linkedProviderShareMediaTarget(hostPeer)).toBeNull();
  // A paused share forgets the move: its rule is the original one again, and nothing is retained on disk.
  linkReceivedProviderShares({ ...input, received: [share({ status: 'paused' })] });
  expect(state.sessionRoute!(hostPeer)).toBe('primary');
  expect(state.files.get('/unit-only-vault/owner-a/linked-shares-v1.enc')).not.toContain('share-1');
  expect(invoke).toHaveBeenCalledTimes(1);
  stop();
});

it.each([
  { name: 'an older sharer', reply: { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'old' } }, retryAfterMs: 12 * 3600_000 },
  { name: 'a sharer without Agent-Net', reply: { ok: true, result: { unavailable: 'agent-net-off' } }, retryAfterMs: 30 * 60_000 },
  { name: 'a sharer offering another server', reply: { ok: true, result: { route: { server: 'https://elsewhere.example.test',
    networkId: 'account:remote-owner', rootPublicKey: 'A'.repeat(43), hostDeviceId: 'remote-host', region: 'global' } } }, retryAfterMs: 12 * 3600_000 },
] as const)('keeps the share on Device Link for $name and asks again only after the cooldown', async ({ reply, retryAfterMs }) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const invoke = vi.fn(async () => reply);
  const stop = bindGuest();
  const input = { received: [share()], confirmedShareIds: new Set(['share-1']), isAgentNetShare: () => false, invoke };
  linkReceivedProviderShares(input);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  // Let the reply settle (only Date is faked).
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  linkReceivedProviderShares(input);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(state.sessionRoute!(providerShareHostPeer('share-1', 'remote-host'))).toBe('primary');
  expect(state.openSocket).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + retryAfterMs + 1);
  linkReceivedProviderShares(input);
  expect(invoke).toHaveBeenCalledTimes(2);
  stop();
});

it.each([
  { name: 'Agent-Net is off here', setup: () => { state.agentNetEnabled = false; }, input: {} },
  { name: '「仅使用 Agent-Net」 hides V1 shares here', setup: () => { state.onlyEncrypted = true; }, input: {} },
  { name: 'the share is already an Agent-Net share', setup: () => undefined, input: { isAgentNetShare: () => true } },
  { name: 'the share lives in the other region', setup: () => undefined, input: { received: [share({ owner: { displayName: 'Owner', avatarUrl: null, region: 'cn' } })] } },
  { name: 'the sharer is offline', setup: () => undefined, input: { received: [share({ hostOnline: false })] } },
])('never asks the sharer when $name', ({ setup, input }) => {
  setup();
  const invoke = vi.fn();
  const stop = bindGuest();
  linkReceivedProviderShares({ received: [share()], confirmedShareIds: new Set(['share-1']), isAgentNetShare: () => false, invoke, ...input });
  expect(invoke).not.toHaveBeenCalled();
  stop();
});
