/**
 * RemoteHost remote forwarding (ssh -R 等价物) 测试。
 *
 * 用 fake ssh2 Client (EventEmitter + forwardIn/unforwardIn) 注入私有字段,
 * 本地端用真实 net server (127.0.0.1 回环) 验证字节 pipe:
 *   - 首选端口绑定 / 端口冲突顺延 / 全部失败时报错提及 AllowTcpForwarding
 *   - 'tcp connection' 分发到正确的 forward 并双向 pipe
 *   - 本地目标不可达时只断 channel 不炸进程
 *   - ensure 幂等 / close 调 unforwardIn
 *   - 断线重连 re-arm: 愿望保留、端口变化触发 onRearmed
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import net from 'node:net';

import { RemoteHost, DEFAULT_REMOTE_FORWARD_PORT_BASE } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'test-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'agent',
  source: 'manual',
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface ForwardInCall { addr: string; port: number }

type ForwardInCallback = (err: Error | undefined, port: number) => void;

/** 可按端口决定成败的 fake ssh2 Client。 */
class FakeClient extends EventEmitter {
  forwardInCalls: ForwardInCall[] = [];
  unforwardInCalls: ForwardInCall[] = [];
  /** 返回 false 的端口 forwardIn 失败 (模拟被占用 / sshd 拒绝)。 */
  constructor(private readonly allowPort: (port: number) => boolean = () => true) {
    super();
  }
  forwardIn(addr: string, port: number, cb: ForwardInCallback): void {
    this.forwardInCalls.push({ addr, port });
    queueMicrotask(() => {
      if (this.allowPort(port)) cb(undefined, port);
      else cb(new Error('Unable to bind'), 0);
    });
  }
  unforwardIn(addr: string, port: number, cb: () => void): void {
    this.unforwardInCalls.push({ addr, port });
    queueMicrotask(() => cb());
  }
}

/** forwardIn 回调完全手动驱动的 fake — 用来造在飞 / 迟到回调的竞态场景。 */
class ManualForwardClient extends EventEmitter {
  pending = new Map<number, ForwardInCallback>();
  unforwardInCalls: ForwardInCall[] = [];
  forwardIn(_addr: string, port: number, cb: ForwardInCallback): void {
    this.pending.set(port, cb);
  }
  unforwardIn(addr: string, port: number, cb: () => void): void {
    this.unforwardInCalls.push({ addr, port });
    queueMicrotask(() => cb());
  }
  succeed(port: number): void {
    const cb = this.pending.get(port);
    this.pending.delete(port);
    cb?.(undefined, port);
  }
}

interface FakeChannelBundle {
  channel: Duplex & { close: () => void };
  /** test 写入 → channel readable → 本地 sock (模拟远端发来的字节)。 */
  fromRemote: PassThrough;
  /** 本地 sock 写入 → test 读出 (模拟要送回远端的字节)。 */
  toRemote: PassThrough;
  closed: () => boolean;
}

function makeFakeChannel(): FakeChannelBundle {
  const fromRemote = new PassThrough();
  const toRemote = new PassThrough();
  let closed = false;
  // 手工拼 Duplex (@types/node 没有 {readable,writable} pair overload 的类型):
  // readable 侧由 fromRemote 推, writable 侧落进 toRemote 供断言。
  const channel = new Duplex({
    read() {},
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      if (toRemote.write(chunk)) cb();
      else toRemote.once('drain', () => cb());
    },
  }) as Duplex & { close: () => void };
  fromRemote.on('data', (chunk: Buffer) => channel.push(chunk));
  fromRemote.on('end', () => channel.push(null));
  channel.close = () => {
    if (closed) return;
    closed = true;
    channel.destroy();
  };
  return { channel, fromRemote, toRemote, closed: () => closed };
}

/** makeReadyHost 接受的最小 fake client 面 (FakeClient / ManualForwardClient 共用)。 */
interface FakeSshClient extends EventEmitter {
  forwardIn(addr: string, port: number, cb: ForwardInCallback): void;
  unforwardIn(addr: string, port: number, cb: () => void): void;
}

function makeReadyHost(client: FakeSshClient): RemoteHost {
  const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
  (host as unknown as { status: string }).status = 'ready';
  (host as unknown as { client: unknown }).client = client;
  return host;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

/** 起一个在 127.0.0.1 随机端口的 echo server, 返回端口与关闭函数。 */
async function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => sock.pipe(sock));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('RemoteHost remote forwarding', () => {
  it('arms forwardIn on the preferred port and lists it as armed', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE);
    expect(client.forwardInCalls).toEqual([
      { addr: '127.0.0.1', port: DEFAULT_REMOTE_FORWARD_PORT_BASE },
    ]);
    expect(host.listRemoteForwards()).toEqual([
      {
        localHost: '127.0.0.1',
        localPort: 7890,
        remotePort: DEFAULT_REMOTE_FORWARD_PORT_BASE,
        armed: true,
      },
    ]);
  });

  it('falls back to the next candidate port when the preferred one is taken', async () => {
    const client = new FakeClient((port) => port !== DEFAULT_REMOTE_FORWARD_PORT_BASE);
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    expect(client.forwardInCalls.map((c) => c.port)).toEqual([
      DEFAULT_REMOTE_FORWARD_PORT_BASE,
      DEFAULT_REMOTE_FORWARD_PORT_BASE + 1,
    ]);
  });

  it('throws an actionable error when every candidate port fails', async () => {
    const client = new FakeClient(() => false);
    const host = makeReadyHost(client);
    await expect(
      host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 }),
    ).rejects.toThrow(/AllowTcpForwarding/);
  });

  it('rejects invalid local targets before touching ssh', async () => {
    const host = makeReadyHost(new FakeClient());
    await expect(
      host.ensureRemoteForward({ localHost: 'bad host', localPort: 7890 }),
    ).rejects.toThrow(/localHost/);
    await expect(
      host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 0 }),
    ).rejects.toThrow(/localPort/);
    // preferredRemotePort 同样入口校验: 0 会静默变成远端 ephemeral 绑端口语义
    // (review: PR #715 copilot R7)。
    await expect(
      host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890, preferredRemotePort: 0 }),
    ).rejects.toThrow(/preferredRemotePort/);
    await expect(
      host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890, preferredRemotePort: 70000 }),
    ).rejects.toThrow(/preferredRemotePort/);
    // localHost 的引号与空白同样拒 (与 desktop IPC / prefs-store 对齐,
    // review: PR #715 copilot R8) — 否则晚到 net.connect 才以难懂的错误失败。
    await expect(
      host.ensureRemoteForward({ localHost: `12'7.0.0.1`, localPort: 7890 }),
    ).rejects.toThrow(/localHost/);
    await expect(
      host.ensureRemoteForward({ localHost: '12"7.0.0.1', localPort: 7890 }),
    ).rejects.toThrow(/localHost/);
  });

  it('is idempotent for the same local target (no duplicate forwardIn)', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    const a = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    const b = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    expect(a.remotePort).toBe(b.remotePort);
    expect(client.forwardInCalls).toHaveLength(1);
  });

  it('pipes a forwarded connection to the local target and back', async () => {
    const echo = await startEchoServer();
    try {
      const client = new FakeClient();
      const host = makeReadyHost(client);
      const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: echo.port });

      const fake = makeFakeChannel();
      client.emit(
        'tcp connection',
        { srcIP: '127.0.0.1', srcPort: 55000, destIP: '127.0.0.1', destPort: fwd.remotePort },
        () => fake.channel,
        () => { throw new Error('unexpected reject'); },
      );
      fake.fromRemote.write('ping-through-tunnel');
      await flush();

      // echo server 原样弹回 → 应出现在要送回远端的流里。
      expect(fake.toRemote.read()?.toString()).toBe('ping-through-tunnel');
      fake.channel.close();
    } finally {
      await echo.close();
    }
  });

  it('closes the channel (no crash) when the local target is unreachable', async () => {
    // 先占一个端口再释放, 拿到一个几乎必然拒连的端口。
    const probe = await startEchoServer();
    const deadPort = probe.port;
    await probe.close();

    const client = new FakeClient();
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: deadPort });

    const fake = makeFakeChannel();
    client.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 55001, destIP: '127.0.0.1', destPort: fwd.remotePort },
      () => fake.channel,
      () => { throw new Error('unexpected reject'); },
    );
    // ECONNREFUSED 是异步的; 等它发生。
    await flush();
    expect(fake.closed()).toBe(true);
  });

  it('rejects connections to unknown destPorts', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    let rejected = false;
    client.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 55002, destIP: '127.0.0.1', destPort: 1 },
      () => { throw new Error('unexpected accept'); },
      () => { rejected = true; },
    );
    expect(rejected).toBe(true);
  });

  it('rejects forwarded connections from non-loopback sources (fail-closed, PR #715 copilot)', async () => {
    // 远端 sshd 配了 permissive GatewayPorts 时, 隧道口绑到非 loopback 接口,
    // 远端网络的任意机器都能经隧道借用本机 Proxy — 只接受 loopback 来源
    // (远端 daemon 与 sshd 同机, 合法来源恒为 loopback)。
    const client = new FakeClient();
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    let rejected = false;
    client.emit(
      'tcp connection',
      { srcIP: '192.168.1.50', srcPort: 55003, destIP: '192.168.1.10', destPort: fwd.remotePort },
      () => { throw new Error('unexpected accept'); },
      () => { rejected = true; },
    );
    expect(rejected).toBe(true);
  });

  it('close() unforwards on the live client and drops the record', async () => {
    const client = new FakeClient();
    const host = makeReadyHost(client);
    const fwd = await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    await fwd.close();

    expect(client.unforwardInCalls).toEqual([
      { addr: '127.0.0.1', port: DEFAULT_REMOTE_FORWARD_PORT_BASE },
    ]);
    expect(host.listRemoteForwards()).toEqual([]);
  });

  it('re-arms on reconnect and reports a changed port via onRearmed', async () => {
    const client1 = new FakeClient();
    const host = makeReadyHost(client1);
    let rearmed: number | null = null;
    const fwd = await host.ensureRemoteForward({
      localHost: '127.0.0.1',
      localPort: 7890,
      onRearmed: (port) => { rearmed = port; },
    });
    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE);

    // 模拟断线重连: 标记 disarm (handlePostReadyClose 路径) 并换上新 client,
    // 新连接上原端口已被别人占 → 应顺延并回调 onRearmed。
    (host as unknown as { markForwardsDisarmed(): void }).markForwardsDisarmed();
    const client2 = new FakeClient((port) => port !== DEFAULT_REMOTE_FORWARD_PORT_BASE);
    (host as unknown as { client: unknown }).client = client2;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();

    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    expect(rearmed).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    expect(host.listRemoteForwards()[0]?.armed).toBe(true);
  });

  it('re-arm prefers the last bound port (no churn / no onRearmed when it is still free)', async () => {
    // 首轮 base 被占 → 绑到 base+1; 重连后 base 已空闲, 仍应留在 base+1
    // (远端 daemon env / marker 指向它, 端口 churn 会触发无谓的 env 重写)。
    const client1 = new FakeClient((port) => port !== DEFAULT_REMOTE_FORWARD_PORT_BASE);
    const host = makeReadyHost(client1);
    let rearmed: number | null = null;
    const fwd = await host.ensureRemoteForward({
      localHost: '127.0.0.1',
      localPort: 7890,
      onRearmed: (port) => { rearmed = port; },
    });
    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);

    (host as unknown as { markForwardsDisarmed(): void }).markForwardsDisarmed();
    const client2 = new FakeClient(() => true); // 全部空闲
    (host as unknown as { client: unknown }).client = client2;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();

    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    expect(rearmed).toBeNull();
    expect(client2.forwardInCalls.map((c) => c.port)).toEqual([DEFAULT_REMOTE_FORWARD_PORT_BASE + 1]);
  });

  it('unbinds a late forwardIn success that races the 10s watchdog', async () => {
    vi.useFakeTimers();
    try {
      const client = new ManualForwardClient();
      const host = makeReadyHost(client);
      const pending = host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
      // 第一个候选卡在在飞状态; 看门狗 10s 后判失败, 转下一候选。
      await vi.advanceTimersByTimeAsync(10_100);
      expect(client.pending.has(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1)).toBe(true);
      // 迟到的成功: 必须立刻 unbind, 不能在服务端留下野监听。
      client.succeed(DEFAULT_REMOTE_FORWARD_PORT_BASE);
      expect(client.unforwardInCalls).toContainEqual({
        addr: '127.0.0.1',
        port: DEFAULT_REMOTE_FORWARD_PORT_BASE,
      });
      client.succeed(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
      const fwd = await pending;
      expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unbinds the just-bound port when close() races an in-flight arm', async () => {
    const client = new ManualForwardClient();
    const host = makeReadyHost(client);
    const pending = host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    pending.catch(() => { /* assertion below via rejects */ });
    // arm 在飞 (forwardIn 未回调) 时关掉 forward。
    await host.closeAllRemoteForwards();
    expect(host.listRemoteForwards()).toEqual([]);
    // 迟到的绑定成功: record 已摘除, 必须 unbind 而不是留野监听。
    client.succeed(DEFAULT_REMOTE_FORWARD_PORT_BASE);
    await expect(pending).rejects.toThrow(/closed while arming/);
    await flush();
    expect(client.unforwardInCalls).toContainEqual({
      addr: '127.0.0.1',
      port: DEFAULT_REMOTE_FORWARD_PORT_BASE,
    });
  });

  it('re-arms on the current connection when forwardIn resolves on a stale one (review P1)', async () => {
    // arm 在飞期间断线/重连: 旧 client 的迟到成功不得把隧道误标 armed —
    // 应在旧 client 上 unbind 并在当前连接上重试。
    const client1 = new ManualForwardClient();
    const client2 = new ManualForwardClient();
    const host = makeReadyHost(client1);
    const pending = host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    // 断线/重连窗口: markForwardsDisarmed 清掉在飞 arm 引用, client 换成新连接。
    (host as unknown as { markForwardsDisarmed(): void }).markForwardsDisarmed();
    (host as unknown as { client: unknown }).client = client2;
    // 旧连接迟到成功 → StaleForwardArmError → armWithStaleRetry 立即在 client2 重试。
    client1.succeed(DEFAULT_REMOTE_FORWARD_PORT_BASE);
    await flush();
    expect(client1.unforwardInCalls).toContainEqual({
      addr: '127.0.0.1',
      port: DEFAULT_REMOTE_FORWARD_PORT_BASE,
    });
    // 重试落在 client2 上, 完成绑定。
    expect(client2.pending.has(DEFAULT_REMOTE_FORWARD_PORT_BASE)).toBe(true);
    client2.succeed(DEFAULT_REMOTE_FORWARD_PORT_BASE);
    const fwd = await pending;
    expect(fwd.remotePort).toBe(DEFAULT_REMOTE_FORWARD_PORT_BASE);
    expect(host.listRemoteForwards()[0]?.armed).toBe(true);
  });

  it('clears the forward listener client on disconnect; a new client re-attaches (review R3)', async () => {
    // forwardListenerClient 不清会让 RemoteHost 长期持有死 client (抑制 GC +
    // 多次重连后旧 client listener 堆积); 断连后必须置空, 新连接 arm 时重挂。
    const client1 = new FakeClient();
    const host = makeReadyHost(client1);
    await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    expect(client1.listenerCount('tcp connection')).toBe(1);

    (host as unknown as { markForwardsDisarmed(): void }).markForwardsDisarmed();
    expect((host as unknown as { forwardListenerClient: unknown }).forwardListenerClient).toBeNull();

    const client2 = new FakeClient();
    (host as unknown as { client: unknown }).client = client2;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();
    expect(client2.listenerCount('tcp connection')).toBe(1);
    expect((host as unknown as { forwardListenerClient: unknown }).forwardListenerClient).toBe(client2);
  });

  it('keeps the wish when re-arm fails, without throwing (logged only)', async () => {
    const client1 = new FakeClient();
    const host = makeReadyHost(client1);
    await host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });

    (host as unknown as { markForwardsDisarmed(): void }).markForwardsDisarmed();
    const client2 = new FakeClient(() => false);
    (host as unknown as { client: unknown }).client = client2;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();

    const listed = host.listRemoteForwards();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.armed).toBe(false);
  });

  it('defers arming until connect when the host is not ready', async () => {
    const client = new FakeClient();
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
    // disconnected 状态: 只登记愿望, 不碰 ssh。
    const fwdPromise = host.ensureRemoteForward({ localHost: '127.0.0.1', localPort: 7890 });
    await expect(fwdPromise).resolves.toBeDefined();
    expect(client.forwardInCalls).toHaveLength(0);

    // 连接建立 → doConnect onReady 路径的 rearmForwards 把它挂上。
    (host as unknown as { status: string }).status = 'ready';
    (host as unknown as { client: unknown }).client = client;
    await (host as unknown as { rearmForwards(): Promise<void> }).rearmForwards();
    expect(client.forwardInCalls).toHaveLength(1);
  });
});
