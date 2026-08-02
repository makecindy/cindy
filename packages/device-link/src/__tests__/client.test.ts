/**
 * DeviceLinkClient 状态机单测:fake WebSocket 注入,覆盖
 * 握手 / 请求配对 / 超时 / relay-error / 重连退避 / 心跳僵死 / token 缺失。
 */
import { describe, it, expect, vi } from 'vitest';
import { DeviceLinkClient, type WsLike } from '../client.js';
import { PROTOCOL_VERSION, DeviceLinkError, type Envelope } from '../protocol.js';
import {
  DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
  DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
  MAX_TRANSPORT_PENDING_MESSAGES,
  MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES,
  TRANSPORT_PENDING_PUSH_MAX_AGE_MS,
  encodeReliableFrames,
  makeTransportSkipPayload,
  parseTransportPayload,
} from '../transport.js';

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
      capabilities: [DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT],
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

function makeRelayClient(relay: MemoryRelay, deviceId: string): DeviceLinkClient {
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
    // Windows 的零延时 timer 可能晚于两个 8ms 心跳周期才被调度；先启动 pong，
    // 确保本用例验证的是慢业务 handler 与控制帧解耦，而不是测试端尚未开始响应。
    const ponger = setInterval(() => {
      ws.push({ v: PROTOCOL_VERSION, kind: 'pong' });
    }, 4);
    await tick();
    expect(release).toBeTypeOf('function');

    await tick(40);
    clearInterval(ponger);

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
    h.client.closeLink('dev-b', 'user');

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
    // push 之间不互相驱逐：新鲜 push 溢出仍按原语义被背压拒绝
    expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'overflow' })).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );

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

  it('push 入队压力只做 TTL 兜底清扫（单调时钟计量），新鲜 push 之间仍互相背压', async () => {
    // TTL 用单调时钟：墙钟被 NTP 向前校正超过 TTL 时，刚入队的 push 不得被误判过期
    const proto = DeviceLinkClient.prototype as unknown as { monotonicNow(): number };
    let nowMs = 10_000;
    const clock = vi.spyOn(proto, 'monotonicNow').mockImplementation(() => nowMs);
    try {
      const warn = vi.fn();
      const h = makeHarness({
        timing: { pingIntervalMs: 10_000, transportRetryIntervalMs: 60_000 },
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      });
      h.client.start();
      await tick();
      h.current().ack();
      await establishInboundReliableLink(h, 'ttl-stream');

      h.client.sendPush('dev-b', 'maker:event', { text: 'old-1' });
      h.client.sendPush('dev-b', 'maker:event', { text: 'old-2' });
      // 只推进单调时钟：前两条 push 超龄，后续 push 保持新鲜
      nowMs += TRANSPORT_PENDING_PUSH_MAX_AGE_MS + 1;
      for (let i = 0; i < MAX_TRANSPORT_PENDING_MESSAGES - 2; i++) {
        h.client.sendPush('dev-b', 'maker:event', { i });
      }

      // 缓冲满：新 push 触发 TTL 兜底清扫，只有 2 条过期 push 出队，新 push 入队
      expect(() =>
        h.client.sendPush('dev-b', 'maker:event', { text: 'fresh-after-sweep' }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('dropped 2 discardable pending frame(s)'),
      );
      const frames = h.current().sent.filter(
        (env) => env.kind === 'push' && parseTransportPayload(env.payload) !== null,
      );
      const meta = parseTransportPayload(frames[frames.length - 1].payload)!.meta;
      expect(meta.seq).toBe(MAX_TRANSPORT_PENDING_MESSAGES + 1);
      expect(meta.baseSeq).toBe(3);

      // 填回满员后队头是新鲜 push：不互相驱逐，仍按原语义背压
      h.client.sendPush('dev-b', 'maker:event', { text: 'refill' });
      expect(() => h.client.sendPush('dev-b', 'maker:event', { text: 'overflow' })).toThrow(
        expect.objectContaining({ code: 'BACKPRESSURE' }),
      );
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
    await tick(15);
    expect(h.sockets.length).toBe(2);

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
    await tick(15);

    expect(h.sockets).toHaveLength(2);
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
    await tick(30);
    expect(h.sockets.length).toBe(2);
    h.current().ack();

    // 第二条连接还没稳定到 reconnectStableResetMs 就又被顶掉,下一次应按 40ms 退避。
    h.current().emit('close', 4409, 'replaced by newer connection');
    await tick(25);
    expect(h.sockets.length).toBe(2);
    await tick(30);
    expect(h.sockets.length).toBe(3);
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

    // ping 周期 8ms,pongMissLimit=1:第 2 个周期(~16ms)触发僵死
    await tick(40);
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

  it('epoch 守卫:过期 socket 的迟到 close/message 回调被忽略,不触发额外重连', async () => {
    const h = makeHarness();
    h.client.start();
    await tick();
    h.current().ack();
    const stale = h.current(); // socket1(epoch1),online

    // 断线 → 退避重连产生 socket2(epoch2)
    stale.emit('close', 1006);
    await tick(15);
    expect(h.sockets.length).toBe(2);
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
    await tick(10);
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
    await tick(50);
    expect(h.sockets.length).toBe(2); // 到点才重连
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
    await tick(30); // 10ms 超时 + ≤5ms 退避后第二轮拿到 token
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
    await tick(50);
    // watchdog 触发新建连接(测试窗口内后续连接可能再次超时,只断言 ≥2)
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
    await tick(50);
    expect(h.sockets.length).toBeGreaterThanOrEqual(2);
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
    await tick(40);
    expect(first.closed).not.toBeNull();
    expect(h.client.getStatus()).toBe('connecting');
    h.client.stop();
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

      await tick(15);
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

      await tick(15);
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
      await tick(15);
      const ws2 = h.current();
      ws2.emit('error', new Error("Expected HTTP 101 response but was '401 Unauthorized'"));
      ws2.emit('close', 1006);
      expect(h.client.getConnectionIssue()).toMatchObject({ kind: 'auth-failed' });
      await tick(15);
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
      await tick(15);
      const ws2 = h.current();
      ws2.emit('error', new Error('Unexpected server response: 401'));
      ws2.emit('close', 1006);
      expect(issues).toHaveLength(1); // 同类只通知一次

      h.client.stop();
      expect(h.client.getConnectionIssue()).toBeNull();
      expect(issues).toHaveLength(2);
      expect(issues[1]).toBeNull();
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
        expect.stringContaining('discarding live socket for reconnect (reason=appstate-active, pending=0)'),
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
});
