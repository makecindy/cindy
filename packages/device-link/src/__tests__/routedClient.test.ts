/**
 * 测试价值
 * - 生产入口与可观察结果:`RoutedDeviceLinkClient` —— Desktop 与 Mobile 唯一的连接入口,断言每帧实际写进哪条
 *   socket、host 收到哪些帧、两条连接断开时对方的状态。
 * - Bug/规则依据:docs/self-hosted-relay-plan.md §7(跨账号帧走官方中转、同账号帧不能借这条连接绕过自建中转)、
 *   docs/dev-rules/remote-and-mobile-adaptation.md 故障半径三问。
 * - 现有覆盖缺口:新增路由层;client.test.ts 只覆盖单连接。
 * - 最小失败输入:见各用例(官方线路误开第二条连接、同账号 invoke 进入业务层、中转移除设备连带停掉官方连接)。
 * - tier:unit,fake WebSocket,无真实等待。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLinkClient, DeviceLinkClientOptions, WsLike } from '../client.js';
import { RoutedDeviceLinkClient } from '../routedClient.js';
import { PROTOCOL_VERSION, SHARED_TASK_RELAY_CAPABILITY, sharedTaskHostPeer, type Envelope } from '../protocol.js';

type Handler = (...args: unknown[]) => void;

class FakeWs implements WsLike {
  sent: Envelope[] = [];
  bufferedAmount = 0;
  private handlers = new Map<string, Handler[]>();
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(data: string): void { this.sent.push(JSON.parse(data) as Envelope); }
  close(code?: number): void { this.emit('close', code ?? 1000); }
  terminate(): void {}
  on(event: string, cb: (...args: never[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb as Handler]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  push(env: Envelope): void { this.emit('message', { toString: () => JSON.stringify(env) }); }
  ack(capabilities: string[] = []): void {
    this.emit('open');
    this.push({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
      serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'dev-self', userId: 'u1', capabilities,
    } });
  }
}

const RELAY = 'wss://relay.example/ws';
const OFFICIAL = 'wss://official.example/ws';
const SHARED_PEER = sharedTaskHostPeer('task-a', 'host-device');

function harness(selfHosted: { value: boolean }) {
  const sockets: FakeWs[] = [];
  const common: Pick<DeviceLinkClientOptions, 'getHello' | 'createWebSocket'> = {
    getHello: () => ({ capabilities: [], deviceName: 'd', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
    createWebSocket: (url, headers) => {
      const socket = new FakeWs(url, headers as Record<string, string>);
      sockets.push(socket);
      return socket;
    },
  };
  const client = new RoutedDeviceLinkClient({
    ...common,
    getWsUrl: () => (selfHosted.value ? RELAY : OFFICIAL),
    getToken: async () => (selfHosted.value ? 'relay-credential' : 'account-token'),
    authorizationScheme: () => (selfHosted.value ? 'CindyRelay' : 'Bearer'),
  }, {
    active: () => selfHosted.value,
    options: { ...common, getWsUrl: () => OFFICIAL, getToken: async () => 'account-token' },
  });
  const socketTo = (url: string) => {
    const socket = sockets.filter((item) => item.url === url).at(-1);
    if (!socket) throw new Error(`no socket to ${url}`);
    return socket;
  };
  const tick = () => vi.advanceTimersByTimeAsync(1);
  return { client, sockets, socketTo, tick };
}

async function onlineSelfHosted() {
  const h = harness({ value: true });
  h.client.start();
  await h.tick();
  h.socketTo(RELAY).ack();
  h.socketTo(OFFICIAL).ack([SHARED_TASK_RELAY_CAPABILITY]);
  await h.tick();
  return h;
}

describe('RoutedDeviceLinkClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  // PR #9937: Host history bases subscribe to the routed facade, not its inner
  // clients. Existing routing tests did not observe inbound release events.
  // Minimal regression: kick an old controller on the compatibility connection.
  // Unit, fake sockets; also cover primary, cross-account, late resource pins,
  // timeout retention and observer disposal without touching another peer.
  it('forwards inbound releases from every connection and disposes late subscriptions', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const client = new RoutedDeviceLinkClient(options(RELAY), { active: () => true, options: options(OFFICIAL) },
      { active: () => true, useForPeer: peer => peer === 'old-device', options: options('ws://legacy') });
    const released: string[] = [];
    const off = client.onInboundPeerReleased(peer => released.push(peer));
    const retire = client.registerScopedConnection({ kind: 'shared-task', resourceId: 'pinned' }, options('ws://pinned'));
    const pinned = sharedTaskHostPeer('pinned', 'host-device');
    client.start(); await vi.advanceTimersByTimeAsync(1);
    for (const socket of sockets) socket.ack([SHARED_TASK_RELAY_CAPABILITY]);
    await vi.advanceTimersByTimeAsync(1);
    const peers = ['primary-device', 'old-device', SHARED_PEER, pinned];
    for (const peer of peers) {
      client.closeLink(peer, 'transport-timeout', 'inbound');
      client.closeLink(peer, 'user');
    }
    expect(released).toEqual([]);
    for (const peer of peers) client.closeLink(peer, 'revoked', 'inbound');
    expect(released).toEqual(peers);
    off();
    for (const peer of peers) client.closeLink(peer, 'revoked', 'inbound');
    expect(released).toEqual(peers);
    retire(); client.stop();
  });
  // Official V2 must not open two V1 sockets with the same physical identity:
  // they would continuously evict each other. Existing tests use distinct origins.
  // Unit, fake socket; observable routing includes old and new scoped resources.
  it('shares the official compatibility socket between legacy devices and old scoped resources', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({ getWsUrl: () => url, getToken: async () => 'unit-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; } });
    const client = new RoutedDeviceLinkClient(options(RELAY), { active: () => true, useLegacyConnection: () => true,
      options: options(OFFICIAL) }, { active: () => true, useForPeer: () => true, options: options(OFFICIAL) });
    client.start(); await vi.advanceTimersByTimeAsync(1);
    expect(sockets.filter(s => s.url === OFFICIAL)).toHaveLength(1);
    for (const socket of sockets) socket.ack([SHARED_TASK_RELAY_CAPABILITY]);
    await vi.advanceTimersByTimeAsync(1);
    const compatibility = client.connectionFor(SHARED_PEER);
    expect(client.connectionFor('old-device')).toBe(compatibility);
    expect(compatibility).not.toBe(client);
    client.registerScopedConnection({ kind: 'shared-task', resourceId: 'new-task' }, 'primary');
    expect(client.connectionFor(sharedTaskHostPeer('new-task', 'host-device'))).toBe(client);
    expect(client.connectionFor(SHARED_PEER)).toBe(compatibility);
    client.stop();
  });
  // V2 self-hosted parity: a resource pin overrides the official V1 route.
  // Existing tests only know static account-wide routes. Minimal failure: two
  // tasks with separate relays, registered after observers/start; a retired pin
  // must fail closed. Unit tier, fake sockets, no real waits.
  it('pins scoped resources independently, joins late events and never falls back after retirement', async () => {
    const h = await onlineSelfHosted();
    const received: Envelope[] = [];
    const off = h.client.onFrame(frame => received.push(frame));
    const resource = (task: string, address: string) => h.client.registerScopedConnection({ kind: 'shared-task', resourceId: task }, {
      getWsUrl: () => address, getToken: async () => 'resource-proof',
      getHello: () => ({ deviceName: 'Guest', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false }),
      createWebSocket: (url, headers) => { const socket = new FakeWs(url, headers); h.sockets.push(socket); return socket; },
    });
    const retire = resource('task-a', 'wss://private-a.example/ws');
    const retireB = resource('task-b', 'wss://private-b.example/ws'); await h.tick();
    const a = h.socketTo('wss://private-a.example/ws'), b = h.socketTo('wss://private-b.example/ws');
    a.ack([SHARED_TASK_RELAY_CAPABILITY]); b.ack([SHARED_TASK_RELAY_CAPABILITY]); await h.tick();
    void h.client.openLink(SHARED_PEER, {}).catch(() => undefined);
    void h.client.openLink(sharedTaskHostPeer('task-b', 'host-device'), {}).catch(() => undefined); await h.tick();
    expect(a.sent.some(frame => frame.kind === 'link-open' && frame.sharedTask?.sharedTaskId === 'task-a')).toBe(true);
    expect(b.sent.some(frame => frame.kind === 'link-open' && frame.sharedTask?.sharedTaskId === 'task-b')).toBe(true);
    expect(h.socketTo(OFFICIAL).sent.some(frame => frame.kind === 'link-open')).toBe(false);
    const push = { v: PROTOCOL_VERSION, kind: 'push' as const, src: 'host-device', dst: 'dev-self',
      sharedTask: { sharedTaskId: 'task-a', source: { role: 'host' as const }, target: { role: 'guest' as const, memberId: 'member-a' } },
      payload: { channel: 'shared:update', payload: 'private' } };
    a.push(push); b.push(push); h.socketTo(OFFICIAL).push(push);
    expect(received.filter(frame => frame.kind === 'push')).toHaveLength(1);
    retire();
    expect(h.client.connectionFor(SHARED_PEER).getStatus()).toBe('stopped');
    void h.client.openLink(SHARED_PEER, {}).catch(() => undefined); await h.tick();
    expect(h.socketTo(OFFICIAL).sent.some(frame => frame.kind === 'link-open')).toBe(false);
    off(); b.push({ ...push, sharedTask: { ...push.sharedTask, sharedTaskId: 'task-b' } });
    expect(received.filter(frame => frame.kind === 'push')).toHaveLength(1);
    h.socketTo(RELAY).close(4410); h.socketTo(OFFICIAL).close(4410); await h.tick();
    expect(h.client.getStatus()).toBe('stopped');
    expect(h.client.hasOnlineConnection()).toBe(true); // Private task B still supports foreground recovery.
    retireB(); expect(h.client.hasOnlineConnection()).toBe(false);
    h.client.stop();
  });
  // A directory outage is not permission to send business data in cleartext; only an authenticated peer handshake can select V1.
  it.each([false, true])('probes only the link handshake and chooses the peer\'s confirmed transport (V2=%s)', async (newer) => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-test-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => true, useForPeer: () => false, probeForPeer: () => true,
      primaryCapability: 'agent-net-node-v2', options: options('ws://v1-relay'),
    });
    client.start(); await vi.advanceTimersByTimeAsync(1);
    const primary = sockets.find((s) => s.url === 'ws://v2-node')!, legacy = sockets.find((s) => s.url === 'ws://v1-relay')!;
    primary.ack(); legacy.ack(); await vi.advanceTimersByTimeAsync(1);
    const opened = client.openLink('known-peer', {}); await vi.advanceTimersByTimeAsync(1);
    const probe = legacy.sent.find((f) => f.kind === 'link-open')!;
    expect(primary.sent.some((f) => f.kind === 'link-open')).toBe(false);
    legacy.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: probe.id, src: 'known-peer', payload: {
      appVersion: '1', allowlistHash: 'unit', capabilities: newer ? ['agent-net-node-v2'] : [],
    } }); await vi.advanceTimersByTimeAsync(1);
    if (newer) {
      const actual = primary.sent.find((f) => f.kind === 'link-open')!;
      expect(actual).toBeDefined();
      primary.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: actual.id, src: 'known-peer', payload: { appVersion: '1', allowlistHash: 'unit' } });
    }
    await opened;
    void client.invoke('known-peer', { channel: 'private:business', args: ['secret'] }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(primary.sent.some((f) => f.kind === 'invoke')).toBe(newer);
    expect(legacy.sent.some((f) => f.kind === 'invoke')).toBe(!newer);
    client.stop();
  });
  it('routes only peers without V2 to the compatibility socket and replies on the path which accepted a request', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-test-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => true, useForPeer: (peer) => peer === 'old-device', options: options('ws://v1-relay'),
    });
    client.onFrame((frame) => { if (frame.kind === 'link-open' && frame.src && frame.id) client.sendLinkAccept(frame.src, frame.id, { appVersion: '1', allowlistHash: 'unit' }); });
    client.start(); await vi.advanceTimersByTimeAsync(1);
    const primary = sockets.find((s) => s.url === 'ws://v2-node')!, legacy = sockets.find((s) => s.url === 'ws://v1-relay')!;
    primary.ack(); legacy.ack(); await vi.advanceTimersByTimeAsync(1);
    void client.openLink('new-device', {}).catch(() => undefined);
    void client.openLink('old-device', {}).catch(() => undefined); await vi.advanceTimersByTimeAsync(1);
    expect(primary.sent.some((f) => f.kind === 'link-open' && f.dst === 'new-device')).toBe(true);
    expect(legacy.sent.some((f) => f.kind === 'link-open' && f.dst === 'old-device')).toBe(true);
    legacy.push({ v: PROTOCOL_VERSION, kind: 'link-open', src: 'new-device', id: 'request-on-old-path',
      payload: { controllerName: 'unit', protocolVersion: PROTOCOL_VERSION, appVersion: '1' } });
    expect(legacy.sent.some((f) => f.kind === 'link-accept' && f.id === 'request-on-old-path')).toBe(true);
    expect(primary.sent.some((f) => f.kind === 'link-accept' && f.id === 'request-on-old-path')).toBe(false);
    client.stop();
  });

  it('opens no second connection on the official route, so scoped peers stay on the only socket', async () => {
    const h = harness({ value: false });
    h.client.start();
    await h.tick();
    expect(h.sockets).toHaveLength(1);
    h.socketTo(OFFICIAL).ack([SHARED_TASK_RELAY_CAPABILITY]);
    await h.tick();

    expect(h.sockets).toHaveLength(1);
    expect(h.client.crossAccountConnection()).toBe(h.client);
    expect(h.client.connectionFor(SHARED_PEER)).toBe(h.client);
    void h.client.invoke(SHARED_PEER, { channel: 'c', args: [] }).catch(() => undefined);
    await h.tick();
    expect(h.socketTo(OFFICIAL).sent.at(-1)).toMatchObject({ dst: 'host-device', sharedTask: { sharedTaskId: 'task-a' } });
    h.client.stop();
  });

  it('sends cross-account frames to the official relay with the account token, and the rest to the own relay', async () => {
    const h = await onlineSelfHosted();
    expect(h.socketTo(RELAY).headers.authorization).toBe('CindyRelay relay-credential');
    expect(h.socketTo(OFFICIAL).headers.authorization).toBe('Bearer account-token');

    void h.client.invoke(SHARED_PEER, { channel: 'shared', args: [] }).catch(() => undefined);
    void h.client.invoke('same-account-device', { channel: 'own', args: [] }).catch(() => undefined);
    await h.tick();

    const invokes = (socket: FakeWs) => socket.sent.filter((frame) => frame.kind === 'invoke' || frame.kind === 'link-open');
    expect(invokes(h.socketTo(OFFICIAL)).map((frame) => frame.dst)).toEqual(['host-device']);
    expect(invokes(h.socketTo(RELAY)).map((frame) => frame.dst)).toEqual(['same-account-device']);
    h.client.stop();
  });

  // New read channel must negotiate support, stay on the selected self-hosted route,
  // and return the host result without exposing it to the official connection.
  it('negotiates GitHub reads and completes them on the self-hosted relay', async () => {
    const h = await onlineSelfHosted();
    const peer = 'same-account-device';
    const payload = { channel: 'git-context:github-read', args: [{ method: 'get_pr_status', args: { pr: { repo: 'o/r', number: 1 } } }] };
    expect(await h.client.invoke(peer, payload)).toMatchObject({ ok: false, error: { message: expect.stringContaining('GITHUB_READ_UNSUPPORTED') } });
    const socket = h.socketTo(RELAY);
    const opening = h.client.openLink(peer, { controllerName: 'Test', protocolVersion: 1, appVersion: '1' });
    await h.tick();
    const request = socket.sent.filter(frame => frame.kind === 'link-open').at(-1)!;
    socket.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: request.id, src: peer,
      payload: { appVersion: '1', allowlistHash: 'hash', capabilities: ['github-read-v1'] } });
    await opening;
    // 远程连接拓扑:路由客户端的快照经基类读自建中转那条连接;这里的对端没声明可靠传输,是 legacy 链路,不算拓扑里的链路。
    expect(h.client.getPeerLinkSnapshots()).toEqual([]);
    expect(h.client.getRelayRttMs()).toBeNull();
    const result = h.client.invoke(peer, payload);
    await h.tick();
    const invoke = socket.sent.filter(frame => frame.kind === 'invoke').at(-1)!;
    expect(invoke.payload).toMatchObject(payload);
    socket.push({ v: PROTOCOL_VERSION, kind: 'invoke-result', id: invoke.id, src: peer,
      payload: { ok: true, result: { head_sha: 'current', source_device: peer } } });
    expect(await result).toMatchObject({ ok: true, result: { head_sha: 'current' } });
    expect(h.socketTo(OFFICIAL).sent.some(frame => frame.kind === 'invoke')).toBe(false);
    h.client.stop();
  });

  it('never lets a same-account peer reach this device through the official connection', async () => {
    const h = await onlineSelfHosted();
    const frames: Envelope[] = [];
    h.client.onFrame((env) => { frames.push(env); });
    const official = h.socketTo(OFFICIAL);

    official.push({ v: PROTOCOL_VERSION, kind: 'invoke', id: 'r1', src: 'same-account-device', dst: 'dev-self',
      payload: { channel: 'maker:fs:read', args: [] } });
    official.push({ v: PROTOCOL_VERSION, kind: 'link-open', id: 'r2', src: 'same-account-device', dst: 'dev-self', payload: {} });
    await h.tick();

    expect(frames).toEqual([]);
    expect(official.sent.at(-1)).toMatchObject({ kind: 'link-close', dst: 'same-account-device', payload: { reason: 'toggle-off' } });
    h.client.stop();
  });

  it('delivers relay-scoped cross-account frames from the official connection to host handlers', async () => {
    const h = await onlineSelfHosted();
    const frames: Envelope[] = [];
    h.client.onFrame((env) => { frames.push(env); });

    h.socketTo(OFFICIAL).push({ v: PROTOCOL_VERSION, kind: 'link-open', id: 'r1', src: 'guest-device', dst: 'dev-self',
      payload: { controllerName: 'guest', protocolVersion: 1, appVersion: '1' },
      sharedTask: { sharedTaskId: 'task-a', source: { role: 'guest', memberId: 'member' }, target: { role: 'host' } } });
    await h.tick();

    expect(frames.map((frame) => frame.kind)).toEqual(['link-open']);
    h.client.stop();
  });

  it('keeps each connection\'s outage on its own side', async () => {
    const h = await onlineSelfHosted();
    const primary: string[] = [];
    const crossAccount: string[] = [];
    h.client.onStatusChange((status) => primary.push(status));
    h.client.onSeparateCrossAccountStatus((status) => crossAccount.push(status));

    h.socketTo(OFFICIAL).close(1006);
    await h.tick();
    expect(primary).toEqual([]);
    expect(h.client.getStatus()).toBe('online');
    expect(crossAccount.length).toBeGreaterThan(0);
    expect(h.client.crossAccountConnection().getStatus()).not.toBe('online');
    h.client.stop();
  });

  it('keeps shared work online when the own relay removes this device, and stops both for the host', async () => {
    const h = await onlineSelfHosted();
    const relay = h.socketTo(RELAY);
    relay.close(4410);
    await h.tick();

    expect(h.client.getStatus()).toBe('stopped');
    expect(h.client.getConnectionIssue()?.kind).toBe('device-removed');
    const crossAccount = h.client.crossAccountConnection();
    expect(crossAccount).not.toBe(h.client);
    expect(crossAccount.getStatus()).toBe('online');

    h.client.stop();
    expect(crossAccount.getStatus()).toBe('stopped');
  });

  it('restarts the official connection after the host stops and reconnects from the background', async () => {
    const h = await onlineSelfHosted();
    h.client.stop();
    const before = h.sockets.length;

    h.client.connectAllNow('appstate-active');
    await h.tick();

    expect(h.sockets.slice(before).map((socket) => socket.url).sort()).toEqual([OFFICIAL, RELAY].sort());
    h.client.stop();
  });

  it('mirrors presence to the official relay, which gates guests on it', async () => {
    const h = await onlineSelfHosted();
    h.client.sendPresence({ remoteControlEnabled: false });
    await h.tick();
    const presence = (socket: FakeWs) => socket.sent.filter((frame) => frame.kind === 'presence-set').at(-1)?.payload;
    expect(presence(h.socketTo(OFFICIAL))).toMatchObject({ remoteControlEnabled: false });
    expect(presence(h.socketTo(RELAY))).toMatchObject({ remoteControlEnabled: false });
    h.client.stop();
  });

  // 桌面端 #9537 的 Codex review P1:数据面路径(直连 ↔ relay)的变化必须从**承载该
  // peer 的那条连接**汇总到路由客户端上 —— 基类只发自己那条连接上的变化,被路由到
  // legacy / 跨账号 / scoped 连接的 peer 换路时事件留在那条连接上,host 收不到,
  // 连接诊断会一直按旧路径的判定提示用户。
  it('aggregates peer path changes from the routed connections', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const client = new RoutedDeviceLinkClient(options(RELAY), { active: () => true, options: options(OFFICIAL) },
      { active: () => true, useForPeer: peer => peer === 'old-device', options: options('ws://legacy') });
    client.start();
    await vi.advanceTimersByTimeAsync(1);
    const changes: Array<{ deviceId: string; path: string }> = [];
    const off = client.onPeerPathChanged(change => changes.push({ deviceId: change.deviceId, path: change.path }));

    // 旧同账号对端走独立的 legacy 连接:它的换路事件在那条连接上,路由客户端要能收到。
    const legacy = client.connectionFor('old-device');
    expect(legacy).not.toBe(client);
    emitPathChange(legacy, 'old-device', 'direct');
    expect(changes).toEqual([{ deviceId: 'old-device', path: 'direct' }]);

    // 只有**承载连接**的事件算数:主连接自己为这个 legacy 对端发的换路不是事实,
    // 传出去会让 main 的 directDataPeers 停在不承载流量的那条连接上(Codex review P1)。
    emitPathChange(client, 'old-device', 'relay');
    expect(changes).toHaveLength(1);

    // 退订之后不再收到(事件订阅要能释放)。
    off();
    emitPathChange(legacy, 'old-device', 'relay');
    expect(changes).toHaveLength(1);
    client.stop();
  });

  // 桌面端 #9537 的 Codex review P1(第二轮):探测把归属从 legacy 交给主连接时,两条子连接的
  // path 表都没动,onPeerPathChanged 不会响 —— 而「这个对端现在走哪条 socket」已经换了。
  // 诊断钉在旧连接的判定上不失效(main 的 directDataPeers 同理),路由层必须单独通知一次。
  it('notifies route-owner changes when the legacy probe hands a peer to the primary', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => true, useForPeer: () => false, probeForPeer: () => true,
      primaryCapability: 'agent-net-node-v2', options: options('ws://v1-relay'),
    });
    const owners: string[] = [];
    const changes: Array<{ deviceId: string; path: string }> = [];
    const offOwner = client.onPeerRouteOwnerChanged(deviceId => owners.push(deviceId));
    client.onPeerPathChanged(change => changes.push({ deviceId: change.deviceId, path: change.path }));
    client.start();
    await vi.advanceTimersByTimeAsync(1);
    const primarySocket = sockets.find((s) => s.url === 'ws://v2-node')!, legacySocket = sockets.find((s) => s.url === 'ws://v1-relay')!;
    primarySocket.ack(); legacySocket.ack(); await vi.advanceTimersByTimeAsync(1);
    const opened = client.openLink('known-peer', {}); await vi.advanceTimersByTimeAsync(1);
    const probe = legacySocket.sent.find((f) => f.kind === 'link-open')!;
    expect(owners).toEqual([]); // 探测进行中:归属还没变。

    // 探测结果说这个对端能走主连接 → 归属换人,而两条连接的 path 表都没动。
    legacySocket.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: probe.id, src: 'known-peer', payload: {
      appVersion: '1', allowlistHash: 'unit', capabilities: ['agent-net-node-v2'],
    } }); await vi.advanceTimersByTimeAsync(1);
    expect(owners).toEqual(['known-peer']);
    expect(changes).toEqual([]); // 归属切换不是路径变化:不发 onPeerPathChanged。

    // 归属已经归主连接:legacy 之后为自己那条 socket 发的换路,不再是这个对端的事实。
    emitPathChange(client.legacyConnection()!, 'known-peer', 'direct');
    expect(changes).toEqual([]);
    emitPathChange(client, 'known-peer', 'direct');
    expect(changes).toEqual([{ deviceId: 'known-peer', path: 'direct' }]);

    offOwner();
    const accepted = primarySocket.sent.find((f) => f.kind === 'link-open')!;
    primarySocket.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: accepted.id, src: 'known-peer', payload: { appVersion: '1', allowlistHash: 'unit' } });
    await opened; client.stop();
  });

  // 同一个不变量的另一扇门:legacy 兜底整体关掉时,记在它上面的归属一起回到主连接。
  it('notifies route-owner changes when the legacy fallback retires every routed peer', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    let legacyActive = true;
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => legacyActive, useForPeer: () => false, probeForPeer: () => true, options: options('ws://v1-relay'),
    });
    const owners: string[] = [];
    const changes: Array<{ deviceId: string; path: string }> = [];
    client.onPeerRouteOwnerChanged(deviceId => owners.push(deviceId));
    client.onPeerPathChanged(change => changes.push({ deviceId: change.deviceId, path: change.path }));
    client.start();
    await vi.advanceTimersByTimeAsync(1);
    const primarySocket = sockets.find((s) => s.url === 'ws://v2-node')!, legacySocket = sockets.find((s) => s.url === 'ws://v1-relay')!;
    primarySocket.ack(); legacySocket.ack(); await vi.advanceTimersByTimeAsync(1);
    const opened = client.openLink('known-peer', {}); await vi.advanceTimersByTimeAsync(1);
    const probe = legacySocket.sent.find((f) => f.kind === 'link-open')!;
    // 探测结果说不具备主连接能力 → 归属记在 legacy 上。
    legacySocket.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: probe.id, src: 'known-peer', payload: {
      appVersion: '1', allowlistHash: 'unit',
    } }); await vi.advanceTimersByTimeAsync(1);
    expect(owners).toEqual(['known-peer']);
    expect(client.connectionFor('known-peer')).toBe(client.legacyConnection());
    expect(changes).toEqual([]);

    legacyActive = false;
    client.connectNow('unit-legacy-off'); await vi.advanceTimersByTimeAsync(1);
    expect(owners).toEqual(['known-peer', 'known-peer']);
    expect(client.connectionFor('known-peer')).toBe(client);
    // 归属已经归主连接、legacy 也停了:主连接自己的换路照常上报。
    emitPathChange(client, 'known-peer', 'direct');
    expect(changes).toEqual([{ deviceId: 'known-peer', path: 'direct' }]);
    await opened; client.stop();
  });

});

/** 路径变化在 client 内部是私有发射器:单测直接触发它,验证路由层有没有汇总上来。 */
function emitPathChange(connection: DeviceLinkClient, deviceId: string, path: 'direct' | 'relay'): void {
  (connection as unknown as {
    emitPeerPathChanged(change: { deviceId: string; path: 'direct' | 'relay' }): void;
  }).emitPeerPathChanged({ deviceId, path });
}
