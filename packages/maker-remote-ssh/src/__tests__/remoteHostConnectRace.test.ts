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
  connectConfig: { hostVerifier?: (key: Buffer, verify: (valid: boolean) => void) => void } | null = null;

  connect(config?: { hostVerifier?: (key: Buffer, verify: (valid: boolean) => void) => void }): void {
    this.connectConfig = config ?? null;
  }
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

const h = vi.hoisted(() => ({
  client: null as FakeClient | null,
  resolveAuth: vi.fn(async () => ({ label: 'agent' })),
  createClient: vi.fn(),
  hostKeyId: vi.fn((hostname: string, port: number) => `${hostname}:${port}`),
}));

vi.mock('ssh2', () => ({
  Client: h.createClient.mockImplementation(() => {
    h.client = new FakeClient();
    return h.client;
  }),
}));
vi.mock('../credentials.js', () => ({
  resolveAuth: h.resolveAuth,
  defaultAgentEndpoint: vi.fn(() => ''),
}));
vi.mock('../hostKeys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hostKeys.js')>();
  return { ...actual, hostKeyId: h.hostKeyId };
});

import { RemoteHost } from '../RemoteHost.js';
import type { HostKeyStore } from '../hostKeys.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'race-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'agent',
  source: 'manual',
  managedByCindy: false,
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
  it('stops at the authentication guard before SSH transport or TOFU', async () => {
    h.client = null;
    h.createClient.mockClear();
    h.hostKeyId.mockClear();
    const unsupported = new Error('unsupported HostName token') as Error & { code?: string };
    unsupported.code = 'SSH_CONFIG_AUTH_UNSUPPORTED';
    h.resolveAuth.mockRejectedValueOnce(unsupported);
    const store: HostKeyStore = {
      reload: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
    };
    const host = new RemoteHost({
      ...HOST_CONFIG,
      sshAuthentication: {
        identitiesOnly: false,
        configuredIdentityFiles: [],
        identityFileDirectiveSeen: false,
        identityFileNoneSeen: false,
        unsupportedReason: 'unsupported HostName token: %n',
      },
    }, { logger: noopLogger, hostKeys: store });

    await expect(host.connect()).rejects.toMatchObject({
      code: 'SSH_CONFIG_AUTH_UNSUPPORTED',
    });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.hostKeyId).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

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

  it('disconnect during credential resolution does not create an SSH client later', async () => {
    h.client = null;
    let finishAuth!: (value: { label: string }) => void;
    h.resolveAuth.mockImplementationOnce(() => new Promise((resolve) => {
      finishAuth = resolve;
    }));
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });

    const connectP = host.connect();
    await Promise.resolve();
    expect(host.getStatus()).toBe('connecting');

    await host.disconnect();
    finishAuth({ label: 'agent' });

    await expect(connectP).rejects.toThrow('SSH connection attempt cancelled');
    expect(h.client).toBeNull();
    expect(host.getStatus()).toBe('disconnected');
  });

  it('disconnect wakes concurrent connect joiners while credential resolution is still in flight', async () => {
    h.client = null;
    let finishAuth!: (value: { label: string }) => void;
    h.resolveAuth.mockImplementationOnce(() => new Promise((resolve) => {
      finishAuth = resolve;
    }));
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });

    const first = host.connect();
    const joiner = host.connect();
    await Promise.resolve();
    await host.disconnect();
    finishAuth({ label: 'agent' });

    await expect(first).rejects.toThrow('SSH connection attempt cancelled');
    await expect(joiner).rejects.toThrow();
    expect(host.getStatus()).toBe('disconnected');
  });

  it('reports locally verified key changes and clears recovery on endpoint change', async () => {
    const store: HostKeyStore = {
      reload: vi.fn(), get: vi.fn(async () => 'SHA256:trusted'), set: vi.fn(),
    };
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger, hostKeys: store });
    const connecting = host.connect();
    const rejection = expect(connecting).rejects.toThrow('SSH host key changed');
    await flush();
    const client = h.client!;
    const accepted = await new Promise<boolean>((resolve) => {
      client.connectConfig!.hostVerifier!(Buffer.from('replacement-key'), resolve);
    });
    expect(accepted).toBe(false);
    client.emit('error', new Error('Host denied (verification failed)'));
    await rejection;
    expect(host.snapshot().hostKeyMismatch).toEqual({
      host: `${HOST_CONFIG.hostname}:${HOST_CONFIG.port}`,
      trusted: 'SHA256:trusted', presented: expect.stringMatching(/^SHA256:/),
    });
    expect(host.snapshot().lastError).toContain('~/.ssh/known_hosts');
    expect(store.set).not.toHaveBeenCalled();
    client.emit('close');
    expect(host.getStatus()).toBe('failed');
    host.updateConfig({ ...HOST_CONFIG, hostname: 'changed.example' });
    expect(host.snapshot().hostKeyMismatch).toBeUndefined();
    await host.disconnect();
  });

  it('stops a scheduled reconnect when the server key has changed', async () => {
    const store: HostKeyStore = { reload: vi.fn(), get: vi.fn(async () => 'SHA256:old'), set: vi.fn() };
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger, hostKeys: store });
    const connecting = host.connect();
    await flush();
    h.client!.emit('ready');
    await connecting;
    vi.useFakeTimers();
    try {
      h.client!.emit('close');
      expect(host.getStatus()).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1000);
      const client = h.client!;
      await new Promise<boolean>((resolve) => client.connectConfig!.hostVerifier!(Buffer.from('new-key'), resolve));
      client.emit('error', new Error('Host denied (verification failed)'));
      client.emit('close');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.getStatus()).toBe('failed');
      expect(h.client).toBe(client);
      expect(host.snapshot().hostKeyMismatch).toBeDefined();
    } finally {
      await host.disconnect();
      vi.useRealTimers();
    }
  });

  it('a stale host verifier cannot persist trust or write errors for a replacement endpoint', async () => {
    let finishGet!: (fingerprint: string | null) => void;
    const store: HostKeyStore = {
      reload: vi.fn(),
      get: vi.fn(() => new Promise<string | null>((resolve) => { finishGet = resolve; })),
      set: vi.fn(async () => undefined),
    };
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger, hostKeys: store });
    const connectP = host.connect();
    const connectAssertion = expect(connectP).rejects.toThrow('SSH connection attempt cancelled');
    await flush();
    const client = h.client!;
    const verifier = client.connectConfig?.hostVerifier;
    expect(verifier).toBeTypeOf('function');
    const verdict = new Promise<boolean>((resolve) => {
      verifier!(Buffer.from('old-server-key'), resolve);
    });
    await Promise.resolve();

    await host.disconnect();
    host.updateConfig({ ...HOST_CONFIG, hostname: '10.0.0.99', port: 2222 });
    finishGet(null);

    await expect(verdict).resolves.toBe(false);
    await connectAssertion;
    expect(store.set).not.toHaveBeenCalled();
    expect(host.snapshot().lastError).toBeUndefined();
  });

  it('a server rekey after ready keeps the host ready and connect() resolves (#5715)', async () => {
    h.client = null;
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });

    const connectP = host.connect();
    await flush();
    const client = h.client!;
    expect(client).toBeTruthy();
    // First key exchange of the attempt still advances to authenticating.
    client.emit('handshake');
    expect(host.getStatus()).toBe('authenticating');
    client.emit('ready');
    await connectP;
    expect(host.getStatus()).toBe('ready');
    const clientsBefore = h.createClient.mock.calls.length;

    // ssh2 emits 'handshake' again for every later key exchange (Dropbear
    // rekeys every 8h) and never re-emits 'ready'.
    client.emit('handshake');
    expect(host.getStatus()).toBe('ready');

    // Before the fix these joined waitForTerminal() with no attempt in
    // flight and hung until a manual disconnect.
    const joined = Promise.all([host.connect(), host.connect()]);
    const timedOut = new Promise((_, reject) => setTimeout(() => reject(new Error('connect hung after rekey')), 500));
    await expect(Promise.race([joined, timedOut])).resolves.toBeDefined();
    expect(host.getStatus()).toBe('ready');
    expect(h.createClient.mock.calls.length).toBe(clientsBefore);
    expect(client.ended).toBe(false);
  });

  it('disconnect before SSH ready invalidates late client events', async () => {
    h.client = null;
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });

    const connectP = host.connect();
    await flush();
    const client = h.client!;
    expect(client).toBeTruthy();

    await host.disconnect();
    client.emit('ready');

    await expect(connectP).rejects.toThrow('SSH connection attempt cancelled');
    expect(client.ended).toBe(true);
    expect(host.getStatus()).toBe('disconnected');
  });
});
