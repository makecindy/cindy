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
import type { ClientChannel } from 'ssh2';

class FakeShellChannel extends EventEmitter {
  stderr = new EventEmitter();
  writableLength = 0;
  write = vi.fn((_data: string) => true);
  close = vi.fn(() => { this.emit('close'); });
  setWindow = vi.fn();
}

class FakeClient extends EventEmitter {
  shellPending: Array<(err: Error | undefined, channel: ClientChannel) => void> = [];
  shellOptions: unknown;
  shell(options: unknown, callback: (err: Error | undefined, channel: ClientChannel) => void): void {
    this.shellOptions = options;
    this.shellPending.push(callback);
  }
  forwardInPending: Array<(err: Error | undefined, port: number) => void> = [];
  unforwardInCalls: Array<{ addr: string; port: number }> = [];
  ended = false;
  connectConfig: { tryKeyboard?: boolean; readyTimeout?: number; hostVerifier?: (key: Buffer, verify: (valid: boolean) => void) => void } | null = null;

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
import type { KeyboardInteractiveHandler } from '../keyboardInteractive.js';

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

async function interactiveHost(handler?: KeyboardInteractiveHandler) {
  h.client = null;
  const store: HostKeyStore = { reload: vi.fn(), get: vi.fn(async () => null), set: vi.fn(async () => {}) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const host = new RemoteHost(HOST_CONFIG, { logger, hostKeys: store, keyboardInteractive: handler });
  const connecting = host.connect();
  await Promise.resolve(); await Promise.resolve();
  const client = h.client!;
  const verify = () => new Promise<boolean>(resolve => client.connectConfig!.hostVerifier!(Buffer.from('test-key'), resolve));
  const prompt = (finish: (answers: string[]) => void, prompts = [{ prompt: 'Code', echo: false }]) =>
    client.emit('keyboard-interactive', 'MFA', 'Enter code', '', prompts, finish);
  return { host, connecting, client, logger, verify, prompt };
}

// Test value: RemoteHost.execPty is the public production entry for the real
// JumpServer "No PTY requested" failure. Existing exec/forward/OTP coverage
// cannot exercise shell handshakes, framing, or late shell callbacks. unit tier:
// smallest inputs are an echoed handshake, a split result, and a missing nonce.
describe('RemoteHost PTY command transport', () => {
  async function readyHost() {
    const fixture = await interactiveHost();
    await fixture.verify();
    fixture.client.emit('ready');
    await fixture.connecting;
    return fixture;
  }
  async function attach(client: FakeClient) {
    const channel = new FakeShellChannel();
    client.shellPending.shift()!(undefined, channel as unknown as ClientChannel);
    await Promise.resolve(); await Promise.resolve();
    const wire = channel.write.mock.calls[0][0] as unknown as string;
    const nonce = /([0-9a-f]{32})_READY/.exec(wire)![1];
    return { channel, wire, nonce };
  }
  function proveShell(channel: FakeShellChannel, nonce: string) {
    channel.emit('data', Buffer.from(String(channel.write.mock.calls[0][0])));
    channel.emit('data', Buffer.from('\x1e' + nonce + '_READY\x1f'));
    const commandLine = channel.write.mock.calls[2]?.[0];
    if (commandLine !== undefined) channel.emit('data', Buffer.from(String(commandLine)));
  }
  // PR #7184: stdin was reversibly embedded in the audited command and a failed
  // decoder still ran it. Nonempty input must fail before opening any PTY.
  it('rejects private stdin before opening a shell or executing a command', async () => {
    const { host, client } = await readyHost();
    try {
      const result = host.execPty('never-execute', { input: 'FAKE-PRIVATE-INPUT' });
      const rejected = expect(result).rejects.toThrow('PTY command transport does not support stdin input.');
      if (client.shellPending.length) { const { channel } = await attach(client); channel.emit('close'); }
      await rejected;
      expect(client.shellPending).toHaveLength(0);
    } finally { await host.disconnect(); }
  });
  // PR #7184: repeated quoting expanded a valid <64KiB command beyond the real
  // openPtyShell queue cap. This uses that production writer, not a copied limit.
  it('executes a quote-heavy command within the advertised raw size limit', async () => {
    const { host, client } = await readyHost();
    try {
      const result = host.execPty('printf x ' + "''".repeat(20 * 1024));
      const outcome = result.then(value => ({ value }), error => ({ error: error.message }));
      const { channel, nonce } = await attach(client);
      proveShell(channel, nonce);
      channel.emit('data', Buffer.from('\x1e' + nonce + '_START\x1fx\x1e' + nonce + '_EXIT:0\x1f'));
      await expect(outcome).resolves.toMatchObject({ value: { stdout: 'x', exitCode: 0 } });
    } finally { await host.disconnect(); }
  });
  it('rejects an oversized encoded command and environment before opening a shell', async () => {
    const { host, client } = await readyHost();
    try {
      await expect(host.execPty('never-execute', { env: { CINDY_FAKE_VALUE: 'x'.repeat(300_000) } }))
        .rejects.toThrow('PTY encoded command and environment exceed the terminal input limit.');
      expect(client.shellPending).toHaveLength(0);
    } finally { await host.disconnect(); }
  });
  it('sends the command only after shell proof and returns framed Unicode output and nonzero exit', async () => {
    const { host, client } = await readyHost();
    try {
      const result = host.execPty('printf visible-command');
      const { channel, wire, nonce } = await attach(client);
      expect(client.shellOptions).toMatchObject({ term: 'xterm-256color', cols: 80, rows: 24 });
      channel.emit('data', Buffer.from('FAKE-LOGIN-BANNER\r\n' + wire));
      expect(channel.write).toHaveBeenCalledTimes(2);
      expect(channel.write.mock.calls[1][0]).toBe('\r');
      expect(wire).not.toContain('visible-command');
      channel.emit('data', Buffer.from('\x1e' + nonce + '_READY\x1f'));
      expect(channel.write).toHaveBeenCalledTimes(3);
      const commandLine = String(channel.write.mock.calls[2][0]);
      expect(commandLine).toContain('visible-command');
      expect(commandLine).not.toMatch(/[\r\n]/);
      channel.emit('data', Buffer.from(commandLine));
      expect(channel.write).toHaveBeenCalledTimes(4);
      expect(channel.write.mock.calls[3][0]).toBe('\r');
      const bytes = Buffer.from('FAKE-COMMAND-ECHO\x1e' + nonce + '_START\x1f中文\nerror\n\x1e' + nonce + '_EXIT:7\x1f');
      for (const byte of bytes) channel.emit('data', Buffer.from([byte]));
      await expect(result).resolves.toEqual({ stdout: '中文\nerror\n', stderr: '', exitCode: 7, signal: null, stderrMerged: true });
      expect(channel.close).toHaveBeenCalled();
    } finally { await host.disconnect(); }
  });
  it('caps a flooding output before buffering it and invalidates its exit result', async () => {
    const { host, client } = await readyHost();
    try {
      const result = host.execPty('yes', { maxOutputBytes: 16 });
      const { channel, nonce } = await attach(client);
      proveShell(channel, nonce);
      channel.emit('data', Buffer.from('\x1e' + nonce + '_START\x1f' + 'a'.repeat(4096)));
      await expect(result).resolves.toMatchObject({ stdout: 'a'.repeat(16), truncated: true, exitCode: null });
      expect(channel.close).toHaveBeenCalled();
    } finally { await host.disconnect(); }
  });
  // Bastion regression: wrap padding split the echo nonce, and
  // an outer exit closed the bastion channel before its result footer arrived.
  // Existing fixtures echo unpadded text and flush results before closing.
  // unit: execPty must return exit 7 for a padded marker / delayed footer.
  it.each(['handshake-padding', 'command-padding', 'early-exit'] as const)(
    'waits for a verified result with %s', async failure => {
      const { host, client } = await readyHost();
      vi.useFakeTimers();
      try {
        const outcome = host.execPty('exit 7', { timeoutMs: 1000 }).then(
          value => ({ value }), error => ({ error: error.message }),
        );
        const { channel, wire, nonce } = await attach(client);
        const pad = (line: string, marker: string) =>
          line.replace(marker, marker.slice(0, 16) + ' \r' + marker.slice(16));
        const writeCount = () => channel.write.mock.calls.length;
        channel.emit('data', Buffer.from(failure === 'handshake-padding'
          ? pad(wire, nonce + '_HANDSHAKE_INPUT') : wire));
        if (failure !== 'handshake-padding') expect(channel.write.mock.calls).toHaveLength(2);
        // A shell executes each line only when the client sends Enter after echo.
        if (writeCount() === 2) {
          channel.emit('data', Buffer.from('\x1e' + nonce + '_READY\x1f'));
          const commandLine = String(channel.write.mock.calls[2][0]);
          channel.emit('data', Buffer.from(failure === 'command-padding'
            ? pad(commandLine, nonce + '_COMMAND_INPUT') : commandLine));
          if (writeCount() === 4) {
            channel.emit('data', Buffer.from('\x1e' + nonce + '_START\x1fmargin-ok'));
            // Model the observed bastion ordering: outer exit closes before
            // buffered footer delivery; without exit, deliver it on the next turn.
            if (failure === 'early-exit' && /;\s*exit\s*#/.test(commandLine)) {
              channel.emit('close');
            } else {
              await Promise.resolve();
              channel.emit('data', Buffer.from('\x1e' + nonce + '_EXIT:7\x1f'));
            }
          }
        }
        await vi.advanceTimersByTimeAsync(1000);
        await expect(outcome).resolves.toMatchObject({ value: { stdout: 'margin-ok', exitCode: 7 } });
        expect(channel.close).toHaveBeenCalled();
      } finally { await host.disconnect(); vi.useRealTimers(); }
    },
  );
  it('rejects non-shell responses without sending the command or exposing banners', async () => {
    const { host, client } = await readyHost();
    try {
      const result = host.execPty('never-execute');
      const rejection = expect(result).rejects.toThrow('PTY command did not return a verified result');
      const { channel } = await attach(client);
      channel.emit('data', Buffer.from('No PTY requested. FAKE-PRIVATE-BANNER'));
      channel.emit('close');
      await rejection;
      expect(channel.write).toHaveBeenCalledTimes(1);
    } finally { await host.disconnect(); }
  });
  it.each(['timeout', 'disconnect'] as const)('closes a late shell channel after %s', async reason => {
    vi.useFakeTimers();
    const { host, client } = await readyHost();
    try {
      const result = host.execPty('never-execute', { timeoutMs: 1000 });
      const rejection = expect(result).rejects.toThrow();
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(1000);
      else await host.disconnect();
      await rejection;
      const channel = new FakeShellChannel();
      client.shellPending.shift()!(undefined, channel as unknown as ClientChannel);
      expect(channel.close).toHaveBeenCalledOnce();
      expect(channel.write).not.toHaveBeenCalled();
    } finally { await host.disconnect(); vi.useRealTimers(); }
  });
  it.each(['missing-footer', 'invalid-footer', 'server-error'] as const)(
    'does not return unverified output or replay the command after %s', async failure => {
      const { host, client } = await readyHost();
      try {
        const result = host.execPty('run-once');
        const rejection = expect(result).rejects.toThrow('PTY command did not return a verified result');
        const { channel, nonce } = await attach(client);
        proveShell(channel, nonce);
        channel.emit('data', Buffer.from('\x1e' + nonce + '_START\x1fFAKE-PRIVATE-PARTIAL'));
        if (failure === 'missing-footer') channel.emit('close');
        if (failure === 'invalid-footer') channel.emit('data', Buffer.from('\x1e' + nonce + '_EXIT:999\x1f'));
        if (failure === 'server-error') channel.emit('error', new Error('FAKE-PRIVATE-PARTIAL'));
        await rejection;
        expect(channel.write).toHaveBeenCalledTimes(4);
        expect(client.shellPending).toHaveLength(0);
      } finally { await host.disconnect(); }
    },
  );
});

describe('RemoteHost keyboard-interactive authentication', () => {
  it('redacts post-ready server errors and requests fresh input after reconnect', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => ['FAKE-OTP']);
    const { host, connecting, client, logger, verify, prompt } = await interactiveHost(handler);
    try {
      await verify();
      prompt(() => client.emit('ready'));
      await connecting;
      client.emit('error', new Error('FAKE-OTP echoed after ready'));
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('FAKE-OTP');
      expect(host.snapshot().lastError).toBe('SSH connection interrupted.');
      client.emit('close');
      expect(host.getStatus()).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1000);
      const next = h.client!;
      expect(next).not.toBe(client);
      await new Promise<boolean>(resolve => next.connectConfig!.hostVerifier!(Buffer.from('test-key'), resolve));
      next.emit('keyboard-interactive', 'MFA', 'Enter code', '', [{ prompt: 'Code', echo: false }], () => next.emit('ready'));
      await Promise.resolve(); await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(host.getStatus()).toBe('ready');
    } finally { await host.disconnect(); vi.useRealTimers(); }
  });
  // PR #7184: only real local input extends dependent waiters. Observe the real
  // entry's input deadlines across six rounds and server gaps (unit/fake time).
  it('allows six slow authentication rounds, clears answers, and reaches ready', async () => {
    vi.useFakeTimers();
    let respond!: (answers: string[]) => void;
    let signal!: AbortSignal;
    const handler = vi.fn((_challenge, abort: AbortSignal) => { signal = abort; return new Promise<string[]>(resolve => { respond = resolve; }); });
    const { host, connecting, client, verify, prompt } = await interactiveHost(handler);
    const input = vi.fn();
    const offInput = host.onInteractiveAuthentication(input);
    try {
      expect(await verify()).toBe(true);
      expect(client.connectConfig).toMatchObject({ tryKeyboard: true, readyTimeout: 0 });
      const received: string[][] = [];
      const settled = vi.fn();
      void connecting.then(settled, settled);
      await vi.advanceTimersByTimeAsync(19_000);
      for (let round = 0; round < 6; round++) {
        prompt(answers => {
          expect(input).toHaveBeenLastCalledWith(null);
          received.push([...answers]);
        });
        expect(input).toHaveBeenLastCalledWith(Date.now() + 120_000);
        await vi.advanceTimersByTimeAsync(119_000);
        const answers = ['FAKE-OTP']; respond(answers);
        await vi.advanceTimersByTimeAsync(19_000);
        expect(answers).toEqual(['']);
        expect(settled).not.toHaveBeenCalled();
      }
      client.emit('ready');
      await connecting;
      expect(received).toEqual(Array.from({ length: 6 }, () => ['FAKE-OTP']));
      expect(signal.aborted).toBe(true);
      expect(host.getStatus()).toBe('ready');
      expect(input).toHaveBeenLastCalledWith(null);
    } finally { offInput(); await host.disconnect(); vi.useRealTimers(); }
  });

  it.each(['cancelled', 'timeout', 'exception', 'invalid', 'server-error'] as const)('fails closed for %s without leaking input or reopening prompts', async reason => {
    vi.useFakeTimers();
    let respond!: (value: string[] | null) => void;
    let rejectInput!: (err: Error) => void;
    const handler = vi.fn(() => new Promise<string[] | null>((resolve, reject) => { respond = resolve; rejectInput = reject; }));
    const { host, connecting, client, logger, verify, prompt } = await interactiveHost(handler);
    const input = vi.fn();
    const offInput = host.onInteractiveAuthentication(input);
    const rejected = expect(connecting).rejects.toMatchObject({ code: 'SSH_INTERACTIVE_AUTH_FAILED' });
    try {
      await verify();
      const finish = vi.fn(); prompt(finish);
      if (reason === 'cancelled') respond(null);
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(120_000);
      if (reason === 'exception') rejectInput(new Error('FAKE-OTP was rejected'));
      if (reason === 'invalid') respond(['FAKE-OTP', 'extra']);
      if (reason === 'server-error') client.emit('error', new Error('FAKE-OTP was rejected'));
      await rejected;
      expect(input).toHaveBeenLastCalledWith(null);
      client.emit('error', new Error('FAKE-OTP echoed by a closing transport'));
      if (reason === 'server-error') client.emit('close');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.getStatus()).toBe('failed');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(finish).not.toHaveBeenCalled();
      expect(JSON.stringify(host.snapshot())).not.toContain('FAKE-OTP');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('FAKE-OTP');
    } finally { offInput(); await host.disconnect(); vi.useRealTimers(); }
  });

  it('aborts on disconnect and ignores and clears a late answer', async () => {
    let respond!: (value: string[]) => void;
    let signal!: AbortSignal;
    const { host, connecting, verify, prompt } = await interactiveHost((_request, abort) => {
      signal = abort; return new Promise(resolve => { respond = resolve; });
    });
    const rejected = expect(connecting).rejects.toThrow('SSH connection attempt cancelled');
    const input = vi.fn();
    const offInput = host.onInteractiveAuthentication(input);
    await verify();
    const finish = vi.fn(); prompt(finish);
    await host.disconnect(); await rejected;
    expect(input).toHaveBeenLastCalledWith(null);
    expect(signal.aborted).toBe(true);
    const late = ['FAKE-LATE']; respond(late);
    await Promise.resolve(); await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    expect(late).toEqual(['']);
    offInput();
  });

  it('never requests input from an unverified host', async () => {
    const handler = vi.fn(async () => ['FAKE-OTP']);
    const { host, connecting, prompt } = await interactiveHost(handler);
    const rejected = expect(connecting).rejects.toMatchObject({ code: 'SSH_INTERACTIVE_AUTH_FAILED' });
    prompt(vi.fn()); await rejected;
    expect(handler).not.toHaveBeenCalled();
    await host.disconnect();
  });

  it('keeps a new input deadline when an old connection closes or answers late', async () => {
    vi.useFakeTimers();
    const responders: Array<(answers: string[]) => void> = [];
    const { host, connecting, client, verify, prompt } = await interactiveHost(
      () => new Promise(resolve => { responders.push(resolve); }),
    );
    const input = vi.fn();
    const offInput = host.onInteractiveAuthentication(input);
    const rejected = expect(connecting).rejects.toThrow('SSH connection attempt cancelled');
    try {
      await verify();
      prompt(vi.fn());
      await host.disconnect();
      await rejected;
      const reconnecting = host.connect();
      await vi.advanceTimersByTimeAsync(1);
      const next = h.client!;
      await new Promise<boolean>(resolve => next.connectConfig!.hostVerifier!(Buffer.from('test-key'), resolve));
      next.emit('keyboard-interactive', 'MFA', 'Enter code', '', [{ prompt: 'Code', echo: false }], () => next.emit('ready'));
      const currentDeadline = Date.now() + 120_000;
      const lateObserver = vi.fn();
      const offLate = host.onInteractiveAuthentication(lateObserver);
      expect(lateObserver).toHaveBeenLastCalledWith(currentDeadline);
      offLate();
      const late = ['FAKE-LATE'];
      responders[0]!(late);
      client.emit('close');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(input).toHaveBeenLastCalledWith(currentDeadline);
      expect(late).toEqual(['']);
      responders[1]!(['FAKE-OTP']);
      await reconnecting;
      expect(host.getStatus()).toBe('ready');
      expect(input).toHaveBeenLastCalledWith(null);
    } finally { offInput(); await host.disconnect(); vi.useRealTimers(); }
  });

  it('reports a missing local input handler and handles empty informational rounds without UI', async () => {
    const { host, connecting, verify, prompt } = await interactiveHost();
    const rejected = expect(connecting).rejects.toMatchObject({ code: 'SSH_INTERACTIVE_AUTH_FAILED', reason: 'required' });
    await verify();
    const finish = vi.fn(); prompt(finish, []);
    expect(finish).toHaveBeenCalledWith([]);
    prompt(finish); await rejected;
    expect(finish).toHaveBeenCalledTimes(1);
    await host.disconnect();
  });
});

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
    // real-wait: enforce the real connection timeout in this rekey race.
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
