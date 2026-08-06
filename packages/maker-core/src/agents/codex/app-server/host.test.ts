import { describe, expect, it, vi } from 'vitest';

import { AppServerHost } from './host.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { Transport, LineHandler, StderrHandler, CloseHandler } from './transport.js';

/** 任何请求都永不回应的 transport — 模拟远端 daemon bootstrap 挂死 / SSH 通道无响应。 */
class HangingTransport implements Transport {
  private readonly closeHandlers = new Set<CloseHandler>();

  async writeLine(_line: string): Promise<void> {
    // 请求照收, 永远不回 response → initialize 挂起。
  }

  onLine(_handler: LineHandler): () => void {
    return () => {};
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStderr(_handler: StderrHandler): () => void {
    return () => {};
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }
}

/** 所有请求延迟 respondDelayMs 回应的 transport — initialize 最终能完成。 */
class DelayedTransport implements Transport {
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  constructor(private readonly respondDelayMs: number) {}

  async writeLine(line: string): Promise<void> {
    const msg = JSON.parse(line) as { id?: unknown };
    if (msg.id == null) return; // notification (initialized 等), 无 response
    setTimeout(() => {
      const result = {
        userAgent: 'mock-codex/test',
        codexHome: '/tmp/codex-home',
        platformOs: 'linux',
      };
      for (const handler of this.lineHandlers) handler(JSON.stringify({ id: msg.id, result }));
    }, this.respondDelayMs);
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStderr(_handler: StderrHandler): () => void {
    return () => {};
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }
}

class NotificationTransport implements Transport {
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  readonly lines: string[] = [];

  constructor(
    private readonly resultForMethod?: (method: string) => unknown,
  ) {}

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
    const msg = JSON.parse(line) as { id?: unknown; method?: string };
    if (msg.id == null) return;
    const result = msg.method === 'initialize'
      ? {
          userAgent: 'mock-codex/test',
          codexHome: '/tmp/codex-home',
          platformOs: 'linux',
        }
      : this.resultForMethod?.(msg.method ?? '') ?? {};
    this.emit({ id: msg.id, result });
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStderr(_handler: StderrHandler): () => void {
    return () => {};
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }

  emit(message: unknown): void {
    const line = JSON.stringify(message);
    for (const handler of this.lineHandlers) handler(line);
  }
}

describe('AppServerHost MCP readiness', () => {
  it('retries a negative tool probe instead of permanently caching it', async () => {
    let available = false;
    const transport = new NotificationTransport((method) => (
      method === 'mcpServerStatus/list'
        ? {
            data: [{
              name: 'node_repl',
              tools: available ? { js: {} } : {},
              authStatus: 'notApplicable',
            }],
            nextCursor: null,
          }
        : {}
    ));
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
      codexBrowserUseStartupTimeoutMs: 10,
    });

    await expect(host.waitForMcpTool('node_repl', 'js')).resolves.toBe(false);
    available = true;
    await expect(host.waitForMcpTool('node_repl', 'js')).resolves.toBe(true);

    await host.shutdown();
  });

  it('re-probes MCP readiness after the app-server respawns', async () => {
    const firstTransport = new NotificationTransport((method) => (
      method === 'mcpServerStatus/list'
        ? {
            data: [{ name: 'node_repl', tools: { js: {} }, authStatus: 'notApplicable' }],
            nextCursor: null,
          }
        : {}
    ));
    const secondTransport = new NotificationTransport((method) => (
      method === 'mcpServerStatus/list'
        ? {
            data: [{ name: 'node_repl', tools: {}, authStatus: 'notApplicable' }],
            nextCursor: null,
          }
        : {}
    ));
    const transports = [firstTransport, secondTransport];
    const createTransport = vi.fn(() => transports.shift() ?? secondTransport);
    const host = new AppServerHost({
      createTransport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
      codexBrowserUseStartupTimeoutMs: 10,
    });

    await expect(host.waitForMcpTool('node_repl', 'js')).resolves.toBe(true);
    await host.shutdown();
    await expect(host.waitForMcpTool('node_repl', 'js')).resolves.toBe(false);

    expect(createTransport).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });
});

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
};

describe('AppServerHost.request startup timeout', () => {
  it('bounds a hung ensureStarted by the caller-provided timeoutMs (greptile R6 P1)', async () => {
    // 冷启动 / transport 重建时 ensureStarted 本身也可能永不返回 — 调用方显式
    // 给的 timeoutMs 必须同样覆盖启动路径, 否则「关键 RPC 加超时」形同虚设。
    const host = new AppServerHost({
      createTransport: () => new HangingTransport(),
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    await expect(host.request('turn/start', {}, { timeoutMs: 50 })).rejects.toThrow(
      'app-server startup (for turn/start) timed out after 50ms',
    );

    await host.shutdown();
  });

  it('keeps the in-flight bootstrap reusable for a later request after a startup timeout', async () => {
    // 超时只截断本次等待 — bootstrap 仍在后台继续 (startPromise 保留),
    // 后续 request 直接复用, 不重新 spawn。
    const createTransport = vi.fn(() => new DelayedTransport(60));
    const host = new AppServerHost({
      createTransport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    await expect(host.request('turn/start', {}, { timeoutMs: 20 })).rejects.toThrow(
      /app-server startup.*timed out/,
    );

    // 后台 bootstrap (60ms) 完成后, 同一个 startPromise 直接可用。
    await expect(host.request('turn/start', {}, { timeoutMs: 1_000 })).resolves.toMatchObject({
      userAgent: 'mock-codex/test',
    });
    expect(createTransport).toHaveBeenCalledTimes(1);

    await host.shutdown();
  });

  it('treats timeoutMs as an overall deadline across startup + request (copilot R9)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // timeoutMs 不是「startup 一次 + request 再一次」的双重施加: startup 用掉
    // 的预算要从 request 里扣, 最坏等待仍是 1× timeoutMs — 否则 60s 关键 RPC
    // 在冷启动路径上最坏拖到 ~120s, UI 长时间卡 generating。
    // fake clock 下 DelayedTransport(40): startup 精确用掉 40ms,
    // 50ms overall deadline 只剩 10ms 给 request; 若误变成 2× 语义则要到 90ms。
    const host = new AppServerHost({
      createTransport: () => new DelayedTransport(40),
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    try {
      const request = host.request('turn/start', {}, { timeoutMs: 50 });
      const settled = vi.fn();
      void request.then(settled, settled);
      const rejection = expect(request).rejects.toThrow(
        'codex app-server turn/start timed out after 10ms',
      );

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      await host.shutdown();
      vi.useRealTimers();
    }
  });
});

describe('AppServerHost.ensureStartedWithTimeout', () => {
  it('rejects when startup hangs past the budget and keeps the shared bootstrap reusable (codex R13 P1)', async () => {
    // startSession 的 initialize 直调与 request() 的 startup deadline 同款语义:
    // 超时只截断本次等待, startPromise 后台继续, 后续调用直接复用不重新 spawn。
    const createTransport = vi.fn(() => new DelayedTransport(60));
    const host = new AppServerHost({
      createTransport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    await expect(host.ensureStartedWithTimeout(20, 'startSession initialize')).rejects.toThrow(
      'app-server startup (for startSession initialize) timed out after 20ms',
    );

    // 后台 bootstrap (60ms) 完成后, 同一个 startPromise 直接可用。
    await expect(host.ensureStartedWithTimeout(1_000, 'startSession initialize')).resolves.toMatchObject({
      userAgent: 'mock-codex/test',
    });
    expect(createTransport).toHaveBeenCalledTimes(1);

    await host.shutdown();
  });
});

describe('AppServerHost descendant thread routing', () => {
  it('routes child and grandchild thread/started events to the root subscription', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const descendantThreadStarted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantThreadStarted,
    });

    transport.emit({
      method: 'thread/started',
      params: {
        thread: {
          id: 'child-thread',
          parentThreadId: 'root-thread',
        },
      },
    });
    transport.emit({
      method: 'thread/started',
      params: {
        thread: {
          id: 'grandchild-thread',
          parentThreadId: 'child-thread',
        },
      },
    });

    expect(descendantThreadStarted).toHaveBeenNthCalledWith(1, {
      thread: {
        id: 'child-thread',
        parentThreadId: 'root-thread',
      },
    });
    expect(descendantThreadStarted).toHaveBeenNthCalledWith(2, {
      thread: {
        id: 'grandchild-thread',
        parentThreadId: 'child-thread',
      },
    });

    await subscription.release();
    transport.emit({
      method: 'thread/started',
      params: {
        thread: {
          id: 'great-grandchild-thread',
          parentThreadId: 'grandchild-thread',
        },
      },
    });
    expect(descendantThreadStarted).toHaveBeenCalledTimes(2);

    await host.shutdown();
  });

  it('rebuilds buffered descendant lineage when the root subscribes after child starts', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    // Cross-thread notifications can arrive out of lineage order. Both starts are
    // buffered under their own child ids because the root has not subscribed yet.
    transport.emit({
      method: 'thread/started',
      params: {
        thread: {
          id: 'grandchild-thread',
          parentThreadId: 'child-thread',
        },
      },
    });
    transport.emit({
      method: 'thread/started',
      params: {
        thread: {
          id: 'child-thread',
          parentThreadId: 'root-thread',
        },
      },
    });

    const descendantThreadStarted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantThreadStarted,
    });

    expect(descendantThreadStarted).toHaveBeenCalledTimes(2);
    expect(descendantThreadStarted).toHaveBeenCalledWith({
      thread: {
        id: 'child-thread',
        parentThreadId: 'root-thread',
      },
    });
    expect(descendantThreadStarted).toHaveBeenCalledWith({
      thread: {
        id: 'grandchild-thread',
        parentThreadId: 'child-thread',
      },
    });

    await subscription.release();
    await host.shutdown();
  });

  it('registerDescendantLineage routes child notifications without any thread/started (codex 0.145)', async () => {
    // 0.145 只对显式 thread/start / fork RPC 发 thread/started;spawn 出的子线程
    // 只有 item / turn / tokenUsage 通知。血缘必须能由 Cindy 侧(从 spawn item)
    // 主动登记,否则这些通知全部在 TTL 缓冲里过期,子代理卡永久转圈。
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const descendantNotification = vi.fn();
    const descendantThreadStarted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantNotification,
      descendantThreadStarted,
    });

    // 早到:子线程通知先于 spawn item 被处理,落进 TTL 缓冲。
    transport.emit({
      method: 'turn/started',
      params: { threadId: 'child-thread', turn: { id: 'turn-1' } },
    });

    host.registerDescendantLineage('child-thread', 'root-thread');

    // 缓冲的早到通知按序补投,后续通知实时路由;全程没有任何 thread/started。
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'child-thread', turn: { id: 'turn-1', status: 'completed' } },
    });
    expect(descendantNotification).toHaveBeenNthCalledWith(
      1,
      'child-thread',
      'turn/started',
      { threadId: 'child-thread', turn: { id: 'turn-1' } },
    );
    expect(descendantNotification).toHaveBeenNthCalledWith(
      2,
      'child-thread',
      'turn/completed',
      { threadId: 'child-thread', turn: { id: 'turn-1', status: 'completed' } },
    );

    // 血缘重复:新版 codex 补发同一条边的 thread/started 不重复建边、不重放缓冲,
    // 但通知本身仍要转发——它携带的 thread.model 是实际模型的唯一观测入口(codex review)。
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread', model: 'gpt-5.6-terra' } },
    });
    expect(descendantThreadStarted).toHaveBeenCalledTimes(1);
    expect(descendantThreadStarted).toHaveBeenCalledWith({
      thread: { id: 'child-thread', parentThreadId: 'root-thread', model: 'gpt-5.6-terra' },
    });
    expect(descendantNotification).toHaveBeenCalledTimes(2);

    await subscription.release();
    await host.shutdown();
  });

  it('replays a buffered child thread/started before draining ordinary notifications', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    // Root subscription is late. The child metadata and lifecycle arrive first,
    // then the root spawn item is buffered under the root id.
    transport.emit({
      method: 'thread/started',
      params: {
        thread: {
          id: 'child-thread',
          parentThreadId: 'root-thread',
          model: 'codex/gpt-5.6-sol',
        },
      },
    });
    transport.emit({
      method: 'turn/started',
      params: { threadId: 'child-thread', turn: { id: 'child-turn' } },
    });
    transport.emit({
      method: 'item/started',
      params: {
        threadId: 'root-thread',
        turnId: 'root-turn',
        item: { id: 'spawn-1', type: 'subAgentActivity', agentThreadId: 'child-thread' },
      },
    });

    const observed: string[] = [];
    const subscription = host.subscribeThread('root-thread', {
      itemStarted: () => {
        observed.push('spawn');
        host.registerDescendantLineage('child-thread', 'root-thread');
      },
      descendantThreadStarted: (params) => {
        observed.push(`model:${params.thread.model ?? ''}`);
      },
      descendantNotification: (_threadId, method) => {
        observed.push(method);
      },
    });

    expect(observed).toEqual([
      'spawn',
      'model:codex/gpt-5.6-sol',
      'turn/started',
    ]);

    await subscription.release();
    await host.shutdown();
  });

  it('registerDescendantLineage unlocks a buffered grandchild thread/started chain', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const descendantThreadStarted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantThreadStarted,
    });

    // 孙线程的 thread/started(新版 codex 才会发)先到,此时子线程尚无血缘,缓冲。
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'grandchild-thread', parentThreadId: 'child-thread' } },
    });
    expect(descendantThreadStarted).not.toHaveBeenCalled();

    // 子线程血缘由 spawn item 路径登记 → 缓冲中的孙线程血缘应被递归重建。
    host.registerDescendantLineage('child-thread', 'root-thread');
    expect(descendantThreadStarted).toHaveBeenCalledWith({
      thread: { id: 'grandchild-thread', parentThreadId: 'child-thread' },
    });

    await subscription.release();
    await host.shutdown();
  });

  it('routes descendant server requests to the root subscription handlers', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const commandExecutionApproval = vi.fn(async () => ({ decision: 'accept' as const }));
    const fileChangeApproval = vi.fn(async () => ({ decision: 'accept' as const }));
    const mcpServerElicitation = vi.fn(async () => ({
      action: 'accept' as const,
      content: { value: 'ok' },
      _meta: null,
    }));
    const permissionsApproval = vi.fn(async () => ({
      permissions: { network: true },
      scope: 'turn' as const,
    }));
    const requestUserInput = vi.fn(async (_params, meta) => ({
      answers: { q1: { answers: [`request:${String(meta.requestId)}`] } },
    }));
    const dynamicToolCall = vi.fn(async (_params, meta) => ({
      contentItems: [{ type: 'inputText' as const, text: `request:${String(meta.requestId)}` }],
      success: true,
    }));
    const subscription = host.subscribeThread('root-thread', {
      commandExecutionApproval,
      fileChangeApproval,
      mcpServerElicitation,
      permissionsApproval,
      requestUserInput,
      dynamicToolCall,
    });

    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread' } },
    });

    const requests = [
      {
        id: 'server-command',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'child-thread', turnId: 'turn-1', itemId: 'item-1' },
        expected: { decision: 'accept' },
      },
      {
        id: 'server-file',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'child-thread', turnId: 'turn-1', itemId: 'item-2' },
        expected: { decision: 'accept' },
      },
      {
        id: 'server-elicitation',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'child-thread',
          turnId: 'turn-1',
          serverName: 'test-mcp',
          mode: 'form',
          _meta: null,
          message: 'Confirm',
          requestedSchema: {},
        },
        expected: { action: 'accept', content: { value: 'ok' }, _meta: null },
      },
      {
        id: 'server-permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'child-thread',
          turnId: 'turn-1',
          itemId: 'item-3',
          permissions: { network: true },
        },
        expected: { permissions: { network: true }, scope: 'turn' },
      },
      {
        id: 'server-input',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'child-thread',
          turnId: 'turn-1',
          itemId: 'item-4',
          questions: [],
        },
        expected: { answers: { q1: { answers: ['request:server-input'] } } },
      },
      {
        id: 'server-tool',
        method: 'item/tool/call',
        params: {
          threadId: 'child-thread',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: null,
          tool: 'test_tool',
          arguments: {},
        },
        expected: {
          contentItems: [{ type: 'inputText', text: 'request:server-tool' }],
          success: true,
        },
      },
    ] as const;

    const initialLineCount = transport.lines.length;
    for (const request of requests) {
      transport.emit(request);
    }

    await vi.waitFor(() => {
      expect(transport.lines.length).toBe(initialLineCount + requests.length);
    });
    const responses = transport.lines
      .slice(initialLineCount)
      .map((line) => JSON.parse(line) as { id: string; result: unknown });
    expect(responses).toEqual(
      requests.map((request) => ({ id: request.id, result: request.expected })),
    );
    expect(commandExecutionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'child-thread' }),
    );
    expect(fileChangeApproval).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'child-thread' }),
    );
    expect(mcpServerElicitation).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'child-thread' }),
    );
    expect(permissionsApproval).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'child-thread' }),
    );
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'child-thread' }),
      { requestId: 'server-input' },
    );
    expect(dynamicToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'child-thread' }),
      { requestId: 'server-tool' },
    );

    await subscription.release();
    await host.shutdown();
  });

  it('briefly waits for descendant lineage before declining an MCP elicitation', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const mcpServerElicitation = vi.fn(async () => ({
      action: 'accept' as const,
      content: { value: 'ok' },
      _meta: null,
    }));
    const subscription = host.subscribeThread('root-thread', { mcpServerElicitation });
    const initialLineCount = transport.lines.length;

    // The request is dispatched asynchronously. Emit the lineage notification
    // immediately afterwards to reproduce the observed cross-message race.
    transport.emit({
      id: 'early-elicitation',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'child-thread',
        turnId: 'turn-1',
        serverName: 'node_repl',
        mode: 'form',
        _meta: null,
        message: 'Confirm',
        requestedSchema: {},
      },
    });
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread' } },
    });

    await vi.waitFor(() => {
      expect(transport.lines.length).toBe(initialLineCount + 1);
    });
    expect(JSON.parse(transport.lines.at(-1)!)).toEqual({
      id: 'early-elicitation',
      result: { action: 'accept', content: { value: 'ok' }, _meta: null },
    });
    expect(mcpServerElicitation).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'child-thread', serverName: 'node_repl' }),
    );

    await subscription.release();
    await host.shutdown();
  });

  it('keeps known descendant request dispatch synchronous before a resolved notification', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const order: string[] = [];
    const subscription = host.subscribeThread('root-thread', {
      requestUserInput: vi.fn(async () => {
        order.push('request');
        return { answers: {} };
      }),
      serverRequestResolved: vi.fn(() => {
        order.push('resolved');
      }),
    });
    transport.emit({
      id: 'known-request',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'root-thread',
        turnId: 'root-turn',
        itemId: 'input',
        questions: [{ id: 'q1', header: 'Q', question: 'Continue?', options: [] }],
      },
    });
    transport.emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'root-thread', requestId: 'known-request' },
    });

    await vi.waitFor(() => {
      expect(order).toEqual(['request', 'resolved']);
    });

    await subscription.release();
    await host.shutdown();
  });

  it('registers provisional descendant request brokers before replaying resolved notifications', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const order: string[] = [];
    const subscription = host.subscribeThread('root-thread', {
      requestUserInput: vi.fn(async (_params, meta) => {
        order.push(`request:${String(meta.requestId)}`);
        return { answers: {} };
      }),
      dynamicToolCall: vi.fn(async (_params, meta) => {
        order.push(`request:${String(meta.requestId)}`);
        return { contentItems: [], success: false };
      }),
      descendantNotification: (_threadId, method, params) => {
        if (method !== 'serverRequest/resolved') return;
        order.push(`resolved:${String((params as { requestId: string }).requestId)}`);
      },
    });

    host.reserveDescendantLineage('child-thread', 'root-thread');
    transport.emit({
      id: 'pending-input',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'child-thread',
        turnId: 'child-turn',
        itemId: 'input',
        questions: [{ id: 'q1', header: 'Q', question: 'Continue?', options: [] }],
      },
    });
    transport.emit({
      id: 'pending-tool',
      method: 'item/tool/call',
      params: {
        threadId: 'child-thread',
        turnId: 'child-turn',
        callId: 'tool',
        namespace: null,
        tool: 'ask_user',
        arguments: {},
      },
    });
    transport.emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'child-thread', requestId: 'pending-input' },
    });
    transport.emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'child-thread', requestId: 'pending-tool' },
    });

    host.registerDescendantLineage('child-thread', 'root-thread');

    await vi.waitFor(() => {
      expect(order).toEqual([
        'request:pending-input',
        'request:pending-tool',
        'resolved:pending-input',
        'resolved:pending-tool',
      ]);
    });

    await subscription.release();
    await host.shutdown();
  });

  it('declines an MCP elicitation whose lineage stays unknown for the bounded window', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
      notificationBufferTtlMs: 20,
    });
    await host.ensureStarted();

    const mcpServerElicitation = vi.fn();
    const subscription = host.subscribeThread('root-thread', { mcpServerElicitation });
    const initialLineCount = transport.lines.length;
    transport.emit({
      id: 'unknown-elicitation',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'unknown-thread',
        turnId: 'turn-1',
        serverName: 'node_repl',
        mode: 'form',
        _meta: null,
        message: 'Confirm',
        requestedSchema: {},
      },
    });

    await vi.waitFor(() => {
      expect(transport.lines.length).toBe(initialLineCount + 1);
    });
    expect(JSON.parse(transport.lines.at(-1)!)).toEqual({
      id: 'unknown-elicitation',
      result: { action: 'decline', content: null, _meta: null },
    });
    expect(mcpServerElicitation).not.toHaveBeenCalled();

    await subscription.release();
    await host.shutdown();
  });

  it('holds all descendant server requests behind a pending spawn claim until commit', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
      notificationBufferTtlMs: 20,
    });
    await host.ensureStarted();

    const subscription = host.subscribeThread('root-thread', {
      commandExecutionApproval: vi.fn(async () => ({ decision: 'accept' as const })),
      fileChangeApproval: vi.fn(async () => ({ decision: 'accept' as const })),
      permissionsApproval: vi.fn(async () => ({ permissions: { network: true }, scope: 'turn' as const })),
      requestUserInput: vi.fn(async () => ({ answers: { q1: { answers: ['ok'] } } })),
      dynamicToolCall: vi.fn(async () => ({
        contentItems: [{ type: 'inputText' as const, text: 'ok' }],
        success: true,
      })),
      mcpServerElicitation: vi.fn(async () => ({
        action: 'accept' as const,
        content: { value: 'ok' },
        _meta: null,
      })),
    });

    const requests = [
      { id: 'pending-command', method: 'item/commandExecution/requestApproval', params: { threadId: 'child-thread', turnId: 'child-turn', itemId: 'command' } },
      { id: 'pending-file', method: 'item/fileChange/requestApproval', params: { threadId: 'child-thread', turnId: 'child-turn', itemId: 'file' } },
      { id: 'pending-permissions', method: 'item/permissions/requestApproval', params: { threadId: 'child-thread', turnId: 'child-turn', itemId: 'permissions', permissions: { network: true } } },
      { id: 'pending-input', method: 'item/tool/requestUserInput', params: { threadId: 'child-thread', turnId: 'child-turn', itemId: 'input', questions: [] } },
      { id: 'pending-tool', method: 'item/tool/call', params: { threadId: 'child-thread', turnId: 'child-turn', callId: 'tool', namespace: null, tool: 'test', arguments: {} } },
      { id: 'pending-elicitation', method: 'mcpServer/elicitation/request', params: { threadId: 'child-thread', turnId: 'child-turn', serverName: 'test-mcp', mode: 'form', _meta: null, message: 'Confirm', requestedSchema: {} } },
    ] as const;
    const initialLineCount = transport.lines.length;
    for (const request of requests) transport.emit(request);

    // The parent spawn is known, but not yet accepted by turn reconciliation.
    host.reserveDescendantLineage('child-thread', 'root-thread');
    await Promise.resolve();
    expect(transport.lines).toHaveLength(initialLineCount);

    host.registerDescendantLineage('child-thread', 'root-thread');
    await vi.waitFor(() => {
      expect(transport.lines).toHaveLength(initialLineCount + requests.length);
    });

    const responses = transport.lines
      .slice(initialLineCount)
      .map((line) => JSON.parse(line) as { id: string; result: unknown });
    expect(responses.map((response) => response.id)).toEqual(requests.map((request) => request.id));

    await subscription.release();
    await host.shutdown();
  });

  it('keeps pending child buffers alive until commit and drops them on discard', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
      notificationBufferTtlMs: 10,
    });
    await host.ensureStarted();

    const descendantThreadStarted = vi.fn();
    const descendantNotification = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantThreadStarted,
      descendantNotification,
    });

    host.reserveDescendantLineage('child-thread', 'root-thread');
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread', model: 'gpt-5.6-terra' } },
    });
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(descendantThreadStarted).not.toHaveBeenCalled();
    expect(descendantNotification).not.toHaveBeenCalled();

    host.registerDescendantLineage('child-thread', 'root-thread');
    expect(descendantThreadStarted).toHaveBeenCalledWith({
      thread: { id: 'child-thread', parentThreadId: 'root-thread', model: 'gpt-5.6-terra' },
    });
    expect(descendantNotification).toHaveBeenCalledWith(
      'child-thread',
      'turn/completed',
      { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed' } },
    );

    host.reserveDescendantLineage('orphan-child', 'root-thread');
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'orphan-child', turn: { id: 'orphan-turn', status: 'completed' } },
    });
    host.discardPendingDescendantLineage('orphan-child', 'root-thread');
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'orphan-child', turn: { id: 'late-turn', status: 'completed' } },
    });
    expect(descendantNotification).not.toHaveBeenCalledWith(
      'orphan-child',
      expect.anything(),
      expect.anything(),
    );

    await subscription.release();
    await host.shutdown();
  });
});

describe('AppServerHost descendant notification routing', () => {
  it('routes descendant item/tokenUsage/turn notifications to the root descendant channel only', async () => {
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const descendantNotification = vi.fn();
    const itemStarted = vi.fn();
    const tokenUsageUpdated = vi.fn();
    const turnCompleted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantNotification,
      itemStarted,
      tokenUsageUpdated,
      turnCompleted,
    });

    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread' } },
    });
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'grandchild-thread', parentThreadId: 'child-thread' } },
    });

    const childItem = {
      method: 'item/started',
      params: { threadId: 'child-thread', turnId: 'turn-c1', item: { id: 'i-1', type: 'commandExecution' } },
    };
    const childUsage = {
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'child-thread', turnId: 'turn-c1', tokenUsage: { total: { totalTokens: 42 } } },
    };
    const grandchildTurn = {
      method: 'turn/completed',
      params: { threadId: 'grandchild-thread', turn: { id: 'turn-g1', status: 'completed' } },
    };
    transport.emit(childItem);
    transport.emit(childUsage);
    transport.emit(grandchildTurn);

    expect(descendantNotification.mock.calls).toEqual([
      ['child-thread', 'item/started', childItem.params],
      ['child-thread', 'thread/tokenUsage/updated', childUsage.params],
      ['grandchild-thread', 'turn/completed', grandchildTurn.params],
    ]);
    // 关键隔离:子线程事件绝不能进主线程 handler —— 否则子代理的 exec 会被渲染成
    // 主会话自己的工具调用,并污染主 turn 的 usage 与状态机。
    expect(itemStarted).not.toHaveBeenCalled();
    expect(tokenUsageUpdated).not.toHaveBeenCalled();
    expect(turnCompleted).not.toHaveBeenCalled();

    // 主线程自己的同名事件照旧走主通道。
    transport.emit({
      method: 'item/started',
      params: { threadId: 'root-thread', turnId: 'turn-r1', item: { id: 'i-2', type: 'commandExecution' } },
    });
    expect(itemStarted).toHaveBeenCalledTimes(1);
    expect(descendantNotification).toHaveBeenCalledTimes(3);

    await subscription.release();
    transport.emit(childItem);
    expect(descendantNotification).toHaveBeenCalledTimes(3);
    // thread/started 只走专用的 descendantThreadStarted,不重复出现在本通道。
    expect(descendantNotification.mock.calls.some(([, method]) => method === 'thread/started')).toBe(false);

    await host.shutdown();
  });

  it('keeps buffering notifications for threads with no known lineage', async () => {
    // 未知线程仍走 TTL 缓冲(解 subscribe 竞争);只有血缘已知的子线程才就地收口。
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    transport.emit({
      method: 'item/started',
      params: { threadId: 'late-thread', turnId: 'turn-1', item: { id: 'i-1', type: 'commandExecution' } },
    });

    const itemStarted = vi.fn();
    const descendantNotification = vi.fn();
    const subscription = host.subscribeThread('late-thread', { itemStarted, descendantNotification });
    expect(itemStarted).toHaveBeenCalledTimes(1);
    expect(descendantNotification).not.toHaveBeenCalled();

    await subscription.release();
    await host.shutdown();
  });
});
describe('AppServerHost buffered descendant notification replay', () => {
  it('replays a child thread\'s pre-subscribe item/usage/turn notifications in arrival order', async () => {
    // thread/started 与该 child 的 item / usage / turn 全部早于 root 的 subscribeThread 到达时,
    // 它们分别缓存在 **child id** 下。root 侧的 drain 只排空 root id 的队列,这些永远排不到 →
    // 早期工具数、token 丢失,漏掉 turn/completed 还会让卡片永久停在 running(codex review)。
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    // 订阅之前:child 与 grandchild 的血缘 + 各自的业务通知全部先到。
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread' } },
    });
    const childItem = {
      method: 'item/started',
      params: { threadId: 'child-thread', turnId: 't1', item: { id: 'i-1', type: 'commandExecution' } },
    };
    const childUsage = {
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'child-thread', turnId: 't1', tokenUsage: { total: { totalTokens: 99 } } },
    };
    const childTurnEnd = {
      method: 'turn/completed',
      params: { threadId: 'child-thread', turn: { id: 't1', status: 'completed' } },
    };
    transport.emit(childItem);
    transport.emit(childUsage);
    transport.emit(childTurnEnd);
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'grandchild-thread', parentThreadId: 'child-thread' } },
    });
    transport.emit({
      method: 'item/started',
      params: { threadId: 'grandchild-thread', turnId: 't2', item: { id: 'i-2', type: 'mcpToolCall' } },
    });

    const descendantNotification = vi.fn();
    const descendantThreadStarted = vi.fn();
    const itemStarted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantNotification,
      descendantThreadStarted,
      itemStarted,
    });

    // 血缘照旧重建(child + grandchild)。
    expect(descendantThreadStarted).toHaveBeenCalledTimes(2);
    // 关键:child 的三条业务通知按到达顺序补投,grandchild 的也补投。
    expect(descendantNotification.mock.calls).toEqual([
      ['child-thread', 'item/started', childItem.params],
      ['child-thread', 'thread/tokenUsage/updated', childUsage.params],
      ['child-thread', 'turn/completed', childTurnEnd.params],
      [
        'grandchild-thread',
        'item/started',
        { threadId: 'grandchild-thread', turnId: 't2', item: { id: 'i-2', type: 'mcpToolCall' } },
      ],
    ]);
    // thread/started 不进本通道(有专用 handler),也不得重复投递业务通知到主线程通道。
    expect(descendantNotification.mock.calls.some(([, method]) => method === 'thread/started')).toBe(false);
    expect(itemStarted).not.toHaveBeenCalled();

    // 补投过一次后不再重复:同一批不会因后续血缘重建被投第二遍。
    descendantNotification.mockClear();
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'great-grandchild', parentThreadId: 'grandchild-thread' } },
    });
    expect(descendantNotification).not.toHaveBeenCalled();

    await subscription.release();
    await host.shutdown();
  });

  it('rescans buffered lineage when a live thread/started unlocks an already-buffered grandchild', async () => {
    // 与上一例的区别:root **已经订阅**,而孙线程的 thread/started 先于父线程到达。此时孙的
    // 血缘无从判断 → 连同它的业务通知一起缓存在孙自己的 id 下。父线程随后建立血缘时,原实现
    // 只排空父线程那一条队列(而且按契约跳过 thread/started),不再扫待解析的后代血缘 →
    // 孙线程的 tool / token / 终态通知一直烂在缓冲区,卡片漏计并可能持续显示运行中(review)。
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const descendantNotification = vi.fn();
    const descendantThreadStarted = vi.fn();
    const itemStarted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantNotification,
      descendantThreadStarted,
      itemStarted,
    });

    // 逆序:孙先到(父线程此刻还没有血缘),连它的业务通知一起被缓冲。
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'grandchild-thread', parentThreadId: 'child-thread' } },
    });
    const grandchildItem = {
      method: 'item/started',
      params: { threadId: 'grandchild-thread', turnId: 't2', item: { id: 'i-2', type: 'mcpToolCall' } },
    };
    const grandchildTurnEnd = {
      method: 'turn/completed',
      params: { threadId: 'grandchild-thread', turn: { id: 't2', status: 'completed' } },
    };
    transport.emit(grandchildItem);
    transport.emit(grandchildTurnEnd);
    expect(descendantThreadStarted).not.toHaveBeenCalled();
    expect(descendantNotification).not.toHaveBeenCalled();

    // 父线程血缘到达:必须顺带把孙线程解锁并补投它的缓冲通知。
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread' } },
    });

    expect(descendantThreadStarted).toHaveBeenCalledTimes(2);
    expect(descendantNotification.mock.calls).toEqual([
      ['grandchild-thread', 'item/started', grandchildItem.params],
      ['grandchild-thread', 'turn/completed', grandchildTurnEnd.params],
    ]);
    // 后代通知不得漏进主线程通道(否则子代理的工具会被渲染成主会话自己的调用)。
    expect(itemStarted).not.toHaveBeenCalled();

    // 孙线程血缘已建立:它之后的通知直接走 descendant 通道,不再进缓冲。
    descendantNotification.mockClear();
    transport.emit({
      method: 'item/started',
      params: { threadId: 'grandchild-thread', turnId: 't3', item: { id: 'i-3', type: 'webSearch' } },
    });
    expect(descendantNotification).toHaveBeenCalledTimes(1);

    await subscription.release();
    await host.shutdown();
  });

  it('resolves a deep buffered lineage chain from a single live thread/started', async () => {
    // 三代逆序:曾孙 → 孙 全部先到,最后才到子线程对 root 的血缘。一次重建要沿链解开。
    const transport = new NotificationTransport();
    const host = new AppServerHost({
      createTransport: () => transport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });
    await host.ensureStarted();

    const descendantNotification = vi.fn();
    const descendantThreadStarted = vi.fn();
    const subscription = host.subscribeThread('root-thread', {
      descendantNotification,
      descendantThreadStarted,
    });

    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'great-grandchild', parentThreadId: 'grandchild-thread' } },
    });
    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'grandchild-thread', parentThreadId: 'child-thread' } },
    });
    transport.emit({
      method: 'item/started',
      params: { threadId: 'great-grandchild', turnId: 't9', item: { id: 'i-9', type: 'commandExecution' } },
    });
    expect(descendantThreadStarted).not.toHaveBeenCalled();

    transport.emit({
      method: 'thread/started',
      params: { thread: { id: 'child-thread', parentThreadId: 'root-thread' } },
    });

    // child + grandchild + great-grandchild 三代血缘全部建立,曾孙的工具通知补投到位。
    expect(descendantThreadStarted).toHaveBeenCalledTimes(3);
    expect(descendantNotification.mock.calls).toEqual([
      [
        'great-grandchild',
        'item/started',
        { threadId: 'great-grandchild', turnId: 't9', item: { id: 'i-9', type: 'commandExecution' } },
      ],
    ]);

    await subscription.release();
    await host.shutdown();
  });
});
