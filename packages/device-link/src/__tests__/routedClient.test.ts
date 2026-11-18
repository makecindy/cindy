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
import type { DeviceLinkClientOptions, WsLike } from '../client.js';
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
  // 2026-11-17: a peer probed during its restart attests the newer transport before it is reachable there; the host opens the link
  // on its own channel to that peer (Agent-Net sessions) instead of queueing a link-open frame on the main connection.
  it('lets the host re-open a peer that prefers the main connection on its own channel, or fall back to the main connection', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-test-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const seen: string[] = [];
    let ownChannel = true;
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => true, useForPeer: () => false, probeForPeer: () => true, primaryCapability: 'agent-net-node-v2',
      openOnPrimary: async (peer, _payload, _timeout, primaryOpen) => {
        seen.push(peer);
        return ownChannel ? { appVersion: 'own-channel', allowlistHash: 'own' } : primaryOpen();
      },
      options: options('ws://v1-relay'),
    });
    client.start(); await vi.advanceTimersByTimeAsync(1);
    const primary = sockets.find((s) => s.url === 'ws://v2-node')!, legacy = sockets.find((s) => s.url === 'ws://v1-relay')!;
    primary.ack(); legacy.ack(); await vi.advanceTimersByTimeAsync(1);
    const probeAccepted = async (peer: string) => {
      const probe = legacy.sent.find((f) => f.kind === 'link-open' && f.dst === peer)!;
      legacy.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: probe.id, src: peer, payload: {
        appVersion: '1', allowlistHash: 'unit', capabilities: ['agent-net-node-v2'] } });
      await vi.advanceTimersByTimeAsync(1);
    };
    const own = client.openLink('restarting-peer', {}); await vi.advanceTimersByTimeAsync(1);
    await probeAccepted('restarting-peer');
    await expect(own).resolves.toMatchObject({ appVersion: 'own-channel' });
    expect(primary.sent.some((f) => f.kind === 'link-open')).toBe(false);
    ownChannel = false;
    const fallback = client.openLink('other-peer', {}); await vi.advanceTimersByTimeAsync(1);
    await probeAccepted('other-peer');
    const actual = primary.sent.find((f) => f.kind === 'link-open' && f.dst === 'other-peer')!;
    expect(actual).toBeDefined();
    primary.push({ v: PROTOCOL_VERSION, kind: 'link-accept', id: actual.id, src: 'other-peer', payload: { appVersion: '1', allowlistHash: 'unit' } });
    await expect(fallback).resolves.toMatchObject({ appVersion: '1' });
    expect(seen).toEqual(['restarting-peer', 'other-peer']);
    client.stop();
  });
  // 2026-11-17 audit: presence arriving on the compatibility socket never reached the host, so phones without the newer
  // transport and older Desktops no longer updated online/allow-control live while it was on.
  it('marks a legacy-only phone offline when its connection drops and leaves primary presence alone', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-test-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    let compatibility = true;
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => compatibility, useForPeer: (peer) => peer === 'phone', options: options('ws://v1-relay'),
    });
    const seen: string[] = [];
    client.onPresenceChanged((snap) => seen.push(`${snap.deviceId}:${snap.online}:${snap.busy}`));
    client.start(); await vi.advanceTimersByTimeAsync(1);
    const primary = sockets.find((s) => s.url === 'ws://v2-node')!, legacy = sockets.find((s) => s.url === 'ws://v1-relay')!;
    primary.ack(); legacy.ack(); await vi.advanceTimersByTimeAsync(1);
    expect(client.legacyConnection()).not.toBeNull();
    const presence = (socket: FakeWs, deviceId: string, online: boolean, busy = false) => socket.push({ v: PROTOCOL_VERSION,
      kind: 'presence-changed', payload: { deviceId, online, busy, deviceName: deviceId, platform: 'test', appVersion: '1', lastSeenAt: 1,
        remoteControlEnabled: true } });
    // A phone only the compatibility socket knows.
    presence(legacy, 'phone', true);
    presence(primary, 'desktop', true, true);
    presence(legacy, 'desktop', false);
    expect(seen).toEqual(['phone:true:false', 'desktop:true:true']);
    legacy.close(1006); await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(['phone:true:false', 'desktop:true:true', 'phone:false:false']);
    client.stop();
    // Compatibility connection not running (the newer transport off): exactly the main connection's presence.
    compatibility = false; sockets.length = 0; seen.length = 0;
    client.start(); await vi.advanceTimersByTimeAsync(1);
    const mainOnly = sockets.find((s) => s.url === 'ws://v2-node')!;
    mainOnly.ack(); await vi.advanceTimersByTimeAsync(1);
    expect(client.legacyConnection()).toBeNull();
    presence(mainOnly, 'desktop', false); presence(mainOnly, 'desktop', true, true);
    expect(seen).toEqual(['desktop:false:false', 'desktop:true:true']);
    client.stop();
  });
  // 2026-11-17：Node Host 没有单独的跨账号连接，兼容连接的 401 没人听，令牌一直不刷新、手机一直连不上它，状态里也看不到原因。
  it('reports a problem of the compatibility connection on its own, and leaves the main connection clear', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-test-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => true, useForPeer: (peer) => peer === 'phone', options: options('ws://v1-relay'),
    });
    const issues: Array<string | null> = [];
    const off = client.onLegacyConnectionIssue((issue) => issues.push(issue?.kind ?? null));
    client.start(); await vi.advanceTimersByTimeAsync(1);
    sockets.find((s) => s.url === 'ws://v2-node')!.ack();
    const legacy = sockets.find((s) => s.url === 'ws://v1-relay')!;
    legacy.emit('error', new Error('Unexpected server response: 401'));
    legacy.emit('close', 1006);
    await vi.advanceTimersByTimeAsync(1);
    expect(issues).toContain('auth-failed');
    expect(client.getConnectionIssue()).toBeNull();
    off(); client.stop();
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

  // 2026-11-17: a Desktop slept overnight; after wake a peer carried by the
  // compatibility connection stayed "offline" in the UI for 40+ minutes while its
  // invokes succeeded. Only the primary's presence reached the host, so the
  // compatibility relay's real online presence for that peer was dropped and the
  // host had to rely on a directory REST read that failed at wake. Presence must
  // come from the connection that actually carries the peer; the primary's view of
  // such a peer is not authoritative, and peers on the primary are unaffected.
  it('reports each peer\'s presence from the connection that carries it', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-test-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => true, useForPeer: (peer) => peer === 'old-device', options: options('ws://v1-relay'),
    });
    const seen: string[] = [];
    const off = client.onPresenceChanged((snap) => seen.push(`${snap.deviceId}:${snap.online}`));
    client.start(); await vi.advanceTimersByTimeAsync(1);
    const primary = sockets.find((s) => s.url === 'ws://v2-node')!, legacy = sockets.find((s) => s.url === 'ws://v1-relay')!;
    primary.ack(); legacy.ack(); await vi.advanceTimersByTimeAsync(1);
    const presence = (socket: FakeWs, deviceId: string, online: boolean) => socket.push({ v: PROTOCOL_VERSION,
      kind: 'presence-changed', payload: { deviceId, deviceName: deviceId, online, remoteControlEnabled: online,
        platform: 'darwin', appVersion: '1', busy: false, lastSeenAt: 1 } });

    presence(primary, 'old-device', false); // the primary has no route to it: not authoritative
    presence(legacy, 'old-device', true);
    presence(primary, 'new-device', true);
    presence(legacy, 'new-device', false); // carried by the primary: the compatibility view is ignored
    expect(seen).toEqual(['old-device:true', 'new-device:true']);

    off();
    presence(legacy, 'old-device', false);
    expect(seen).toHaveLength(2);
    client.stop();
  });

  // PR #11052 review: the compatibility relay can report a peer online before the
  // route to it is known (the Agent-Net roster arrives later). That presence must be
  // handed over once the route is decided, and again after the primary reconnects,
  // because the host clears its presence view on every primary disconnect.
  it('hands over presence that arrived before the peer\'s route was known', async () => {
    const sockets: FakeWs[] = [];
    const options = (url: string): DeviceLinkClientOptions => ({
      getWsUrl: () => url, getToken: async () => 'unit-test-token',
      getHello: () => ({ deviceName: 'unit', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
      createWebSocket: (address, headers) => { const socket = new FakeWs(address, headers); sockets.push(socket); return socket; },
    });
    let rosterKnown = false;
    const client = new RoutedDeviceLinkClient(options('ws://v2-node'), undefined, {
      active: () => true, useForPeer: (peer) => rosterKnown && peer === 'old-device', options: options('ws://v1-relay'),
    });
    const seen: string[] = [];
    client.onPresenceChanged((snap) => seen.push(`${snap.deviceId}:${snap.online}`));
    client.start(); await vi.advanceTimersByTimeAsync(1);
    const legacy = sockets.find((s) => s.url === 'ws://v1-relay')!;
    legacy.ack(); await vi.advanceTimersByTimeAsync(1);
    legacy.push({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: { deviceId: 'old-device', deviceName: 'old',
      online: true, remoteControlEnabled: true, platform: 'darwin', appVersion: '1', busy: false, lastSeenAt: 1 } });
    expect(seen).toEqual([]);

    rosterKnown = true;
    const primary = sockets.find((s) => s.url === 'ws://v2-node')!;
    primary.ack(); await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(['old-device:true']);

    primary.close(1006); await vi.advanceTimersByTimeAsync(5_000);
    sockets.filter((s) => s.url === 'ws://v2-node').at(-1)!.ack(); await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(['old-device:true', 'old-device:true']);
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
});
