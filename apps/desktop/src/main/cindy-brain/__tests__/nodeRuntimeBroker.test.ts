/** nodeRuntimeBroker.test — 随包 Node / MCP stdio 中继的纯进程假体单测。 */

import { EventEmitter } from 'node:events';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import {
  createUtilityNodeWorkerProcess,
  GhostNodeRuntimeBroker,
  type NodeWorkerStartupObservation,
  type NodeWorkerProcess,
} from '../nodeRuntimeBroker';

const TEST_APP_RUN_ID = 'a'.repeat(16);
const TEST_ATTEMPT_ID = 'b'.repeat(16);

class FakeNodeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 1234;
  killed = false;
  received: Array<Record<string, unknown>> = [];
  startupObservationListeners = new Set<(observation: NodeWorkerStartupObservation) => void>();
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

  onStartupObservation(listener: (observation: NodeWorkerStartupObservation) => void): void {
    this.startupObservationListeners.add(listener);
  }

  emitStartupObservation(observation: NodeWorkerStartupObservation): void {
    this.startupObservationListeners.forEach((listener) => listener(observation));
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

describe('nodeRuntimeBroker owner boundary races', () => {
  it('owner boundary change during startup kills the worker and fails closed', async () => {
    let generation = 1;
    const invalidated = vi.fn();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(undefined, false);
    const spawnProcess = vi.fn(() => child as unknown as NodeWorkerProcess);
    const debug = vi.fn();
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      log: { debug, info: vi.fn(), warn },
      ownerScope: {
        capture: () => generation,
        isCurrent: (scope) => scope === generation,
        isStable: (scope) => scope === generation,
        onInvalidated: invalidated,
      },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('startup'));
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    generation = 2;
    child.emit('spawn');

    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(child.killed).toBe(true);
    expect(invalidated).toHaveBeenCalledWith('node-ghost');
    expect(debug).toHaveBeenCalledWith(
      'ghost node startup settlement',
      expect.objectContaining({
        appRunId: TEST_APP_RUN_ID,
        attemptId: TEST_ATTEMPT_ID,
        outcome: 'cancelled',
        observedStagesAtSettle: ['parent-port-ready'],
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('owner boundary change before a response discards the response and stops the worker', async () => {
    let generation = 1;
    const invalidated = vi.fn();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      ownerScope: {
        capture: () => generation,
        isCurrent: (scope) => scope === generation,
        isStable: (scope) => scope === generation,
        onInvalidated: invalidated,
      },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('response'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    generation = 2;
    child.send({ jsonrpc: '2.0', id: child.received[0].id, result: { stale: true } });

    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'PROCESS_EXITED' });
    expect(child.killed).toBe(true);
    expect(invalidated).toHaveBeenCalledWith('node-ghost');
  });

  it('a stale owner callback does not stop a fresh worker for the same ghost', async () => {
    let generation = 1;
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const staleChild = new FakeNodeProcess(undefined, false);
    const freshChild = new FakeNodeProcess(undefined, false);
    const invalidated = vi.fn();
    const spawnProcess = vi.fn(
      () => (spawnProcess.mock.calls.length === 1 ? staleChild : freshChild) as unknown as NodeWorkerProcess,
    );
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess,
      ownerScope: {
        capture: () => generation,
        isCurrent: (scope) => scope === generation,
        isStable: (scope) => scope === generation,
        onInvalidated: invalidated,
      },
    });

    const firstStart = broker.startResident(ghost);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    staleChild.emit('spawn');
    await firstStart;
    generation = 2;
    broker.stop('node-ghost');
    const secondStart = broker.startResident(ghost);
    await vi.waitFor(() => expect(spawnProcess.mock.calls.length).toBeGreaterThanOrEqual(2));
    freshChild.emit('spawn');
    await secondStart;

    staleChild.stderr.write('stale owner callback\n');
    await vi.waitFor(() => expect(staleChild.killed).toBe(true));

    expect(freshChild.killed).toBe(false);
    expect(broker.stateOf('node-ghost')).toBe('running');
    expect(invalidated).not.toHaveBeenCalled();
  });
});

function makeAutoReplyProcess(methods?: string[], emitSpawn = true) {
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
  }, emitSpawn);
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
    vi.stubEnv('USERPROFILE', 'C:\\Users\\demo');
    vi.stubEnv('APPDATA', 'C:\\Users\\demo\\AppData\\Roaming');
    vi.stubEnv('GH_CONFIG_DIR', 'D:\\gh-config');
    vi.stubEnv('XDG_CONFIG_HOME', 'D:\\xdg-config');
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
    // 用户身份路径变量必须透传——Windows 上的 gh 靠 APPDATA / USERPROFILE 定位
    // 登录配置，裁掉会让 worker 里的 gh 误报“未登录”（keyring 登录读不到）。
    expect(forkOptions.env.USERPROFILE).toBe('C:\\Users\\demo');
    expect(forkOptions.env.APPDATA).toBe('C:\\Users\\demo\\AppData\\Roaming');
    expect(forkOptions.env.GH_CONFIG_DIR).toBe('D:\\gh-config');
    expect(forkOptions.env.XDG_CONFIG_HOME).toBe('D:\\xdg-config');

    expect(worker.stderr).toBe(child.stderr);
    expect(child.stderr.listenerCount('error')).toBe(0);
    const stages: NodeWorkerStartupObservation[] = [];
    worker.onStartupObservation?.(() => {
      throw new Error('diagnostic listener failed');
    });
    worker.onStartupObservation?.((stage) => stages.push(stage));

    const spawned = vi.fn();
    worker.once('spawn', spawned);
    child.emit('message', { type: 'ready' });
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(stages.map(({ stage }) => stage)).toEqual(['utility-process-spawned']);
    // 2026-07-23 起普通 worker 就绪后保留一条消息听筒——它只承载引导层的
    // 子进程控制帧(childSpawn),形状由 broker 严格把关;非控制帧仍然没有
    // 任何消费面(下面的 stdin 断言即证明正式通信面仍是 stdio)。
    expect(child.listenerCount('message')).toBe(1);

    expect(worker.stdin.write('{"jsonrpc":"2.0"}\n')).toBe(true);
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'stdin',
      chunk: '{"jsonrpc":"2.0"}\n',
    });
    const processError = vi.fn();
    worker.on('error', processError);
    child.emit('error', 'crashed', 'service');
    expect(processError).toHaveBeenCalledOnce();
    expect(processError.mock.calls[0][0]).toEqual(
      new Error('Node utilityProcess crashed at service'),
    );
    expect(worker.kill('SIGTERM')).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('native observation 只在正整数 PID 回放或真实 spawn 时发布一次', () => {
    const child = new FakeUtilityProcess();
    child.pid = undefined;
    const worker = createUtilityNodeWorkerProcess(
      '/plugins/demo/node/worker.cjs',
      '/plugins/demo',
      'demo',
      vi.fn(() => child) as never,
    );
    const stages: NodeWorkerStartupObservation[] = [];
    worker.onStartupObservation?.((stage) => stages.push(stage));

    expect(stages).toEqual([]);
    child.emit('spawn');
    child.pid = 4321;
    child.emit('spawn');
    child.emit('message', { type: 'ready' });
    expect(stages).toEqual([{ stage: 'utility-process-spawned' }]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '非法初始 PID %s 不会伪造 native spawn observation',
    (pid) => {
      const child = new FakeUtilityProcess();
      child.pid = pid;
      const worker = createUtilityNodeWorkerProcess(
        '/plugins/demo/node/worker.cjs',
        '/plugins/demo',
        'demo',
        vi.fn(() => child) as never,
      );
      const stages: NodeWorkerStartupObservation[] = [];
      worker.onStartupObservation?.((stage) => stages.push(stage));
      expect(stages).toEqual([]);
    },
  );
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

  it('stopAndWait 在工作进程实际退出前不返回', async () => {
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const child = new FakeNodeProcess();
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      child.killed = true;
      return true;
    });
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });
    await broker.startResident(ghost);

    let settled = false;
    const stopping = broker.stopAndWait('node-ghost').then(() => {
      settled = true;
    });
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);

    child.emit('exit', null, 'SIGTERM');
    await stopping;
    expect(settled).toBe(true);
  });

  it('stopAndWait 在进程不退出时有界失败，不让更新永久卡住', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const child = new FakeNodeProcess();
    vi.spyOn(child, 'kill').mockImplementation(() => {
      child.killed = true;
      return true;
    });
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });
    await broker.startResident(ghost);

    const stopping = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止超时',
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;

    // 第一次超时后 worker 已离开业务 map，但真实 exit 未到；重试不能把它漏掉。
    const retry = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止超时',
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await retry;
  });

  it('工作进程先报 error 时仍终止并等待真实 exit', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const child = new FakeNodeProcess();
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      child.killed = true;
      return true;
    });
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });
    await broker.startResident(ghost);

    child.emit('error', new Error('utility process channel broke'));
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    const stopping = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止超时',
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('stopAndWait 在进程 error 后保留强杀并等待有界失败', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const child = new FakeNodeProcess();
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      child.killed = true;
      return true;
    });
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });
    await broker.startResident(ghost);

    const stopping = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止失败',
    );
    child.emit('error', new Error('spawn transport broke'));
    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
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

  it('两级启动观测按 main 接收顺序记录，elapsedMs 是 main observation latency', async () => {
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess(undefined, false);
    let readyTimerCleared = false;
    const debug = vi.fn((message: string, meta?: Record<string, unknown>) => {
      if (message === 'ghost node startup stage' && meta?.stage === 'parent-port-ready') {
        // 同步慢 logger 开始前，settle(resolve) 已经清掉 10s timer。
        expect(readyTimerCleared).toBe(true);
        for (let index = 0; index < 10_000; index += 1) Math.sqrt(index);
      }
    });
    const info = vi.fn();
    let observedAt = 1_000;
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      getStartAttemptContext: () => ({
        observedMainWindowState: 'focused',
        observedScreenState: 'active',
      }),
      log: { debug, info, warn: vi.fn() },
      diagnosticNow: () => observedAt,
      clearTimer: (timer) => {
        readyTimerCleared = true;
        clearTimeout(timer);
      },
    });

    const pending = broker.handleRequest(
      'node-ghost',
      rpcRequest('stage-order', { forbiddenUserContent: 'sentinel-request-params' }),
    );
    await Promise.resolve();
    observedAt = 1_007;
    child.emitStartupObservation({
      stage: 'utility-process-spawned',
      pid: 1234,
    });
    observedAt = 1_013;
    child.emit('spawn');
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { method: 'stage-order' },
    });

    const stages = debug.mock.calls
      .filter(([message]) => message === 'ghost node startup stage')
      .map(([, meta]) => meta as Record<string, unknown>);
    expect(stages.map(({ stage }) => stage)).toEqual([
      'utility-process-spawned',
      'parent-port-ready',
    ]);
    expect(stages.map(({ elapsedMs }) => elapsedMs)).toEqual([7, 13]);
    for (const meta of stages) {
      expect(Object.keys(meta).sort()).toEqual(
        ['appRunId', 'attemptId', 'elapsedMs', 'entry', 'ghostId', 'pid', 'stage'].sort(),
      );
      expect(meta).toMatchObject({
        ghostId: 'node-ghost',
        entry: 'node/worker.cjs',
        appRunId: TEST_APP_RUN_ID,
        attemptId: TEST_ATTEMPT_ID,
        pid: 1234,
      });
    }
    expect(JSON.stringify(stages)).not.toContain('/fake/node-ghost');
    expect(JSON.stringify(stages)).not.toContain('stage-order');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('sentinel-request-params');
    expect(debug).toHaveBeenCalledWith('ghost node startup settlement', {
      ghostId: 'node-ghost',
      entry: 'node/worker.cjs',
      attempt: 1,
      appRunId: TEST_APP_RUN_ID,
      attemptId: TEST_ATTEMPT_ID,
      outcome: 'ready',
      observedStagesAtSettle: ['utility-process-spawned', 'parent-port-ready'],
      pid: 1234,
    });
    expect(info).not.toHaveBeenCalled();
    broker.destroyAll();
  });

  it('乱序或迟到的纯观测不会改写既有 ready settlement', async () => {
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess(undefined, false);
    const debug = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      log: { debug, info: vi.fn(), warn: vi.fn() },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('out-of-order'));
    await Promise.resolve();
    child.emitStartupObservation({ stage: 'parent-port-ready', pid: 1234 });
    child.emit('spawn');
    await expect(pending).resolves.toMatchObject({ ok: true });
    child.emitStartupObservation({ stage: 'utility-process-spawned', pid: 1234 });

    const settlements = debug.mock.calls.filter(
      ([message]) => message === 'ghost node startup settlement',
    );
    expect(settlements).toHaveLength(1);
    expect(settlements[0][1]).toMatchObject({
      outcome: 'ready',
      observedStagesAtSettle: ['parent-port-ready'],
    });
    broker.destroyAll();
  });

  it('native spawn 已观测但 ready 未观测时只记录两级 observed metadata', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(undefined, false);
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      log: { info: vi.fn(), warn },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await Promise.resolve();
    child.emitStartupObservation({
      stage: 'utility-process-spawned',
      pid: 1234,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      errorCode: 'PROCESS_START_FAILED',
      message: 'Node 工作进程启动超时',
    });
    expect(warn).toHaveBeenCalledWith('ghost node start attempt failed', {
      ghostId: 'node-ghost',
      entry: 'node/worker.cjs',
      attempt: 1,
      appRunId: TEST_APP_RUN_ID,
      attemptId: TEST_ATTEMPT_ID,
      outcome: 'failed',
      observedStagesAtDeadline: ['utility-process-spawned'],
      pid: 1234,
      error: 'startup-timeout',
      observedTimeoutClass: 'native-observed-ready-not-observed',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/fake/node-ghost');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('echo');
    expect(child.killed).toBe(true);
    expect(broker.stateOf('node-ghost')).toBe('off');
  });

  it('空闲回收只在 debug 记录既有 signal/exit 顺序和固定字段', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    const originalKill = child.kill.bind(child);
    vi.spyOn(child, 'kill').mockImplementation((signal) => {
      child.pid = undefined;
      return originalKill(signal);
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const statuses: Array<Record<string, unknown>> = [];
    const debug = vi.fn((message: string, meta?: Record<string, unknown>) => {
      if (message !== 'ghost node process lifecycle') return;
      if (meta?.stage === 'sigterm-requested') {
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 2_000)).toBe(true);
        expect(statuses.some(({ state }) => state === 'stopped')).toBe(true);
        for (let index = 0; index < 10_000; index += 1) Math.sqrt(index);
      }
      if (meta?.stage === 'idle-stop') {
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      }
    });
    const info = vi.fn();
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      sendToGhost: (_ghostId, payload) => statuses.push(payload as Record<string, unknown>),
      log: { debug, info, warn },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.runAllTicks();
    await expect(pending).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.runAllTicks();

    const lifecycle = debug.mock.calls
      .filter(([message]) => message === 'ghost node process lifecycle')
      .map(([, meta]) => meta as Record<string, unknown>);
    expect(lifecycle.map(({ stage }) => stage)).toEqual(['sigterm-requested', 'idle-stop', 'exit']);
    expect(lifecycle[0]).toEqual({
      ghostId: 'node-ghost',
      entry: 'node/worker.cjs',
      appRunId: TEST_APP_RUN_ID,
      attemptId: TEST_ATTEMPT_ID,
      pid: 1234,
      stage: 'sigterm-requested',
      killReturned: true,
    });
    expect(lifecycle[1]).toEqual({
      ghostId: 'node-ghost',
      entry: 'node/worker.cjs',
      appRunId: TEST_APP_RUN_ID,
      attemptId: TEST_ATTEMPT_ID,
      pid: 1234,
      stage: 'idle-stop',
    });
    expect(lifecycle[2]).toEqual({
      ghostId: 'node-ghost',
      entry: 'node/worker.cjs',
      appRunId: TEST_APP_RUN_ID,
      attemptId: TEST_ATTEMPT_ID,
      pid: 1234,
      stage: 'exit',
      code: null,
      signal: 'SIGTERM',
      stoppingElapsedMs: 0,
    });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('既有强杀定时器触发时只追加 SIGKILL 返回值诊断', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
    const debug = vi.fn((message: string, meta?: Record<string, unknown>) => {
      if (message === 'ghost node process lifecycle' && meta?.stage === 'sigkill-requested') {
        expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      }
    });
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      log: { debug, info: vi.fn(), warn: vi.fn() },
    });
    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.runAllTicks();
    await expect(pending).resolves.toMatchObject({ ok: true });

    broker.stop('node-ghost');
    await vi.advanceTimersByTimeAsync(2_500);

    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(debug).toHaveBeenCalledWith('ghost node process lifecycle', {
      ghostId: 'node-ghost',
      entry: 'node/worker.cjs',
      appRunId: TEST_APP_RUN_ID,
      attemptId: TEST_ATTEMPT_ID,
      pid: 1234,
      stage: 'sigkill-requested',
      killReturned: true,
    });
  });

  it('真实 exit debug 只在 worker 状态与 pending 退出收口之后运行', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const statuses: Array<Record<string, unknown>> = [];
    let broker!: GhostNodeRuntimeBroker;
    const debug = vi.fn((message: string, meta?: Record<string, unknown>) => {
      if (message === 'ghost node process lifecycle' && meta?.stage === 'exit') {
        expect(broker.stateOf('node-ghost')).toBe('off');
        expect(statuses.some(({ state }) => state === 'crashed')).toBe(true);
      }
    });
    broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      sendToGhost: (_ghostId, payload) => statuses.push(payload as Record<string, unknown>),
      log: { debug, info: vi.fn(), warn: vi.fn() },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('will-exit'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    child.emit('exit', 1, null);
    child.stderr.end();
    await vi.runAllTicks();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROCESS_EXITED',
    });
    expect(debug).toHaveBeenCalledWith(
      'ghost node process lifecycle',
      expect.objectContaining({ stage: 'exit', code: 1, signal: null }),
    );
  });

  it('进程 error 后只在真实 exit 到达并完成既有清理后记录 exit', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost({ lifecycle: 'resident' });
    const child = new FakeNodeProcess();
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      child.killed = true;
      return true;
    });
    const statuses: Array<Record<string, unknown>> = [];
    let requestSettled = false;
    let broker!: GhostNodeRuntimeBroker;
    const debug = vi.fn((message: string, meta?: Record<string, unknown>) => {
      if (message === 'ghost node process lifecycle' && meta?.stage === 'exit') {
        expect(requestSettled).toBe(true);
        expect(broker.stateOf('node-ghost')).toBe('off');
        expect(statuses.some(({ state }) => state === 'crashed')).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      }
    });
    broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      sendToGhost: (_ghostId, payload) => statuses.push(payload as Record<string, unknown>),
      log: { debug, info: vi.fn(), warn: vi.fn() },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('error-then-exit'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));

    child.emit('error', new Error('utility process channel broke'));
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(
      debug.mock.calls.filter(
        ([message, meta]) => message === 'ghost node process lifecycle' && meta?.stage === 'exit',
      ),
    ).toHaveLength(0);

    child.stderr.end();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROCESS_EXITED',
    });
    requestSettled = true;
    expect(broker.stateOf('node-ghost')).toBe('off');
    expect(statuses.some(({ state }) => state === 'crashed')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    child.emit('exit', 7, 'SIGTERM');

    const exitLogs = debug.mock.calls.filter(
      ([message, meta]) => message === 'ghost node process lifecycle' && meta?.stage === 'exit',
    );
    expect(exitLogs).toEqual([
      [
        'ghost node process lifecycle',
        {
          ghostId: 'node-ghost',
          entry: 'node/worker.cjs',
          appRunId: TEST_APP_RUN_ID,
          attemptId: TEST_ATTEMPT_ID,
          pid: 1234,
          stage: 'exit',
          code: 7,
          signal: 'SIGTERM',
        },
      ],
    ]);
    expect(exitLogs[0]?.[1]).not.toHaveProperty('stoppingElapsedMs');
  });

  it('native spawn 未观测时不给出 UtilityProcess 未创建的因果结论', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(undefined, false);
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      log: { info: vi.fn(), warn },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      errorCode: 'PROCESS_START_FAILED',
      message: 'Node 工作进程启动超时',
    });
    expect(warn).toHaveBeenCalledWith(
      'ghost node start attempt failed',
      expect.objectContaining({
        error: 'startup-timeout',
        observedTimeoutClass: 'native-not-observed',
        observedStagesAtDeadline: [],
      }),
    );
    const attemptWarnings = warn.mock.calls.filter(
      ([message]) => message === 'ghost node start attempt failed',
    );
    expect(JSON.stringify(attemptWarnings)).not.toMatch(/EPERM|nodeRuntimeWorkerProcess|C:\\app/);
    expect(child.killed).toBe(true);
  });

  it('启动失败 settlement warn 抛错仍返回 HEAD 固定错误并走原 kill 路径', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(undefined, false);
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      log: {
        info: vi.fn(),
        warn: () => {
          throw new Error('diagnostic warn failed');
        },
      },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({
      ok: false,
      errorCode: 'PROCESS_START_FAILED',
      message: 'Node 工作进程启动超时',
    });
    expect(child.killed).toBe(true);
  });

  it('每次 attempt 只读一次粗粒度上下文，getter 异常安全降级', async () => {
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    const debug = vi.fn();
    const getStartAttemptContext = vi.fn(() => ({
      observedMainWindowState: 'focused' as const,
      observedScreenState: 'locked' as const,
    }));
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      getStartAttemptContext,
      log: { debug, info: vi.fn(), warn: vi.fn() },
    });

    await expect(broker.handleRequest('node-ghost', rpcRequest())).resolves.toMatchObject({
      ok: true,
    });
    const attemptContext = debug.mock.calls.find(
      ([message]) => message === 'ghost node startup attempt',
    )?.[1] as Record<string, unknown>;
    expect(getStartAttemptContext).toHaveBeenCalledOnce();
    expect(attemptContext).toEqual({
      ghostId: 'node-ghost',
      entry: 'node/worker.cjs',
      attempt: 1,
      appRunId: TEST_APP_RUN_ID,
      attemptId: TEST_ATTEMPT_ID,
      stage: 'begin',
      observedMainWindowState: 'focused',
      observedScreenState: 'locked',
    });
    broker.destroyAll();

    const fallbackChild = makeAutoReplyProcess();
    const fallbackDebug = vi.fn();
    const fallbackBroker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => fallbackChild as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      getStartAttemptContext: () => {
        throw new Error('diagnostic getter failed');
      },
      log: { debug: fallbackDebug, info: vi.fn(), warn: vi.fn() },
    });
    await expect(fallbackBroker.handleRequest('node-ghost', rpcRequest())).resolves.toMatchObject({
      ok: true,
    });
    expect(fallbackDebug).toHaveBeenCalledWith(
      'ghost node startup attempt',
      expect.objectContaining({
        observedMainWindowState: 'unknown',
        observedScreenState: 'unknown',
      }),
    );
    fallbackBroker.destroyAll();
  });

  it('新增 diagnostic logger 抛错时不影响 ready 与请求成功', async () => {
    const ghost = fakeGhost();
    const child = makeAutoReplyProcess();
    child.onStartupObservation = () => {
      throw new Error('diagnostic subscription failed');
    };
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => TEST_ATTEMPT_ID,
      log: {
        debug: () => {
          throw new Error('diagnostic logger failed');
        },
        info: vi.fn(),
        warn: vi.fn(),
      },
    });

    await expect(
      broker.handleRequest('node-ghost', rpcRequest('logger-fail-open')),
    ).resolves.toMatchObject({ ok: true });
    broker.destroyAll();
  });

  it('main 注入的 appRunId 跨 broker 稳定且 attemptId 每次唯一', async () => {
    const ghost = fakeGhost();
    const starts: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 2; index += 1) {
      const debug = vi.fn((message: string, meta?: Record<string, unknown>) => {
        if (message === 'ghost node startup attempt' && meta) starts.push(meta);
      });
      const broker = new GhostNodeRuntimeBroker({
        getGhost: () => ghost,
        spawnProcess: () => makeAutoReplyProcess() as unknown as NodeWorkerProcess,
        appRunId: TEST_APP_RUN_ID,
        log: { debug, info: vi.fn(), warn: vi.fn() },
      });
      await expect(broker.handleRequest('node-ghost', rpcRequest())).resolves.toMatchObject({
        ok: true,
      });
      broker.destroyAll();
    }

    expect(starts).toHaveLength(2);
    expect(starts[0].appRunId).toBe(starts[1].appRunId);
    expect(starts[0].appRunId).toBe(TEST_APP_RUN_ID);
    expect(starts[0].attemptId).toMatch(/^[0-9a-f]{16,64}$/);
    expect(starts[1].attemptId).toMatch(/^[0-9a-f]{16,64}$/);
    expect(starts[0].attemptId).not.toBe(starts[1].attemptId);
  });
});

describe('nodeRuntimeBroker · 启动瞬时失败重试(2026-07-24)', () => {
  /** 就绪前即崩的假进程:Windows 杀软扫描刚写入的引导产物时的真实形态。 */
  function epermFailingProcess(): FakeNodeProcess {
    const failing = new FakeNodeProcess(undefined, false);
    queueMicrotask(() => {
      failing.stderr.write(
        "node:fs:560\nError: EPERM: operation not permitted, open 'C:\\app\\.vite\\build\\nodeRuntimeWorkerProcess.js'\n",
      );
      failing.emit('exit', 1, null);
    });
    return failing;
  }

  it('就绪前退出自动重试,第二次成功;并发请求共享同一次启动,不发假 crashed', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const pushes: Array<Record<string, unknown>> = [];
    let spawnCount = 0;
    const attemptIds = ['1'.repeat(16), '2'.repeat(16)];
    const getStartAttemptContext = vi.fn(() => ({
      observedMainWindowState: 'hidden' as const,
      observedScreenState: 'idle' as const,
    }));
    const debug = vi.fn();
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      sendToGhost: (_id, payload) => pushes.push(payload as unknown as Record<string, unknown>),
      appRunId: TEST_APP_RUN_ID,
      createAttemptId: () => attemptIds.shift()!,
      getStartAttemptContext,
      log: { debug, info: vi.fn(), warn },
      spawnProcess: () => {
        spawnCount += 1;
        const child = spawnCount === 1 ? epermFailingProcess() : makeAutoReplyProcess();
        return child as unknown as NodeWorkerProcess;
      },
    });

    const first = broker.handleRequest('node-ghost', rpcRequest('first'));
    const second = broker.handleRequest('node-ghost', rpcRequest('second'));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({ ok: true, result: { method: 'first' } });
    await expect(second).resolves.toMatchObject({ ok: true, result: { method: 'second' } });
    expect(spawnCount).toBe(2);
    expect(getStartAttemptContext).toHaveBeenCalledTimes(2);
    const states = pushes.filter((p) => p.name === 'node-status').map((p) => p.state);
    expect(states).toEqual(['starting', 'running']);
    expect(
      debug.mock.calls
        .filter(([message]) => message === 'ghost node startup attempt')
        .map(([, meta]) => (meta as { attemptId: string }).attemptId),
    ).toEqual(['1'.repeat(16), '2'.repeat(16)]);
    expect(warn).toHaveBeenCalledWith(
      'ghost node start attempt failed',
      expect.objectContaining({
        appRunId: TEST_APP_RUN_ID,
        attemptId: '1'.repeat(16),
        outcome: 'failed',
      }),
    );
    const failedAttemptWarnings = warn.mock.calls.filter(
      ([message]) => message === 'ghost node start attempt failed',
    );
    expect(JSON.stringify(failedAttemptWarnings)).not.toMatch(
      /EPERM|nodeRuntimeWorkerProcess|C:\\app/,
    );
    expect(debug).toHaveBeenCalledWith(
      'ghost node startup settlement',
      expect.objectContaining({
        appRunId: TEST_APP_RUN_ID,
        attemptId: '2'.repeat(16),
        outcome: 'ready',
      }),
    );
    broker.destroyAll();
  });

  it('连续失败耗尽重试:失败消息与 crashed 状态都带 stderr 诊断行,crashed 只发一次', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const pushes: Array<Record<string, unknown>> = [];
    let spawnCount = 0;
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      sendToGhost: (_id, payload) => pushes.push(payload as unknown as Record<string, unknown>),
      spawnProcess: () => {
        spawnCount += 1;
        return epermFailingProcess() as unknown as NodeWorkerProcess;
      },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorCode: 'PROCESS_START_FAILED' });
    expect((result as { message?: string }).message).toContain('启动前退出');
    expect((result as { message?: string }).message).toContain('EPERM');
    expect(spawnCount).toBe(3);
    const states = pushes.filter((p) => p.name === 'node-status').map((p) => p.state);
    expect(states).toEqual(['starting', 'crashed']);
    const crashed = pushes.find((p) => p.state === 'crashed') as { message?: string };
    expect(crashed.message).toContain('EPERM');
    expect(broker.stateOf('node-ghost')).toBe('off');
  });

  it('重试退避期间插件被停用:不再拉新进程', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    let enabled = true;
    let spawnCount = 0;
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => (enabled ? ghost : null),
      spawnProcess: () => {
        spawnCount += 1;
        return epermFailingProcess() as unknown as NodeWorkerProcess;
      },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.advanceTimersByTimeAsync(50); // 第一次尝试已失败,退避中
    enabled = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'PROCESS_START_FAILED' });
    expect(spawnCount).toBe(1);
  });

  it('destroyAll 后到达的请求不拉新进程(首次尝试即短路)', async () => {
    const ghost = fakeGhost();
    const spawnProcess = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess,
    });

    broker.destroyAll();
    const result = await broker.handleRequest('node-ghost', rpcRequest());
    expect(result).toMatchObject({ ok: false, errorCode: 'PROCESS_START_FAILED' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('stop(ghostId) 取消在途重试:退避中不再拉新进程', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    let spawnCount = 0;
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => {
        spawnCount += 1;
        return epermFailingProcess() as unknown as NodeWorkerProcess;
      },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.advanceTimersByTimeAsync(50);
    broker.stop('node-ghost');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'PROCESS_START_FAILED' });
    expect(spawnCount).toBe(1);
  });

  it('stop 期间上层禁用阻拦请求;重新启用后 resident 由 startResident 恢复', async () => {
    const ghost = fakeGhost({ lifecycle: 'resident' });
    let enabled = true;
    let spawnCount = 0;
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => (enabled ? ghost : null),
      spawnProcess: () => {
        spawnCount += 1;
        return makeAutoReplyProcess() as unknown as NodeWorkerProcess;
      },
    });

    broker.stop('node-ghost');
    enabled = false;
    const blocked = await broker.handleRequest('node-ghost', rpcRequest());
    expect(blocked).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(spawnCount).toBe(0);

    enabled = true;
    await broker.startResident(ghost);
    expect(spawnCount).toBe(1);
    const ok = await broker.handleRequest('node-ghost', rpcRequest());
    expect(ok).toMatchObject({ ok: true });
    broker.destroyAll();
  });

  it('按需插件 stop 后:上层重新启用时 handleRequest 自动恢复', async () => {
    const ghost = fakeGhost();
    let enabled = true;
    let spawnCount = 0;
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => (enabled ? ghost : null),
      spawnProcess: () => {
        spawnCount += 1;
        return makeAutoReplyProcess() as unknown as NodeWorkerProcess;
      },
    });

    broker.stop('node-ghost');
    enabled = false;
    const blocked = await broker.handleRequest('node-ghost', rpcRequest());
    expect(blocked).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(spawnCount).toBe(0);

    enabled = true;
    const ok = await broker.handleRequest('node-ghost', rpcRequest());
    expect(ok).toMatchObject({ ok: true });
    expect(spawnCount).toBe(1);
    broker.destroyAll();
  });

  it('诊断行不泄露绝对路径', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const pushes: Array<Record<string, unknown>> = [];
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      sendToGhost: (_id, payload) => pushes.push(payload as unknown as Record<string, unknown>),
      spawnProcess: () => {
        const failing = new FakeNodeProcess(undefined, false);
        queueMicrotask(() => {
          failing.stderr.write(
            "Error: EPERM: operation not permitted, open 'C:\\Users\\dev\\AppData\\Local\\cindy\\.vite\\build\\nodeRuntimeWorkerProcess.js'\n",
          );
          failing.emit('exit', 1, null);
        });
        return failing as unknown as NodeWorkerProcess;
      },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest());
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect((result as { message?: string }).message).toContain('EPERM');
    expect((result as { message?: string }).message).not.toContain('C:\\Users');
    expect((result as { message?: string }).message).not.toContain('AppData');
    const crashed = pushes.find((p) => p.state === 'crashed') as { message?: string };
    expect(crashed.message).toContain('EPERM');
    expect(crashed.message).not.toContain('C:\\Users');
    broker.destroyAll();
  });
});

describe('nodeRuntimeBroker · 意外死亡诊断(2026-07-26)', () => {
  it('就绪后崩溃:在途请求与 crashed 状态都带临死前的 stderr 诊断行,且不泄露绝对路径', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess(); // 不回 response,保持在途
    const pushes: Array<Record<string, unknown>> = [];
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      sendToGhost: (_id, payload) => pushes.push(payload as unknown as Record<string, unknown>),
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      log: { info: vi.fn(), warn },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    // 引导层先发 ready、后 require 插件入口,所以这类崩溃发生在启动期之后。
    child.stderr.write(
      "C:\\Users\\dev\\AppData\\Roaming\\cindy\\plugins\\demo\\node\\worker.cjs:74\n" +
        "Object.defineProperty(process, 'stdin', {\n       ^\n\n" +
        'TypeError: Cannot redefine property: stdin\n    at Object.<anonymous>\n',
    );
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('ghost node stderr', expect.anything()),
    );
    child.emit('exit', 1, null);
    child.stderr.end();

    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorCode: 'PROCESS_EXITED' });
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('code=1');
    expect(message).toContain('Cannot redefine property: stdin');
    expect(message).not.toContain('C:\\Users');
    expect(message).not.toContain('AppData');
    const crashed = pushes.find((p) => p.state === 'crashed') as { message?: string };
    expect(crashed.message).toContain('Cannot redefine property: stdin');
    expect(crashed.message).not.toContain('C:\\Users');
  });

  it('陈旧 stderr 不当死因:超过回看窗口只报退出码', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.advanceTimersByTimeAsync(10);
    child.stderr.write('compiling scene 1...\n');
    await vi.advanceTimersByTimeAsync(6_000);
    child.emit('exit', 1, null);
    child.stderr.end();
    await vi.advanceTimersByTimeAsync(10);

    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorCode: 'PROCESS_EXITED' });
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('code=1');
    expect(message).not.toContain('compiling scene 1');
  });

  it('exit 前的 drain 窗口:stderr 在 exit 后到达仍可截获', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.advanceTimersByTimeAsync(10);
    child.emit('exit', 1, null);
    // stderr 晚于 exit 到达(管道中的最后一段)
    child.stderr.write('Error: EACCES permission denied\n');
    child.stderr.end();
    await vi.advanceTimersByTimeAsync(10);

    const result = await pending;
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('EACCES permission denied');
  });

  it('含空格的 Windows 路径被完整收敛为文件名', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      log: { info: vi.fn(), warn },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    child.stderr.write(
      'Error: Cannot find module\n' +
        '    at C:\\Users\\Jane Doe\\AppData\\Roaming\\cindy\\plugins\\demo\\worker.cjs:12\n',
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    child.emit('exit', 1, null);
    child.stderr.end();

    const result = await pending;
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('Cannot find module');
    expect(message).not.toContain('Jane Doe');
    expect(message).not.toContain('AppData');
  });

  it('含空格的 POSIX 路径被完整收敛为文件名', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      log: { info: vi.fn(), warn },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    child.stderr.write(
      'Error: ENOENT /Users/jane/Library/Application Support/Cindy/plugins/demo/worker.cjs\n',
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    child.emit('exit', 1, null);
    child.stderr.end();

    const result = await pending;
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('Application Support');
    expect(message).not.toContain('/Users/jane');
  });

  it('含撇号的 unquoted 路径被完整收敛为文件名', async () => {
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      log: { info: vi.fn(), warn },
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    child.stderr.write(
      "Error: ENOENT\n    at C:\\Users\\O'Brien\\AppData\\Roaming\\cindy\\worker.js:12\n",
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    child.emit('exit', 1, null);
    child.stderr.end();

    const result = await pending;
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('ENOENT');
    expect(message).not.toContain("O'Brien");
    expect(message).not.toContain('AppData');
  });

  it('陈旧段不被后续良性 chunk 携带进回看窗口', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const child = new FakeNodeProcess();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
    });

    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.advanceTimersByTimeAsync(10);
    // 10 秒前写入一条错误日志
    child.stderr.write('Error: old failure from initialization\n');
    await vi.advanceTimersByTimeAsync(10_000);
    // 紧邻退出前写入一条良性日志
    child.stderr.write('heartbeat ok\n');
    await vi.advanceTimersByTimeAsync(100);
    child.emit('exit', 1, null);
    child.stderr.end();
    await vi.advanceTimersByTimeAsync(10);

    const result = await pending;
    const message = (result as { message?: string }).message ?? '';
    // 只有"heartbeat ok"在窗口内,选取的诊断行不应含旧错误
    expect(message).not.toContain('old failure from initialization');
  });

  it('凭证值出现在 stderr 诊断行中时被脱敏', async () => {
    const ghost = fakeGhost();
    // secretBindings 绑定到所有方法(包括 slow)
    ghost.manifest.node!.secretBindings = [
      { key: 'api_key', label: 'API Key', methods: ['slow'] },
    ];
    const child = new FakeNodeProcess();
    const readSecret = vi.fn(() => 'sk-secret-token-12345');
    const warn = vi.fn();
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      readSecret,
      spawnProcess: () => child as unknown as NodeWorkerProcess,
      log: { info: vi.fn(), warn },
    });

    // 发一个带凭证的请求并保持 pending(不回复)
    const pending = broker.handleRequest('node-ghost', rpcRequest('slow'));
    await vi.waitFor(() => expect(child.received).toHaveLength(1));
    child.stderr.write('Error: auth failed with token sk-secret-token-12345\n');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    child.emit('exit', 1, null);
    child.stderr.end();

    const result = await pending;
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('sk-secret-token-12345');
  });
});

describe('nodeRuntimeBroker · 权限与协议', () => {
  it('没声明 node 槽时拒绝且不启动进程', async () => {
    const ghost = fakeGhost();
    delete ghost.manifest.node;
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

  it('raw stderr 的“_”在 t=800ms 同 tick 到达 broker 并保持 HEAD 续命', async () => {
    vi.useFakeTimers();
    const ghost = fakeGhost();
    const utilityChild = new FakeUtilityProcess();
    const worker = createUtilityNodeWorkerProcess(
      '/fake/node-ghost/node/worker.cjs',
      '/fake/node-ghost',
      'node-ghost',
      vi.fn(() => utilityChild) as never,
    );
    const broker = new GhostNodeRuntimeBroker({
      getGhost: () => ghost,
      spawnProcess: () => worker,
    });
    const pending = broker.handleRequest('node-ghost', {
      ...rpcRequest('build/run'),
      timeoutMs: 1_000,
      maxTotalMs: 10_000,
    });
    utilityChild.emit('message', { type: 'ready' });
    await vi.runAllTicks();
    expect(worker.stderr).toBe(utilityChild.stderr);
    expect(utilityChild.stderr.listenerCount('error')).toBe(0);

    await vi.advanceTimersByTimeAsync(800);
    utilityChild.stderr.write('_');
    await vi.advanceTimersByTimeAsync(800);
    const stdinFrame = utilityChild.postMessage.mock.calls
      .map(([message]) => message as { type?: string; chunk?: string })
      .find(({ type }) => type === 'stdin');
    const request = JSON.parse(String(stdinFrame?.chunk).trim()) as { id: string };
    utilityChild.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { built: true } })}\n`,
    );
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

  async function bootWorker(
    ghost: InstalledGhost,
    spawnChild?: () => FakeRawChild,
    autoSpawnChild = true,
  ) {
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
        if (autoSpawnChild) queueMicrotask(() => child.emit('spawn'));
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

  it('stopAndWait 等待尚未触发 spawn 的已 fork 子进程退出', async () => {
    const startingChild = new FakeRawChild();
    const { broker, worker, spawned } = await bootWorker(
      childSpawnGhost(),
      () => startingChild,
      false,
    );
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));

    let settled = false;
    const stopping = broker.stopAndWait('node-ghost').then(() => {
      settled = true;
    });
    expect(startingChild.killed).toBe(true);
    expect(settled).toBe(false);

    await stopping;
    expect(settled).toBe(true);
  });

  it('正式子进程 error 后仍保留记账，直到真实 exit 或有界失败', async () => {
    vi.useFakeTimers();
    const { broker, worker, spawned } = await bootWorker(childSpawnGhost());
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs' });
    await vi.waitFor(() => {
      expect(worker.lastOf('spawn-child-result')).toMatchObject({ reqId: 'r1', ok: true });
    });
    const child = spawned[0].child;
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      child.killed = true;
      return true;
    });

    child.emit('error', new Error('child transport broke'));
    expect(kill).toHaveBeenCalledWith('SIGTERM');

    const stopping = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止超时',
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('父 worker 退出后仍等待尚未真实退出的子进程', async () => {
    vi.useFakeTimers();
    const { broker, worker, spawned } = await bootWorker(childSpawnGhost());
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs' });
    await vi.waitFor(() => {
      expect(worker.lastOf('spawn-child-result')).toMatchObject({ reqId: 'r1', ok: true });
    });
    const child = spawned[0].child;
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      child.killed = true;
      return true;
    });

    worker.emit('exit', 1, null);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    const stopping = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止超时',
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('启动中子进程报错时仍保留停止后的 SIGKILL 兜底', async () => {
    vi.useFakeTimers();
    const startingChild = new FakeRawChild();
    const kill = vi.spyOn(startingChild, 'kill').mockImplementation(() => {
      startingChild.killed = true;
      return true;
    });
    const { broker, worker, spawned } = await bootWorker(
      childSpawnGhost(),
      () => startingChild,
      false,
    );
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));

    const stopping = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止失败',
    );
    startingChild.emit('error', new Error('child transport broke'));
    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('非停止状态的启动错误也会强杀并保留记账直到 exit', async () => {
    vi.useFakeTimers();
    const startingChild = new FakeRawChild();
    const kill = vi.spyOn(startingChild, 'kill').mockImplementation(() => {
      startingChild.killed = true;
      return true;
    });
    const { broker, worker, spawned } = await bootWorker(
      childSpawnGhost(),
      () => startingChild,
      false,
    );
    worker.emitControl({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));

    startingChild.emit('error', new Error('child transport broke'));
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGKILL'));

    const stopping = expect(broker.stopAndWait('node-ghost')).rejects.toThrow(
      '插件 Node 进程停止超时',
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;
  });
});
