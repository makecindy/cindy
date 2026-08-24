/**
 * DeviceLinkClient 状态机单测:fake WebSocket 注入,覆盖
 * 握手 / 请求配对 / 超时 / relay-error / 重连退避 / 心跳僵死 / token 缺失。
 */
import { describe, it, expect, vi } from 'vitest';
import { DeviceLinkClient, computeReconnectDelayMs, type WsLike } from '../client.js';
import { PROTOCOL_VERSION, DeviceLinkError, type Envelope } from '../protocol.js';
import {
  DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM,
  DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
  DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
  DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
  MAX_TRANSPORT_PENDING_MESSAGES,
  MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES,
  TRANSPORT_PENDING_PUSH_MAX_AGE_MS,
  TRANSPORT_RETRY_PASS_BUDGET,
  encodeReliableFrames,
  makeTransportSkipPayload,
  parseTransportAck,
  parseTransportPayload,
} from '../transport.js';
import { DL_CONTACTS_SYNC_CHANNEL } from '../contactsSyncProtocol.js';
import { SESSION_ACTIVITY_CHANNEL } from '../topics.js';

type Handler = (...args: unknown[]) => void;

/** 可编程 fake socket:记录发出的帧,可注入入站帧/关闭事件 */
class FakeWs implements WsLike {
  sent: Envelope[] = [];
  bufferedAmount = 0;
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  private handlers = new Map<string, Handler[]>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Envelope);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.emit('close', code ?? 1000);
  }
  terminate(): void {
    this.terminated = true;
  }
  // 测试桩用宽签名实现 WsLike 的重载 on
  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as Handler);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  /** 服务器视角:推一帧给客户端 */
  push(env: Envelope): void {
    this.emit('message', { toString: () => JSON.stringify(env) });
  }
  /** 完成 open + hello-ack 流程 */
  ack(): void {
    this.emit('open');
    this.push({
      v: PROTOCOL_VERSION,
      kind: 'hello-ack',
      payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'dev-self', userId: 'u1' },
    });
  }
}

interface Harness {
  client: DeviceLinkClient;
  sockets: FakeWs[];
  current(): FakeWs;
}

function makeHarness(opts?: {
  token?: string | null;
  timing?: ConstructorParameters<typeof DeviceLinkClient>[0]['timing'];
  logger?: ConstructorParameters<typeof DeviceLinkClient>[0]['logger'];
}): Harness {
  const sockets: FakeWs[] = [];
  const client = new DeviceLinkClient({
    getWsUrl: () => 'ws://test/api/device-link/ws',
    logger: opts?.logger,
    getToken: async () => (opts && 'token' in opts ? (opts.token ?? null) : 'jwt-token'),
    getHello: () => ({
      deviceName: 'Test Mac',
      platform: 'darwin',
      appVersion: '1.0.0',
      remoteControlEnabled: true,
      busy: false,
    }),
    createWebSocket: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    timing: {
      reconnectBaseMs: 5,
      reconnectMaxMs: 40,
      pingIntervalMs: 10,
      pongMissLimit: 2,
      requestTimeoutMs: 50,
      ...opts?.timing,
    },
  });
  return { client, sockets, current: () => sockets[sockets.length - 1] };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let inboundLinkId = 0;

async function establishInboundReliableLink(
  h: Harness,
  streamId: string,
  transportBaseSeq = 1,
  src = 'dev-b',
  // 默认模拟当前已发布、尚未声明 reliable-link-confirm-v1 的控制端；这样既有
  // 测试继续覆盖独立升级兼容路径。传入仅 RELIABLE 可进一步模拟不认识
  // transport-timeout 瞬时重置语义的更老控制端。
  capabilities: string[] = [
    DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
    DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
  ],
): Promise<void> {
  const id = `inbound-link-${++inboundLinkId}`;
  const off = h.client.onFrame((env) => {
    if (env.kind !== 'link-open' || env.id !== id || !env.src) return;
    h.client.sendLinkAccept(env.src, env.id, {
      appVersion: '1',
      allowlistHash: 'hash',
    });
  });
  h.current().push({
    v: PROTOCOL_VERSION,
    kind: 'link-open',
    id,
    src,
    payload: {
      controllerName: 'Remote',
      protocolVersion: 1,
      appVersion: '1',
      capabilities,
      transportStreamId: streamId,
      transportBaseSeq,
    },
  });
  await tick();
  off();
}

/** 接入内存中继的 fake socket：send 时把帧交给中继按 dst 保序路由。 */
class RelayWs extends FakeWs {
  constructor(
    private readonly relay: MemoryRelay,
    readonly ownerId: string,
  ) {
    super();
  }

  override send(data: string): void {
    super.send(data);
    this.relay.route(this.ownerId, this, JSON.parse(data) as Envelope);
  }
}

/**
 * 双客户端内存中继：单队列按帧到达顺序逐帧投递，验证接收端的「实际交付」
 * 顺序而不只是发送端 emit。与真实 relay 一致：目的地离线的帧在入口处丢弃
 *（发送端的可靠层靠未 ACK 的 pending 自行保留）。
 */
class MemoryRelay {
  /** 按目的地记录实际投递给对端的帧（不含 hello-ack/pong 控制帧）。 */
  readonly deliveredTo = new Map<string, Envelope[]>();
  private readonly members = new Map<string, { ws: RelayWs | null }>();
  private readonly dropNextPredicates: Array<(senderId: string, env: Envelope) => boolean> = [];
  private readonly queue: Array<
    | { kind: 'direct'; ws: RelayWs; env: Envelope }
    | { kind: 'routed'; dstId: string; env: Envelope }
  > = [];

  makeWebSocket(deviceId: string): RelayWs {
    const member = this.members.get(deviceId) ?? { ws: null };
    this.members.set(deviceId, member);
    const ws = new RelayWs(this, deviceId);
    member.ws = ws;
    // 客户端在 createWebSocket 返回后才挂 handler：延到下一个宏任务再 open
    setTimeout(() => {
      if (this.members.get(deviceId)?.ws === ws) ws.emit('open');
    }, 0);
    return ws;
  }

  /** 静默掉线（无 link-close）：之后发往该设备的帧在入口处被丢弃。 */
  disconnect(deviceId: string): void {
    const member = this.members.get(deviceId);
    if (!member?.ws) return;
    const ws = member.ws;
    member.ws = null;
    ws.emit('close', 1006, 'network lost');
  }

  dropNext(predicate: (senderId: string, env: Envelope) => boolean): void {
    this.dropNextPredicates.push(predicate);
  }

  route(senderId: string, ws: RelayWs, env: Envelope): void {
    if (env.kind === 'hello') {
      this.queue.push({
        kind: 'direct',
        ws,
        env: {
          v: PROTOCOL_VERSION,
          kind: 'hello-ack',
          payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: senderId, userId: 'u1' },
        },
      });
      return;
    }
    if (env.kind === 'ping') {
      this.queue.push({ kind: 'direct', ws, env: { v: PROTOCOL_VERSION, kind: 'pong' } });
      return;
    }
    if (!env.dst) return;
    const dropIndex = this.dropNextPredicates.findIndex((predicate) => predicate(senderId, env));
    if (dropIndex >= 0) {
      this.dropNextPredicates.splice(dropIndex, 1);
      return;
    }
    // 入口即判定在线与否：离线目的地直接丢帧，不缓存、不重排
    if (!this.members.get(env.dst)?.ws) return;
    this.queue.push({ kind: 'routed', dstId: env.dst, env: { ...env, src: senderId } });
  }

  /** 按顺序逐帧投递直到静默；每帧之间让微任务（drain/ACK）跑完。 */
  async settle(): Promise<void> {
    let idle = 0;
    while (idle < 3) {
      const entry = this.queue.shift();
      if (!entry) {
        idle += 1;
        await tick();
        continue;
      }
      idle = 0;
      if (entry.kind === 'direct') {
        if (this.members.get(entry.ws.ownerId)?.ws === entry.ws) entry.ws.push(entry.env);
      } else {
        const member = this.members.get(entry.dstId);
        if (member?.ws) {
          let log = this.deliveredTo.get(entry.dstId);
          if (!log) {
            log = [];
            this.deliveredTo.set(entry.dstId, log);
          }
          log.push(entry.env);
          member.ws.push(entry.env);
        }
      }
      await tick();
    }
  }

  /** 持续泵送直到条件成立（如等待重连退避计时器触发）。 */
  async settleUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.settle();
      if (condition()) return;
      if (Date.now() > deadline) throw new Error('MemoryRelay.settleUntil timed out');
      await tick(5);
    }
  }
}

function makeRelayClient(
  relay: MemoryRelay,
  deviceId: string,
  timing?: ConstructorParameters<typeof DeviceLinkClient>[0]['timing'],
): DeviceLinkClient {
  return new DeviceLinkClient({
    getWsUrl: () => 'ws://test/api/device-link/ws',
    getToken: async () => 'jwt-token',
    getHello: () => ({
      deviceName: deviceId,
      platform: 'darwin',
      appVersion: '1.0.0',
      remoteControlEnabled: true,
      busy: false,
    }),
    createWebSocket: () => relay.makeWebSocket(deviceId),
    timing: {
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      pingIntervalMs: 60_000,
      pongMissLimit: 4,
      requestTimeoutMs: 2_000,
      transportRetryIntervalMs: 60_000,
      ...timing,
    },
  });
}

describe('DeviceLinkClient', () => {
  it('start → open 后第一帧是 hello,hello-ack 后 online', async () => {
    const h = makeHarness();
    const statuses: string[] = [];
    h.client.onStatusChange((s) => statuses.push(s));
    h.client.start();
    await tick();

    const ws = h.current();
    ws.emit('open');
    expect(ws.sent[0]).toMatchObject({ kind: 'hello', v: PROTOCOL_VERSION });
    expect(ws.sent[0].payload).toMatchObject({ deviceName: 'Test Mac' });

    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'hello-ack',
      payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'd', userId: 'u' },
    });
    expect(h.client.getStatus()).toBe('online');
    expect(statuses).toEqual(['connecting', 'online']);
    h.client.stop();
  });

  it('invoke:同 id invoke-result 配对 resolve', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();

    const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] });
    const sentInvoke = h.current().sent.find((e) => e.kind === 'invoke')!;
    expect(sentInvoke.dst).toBe('dev-b');
    expect(sentInvoke.id).toBeTruthy();

    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke-result',
      id: sentInvoke.id,
      src: 'dev-b',
      payload: { ok: true, result: ['s1'] },
    });
    await expect(p).resolves.toMatchObject({ ok: true, result: ['s1'] });
    h.client.stop();
  });

  it('双方协商可靠传输后，大 invoke-result 分片并在累计 ACK 后停止重发', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 10_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', {
      controllerName: 'Test',
      protocolVersion: 1,
      appVersion: '1',
    });
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    expect((sentOpen.payload as { capabilities: string[] }).capabilities).toContain(
      DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
    );
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
      },
    });
    await open;

    const before = h.current().sent.length;
    h.client.sendInvokeResult('dev-b', 'req-large', {
      ok: true,
      result: { text: '弱'.repeat(100_000) },
    });
    const chunks = h.current().sent.slice(before).filter((env) => env.kind === 'invoke-result');
    expect(chunks.length).toBeGreaterThan(1);
    const parsed = chunks.map((env) => parseTransportPayload(env.payload)!);
    expect(parsed.map((part) => part.meta.segment!.index)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
    const { streamId, seq } = parsed[0].meta;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId, ackSeq: seq },
      },
    });
    const afterAck = h.current().sent.length;
    await tick(2_100);
    expect(h.current().sent).toHaveLength(afterAck);
    h.client.stop();
  }, 5_000);

  it('累计 ACK 推进后不立即重发，定时重放时刷新 wrapper baseSeq', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 10_000,
        transportRetryIntervalMs: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', {
      controllerName: 'Test',
      protocolVersion: 1,
      appVersion: '1',
    });
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    h.client.sendPush('dev-b', 'maker:event', { text: 'first' });
    h.client.sendPush('dev-b', 'maker:event', { text: 'second' });
    const initial = h.current().sent
      .filter((env) => env.kind === 'push')
      .map((env) => parseTransportPayload(env.payload))
      .filter((parsed) => parsed !== null);
    const first = initial.find((parsed) => parsed.meta.seq === 1)!;
    expect(initial.find((parsed) => parsed.meta.seq === 2)?.meta.baseSeq).toBeUndefined();

    const beforeAck = h.current().sent.length;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: first.meta.streamId, ackSeq: 1 },
      },
    });
    expect(h.current().sent).toHaveLength(beforeAck);
    await vi.waitFor(() => expect(h.current().sent.length).toBeGreaterThan(beforeAck));
    const replay = h.current().sent.slice(beforeAck)
      .map((env) => parseTransportPayload(env.payload))
      .find((parsed) => parsed?.meta.seq === 2);
    expect(replay?.meta.baseSeq).toBe(2);

    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: first.meta.streamId, ackSeq: 2 },
      },
    });
    h.client.stop();
  });

  it('接收缓存被未来 seq 占满时，队头 skip 仍可进入并解除永久堵塞', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const streamId = 'full-receive-stream';
    await establishInboundReliableLink(h, streamId);
    const received: number[] = [];
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      received.push((env.payload as { payload: { seq: number } }).payload.seq);
    });
    const firstFrames = encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: 'maker:event',
        payload: { seq: 1, text: '弱'.repeat(100_000) },
      },
    }, streamId, 1);
    expect(firstFrames.length).toBeGreaterThan(1);
    h.current().push(firstFrames[0]);

    for (let seq = 2; seq <= 16; seq++) {
      h.current().push(encodeReliableFrames({
        v: PROTOCOL_VERSION,
        kind: 'push',
        src: 'dev-b',
        payload: { channel: 'maker:event', payload: { seq } },
      }, streamId, seq)[0]);
    }
    expect(received).toEqual([]);

    h.current().push(encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: makeTransportSkipPayload(),
    }, streamId, 1)[0]);
    await tick();

    expect(received).toEqual(Array.from({ length: 15 }, (_, index) => index + 2));
    expect(h.current().sent.filter((env) => (
      env.kind === 'push'
      && (env.payload as { channel?: string }).channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL
    )).at(-1)).toMatchObject({
      payload: { payload: { ackSeq: 16 } },
    });
    h.client.stop();
  });

  it('乱序分片只在缺口补齐后按 seq 交付，重复帧不重复触发 host', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const streamId = 'remote-stream';
    await establishInboundReliableLink(h, streamId);
    const frames: Envelope[] = [];
    h.client.onFrame((env) => {
      frames.push(env);
    });
    const make = (seq: number, text: string) => ({
      v: PROTOCOL_VERSION,
      kind: 'push' as const,
      src: 'dev-b',
      payload: {
        __cindyDeviceLinkTransport: { version: 1, streamId, seq },
        data: JSON.stringify({ channel: 'maker:event', payload: { text } }),
      },
    });
    h.current().push(make(2, 'second'));
    await tick();
    expect(frames).toEqual([]);
    h.current().push(make(1, 'first'));
    await tick();
    expect(frames.map((env) => (env.payload as { payload: { text: string } }).payload.text)).toEqual([
      'first',
      'second',
    ]);
    h.current().push(make(1, 'first'));
    await tick();
    expect(frames).toHaveLength(2);
    h.client.stop();
  });

  it('handler 失败时不推进 ACK，也不交付后续 seq；重发成功后按序恢复', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const streamId = 'handler-retry-stream';
    await establishInboundReliableLink(h, streamId);
    const seen: string[] = [];
    let failOnce = true;
    h.client.onFrame(async (env) => {
      if (env.kind !== 'push') return;
      const text = (env.payload as { payload: { text: string } }).payload.text;
      seen.push(text);
      if (failOnce) {
        failOnce = false;
        throw new Error('temporary handler failure');
      }
    });
    const make = (seq: number, text: string) => ({
      v: PROTOCOL_VERSION,
      kind: 'push' as const,
      src: 'dev-b',
      payload: {
        __cindyDeviceLinkTransport: { version: 1, streamId, seq },
        data: JSON.stringify({ channel: 'maker:event', payload: { text } }),
      },
    });

    h.current().push(make(1, 'first'));
    await tick();
    expect(seen).toEqual(['first']);
    expect(h.current().sent.filter((e) => e.payload && (e.payload as { channel?: string }).channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL).at(-1)).toMatchObject({
      payload: { payload: { ackSeq: 0 } },
    });

    h.current().push(make(2, 'second'));
    await tick();
    expect(seen).toEqual(['first', 'first', 'second']);
    expect(h.current().sent.filter((e) => e.payload && (e.payload as { channel?: string }).channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL).at(-1)).toMatchObject({
      payload: { payload: { ackSeq: 2 } },
    });
    h.client.stop();
  });

  it('慢可靠业务 handler 不阻塞 pong，避免把本地处理拥塞误判成断网', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 8,
        pongMissLimit: 1,
      },
    });
    h.client.start();
    await tick();
    const ws = h.current();
    // 确定性回 pong:监听出站 ping、同步应答,彻底消除对真实计时器调度的依赖。
    // 必须在 ack()(hello-ack 启动心跳)之前装上:装晚了,建链期间的若干
    // await tick() 在慢 CI/Windows 上可能耗掉两个 8ms 心跳周期,期间 ping
    // 无人应答就已误判断网。语义不变:若慢业务 handler 真堵住帧处理,push
    // 进来的 pong 不会被消费,pongMiss 照样触发断网,断言仍能抓住回归。
    const originalSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      originalSend(data);
      const env = JSON.parse(data) as Envelope;
      if (env.kind === 'ping') ws.push({ v: PROTOCOL_VERSION, kind: 'pong' });
    };
    ws.ack();
    await establishInboundReliableLink(h, 'slow-stream');

    let release: (() => void) | undefined;
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        __cindyDeviceLinkTransport: { version: 1, streamId: 'slow-stream', seq: 1 },
        data: JSON.stringify({ channel: 'maker:event', payload: { text: 'slow' } }),
      },
    });
    await tick();
    expect(release).toBeTypeOf('function');

    await tick(40);

    expect(ws.terminated).toBe(false);
    expect(h.client.getStatus()).toBe('online');
    release?.();
    await tick();
    h.client.stop();
  });

  it('可靠 invoke 超时后用同一 seq 发送 skip，避免后续消息永久卡在缺口', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000, requestTimeoutMs: 20 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', { controllerName: 'Test', protocolVersion: 1, appVersion: '1' }, 100);
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    const invoke = h.client.invoke('dev-b', { channel: 'maker:slow', args: [] }, 20);
    await expect(invoke).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });
    const reliableFrames = h.current().sent.filter((e) => e.kind === 'invoke');
    expect(reliableFrames.length).toBeGreaterThanOrEqual(2);
    const first = parseTransportPayload(reliableFrames[0].payload)!;
    const skip = parseTransportPayload(reliableFrames.at(-1)!.payload)!;
    expect(skip.meta.seq).toBe(first.meta.seq);
    expect(JSON.parse(skip.data)).toMatchObject({ __cindyDeviceLinkTransportSkip: true });
    h.client.stop();
  });

  it('可靠消息重试耗尽后主动重连，并在新 link 上重放同一 seq（用不可丢弃的 invoke-result 验证；队头 push 重连时作为可丢弃前缀被放弃）', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        reconnectBaseMs: 5,
        reconnectMaxMs: 5,
        transportRetryIntervalMs: 5,
        transportMaxRetryAttempts: 2,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    const firstOpen = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const firstOpenFrame = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: firstOpenFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await firstOpen;

    const firstSocket = h.current();
    h.client.sendInvokeResult('dev-b', 'replay-me', { ok: true, result: [] });
    const firstReliable = firstSocket.sent.find((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    ))!;
    const firstMeta = parseTransportPayload(firstReliable.payload)!.meta;

    await vi.waitFor(() => expect(firstSocket.terminated).toBe(true));
    await vi.waitFor(() => expect(h.sockets.length).toBe(2));
    h.current().ack();

    const secondOpen = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const secondOpenFrame = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: secondOpenFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await secondOpen;

    const replays = h.current().sent.filter((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    ));
    expect(replays).toHaveLength(1);
    const replay = replays[0];
    expect(parseTransportPayload(replay.payload)?.meta).toMatchObject({
      streamId: firstMeta.streamId,
      seq: firstMeta.seq,
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: firstMeta.streamId, ackSeq: firstMeta.seq },
      },
    });
    h.client.stop();
  });

  it('入站 link 的可靠重试耗尽只重置该 peer link:relay 连接不拆,发 transport-timeout link-close,重开后 live 帧按原 seq 重放', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        reconnectBaseMs: 5,
        reconnectMaxMs: 5,
        transportRetryIntervalMs: 5,
        transportMaxRetryAttempts: 2,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'inbound-timeout-stream');

    const firstSocket = h.current();
    // 可丢弃前缀(陈旧实时镜像) + 不可丢弃的 live invoke-result
    h.client.sendPush('dev-b', 'maker:event', { drop: 'me' });
    h.client.sendInvokeResult('dev-b', 'keep-me', { ok: true, result: [] });
    const firstReliable = firstSocket.sent.find((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    ))!;
    const firstMeta = parseTransportPayload(firstReliable.payload)!.meta;

    // 对端永不 ACK → 重试耗尽 → 只重置该 peer 的 link 并通知对端
    await vi.waitFor(() => {
      expect(firstSocket.sent.some((env) => (
        env.kind === 'link-close'
        && env.dst === 'dev-b'
        && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
      ))).toBe(true);
    });
    // relay 连接毫发无损:既没 terminate,也没新建 socket(其它 peer 零感知)
    expect(firstSocket.terminated).toBe(false);
    expect(firstSocket.closed).toBeNull();
    expect(h.sockets).toHaveLength(1);

    // 对端重开链路 → 陈旧 push 前缀被清扫,live invoke-result 按原 seq 重放
    const sentBefore = firstSocket.sent.length;
    await establishInboundReliableLink(h, 'inbound-timeout-stream');
    // 模拟真实接收端:重放帧已写入 socket FIFO 后立即回 ACK(见 client.ts
    // sendTransportAck 的交付即确认语义)。不 ACK 的话,重放后 retryTimer
    // 会在 Windows 低精度计时器(≈12ms>配置 5ms)下把同一帧再发一遍,慢 CI
    // runner 上断言窗口跨过该周期时会把「重试重发」误判成「重放两次」。
    const justReplayed = firstSocket.sent.slice(sentBefore).filter((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    ));
    if (justReplayed.length > 0) {
      const meta = parseTransportPayload(justReplayed[0].payload)!.meta;
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'push',
        src: 'dev-b',
        payload: {
          channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
          payload: { streamId: meta.streamId, ackSeq: meta.seq },
        },
      });
    }
    const replayed = firstSocket.sent.slice(sentBefore);
    const replays = replayed.filter((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    ));
    expect(replays).toHaveLength(1);
    expect(parseTransportPayload(replays[0].payload)?.meta).toMatchObject({
      streamId: firstMeta.streamId,
      seq: firstMeta.seq,
    });
    expect(replayed.filter((env) => (
      env.kind === 'push'
      && parseTransportPayload(env.payload)
    ))).toHaveLength(0);
    h.client.stop();
  });

  it('互控:出站 link-accept 不覆盖入站标记,重试耗尽仍走 peer 级重置不拆共享 relay', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        reconnectBaseMs: 5,
        reconnectMaxMs: 5,
        transportRetryIntervalMs: 5,
        transportMaxRetryAttempts: 2,
        requestTimeoutMs: 5_000,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 1) 对端作为控制端接入(入站 accept → linkAcceptedInbound=true)
    await establishInboundReliableLink(h, 'mutual-stream');

    // 2) 本机随后也作为控制端 openLink 到对端——出站 link-accept 到达
    //    (回归点:曾把共享的入站标记覆盖回 false)
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const openFrame = h.current().sent.filter((e) => e.kind === 'link-open').at(-1)!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: openFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        // 生产形态:对端 sendLinkAccept 只回显 reliable 能力,**不带**
        // transport-timeout-close-v1——回归点:这样的反向 accept 曾把入站
        // link-open 协商到的 supportsTransportTimeoutClose 覆盖回 false。
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'mutual-host-stream',
      },
    });
    await open;

    // 3) 入站方向的可靠帧对端不再 ACK → 重试耗尽 → 必须仍是 peer 级重置
    const socket = h.current();
    h.client.sendInvokeResult('dev-b', 'mutual-replay', { ok: true, result: [] });
    await vi.waitFor(() => {
      expect(socket.sent.some((env) => (
        env.kind === 'link-close'
        && env.dst === 'dev-b'
        && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
      ))).toBe(true);
    });
    // 共享 relay 连接完好:没有因互控覆盖误走整连接重连
    expect(socket.terminated).toBe(false);
    expect(h.sockets).toHaveLength(1);
    h.client.stop();
  });

  it('已排期的通知重试在本地永久 closeLink 后被撤销,不补发迟到的 transport-timeout', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 20,
        transportMaxRetryAttempts: 2,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'late-notify-local-close');

    const socket = h.current();
    h.client.sendInvokeResult('dev-b', 'late-1', { ok: true, result: [] });

    // 让 link-close 的首发持续失败 → 重试被排期
    const originalSend = socket.send.bind(socket);
    let blockedCloses = 0;
    socket.send = (data: string) => {
      const env = JSON.parse(data) as Envelope;
      if (env.kind === 'link-close') {
        blockedCloses += 1;
        throw new Error('simulated backpressure');
      }
      originalSend(data);
    };
    await vi.waitFor(() => expect(blockedCloses).toBeGreaterThanOrEqual(1));

    // 重试排期期间,本地永久关闭该链路(如用户断开/被控开关关闭)
    socket.send = originalSend;
    h.client.closeLink('dev-b', 'user');
    const sentBefore = socket.sent.length;

    // 超过数个重试周期:不得再补发任何 transport-timeout
    await tick(100);
    const lateTimeouts = socket.sent.slice(sentBefore).filter((env) => (
      env.kind === 'link-close'
      && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
    ));
    expect(lateTimeouts).toHaveLength(0);
    h.client.stop();
  });

  it('收到对端永久 link-close 后,迟到的通知重试回调复验状态后终止,不补发 transport-timeout', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 20,
        transportMaxRetryAttempts: 3,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'late-notify-peer-close');

    const socket = h.current();
    h.client.sendInvokeResult('dev-b', 'late-2', { ok: true, result: [] });

    const originalSend = socket.send.bind(socket);
    let blockedCloses = 0;
    socket.send = (data: string) => {
      const env = JSON.parse(data) as Envelope;
      if (env.kind === 'link-close') {
        blockedCloses += 1;
        throw new Error('simulated backpressure');
      }
      originalSend(data);
    };
    await vi.waitFor(() => expect(blockedCloses).toBeGreaterThanOrEqual(1));

    // 重试排期期间收到对端的永久关闭(对方用户关掉了它对本机的控制)
    socket.send = originalSend;
    socket.push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'user' },
    });
    await tick();
    const sentBefore = socket.sent.length;

    await tick(150);
    const lateTimeouts = socket.sent.slice(sentBefore).filter((env) => (
      env.kind === 'link-close'
      && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
    ));
    expect(lateTimeouts).toHaveLength(0);
    h.client.stop();
  });

  it('入站方向被永久关闭后,出站重试耗尽不得再发 transport-timeout(不诱使对端重开用户已关闭的方向)', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        reconnectBaseMs: 5,
        reconnectMaxMs: 5,
        transportRetryIntervalMs: 5,
        transportMaxRetryAttempts: 2,
        requestTimeoutMs: 5_000,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 1) 互控:对方作为控制端接入(活动入站标记置位)
    await establishInboundReliableLink(h, 'perm-close-stream');

    // 2) 对方用户明确关闭它对本机的控制(永久 link-close 'user')
    const firstSocket = h.current();
    firstSocket.push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'user' },
    });
    await tick();

    // 3) 本机仍作为控制端 openLink 到对方,出站可靠帧耗尽重试
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const openFrame = firstSocket.sent.filter((e) => e.kind === 'link-open').at(-1)!;
    firstSocket.push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: openFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'perm-close-host-stream',
      },
    });
    await open;
    h.client.sendInvokeResult('dev-b', 'after-perm-close', { ok: true, result: [] });

    // 入站方向已永久关闭 → 回退整连接重连语义,绝不发 transport-timeout
    await vi.waitFor(() => expect(firstSocket.terminated).toBe(true));
    expect(firstSocket.sent.some((env) => (
      env.kind === 'link-close'
      && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
    ))).toBe(false);
    h.client.stop();
  });

  it('旧控制端(未声明 transport-timeout-close-v1)重试耗尽回退整连接重连,不发新 reason', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        reconnectBaseMs: 5,
        reconnectMaxMs: 5,
        transportRetryIntervalMs: 5,
        transportMaxRetryAttempts: 2,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    // 旧版控制端:只声明 reliable,不声明 transport-timeout-close-v1
    await establishInboundReliableLink(
      h,
      'legacy-stream',
      1,
      'dev-b',
      [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
    );

    const firstSocket = h.current();
    h.client.sendInvokeResult('dev-b', 'legacy-replay', { ok: true, result: [] });

    // 对旧对端不能发它不理解的 reason(会被当永久关闭且永不重开):
    // 回退到旧的整连接重连,靠 presence 闪断触发对端既有 rehydrate。
    await vi.waitFor(() => expect(firstSocket.terminated).toBe(true));
    await vi.waitFor(() => expect(h.sockets.length).toBe(2));
    expect(firstSocket.sent.some((env) => env.kind === 'link-close')).toBe(false);
    h.client.stop();
  });

  it('transport-timeout 通知首发失败后按退避重发;对端重开后仍同 seq 续传', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        reconnectBaseMs: 5,
        reconnectMaxMs: 5,
        transportRetryIntervalMs: 5,
        transportMaxRetryAttempts: 2,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'notify-retry-stream');

    const firstSocket = h.current();
    h.client.sendInvokeResult('dev-b', 'keep-me-2', { ok: true, result: [] });
    const firstReliable = firstSocket.sent.find((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    ))!;
    const firstMeta = parseTransportPayload(firstReliable.payload)!.meta;

    // 让 link-close 的首次发送失败(模拟 WebSocket 背压/发送异常),后续恢复
    const originalSend = firstSocket.send.bind(firstSocket);
    let failedOnce = false;
    firstSocket.send = (data: string) => {
      const env = JSON.parse(data) as Envelope;
      if (env.kind === 'link-close' && !failedOnce) {
        failedOnce = true;
        throw new Error('simulated send backpressure');
      }
      originalSend(data);
    };

    // 对端永不 ACK → 重试耗尽 → 首发通知失败 → 退避重发成功
    await vi.waitFor(() => {
      expect(failedOnce).toBe(true);
      expect(firstSocket.sent.some((env) => (
        env.kind === 'link-close'
        && env.dst === 'dev-b'
        && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
      ))).toBe(true);
    });
    // 重发期间 relay 连接始终未被拆
    expect(firstSocket.terminated).toBe(false);
    expect(h.sockets).toHaveLength(1);

    // 对端重开 → 保留的 live invoke-result 按原 seq 重放
    const sentBefore = firstSocket.sent.length;
    await establishInboundReliableLink(h, 'notify-retry-stream');
    const replays = firstSocket.sent.slice(sentBefore).filter((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    ));
    expect(replays).toHaveLength(1);
    expect(parseTransportPayload(replays[0].payload)?.meta).toMatchObject({
      streamId: firstMeta.streamId,
      seq: firstMeta.seq,
    });
    h.client.stop();
  });

  it('入站方向 closeLink 不拆共享可靠层:在途出站请求不被拒、后续发送不报 LINK_NOT_OPEN、回包照常送达', async () => {
    const h = makeHarness({
      timing: { pingIntervalMs: 60_000, requestTimeoutMs: 5_000, transportRetryIntervalMs: 60_000 },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 互控:入站 accept + 本机出站 openLink
    await establishInboundReliableLink(h, 'iso-mutual-stream');
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const openFrame = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: openFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'iso-mutual-host-stream',
      },
    });
    await open;

    // 在途出站 invoke(尚无回包)
    const invokeResult = h.client.invoke('dev-b', { channel: 'local-db:sessions:list', args: [] });
    let settled = false;
    void invokeResult.finally(() => { settled = true; });
    const invokeFrame = h.current().sent.find((env) => (
      env.kind === 'invoke' && parseTransportPayload(env.payload)
    ))!;

    // 入站方向撤权:不得陪葬仍存续的出站可靠层
    h.client.closeLink('dev-b', 'revoked', 'inbound');
    await tick();
    expect(settled).toBe(false); // 在途请求未被拒
    // 后续可靠发送不报 LINK_NOT_OPEN(可靠层未被拆)
    expect(() => h.client.sendPush('dev-b', 'maker:event', { still: 'alive' })).not.toThrow();

    // 回包到达 → 在途请求正常完成
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke-result',
      id: invokeFrame.id,
      src: 'dev-b',
      payload: { ok: true, result: [] },
    });
    await expect(invokeResult).resolves.toMatchObject({ ok: true });
    h.client.stop();
  });

  it('入站方向撤权(closeLink inbound)不封死仍存续的主动控制:transport-timeout 照常交 app 层触发重建', async () => {
    const h = makeHarness({
      timing: { pingIntervalMs: 60_000, requestTimeoutMs: 5_000 },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 互控:对方控制本机(入站)+ 本机控制对方(出站)
    await establishInboundReliableLink(h, 'revoke-mutual-stream');
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const openFrame = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: openFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'revoke-mutual-host-stream',
      },
    });
    await open;

    // 本机撤销对方对本机的控制(入站方向):revoked 帧可能丢失,对方无感知
    h.client.closeLink('dev-b', 'revoked', 'inbound');

    // 对方(作为本机出站控制的被控端)发来 transport-timeout:本机仍在主动
    // 控制对方,必须照常交 app 层(desktop 据此 openRemoteLink 重建)
    const seenFrames: Envelope[] = [];
    const off = h.client.onFrame((env) => {
      seenFrames.push(env);
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'transport-timeout' },
    });
    await tick();
    expect(seenFrames.filter((env) => env.kind === 'link-close')).toHaveLength(1);
    off();
    h.client.stop();
  });

  it('入站撤权取消待确认超时,同时保留此前已就绪的出站控制方向', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 5,
        transportMaxRetryAttempts: 2,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 先建立本机主动控制对方的可靠方向,确认 sendPhase 已经 ready。
    const outboundOpen = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const outboundFrame = h.current().sent.find((env) => env.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: outboundFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'outbound-remote-stream',
      },
    });
    await outboundOpen;

    // 再接受对方入站 link-open,但不回 confirmation ACK,制造待确认 timer。
    const inboundId = 'inbound-confirmation-revoke';
    const off = h.client.onFrame((env) => {
      if (env.kind !== 'link-open' || env.id !== inboundId || !env.src) return;
      h.client.sendLinkAccept(env.src, env.id, {
        appVersion: '1',
        allowlistHash: 'hash',
      });
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-open',
      id: inboundId,
      src: 'dev-b',
      payload: {
        controllerName: 'Remote',
        protocolVersion: 1,
        appVersion: '1',
        capabilities: [
          DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
          DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM,
          DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
        ],
        transportStreamId: 'inbound-remote-stream',
        transportBaseSeq: 1,
      },
    });
    await tick();
    off();

    // 确认尚未完成时再次收到同方向 open:新 confirmation 替换旧对象,但必须继承
    // 旧对象记录的 outbound ready 状态。
    const replacementId = 'inbound-confirmation-revoke-replacement';
    const offReplacement = h.client.onFrame((env) => {
      if (env.kind !== 'link-open' || env.id !== replacementId || !env.src) return;
      h.client.sendLinkAccept(env.src, env.id, {
        appVersion: '1',
        allowlistHash: 'hash',
      });
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-open',
      id: replacementId,
      src: 'dev-b',
      payload: {
        controllerName: 'Remote',
        protocolVersion: 1,
        appVersion: '1',
        capabilities: [
          DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
          DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM,
          DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
        ],
        transportStreamId: 'inbound-remote-stream',
        transportBaseSeq: 1,
      },
    });
    await tick();
    offReplacement();

    const socket = h.current();
    h.client.closeLink('dev-b', 'revoked', 'inbound');
    await tick(30);

    // 撤权后旧确认 timer 不得再触发 transport-timeout 或拆共享 relay。
    expect(socket.terminated).toBe(false);
    expect(socket.sent.filter((env) => (
      env.kind === 'link-close'
      && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
    ))).toHaveLength(0);
    const internals = h.client as unknown as {
      peerTransport: Map<string, { sendPhase: string }>;
    };
    expect(internals.peerTransport.get('dev-b')?.sendPhase).toBe('ready');

    // 原有出站控制方向仍可继续写可靠帧,而不是被 pending confirmation 留在 awaiting。
    const depthBefore = h.client.getReliableSendQueueDepth('dev-b');
    expect(() => h.client.sendPush('dev-b', 'maker:event', { still: 'alive' })).not.toThrow();
    expect(h.client.getReliableSendQueueDepth('dev-b')).toBeGreaterThan(depthBefore);
    h.client.stop();
  }, 10_000);

  it('本地 closeLink 后迟到的 transport-timeout 被拦截:不交 app 层、不触发重建、不改变已关闭状态', async () => {
    const h = makeHarness({
      timing: { pingIntervalMs: 60_000, requestTimeoutMs: 5_000 },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 控制端建链后用户显式断开(closeLink 的永久关闭帧可能因背压未送达对端)
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const openFrame = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: openFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'closed-host-stream',
      },
    });
    await open;
    h.client.closeLink('dev-b', 'user');

    // 对端因保留消息耗尽重试,发来迟到的瞬时重置
    const seenFrames: Envelope[] = [];
    const off = h.client.onFrame((env) => {
      seenFrames.push(env);
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'transport-timeout' },
    });
    await tick();

    // 不交 app 层(app 层看不到帧,就不会 openRemoteLink/rehydrate 重建)
    expect(seenFrames.filter((env) => env.kind === 'link-close')).toHaveLength(0);
    // 已关闭状态不变:后续可靠发送仍被挡(未被瞬时重置分支“激活”)
    expect(() => h.client.sendInvokeResult('dev-b', 'x', { ok: true, result: [] })).toThrow(
      expect.objectContaining({ code: 'LINK_NOT_OPEN' }),
    );
    off();
    h.client.stop();
  });

  it('控制端收到 transport-timeout link-close:瞬时重置而非永久关闭——在途请求不被拒,重开后同 seq 续传并可正常完成', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        requestTimeoutMs: 5_000,
        transportRetryIntervalMs: 60_000,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 控制端视角:出站 openLink 建可靠链路
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const openFrame = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: openFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'host-stream',
      },
    });
    await open;

    // 发一条 invoke(在途,尚无回包)
    const invokeResult = h.client.invoke('dev-b', { channel: 'local-db:sessions:list', args: [] });
    let settled = false;
    void invokeResult.finally(() => { settled = true; });
    const invokeFrame = h.current().sent.find((env) => (
      env.kind === 'invoke' && parseTransportPayload(env.payload)
    ))!;
    const invokeMeta = parseTransportPayload(invokeFrame.payload)!.meta;

    // 被控端对本机可靠重试耗尽 → 发来 transport-timeout
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'transport-timeout' },
    });
    await tick();
    // 在途请求不被拒(瞬时重置 ≠ 永久关闭)
    expect(settled).toBe(false);
    // 可靠层未被拆:新的可靠发送不抛 LINK_NOT_OPEN,进入 pending 等重建
    expect(() => h.client.sendPush('dev-b', 'maker:event', { queued: true })).not.toThrow();

    // 重新 openLink → link-accept(同 stream)→ 在途 invoke 按原 seq 重放
    const sentBefore = h.current().sent.length;
    const reopen = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const reopenFrame = h.current().sent.slice(sentBefore).find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: reopenFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'host-stream',
      },
    });
    await reopen;
    const replayedInvokes = h.current().sent.slice(sentBefore).filter((env) => (
      env.kind === 'invoke' && parseTransportPayload(env.payload)
    ));
    expect(replayedInvokes.length).toBeGreaterThanOrEqual(1);
    expect(parseTransportPayload(replayedInvokes[0].payload)?.meta).toMatchObject({
      streamId: invokeMeta.streamId,
      seq: invokeMeta.seq,
    });

    // 回包送达 → 在途请求正常完成
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke-result',
      id: invokeFrame.id,
      src: 'dev-b',
      payload: { ok: true, result: [] },
    });
    await expect(invokeResult).resolves.toMatchObject({ ok: true });
    h.client.stop();
  });

  it('对端显式关闭 link 时终止可靠 pending，不留到未来重放', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    const invoke = h.client.invoke('dev-b', { channel: 'maker:slow', args: [] }, 1_000);
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'user' },
    });

    await expect(invoke).rejects.toMatchObject({ code: 'NOT_CONNECTED', inFlight: true });

    const listing = h.client.invoke('dev-b', { channel: 'local-db:sessions:list', args: [] });
    const sentListing = h.current().sent.at(-1)!;
    expect(sentListing).toMatchObject({
      kind: 'invoke',
      dst: 'dev-b',
      payload: { channel: 'local-db:sessions:list', args: [] },
    });
    expect(parseTransportPayload(sentListing.payload)).toBeNull();
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke-result',
      id: sentListing.id,
      src: 'dev-b',
      payload: { ok: true, result: ['session-after-peer-close'] },
    });
    await expect(listing).resolves.toMatchObject({
      ok: true,
      result: ['session-after-peer-close'],
    });
    h.client.stop();
  });

  it('relay 离线时本地显式 close 仍终止可靠 pending，不在重开后复活', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        reconnectBaseMs: 20,
        reconnectMaxMs: 20,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const sentOpen = h.current().sent.find((env) => env.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    const invoke = h.client.invoke('dev-b', { channel: 'maker:slow', args: [] }, 1_000);
    const sentInvoke = h.current().sent.find((env) => env.kind === 'invoke')!;
    const originalSeq = parseTransportPayload(sentInvoke.payload)!.meta.seq;
    h.current().emit('close', 1006, 'network lost');
    h.client.closeLink('dev-b', 'user');

    await expect(invoke).rejects.toMatchObject({ code: 'NOT_CONNECTED', inFlight: true });
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    h.current().ack();
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'stale' })).toThrow(
      expect.objectContaining({ code: 'LINK_NOT_OPEN' }),
    );
    const reopen = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const reopenFrame = h.current().sent.find((env) => env.kind === 'link-open')!;
    expect((reopenFrame.payload as { transportBaseSeq?: number }).transportBaseSeq).toBe(
      originalSeq + 1,
    );
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: reopenFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream-after-close',
      },
    });
    await reopen;
    expect(h.current().sent.some((env) => env.kind === 'invoke')).toBe(false);
    h.client.stop();
  });

  it('显式 close 后 listing invoke 回退 legacy，不要求重新打开 streaming link', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const sentOpen = h.current().sent.find((env) => env.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;
    expect(h.client.isLinkReady('dev-b')).toBe(true);
    h.client.closeLink('dev-b', 'user');
    expect(h.client.isLinkReady('dev-b')).toBe(false);

    const sentBeforeBlockedInvoke = h.current().sent.length;
    const blockedInvoke = await h.client.invoke(
      'dev-b',
      { channel: 'maker:send', args: [] },
    ).catch((err: unknown) => err);
    expect(blockedInvoke).toMatchObject({ code: 'LINK_NOT_OPEN' });
    expect((blockedInvoke as DeviceLinkError).inFlight).not.toBe(true);
    expect(h.current().sent).toHaveLength(sentBeforeBlockedInvoke);

    const listing = h.client.invoke('dev-b', { channel: 'local-db:sessions:list', args: [] });
    const sentListing = h.current().sent.at(-1)!;
    expect(sentListing).toMatchObject({
      kind: 'invoke',
      dst: 'dev-b',
      payload: { channel: 'local-db:sessions:list', args: [] },
    });
    expect(parseTransportPayload(sentListing.payload)).toBeNull();

    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke-result',
      id: sentListing.id,
      src: 'dev-b',
      payload: { ok: true, result: ['session-1'] },
    });
    await expect(listing).resolves.toMatchObject({ ok: true, result: ['session-1'] });
    h.client.stop();
  });

  it('显式 close 后词典只读快照 push 仍走 unlinked legacy,不报 LINK_NOT_OPEN', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const sentOpen = h.current().sent.find((env) => env.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;
    h.client.closeLink('dev-b', 'user');

    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'blocked' })).toThrow(
      expect.objectContaining({ code: 'LINK_NOT_OPEN' }),
    );
    const sentBefore = h.current().sent.length;
    expect(() => h.client.sendPush(
      'dev-b',
      'device-link:voice:dictionary:snapshot',
      { ok: true, entries: [] },
    )).not.toThrow();
    const sent = h.current().sent.at(-1)!;
    expect(h.current().sent.length).toBeGreaterThan(sentBefore);
    expect(sent).toMatchObject({
      kind: 'push',
      dst: 'dev-b',
      payload: { channel: 'device-link:voice:dictionary:snapshot' },
    });
    expect(parseTransportPayload(sent.payload)).toBeNull();
    h.client.stop();
  });

  it('显式 close 后只放行已接收的 legacy listing invoke-result 回程', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'controller-stream');
    h.client.closeLink('dev-b', 'toggle-off');

    h.client.onFrame((env) => {
      if (
        env.kind !== 'invoke'
        || env.id !== 'listing-after-close'
        || env.src !== 'dev-b'
      ) return;
      h.client.sendInvokeResult(env.src, env.id, {
        ok: true,
        result: ['session-after-close'],
      });
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke',
      id: 'listing-after-close',
      src: 'dev-b',
      payload: { channel: 'local-db:sessions:list', args: [] },
    });
    await tick();

    const response = h.current().sent.find((env) => (
      env.kind === 'invoke-result' && env.id === 'listing-after-close'
    ));
    expect(response).toMatchObject({
      kind: 'invoke-result',
      dst: 'dev-b',
      payload: { ok: true, result: ['session-after-close'] },
    });
    expect(parseTransportPayload(response?.payload)).toBeNull();
    expect(() => h.client.sendInvokeResult('dev-b', 'unknown-request', {
      ok: true,
      result: null,
    })).toThrow(expect.objectContaining({ code: 'LINK_NOT_OPEN' }));
    expect(() => h.client.sendInvokeResult('dev-b', 'listing-after-close', {
      ok: true,
      result: null,
    })).toThrow(expect.objectContaining({ code: 'LINK_NOT_OPEN' }));
    h.client.stop();
  });

  it('对端进程重启后按握手给出的 transportBaseSeq 接续，不等待已确认旧 seq', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    h.client.onFrame((env) => {
      if (env.kind !== 'link-open' || !env.src || !env.id) return;
      h.client.sendLinkAccept(env.src, env.id, {
        appVersion: '1',
        allowlistHash: 'hash',
      });
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-open',
      id: 'remote-restart-open',
      src: 'dev-b',
      payload: {
        controllerName: 'Remote',
        protocolVersion: 1,
        appVersion: '1',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'long-lived-stream',
        transportBaseSeq: 101,
      },
    });
    await tick();
    expect(h.current().sent).toContainEqual(expect.objectContaining({
      kind: 'link-accept',
      id: 'remote-restart-open',
      dst: 'dev-b',
    }));

    const received: string[] = [];
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      received.push((env.payload as { payload: { text: string } }).payload.text);
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        __cindyDeviceLinkTransport: {
          version: 1,
          streamId: 'long-lived-stream',
          seq: 101,
        },
        data: JSON.stringify({
          channel: 'maker:event',
          payload: { text: 'after restart' },
        }),
      },
    });
    await tick();

    expect(received).toEqual(['after restart']);
    expect(h.current().sent.filter((env) => (
      env.kind === 'push'
      && (env.payload as { channel?: string }).channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL
    )).at(-1)).toMatchObject({
      payload: { payload: { ackSeq: 101 } },
    });
    h.client.stop();
  });

  it('先收到旧帧后，wrapper baseSeq 仍可推进重启后的接收基线', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    await establishInboundReliableLink(h, 'long-lived-stream');
    const received: string[] = [];
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      received.push((env.payload as { payload: { text: string } }).payload.text);
    });
    const make = (seq: number, text: string, baseSeq?: number): Envelope => ({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        __cindyDeviceLinkTransport: {
          version: 1,
          streamId: 'long-lived-stream',
          seq,
          ...(baseSeq ? { baseSeq } : {}),
        },
        data: JSON.stringify({
          channel: 'maker:event',
          payload: { text },
        }),
      },
    });

    h.current().push(make(100, 'stale'));
    await tick();
    expect(received).toEqual([]);

    h.current().push(make(101, 'resumed', 101));
    await tick();
    expect(received).toEqual(['resumed']);
    expect(h.current().sent.filter((env) => (
      env.kind === 'push'
      && (env.payload as { channel?: string }).channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL
    )).at(-1)).toMatchObject({
      payload: { payload: { ackSeq: 101 } },
    });
    h.client.stop();
  });

  it('新 link 接受的 baseSeq 可跨过已失败但尚未交付的队头', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const streamId = 'failed-head-stream';
    await establishInboundReliableLink(h, streamId);
    let failedHeadAttempts = 0;
    const received: number[] = [];
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      const seq = (env.payload as { payload: { seq: number } }).payload.seq;
      if (seq === 1) {
        failedHeadAttempts++;
        throw new Error('host rejected stale head');
      }
      received.push(seq);
    });

    h.current().push(encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: { channel: 'maker:event', payload: { seq: 1 } },
    }, streamId, 1)[0]);
    await tick();
    expect(failedHeadAttempts).toBe(1);

    await establishInboundReliableLink(h, streamId, 2);
    h.current().push(encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: { channel: 'maker:event', payload: { seq: 2 } },
    }, streamId, 2, 2)[0]);
    await tick();

    expect(failedHeadAttempts).toBe(1);
    expect(received).toEqual([2]);
    expect(h.current().sent.filter((env) => (
      env.kind === 'push'
      && (env.payload as { channel?: string }).channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL
    )).at(-1)).toMatchObject({
      payload: { payload: { ackSeq: 2 } },
    });
    h.client.stop();
  });

  it('迟到且已失配的 link-accept 不会重新打开显式关闭的可靠链路', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', {
      controllerName: 'Test',
      protocolVersion: 1,
      appVersion: '1',
    });
    const sentOpen = h.current().sent.find((env) => env.kind === 'link-open')!;
    const acceptedPayload = {
      appVersion: '1',
      allowlistHash: 'hash',
      capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
      transportStreamId: 'remote-stream',
    };
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: acceptedPayload,
    });
    await open;
    h.current().bufferedAmount = 9 * 1024 * 1024;
    expect(() => h.client.closeLink('dev-b', 'user')).not.toThrow();
    h.current().bufferedAmount = 0;

    const received: string[] = [];
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      received.push((env.payload as { payload: { text: string } }).payload.text);
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: acceptedPayload,
    });
    h.current().push(encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: { channel: 'maker:event', payload: { text: 'must stay closed' } },
    }, 'remote-stream', 1)[0]);
    await tick();

    expect(received).toEqual([]);
    h.client.stop();
  });

  it('显式关闭会取消仍在等待的 link-open，匹配的迟到 accept 也不能复活链路', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', {
      controllerName: 'Test',
      protocolVersion: 1,
      appVersion: '1',
    });
    const sentOpen = h.current().sent.find((env) => env.kind === 'link-open')!;
    h.client.closeLink('dev-b', 'user');
    await expect(open).rejects.toMatchObject({ code: 'LINK_NOT_OPEN' });

    const received: string[] = [];
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      received.push((env.payload as { payload: { text: string } }).payload.text);
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    h.current().push(encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: { channel: 'maker:event', payload: { text: 'must stay closed' } },
    }, 'remote-stream', 1)[0]);
    await tick();

    expect(received).toEqual([]);
    h.client.stop();
  });

  it('对端在 link-open 等待期撤权会立即拒绝请求，不再挂到超时', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', {
      controllerName: 'Test',
      protocolVersion: 1,
      appVersion: '1',
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'revoked' },
    });

    await expect(open).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
    h.client.stop();
  });

  it('显式 link-close 会丢弃旧 stream 尚未开始的排队帧', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'closing-stream');

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const received: number[] = [];
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      const seq = (env.payload as { payload: { seq: number } }).payload.seq;
      received.push(seq);
      if (seq === 1) return firstGate;
    });
    for (const seq of [1, 2]) {
      h.current().push(encodeReliableFrames({
        v: PROTOCOL_VERSION,
        kind: 'push',
        src: 'dev-b',
        payload: { channel: 'maker:event', payload: { seq } },
      }, 'closing-stream', seq)[0]);
    }
    await vi.waitFor(() => expect(received).toEqual([1]));
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'user' },
    });
    releaseFirst();
    await tick();

    expect(received).toEqual([1]);
    h.client.stop();
  });

  it('旧协议慢 handler 的串行队列有界，过载帧直接丢弃', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000 },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    let received = 0;
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      received++;
      if (received === 1) return firstGate;
    });
    for (let i = 0; i < 140; i++) {
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'push',
        src: 'legacy-peer',
        payload: { channel: 'maker:event', payload: { i } },
      });
    }
    await tick();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('under backpressure'));
    releaseFirst();
    await vi.waitFor(() => expect(received).toBe(128));
    h.client.stop();
  });

  it('旧连接永久挂起的 legacy handler 不会堵住重连后的新队列', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        reconnectBaseMs: 5,
        reconnectMaxMs: 5,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    let calls = 0;
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      calls++;
      if (calls === 1) return new Promise<never>(() => {});
    });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'legacy-peer',
      payload: { channel: 'maker:event', payload: { seq: 1 } },
    });
    await vi.waitFor(() => expect(calls).toBe(1));

    h.current().emit('close', 1006, 'network lost');
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    h.current().ack();
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'legacy-peer',
      payload: { channel: 'maker:event', payload: { seq: 2 } },
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    h.client.stop();
  });

  it('初次发送遇到 WebSocket 背压不占用 seq，恢复后下一条仍从 seq=1 开始', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();
    const open = h.client.openLink('dev-b', { controllerName: 'Test', protocolVersion: 1, appVersion: '1' }, 100);
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    h.current().bufferedAmount = 9 * 1024 * 1024;
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'blocked' })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    h.current().bufferedAmount = 0;
    h.client.sendPush('dev-b', 'maker:event', { text: 'sent' });
    const sent = h.current().sent.filter((e) => e.kind === 'push' && e.dst === 'dev-b');
    expect(parseTransportPayload(sent.at(-1)!.payload)?.meta.seq).toBe(1);
    h.client.stop();
  });

  it('缓冲被未 ACK 的 push 占满时，invoke-result 丢弃整个可丢弃前缀，成为最早的 live seq', async () => {
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'starved-stream');

    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }
    // （push 拥塞入队的 latest-wins 语义见专项用例
    //   「缓冲被未 ACK 的 push 占满时，新 push latest-wins 驱逐最旧帧入队」）

    // invoke-result 是控制端的存活凭据：丢弃整个队头可丢弃前缀（fresh push
    // 一并放弃），立即入队发出，不留任何 push 排在 result 之前
    expect(() =>
      h.client.sendInvokeResult('dev-b', 'probe-result', { ok: true, result: [] }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('to make room for invoke-result'),
    );
    const resultFrame = h.current().sent.find(
      (env) => env.kind === 'invoke-result' && env.id === 'probe-result',
    )!;
    const meta = parseTransportPayload(resultFrame.payload)!.meta;
    expect(meta.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    // 整个 push 前缀被丢弃：baseSeq 直接前移到 result 自身，接收端不再等任何
    // 被丢弃的 seq，result 就是下一条可交付的 live 帧
    expect(meta.baseSeq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    h.client.stop();
  });

  it('建链即丢弃可丢弃前缀：离线期间堆积的 push 不分新旧都不重放，link-accept 的 baseSeq 直接跳过它们', async () => {
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'stale-stream');

    // 三条均为新鲜 push：重连重放路径不看 TTL，单 FIFO 无法同时保证 push 无损
    // 与 invoke-result 抢占，重建链路时整个可丢弃前缀一律放弃
    h.client.sendPush('dev-b', 'maker:event', { text: 'stale-1' });
    h.client.sendPush('dev-b', 'maker:event', { text: 'stale-2' });
    h.client.sendPush('dev-b', 'maker:event', { text: 'stale-3' });

    // 静默断连(无 link-close,如对端失联/中继断开):push 留在 pending 等待重放
    h.current().emit('close', 1006, 'network lost');
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    h.current().ack();
    await tick();

    const before = h.current().sent.length;
    await establishInboundReliableLink(h, 'stale-stream-reopen');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 3 discardable pending frame(s)'),
    );
    // accept 直接宣告新基线：被丢弃 push 的 seq 1..3 被接收端整体跳过
    const accept = h.current().sent.slice(before).find((env) => env.kind === 'link-accept')!;
    expect((accept.payload as { transportBaseSeq?: number }).transportBaseSeq).toBe(4);
    // 堆积的 push 一条都不重放
    const replayedPushes = h.current().sent.slice(before).filter((env) =>
      env.kind === 'push' && env.dst === 'dev-b' && parseTransportPayload(env.payload) !== null,
    );
    expect(replayedPushes).toHaveLength(0);

    // 建链后 invoke-result 立即发出，不再排在陈旧 push 的重放洪峰后面
    h.client.sendInvokeResult('dev-b', 'probe-result', { ok: true, result: [] });
    const resultFrame = h.current().sent.find(
      (env) => env.kind === 'invoke-result' && env.id === 'probe-result',
    )!;
    expect(parseTransportPayload(resultFrame.payload)!.meta.seq).toBe(4);
    h.client.stop();
  });

  it('缓冲被未 ACK 的 push 占满时，新 push latest-wins 驱逐最旧帧入队，不再 BACKPRESSURE', async () => {
    // 生产反例（2026-08-07，P0 度量实锤）：对端停 ACK 时新鲜 push 互相背压，
    // 一小时 5168 次 BACKPRESSURE（maker:event），镜像零交付只放大重试风暴。
    // 现改为按需腾位：只丢最旧的可丢弃帧，较新的镜像历史保留给对端恢复后交付。
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'latest-wins-stream');

    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }

    // 满员后的新 push：只驱逐最旧的 1 条（seq=1）腾位，自身入队；
    // baseSeq 前移到 2，接收端整体跳过被驱逐的 seq，无空洞
    expect(() =>
      h.client.sendPush('dev-b', 'maker:event', { text: 'newest-1' }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('latest-wins push admission'),
    );
    const pushFrames = () => h.current().sent.filter(
      (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
    );
    let meta = parseTransportPayload(pushFrames().at(-1)!.payload)!.meta;
    expect(meta.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    expect(meta.baseSeq).toBe(2);

    // 连续洪峰：每条新 push 轮换掉一条最旧帧，队列保持满员而不再抛背压
    expect(() =>
      h.client.sendPush('dev-b', 'maker:event', { text: 'newest-2' }),
    ).not.toThrow();
    meta = parseTransportPayload(pushFrames().at(-1)!.payload)!.meta;
    expect(meta.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 2);
    expect(meta.baseSeq).toBe(3);
    h.client.stop();
  });

  it('push 拥塞腾位不跨 live 帧：队头是 live invoke 时新 push 维持 BACKPRESSURE', async () => {
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, requestTimeoutMs: 5_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', {
      controllerName: 'Test',
      protocolVersion: 1,
      appVersion: '1',
    });
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    // 队头 seq=1 是仍在等待响应的 live invoke，其后被 push 填满：
    // live 帧是可丢弃前缀的边界，push 腾位不得跨越（会留 seq 空洞）
    const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] }, 5_000);
    p.catch(() => {});
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 1; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }

    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'overflow' })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('latest-wins push admission'),
    );
    h.client.stop();
  });

  it('流控 push(contacts-sync)满员入队不驱逐镜像帧,维持 BACKPRESSURE 交发送方流控', async () => {
    // contacts-sync sender 对 BACKPRESSURE 做阻塞等待重试(它的流控协议),
    // 它的帧不得触发 latest-wins 驱逐别人——满员时按原语义拒收即可。
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'flow-controlled-in-stream');

    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }
    expect(() =>
      h.client.sendPush('dev-b', DL_CONTACTS_SYNC_CHANNEL, { version: 1, type: 'chunk' }),
    ).toThrow(expect.objectContaining({ code: 'BACKPRESSURE' }));
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('latest-wins push admission'),
    );
    h.client.stop();
  });

  it('已入队的流控 push 是腾位边界:镜像洪峰驱逐到它即止,分片不被静默丢弃', async () => {
    // 反例(review P2):contacts-sync 的 cipher-chunk 一旦被 maker:event 洪峰
    // 静默驱逐,发送方以为已送达,接收端永远拼不出本次传输。
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'flow-controlled-boundary-stream');

    // 队形:2 条镜像(seq1-2) + 1 条 contacts 分片(seq3) + 镜像填满到 64
    h.client.sendPush('dev-b', 'maker:event', { i: 0 });
    h.client.sendPush('dev-b', 'maker:event', { i: 1 });
    h.client.sendPush('dev-b', DL_CONTACTS_SYNC_CHANNEL, { version: 1, type: 'chunk', index: 0 });
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 3; i++) {
      h.client.sendPush('dev-b', 'maker:event', { fill: i });
    }

    const pushFrames = () => h.current().sent.filter(
      (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
    );
    // 洪峰驱逐 seq1、seq2 两条镜像后,队头是 contacts 分片:边界生效,第三条拒收
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'newest-1' })).not.toThrow();
    expect(parseTransportPayload(pushFrames().at(-1)!.payload)!.meta.baseSeq).toBe(2);
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'newest-2' })).not.toThrow();
    expect(parseTransportPayload(pushFrames().at(-1)!.payload)!.meta.baseSeq).toBe(3);
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'blocked' })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    h.client.stop();
  });

  it('白名单外的事件流 push(messages:created)不参与 latest-wins:不驱逐别人,也不被驱逐', async () => {
    // review P1(第二轮):local-db:messages:created 是不可合并的事件流——拥塞
    // 驱逐发生时 link 未断,reconnect reseed 不会跑,静默驱逐 = UI 永久漏一条消息。
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'event-stream-guard-stream');

    // 方向一:满员时它自己入队不驱逐镜像,维持 BACKPRESSURE
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }
    expect(() =>
      h.client.sendPush('dev-b', 'local-db:messages:created', { messageId: 'm1' }),
    ).toThrow(expect.objectContaining({ code: 'BACKPRESSURE' }));
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('latest-wins push admission'),
    );
    h.client.stop();
  });

  it('已入队的事件流 push 是腾位边界:镜像洪峰驱逐到 messages:created 即止', async () => {
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'event-stream-boundary-stream');

    // 队形:1 条镜像(seq1) + 1 条 messages:created(seq2) + 镜像填满到 64
    h.client.sendPush('dev-b', 'maker:event', { i: 0 });
    h.client.sendPush('dev-b', 'local-db:messages:created', { messageId: 'm1' });
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 2; i++) {
      h.client.sendPush('dev-b', 'maker:event', { fill: i });
    }

    const pushFrames = () => h.current().sent.filter(
      (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
    );
    // 第一条洪峰驱逐 seq1 镜像入队;第二条队头已是 messages:created,拒收
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'newest-1' })).not.toThrow();
    expect(parseTransportPayload(pushFrames().at(-1)!.payload)!.meta.baseSeq).toBe(2);
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'blocked' })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    h.client.stop();
  });

  it('键控终态快照(sessions:activity)不参与 latest-wins:收尾快照不被 maker:event 洪峰驱逐', async () => {
    // review P2(第三轮):activity 按 sessionId 键控,completed/error 收尾快照是
    // 该键最后一帧;staging 在 sendPush 成功后即删暂存不再重试,link 不重连
    // reseed 不会跑——被驱逐 = 手机端永远显示 running。
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'activity-final-stream');

    // 队形:1 条镜像(seq1) + 会话 A 的 completed 快照(seq2) + 镜像填满到 64
    h.client.sendPush('dev-b', 'maker:event', { i: 0 });
    h.client.sendPush('dev-b', SESSION_ACTIVITY_CHANNEL, { sessionId: 'a', status: 'completed' });
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 2; i++) {
      h.client.sendPush('dev-b', 'maker:event', { fill: i });
    }

    const pushFrames = () => h.current().sent.filter(
      (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
    );
    // 洪峰驱逐 seq1 镜像后,队头是 activity 收尾快照:边界生效,后续洪峰拒收
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'newest-1' })).not.toThrow();
    expect(parseTransportPayload(pushFrames().at(-1)!.payload)!.meta.baseSeq).toBe(2);
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'blocked' })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    // activity 满员入队也不驱逐别人(不在白名单)
    expect(() =>
      h.client.sendPush('dev-b', SESSION_ACTIVITY_CHANNEL, { sessionId: 'b', status: 'running' }),
    ).toThrow(expect.objectContaining({ code: 'BACKPRESSURE' }));
    h.client.stop();
  });

  it('WebSocket 缓冲满时 push 在驱逐前拒绝:不为无法入队的帧清空镜像历史', async () => {
    // review P1:容量预检若晚于驱逐,连续调用会逐步清空本可重试的镜像历史,
    // 却一帧未纳。预检先行后,ws 满那一轮必须一条都不驱逐。
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'ws-precheck-stream');

    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }
    h.current().bufferedAmount = MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES;
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'rejected' })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('latest-wins push admission'),
    );

    // ws 恢复后的下一条 push 只驱逐本轮的 1 条(baseSeq=2):
    // 证明 ws 满那一轮没有发生任何驱逐,否则基线会更靠后
    h.current().bufferedAmount = 0;
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'admitted' })).not.toThrow();
    const pushFrames = h.current().sent.filter(
      (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
    );
    expect(parseTransportPayload(pushFrames.at(-1)!.payload)!.meta.baseSeq).toBe(2);
    h.client.stop();
  });

  it('live invoke 入队压力只做 TTL 兜底清扫(单调时钟计量):过期 push 出队,新鲜 push 不被 invoke 驱逐', async () => {
    // TTL 用单调时钟:墙钟被 NTP 向前校正超过 TTL 时,刚入队的 push 不得被误判过期。
    // (push 入队已改 latest-wins,TTL 路径由 live invoke 的入队压力触达。)
    const proto = DeviceLinkClient.prototype as unknown as { monotonicNow(): number };
    let nowMs = 10_000;
    const clock = vi.spyOn(proto, 'monotonicNow').mockImplementation(() => nowMs);
    try {
      const warn = vi.fn();
      const h = makeHarness({
        timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000, requestTimeoutMs: 5_000 },
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      });
      h.client.start();
      await tick();
      h.current().ack();
      await establishInboundReliableLink(h, 'ttl-invoke-stream');

      h.client.sendPush('dev-b', 'maker:event', { text: 'old-1' });
      h.client.sendPush('dev-b', 'maker:event', { text: 'old-2' });
      // 只推进单调时钟:前两条 push 超龄,后续 push 保持新鲜
      nowMs += TRANSPORT_PENDING_PUSH_MAX_AGE_MS + 1;
      for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 2; i++) {
        h.client.sendPush('dev-b', 'maker:event', { i });
      }

      // 缓冲满:live invoke 触发 TTL 兜底清扫,2 条过期 push 出队,invoke 入队
      const p1 = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] }, 5_000);
      p1.catch(() => {});
      await tick();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('dropped 2 discardable pending frame(s)'),
      );

      // 填回满员后队头是新鲜 push:invoke 不得驱逐它们,维持 BACKPRESSURE
      h.client.sendPush('dev-b', 'maker:event', { text: 'refill' });
      let backpressured: unknown;
      const p2 = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] }, 5_000);
      await p2.catch((err: unknown) => { backpressured = err; });
      expect(backpressured).toEqual(expect.objectContaining({ code: 'BACKPRESSURE' }));
      h.client.stop();
    } finally {
      clock.mockRestore();
    }
  });

  it('队头 skip 占位不再挡住腾位：invoke 超时成 skip 后，invoke-result 跨过 skip 与 push 入队，重连后第一个重放', async () => {
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'skip-head-stream');

    // seq=1：invoke 超时后被 dropReliablePendingForRequest 换成 transport-skip
    // 占位：外层 kind 仍是 invoke，但已无业务副作用
    const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] }, 20);
    await expect(p).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });

    // skip 之后队列被 push 填满
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 1; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }

    // 旧判据按外层 kind === 'invoke' 会在队头 skip 上停下→BACKPRESSURE；
    // 新判据（push || isTransportSkipPayload）跨过 skip 与全部 push
    expect(() =>
      h.client.sendInvokeResult('dev-b', 'probe-result', { ok: true, result: [] }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('to make room for invoke-result'),
    );
    const resultFrame = h.current().sent.find(
      (env) => env.kind === 'invoke-result' && env.id === 'probe-result',
    )!;
    const meta = parseTransportPayload(resultFrame.payload)!.meta;
    expect(meta.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    expect(meta.baseSeq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);

    // 静默断连后重建链路：重放的第一帧就是这条 result，没有 skip/push 挡在前面
    h.current().emit('close', 1006, 'network lost');
    await vi.waitFor(() => expect(h.sockets.length).toBeGreaterThanOrEqual(2));
    h.current().ack();
    await tick();
    const before = h.current().sent.length;
    await establishInboundReliableLink(h, 'skip-head-stream-reopen');

    const accept = h.current().sent.slice(before).find((env) => env.kind === 'link-accept')!;
    expect((accept.payload as { transportBaseSeq?: number }).transportBaseSeq)
      .toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    const replayed = h.current().sent.slice(before).filter(
      (env) => parseTransportPayload(env.payload) !== null,
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0].kind).toBe('invoke-result');
    expect(parseTransportPayload(replayed[0].payload)!.meta.baseSeq)
      .toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    h.client.stop();
  });

  it('腾位只跨过可丢弃帧：队头是 live invoke 时不驱逐，invoke-result 保持原背压语义', async () => {
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, requestTimeoutMs: 5_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();

    const open = h.client.openLink('dev-b', {
      controllerName: 'Test',
      protocolVersion: 1,
      appVersion: '1',
    });
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    // 队头 seq=1 是仍在等待响应的 live invoke（未超时、未被换成 skip），其后被 push 填满；
    // live invoke 是可丢弃前缀的边界，其后的 push 不可跨越（否则留下 seq 空洞）
    const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] }, 5_000);
    p.catch(() => {});
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 1; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }

    expect(() => h.client.sendInvokeResult('dev-b', 'r1', { ok: true, result: [] })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('to make room for invoke-result'),
    );
    h.client.stop();
  });

  it('双端有序中继：64 条 fresh push 灌满后重连，探测 invoke 的 result 先于任何重放 push 实际交付并在超时前 resolve', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'dev-a');
    const controller = makeRelayClient(relay, 'dev-b');
    // host 侧应用逻辑：自动接受 link-open，即时应答 invoke（存活探测）
    host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      }
      if (env.kind === 'invoke' && env.src && env.id) {
        host.sendInvokeResult(env.src, env.id, { ok: true, result: ['alive'] });
      }
    });
    host.start();
    controller.start();
    await relay.settleUntil(
      () => host.getStatus() === 'online' && controller.getStatus() === 'online',
    );

    const open = controller.openLink('dev-a', {
      controllerName: 'Ctrl',
      protocolVersion: 1,
      appVersion: '1',
    });
    await relay.settle();
    await open;

    // 控制端整夜离线：host 同步灌满 64 条 fresh push（入口即丢，但全部滞留
    // 在 host 的可靠 pending 里等 ACK，与线上事故的堆积形态一致）
    relay.disconnect('dev-b');
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      host.sendPush('dev-b', 'maker:event', { i });
    }

    // 控制端重连、重新建链，立即发存活探测
    await relay.settleUntil(() => controller.getStatus() === 'online');
    const reopen = controller.openLink('dev-a', {
      controllerName: 'Ctrl',
      protocolVersion: 1,
      appVersion: '1',
    });
    await relay.settle();
    await reopen;
    const probe = controller.invoke(
      'dev-a',
      { channel: 'maker:list-active', args: [] },
      2_000,
    );
    await relay.settle();

    // 关键断言 1：探测在超时窗口内真实 resolve（交付验证，非发送端 emit）
    await expect(probe).resolves.toMatchObject({ ok: true });

    // 关键断言 2：控制端收到的可靠传输帧里，result 排第一，前面没有任何
    // 重放的 push（旧实现会先把 64 条 push 写进 WS FIFO，result 只能排尾）
    const transportFrames = (relay.deliveredTo.get('dev-b') ?? []).filter(
      (env) => parseTransportPayload(env.payload) !== null,
    );
    expect(transportFrames.length).toBeGreaterThan(0);
    expect(transportFrames[0].kind).toBe('invoke-result');
    expect(transportFrames.some((env) => env.kind === 'push')).toBe(false);

    host.stop();
    controller.stop();
  });

  it('被驱逐 seq 的迟到 ACK 幂等无害：不误删存活的 result、不抛错、不错推状态', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 } });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'stale-ack-stream');

    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }
    // 驱逐 seq 1..64，result 以 seq=65 入队
    h.client.sendInvokeResult('dev-b', 'probe-result', { ok: true, result: [] });
    const resultFrame = h.current().sent.find(
      (env) => env.kind === 'invoke-result' && env.id === 'probe-result',
    )!;
    const streamId = parseTransportPayload(resultFrame.payload)!.meta.streamId;

    // 驱逐×ACK 竞态：接收端对早已被驱逐的 seq=3 的迟到累计 ACK 现在才到
    const sendAck = (ackSeq: number) => h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId, ackSeq },
      },
    });
    sendAck(3);
    // 越界的未知 ACK（超过 nextSeq-1）同样幂等忽略
    sendAck(999);
    await tick();

    // result 仍在 pending 队头：后续帧的 baseSeq 仍指向 65，未被误删
    h.client.sendPush('dev-b', 'maker:event', { text: 'after-stale-ack' });
    const pushFrames = h.current().sent.filter(
      (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
    );
    const afterStale = parseTransportPayload(pushFrames[pushFrames.length - 1].payload)!.meta;
    expect(afterStale.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 2);
    expect(afterStale.baseSeq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);

    // 真正的 ACK(65) 只清掉 result：再下一帧 baseSeq 前移到 66
    sendAck(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    await tick();
    h.client.sendPush('dev-b', 'maker:event', { text: 'after-real-ack' });
    const pushFrames2 = h.current().sent.filter(
      (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
    );
    const afterReal = parseTransportPayload(pushFrames2[pushFrames2.length - 1].payload)!.meta;
    expect(afterReal.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 3);
    expect(afterReal.baseSeq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 2);
    h.client.stop();
  });

  it('单 FIFO 固有极限：live invoke 卡在中段时，result 只跨过其前的可丢弃前缀，语义一致不死锁', async () => {
    const warn = vi.fn();
    const h = makeHarness({
      timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'mid-live-stream');

    // 队形：[push(1), live-invoke(2), push×62] → 满 64
    h.client.sendPush('dev-b', 'maker:event', { text: 'head-discardable' });
    const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] }, 5_000);
    p.catch(() => {});
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 2; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }

    // 前缀清扫停在 live invoke：只丢 seq=1，result 入队但排在 invoke+push 之后。
    // 这是维护者确认的单 FIFO 极限：live 帧之后的 push 不可跨越（会留 seq 空洞）
    expect(() =>
      h.client.sendInvokeResult('dev-b', 'queued-result', { ok: true, result: [] }),
    ).not.toThrow();
    const resultFrame = h.current().sent.find(
      (env) => env.kind === 'invoke-result' && env.id === 'queued-result',
    )!;
    const meta = parseTransportPayload(resultFrame.payload)!.meta;
    expect(meta.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
    expect(meta.baseSeq).toBe(2);

    // 再次满员且队头已是 live invoke：前缀为空，维持 BACKPRESSURE，不死循环不死锁
    expect(() => h.client.sendInvokeResult('dev-b', 'r2', { ok: true, result: [] })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    h.client.stop();
  });

  it('驱逐只作用于目标 peer：另一控制端的 pending 不受影响', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 } });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'iso-b');
    await establishInboundReliableLink(h, 'iso-c', 1, 'dev-c');

    h.client.sendPush('dev-c', 'maker:event', { keep: true });
    for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
      h.client.sendPush('dev-b', 'maker:event', { i });
    }
    // dev-b 的 result 驱逐 dev-b 全部 64 条 push
    h.client.sendInvokeResult('dev-b', 'probe-result', { ok: true, result: [] });
    const resultMeta = parseTransportPayload(
      h.current().sent.find((env) => env.kind === 'invoke-result' && env.id === 'probe-result')!.payload,
    )!.meta;
    expect(resultMeta.baseSeq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);

    // dev-c 的缓冲丝毫未动：seq=1 仍在 pending，新帧 baseSeq 仍为 1
    h.client.sendPush('dev-c', 'maker:event', { second: true });
    const devCFrames = h.current().sent.filter(
      (env) => env.kind === 'push' && env.dst === 'dev-c' && parseTransportPayload(env.payload) !== null,
    );
    const devCMeta = parseTransportPayload(devCFrames[devCFrames.length - 1].payload)!.meta;
    expect(devCMeta.seq).toBe(2);
    // 线上格式在 baseSeq === 1 时省略该字段：基线仍为 1 即未发生任何驱逐
    expect(devCMeta.baseSeq ?? 1).toBe(1);
    h.client.stop();
  });

  it('invoke request id 在没有 global crypto 的运行时仍可生成', async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    try {
      const h = makeHarness();
      h.client.start();
      await tick();
      h.current().ack();

      const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] });
      const sentInvoke = h.current().sent.find((e) => e.kind === 'invoke')!;
      expect(sentInvoke.id).toMatch(/^[0-9a-f-]{36}$/);

      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'invoke-result',
        id: sentInvoke.id,
        src: 'dev-b',
        payload: { ok: true, result: [] },
      });
      await expect(p).resolves.toMatchObject({ ok: true, result: [] });
      h.client.stop();
    } finally {
      vi.stubGlobal('crypto', originalCrypto);
    }
  });

  it('配对要 id + kind 双命中:id 撞但 kind 不符的帧不 resolve 等待中的请求(留它超时,帧交 host)', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    const frames: Envelope[] = [];
    h.client.onFrame((env) => frames.push(env));

    // openLink 等的是 link-accept;推一个 id 相同但 kind=invoke-result 的帧。
    const p = h.client.openLink('dev-b', { controllerName: 'X' }, 30);
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke-result', // 错的 kind
      id: sentOpen.id,
      src: 'dev-b',
      payload: { ok: true, result: 1 },
    });

    // 不被错误 resolve → 走超时 reject;错配帧落到 onFrame 交给 host。
    await expect(p).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });
    expect(frames.some((f) => f.kind === 'invoke-result' && f.id === sentOpen.id)).toBe(true);
    h.client.stop();
  });

  it('invoke 超时 → INVOKE_TIMEOUT', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();

    const p = h.client.invoke('dev-b', { channel: 'x', args: [] }, 20);
    await expect(p).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });
    h.client.stop();
  });

  it('同 id relay-error → 带 code reject', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();

    const p = h.client.invoke('dev-b', { channel: 'x', args: [] });
    const sent = h.current().sent.find((e) => e.kind === 'invoke')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'relay-error',
      id: sent.id,
      payload: { code: 'REMOTE_DISABLED', message: 'off' },
    });
    await expect(p).rejects.toMatchObject({ code: 'REMOTE_DISABLED' });
    h.client.stop();
  });

  it('可靠 link 收到 DEVICE_OFFLINE 后清空 pending，下次握手用 baseSeq 跨过', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 1_000 } });
    h.client.start();
    await tick();
    h.current().ack();
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const sentOpen = h.current().sent.find((e) => e.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    const invoke = h.client.invoke('dev-b', { channel: 'maker:send', args: ['hello'] });
    const sentInvoke = h.current().sent.find((e) => e.kind === 'invoke')!;
    const original = parseTransportPayload(sentInvoke.payload)!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'relay-error',
      id: sentInvoke.id,
      payload: { code: 'DEVICE_OFFLINE', message: 'offline' },
    });

    await expect(invoke).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    const skip = h.current().sent
      .filter((env) => env.kind === 'invoke')
      .map((env) => parseTransportPayload(env.payload))
      .find((part) => (
        part?.meta.seq === original.meta.seq
        && JSON.parse(part.data).__cindyDeviceLinkTransportSkip === true
      ));
    expect(skip).toBeUndefined();

    const reopen = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const reopenFrame = h.current().sent.filter((env) => env.kind === 'link-open').at(-1)!;
    expect((reopenFrame.payload as { transportBaseSeq?: number }).transportBaseSeq).toBe(
      original.meta.seq + 1,
    );
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: reopenFrame.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream-after-offline',
      },
    });
    await reopen;
    h.client.stop();
  });

  it('fire-and-forget 可靠帧收到 DEVICE_OFFLINE 后不再耗尽重试并强制重连', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        transportRetryIntervalMs: 10,
        transportMaxRetryAttempts: 1,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    const open = h.client.openLink(
      'dev-b',
      { controllerName: 'Test', protocolVersion: 1, appVersion: '1' },
      100,
    );
    const sentOpen = h.current().sent.find((env) => env.kind === 'link-open')!;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: sentOpen.id,
      src: 'dev-b',
      payload: {
        appVersion: '1',
        allowlistHash: 'hash',
        capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
        transportStreamId: 'remote-stream',
      },
    });
    await open;

    h.client.sendPush('dev-b', 'maker:event', { text: 'offline target' });
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'relay-error',
      payload: {
        code: 'DEVICE_OFFLINE',
        message: 'target device offline',
        dst: 'dev-b',
      },
    });
    await tick(30);

    expect(h.current().terminated).toBe(false);
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('invoke-result 回程遇到 DEVICE_OFFLINE 会保留，并在控制端重开 link 后重放', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        transportRetryIntervalMs: 10,
        transportMaxRetryAttempts: 1,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'controller-stream');

    h.client.sendInvokeResult('dev-b', 'result-after-offline', {
      ok: true,
      result: ['completed'],
    });
    const original = h.current().sent.find((env) => (
      env.kind === 'invoke-result' && env.id === 'result-after-offline'
    ))!;
    const originalMeta = parseTransportPayload(original.payload)!.meta;
    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'relay-error',
      id: 'result-after-offline',
      payload: {
        code: 'DEVICE_OFFLINE',
        message: 'target device offline',
        dst: 'dev-b',
      },
    });
    await tick(30);
    expect(h.current().terminated).toBe(false);

    const beforeReopen = h.current().sent.length;
    await establishInboundReliableLink(h, 'controller-stream-after-reconnect');
    const replay = h.current().sent.slice(beforeReopen).find((env) => (
      env.kind === 'invoke-result' && env.id === 'result-after-offline'
    ))!;
    expect(parseTransportPayload(replay.payload)?.meta).toMatchObject({
      streamId: originalMeta.streamId,
      seq: originalMeta.seq,
    });
    h.client.stop();
  });

  it('未连接时 invoke 直接 NOT_CONNECTED', async () => {
    const h = makeHarness();
    await expect(h.client.invoke('dev-b', { channel: 'x', args: [] })).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });

  it('帧大小按 UTF-8 字节判定:CJK 帧码元数未超但字节数超 → PAYLOAD_TOO_LARGE', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();

    // '好' = 1 UTF-16 码元 / 3 UTF-8 字节。80 万字符:码元≈0.8M(< 2MB 上限),
    // 字节≈2.4MB(> 上限)。旧实现用 text.length(码元)会放行后被服务端拒;
    // 新实现按字节判定,这里应直接 reject(回归:bytes vs code-units)。
    const cjk = '好'.repeat(800_000);
    await expect(
      h.client.invoke('dev-b', { channel: 'maker:send', args: [cjk] }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    h.client.stop();
  });

  it('hello-ack 协议版本不一致:不进 online,关连接(4400)由退避重连兜底', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    const ws = h.current();
    ws.emit('open');
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'hello-ack',
      payload: { serverProtocolVersion: PROTOCOL_VERSION + 1, deviceId: 'd', userId: 'u' },
    });
    expect(h.client.getStatus()).not.toBe('online');
    expect(ws.closed?.code).toBe(4400);
    h.client.stop();
  });

  it('断线后指数退避重连,重连成功进入 online', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    expect(h.sockets.length).toBe(1);

    // 断线 → 第一次退避 5ms
    h.current().emit('close', 1006);
    expect(h.client.getStatus()).toBe('connecting');
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));

    h.current().ack();
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('relay 以 1012 service restart 关闭时自动重连', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();

    h.current().emit('close', 1012, 'service restart');
    expect(h.client.getStatus()).toBe('connecting');
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    h.current().ack();
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('短暂上线后被 relay 顶掉时不立刻清零退避,避免重复连接风暴', async () => {
    const h = makeHarness({
      timing: {
        reconnectBaseMs: 20,
        reconnectMaxMs: 200,
        reconnectStableResetMs: 500,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    // 第一次断线 → 20ms 后重连。
    h.current().emit('close', 4409, 'replaced by newer connection');
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    h.current().ack();

    // 第二条连接还没稳定到 reconnectStableResetMs 就又被顶掉,下一次应按 40ms 退避。
    h.current().emit('close', 4409, 'replaced by newer connection');
    await tick(25);
    expect(h.sockets.length).toBe(2);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(3));
    h.client.stop();
  });

  it('断线时在途请求全部 NOT_CONNECTED', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();

    const p = h.client.invoke('dev-b', { channel: 'x', args: [] });
    h.current().emit('close', 1006);
    await expect(p).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    h.client.stop();
  });

  it('心跳:连续无 pong 超限 → terminate + 重连', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
    h.client.start();
    await tick();
    const first = h.current();
    first.ack();

    // ping 周期 8ms,pongMissLimit=1:第 2 个周期(~16ms)触发僵死。
    // 负载下(Windows CI 分片并跑)固定 tick(40) 不足以保证两个 ping 周期都已跑完 ——
    // 有界等待到 terminate 真的发生,断言语义不变(僵死必须被判出来并进重连)。
    for (let i = 0; i < 40 && !first.terminated; i++) await tick(10);
    expect(first.terminated).toBe(true);
    // 已进入重连(新 socket 已创建或定时器排队中)
    expect(h.client.getStatus()).toBe('connecting');
    h.client.stop();
  });

  it('pong 持续回应则不判僵死', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
    h.client.start();
    await tick();
    const ws = h.current();
    ws.ack();

    // 模拟 server:每收到 ping 就回 pong
    const ponger = setInterval(() => {
      if (ws.sent.some((e) => e.kind === 'ping')) {
        ws.push({ v: PROTOCOL_VERSION, kind: 'pong' });
      }
    }, 4);
    await tick(50);
    clearInterval(ponger);
    expect(ws.terminated).toBe(false);
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('非 pong 的有效入站流量也能阻止心跳误判共享连接', async () => {
    // 这条验证的是 heartbeat tick 与入站活动的逻辑顺序，不是宿主定时器精度。
    // Windows 高负载 runner 会把 4ms/8ms 真实 timer 一起推迟，再先执行较早注册的
    // heartbeat，制造测试自身的假空闲窗口；用 fake timers 固定每个周期的先后关系。
    vi.useFakeTimers();
    try {
      const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
      h.client.start();
      await vi.advanceTimersByTimeAsync(1);
      const ws = h.current();
      ws.ack();

      // 模拟 relay 仍在持续推送 presence，但 pong 偶发丢失；有效业务帧证明
      // 共享 socket 仍有入站流量，不应因单独的 pong 计数拆掉所有 peer。
      const activity = setInterval(() => {
        ws.push({
          v: PROTOCOL_VERSION,
          kind: 'presence-changed',
          payload: { deviceId: 'dev-b', online: true, deviceName: 'Test' },
        });
      }, 4);
      await vi.advanceTimersByTimeAsync(50);
      clearInterval(activity);
      expect(ws.terminated).toBe(false);
      expect(h.client.getStatus()).toBe('online');
      h.client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('多 peer 心跳:一个 peer 静默时健康 peer 的 link 与在途请求零感知', async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      timing: {
        pingIntervalMs: 8,
        pongMissLimit: 1,
        requestTimeoutMs: 200,
        transportRetryIntervalMs: 60_000,
      },
    });
    let healthyPending: Promise<unknown> | null = null;
    let activity: ReturnType<typeof setInterval> | null = null;
    try {
      h.client.start();
      await vi.advanceTimersByTimeAsync(1);
      const ws = h.current();
      ws.ack();
      const silentLink = establishInboundReliableLink(
        h,
        'heartbeat-silent-stream',
        1,
        'peer-silent',
      );
      await vi.advanceTimersByTimeAsync(1);
      await silentLink;
      const healthyLink = establishInboundReliableLink(
        h,
        'heartbeat-healthy-stream',
        1,
        'peer-healthy',
      );
      await vi.advanceTimersByTimeAsync(1);
      await healthyLink;
      expect(h.client.isLinkReady('peer-silent')).toBe(true);
      expect(h.client.isLinkReady('peer-healthy')).toBe(true);

      // peer-silent 此后不再发送任何帧；peer-healthy 上保留一个真实在途请求。
      healthyPending = h.client.invoke('peer-healthy', {
        channel: 'local-db:sessions:list',
        args: [10],
      }, 200);
      const healthyInvoke = ws.sent
        .filter((env) => env.kind === 'invoke' && env.dst === 'peer-healthy')
        .at(-1)!;
      const socketsBefore = h.sockets.length;

      // relay 仍持续报告健康 peer 的有效入站活动，但 pong 丢失。heartbeat 必须按
      // 共享 socket 的真实活性判断，不能因另一 peer 静默拆掉所有 link。
      activity = setInterval(() => {
        ws.push({
          v: PROTOCOL_VERSION,
          kind: 'presence-changed',
          payload: { deviceId: 'peer-healthy', online: true, deviceName: 'Healthy' },
        });
      }, 4);
      await vi.advanceTimersByTimeAsync(50);
      clearInterval(activity);
      activity = null;

      expect(ws.terminated).toBe(false);
      expect(h.sockets).toHaveLength(socketsBefore);
      expect(h.client.isLinkReady('peer-silent')).toBe(true);
      expect(h.client.isLinkReady('peer-healthy')).toBe(true);

      ws.push({
        v: PROTOCOL_VERSION,
        kind: 'invoke-result',
        id: healthyInvoke.id,
        src: 'peer-healthy',
        payload: { ok: true, result: ['healthy-ok'] },
      });
      await expect(healthyPending).resolves.toMatchObject({
        ok: true,
        result: ['healthy-ok'],
      });
    } finally {
      if (activity) clearInterval(activity);
      h.client.stop();
      await healthyPending?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('可解析但协议无效的入站帧不会刷新 heartbeat 活性', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
    h.client.start();
    await tick();
    const ws = h.current();
    ws.ack();

    const invalidFrames = [
      { v: PROTOCOL_VERSION + 1, kind: 'pong' },
      { v: PROTOCOL_VERSION, kind: 'future-kind' },
      {
        v: PROTOCOL_VERSION,
        kind: 'presence-changed',
        payload: { online: true },
      },
    ] as unknown as Envelope[];
    let index = 0;
    const activity = setInterval(() => {
      ws.push(invalidFrames[index % invalidFrames.length]);
      index += 1;
    }, 4);
    for (let i = 0; i < 40 && !ws.terminated; i++) await tick(10);
    clearInterval(activity);

    expect(ws.terminated).toBe(true);
    expect(h.client.getStatus()).toBe('connecting');
    h.client.stop();
  });

  it('畸形 invoke 继续分发但不会喂活 heartbeat', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
    const frames: Envelope[] = [];
    h.client.onFrame((env) => frames.push(env));
    h.client.start();
    await tick();
    const ws = h.current();
    ws.ack();

    const malformed = {
      v: PROTOCOL_VERSION,
      kind: 'invoke',
      id: 'malformed-heartbeat-invoke',
      src: 'dev-b',
      payload: { args: [] },
    } as unknown as Envelope;
    const activity = setInterval(() => ws.push(malformed), 4);
    for (let i = 0; i < 40 && !ws.terminated; i++) await tick(10);
    clearInterval(activity);

    expect(frames.length).toBeGreaterThan(0);
    expect(ws.terminated).toBe(true);
    expect(h.client.getStatus()).toBe('connecting');
    h.client.stop();
  });

  it('缺少 src 或 id 的 legacy invoke 不会喂活 heartbeat', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
      h.client.start();
      await vi.advanceTimersByTimeAsync(1);
      const ws = h.current();
      ws.ack();

      const malformed = {
        v: PROTOCOL_VERSION,
        kind: 'invoke',
        payload: { channel: 'maker:valid-looking', args: [] },
      } as unknown as Envelope;
      const activity = setInterval(() => ws.push(malformed), 4);
      await vi.advanceTimersByTimeAsync(50);
      clearInterval(activity);

      expect(ws.terminated).toBe(true);
      expect(h.client.getStatus()).toBe('connecting');
      h.client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('可靠 invoke 分片在重组前也算入站活性', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 50, pongMissLimit: 2 } });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'heartbeat-fragment-stream');

    const frames = encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'invoke',
      id: 'fragmented-heartbeat-invoke',
      src: 'dev-b',
      dst: 'dev-self',
      payload: { channel: 'maker:large', args: ['x'.repeat(150_000)] },
    }, 'heartbeat-fragment-stream', 1);
    expect(frames.length).toBeGreaterThan(1);

    const activity = setInterval(() => {
      for (const frame of frames) h.current().push(frame);
    }, 10);
    await tick(180);
    clearInterval(activity);

    expect(h.current().terminated).toBe(false);
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('缺少 src 或 id 的可靠 invoke 不会喂活 heartbeat', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'heartbeat-missing-id-stream');
    const ws = h.current();

    const malformed = encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'invoke',
      payload: { channel: 'maker:valid-looking', args: [] },
    }, 'heartbeat-missing-id-stream', 1)[0]!;
    const activity = setInterval(() => ws.push(malformed), 4);
    for (let i = 0; i < 40 && !ws.terminated; i++) await tick(10);
    clearInterval(activity);

    expect(ws.terminated).toBe(true);
    expect(h.client.getStatus()).toBe('connecting');
    h.client.stop();
  });

  it('heartbeat idle 使用单调时钟，不受系统时间回拨影响', async () => {
    const proto = DeviceLinkClient.prototype as unknown as { monotonicNow(): number };
    let monotonicMs = 100;
    const monotonic = vi.spyOn(proto, 'monotonicNow').mockImplementation(() => monotonicMs);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
      h.client.start();
      await tick();
      const ws = h.current();
      ws.ack();
      wallClock.mockReturnValue(-1_000_000);

      for (let i = 0; i < 40 && !ws.terminated; i++) {
        monotonicMs += 10;
        await tick(10);
      }

      expect(ws.terminated).toBe(true);
      expect(h.client.getStatus()).toBe('connecting');
      h.client.stop();
    } finally {
      wallClock.mockRestore();
      monotonic.mockRestore();
    }
  });

  it('getToken 返回 null:不建连,按退避重试', async () => {
    const h = makeHarness({ token: null });
    h.client.start();
    await tick(20);
    expect(h.sockets.length).toBe(0);
    expect(h.client.getStatus()).toBe('connecting');
    h.client.stop();
    expect(h.client.getStatus()).toBe('stopped');
  });

  it('presence-changed 分发给订阅者', async () => {
    const h = makeHarness();
    const seen: unknown[] = [];
    h.client.onPresenceChanged((s) => seen.push(s));
    h.client.start();
    await tick();
    h.current().ack();

    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'presence-changed',
      payload: { deviceId: 'dev-b', online: true, deviceName: 'B', platform: 'win32', appVersion: '1', lastSeenAt: 1, remoteControlEnabled: true, busy: false },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ deviceId: 'dev-b', online: true });
    h.client.stop();
  });

  it('入站隧道帧(invoke/push/link-close)走 onFrame', async () => {
    const h = makeHarness();
    const frames: Envelope[] = [];
    h.client.onFrame((e) => frames.push(e));
    h.client.start();
    await tick();
    h.current().ack();

    h.current().push({ v: PROTOCOL_VERSION, kind: 'invoke', id: 'r1', src: 'dev-a', payload: { channel: 'maker:send', args: [] } });
    h.current().push({ v: PROTOCOL_VERSION, kind: 'push', src: 'dev-b', payload: { channel: 'maker:event', payload: {} } });
    h.current().push({ v: PROTOCOL_VERSION, kind: 'link-close', src: 'dev-a', payload: { reason: 'user' } });
    expect(frames.map((f) => f.kind)).toEqual(['invoke', 'push', 'link-close']);
    h.client.stop();
  });

  it('畸形 invoke 仍交给业务层生成结构化拒绝', async () => {
    const h = makeHarness();
    const frames: Envelope[] = [];
    h.client.onFrame((e) => frames.push(e));
    h.client.start();
    await tick();
    h.current().ack();

    h.current().push({
      v: PROTOCOL_VERSION,
      kind: 'invoke',
      id: 'malformed-invoke',
      src: 'dev-a',
      payload: { channel: 'maker:send' },
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'invoke',
      id: 'malformed-invoke',
      payload: { channel: 'maker:send' },
    });
    h.client.stop();
  });

  it('畸形 link-close 仍交给业务层收口但不会喂活 heartbeat', async () => {
    vi.useFakeTimers();
    const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
    const frames: Envelope[] = [];
    let activity: ReturnType<typeof setInterval> | null = null;
    try {
      h.client.onFrame((env) => frames.push(env));
      h.client.start();
      await vi.advanceTimersByTimeAsync(1);
      const ws = h.current();
      ws.ack();

      const malformed = {
        v: PROTOCOL_VERSION,
        kind: 'link-close',
        src: 'dev-a',
        payload: {},
      } as unknown as Envelope;
      activity = setInterval(() => ws.push(malformed), 4);
      await vi.advanceTimersByTimeAsync(50);
      if (activity) clearInterval(activity);
      activity = null;

      expect(frames.length).toBeGreaterThan(0);
      expect(ws.terminated).toBe(true);
      expect(h.client.getStatus()).toBe('connecting');
    } finally {
      if (activity) clearInterval(activity);
      h.client.stop();
      vi.useRealTimers();
    }
  });

  it('epoch 守卫:过期 socket 的迟到 close/message 回调被忽略,不触发额外重连', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    const stale = h.current(); // socket1(epoch1),online

    // 断线 → 退避重连产生 socket2(epoch2)
    stale.emit('close', 1006);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    const fresh = h.current();

    // 过期 socket1 的迟到 close + 垃圾 message:epoch 守卫应忽略(否则 handleDisconnect 会
    // 把 this.ws=socket2 误清并再排一次重连 → socket3)。
    stale.emit('close', 1006);
    stale.emit('message', { toString: () => 'garbage-from-stale' });
    await tick(25);
    expect(h.sockets.length).toBe(2); // 没有因 stale 迟到事件多建连

    fresh.ack();
    expect(h.client.getStatus()).toBe('online'); // fresh 不受 stale 影响,正常 online
    h.client.stop();
  });

  it('离线时 sendPresence / sendPush 静默忽略(不发帧、不抛、不排队)', async () => {
    const h = makeHarness();
    // 未 start(status=stopped):直接忽略,不抛
    expect(() => h.client.sendPresence({ busy: true })).not.toThrow();
    expect(() => h.client.sendPush('dev-b', 'maker:event', {})).not.toThrow();

    h.client.start();
    await tick();
    // 已建 socket 但未 ack(status=connecting):仍忽略,不发 push,且 online 后不补发(无队列)
    h.client.sendPush('dev-b', 'maker:event', { stale: true });
    expect(h.current().sent.some((e) => e.kind === 'push')).toBe(false);

    h.current().ack();
    expect(h.current().sent.some((e) => e.kind === 'push')).toBe(false); // 离线那条没被补发
    h.client.sendPush('dev-b', 'maker:event', { x: 1 });
    expect(h.current().sent.some((e) => e.kind === 'push' && e.dst === 'dev-b')).toBe(true);
    h.client.stop();
  });

  it('presence 背压时合并最新状态并有界重试，不向 host 抛异常', async () => {
    const h = makeHarness({ timing: { presenceRetryIntervalMs: 5 } });
    h.client.start();
    await tick();
    h.current().ack();
    h.current().bufferedAmount = MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES;

    expect(() => h.client.sendPresence({ busy: true })).not.toThrow();
    expect(() => h.client.sendPresence({ remoteControlEnabled: false })).not.toThrow();
    expect(h.current().sent.some((env) => env.kind === 'presence-set')).toBe(false);

    h.current().bufferedAmount = 0;
    for (
      let attempt = 0;
      attempt < 40 && !h.current().sent.some((env) => env.kind === 'presence-set');
      attempt += 1
    ) {
      await tick(10);
    }
    expect(h.current().sent.filter((env) => env.kind === 'presence-set')).toEqual([
      expect.objectContaining({
        payload: {
          busy: true,
          remoteControlEnabled: false,
        },
      }),
    ]);
    h.client.stop();
  });

  it('connectNow:绕开挂起的退避计时器立即重连', async () => {
    // 退避基数拉大到 10s,断线后会 park 一个长计时器;connectNow 应清掉它立刻重连。
    const h = makeHarness({ timing: { reconnectBaseMs: 10_000, reconnectMaxMs: 30_000 } });
    h.client.start();
    await tick();
    h.current().ack();
    expect(h.sockets.length).toBe(1);

    h.current().emit('close', 1006);
    expect(h.client.getStatus()).toBe('connecting');
    await tick(20);
    expect(h.sockets.length).toBe(1); // 退避还没到,没新建连接

    h.client.connectNow();
    await tick();
    expect(h.sockets.length).toBe(2); // 立刻重连
    h.current().ack();
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('connectNow:online 时为空操作,不打断健康连接', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    expect(h.sockets.length).toBe(1);

    h.client.connectNow();
    await tick();
    expect(h.sockets.length).toBe(1); // 没有多建连接
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('restartConnection 丢弃半开 socket 并复位所有 peer 的旧 link 状态', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    expect(h.client.getStatus()).toBe('online');
    await establishInboundReliableLink(h, 'force-stream-a', 1, 'ctrl-force-a');
    await establishInboundReliableLink(h, 'force-stream-b', 1, 'ctrl-force-b');
    expect(h.client.isLinkReady('ctrl-force-a')).toBe(true);
    expect(h.client.isLinkReady('ctrl-force-b')).toBe(true);

    h.client.restartConnection('system-resume');
    expect(h.client.isLinkReady('ctrl-force-a')).toBe(false);
    expect(h.client.isLinkReady('ctrl-force-b')).toBe(false);
    await tick();
    expect(h.sockets.length).toBe(2);
    h.current().ack();
    expect(h.client.getStatus()).toBe('online');

    h.client.sendInvokeResult('ctrl-force-a', 'req-force-a', { ok: true, result: 'a' });
    h.client.sendInvokeResult('ctrl-force-b', 'req-force-b', { ok: true, result: 'b' });
    const resent = h.current().sent.filter((env) => env.kind === 'invoke-result');
    expect(resent).toHaveLength(2);
    expect(resent.map((env) => env.id)).toEqual(['req-force-a', 'req-force-b']);
    expect(resent.map((env) => env.payload)).toEqual([
      { ok: true, result: 'a' },
      { ok: true, result: 'b' },
    ]);
    h.client.stop();
  });

  it('connectNow:stopped 后也能拉起连接(等价 start)', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    h.client.stop();
    expect(h.client.getStatus()).toBe('stopped');

    h.client.connectNow();
    await tick();
    expect(h.sockets.length).toBe(2);
    h.current().ack();
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('waitUntilOnline:online 时立即 resolve', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    await expect(h.client.waitUntilOnline(50)).resolves.toBeUndefined();
    h.client.stop();
  });

  it('waitUntilOnline:离线请求有界等待 —— un-park 退避立即重连,上线后 resolve', async () => {
    // 退避基数 10s:断线后会 park 一个长计时器,模拟"掉线/重连窗口"。
    const h = makeHarness({ timing: { reconnectBaseMs: 10_000, reconnectMaxMs: 30_000 } });
    h.client.start();
    await tick();
    h.current().ack();

    h.current().emit('close', 1006);
    await tick(20);
    expect(h.sockets.length).toBe(1); // 退避还没到,park 住,没新建连接

    const p = h.client.waitUntilOnline(1_000);
    await tick(); // waitUntilOnline 内 connectNow un-park,立刻发起重连
    expect(h.sockets.length).toBe(2);
    h.current().ack();
    await expect(p).resolves.toBeUndefined(); // 上线后放行,而不是干等 10s 退避
    h.client.stop();
  });

  it('waitUntilOnline:超时仍未上线 → NOT_CONNECTED(让上层感知并重试)', async () => {
    // token 恒为 null:永远连不上,status 卡在 connecting。
    const h = makeHarness({ token: null });
    h.client.start();
    await tick(20);
    expect(h.client.getStatus()).toBe('connecting');
    await expect(h.client.waitUntilOnline(30)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    h.client.stop();
  });

  it('waitUntilOnline:stopped 时立即 NOT_CONNECTED(不自动拉起连接)', async () => {
    const h = makeHarness();
    // 从未 start(stopped=true):快速失败,且不创建连接(交由宿主生命周期 start)。
    await expect(h.client.waitUntilOnline(50)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(h.sockets.length).toBe(0);
  });

  it('默认行为(桌面)不受影响:不调用 connectNow/waitUntilOnline 时,断线仍按退避不提前重连', async () => {
    const h = makeHarness({ timing: { reconnectBaseMs: 50, reconnectMaxMs: 200 } });
    h.client.start();
    await tick();
    h.current().ack();

    h.current().emit('close', 1006);
    await tick(20);
    expect(h.sockets.length).toBe(1); // 退避 50ms 未到,不重连(默认曲线未被改快)
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2)); // 到点才重连
    h.current().ack();
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('getToken 挂起超过 getTokenTimeoutMs → 走退避重连,不永久卡在 connecting', async () => {
    const sockets: FakeWs[] = [];
    let calls = 0;
    const client = new DeviceLinkClient({
      getWsUrl: () => 'ws://test/api/device-link/ws',
      // 第一轮 getToken 永不 resolve(模拟弱网下 token 刷新挂死),第二轮正常返回
      getToken: () => {
        calls++;
        return calls === 1 ? new Promise<string | null>(() => {}) : Promise.resolve('jwt-token');
      },
      getHello: () => ({
        deviceName: 'Test Mac',
        platform: 'darwin',
        appVersion: '1.0.0',
        remoteControlEnabled: true,
        busy: false,
      }),
      createWebSocket: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      timing: { getTokenTimeoutMs: 10, reconnectBaseMs: 5, reconnectMaxMs: 40 },
    });
    client.start();
    await tick(5);
    expect(sockets.length).toBe(0); // 第一轮卡在 getToken,没建 socket
    // 负载下(Windows CI 分片并跑)事件循环调度可能远超名义毫秒数:单次固定 tick(30) 不足以
    // 保证 10ms getToken 超时 + ≤5ms 退避 + 第二轮 getToken 都已落地。有界等待到 socket
    // 出现,断言语义不变(挂死的第一轮必须被超时掀掉、第二轮必须真的建出连接)。
    for (let i = 0; i < 40 && sockets.length < 1; i++) await tick(10);
    expect(sockets.length).toBe(1);
    sockets[0].ack();
    expect(client.getStatus()).toBe('online');
    client.stop();
  });

  it('异步 WsFactory:resolve 时世代已变 → 关掉孤儿 socket 且不挂到 client 上', async () => {
    const sockets: FakeWs[] = [];
    let release!: (ws: WsLike) => void;
    const client = new DeviceLinkClient({
      getWsUrl: () => 'ws://test/api/device-link/ws',
      getToken: async () => 'jwt-token',
      getHello: () => ({
        deviceName: 'Test Mac',
        platform: 'darwin',
        appVersion: '1.0.0',
        remoteControlEnabled: true,
        busy: false,
      }),
      // 首轮工厂悬挂(模拟解析代理 agent 的异步往返),由测试决定何时 resolve。
      createWebSocket: () =>
        new Promise<WsLike>((resolve) => {
          release = resolve;
        }),
      timing: { reconnectBaseMs: 5, reconnectMaxMs: 40 },
    });
    client.start();
    await tick();
    // 工厂还没 resolve 时先 stop:世代作废
    client.stop();
    const orphan = new FakeWs();
    sockets.push(orphan);
    release(orphan);
    await tick();
    // 孤儿被关掉,且不会成为 client 的当前连接(stop 后状态恒为 stopped)
    expect(orphan.closed).not.toBeNull();
    expect(client.getStatus()).toBe('stopped');
  });

  it('异步 WsFactory:过期的 reject 被忽略,不改状态也不排重连', async () => {
    const statuses: string[] = [];
    let rejectFirst!: (err: Error) => void;
    let factoryCalls = 0;
    const client = new DeviceLinkClient({
      getWsUrl: () => 'ws://test/api/device-link/ws',
      getToken: async () => 'jwt-token',
      getHello: () => ({
        deviceName: 'Test Mac',
        platform: 'darwin',
        appVersion: '1.0.0',
        remoteControlEnabled: true,
        busy: false,
      }),
      createWebSocket: () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          return new Promise<WsLike>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return new FakeWs();
      },
      timing: { reconnectBaseMs: 5, reconnectMaxMs: 40 },
    });
    client.onStatusChange((s) => statuses.push(s));
    client.start();
    await tick();
    // 第一轮工厂还悬着时 stop:该轮世代已作废
    client.stop();
    statuses.length = 0;
    rejectFirst(new Error('proxy agent unavailable'));
    await tick(20);
    // 过期失败既不改状态,也不排重连(不会有第二个 socket / 新的 connecting)
    expect(statuses).toEqual([]);
    expect(factoryCalls).toBe(1);
  });

  it('握手超时(open 后 hello-ack 一直不来)→ 强制断开走退避重连', async () => {
    const h = makeHarness({ timing: { handshakeTimeoutMs: 15, reconnectBaseMs: 5, reconnectMaxMs: 40 } });
    h.client.start();
    await tick();
    const first = h.current();
    first.emit('open'); // upgrade 成功但对端不回 hello-ack(半开/服务假活)
    // 负载下(Windows CI 分片并跑)事件循环调度可能远超名义毫秒数:单次固定 tick(50)
    // 不足以保证 15ms 握手看门狗 + 退避重连都已落地。有界等待到第二个 socket 出现,
    // 断言语义不变(watchdog 必须触发新建连接;测试窗口内后续连接可能再次超时,只断言 ≥2)。
    for (let i = 0; i < 40 && h.sockets.length < 2; i++) await tick(10);
    expect(h.sockets.length).toBeGreaterThanOrEqual(2);
    expect(first.terminated || first.closed !== null).toBe(true); // 旧 socket 被回收
    // 负载下(全量并跑)事件循环调度可能远超名义毫秒数:current() 拿到的
    // socket 可能在 ack 送达前又被 15ms watchdog 换掉,ack 打在过期 socket
    // 上被 epoch 守卫忽略。有界重试直到某一代 ack 赶进自己的握手窗口,
    // 断言语义不变:握手超时重连后的新连接 ack 即 online。
    for (let i = 0; i < 20 && h.client.getStatus() !== 'online'; i++) {
      h.current().ack();
      await tick();
    }
    expect(h.client.getStatus()).toBe('online');
    h.client.stop();
  });

  it('握手超时也覆盖 open 从未到来的场景(TCP 升级挂死)', async () => {
    const h = makeHarness({ timing: { handshakeTimeoutMs: 15, reconnectBaseMs: 5, reconnectMaxMs: 40 } });
    h.client.start();
    await tick();
    expect(h.sockets.length).toBe(1); // socket 建了但 open 一直不来
    // 负载下(全量并跑)事件循环调度可能远超名义毫秒数:单次固定 tick(50) 不足以
    // 保证 15ms 握手看门狗 + 退避重连都已落地。有界等待到第二个 socket 出现,
    // 断言语义不变(open 从未到来也必须换连接)。
    for (let i = 0; i < 40 && h.sockets.length < 2; i++) await tick(10);
    expect(h.sockets.length).toBeGreaterThanOrEqual(2);
    h.client.stop();
  });

  it('连续 2 次握手超时后窗口翻倍(2×),hello-ack 上线后复位', async () => {
    const warns: string[] = [];
    const h = makeHarness({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => warns.push(args.map(String).join(' ')),
        error: () => {},
      },
      timing: { handshakeTimeoutMs: 15, reconnectBaseMs: 5, reconnectMaxMs: 10 },
    });
    const handshakeWarns = () => warns.filter((w) => w.includes('handshake not completed'));
    h.client.start();
    // 等满 3 次握手超时:前两次窗口 15ms,第三次(streak≥2)翻倍到 30ms
    for (let i = 0; i < 200 && handshakeWarns().length < 3; i++) await tick(5);
    const seen = handshakeWarns();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0]).toContain('within 15ms');
    expect(seen[1]).toContain('within 15ms');
    expect(seen[2]).toContain('within 30ms');
    // 上线复位(负载下 ack 可能打在过期 socket 上,按既有模式有界重试)
    for (let i = 0; i < 20 && h.client.getStatus() !== 'online'; i++) {
      h.current().ack();
      await tick();
    }
    expect(h.client.getStatus()).toBe('online');
    // 掉线后下一次握手超时窗口回到基础值
    const before = handshakeWarns().length;
    h.current().emit('close', 1006);
    for (let i = 0; i < 200 && handshakeWarns().length <= before; i++) await tick(5);
    expect(handshakeWarns()[before]).toContain('within 15ms');
    h.client.stop();
  });

  it('心跳僵死时无 terminate 实现(RN WebSocket)→ fallback close 回收 socket', async () => {
    const h = makeHarness({ timing: { pingIntervalMs: 8, pongMissLimit: 1 } });
    h.client.start();
    await tick();
    const first = h.current();
    // 模拟 RN 适配层没有 terminate 的历史形态:删掉后必须退回 close,不能裸遗留
    (first as { terminate?: () => void }).terminate = undefined;
    first.ack();
    // 有界轮询替代固定窗口:CI 负载下(Windows 实测)真实计时器漂移会让 8ms×2 tick
    // 的判死晚于固定 40ms 断言点,语义不变,只是等到事件发生。
    for (let i = 0; i < 100 && first.closed === null; i++) await tick(10);
    expect(first.closed).not.toBeNull();
    expect(h.client.getStatus()).toBe('connecting');
    h.client.stop();
  });

  it('restartConnection:online(可能半开假活)也强制重建并复位 link 状态;stopped 不拉起', async () => {
    const h = makeHarness({ timing: { reconnectBaseMs: 5, reconnectMaxMs: 10 } });
    h.client.start();
    await tick();
    h.current().ack();
    await tick();
    expect(h.client.getStatus()).toBe('online');
    // 建一条 reliable link:重建后它的收发 ready 必须被复位,host 才会重新 openLink
    await establishInboundReliableLink(h, 'resume-stream', 1, 'ctrl-resume');

    const before = h.sockets.length;
    h.client.restartConnection('system-resume');
    await tick();
    expect(h.sockets.length).toBe(before + 1); // 丢弃旧 socket,新建连接
    h.current().ack();
    await tick();
    expect(h.client.getStatus()).toBe('online');
    // 发送方向已复位:relay 在线 + link 未就绪 → invoke-result 走 legacy 裸帧
    // (若 sendPhase 残留 ready,这里会被包进 transport wrapper 走旧 stream)
    h.client.sendInvokeResult('ctrl-resume', 'req-after-resume', { ok: true, result: 1 });
    const resent = h.current().sent.filter((e) => e.kind === 'invoke-result');
    expect(resent).toHaveLength(1);
    expect(resent[0]!.payload).toMatchObject({ ok: true, result: 1 });

    h.client.stop();
    const count = h.sockets.length;
    h.client.restartConnection('after-stop');
    await tick(20);
    expect(h.sockets.length).toBe(count); // 生命周期仍归 start/stop 管
    expect(h.client.getStatus()).toBe('stopped');
  });

  it('stop 后不再重连', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    h.client.stop();
    const count = h.sockets.length;
    await tick(30);
    expect(h.sockets.length).toBe(count);
    expect(h.client.getStatus()).toBe('stopped');
  });

  describe('connection issue(连接问题旁路通道)', () => {
    it('4409 被顶号 → issue=replaced;重连成功 online 后清除(null)', async () => {
      const h = makeHarness();
      const issues: unknown[] = [];
      h.client.onConnectionIssue((i) => issues.push(i));
      h.client.start();
      await tick();
      h.current().ack();

      h.current().emit('close', 4409, 'replaced by new connection');
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'replaced', closeCode: 4409 });
      expect(issues).toHaveLength(1);

      await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
      h.current().ack();
      expect(h.client.getConnectionIssue()).toBeNull();
      expect(issues).toHaveLength(2);
      expect(issues[1]).toBeNull();
      h.client.stop();
    });

    it('升级失败 401:close 无码可辨,靠 socket error message 分类为 auth-failed', async () => {
      const h = makeHarness();
      h.client.start();
      await tick();
      const ws = h.current();
      // Node ws / RN 的升级失败路径:先 error(带 401 message),再 close(1006)
      ws.emit('error', new Error("Unexpected server response: 401"));
      ws.emit('close', 1006);
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'auth-failed' });
      h.client.stop();
    });

    it('4429 连接数超限 → too-many-connections;4400 版本 reason → version-mismatch', async () => {
      const h = makeHarness();
      h.client.start();
      await tick();
      h.current().emit('close', 4429, 'too many connections');
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'too-many-connections' });

      await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
      h.current().emit('close', 4400, 'protocol version mismatch');
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'version-mismatch' });
      h.client.stop();
    });

    it('连接级 relay-error VERSION_MISMATCH(无 pending id)→ 记 version-mismatch issue,不依赖 close reason', async () => {
      const h = makeHarness();
      h.client.start();
      await tick();
      const ws = h.current();
      ws.emit('open');
      // server hello 阶段拒绝:先发 relay-error 帧,再 close(4400) 且 reason 可能被截断为空
      ws.push({
        v: PROTOCOL_VERSION,
        kind: 'relay-error',
        payload: { code: 'VERSION_MISMATCH', message: 'protocol version mismatch: client v1, server v2' },
      });
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'version-mismatch' });
      ws.emit('close', 4400, '');
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'version-mismatch' });
      h.client.stop();
    });

    it('hello-ack 客户端侧版本校验失败 → 直接记 version-mismatch issue', async () => {
      const h = makeHarness();
      h.client.start();
      await tick();
      const ws = h.current();
      ws.emit('open');
      ws.push({
        v: PROTOCOL_VERSION,
        kind: 'hello-ack',
        payload: { serverProtocolVersion: PROTOCOL_VERSION + 1, deviceId: 'd', userId: 'u' },
      });
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'version-mismatch' });
      h.client.stop();
    });

    it('普通断线(1006 无 error)不产生 issue;也不清除已有 issue', async () => {
      const h = makeHarness();
      h.client.start();
      await tick();
      h.current().ack();
      h.current().emit('close', 1006);
      expect(h.client.getConnectionIssue()).toBeNull();

      // 先制造 auth-failed,再来一次普通断线:原因不被网络抖动洗掉
      await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
      const ws2 = h.current();
      ws2.emit('error', new Error("Expected HTTP 101 response but was '401 Unauthorized'"));
      ws2.emit('close', 1006);
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'auth-failed' });
      await vi.waitFor(() => expect(h.sockets).toHaveLength(3));
      h.current().emit('close', 1006);
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'auth-failed' });
      h.client.stop();
    });

    it('同类 issue 重复发生只通知一次;stop 清除 issue', async () => {
      const h = makeHarness();
      const issues: unknown[] = [];
      h.client.onConnectionIssue((i) => issues.push(i));
      h.client.start();
      await tick();
      const ws = h.current();
      ws.emit('error', new Error('Unexpected server response: 401'));
      ws.emit('close', 1006);
      await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
      const ws2 = h.current();
      ws2.emit('error', new Error('Unexpected server response: 401'));
      ws2.emit('close', 1006);
      expect(issues).toHaveLength(1); // 同类只通知一次

      h.client.stop();
      expect(h.client.getConnectionIssue()).toBeNull();
      expect(issues).toHaveLength(2);
      expect(issues[1]).toBeNull();
    });

    describe('unstable(反复连上又掉)', () => {
      const flappy = () =>
        makeHarness({ timing: { reconnectStableResetMs: 60, pingIntervalMs: 10_000 } });

      async function flap(h: Harness, first = false): Promise<void> {
        if (first) h.client.start();
        await tick(first ? 0 : 45);
        h.current().ack();
        h.current().emit('close', 1006);
      }

      it('前两次短命不打扰用户,第三次连续才判 unstable', async () => {
        const h = flappy();
        await flap(h, true);
        expect(h.client.getConnectionIssue()).toBeNull();
        await flap(h);
        expect(h.client.getConnectionIssue()).toBeNull();
        await flap(h);
        expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'unstable' });
        h.client.stop();
      });

      it('hello-ack 不会立即清除 unstable,稳定在线满一个周期后才清除', async () => {
        const h = flappy();
        await flap(h, true);
        await flap(h);
        await flap(h);
        expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'unstable' });
        await tick(45);
        h.current().ack();
        expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'unstable' });
        await tick(80);
        expect(h.client.getConnectionIssue()).toBeNull();
        h.current().emit('close', 1006);
        expect(h.client.getConnectionIssue()).toBeNull();
        h.client.stop();
      });

      it('具体的 4409 replaced 优先于 unstable,主动 stop 不计入', async () => {
        const h = flappy();
        h.client.start();
        await tick();
        for (let i = 0; i < 3; i++) {
          if (i > 0) await tick(45);
          h.current().ack();
          h.current().emit('close', 4409, 'replaced by new connection');
        }
        expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'replaced', closeCode: 4409 });
        h.client.stop();

        const stopped = flappy();
        for (let i = 0; i < 3; i++) {
          stopped.client.start();
          await tick();
          stopped.current().ack();
          stopped.client.stop();
        }
        expect(stopped.client.getConnectionIssue()).toBeNull();
      });
    });
  });

  describe('客户端主动重建(connect 重入丢弃在用 socket)', () => {
    const silent = () => {};

    it('握手途中 connectNow:丢弃在用 socket、带 reason 打 INFO 排障锚点', async () => {
      const info = vi.fn();
      const h = makeHarness({ logger: { debug: silent, info, warn: silent, error: silent } });
      h.client.start();
      await tick();
      const first = h.current();
      first.emit('open'); // 已建连未 hello-ack:status 停在 connecting,connectNow 不被 online 守卫拦下
      h.client.connectNow('appstate-active');
      await tick();

      expect(h.sockets.length).toBe(2);
      expect(first.closed).toMatchObject({ code: 1000 }); // 旧 socket 被显式回收,不裸遗留
      // 静默重建此前没有任何日志痕迹(旧 socket close 被 epoch 守卫屏蔽),这条 INFO
      // 是排障时区分「客户端主动重建」与「真实断连重连」的唯一锚点。
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('discarding live socket for reconnect (reason=appstate-active, pending=0'),
      );
      h.current().ack();
      expect(h.client.getStatus()).toBe('online');
      h.client.stop();
    });

    it('重建丢弃 socket 时立即 fail in-flight 请求(不等 requestTimeoutMs)', async () => {
      const h = makeHarness({ timing: { requestTimeoutMs: 60_000 } });
      h.client.start();
      await tick();
      h.current().ack();
      const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] });

      // 公开 API 下 online 期间不会重入 connect(connectNow 有 online 守卫),白盒直调
      // 钉住防御性契约:任何丢弃在用 socket 的重建路径(文档描述的 getToken 竞态、未来
      // host 主动 restart)都必须立刻以 NOT_CONNECTED + inFlight 标记 fail 掉 in-flight
      // 请求,不许让它们挂满 requestTimeoutMs(连接翻覆场景下即 30s 空白干等)。
      void (h.client as unknown as { connect(reason: string): Promise<void> }).connect('forced-test');
      await expect(p).rejects.toMatchObject({ code: 'NOT_CONNECTED', inFlight: true });
      h.client.stop();
    });

    it('重复 hello-ack(已在线)只打判别日志:不重连、不影响 in-flight 请求', async () => {
      const info = vi.fn();
      const h = makeHarness({ logger: { debug: silent, info, warn: silent, error: silent } });
      h.client.start();
      await tick();
      const ws = h.current();
      ws.ack();
      const p = h.client.invoke('dev-b', { channel: 'maker:list-active', args: [] });
      const sentInvoke = ws.sent.find((e) => e.kind === 'invoke')!;

      // relay 在同一条 socket 上重发 hello-ack(relay 侧恢复/迁移):不是新连接
      ws.push({
        v: PROTOCOL_VERSION,
        kind: 'hello-ack',
        payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'dev-self', userId: 'u1' },
      });
      expect(h.client.getStatus()).toBe('online');
      expect(h.sockets.length).toBe(1); // 没有触发重连
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('duplicate hello-ack while already online'),
      );

      ws.push({
        v: PROTOCOL_VERSION,
        kind: 'invoke-result',
        id: sentInvoke.id,
        src: 'dev-b',
        payload: { ok: true, result: [] },
      });
      await expect(p).resolves.toMatchObject({ ok: true });
      h.client.stop();
    });
  });

  describe('可靠传输死锁自愈(2026-08-03 线上实锤:被控端回程队列冻结)', () => {
    /** 建 reliable link 后经历一次 relay 断线重连:peer.reliable=true 而收发方向未 ready。 */
    async function makeLinkDownPeer(h: Harness, src = 'ctrl-1'): Promise<void> {
      await tick();
      h.current().ack();
      await tick();
      await establishInboundReliableLink(h, `stream-${src}`, 1, src);
      const socketCount = h.sockets.length;
      h.current().emit('close', 1006);
      await vi.waitFor(() => expect(h.sockets).toHaveLength(socketCount + 1));
      h.current().ack();
      await tick();
      expect(h.client.getStatus()).toBe('online');
    }

    it('B:link 未就绪且 relay 在线时,invoke-result 降级 legacy 裸帧直发', async () => {
      const h = makeHarness({ timing: { reconnectBaseMs: 5, reconnectMaxMs: 10 } });
      h.client.start();
      await makeLinkDownPeer(h);

      h.client.sendInvokeResult('ctrl-1', 'req-legacy', { ok: true, result: 42 });
      const sent = h.current().sent.filter((e) => e.kind === 'invoke-result');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.id).toBe('req-legacy');
      // 裸帧:payload 就是业务 payload,没有 transport wrapper
      expect(sent[0]!.payload).toMatchObject({ ok: true, result: 42 });
      h.client.stop();
    });

    it('A:link 断开状态下 pending 滞留超阈值 → 新帧入队前整队放弃,不再 BACKPRESSURE', async () => {
      const proto = DeviceLinkClient.prototype as unknown as { monotonicNow(): number };
      let nowMs = 1_000_000;
      const clock = vi.spyOn(proto, 'monotonicNow').mockImplementation(() => nowMs);
      try {
        const h = makeHarness({
          timing: { reconnectBaseMs: 5, reconnectMaxMs: 10, stalledLinkPendingMaxAgeMs: 50 },
        });
        h.client.start();
        await makeLinkDownPeer(h);

        // link down:push 只入队不发送,填满 pending(64 条)
        // (用可合并镜像通道 maker:event:白名单外通道不参与 latest-wins)
        for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES; i++) {
          h.client.sendPush('ctrl-1', 'maker:event', { i });
        }
        // 第 65 条:队头未过滞留阈值 → latest-wins 驱逐最旧 push 腾位入队,
        // 不再 BACKPRESSURE(link 恢复后仍可交付较新镜像)
        expect(() => h.client.sendPush('ctrl-1', 'maker:event', { overflow: true })).not.toThrow();
        // 滞留超阈值后:入队前整队放弃,新帧不再被顶回
        nowMs += 51;
        expect(() => h.client.sendPush('ctrl-1', 'maker:event', { after: true })).not.toThrow();
        h.client.stop();
      } finally {
        clock.mockRestore();
      }
    });

    it('C:link 未就绪收到可靠帧 → 通知 host(同 peer 节流,上线后重置无关)', async () => {
      const proto = DeviceLinkClient.prototype as unknown as { monotonicNow(): number };
      let nowMs = 2_000_000;
      const clock = vi.spyOn(proto, 'monotonicNow').mockImplementation(() => nowMs);
      try {
        const h = makeHarness({ timing: { reconnectBaseMs: 5, reconnectMaxMs: 10 } });
        const notified: string[] = [];
        h.client.onReliableFrameBeforeLink((deviceId) => notified.push(deviceId));
        h.client.start();
        await makeLinkDownPeer(h, 'dev-b');

        const frame = encodeReliableFrames(
          {
            v: PROTOCOL_VERSION,
            kind: 'push',
            src: 'dev-b',
            dst: 'dev-self',
            payload: { channel: 'sessions', payload: {} },
          },
          'stream-dev-b',
          1,
          1,
        )[0]!;
        h.current().push({ ...frame, src: 'dev-b' });
        await tick();
        expect(notified).toEqual(['dev-b']);
        // 节流窗口内的第二帧不重复通知
        h.current().push({ ...frame, src: 'dev-b' });
        await tick();
        expect(notified).toEqual(['dev-b']);
        // 越过节流窗口再来一帧 → 再次通知
        nowMs += 30_001;
        h.current().push({ ...frame, src: 'dev-b' });
        await tick();
        expect(notified).toEqual(['dev-b', 'dev-b']);
        h.client.stop();
      } finally {
        clock.mockRestore();
      }
    });

    it('C3:恢复动作(openLink)按 peer 隔离 —— 邻居的真实在途可靠请求照常完成、link 不被复位', async () => {
      // 本例断言的是 peer 隔离,与心跳/超时无关:FakeWs 从不回 pong,若沿用
      // harness 默认(pingIntervalMs 10 / pongMissLimit 2)则约 30ms 真实时间后
      // 心跳看门狗就会拆连接、复位所有 peer link 并拒掉在途请求 —— 在负载高的
      // CI runner 上会把隔离断言压成假失败。把这两个真实计时器推远。
      const h = makeHarness({
        timing: { pingIntervalMs: 60_000, requestTimeoutMs: 60_000, transportRetryIntervalMs: 60_000 },
      });
      h.client.start();
      await tick();
      h.current().ack();
      await tick();
      // 共享同一条 relay 的两个 peer:都完成可靠能力协商
      await establishInboundReliableLink(h, 'stream-neighbor', 1, 'peer-neighbor');
      await establishInboundReliableLink(h, 'stream-broken', 1, 'peer-broken');
      expect(h.client.isLinkReady('peer-neighbor')).toBe(true);
      expect(h.client.isLinkReady('peer-broken')).toBe(true);

      // 邻居上挂一个**真实**在途可靠 invoke(回包未到)
      const neighborPending = h.client.invoke('peer-neighbor', {
        channel: 'local-db:sessions:list',
        args: [10],
      });
      const neighborInvoke = h.current().sent
        .filter((env) => env.kind === 'invoke' && env.dst === 'peer-neighbor')
        .at(-1)!;
      expect(neighborInvoke).toBeDefined();

      // peer-broken 的 link 瞬时重置(transport-timeout 保留可靠层,是 before-link 现场)
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'link-close',
        src: 'peer-broken',
        payload: { reason: 'transport-timeout' },
      });
      await tick();
      expect(h.client.isLinkReady('peer-broken')).toBe(false);
      expect(h.client.isLinkReady('peer-neighbor')).toBe(true);

      // 执行 host 恢复队列真正会做的动作:对 peer-broken 发起 openLink
      const socketsBefore = h.sockets.length;
      const reopened = h.client.openLink('peer-broken', {
        controllerName: 'Test Mac',
        protocolVersion: 1,
        appVersion: '1.0.0',
      });
      const openFrame = h.current().sent
        .filter((env) => env.kind === 'link-open' && env.dst === 'peer-broken')
        .at(-1)!;
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'link-accept',
        id: openFrame.id,
        src: 'peer-broken',
        payload: {
          appVersion: '1.0.0',
          allowlistHash: 'hash',
          capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
          transportStreamId: 'stream-broken-2',
          transportBaseSeq: 1,
        },
      });
      await expect(reopened).resolves.toMatchObject({ allowlistHash: 'hash' });
      expect(h.client.isLinkReady('peer-broken')).toBe(true);

      // 邻居零感知:link 未被复位、共享 relay 未重建、在途请求既未被拒也未丢
      expect(h.client.isLinkReady('peer-neighbor')).toBe(true);
      expect(h.sockets.length).toBe(socketsBefore);
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'invoke-result',
        id: neighborInvoke.id,
        src: 'peer-neighbor',
        payload: { ok: true, result: ['neighbor-ok'] },
      });
      await expect(neighborPending).resolves.toMatchObject({
        ok: true,
        result: ['neighbor-ok'],
      });
      h.client.stop();
    });

    it('C4:方向证据访问器 —— 只认业务 invoke,显式关闭出站后一票否决', async () => {
      // 同 C3:断言的是访问器语义。默认心跳会拆连接并拒掉在途 invoke,
      // 使「在途业务 invoke → 算证据」在慢 runner 上假失败。
      const h = makeHarness({ timing: { pingIntervalMs: 60_000, requestTimeoutMs: 60_000 } });
      h.client.start();
      await tick();
      h.current().ack();
      await tick();
      await establishInboundReliableLink(h, 'stream-intent', 1, 'peer-intent');

      // 无在途请求 → 无业务证据
      expect(h.client.hasPendingRequestsTo('peer-intent')).toBe(false);
      expect(h.client.isOutboundExplicitlyClosed('peer-intent')).toBe(false);

      // 在途业务 invoke → 算证据
      const pending = h.client.invoke('peer-intent', {
        channel: 'local-db:sessions:list',
        args: [1],
      });
      expect(h.client.hasPendingRequestsTo('peer-intent')).toBe(true);

      // 在途 link-open(协议请求)不算证据:重开动作本身就是发 link-open,
      // 算进来会形成「重开在途 → 因此有权重开」的自我论证闭环。
      const linkPending = h.client.openLink('peer-other', {
        controllerName: 'Test Mac',
        protocolVersion: 1,
        appVersion: '1.0.0',
      });
      expect(h.client.hasPendingRequestsTo('peer-other')).toBe(false);

      // 用户显式断开出站控制 → 一票否决(残留在途请求不得把链路拉回来)
      h.client.closeLink('peer-intent', 'user');
      expect(h.client.isOutboundExplicitlyClosed('peer-intent')).toBe(true);

      // openLink 是「意图续新」→ 清除该标记
      const reopen = h.client.openLink('peer-intent', {
        controllerName: 'Test Mac',
        protocolVersion: 1,
        appVersion: '1.0.0',
      });
      expect(h.client.isOutboundExplicitlyClosed('peer-intent')).toBe(false);

      h.client.stop();
      await Promise.allSettled([pending, linkPending, reopen]);
    });

    it('C2:link 恢复即清节流 —— 恢复后 30s 内再次丢 link 时新帧立刻再通知一次', async () => {
      const proto = DeviceLinkClient.prototype as unknown as { monotonicNow(): number };
      let nowMs = 4_000_000;
      const clock = vi.spyOn(proto, 'monotonicNow').mockImplementation(() => nowMs);
      try {
        // 断连由本例自己 emit('close') 驱动,不靠心跳:把心跳推远,避免慢 runner
        // 上看门狗抢先拆连接把「恢复后 link 就绪」的中间断言压成假失败。
        const h = makeHarness({
          timing: {
            reconnectBaseMs: 5,
            reconnectMaxMs: 10,
            pingIntervalMs: 60_000,
            requestTimeoutMs: 60_000,
          },
        });
        const notified: string[] = [];
        h.client.onReliableFrameBeforeLink((deviceId) => notified.push(deviceId));
        h.client.start();
        await makeLinkDownPeer(h, 'dev-r');

        const staleFrame = encodeReliableFrames(
          {
            v: PROTOCOL_VERSION,
            kind: 'push',
            src: 'dev-r',
            dst: 'dev-self',
            payload: { channel: 'sessions', payload: {} },
          },
          'stream-dev-r',
          1,
          1,
        )[0]!;

        h.current().push({ ...staleFrame, src: 'dev-r' });
        await tick();
        expect(notified).toEqual(['dev-r']);

        // host 重开成功(对端重新 link-open,本机 accept)→ link 就绪,节流应复位
        await establishInboundReliableLink(h, 'stream-dev-r2', 1, 'dev-r');
        expect(h.client.isLinkReady('dev-r')).toBe(true);

        // 恢复后仍在 30s 节流窗口内(时钟只走 1s)再次丢 link:新帧必须立刻再通知,
        // 否则 host 的唯一恢复出口最坏被推迟整个窗口。
        nowMs += 1_000;
        const socketCount = h.sockets.length;
        h.current().emit('close', 1006);
        await vi.waitFor(() => expect(h.sockets).toHaveLength(socketCount + 1));
        h.current().ack();
        await tick();
        const staleFrame2 = encodeReliableFrames(
          {
            v: PROTOCOL_VERSION,
            kind: 'push',
            src: 'dev-r',
            dst: 'dev-self',
            payload: { channel: 'sessions', payload: {} },
          },
          'stream-dev-r2',
          2,
          2,
        )[0]!;
        h.current().push({ ...staleFrame2, src: 'dev-r' });
        await tick();
        expect(notified).toEqual(['dev-r', 'dev-r']);
        h.client.stop();
      } finally {
        clock.mockRestore();
      }
    });
  });
});

describe('computeReconnectDelayMs(relay 拥塞冷却下限)', () => {
  const timing = {
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 30_000,
    congestionBackoffBaseMs: 5_000,
    congestionBackoffMaxMs: 30_000,
  };

  it('无拥塞信号:维持原指数退避曲线与 0.7x–1.0x 向下抖动', () => {
    expect(computeReconnectDelayMs({ ...timing, attempt: 0, congestionCloseStreak: 0, random: 0 }))
      .toBe(700);
    expect(computeReconnectDelayMs({ ...timing, attempt: 0, congestionCloseStreak: 0, random: 0.9999 }))
      .toBe(1000);
    // 指数封顶 reconnectMaxMs
    expect(computeReconnectDelayMs({ ...timing, attempt: 10, congestionCloseStreak: 0, random: 0 }))
      .toBe(21_000);
  });

  it('拥塞冷却:与普通退避取 max,按连击加深,封顶 congestionBackoffMaxMs', () => {
    // 稳定在线后 attempt 归零,但拥塞连击在:冷却下限接管(5s × 0.7 = 3.5s)
    expect(computeReconnectDelayMs({ ...timing, attempt: 0, congestionCloseStreak: 1, random: 0 }))
      .toBe(3_500);
    expect(computeReconnectDelayMs({ ...timing, attempt: 0, congestionCloseStreak: 2, random: 0 }))
      .toBe(7_000);
    // 连击封顶:5s × 2^3 = 40s > 30s 上限
    expect(computeReconnectDelayMs({ ...timing, attempt: 0, congestionCloseStreak: 4, random: 0 }))
      .toBe(21_000);
    // 普通退避已深于冷却下限时,取普通退避(max 语义,不是叠加)
    expect(computeReconnectDelayMs({ ...timing, attempt: 6, congestionCloseStreak: 1, random: 0 }))
      .toBe(21_000);
  });

  it('入参钳制:非法 attempt/streak/random 不产生 NaN 或负延迟', () => {
    expect(computeReconnectDelayMs({ ...timing, attempt: -3, congestionCloseStreak: -1, random: 0 }))
      .toBe(700);
    expect(computeReconnectDelayMs({ ...timing, attempt: Number.NaN, congestionCloseStreak: 0, random: 2 }))
      .toBe(1_000);
    expect(computeReconnectDelayMs({ ...timing, attempt: 0.9, congestionCloseStreak: 1.9, random: Number.NaN }))
      .toBe(3_500);
  });
});

describe('DeviceLinkClient relay 拥塞断连(close 1013)', () => {
  it('1013 计入拥塞连击,握手成功不清零,稳定在线满窗口才清零;普通断线不计入', async () => {
    const h = makeHarness({
      timing: {
        reconnectBaseMs: 1,
        reconnectMaxMs: 5,
        reconnectStableResetMs: 20,
        congestionStableResetMs: 80,
        congestionBackoffBaseMs: 2,
        congestionBackoffMaxMs: 8,
        pingIntervalMs: 60_000,
      },
    });
    const internals = h.client as unknown as { congestionCloseStreak: number };
    h.client.start();
    await tick();
    h.current().ack();
    expect(internals.congestionCloseStreak).toBe(0);

    // relay 拥塞踢连接:计入连击
    h.current().emit('close', 1013, 'inbound backpressure');
    expect(internals.congestionCloseStreak).toBe(1);

    // 退避后重连成功:握手成功**不**清拥塞连击(与 reconnectAttempt 生命周期不同)
    await tick(40);
    h.current().ack();
    expect(h.client.getStatus()).toBe('online');
    expect(internals.congestionCloseStreak).toBe(1);

    // 普通稳定窗过了,拥塞连击仍在:现场 1013 间隔远大于 10s
    await tick(40);
    expect(internals.congestionCloseStreak).toBe(1);

    // 稳定在线满 congestionStableResetMs 后才清零
    await tick(80);
    expect(internals.congestionCloseStreak).toBe(0);

    // 普通断线(1006)不计入拥塞连击
    h.current().emit('close', 1006, 'heartbeat lost');
    expect(internals.congestionCloseStreak).toBe(0);
    h.client.stop();
  });

  it('拥塞冷却不被请求路径打穿:waitUntilOnline 不 un-park,显式用户意图 override 才立即重连', async () => {
    // review P1:事故形态下在途请求经 waitUntilOnline → connectNow 清掉冷却
    // 计时器,每次 1013 后仍立即重连,循环掐不断。
    const h = makeHarness({
      timing: {
        reconnectBaseMs: 1,
        reconnectMaxMs: 5,
        // 冷却下限拉大,确保测试窗口内计时器不会自然到点
        congestionBackoffBaseMs: 60_000,
        congestionBackoffMaxMs: 60_000,
        pingIntervalMs: 60_000,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    const socketsBefore = h.sockets.length;

    h.current().emit('close', 1013, 'inbound backpressure');
    // 请求路径 un-park:冷却期间必须被 park,不新建连接,有界等待快速失败
    await expect(h.client.waitUntilOnline(30)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(h.sockets.length).toBe(socketsBefore);

    // 显式用户意图(移动端回前台):override 立即重连
    h.client.connectNow('appstate-active', { overrideCongestionCooldown: true });
    await tick();
    expect(h.sockets.length).toBe(socketsBefore + 1);
    h.client.stop();
  });

  it('非拥塞断线的 waitUntilOnline un-park 行为不变:立即打断退避重连', async () => {
    const h = makeHarness({
      timing: {
        // 普通退避拉大:不 un-park 的话测试窗口内不会自然重连
        reconnectBaseMs: 60_000,
        reconnectMaxMs: 60_000,
        pingIntervalMs: 60_000,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    const socketsBefore = h.sockets.length;

    h.current().emit('close', 1006, 'heartbeat lost');
    const wait = h.client.waitUntilOnline(2_000);
    await tick();
    expect(h.sockets.length).toBe(socketsBefore + 1);
    h.current().ack();
    await expect(wait).resolves.toBeUndefined();
    h.client.stop();
  });

  it('多 peer 拓扑:冷却是连接级的,两个控制端对称受影响、pending 均保留并在重连后各自重放', async () => {
    // 故障半径三问 §3(remote-and-mobile-adaptation):被控端与 relay 只有一条
    // 连接、服务多个控制端。1013 是连接级故障,冷却也只推迟连接级重连——必须
    // 断言它不偏袒/不惩罚任何单个 peer:两边的 link 与 pending 处理完全对称,
    // 且冷却期间不丢在途帧,重连后各自按原 seq 重放(#1187→#1405 的放大判例
    // 正是「单 peer 故障升级成整条连接」,这里反向确认没有引入新的不对称)。
    const h = makeHarness({
      timing: {
        reconnectBaseMs: 1,
        reconnectMaxMs: 5,
        congestionBackoffBaseMs: 20,
        congestionBackoffMaxMs: 20,
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000, // 重试计时器不参与本用例
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'stream-a', 1, 'ctrl-a');
    await establishInboundReliableLink(h, 'stream-b', 1, 'ctrl-b');

    // 在途帧用 invoke-result(live 帧,永不可丢弃):push 是 best-effort 镜像,
    // 建链时会被可丢弃前缀清扫丢掉(#1375),验证不了「pending 跨冷却保留」。
    // 它也正是「另一个 peer 的在途请求回包」这一关注点本身。
    const reliableResultsTo = (dst: string): Envelope[] => h.current().sent.filter(
      (e) => e.kind === 'invoke-result' && e.dst === dst && parseTransportPayload(e.payload) !== null,
    );
    h.client.sendInvokeResult('ctrl-a', 'req-a', { ok: true, result: 'a' });
    h.client.sendInvokeResult('ctrl-b', 'req-b', { ok: true, result: 'b' });
    expect(reliableResultsTo('ctrl-a')).toHaveLength(1);
    expect(reliableResultsTo('ctrl-b')).toHaveLength(1);

    // relay 拥塞踢掉整条共享连接
    const socketsBefore = h.sockets.length;
    h.current().emit('close', 1013, 'inbound backpressure');

    // 冷却期内不重连(对两个 peer 一视同仁:谁都拿不到新连接,也没人被单独放行)
    await tick(8);
    expect(h.sockets.length).toBe(socketsBefore);

    // 冷却到点:重连并重建两条 link → 两个 peer 的 pending 各自按原 seq 重放,
    // 一条都没丢、也没有串到对方的 stream
    await tick(30);
    expect(h.sockets.length).toBe(socketsBefore + 1);
    h.current().ack();
    await establishInboundReliableLink(h, 'stream-a', 1, 'ctrl-a');
    await establishInboundReliableLink(h, 'stream-b', 1, 'ctrl-b');
    await tick();
    const replayedA = reliableResultsTo('ctrl-a');
    const replayedB = reliableResultsTo('ctrl-b');
    expect(replayedA).toHaveLength(1);
    expect(replayedB).toHaveLength(1);
    expect(parseTransportPayload(replayedA[0]!.payload)!.meta.seq).toBe(1);
    expect(parseTransportPayload(replayedB[0]!.payload)!.meta.seq).toBe(1);
    h.client.stop();
  });

  it('stopped 后经 connectNow 拉起 = 新生命周期:拥塞连击清零(与 start 对齐)', async () => {
    const h = makeHarness({
      timing: { reconnectBaseMs: 1, reconnectMaxMs: 5, pingIntervalMs: 60_000 },
    });
    const internals = h.client as unknown as { congestionCloseStreak: number };
    h.client.start();
    await tick();
    h.current().ack();
    h.current().emit('close', 1013, 'inbound backpressure');
    expect(internals.congestionCloseStreak).toBe(1);

    h.client.stop();
    h.client.connectNow('relaunch');
    expect(internals.congestionCloseStreak).toBe(0);
    h.client.stop();
  });
});

describe('定时重发的单趟预算(TRANSPORT_RETRY_PASS_BUDGET)', () => {
  /**
   * 统计每个 seq 的**发送次数**(首发 1 次,之后每次重发 +1)。
   * 分片消息一次发送会写出多帧,所以只数首片(segment.index === 0 或未分片),
   * 否则「首发」本身就会被误判成重发过。
   */
  function sendsBySeq(ws: FakeWs, kind: Envelope['kind'] = 'invoke-result'): Map<number, number> {
    const counts = new Map<number, number>();
    for (const env of ws.sent) {
      if (env.kind !== kind) continue;
      const parsed = parseTransportPayload(env.payload);
      if (!parsed) continue;
      if (parsed.meta.segment && parsed.meta.segment.index !== 0) continue;
      counts.set(parsed.meta.seq, (counts.get(parsed.meta.seq) ?? 0) + 1);
    }
    return counts;
  }
  /** 统计写进 ws 的**帧**数(分片逐帧计),用于验证按帧扣预算。 */
  function framesSent(ws: FakeWs, kind: Envelope['kind'] = 'invoke-result'): number {
    return ws.sent.filter((env) => (
      env.kind === kind && parseTransportPayload(env.payload) !== null
    )).length;
  }
  const retriedSeqs = (counts: Map<number, number>): number[] =>
    [...counts.entries()].filter(([, n]) => n > 1).map(([seq]) => seq).sort((a, b) => a - b);

  it('新确认阶段:首个 link-accept 丢失时不提前发可靠帧,同 stream 重开确认后恢复小帧', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'desktop');
    const controller = makeRelayClient(relay, 'ios');
    const receivedInvokes: Envelope[] = [];
    const offHost = host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      }
    });
    const offController = controller.onFrame((env) => {
      if (env.kind === 'invoke' && env.src && env.id) {
        receivedInvokes.push(env);
        controller.sendInvokeResult(env.src, env.id, { ok: true, result: 'small-live-result' });
      }
    });
    host.start();
    controller.start();
    await relay.settleUntil(() => host.getStatus() === 'online' && controller.getStatus() === 'online');

    relay.dropNext((senderId, env) => senderId === 'desktop' && env.kind === 'link-accept');
    const firstOpen = controller.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 50);
    const firstOpenRejection = expect(firstOpen).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });
    await relay.settle();

    const liveInvoke = host.invoke('ios', {
      channel: 'maker:small-live-request',
      args: [],
    }, 1_000);
    await relay.settle();
    const rawBeforeConfirm = relay.deliveredTo.get('ios') ?? [];
    expect(rawBeforeConfirm.some((env) => parseTransportPayload(env.payload) !== null)).toBe(false);
    await firstOpenRejection;

    const secondOpen = controller.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settleUntil(() => receivedInvokes.length === 1);
    await expect(secondOpen).resolves.toMatchObject({
      capabilities: expect.arrayContaining([
        DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
        DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM,
      ]),
    });
    expect(receivedInvokes[0]).toMatchObject({
      kind: 'invoke',
      payload: { channel: 'maker:small-live-request', args: [] },
    });
    await expect(liveInvoke).resolves.toEqual({ ok: true, result: 'small-live-result' });
    expect(host.getReliableSendQueueDepth('ios')).toBe(0);

    offHost();
    offController();
    host.stop();
    controller.stop();
  }, 10_000);

  it('新确认阶段:迟到的旧 request id 不跨代放行,只接受当前 link-open 的确认', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'desktop');
    const controller = makeRelayClient(relay, 'ios');
    const receivedInvokes: Envelope[] = [];
    const offHost = host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      }
    });
    const offController = controller.onFrame((env) => {
      if (env.kind === 'invoke' && env.src && env.id) {
        receivedInvokes.push(env);
        controller.sendInvokeResult(env.src, env.id, { ok: true, result: 'confirmed-current' });
      }
    });
    host.start();
    controller.start();
    await relay.settleUntil(() => host.getStatus() === 'online' && controller.getStatus() === 'online');

    relay.dropNext((senderId, env) => senderId === 'desktop' && env.kind === 'link-accept');
    const staleOpen = controller.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 50);
    await relay.settle();
    const staleRequestId = (relay.deliveredTo.get('desktop') ?? [])
      .filter((env) => env.kind === 'link-open')
      .at(-1)?.id;
    expect(staleRequestId).toBeTruthy();
    await expect(staleOpen).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });

    const liveInvoke = host.invoke('ios', {
      channel: 'maker:cross-generation-request',
      args: [],
    }, 1_000);
    relay.dropNext((senderId, env) => (
      senderId === 'ios' && parseTransportAck(env)?.linkRequestId !== undefined
    ));
    const currentOpen = controller.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settle();
    const accepted = await currentOpen;
    const currentRequestId = (relay.deliveredTo.get('desktop') ?? [])
      .filter((env) => env.kind === 'link-open')
      .at(-1)?.id;
    expect(currentRequestId).toBeTruthy();
    expect(currentRequestId).not.toBe(staleRequestId);
    expect(host.isLinkReady('ios')).toBe(false);

    controller.sendPush('desktop', DEVICE_LINK_TRANSPORT_ACK_CHANNEL, {
      streamId: accepted.transportStreamId,
      ackSeq: Number.MAX_SAFE_INTEGER,
      linkRequestId: currentRequestId,
    });
    await relay.settle();
    expect(host.isLinkReady('ios')).toBe(false);

    controller.sendPush('desktop', DEVICE_LINK_TRANSPORT_ACK_CHANNEL, {
      streamId: accepted.transportStreamId,
      ackSeq: 0,
      linkRequestId: staleRequestId,
    });
    await relay.settle();
    expect(host.isLinkReady('ios')).toBe(false);
    expect(receivedInvokes).toHaveLength(0);

    controller.sendPush('desktop', DEVICE_LINK_TRANSPORT_ACK_CHANNEL, {
      streamId: accepted.transportStreamId,
      ackSeq: 0,
      linkRequestId: currentRequestId,
    });
    await relay.settleUntil(() => receivedInvokes.length === 1);
    expect(host.isLinkReady('ios')).toBe(true);
    await expect(liveInvoke).resolves.toEqual({ ok: true, result: 'confirmed-current' });

    offHost();
    offController();
    host.stop();
    controller.stop();
  }, 10_000);

  it('新确认阶段:同 stream 可靠业务帧不能替代当前代确认 ACK', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'desktop', {
      transportRetryIntervalMs: 1_000,
      transportMaxRetryAttempts: 3,
    });
    const controller = makeRelayClient(relay, 'ios', {
      transportRetryIntervalMs: 1_000,
      transportMaxRetryAttempts: 3,
    });
    const receivedInvokes: Envelope[] = [];
    const offHost = host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      } else if (env.kind === 'invoke' && env.src && env.id) {
        host.sendInvokeResult(env.src, env.id, { ok: true, result: 'host-ready' });
      }
    });
    const offController = controller.onFrame((env) => {
      if (env.kind === 'invoke' && env.src && env.id) {
        receivedInvokes.push(env);
        controller.sendInvokeResult(env.src, env.id, { ok: true, result: 'reopened' });
      }
    });
    host.start();
    controller.start();
    await relay.settleUntil(() => host.getStatus() === 'online' && controller.getStatus() === 'online');

    relay.dropNext((senderId, env) => (
      senderId === 'ios' && parseTransportAck(env)?.linkRequestId !== undefined
    ));
    const firstOpen = controller.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settle();
    const accepted = await firstOpen;
    const currentRequestId = (relay.deliveredTo.get('desktop') ?? [])
      .filter((env) => env.kind === 'link-open')
      .at(-1)?.id;
    expect(currentRequestId).toBeTruthy();
    expect(host.isLinkReady('ios')).toBe(false);

    const liveInvoke = host.invoke('ios', {
      channel: 'maker:held-until-reopen',
      args: [],
    }, 1_000);
    await relay.settle();
    expect(receivedInvokes).toHaveLength(0);

    const inboundEvidence = controller.invoke('desktop', {
      channel: 'maker:prove-accept-was-processed',
      args: [],
    }, 500);
    await relay.settleUntil(() => (
      relay.deliveredTo.get('ios') ?? []
    ).some((env) => env.kind === 'invoke-result'));
    await expect(inboundEvidence).resolves.toEqual({ ok: true, result: 'host-ready' });
    expect(host.isLinkReady('ios')).toBe(false);

    controller.sendPush('desktop', DEVICE_LINK_TRANSPORT_ACK_CHANNEL, {
      streamId: accepted.transportStreamId,
      ackSeq: 0,
      linkRequestId: currentRequestId,
    });
    await relay.settleUntil(() => receivedInvokes.length === 1);
    await expect(liveInvoke).resolves.toEqual({ ok: true, result: 'reopened' });
    expect(host.isLinkReady('ios')).toBe(true);

    offHost();
    offController();
    host.stop();
    controller.stop();
  }, 10_000);

  it('新确认阶段:确认 ACK 丢失后自动有界重发,无需等待下一条控制端业务', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'desktop', {
      transportRetryIntervalMs: 20,
      transportMaxRetryAttempts: 3,
    });
    const controller = makeRelayClient(relay, 'ios', {
      transportRetryIntervalMs: 20,
      transportMaxRetryAttempts: 3,
    });
    const receivedInvokes: Envelope[] = [];
    const offHost = host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      }
    });
    const offController = controller.onFrame((env) => {
      if (env.kind === 'invoke' && env.src && env.id) {
        receivedInvokes.push(env);
        controller.sendInvokeResult(env.src, env.id, { ok: true, result: 'retry-confirmed' });
      }
    });
    host.start();
    controller.start();
    await relay.settleUntil(() => host.getStatus() === 'online' && controller.getStatus() === 'online');

    relay.dropNext((senderId, env) => (
      senderId === 'ios' && parseTransportAck(env)?.linkRequestId !== undefined
    ));
    const opened = controller.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settleUntil(() => host.isLinkReady('ios'));
    await expect(opened).resolves.toBeTruthy();
    const linkRequestId = (relay.deliveredTo.get('desktop') ?? [])
      .filter((env) => env.kind === 'link-open')
      .at(-1)?.id;
    expect(linkRequestId).toBeTruthy();

    const liveInvoke = host.invoke('ios', {
      channel: 'maker:confirmed-by-retry',
      args: [],
    }, 500);
    await relay.settleUntil(() => receivedInvokes.length === 1);
    await expect(liveInvoke).resolves.toEqual({ ok: true, result: 'retry-confirmed' });

    const confirmationAcks = (relay.deliveredTo.get('desktop') ?? []).filter((env) => (
      parseTransportAck(env)?.linkRequestId !== undefined
    ));
    // 第一包确认被丢弃后，host 收到首个重试便会恢复发送；但在其首个可靠业务帧
    // 回到 controller、取消确认计时器之前，下一次 20ms 重试可能已经进入 relay。
    // Windows runner 更容易命中这个合法竞态，因此这里只约束协议不变量：至少
    // 有一次确认送达，且不会超过首包丢失后的剩余重试预算，也不跨 request 代际。
    expect(confirmationAcks.length).toBeGreaterThanOrEqual(1);
    expect(confirmationAcks.length).toBeLessThanOrEqual(3);
    expect(confirmationAcks.every((env) => (
      parseTransportAck(env)?.linkRequestId === linkRequestId
    ))).toBe(true);

    offHost();
    offController();
    host.stop();
    controller.stop();
  }, 10_000);

  it('新确认阶段:旧帧执行完才提交的新基线会刷新确认 ACK,不复用首次 stale ackSeq', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 1_000,
        transportRetryIntervalMs: 50,
        transportMaxRetryAttempts: 3,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    const openLink = async (transportBaseSeq: number): Promise<string> => {
      const opening = h.client.openLink('dev-b', {
        controllerName: 'Test iPhone',
        protocolVersion: 1,
        appVersion: '1',
      }, 500);
      const requestId = h.current().sent.filter((env) => env.kind === 'link-open').at(-1)!.id!;
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'link-accept',
        id: requestId,
        src: 'dev-b',
        payload: {
          appVersion: '1',
          allowlistHash: 'hash',
          capabilities: [
            DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
            DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM,
          ],
          transportStreamId: 'remote-stream',
          transportBaseSeq,
        },
      });
      await opening;
      return requestId;
    };

    await openLink(1);
    let release: (() => void) | undefined;
    h.client.onFrame((env) => {
      if (env.kind !== 'push') return;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    h.current().push(encodeReliableFrames({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: { channel: 'maker:event', payload: { text: 'old-running-frame' } },
    }, 'remote-stream', 1)[0]);
    await tick();
    expect(release).toBeTypeOf('function');

    const reopenedRequestId = await openLink(2);
    const confirmationAcks = () => h.current().sent
      .map((env) => parseTransportAck(env))
      .filter((ack) => ack?.linkRequestId === reopenedRequestId);
    expect(confirmationAcks().at(-1)).toMatchObject({ ackSeq: 0 });

    release?.();
    await tick();
    expect(confirmationAcks().at(-1)).toMatchObject({ ackSeq: 1 });

    h.client.stop();
  }, 10_000);

  it('新确认阶段:确认重试全部丢失后超时重置 peer,通知控制端重开而非永久等待', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'desktop', {
      transportRetryIntervalMs: 20,
      transportMaxRetryAttempts: 3,
    });
    const controller = makeRelayClient(relay, 'ios', {
      transportRetryIntervalMs: 20,
      transportMaxRetryAttempts: 3,
    });
    const offHost = host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      }
    });
    host.start();
    controller.start();
    await relay.settleUntil(() => host.getStatus() === 'online' && controller.getStatus() === 'online');

    for (let i = 0; i < 3; i++) {
      relay.dropNext((senderId, env) => (
        senderId === 'ios' && parseTransportAck(env)?.linkRequestId !== undefined
      ));
    }
    const opened = controller.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settle();
    await expect(opened).resolves.toBeTruthy();
    await relay.settleUntil(() => (
      (relay.deliveredTo.get('ios') ?? []).some((env) => (
        env.kind === 'link-close'
        && (env.payload as { reason?: string } | undefined)?.reason === 'transport-timeout'
      ))
    ));
    expect(host.isLinkReady('ios')).toBe(false);

    offHost();
    host.stop();
    controller.stop();
  }, 10_000);

  it('新确认阶段:对端进程换 stream 后按新基线确认并重放 live 请求', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'desktop');
    const firstController = makeRelayClient(relay, 'ios');
    const offHost = host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      }
    });
    host.start();
    firstController.start();
    await relay.settleUntil(() => (
      host.getStatus() === 'online' && firstController.getStatus() === 'online'
    ));

    const firstOpen = firstController.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settleUntil(() => host.isLinkReady('ios'));
    await expect(firstOpen).resolves.toBeTruthy();

    relay.disconnect('ios');
    firstController.stop();
    const liveInvoke = host.invoke('ios', {
      channel: 'maker:survive-controller-restart',
      args: [],
    }, 1_000);
    await relay.settle();
    expect(host.getReliableSendQueueDepth('ios')).toBe(1);

    const restartedController = makeRelayClient(relay, 'ios');
    const receivedInvokes: Envelope[] = [];
    const offRestarted = restartedController.onFrame((env) => {
      if (env.kind === 'invoke' && env.src && env.id) {
        receivedInvokes.push(env);
        restartedController.sendInvokeResult(env.src, env.id, {
          ok: true,
          result: 'new-stream-result',
        });
      }
    });
    restartedController.start();
    await relay.settleUntil(() => restartedController.getStatus() === 'online');
    const reopened = restartedController.openLink('desktop', {
      controllerName: 'iPhone',
      protocolVersion: 1,
      appVersion: '2',
    }, 500);
    await relay.settleUntil(() => receivedInvokes.length === 1);

    await expect(reopened).resolves.toBeTruthy();
    await expect(liveInvoke).resolves.toEqual({ ok: true, result: 'new-stream-result' });
    expect(host.isLinkReady('ios')).toBe(true);
    expect(host.getReliableSendQueueDepth('ios')).toBe(0);

    offHost();
    offRestarted();
    host.stop();
    restartedController.stop();
  }, 10_000);

  it('新确认阶段:一个 peer 卡在确认不影响另一个 peer 的发送与 ACK', async () => {
    const relay = new MemoryRelay();
    const host = makeRelayClient(relay, 'desktop');
    const stalledController = makeRelayClient(relay, 'ios-stalled');
    const healthyController = makeRelayClient(relay, 'ios-healthy');
    const stalledInvokes: Envelope[] = [];
    const healthyInvokes: Envelope[] = [];
    const offHost = host.onFrame((env) => {
      if (env.kind === 'link-open' && env.src && env.id) {
        host.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'hash' });
      }
    });
    const offStalled = stalledController.onFrame((env) => {
      if (env.kind === 'invoke') stalledInvokes.push(env);
    });
    const offHealthy = healthyController.onFrame((env) => {
      if (env.kind === 'invoke' && env.src && env.id) {
        healthyInvokes.push(env);
        healthyController.sendInvokeResult(env.src, env.id, { ok: true, result: 'healthy' });
      }
    });
    host.start();
    stalledController.start();
    healthyController.start();
    await relay.settleUntil(() => (
      host.getStatus() === 'online'
      && stalledController.getStatus() === 'online'
      && healthyController.getStatus() === 'online'
    ));

    const healthyOpen = healthyController.openLink('desktop', {
      controllerName: 'Healthy iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settleUntil(() => host.isLinkReady('ios-healthy'));
    await expect(healthyOpen).resolves.toBeTruthy();

    relay.dropNext((senderId, env) => (
      senderId === 'ios-stalled' && parseTransportAck(env)?.linkRequestId !== undefined
    ));
    const stalledOpen = stalledController.openLink('desktop', {
      controllerName: 'Stalled iPhone',
      protocolVersion: 1,
      appVersion: '1',
    }, 500);
    await relay.settle();
    await expect(stalledOpen).resolves.toBeTruthy();
    expect(host.isLinkReady('ios-stalled')).toBe(false);

    const stalledInvoke = host.invoke('ios-stalled', {
      channel: 'maker:must-stay-held',
      args: [],
    }, 5_000);
    const stalledOutcome = stalledInvoke.catch((err: unknown) => err);
    const healthyInvoke = host.invoke('ios-healthy', {
      channel: 'maker:must-stay-independent',
      args: [],
    }, 1_000);
    await relay.settleUntil(() => healthyInvokes.length === 1);

    await expect(healthyInvoke).resolves.toEqual({ ok: true, result: 'healthy' });
    expect(stalledInvokes).toHaveLength(0);
    expect(host.getReliableSendQueueDepth('ios-stalled')).toBe(1);
    expect(host.getReliableSendQueueDepth('ios-healthy')).toBe(0);

    offHost();
    offStalled();
    offHealthy();
    host.stop();
    stalledController.stop();
    healthyController.stop();
    await expect(stalledOutcome).resolves.toMatchObject({ code: 'NOT_CONNECTED' });
  }, 10_000);

  /**
   * 这两条断言的是「**每一趟**发多少」,所以必须用 fake timers 逐趟驱动:真实定时器下
   * 回调会在负载高的 runner 上挤在一起(CI 上实测把「只压队头 2 条」跑成 4 条),那不是
   * 实现问题,而是「累计重发集合」根本不是不变量 —— 每趟上限才是。
   */
  async function withFakeTimers(
    fn: (h: Harness, advance: (ms: number) => Promise<void>) => Promise<void>,
    timing: NonNullable<Parameters<typeof makeHarness>[0]>['timing'],
  ): Promise<void> {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ timing });
      const advance = async (ms: number): Promise<void> => {
        await vi.advanceTimersByTimeAsync(ms);
      };
      h.client.start();
      await advance(1);
      h.current().ack();
      const linked = establishInboundReliableLink(h, 'remote-stream');
      await advance(1);
      await linked;
      await fn(h, advance);
      h.client.stop();
    } finally {
      vi.useRealTimers();
    }
  }

  it('对端停止 ACK 时,一趟定时重发只发预算内的最旧几条(而不是整个窗口)', async () => {
    // 2026-08-08 线上:一趟重发遍历整个 pending 窗口(上限 64 条)、同步全部写进 ws,
    // 对端 relay 路由已失效时逐帧弹回 DEVICE_OFFLINE —— 单簇 213 条就是这个形状。
    // 既有两道刹车都拦不住本趟:per-peer 制动要等 relay-error 回来(异步),ws 容量
    // 中断的阈值是 8MB(小帧根本到不了)。所以「一趟发多少条」必须自己有上限。
    await withFakeTimers(async (h, advance) => {
      for (let i = 0; i < 9; i += 1) {
        h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
      }
      const ws = h.current();
      const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
      expect(seqs).toHaveLength(9);
      expect(retriedSeqs(sendsBySeq(ws))).toEqual([]);

      // 恰好跑一趟:只重发预算内的最旧 3 条 —— 累计 ACK 只能从队头推进,顺序不是可选项
      await advance(200);
      expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, 3));

      // 再一趟:对端仍未 ACK,预算继续压在同样的队头 3 条上(不铺满窗口)
      await advance(200);
      expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, 3));
      const headCounts = seqs.slice(0, 3).map((seq) => sendsBySeq(ws).get(seq));
      expect(headCounts).toEqual([3, 3, 3]); // 首发 + 两趟重发
    }, {
      pingIntervalMs: 600_000,
      transportRetryIntervalMs: 200,
      transportRetryPassBudget: 3,
      transportMaxRetryAttempts: 50, // 不让耗尽路径提前介入
    });
  }, 10_000);

  it('队头被累计 ACK 后窗口前移,后续消息才轮到重发', async () => {
    // 「一直重发最旧几条」不是饥饿而是正确形状:接收端拿不到队头就无法消费后面的 seq。
    // 窗口只在队头被确认后前移,这条用例锚定 ACK 前后两段。
    await withFakeTimers(async (h, advance) => {
      for (let i = 0; i < 6; i += 1) {
        h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
      }
      const ws = h.current();
      const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
      const streamId = parseTransportPayload(
        ws.sent.find((env) => env.kind === 'invoke-result' && parseTransportPayload(env.payload))!.payload,
      )!.meta.streamId;

      await advance(200);
      expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, 2));

      // 累计 ACK 掉前 3 条 → 窗口前移 → 下一趟轮到 seq[3]、seq[4]
      ws.push({
        v: PROTOCOL_VERSION,
        kind: 'push',
        src: 'dev-b',
        payload: {
          channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
          payload: { streamId, ackSeq: seqs[2] },
        },
      });
      await advance(200);
      expect(retriedSeqs(sendsBySeq(ws))).toEqual([...seqs.slice(0, 2), seqs[3], seqs[4]]);
    }, {
      pingIntervalMs: 600_000,
      transportRetryIntervalMs: 200,
      transportRetryPassBudget: 2,
      transportMaxRetryAttempts: 50,
    });
  }, 10_000);

  it('分片消息按**帧**扣预算:一条大消息就能用满一趟(不再让 8 条放出上百帧)', async () => {
    // greptile P1:压垮 relay 的是帧数。按逻辑消息计数时,一条 4MB 消息分 32 片,
    // 8 条预算能放出 ~256 帧,等于没限。分片不能跨趟拆(接收端要整条重组),所以
    // 每趟至少发一条,发完按帧数结算。
    await withFakeTimers(async (h, advance) => {
      // 每条 ~3 片(payload 略大于 2×128KB)
      const chunky = 'x'.repeat(2 * 128 * 1024 + 1_000);
      for (let i = 0; i < 4; i += 1) {
        h.client.sendInvokeResult('dev-b', `big-${i}`, { ok: true, result: chunky });
      }
      const ws = h.current();
      const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
      expect(seqs).toHaveLength(4);
      // 首发就证明确实分片了:帧数远多于消息数,而每条消息只算发过 1 次
      expect(framesSent(ws)).toBeGreaterThan(8);
      expect([...sendsBySeq(ws).values()]).toEqual([1, 1, 1, 1]);

      // 预算 4 帧、每条 3 片:队头那条发完(3 帧)后,第二条会超预算 → 发送前就被拦下,
      // 留到下一趟。所以本趟只重发队头 1 条、只写出 3 帧。
      const framesBefore = framesSent(ws);
      await advance(200);
      const retried = retriedSeqs(sendsBySeq(ws));
      expect(retried).toEqual([seqs[0]]);
      // 本趟真实写出的帧数不超过 max(预算, 队头分片数) —— 这才是「上限」的准确表述
      const passFrames = framesSent(ws) - framesBefore;
      expect(passFrames).toBeLessThanOrEqual(4);
    }, {
      pingIntervalMs: 600_000,
      transportRetryIntervalMs: 200,
      transportRetryPassBudget: 4,
      transportMaxRetryAttempts: 50,
    });
  }, 15_000);

  it('队头单条就超预算时:本趟只发它一条,后面的一条都不带(上限 = max(预算, 队头分片数))', async () => {
    // review 两位都指出「预算不是硬上限」。准确表述是 max(预算, 队头分片数):队头那条
    // 压不下去(分片不能跨趟拆,而它又必须先送到),但它绝不能顺带把后面的也拖出去。
    await withFakeTimers(async (h, advance) => {
      const chunky = 'x'.repeat(3 * 128 * 1024 + 1_000); // ~4 片,单条即超预算(2)
      h.client.sendInvokeResult('dev-b', 'big', { ok: true, result: chunky });
      for (let i = 0; i < 5; i += 1) {
        h.client.sendInvokeResult('dev-b', `small-${i}`, { ok: true, result: i });
      }
      const ws = h.current();
      const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
      const framesBefore = framesSent(ws);

      await advance(200);
      // 只有队头那条大消息被重发,5 条小消息一条都没被带出去
      expect(retriedSeqs(sendsBySeq(ws))).toEqual([seqs[0]]);
      // 溢出被限制在「队头这一条的分片数」内,而不是预算 + 队头
      const passFrames = framesSent(ws) - framesBefore;
      expect(passFrames).toBeLessThanOrEqual(6);
    }, {
      pingIntervalMs: 600_000,
      transportRetryIntervalMs: 200,
      transportRetryPassBudget: 2,
      transportMaxRetryAttempts: 50,
    });
  }, 15_000);

  it('预算字段被显式塞成 undefined 时回退到常量默认,不是静默关掉限流', async () => {
    // copilot review:Partial<DeviceLinkTiming> 的「可选值直塞」会 spread 覆盖默认值,
    // Math.max(1, undefined) = NaN → 判据恒 false → 预算被静默关闭。
    await withFakeTimers(async (h, advance) => {
      for (let i = 0; i < 20; i += 1) {
        h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
      }
      const ws = h.current();
      const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
      await advance(200);
      // 回退到 TRANSPORT_RETRY_PASS_BUDGET(8),而不是把 20 条全部重发
      expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, TRANSPORT_RETRY_PASS_BUDGET));
    }, {
      pingIntervalMs: 600_000,
      transportRetryIntervalMs: 200,
      transportRetryPassBudget: undefined as unknown as number,
      transportMaxRetryAttempts: 50,
    });
  }, 10_000);

  it('超时生成的 skip 占位一定被发出(哪怕队头压着超过预算的 pending),且不顺带重放全窗口', async () => {
    // codex P2 两轮:① 不该借道无限重放(会同步重发整个窗口);② 但也不能借道「受预算的
    // 一趟」—— 那会从队头开始消耗预算、在到达 skip 之前用完,接收端正等这个 seq,后面的
    // 可靠消息会一直阻塞。所以改成定向发这一帧。
    await withFakeTimers(async (h, advance) => {
      // 队头先压 12 条(远超预算 3)
      for (let i = 0; i < 12; i += 1) {
        h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
      }
      const ws = h.current();
      const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);

      // 先挂 catch 再推进时钟:fake timer 下 reject 发生在 advance 内部,
      // 事后才 await 会被算成 unhandled rejection。
      const invoke = h.client.invoke('dev-b', { channel: 'maker:slow', args: [] }, 50)
        .then(() => null, (err: unknown) => err);
      const invokeFrame = ws.sent.filter((env) => (
        env.kind === 'invoke' && parseTransportPayload(env.payload)
      )).at(-1)!;
      const invokeSeq = parseTransportPayload(invokeFrame.payload)!.meta.seq;
      expect(invokeSeq).toBeGreaterThan(seqs.at(-1)!); // 它排在那 12 条之后

      await advance(60);
      expect(await invoke).toMatchObject({ code: 'INVOKE_TIMEOUT' });

      // ① 该 seq 的 skip 占位确实发出去了(不是等后续趟次才触达)
      const skipSent = ws.sent.some((env) => {
        const parsed = parseTransportPayload(env.payload);
        if (!parsed || parsed.meta.seq !== invokeSeq) return false;
        return JSON.parse(parsed.data)?.__cindyDeviceLinkTransportSkip === true;
      });
      expect(skipSent).toBe(true);

      // ② 没有顺带把前面 12 条全部重发(那正是本 PR 要消除的簇)
      expect(retriedSeqs(sendsBySeq(ws))).toEqual([]);
    }, {
      pingIntervalMs: 600_000,
      transportRetryIntervalMs: 10_000, // 定时器不参与,只看 skip 这一步
      transportRetryPassBudget: 3,
      transportMaxRetryAttempts: 50,
    });
  }, 10_000);

  it('同连接代重复 link-open 不再全量 replay', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 2,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    for (let i = 0; i < 7; i += 1) {
      h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
    }
    const ws = h.current();
    expect(retriedSeqs(sendsBySeq(ws))).toEqual([]);

    await establishInboundReliableLink(h, 'remote-stream');
    await tick();
    expect(retriedSeqs(sendsBySeq(ws))).toEqual([]);

    h.client.stop();
  }, 10_000);

  it('同连接同 stream 重复 link-open 确认后恢复 pending retry timer', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 20,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();

    const capabilities = [
      DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
      DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM,
      DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
    ];
    const sendInboundOpen = async (id: string): Promise<void> => {
      const off = h.client.onFrame((env) => {
        if (env.kind !== 'link-open' || env.id !== id || !env.src) return;
        h.client.sendLinkAccept(env.src, env.id, {
          appVersion: '1',
          allowlistHash: 'hash',
        });
      });
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'link-open',
        id,
        src: 'dev-b',
        payload: {
          controllerName: 'Remote',
          protocolVersion: 1,
          appVersion: '1',
          capabilities,
          transportStreamId: 'same-remote-stream',
          transportBaseSeq: 1,
        },
      });
      await tick();
      off();
    };
    const confirmInboundOpen = (id: string): void => {
      const accept = h.current().sent.filter((env) => (
        env.kind === 'link-accept' && env.id === id
      )).at(-1)!;
      const payload = accept.payload as { transportStreamId?: string };
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'push',
        src: 'dev-b',
        payload: {
          channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
          payload: {
            streamId: payload.transportStreamId,
            ackSeq: 0,
            linkRequestId: id,
          },
        },
      });
    };

    await sendInboundOpen('duplicate-open-1');
    confirmInboundOpen('duplicate-open-1');

    h.client.sendInvokeResult('dev-b', 'pending-before-duplicate', {
      ok: true,
      result: 'pending',
    });
    const ws = h.current();
    const first = ws.sent.filter((env) => (
      env.kind === 'invoke-result' && parseTransportPayload(env.payload)
    )).at(-1)!;
    const firstMeta = parseTransportPayload(first.payload)!.meta;

    // 在原 retry interval 到期前立刻处理同连接同 stream 的重复 open。
    await sendInboundOpen('duplicate-open-2');
    confirmInboundOpen('duplicate-open-2');

    await vi.waitFor(() => {
      const retries = ws.sent.filter((env) => {
        const parsed = parseTransportPayload(env.payload);
        return env.kind === 'invoke-result'
          && parsed?.meta.seq === firstMeta.seq;
      });
      expect(retries.length).toBeGreaterThan(1);
    }, { timeout: 500 });

    h.client.stop();
  }, 10_000);

  it('对端换 stream 视为真正恢复,按探测预算 replay', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 2,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    for (let i = 0; i < 7; i += 1) {
      h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
    }
    const ws = h.current();
    const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
    expect(retriedSeqs(sendsBySeq(ws))).toEqual([]);

    await establishInboundReliableLink(h, 'remote-stream-restarted');
    await tick();
    expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, 2));

    h.client.stop();
  }, 10_000);

  it('真正恢复时 replay 受探测预算约束,ACK 后再继续 drain', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 2,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    for (let i = 0; i < 7; i += 1) {
      h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
    }
    const ws = h.current();
    const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
    expect(seqs).toHaveLength(7);

    const internals = h.client as unknown as {
      peerTransport: Map<string, { sendPhase: string; receiveReady: boolean }>;
    };
    internals.peerTransport.get('dev-b')!.sendPhase = 'down';
    internals.peerTransport.get('dev-b')!.receiveReady = false;

    await establishInboundReliableLink(h, 'remote-stream-2');
    await tick();
    expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, 2));

    h.client.sendInvokeResult('dev-b', 'extra-during-recovery', { ok: true, result: 'x' });
    expect([...sendsBySeq(ws).keys()]).toHaveLength(7);

    const streamId = parseTransportPayload(
      ws.sent.find((env) => env.kind === 'invoke-result' && parseTransportPayload(env.payload))!.payload,
    )!.meta.streamId;
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId, ackSeq: seqs[1] },
      },
    });
    await tick();
    expect(retriedSeqs(sendsBySeq(ws))).toEqual([...seqs.slice(0, 2), ...seqs.slice(2, 4)]);

    h.client.stop();
  }, 10_000);

  it('恢复预算还剩一点时,放不下的大消息先入队不发出', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 3,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    h.client.sendInvokeResult('dev-b', 'small-0', { ok: true, result: 0 });
    h.client.sendInvokeResult('dev-b', 'small-1', { ok: true, result: 1 });
    const ws = h.current();
    const before = framesSent(ws);
    const internals = h.client as unknown as {
      peerTransport: Map<string, { sendPhase: string; receiveReady: boolean }>;
    };
    internals.peerTransport.get('dev-b')!.sendPhase = 'down';
    internals.peerTransport.get('dev-b')!.receiveReady = false;
    await establishInboundReliableLink(h, 'remote-stream-2');
    await tick();

    const chunky = 'x'.repeat(2 * 128 * 1024 + 1_000);
    h.client.sendInvokeResult('dev-b', 'too-big', { ok: true, result: chunky });
    expect(framesSent(ws)).toBe(before + 2);

    h.client.stop();
  }, 10_000);

  it('空队列恢复后新入队流量仍走探测预算', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 2,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    h.client.sendInvokeResult('dev-b', 'warmup', { ok: true, result: 0 });
    const ws = h.current();
    const warmup = parseTransportPayload(
      ws.sent.find((env) => env.kind === 'invoke-result' && parseTransportPayload(env.payload))!.payload,
    )!;
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: warmup.meta.streamId, ackSeq: warmup.meta.seq },
      },
    });
    await tick();

    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'transport-timeout' },
    });
    await tick();
    await establishInboundReliableLink(h, 'remote-stream');

    const before = framesSent(ws);
    for (let i = 0; i < 7; i += 1) {
      h.client.sendInvokeResult('dev-b', `after-${i}`, { ok: true, result: i });
    }
    expect(framesSent(ws)).toBe(before + 2);

    h.client.stop();
  }, 10_000);

  it('恢复期 hold 时不因共享 ws 缓冲满而 BACKPRESSURE', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 2,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    h.client.sendInvokeResult('dev-b', 'warmup', { ok: true, result: 0 });
    const ws = h.current();
    const warmup = parseTransportPayload(
      ws.sent.find((env) => env.kind === 'invoke-result' && parseTransportPayload(env.payload))!.payload,
    )!;
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: warmup.meta.streamId, ackSeq: warmup.meta.seq },
      },
    });
    await tick();
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'transport-timeout' },
    });
    await tick();
    await establishInboundReliableLink(h, 'remote-stream');

    ws.bufferedAmount = MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES;
    expect(() => h.client.sendInvokeResult('dev-b', 'probe', { ok: true, result: 0 })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );

    ws.bufferedAmount = 0;
    h.client.sendInvokeResult('dev-b', 'probe-0', { ok: true, result: 0 });
    h.client.sendInvokeResult('dev-b', 'probe-1', { ok: true, result: 1 });
    const before = framesSent(ws);
    ws.bufferedAmount = MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES;
    expect(() => h.client.sendInvokeResult('dev-b', 'held', { ok: true, result: 2 })).not.toThrow();
    expect(framesSent(ws)).toBe(before);

    h.client.stop();
  }, 10_000);

  it('已发探针被驱逐后恢复期允许再发一帧换 ACK', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 2,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    h.client.sendInvokeResult('dev-b', 'warmup', { ok: true, result: 0 });
    const ws = h.current();
    const warmup = parseTransportPayload(
      ws.sent.find((env) => env.kind === 'invoke-result' && parseTransportPayload(env.payload))!.payload,
    )!;
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: warmup.meta.streamId, ackSeq: warmup.meta.seq },
      },
    });
    await tick();
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'transport-timeout' },
    });
    await tick();
    await establishInboundReliableLink(h, 'remote-stream');

    h.client.sendInvokeResult('dev-b', 'probe-0', { ok: true, result: 0 });
    h.client.sendInvokeResult('dev-b', 'probe-1', { ok: true, result: 1 });
    const internals = h.client as unknown as {
      peerTransport: Map<string, {
        pending: Map<number, { sent: boolean; bytes: number }>;
        pendingBytes: number;
      }>;
    };
    const peer = internals.peerTransport.get('dev-b')!;
    for (const [seq, pending] of [...peer.pending]) {
      if (!pending.sent) continue;
      peer.pending.delete(seq);
      peer.pendingBytes -= pending.bytes;
    }

    const before = framesSent(ws);
    h.client.sendInvokeResult('dev-b', 'reprobe', { ok: true, result: 2 });
    expect(framesSent(ws)).toBe(before + 1);

    h.client.stop();
  }, 10_000);

  it('恢复期内部分写出的分片也计入探测预算', async () => {
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 60_000,
        transportRetryPassBudget: 3,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'remote-stream');

    h.client.sendInvokeResult('dev-b', 'warmup', { ok: true, result: 0 });
    const ws = h.current();
    const warmup = parseTransportPayload(
      ws.sent.find((env) => env.kind === 'invoke-result' && parseTransportPayload(env.payload))!.payload,
    )!;
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-b',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: warmup.meta.streamId, ackSeq: warmup.meta.seq },
      },
    });
    await tick();
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      src: 'dev-b',
      payload: { reason: 'transport-timeout' },
    });
    await tick();
    await establishInboundReliableLink(h, 'remote-stream');

    const before = framesSent(ws);
    const origSend = ws.send.bind(ws);
    let reliableFrames = 0;
    ws.send = (data: string) => {
      const env = JSON.parse(data) as Envelope;
      if (env.kind === 'invoke-result' && parseTransportPayload(env.payload)) {
        reliableFrames += 1;
        if (reliableFrames >= 2) throw new Error('socket raced');
      }
      origSend(data);
    };
    const chunky = 'x'.repeat(2 * 128 * 1024 + 1_000);
    h.client.sendInvokeResult('dev-b', 'partial', { ok: true, result: chunky });
    expect(framesSent(ws)).toBe(before + 1);

    ws.send = origSend;
    for (let i = 0; i < 5; i += 1) {
      h.client.sendInvokeResult('dev-b', `after-${i}`, { ok: true, result: i });
    }
    expect(framesSent(ws)).toBe(before + 3);

    h.client.stop();
  }, 10_000);

  it('恢复探测未 ACK 时定时器仍重发已发出的探针,不放行新帧', async () => {
    await withFakeTimers(async (h, advance) => {
      for (let i = 0; i < 7; i += 1) {
        h.client.sendInvokeResult('dev-b', `req-${i}`, { ok: true, result: i });
      }
      const ws = h.current();
      const seqs = [...sendsBySeq(ws).keys()].sort((a, b) => a - b);
      const internals = h.client as unknown as {
        peerTransport: Map<string, { sendPhase: string; receiveReady: boolean }>;
      };
      internals.peerTransport.get('dev-b')!.sendPhase = 'down';
      internals.peerTransport.get('dev-b')!.receiveReady = false;

      const id = `inbound-link-${++inboundLinkId}`;
      const off = h.client.onFrame((env) => {
        if (env.kind !== 'link-open' || env.id !== id || !env.src) return;
        h.client.sendLinkAccept(env.src, env.id, {
          appVersion: '1',
          allowlistHash: 'hash',
        });
      });
      h.current().push({
        v: PROTOCOL_VERSION,
        kind: 'link-open',
        id,
        src: 'dev-b',
        payload: {
          controllerName: 'Remote',
          protocolVersion: 1,
          appVersion: '1',
          capabilities: [
            DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
            DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
          ],
          transportStreamId: 'remote-stream-2',
          transportBaseSeq: 1,
        },
      });
      await advance(1);
      off();
      expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, 2));

      await advance(200);
      expect(retriedSeqs(sendsBySeq(ws))).toEqual(seqs.slice(0, 2));
      expect(seqs.slice(0, 2).map((seq) => sendsBySeq(ws).get(seq))).toEqual([3, 3]);
      expect(seqs.slice(2).every((seq) => sendsBySeq(ws).get(seq) === 1)).toBe(true);
    }, {
      pingIntervalMs: 600_000,
      transportRetryIntervalMs: 200,
      transportRetryPassBudget: 2,
      transportMaxRetryAttempts: 50,
    });
  }, 10_000);

  it('多 peer 拓扑:一个 peer 停止 ACK 被限流,另一个 peer 的投递零感知', async () => {
    // 故障半径第 3 问(docs/dev-rules/remote-and-mobile-adaptation.md):预算是 per-peer 的,
    // 一台休眠手机的积压不得拖慢另一台在线设备。
    const h = makeHarness({
      timing: {
        pingIntervalMs: 60_000,
        transportRetryIntervalMs: 200,
        transportRetryPassBudget: 2,
        transportMaxRetryAttempts: 50,
      },
    });
    h.client.start();
    await tick();
    h.current().ack();
    await establishInboundReliableLink(h, 'stream-b', 1, 'dev-b');
    await establishInboundReliableLink(h, 'stream-c', 1, 'dev-c');

    // dev-b 积压 8 条且从不 ACK;dev-c 只有 1 条并正常 ACK
    for (let i = 0; i < 8; i += 1) {
      h.client.sendInvokeResult('dev-b', `b-${i}`, { ok: true, result: i });
    }
    h.client.sendInvokeResult('dev-c', 'c-0', { ok: true, result: 'c' });

    const ws = h.current();
    const cFrames = () => ws.sent.filter((env) => {
      if (env.kind !== 'invoke-result' || env.dst !== 'dev-c') return false;
      return parseTransportPayload(env.payload) !== null;
    });
    expect(cFrames()).toHaveLength(1);
    const cStreamId = parseTransportPayload(cFrames()[0]!.payload)!.meta.streamId;

    // dev-c 累计 ACK:它的 pending 清空,此后不再重发
    ws.push({
      v: PROTOCOL_VERSION,
      kind: 'push',
      src: 'dev-c',
      payload: {
        channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
        payload: { streamId: cStreamId, ackSeq: 1 },
      },
    });

    // 等 dev-b 至少跑过一趟限流重发,确认 dev-c 完全没被牵连
    await vi.waitFor(() => {
      const bRetried = ws.sent.filter((env) => env.dst === 'dev-b' && env.kind === 'invoke-result');
      expect(bRetried.length).toBeGreaterThan(8);
    });
    expect(cFrames()).toHaveLength(1);

    h.client.stop();
  }, 10_000);
});
