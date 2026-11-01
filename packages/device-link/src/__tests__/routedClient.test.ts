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
