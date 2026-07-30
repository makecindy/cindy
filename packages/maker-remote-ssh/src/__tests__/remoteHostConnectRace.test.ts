/**
 * RemoteHost arm 在飞期间连接断开的竞态回归 (#715 StaleForwardArmError 路径):
 * forwardIn 的成功回调在连接死后迟到到达时,record 不得误标 armed,旧连接
 * 上的野监听必须立刻拆除,ensureRemoteForward 以 stale 错误收尾 (重连后
 * rearm 才会在新连接上重新 arm)。
 *
 * 历史:本文件原测 #778 旧实现的 "rebind 阻塞 ready" 竞态;#715 改为 rearm
 * 不阻塞 ready (session 路径自己 await ensureRemoteForward 拿 arm 错误),
 * 原断言的 connect reject 场景已不存在,改写为守护等价的迟到回调污染。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeClient extends EventEmitter {
  forwardInPending: Array<(err: Error | undefined, port: number) => void> = [];
  unforwardInCalls: Array<{ addr: string; port: number }> = [];
  ended = false;

  connect(): void {}
  forwardIn(_addr: string, _port: number, cb: (err: Error | undefined, port: number) => void): void {
    this.forwardInPending.push(cb);
  }
  unforwardIn(addr: string, port: number, cb: () => void): void {
    this.unforwardInCalls.push({ addr, port });
    cb();
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    queueMicrotask(() => this.emit('close'));
  }
  /** 模拟连接死后 ssh2 对 pending global request 的迟到回调。 */
  flushForwardIn(): void {
    const pending = this.forwardInPending.splice(0);
    for (const cb of pending) cb(undefined, 47921);
  }
}

const h = vi.hoisted(() => ({ client: null as FakeClient | null }));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    h.client = new FakeClient();
    return h.client;
  }),
}));
vi.mock('../credentials.js', () => ({
  resolveAuth: vi.fn(async () => ({ label: 'agent' })),
  defaultAgentEndpoint: vi.fn(() => ''),
}));

import { RemoteHost } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'race-host',
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

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe('RemoteHost arm/disconnect race', () => {
  it('stale forwardIn success after disconnect neither marks armed nor leaks the bind', async () => {
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });

    const connectP = host.connect();
    // doConnect 里 new Client() 在 await resolveAuth 之后,先让微任务推进。
    await flush();
    const client = h.client!;
    expect(client).toBeTruthy();
    client.emit('ready');
    // #715: ready 立即发布 (rearm 不阻塞 connect)。
    await connectP;
    expect(host.getStatus()).toBe('ready');

    // ready 后登记 forward → arm 在飞 (forwardIn pending)。
    const ensureP = host.ensureRemoteForward({
      localHost: '127.0.0.1',
      localPort: 38080,
      preferredRemotePort: 47921,
    });
    // 立即挂上 rejection 断言,避免事件驱动期间出现 unhandled rejection。
    const assertion = expect(ensureP).rejects.toThrow(/stale connection/);
    await flush();
    expect(client.forwardInPending.length).toBe(1);

    // arm 在飞期间用户断开:client 置空,status 进入 disconnected。
    await host.disconnect();
    // forwardIn 回调此时才迟到到达 (成功)。
    client.flushForwardIn();

    await assertion;
    expect(host.getStatus()).toBe('disconnected');
    // record 不得误标 armed (愿望保留,重连后 rearm 重新发起)。
    expect(host.listRemoteForwards()).toEqual([
      { localHost: '127.0.0.1', localPort: 38080, remotePort: 47921, armed: false },
    ]);
    // 旧连接上刚绑上的野监听必须立刻拆除。
    expect(client.unforwardInCalls).toContainEqual({ addr: '127.0.0.1', port: 47921 });
  });
});
