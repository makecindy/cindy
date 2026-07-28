/**
 * DeviceLinkClient 状态机单测:fake WebSocket 注入,覆盖
 * 握手 / 请求配对 / 超时 / relay-error / 重连退避 / 心跳僵死 / token 缺失。
 */
import { describe, it, expect, vi } from 'vitest';
import { DeviceLinkClient, type WsLike } from '../client.js';
import { PROTOCOL_VERSION, DeviceLinkError, type Envelope } from '../protocol.js';

type Handler = (...args: unknown[]) => void;

/** 可编程 fake socket:记录发出的帧,可注入入站帧/关闭事件 */
class FakeWs implements WsLike {
  sent: Envelope[] = [];
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
