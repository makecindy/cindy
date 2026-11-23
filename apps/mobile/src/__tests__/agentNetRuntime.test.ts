/** Production runtime registration -> real attachment entry. Known V2 offline
 * errors must prevent plaintext, while V1 sharing stays usable. The media-player
 * suite mocks agentNetRuntime and manually installed a backend, so it could not
 * catch the production callback swallowing errors. This suite loads the real
 * runtime once; native/notification/transport boundaries are inert memory fakes.
 * Unit tier: one scoped offline destination and one V1-only route, no I/O/waits.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RoutedDeviceLinkClient, sharedTaskHostPeer } from '@cindy/device-link';
import { createPrivateNetwork, generateIdentity, verifyCertificate } from '../../../../packages/agent-net-relay/src/index.js';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { parseAttachmentOssRef } from '@/session/attachmentOssRef';

const fake = vi.hoisted(() => ({ target: vi.fn(), open: vi.fn(), identity: vi.fn(), enabled: false, agentNetOnly: false,
  onlyEncrypted: false, createTransport: vi.fn(), rawFetch: vi.fn(), verifyCertificate: vi.fn(), readDirectory: vi.fn() }));
vi.mock('@cindy/agent-net/portable', async original => ({ ...await original<typeof import('@cindy/agent-net/portable')>(),
  AgentNetSocket: { openWithBindings: fake.open }, NativeTransport: { create: fake.createTransport } }));
vi.mock('@/api/client', async original => ({
  ...await original<typeof import('@/api/client')>(), apiFetchRaw: fake.rawFetch,
}));
vi.mock('expo-network', () => ({ getIpAddressAsync: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.test',
  getOfficialDeviceLinkApiBaseUrl: () => 'https://relay.example.test', getOfficialAgentNetApiBaseUrl: () => 'https://agent-net.example.test' }));
vi.mock('@/device-link/agentNetNative', () => ({ MobileAgentNetEngine: { available: () => true } }));
vi.mock('@/device-link/agentNetIdentity', () => ({ ensureMobileAgentNetIdentity: fake.identity, clearMobileAgentNetIdentity: vi.fn(), currentMobileAgentNetIdentity: () => null }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getActiveSelfHostedRelay: () => fake.agentNetOnly ? { signing: { agentNet: { certificate: {} } } } : null,
  getSelfHostedRelayRouteGeneration: () => 0, isAgentNetOnlyRoute: () => fake.agentNetOnly,
  subscribeSelfHostedRelayRoute: () => () => {}, deviceLinkMediaApiBaseUrl: () => 'https://relay.example.test' }));
vi.mock('@/device-link/agentNetPreferences', () => ({ getMobileAgentNetPreferences: () => ({ ready: true, enabled: fake.enabled, onlyEncrypted: fake.onlyEncrypted, generation: 0 }),
  mobileAgentNetRequiresEncryption: () => fake.onlyEncrypted, subscribeMobileAgentNetPreferences: () => () => {} }));
vi.mock('@/device-link/agentNetNotifications', () => ({ clearMobileAgentNetNotifications: vi.fn(),
  clearMobileAgentNetNotificationDelivery: vi.fn(), refreshMobileAgentNetNotificationPreferences: vi.fn(),
  mobileAgentNetNotificationScope: vi.fn(), mutateMobileAgentNetNotificationRegistration: vi.fn(),
  updateMobileAgentNetNotificationTrust: vi.fn(), sendMobileAgentNetNotification: vi.fn() }));
vi.mock('@/device-link/agentNetLan', () => ({ mobileAgentNetDiscovery: vi.fn() }));
vi.mock('@/device-link/agentNetProtocol', () => ({ verifyMobileAgentNetCertificate: fake.verifyCertificate, verifyMobileAgentNetDelegation: vi.fn() }));
vi.mock('@/device-link/agentNetDirectoryCache', () => ({ readMobileAgentNetDirectory: fake.readDirectory, writeMobileAgentNetDirectory: vi.fn() }));
vi.mock('@/device-link/agentNetMode', () => ({ verifyMobileAgentNetModeProof: vi.fn() }));
vi.mock('@/device-link/agentNetSharing', () => ({ mobileAgentNetSharingMediaTarget: fake.target, setMobileAgentNetPrivateSharingSupport: vi.fn() }));

import type { PortableSocketOptions } from '@cindy/agent-net/portable';
import * as Network from 'expo-network';
import { openMobileAgentNetSocket, isMobileAgentNetActive, mobileAgentNetIdentityRefused,
  mobileAgentNetShouldUseLegacyPeer, mobileAgentNetShouldProbeLegacyPeer,
  notifyMobileAgentNetNetworkChanged, stopMobileAgentNetRuntime } from '@/device-link/agentNetRuntime';
import { uploadMobileAttachment } from '@/session/mobileAttachmentUpload';
beforeEach(() => {
  fake.target.mockReset(); fake.open.mockReset(); fake.identity.mockReset(); fake.enabled = false; fake.agentNetOnly = false; fake.onlyEncrypted = false;
  fake.readDirectory.mockReset().mockResolvedValue(null);
  fake.rawFetch.mockReset().mockResolvedValue({ devices: [] });
  fake.createTransport.mockReset(); fake.verifyCertificate.mockReset().mockImplementation(verifyCertificate);
  setMobileAuthOwner('unit-media-owner');
});
afterEach(() => setMobileAuthOwner(null));
const deviceId = sharedTaskHostPeer('unit-shared-task', 'host');
const candidate = { name: 'note.txt', size: 1, mimeType: 'text/plain' };

it('keeps the installed backend from presigning or PUTing plaintext when a known V2 peer is unavailable', async () => {
  fake.target.mockImplementation(() => { throw new Error('AGENT_NET_MEDIA_PEER_UNAVAILABLE'); });
  const legacy = vi.fn();
  await expect(uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId, sharedTaskId: 'unit-shared-task', deps: { apiFetch: legacy, fetch: legacy } })).rejects.toThrow('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
  expect(legacy).not.toHaveBeenCalled();
});

it('keeps the actual legacy upload path for a scoped peer with no V2 route', async () => {
  const apiFetch = vi.fn(async () => ({ putUrl: 'https://oss.example.test/put', key: 'legacy-note' }));
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const attachment = await uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId, sharedTaskId: 'unit-shared-task', deps: { apiFetch: apiFetch as any, fetch: put } });
  expect(parseAttachmentOssRef(attachment.path)?.ossKey).toBe('legacy-note');
  expect(apiFetch).toHaveBeenCalledOnce(); expect(put).toHaveBeenCalledOnce();
});

// A retained V2 identity survives directory removal. Absence of its current
// certificate is not evidence that this ordinary peer can safely use plaintext.
it.each([false, true])('handles an ordinary peer missing a certificate without downgrading known V2 (known=%s)', async known => {
  fake.enabled = true;
  const socket = new EventEmitter() as any;
  socket.close = () => socket.emit('close', 1000);
  socket.knowsPeer = () => known; socket.certificateFor = () => undefined; socket.restrictPeers = () => undefined;
  fake.open.mockResolvedValue(socket);
  fake.identity.mockResolvedValue({ api: { identity: { deviceId: 'phone' }, certificate: { expiresAt: Date.now() + 48 * 60 * 60_000 } },
    signer: {}, newTransportEngine: async () => ({ destroy: vi.fn() }) });
  await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null });
  const apiFetch = vi.fn(async () => ({ putUrl: 'https://oss.example.test/put', key: 'legacy-note' }));
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const work = uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId: 'computer', deps: { apiFetch: apiFetch as any, fetch: put } });
  if (known) {
    await expect(work).rejects.toThrow('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
    expect(apiFetch).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  } else {
    expect(parseAttachmentOssRef((await work).path)?.ossKey).toBe('legacy-note');
    expect(apiFetch).toHaveBeenCalledOnce(); expect(put).toHaveBeenCalledOnce();
  }
});

/** Production Mobile startup + real PortableSocket/RoutedDeviceLinkClient.
 * Agent-Net's V1 parity rule: a relay outage with no directory must not disable
 * a healthy legacy link. Earlier media tests stubbed socket startup; Portable
 * recovery tests supplied a cached remote peer. Minimal input: our valid local
 * certificate, no cache, and one failed V2 connection. Unit: signed certificates
 * and real routing, only native transport and WebSocket I/O are in-memory fakes.
 */
it('opens a legacy link with no cached directory while the V2 relay is offline, without admitting unknown V2 peers', async () => {
  fake.enabled = true;
  const identity = generateIdentity('phone'), { bootstrap } = createPrivateNetwork('Offline mobile', identity);
  const { AgentNetSocket } = await vi.importActual<typeof import('@cindy/agent-net/portable')>('@cindy/agent-net/portable');
  fake.open.mockImplementation(AgentNetSocket.openWithBindings.bind(AgentNetSocket));
  fake.identity.mockResolvedValue({ api: { base: 'https://agent-net.example.test', rootPublicKey: bootstrap.rootPublicKey,
    identity, certificate: bootstrap.ownerCertificate, connect: async () => { throw new Error('offline'); } },
    signer: {}, newTransportEngine: async () => ({ destroy: vi.fn() }) });
  const connect = vi.fn();
  fake.createTransport.mockResolvedValue({ id: 'phone', dial: {}, connect, supports: () => false, close: async () => undefined });
  const socket = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null });
  expect(socket).not.toBeNull();
  await expect(socket!.dial('unknown')).rejects.toThrow('UNAUTHORIZED_PEER');
  expect(connect).not.toHaveBeenCalled();
  const frames: any[] = [];
  const legacy = Object.assign(new EventEmitter(), { bufferedAmount: 0,
    send: (text: string) => { frames.push(JSON.parse(text)); }, close: () => legacy.emit('close', 1000) });
  const options = { getWsUrl: () => 'wss://legacy.example.test', getToken: async () => 'unit-marker',
    getHello: () => ({ deviceName: 'Phone', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }),
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  const client = new RoutedDeviceLinkClient({ ...options, createWebSocket: () => socket! }, undefined, {
    active: () => true, useForPeer: mobileAgentNetShouldUseLegacyPeer, probeForPeer: mobileAgentNetShouldProbeLegacyPeer,
    options: { ...options, createWebSocket: () => legacy },
  });
  try {
    client.start();
    await vi.waitFor(() => expect(legacy.listenerCount('open')).toBeGreaterThan(0), { interval: 1 });
    legacy.emit('open');
    legacy.emit('message', JSON.stringify({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1,
      deviceId: 'phone', userId: 'unit-media-owner', capabilities: [] } }));
    const opened = client.openLink('legacy-desktop', {}, 1000);
    await vi.waitFor(() => expect(frames.find(frame => frame.kind === 'link-open')).toBeDefined(), { interval: 1 });
    const request = frames.find(frame => frame.kind === 'link-open');
    legacy.emit('message', JSON.stringify({ v: 1, kind: 'link-accept', id: request.id, src: 'legacy-desktop',
      payload: { appVersion: '1', allowlistHash: 'unit' } }));
    await expect(opened).resolves.toMatchObject({ appVersion: '1', allowlistHash: 'unit' });
    expect(client.connectionFor('legacy-desktop')).not.toBe(client);
  } finally { client.stop(); socket?.close(); }
});

it('fences the original account while the selected media module loads asynchronously', async () => {
  let started!: () => void, release!: () => void;
  const importing = new Promise<void>(resolve => { started = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const upload = vi.fn(async () => ({ key: 'agent-net-v3/unit-selected', sha256: 'a'.repeat(64) }));
  vi.doMock('@/device-link/agentNetMedia', async () => { started(); await ready; return { uploadMobileAgentNetMedia: upload }; });
  fake.target.mockReturnValue({});
  const legacy = vi.fn();
  const outcome = uploadMobileAttachment(candidate, new Uint8Array([1]).buffer, { token: 'unit-unused-token',
    deviceId, sharedTaskId: 'unit-shared-task', deps: { apiFetch: legacy, fetch: legacy } }).catch(error => error);
  await importing; setMobileAuthOwner('other-owner'); release();
  expect(await outcome).toMatchObject({ message: 'AGENT_NET_OWNER_CHANGED' });
  expect(upload).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
});

// Production socket startup must use the original V2 transport with the toggle
// off. With opt-in, even a never-answering UDP lookup cannot delay startup.
// Unit tier: one forced route, in-memory relay and native boundaries.
it.each([false, true])('keeps forced V2 startup independent of UDP discovery (enabled=%s)', async enabled => {
  fake.agentNetOnly = true;
  fake.enabled = enabled;
  const socket = new EventEmitter() as any;
  socket.close = () => socket.emit('close', 1000);
  const configureUdpServer = vi.fn();
  fake.createTransport.mockResolvedValue({ supports: () => true, configureUdpServer });
  fake.open.mockImplementation(async options => {
    await options.bindings.createTransport({});
    return socket;
  });
  const engine = { destroy: vi.fn() };
  const createEngine = vi.fn(async () => engine);
  fake.identity.mockResolvedValue({ api: { base: 'https://private.example.test',
    identity: { deviceId: 'phone' }, certificate: { networkId: 'private:test', expiresAt: Date.now() + 48 * 60 * 60_000 } },
    signer: {}, newTransportEngine: createEngine });
  let finishLookup!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finishLookup = resolve; }));
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null })).resolves.toBe(socket);
    expect(fetch).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(configureUdpServer).not.toHaveBeenCalled();
    expect(fake.rawFetch).not.toHaveBeenCalled();
    expect(createEngine).toHaveBeenCalledWith(expect.any(Function), enabled);
    expect(fake.createTransport).toHaveBeenCalledWith(engine, {}, expect.any(Function), enabled);
  } finally {
    finishLookup?.(new Response(null, { status: 503 }));
    socket.close();
    vi.unstubAllGlobals();
  }
});

// The admission rule must exclude a still-certified peer missing from the
// official Device Link response, even on the first socket open. V2 directory
// display tests cannot exercise this startup boundary. Unit with raw HTTP fake.
it('applies the raw official Device Link list before opening the Agent-Net socket', async () => {
  fake.enabled = true;
  const events = new EventEmitter();
  const socket = Object.assign(events, { restrictPeers: vi.fn(), close: () => events.emit('close', 1000) });
  fake.open.mockResolvedValue(socket);
  fake.rawFetch.mockResolvedValue({ devices: [{ deviceId: 'phone' }] });
  fake.readDirectory.mockResolvedValue({ devices: [{ certificate: { deviceId: 'removed-desktop' } }] });
  fake.identity.mockResolvedValue({ api: { identity: { deviceId: 'phone' }, certificate: { expiresAt: Date.now() + 48 * 60 * 60_000 } },
    signer: {}, newTransportEngine: async () => ({ destroy: vi.fn() }) });
  try {
    await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => 'unit-only' });
    expect(fake.rawFetch).toHaveBeenCalledExactlyOnceWith('/api/device-link/devices',
      expect.objectContaining({ baseUrl: 'https://relay.example.test' }));
    expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({ peerRule: { allowed: ['phone'], refused: [] } }));
  } finally { socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机 `openMobileAgentNetSocket` 与 `notifyMobileAgentNetNetworkChanged`。
 *   ① 官方设备列表请求与身份准备并行启动（不等 Keystore 准备完才发 HTTP），且在打开 socket 前收口准入规则；
 *   ② 同账号同局域网 IP 后台重开时传入上次已验证的直连 UDP 候选与 `deferRelay: true`；
 *   ③ 本机局域网 IP 变化或收到 `routeChanged: true` 物理切网通知后，立即清空旧私网直连候选，不再向新网络重拨旧内网地址。
 * - Bug／规则依据：2026-11-21 真机（Redmi K40）冷启动串行瀑布多耗约 440 ms，后台 20s 回前台因丢弃上次验证过的直连地址每次重走中转握手多耗约 400 ms；
 *   同时故障半径要求私网记忆地址仅限本进程同本地 IP，切网或退登立即失效。
 * - 现有覆盖缺口：已有测试只验证 `peerRule` 结果，未验证并行启动顺序、同 IP 直连地址复用及切网失效边界。
 * - 最小失败输入：1 台同账号桌面设备、两次同 IP 打开、一次换 IP 打开与一次 `routeChanged` 打开。tier：unit，内存桩，无计时器等待。 */
it('starts the official device-list check in parallel with identity setup and scopes remembered direct addresses to the same local route', async () => {
  fake.enabled = true;
  const phone = generateIdentity('phone'), desktop = generateIdentity('desktop-lan');
  const { root, bootstrap } = createPrivateNetwork('Fast resume', phone);
  const desktopCert = { ...bootstrap.ownerCertificate, deviceId: desktop.deviceId, signingKey: desktop.signingKey, transportKey: desktop.transportKey };
  void root;
  vi.mocked(Network.getIpAddressAsync).mockResolvedValue('192.168.1.50');
  fake.rawFetch.mockResolvedValue({ devices: [{ deviceId: 'phone' }, { deviceId: 'desktop-lan' }] });
  fake.readDirectory.mockResolvedValue({
    devices: [{ certificate: desktopCert, name: 'Desktop', online: false, remoteControlEnabled: true, capabilities: [] }],
    expiresAt: Date.now() + 60_000,
  });
  let sawParallelDeviceFetch = false;
  fake.identity.mockImplementation(async () => {
    await Promise.resolve();
    sawParallelDeviceFetch = fake.rawFetch.mock.calls.length === 1;
    return {
      api: { identity: phone, certificate: bootstrap.ownerCertificate },
      signer: {},
      newTransportEngine: async () => ({ destroy: vi.fn() }),
    };
  });
  const makeSocket = () => {
    const events = new EventEmitter();
    return Object.assign(events, { restrictPeers: vi.fn(), close: () => events.emit('close', 1000) });
  };
  const openedOptions: PortableSocketOptions[] = [];
  fake.open.mockImplementation(async (options) => {
    openedOptions.push(options);
    return makeSocket();
  });
  try {
    const first = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => 'token-1' });
    expect(sawParallelDeviceFetch).toBe(true);
    expect(openedOptions[0]?.deferRelay).toBeUndefined();
    expect(openedOptions[0]?.peerRule).toEqual({ allowed: ['phone', 'desktop-lan'], refused: [] });
    openedOptions[0]?.onDirectAddress?.('desktop-lan', { address: '192.168.1.10', port: 41000 });
    first?.close();

    const second = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => 'token-1' });
    expect(openedOptions[1]?.deferRelay).toBe(true);
    expect(openedOptions[1]?.initialCandidates?.get('desktop-lan')).toEqual({ address: '192.168.1.10', port: 41000 });
    second?.close();

    vi.mocked(Network.getIpAddressAsync).mockResolvedValue('192.168.2.88');
    const third = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => 'token-1' });
    expect(openedOptions[2]?.deferRelay).toBeUndefined();
    expect(openedOptions[2]?.initialCandidates).toBeUndefined();
    openedOptions[2]?.onDirectAddress?.('desktop-lan', { address: '192.168.2.10', port: 41000 });
    third?.close();

    notifyMobileAgentNetNetworkChanged({ routeChanged: true });
    const fourth = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => 'token-1' });
    expect(openedOptions[3]?.deferRelay).toBeUndefined();
    expect(openedOptions[3]?.initialCandidates).toBeUndefined();
    fourth?.close();
  } finally {
    stopMobileAgentNetRuntime();
  }
});

/** 测试价值
 * - 生产入口与可观察结果：手机 `openMobileAgentNetSocket` 与 `isMobileAgentNetActive` 在身份被 Agent-Net 永久撤销时的回退。
 *   当 WebSocket 握手被服务端直接断开（`AGENT_NET_SOCKET_ERROR`）、进程因本地目录缓存仍打开离线 `AgentNetSocket` 时，
 *   一次 `/directory` 探针确认 403 后立即记录 `mobileAgentNetIdentityRefused` 并以 `1006` 关闭该虚活连接，使主连接回退到
 *   Device Link（未重登时暴露真实 `4410` 已移除提示，已重登时恢复正常连接）；纯离线（`status: 0`）不误标被拒。
 * - Bug／规则依据：2026-11-21 Redmi K40 真机被从设备列表删除后，服务端 `server.ts` 对已撤销身份执行 `socket.destroy()`，
 *   手机因 `cachedDirectory` 保持虚活显示「Relay 已连接」，掩盖 `4410` 且重登后仍卡死；对齐桌面端 `agent-net-device-removal.md`。
 * - 现有覆盖缺口：已有离线用例没有 `api.directory` 403 与 0 状态码对照，未覆盖手机身份被拒后的回退。
 * - 最小失败输入：1 次离线（`status: 0`）保持 Agent-Net 开启 + 1 次被拒（`status: 403`）关闭虚活连接并切回 Device Link。
 * - tier：unit，真实 `AgentNetSocket.openWithBindings`，内存传输，无计时器等待；约 15 毫秒。 */
it.each([
  ['keeps offline cache mode when the directory check fails transiently', 'socket-error-0', false],
  ['closes the cached socket and falls back to Device Link when the identity is revoked (403)', 'socket-error-403', true],
  ['shows removal when the encrypted-only phone cold starts with a revoked credential', 'encrypted-revoked', true],
  ['converts a deferred-relay explicit 403 upgrade rejection into 1006 Device Link fallback instead of terminal 4410', 'deferred-403', true],
] as const)('verifies a failed initial relay handshake once via directory: %s', async (_label, mode, shouldRefuse) => {
  fake.enabled = true;
  fake.onlyEncrypted = mode === 'encrypted-revoked';
  const identity = generateIdentity('phone'), desktop = generateIdentity('desktop-lan');
  const { bootstrap } = createPrivateNetwork('Revoked mobile', identity);
  const desktopCert = { ...bootstrap.ownerCertificate, deviceId: desktop.deviceId, signingKey: desktop.signingKey, transportKey: desktop.transportKey };
  const { AgentNetSocket: RealSocket } = await vi.importActual<typeof import('@cindy/agent-net/portable')>('@cindy/agent-net/portable');
  fake.open.mockImplementation(RealSocket.openWithBindings.bind(RealSocket));
  fake.createTransport.mockResolvedValue({ id: 'phone', dial: {}, connect: vi.fn(async () => new Promise(() => {})), supports: () => false, close: async () => undefined });
  vi.mocked(Network.getIpAddressAsync).mockResolvedValue('192.168.1.50');
  if (mode === 'deferred-403') {
    fake.readDirectory.mockResolvedValue({
      devices: [{ certificate: desktopCert, name: 'Desktop', online: false, remoteControlEnabled: true, capabilities: [] }],
      expiresAt: Date.now() + 60_000,
    });
  }
  let rejectDeferred!: (error: Error) => void;
  let useDeferred = false;
  const directory = vi.fn(async () => {
    const status = mode === 'socket-error-403' || mode === 'encrypted-revoked' ? 403 : 0;
    const code = status === 403 ? 'DEVICE_REVOKED' : 'AGENT_NET_NETWORK_ERROR';
    throw Object.assign(new Error(code), { status, code });
  });
  fake.identity.mockResolvedValue({
    api: {
      base: 'https://agent-net.example.test', rootPublicKey: bootstrap.rootPublicKey,
      identity, certificate: bootstrap.ownerCertificate,
      connect: async () => {
        if (useDeferred) return new Promise((_resolve, reject) => { rejectDeferred = reject; });
        throw new Error('AGENT_NET_SOCKET_ERROR');
      },
      directory,
    },
    signer: {},
    newTransportEngine: async () => ({ destroy: vi.fn() }),
  });
  try {
    if (mode === 'deferred-403') {
      const seed = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null });
      // Seed a remembered direct LAN candidate on the same IP so the next open uses `deferRelay: true`.
      fake.open.mock.calls.at(-1)![0].onDirectAddress?.('desktop-lan', { address: '192.168.1.10', port: 41000 });
      seed?.close();
      directory.mockClear();
      useDeferred = true;
    }
    const socket = await openMobileAgentNetSocket({ deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null });
    expect(socket).not.toBeNull();
    if (mode === 'deferred-403') expect(fake.open.mock.calls.at(-1)![0].deferRelay).toBe(true);
    const closedCode = new Promise<number>(resolve => socket!.once('close', code => resolve(code)));
    if (mode === 'deferred-403') rejectDeferred(new Error('AGENT_NET_UPGRADE_403'));
    if (shouldRefuse) {
      await expect(closedCode).resolves.toBe(fake.onlyEncrypted ? 4410 : 1006);
      expect(mobileAgentNetIdentityRefused()).toBe(!fake.onlyEncrypted);
      expect(isMobileAgentNetActive()).toBe(fake.onlyEncrypted);
      if (mode === 'deferred-403') expect(directory).not.toHaveBeenCalled();
    } else {
      await Promise.resolve();
      await Promise.resolve();
      expect(mobileAgentNetIdentityRefused()).toBe(false);
      expect(isMobileAgentNetActive()).toBe(true);
      socket?.close();
    }
  } finally {
    stopMobileAgentNetRuntime();
  }
});
