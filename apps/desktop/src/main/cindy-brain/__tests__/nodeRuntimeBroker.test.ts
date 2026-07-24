/** nodeRuntimeBroker.test — 随包 Node / MCP stdio 中继的纯进程假体单测。 */

import { EventEmitter } from 'node:events';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import {
  createUtilityNodeWorkerProcess,
  GhostNodeRuntimeBroker,
  type NodeWorkerProcess,
} from '../nodeRuntimeBroker';

class FakeNodeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1234;
  killed = false;
  received: Array<Record<string, unknown>> = [];
  private inputBuffer = '';

  constructor(
    private readonly onMessage?: (message: Record<string, unknown>) => void,
    emitSpawn = true,
  ) {
    super();
    this.stdin.on('data', (chunk) => {
      this.inputBuffer += String(chunk);
      for (;;) {
        const newline = this.inputBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.inputBuffer.slice(0, newline);
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        this.received.push(message);
        this.onMessage?.(message);
      }
    });
    if (emitSpawn) queueMicrotask(() => this.emit('spawn'));
  }

  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
}

class FakeUtilityProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4321;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

function fakeGhost(
  options: { protocol?: 'json-rpc-stdio' | 'mcp-stdio'; lifecycle?: 'on-demand' | 'resident' } = {},
): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'node-ghost',
      name: 'Node Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['node'],
      node: {
        entry: 'node/worker.cjs',
        protocol: options.protocol ?? 'json-rpc-stdio',
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      },
    },
    dir: '/fake/node-ghost',
    enabled: true,
  } as InstalledGhost;
}

function rpcRequest(method = 'echo', params: unknown = { value: 1 }) {
  return { type: 'node-request', method, params };
}

function makeAutoReplyProcess(methods?: string[]) {
  const process = new FakeNodeProcess((message) => {
    if (typeof message.method === 'string') methods?.push(message.method);
    if (message.id !== undefined && typeof message.method === 'string') {
      queueMicrotask(() =>
        process.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { method: message.method, params: message.params },
        }),
      );
    }
  });
  return process;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('nodeRuntimeBroker · Electron utilityProcess 适配', () => {
  it('不依赖 RunAsNode，过滤宿主秘密，并只用 parentPort 推送 stdin', () => {
    vi.stubEnv('PATH', '/usr/bin');
    vi.stubEnv('NODE_OPTIONS', '--inspect=0.0.0.0:9229');
    vi.stubEnv('ANTHROPIC_API_KEY', 'secret');
    const child = new FakeUtilityProcess();
    const fork = vi.fn((modulePath: unknown, entryArgs: unknown, options: unknown) => {
      void modulePath;
      void entryArgs;
      void options;
      return child;
    });
    const worker = createUtilityNodeWorkerProcess(
      '/plugins/demo/node/worker.cjs',
      '/plugins/demo',
      'demo',
      fork as never,
    );

    expect(fork).toHaveBeenCalledWith(
      expect.stringMatching(/nodeRuntimeWorkerProcess\.js$/),
      ['/plugins/demo/node/worker.cjs'],
      expect.objectContaining({
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        serviceName: 'cindy-ghost-node:demo',
        env: expect.objectContaining({
          CINDY_GHOST_ID: 'demo',
        }),
      }),
    );
    const forkOptions = fork.mock.calls[0][2] as { env: Record<string, string> };
    expect(forkOptions.env).not.toHaveProperty('CINDY_GHOST_DIR');
    expect(forkOptions.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(forkOptions.env).not.toHaveProperty('NODE_OPTIONS');
    expect(forkOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');

    const spawned = vi.fn();
    worker.once('spawn', spawned);
    child.emit('message', { type: 'ready' });
    expect(spawned).toHaveBeenCalledTimes(1);
    // 2026-07-23 起普通 worker 就绪后保留一条消息听筒——它只承载引导层的
    // 子进程控制帧(childSpawn),形状由 broker 严格把关;非控制帧仍然没有
    // 任何消费面(下面的 stdin 断言即证明正式通信面仍是 stdio)。
    expect(child.listenerCount('message')).toBe(1);

    expect(worker.stdin.write('{"jsonrpc":"2.0"}\n')).toBe(true);
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'stdin',
      chunk: '{"jsonrpc":"2.0"}\n',
    });
    expect(worker.kill('SIGTERM')).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe('nodeRuntimeBroker · 进程生命周期', () => {
  it('第一次请求才启动，同一插件后续请求复用同一个进程', async () => {
    const ghost = fakeGhost();
    const children: FakeNodeProcess[] = [];
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => {
        const child = makeAutoReplyProcess();
        children.push(child);
        return child as unknown as NodeWorkerProcess;
      },
    });

    expect(broker.stateOf('node-ghost')).toBe('off');
    expect(await broker.handleRequest('node-ghost', rpcRequest('first'))).toMatchObject({
      ok: true,
      result: { method: 'first' },
    });
    expect(await broker.handleRequest('node-ghost', rpcRequest('second'))).toMatchObject({
      ok: true,
      result: { method: 'second' },
    });
    expect(children).toHaveLength(1);
    expect(broker.stateOf('node-ghost')).toBe('running');
    broker.destroyAll();
  });

  it('停用式 stop 立即拒绝在途请求并关闭进程', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(); // 不回 response，保持在途
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    broker.stop('node-ghost');
    expect(await pending).toMatchObject({ ok: false, errorCode: 'PROCESS_EXITED' });
    expect(child.killed).toBe(true);
    expect(broker.stateOf('node-ghost')).toBe('off');
  });

  it('按需进程空闲两分钟后自动关闭', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.runAllTicks();
    await expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.killed).toBe(true);
    expect(broker.stateOf('node-ghost')).toBe('off');
  });

  it('resident 档可提前启动且不会设置空闲关闭', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const child = makeAutoReplyProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    await broker.startResident(ghost);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(child.killed).toBe(false);
    expect(broker.stateOf('node-ghost')).toBe('running');
    broker.destroyAll();
  });

  it('工作进程一直不就绪时 10 秒后失败并强制关闭', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(undefined, false);
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROCESS_START_FAILED',
      message: expect.stringContaining('启动超时'),
    });
    expect(child.killed).toBe(true);
    expect(broker.stateOf('node-ghost')).toBe('off');
  });
});

describe('nodeRuntimeBroker · 权限与协议', () => {
  it('没声明 node 槽时拒绝且不启动进程', async () => {
    const ghost = fakeGhost();
    ghost.manifest.slots = ['card'];
    const spawnProcess = vi.fn();
    const broker = new GhostNodeRuntimeBroker({ getGhost: () => ghost, spawnProcess });

    expect(await broker.handleRequest('node-ghost', rpcRequest())).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('只在清单绑定的方法中把 safeStorage 凭证注入 Worker 保留字段', async () => {
    const ghost = fakeGhost();
    ghost.manifest.node!.secretBindings = [
      {
        key: 'mail_code',
        label: '邮箱授权码',
        methods: ['mail/action'],
      },
    ];
    const child = makeAutoReplyProcess();
    const readSecret = vi.fn(() => 'fake-secret-value');
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      readSecret,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const result = await broker.handleRequest('node-ghost', {
      type: 'node-request',
      method: 'mail/action',
      params: { action: 'search' },
      // main.js 自报的同名字段不可信；broker 必须忽略并重铸。
      cindy: { secrets: { mail_code: 'attacker-value' } },
    });
    expect(result).toMatchObject({ ok: true });
    expect(readSecret).toHaveBeenCalledWith('node-ghost', 'mail_code');
    expect(child.received[0]).toMatchObject({
      method: 'mail/action',
      params: { action: 'search' },
      cindy: { secrets: { mail_code: 'fake-secret-value' } },
    });

    await broker.handleRequest('node-ghost', rpcRequest('account/status', {}));
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(child.received[1]).not.toHaveProperty('cindy');
    broker.destroyAll();
  });

  it('绑定凭证未保存时不向 Worker 发送业务请求，也不在日志中泄露值', async () => {
    const ghost = fakeGhost();
    ghost.manifest.node!.secretBindings = [
      {
        key: 'mail_code',
        label: '邮箱授权码',
        methods: ['mail/action'],
      },
    ];
    const child = makeAutoReplyProcess();
    const log = { info: vi.fn(), warn: vi.fn() };
    const spawnProcess = vi.fn(() => child as unknown as NodeWorkerProcess);
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      readSecret: () => null,
      spawnProcess,
      log,
    });

    expect(await broker.handleRequest('node-ghost', rpcRequest('mail/action', {}))).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: expect.stringContaining('邮箱授权码'),
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(child.received).toHaveLength(0);
    expect(JSON.stringify(log)).not.toContain('fake-secret-value');
    broker.destroyAll();
  });

  it('保险库读取异常时返回固定错误，不发送请求或泄露异常细节', async () => {
    const ghost = fakeGhost();
    ghost.manifest.node!.secretBindings = [
      {
        key: 'mail_code',
        label: '邮箱授权码',
        methods: ['mail/action'],
      },
    ];
    const child = makeAutoReplyProcess();
    const spawnProcess = vi.fn(() => child as unknown as NodeWorkerProcess);
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      readSecret: () => {
        throw new Error('vault failed with sensitive context');
      },
      spawnProcess,
    });

    const result = await broker.handleRequest('node-ghost', rpcRequest('mail/action', {}));
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: '读取 Node 请求所需凭证失败',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive context');
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(child.received).toHaveLength(0);
    broker.destroyAll();
  });

  it('mcp-stdio 保留初始化方法在启动 Worker 前拒绝', async () => {
    const ghost = fakeGhost({ protocol: 'mcp-stdio' });
    const spawnProcess = vi.fn();
    const broker = new GhostNodeRuntimeBroker({ getGhost: () => ghost, spawnProcess });

    for (const method of ['initialize', 'notifications/initialized']) {
      expect(await broker.handleRequest('node-ghost', rpcRequest(method, {}))).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: expect.stringContaining('MCP 初始化'),
      });
    }
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('mcp-stdio 由主机先 initialize，再发送 initialized 通知和业务方法', async () => {
    const methods: string[] = [];
    const ghost = fakeGhost({ protocol: 'mcp-stdio' });
    const child = makeAutoReplyProcess(methods);
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const result = await broker.handleRequest('node-ghost', rpcRequest('tools/list', {}));
    expect(result.ok).toBe(true);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    const init = child.received[0];
    expect(init).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'Cindy' } },
    });
    broker.destroyAll();
  });

  it('Node notification 只转交给 main.js；反向 RPC 请求 Cindy 恒回 -32601', async () => {
    const events: unknown[] = [];
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      sendToGhost: (_id, event) => events.push(event),
      now: () => 99,
    });
    await broker.handleRequest('node-ghost', rpcRequest());

    child.send({ jsonrpc: '2.0', method: 'progress', params: { pct: 50 } });
    child.send({ jsonrpc: '2.0', id: 'server-1', method: 'sampling/createMessage', params: {} });
    await vi.waitFor(() =>
      expect(child.received).toContainEqual(
        expect.objectContaining({
          id: 'server-1',
          error: { code: -32601, message: expect.any(String) },
        }),
      ),
    );
    expect(events).toContainEqual({
      type: 'event',
      name: 'node-notification',
      method: 'progress',
      params: { pct: 50 },
      ts: 99,
    });
    broker.destroyAll();
  });

  it('非法 stdout 会终止进程并返回协议错误，不会拖垮主机', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    child.stdout.write('not-json\n');
    expect(await pending).toMatchObject({ ok: false, errorCode: 'PROTOCOL_ERROR' });
    expect(child.killed).toBe(true);
  });

  it('UTF-8 汉字被拆在两个 stdout chunk 时仍能完整解析', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    const line = Buffer.from(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: child.received[0].id,
        result: { text: '中文结果' },
      })}\n`,
      'utf8',
    );
    const firstChineseByte = line.indexOf(Buffer.from('中'));
    child.stdout.write(line.subarray(0, firstChineseByte + 1));
    child.stdout.write(line.subarray(firstChineseByte + 1));

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { text: '中文结果' },
    });
    broker.destroyAll();
  });
});

describe('nodeRuntimeBroker · 多入口(node.entries 窄版,2026-07-23)', () => {
  function multiEntryGhost(): InstalledGhost {
    const ghost = fakeGhost();
    ghost.manifest.node = {
      entry: 'node/worker.cjs',
      protocol: 'json-rpc-stdio',
      entries: ['node/build.cjs'],
    };
    return ghost;
  }

  it('entry 未命中申报清单整单拒;命中/缺省各起独立进程;stop 收掉全部', async () => {
    const ghost = multiEntryGhost();
    const spawned: Array<{ entryPath: string; process: FakeNodeProcess }> = [];
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: (entryPath) => {
        const process = makeAutoReplyProcess();
        spawned.push({ entryPath, process });
        return process as unknown as NodeWorkerProcess;
      },
    });

    // 未申报入口:整单拒,不 spawn
    const rejected = await broker.handleRequest('node-ghost', {
      ...rpcRequest(),
      entry: 'node/hack.cjs',
    });
    expect(rejected).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(spawned).toHaveLength(0);

    // 缺省 = 主入口
    const primary = await broker.handleRequest('node-ghost', rpcRequest());
    expect(primary.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].entryPath.replaceAll('\\', '/')).toContain('node/worker.cjs');

    // 申报的额外入口:独立进程
    const extra = await broker.handleRequest('node-ghost', {
      ...rpcRequest('build/run'),
      entry: 'node/build.cjs',
    });
    expect(extra.ok).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].entryPath.replaceAll('\\', '/')).toContain('node/build.cjs');

    // 同入口复用进程,不重复 spawn
    await broker.handleRequest('node-ghost', { ...rpcRequest(), entry: 'node/build.cjs' });
    expect(spawned).toHaveLength(2);
    expect(broker.stateOf('node-ghost')).toBe('running');

    // stop 收掉该插件全部进程
    broker.stop('node-ghost');
    expect(spawned[0].process.killed).toBe(true);
    expect(spawned[1].process.killed).toBe(true);
    expect(broker.stateOf('node-ghost')).toBe('off');
  });

  it('额外入口的 node-status 事件带 entry 字段,主入口不带(老包协议零变化)', async () => {
    const ghost = multiEntryGhost();
    const pushes: Array<Record<string, unknown>> = [];
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => makeAutoReplyProcess() as unknown as NodeWorkerProcess,
      sendToGhost: (_id, payload) => {
        pushes.push(payload as unknown as Record<string, unknown>);
      },
    });
    await broker.handleRequest('node-ghost', rpcRequest());
    await broker.handleRequest('node-ghost', { ...rpcRequest(), entry: 'node/build.cjs' });
    const statuses = pushes.filter((p) => p.name === 'node-status');
    const primaryStatuses = statuses.filter((p) => !('entry' in p));
    const extraStatuses = statuses.filter((p) => p.entry === 'node/build.cjs');
    expect(primaryStatuses.length).toBeGreaterThan(0);
    expect(extraStatuses.length).toBeGreaterThan(0);
    // 除主入口外不允许出现其它 entry 值
    expect(statuses.every((p) => !('entry' in p) || p.entry === 'node/build.cjs')).toBe(true);
  });
});

describe('nodeRuntimeBroker · 长任务续命(maxTotalMs,2026-07-23)', () => {
  function silentProcess(): FakeNodeProcess {
    // 不自动回复:超时/续命行为全由测试手动驱动。
    return new FakeNodeProcess();
  }

  it('maxTotalMs 校验:非整数 / 小于生效 timeoutMs / 超 15 分钟 一律拒', async () => {
    const ghost = fakeGhost();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => silentProcess() as unknown as NodeWorkerProcess,
    });
    for (const bad of [
      { ...rpcRequest(), maxTotalMs: 1.5 },
      { ...rpcRequest(), timeoutMs: 60_000, maxTotalMs: 30_000 },
      { ...rpcRequest(), maxTotalMs: 15 * 60_000 + 1 },
      { ...rpcRequest(), maxTotalMs: '900000' },
    ]) {
      expect(await broker.handleRequest('node-ghost', bad)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
      });
    }
    broker.destroyAll();
  });

  it('不声明 maxTotalMs = 旧语义:进度通知不给请求续命', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = silentProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });
    const pending = broker.handleRequest('node-ghost', { ...rpcRequest(), timeoutMs: 1_000 });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(800);
    child.send({ jsonrpc: '2.0', method: 'progress', params: { percent: 50 } });
    await vi.advanceTimersByTimeAsync(300); // 总时长 1100ms > timeoutMs
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    broker.destroyAll();
  });

  it('声明 maxTotalMs:stdout 进度与 stderr 日志都能续命,最终正常交卷', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = silentProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });
    const pending = broker.handleRequest('node-ghost', {
      ...rpcRequest('build/run'),
      timeoutMs: 1_000,
      maxTotalMs: 10_000,
    });
    await vi.runAllTicks();
    // 三轮 800ms 间隔的动静:无续命早就在 1000ms 处死了。
    await vi.advanceTimersByTimeAsync(800);
    child.send({ jsonrpc: '2.0', method: 'progress', params: { percent: 30 } });
    await vi.advanceTimersByTimeAsync(800);
    child.stderr.write('compiling scene 2...\n');
    await vi.advanceTimersByTimeAsync(800);
    child.send({ jsonrpc: '2.0', method: 'progress', params: { percent: 90 } });
    // 交卷(总时长 2400ms,早已超过旧语义的 1000ms)。
    const requestId = child.received.at(-1)?.id ?? child.received[0]?.id;
    child.send({ jsonrpc: '2.0', id: requestId, result: { built: true } });
    await vi.runAllTicks();
    await expect(pending).resolves.toMatchObject({ ok: true, result: { built: true } });
    broker.destroyAll();
  });

  it('续命后彻底沉默超过 timeoutMs 仍判死;一直有动静也过不了 maxTotalMs 天花板', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = silentProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });
    // 场景 A:续一次命后彻底沉默 → 沉默窗口到点判死。
    const silentDeath = broker.handleRequest('node-ghost', {
      ...rpcRequest(),
      timeoutMs: 1_000,
      maxTotalMs: 10_000,
    });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(800);
    child.send({ jsonrpc: '2.0', method: 'progress' });
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(silentDeath).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });

    // 场景 B:每 500ms 一条动静,但 maxTotalMs=3000 → 天花板处判死。
    const capped = broker.handleRequest('node-ghost', {
      ...rpcRequest('build/forever'),
      timeoutMs: 1_000,
      maxTotalMs: 3_000,
    });
    await vi.runAllTicks();
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      child.send({ jsonrpc: '2.0', method: 'progress', params: { tick: i } });
    }
    await expect(capped).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    broker.destroyAll();
  });
});

describe('nodeRuntimeBroker · 宿主代启子进程(childSpawn,2026-07-23)', () => {
  /** 带控制通道的 worker 假体(引导层 parentPort 的两端都在测试手里)。 */
  class FakeControlProcess extends FakeNodeProcess {
    controlListeners = new Set<(message: unknown) => void>();
    sentControl: Array<Record<string, unknown>> = [];
    onControl(listener: (message: unknown) => void): void {
      this.controlListeners.add(listener);
    }
    sendControl(message: unknown): boolean {
      this.sentControl.push(message as Record<string, unknown>);
      return true;
    }
    emitControl(message: unknown): void {
      this.controlListeners.forEach((listener) => listener(message));
    }
    lastOf(type: string): Record<string, unknown> | undefined {
      return [...this.sentControl].reverse().find((m) => m.type === type);
    }
  }

  /** 原样 stdio 子进程假体(spawnChildProcess 返回)。 */
  class FakeRawChild extends EventEmitter {
    stdinChunks: string[] = [];
    stdin = {
      destroyed: false,
      write: (chunk: string): boolean => {
        this.stdinChunks.push(chunk);
        return true;
      },
    };
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 777;
    killed = false;
    controlSent: unknown[] = [];
    sendControl(message: unknown): boolean {
      this.controlSent.push(message);
      return true;
    }
    kill(signal?: NodeJS.Signals): boolean {
      this.killed = true;
      queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
      return true;
    }
  }

  function childSpawnGhost(childSpawn = true): InstalledGhost {
    const ghost = fakeGhost();
    ghost.manifest.node = {
      entry: 'node/worker.cjs',
      protocol: 'json-rpc-stdio',
      entries: ['node/maker.cjs'],
      ...(childSpawn ? { childSpawn: true } : {}),
    };
    return ghost;
  }

  async function bootWorker(ghost: InstalledGhost, spawnChild?: () => FakeRawChild) {
    const worker = new FakeControlProcess((message) => {
      if (message.id !== undefined && typeof message.method === 'string') {
        queueMicrotask(() => worker.send({ jsonrpc: '2.0', id: message.id, result: null }));
      }
    });
    const spawned: Array<{ entryPath: string; args: string[]; child: FakeRawChild }> = [];
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => worker as unknown as NodeWorkerProcess,
      spawnChildProcess: (entryPath, _cwd, _ghostId, args) => {
        const child = spawnChild?.() ?? new FakeRawChild();
        spawned.push({ entryPath, args, child });
        queueMicrotask(() => child.emit('spawn'));
        return child as unknown as NodeWorkerProcess;
      },
    });
    await broker.handleRequest('node-ghost', rpcRequest()); // 拉起 worker
    return { broker, worker, spawned };
  }

  it('未声明 childSpawn:代生请求收到结构化拒绝,不 fork', async () => {
    const { worker, spawned } = await bootWorker(childSpawnGhost(false));
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs' });
    await vi.waitFor(() => {
      expect(worker.lastOf('spawn-child-result')).toMatchObject({ reqId: 'r1', ok: false });
    });
    expect(spawned).toHaveLength(0);
  });

  it('入口未申报 / 帧形状畸形:拒绝或静默丢,不 fork', async () => {
    const { worker, spawned } = await bootWorker(childSpawnGhost());
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/hack.cjs' });
    await vi.waitFor(() => {
      expect(worker.lastOf('spawn-child-result')).toMatchObject({ reqId: 'r1', ok: false });
    });
    worker.emitControl({ type: 'spawn-child', reqId: 'bad id!', entry: 'node/maker.cjs' });
    worker.emitControl('not-an-object');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toHaveLength(0);
  });

  it('正道:代生成功回执 childId,双向字节中继 + stdin-end + kill 全通', async () => {
    const { worker, spawned } = await bootWorker(childSpawnGhost());
    worker.emitControl({
      type: 'spawn-child',
      reqId: 'r1',
      entry: 'node/maker.cjs',
      args: ['__maker-proxy'],
    });
    await vi.waitFor(() => {
      expect(worker.lastOf('spawn-child-result')).toMatchObject({ reqId: 'r1', ok: true });
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].entryPath.replaceAll('\\', '/')).toContain('node/maker.cjs');
    expect(spawned[0].args).toEqual(['__maker-proxy']);
    const childId = worker.lastOf('spawn-child-result')?.childId as string;

    // 子 → worker:stdout/stderr 逐帧 base64
    spawned[0].child.stdout.write('hello');
    spawned[0].child.stderr.write('log');
    await vi.waitFor(() => {
      expect(worker.lastOf('child-stdout')).toMatchObject({
        childId,
        b64: Buffer.from('hello').toString('base64'),
      });
      expect(worker.lastOf('child-stderr')).toMatchObject({
        childId,
        b64: Buffer.from('log').toString('base64'),
      });
    });

    // worker → 子:stdin 帧原样转写、stdin-end 下发控制帧
    const b64 = Buffer.from('{"jsonrpc":"2.0"}\n').toString('base64');
    worker.emitControl({ type: 'child-stdin', childId, b64 });
    expect(spawned[0].child.stdinChunks).toEqual([b64]);
    worker.emitControl({ type: 'child-stdin-end', childId });
    expect(spawned[0].child.controlSent).toEqual([{ type: 'stdin-end' }]);

    // kill → 子进程退出 → worker 收到 child-exit
    worker.emitControl({ type: 'child-kill', childId });
    await vi.waitFor(() => {
      expect(spawned[0].child.killed).toBe(true);
      expect(worker.lastOf('child-exit')).toMatchObject({ childId });
    });
  });

  it('数量顶:同插件同时在世子进程超 4 个即拒', async () => {
    const { worker, spawned } = await bootWorker(childSpawnGhost());
    for (let i = 1; i <= 5; i += 1) {
      worker.emitControl({ type: 'spawn-child', reqId: `r${i}`, entry: 'node/maker.cjs' });
    }
    await vi.waitFor(() => {
      expect(worker.lastOf('spawn-child-result')).toMatchObject({ reqId: 'r5', ok: false });
    });
    expect(spawned).toHaveLength(4);
  });

  it('级联生死:stop 插件时子进程一并收掉;有子进程在世时不空闲回收', async () => {
    vi.useFakeTimers();
    const { broker, worker, spawned } = await bootWorker(childSpawnGhost());
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs' });
    await vi.runAllTicks();
    expect(spawned).toHaveLength(1);
    // 空闲两分钟:worker 名下有活着的子进程,不回收
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(worker.killed).toBe(false);
    // stop 收全家
    broker.stop('node-ghost');
    expect(spawned[0].child.killed).toBe(true);
    expect(worker.killed).toBe(true);
  });
});
