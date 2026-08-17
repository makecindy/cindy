/**
 * End-to-end RPC tests: client ↔ ManagerServer + SessionRegistry (fake SDK).
 *
 * Spins up a real ManagerServer on a temp socket, wires SdkHandlers with a
 * fake SDK factory, then drives query/start → query/send → query/event flow
 * through the on-the-wire NDJSON RPC client.
 */

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient, RpcClientError } from '../src/client.js';
import { ManagerServer } from '../src/server.js';
import {
  SessionRegistry,
  type SdkQueryFactory,
  type SdkQueryFactoryOptions,
  type SdkQueryLike,
} from '../src/session-registry.js';
import { wireSdkHandlers } from '../src/sdk-handlers.js';
import { NOTIFICATIONS } from '../src/protocol.js';

interface Ctx {
  server: ManagerServer;
  socketPath: string;
  socket: net.Socket;
  client: RpcClient;
  notifications: Array<{ method: string; params: unknown }>;
}

let ctx: Ctx | null = null;
let latestFactoryOptions: SdkQueryFactoryOptions | null = null;

function makeIpcPath(): string {
  const uniq = `cc-mgr-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${uniq}`;
  }
  return path.join(os.tmpdir(), `${uniq}.sock`);
}

function buildFakeFactory(): SdkQueryFactory {
  return (opts): SdkQueryLike => {
    latestFactoryOptions = opts;
    async function* gen(): AsyncGenerator<unknown> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'fake-sdk-uuid',
        cwd: opts.cwd,
        model: opts.model,
        mcp_servers: Object.keys(opts.mcpServers ?? {}).map((name) => ({
          name,
          status: 'connected',
        })),
      };
      for await (const userMsg of opts.inputStream) {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `got: ${JSON.stringify(userMsg)}` }] },
        };
        yield { type: 'result', subtype: 'success' };
      }
    }
    const g = gen();
    return {
      [Symbol.asyncIterator]: () => g,
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async applyFlagSettings() {},
      async mcpServerStatus() {
        return Object.keys(opts.mcpServers ?? {}).map((name) => ({
          name,
          status: 'connected',
          scope: 'local',
        }));
      },
      async stopTask() {},
      async getContextUsage() {
        return {
          categories: [{ name: 'Messages', tokens: 42, color: 'inactive' }],
          totalTokens: 42,
          maxTokens: 200000,
          rawMaxTokens: 200000,
          percentage: 1,
          gridRows: [],
          model: opts.model,
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        };
      },
    };
  };
}

beforeEach(async () => {
  latestFactoryOptions = null;
  const socketPath = makeIpcPath();
  const registry = new SessionRegistry({ sdkQueryFactory: buildFakeFactory(), bufferCapacity: 2 });
  const server = new ManagerServer({
    socketPath,
    managerVersion: 'test-0.0.0',
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
  wireSdkHandlers(server, registry);
  await server.start();
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const notifications: Array<{ method: string; params: unknown }> = [];
  const client = new RpcClient(socket, {
    onNotification: (n) => notifications.push({ method: n.method, params: n.params }),
  });
  await client.hello();
  ctx = { server, socketPath, socket, client, notifications };
});

afterEach(async () => {
  if (!ctx) return;
  ctx.client.dispose();
  ctx.socket.destroy();
  await ctx.server.stop();
  ctx = null;
});

async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 5;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('sdk-handlers end-to-end', () => {
  it('rewrites controller-local Claude config paths at the remote RPC boundary', async () => {
    await ctx!.client.request('query/start', {
      sessionId: 'remote-env',
      cwd: '/Users/david/repo',
      model: 'm',
      env: {
        ANTHROPIC_API_KEY: 'sk-gw',
        CLAUDE_CONFIG_DIR: 'C:\\Users\\Admin\\AppData\\Roaming\\Cindy-dev2\\claude-home',
      },
    });

    expect(latestFactoryOptions?.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-gw',
      CLAUDE_CONFIG_DIR: expect.stringMatching(/\/.xdt-server\/v1\/claude-home$/),
    });
  });

  it('query/start returns sessionId + emits init notification', async () => {
    const result = await ctx!.client.request<{ sessionId: string }>('query/start', {
      sessionId: 'sess-1',
      cwd: '/tmp/work',
      model: 'claude-opus-4-7[1m]',
      env: {},
    });
    expect(result.sessionId).toBe('sess-1');

    await waitFor(() => ctx!.notifications.length >= 1);
    expect(ctx!.notifications[0].method).toBe(NOTIFICATIONS.QUERY_EVENT);
    expect(ctx!.notifications[0].params).toMatchObject({
      sessionId: 'sess-1',
      seq: 1,
      message: expect.objectContaining({ type: 'system', subtype: 'init' }),
    });
  });

  it('query/send pushes user message → echo + result events arrive', async () => {
    await ctx!.client.request('query/start', {
      sessionId: 'sess-1',
      cwd: '/tmp',
      model: 'm',
      env: {},
    });
    await waitFor(() => ctx!.notifications.length >= 1); // init

    await ctx!.client.request('query/send', {
      sessionId: 'sess-1',
      message: { type: 'user', text: 'hello' },
    });
    await waitFor(() => ctx!.notifications.length >= 3); // init + assistant + result

    const seqs = ctx!.notifications
      .filter((n) => n.method === NOTIFICATIONS.QUERY_EVENT)
      .map((n) => (n.params as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('session/list reflects active sessions', async () => {
    await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm', env: {} });
    await ctx!.client.request('query/start', { sessionId: 's2', cwd: '/b', model: 'm', env: {} });
    const result = await ctx!.client.request<{ sessions: Array<{ sessionId: string }> }>('session/list', {});
    expect(result.sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('session/attach returns replayLossy when requested seq fell out of buffer', async () => {
    await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm', env: {} });
    await waitFor(() => ctx!.notifications.length >= 1);
    await ctx!.client.request('query/send', { sessionId: 's1', message: { type: 'user', text: 'one' } });
    await waitFor(() => ctx!.notifications.length >= 3);

    const socketB = net.connect(ctx!.socketPath);
    await new Promise<void>((resolve, reject) => {
      socketB.once('connect', () => resolve());
      socketB.once('error', reject);
    });
    const clientB = new RpcClient(socketB);
    try {
      await clientB.hello();
      const result = await clientB.request<{ replayLossy: boolean }>('session/attach', {
        sessionId: 's1',
        sinceSeq: 0,
      });
      expect(result.replayLossy).toBe(true);
    } finally {
      clientB.dispose();
      socketB.destroy();
    }
  });

  it('query/start on duplicate sessionId returns SESSION_ALREADY_EXISTS', async () => {
    await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm', env: {} });
    try {
      await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/b', model: 'm', env: {} });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcClientError);
      expect((err as RpcClientError).rpcError.code).toBe('SESSION_ALREADY_EXISTS');
    }
  });

  it('query/send on non-existent session returns SESSION_NOT_FOUND', async () => {
    try {
      await ctx!.client.request('query/send', { sessionId: 'nope', message: {} });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcClientError);
      // mapRegistryError treats unknown codes as SDK_ERROR; SESSION_NOT_FOUND is recognized
      expect((err as RpcClientError).rpcError.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('query/send during a forceful kill window returns SESSION_KILL_PENDING (Greptile P1)', async () => {
    // 终止窗口 (inputQueue 已 end, consume loop 未退出) 的 send 必须带
    // 可重试的 SESSION_KILL_PENDING 过 RPC — 不得被降级为 SDK_ERROR。
    // 共享 fake 在 inputQueue.end 后即刻退出 (窗口关得太快), 这里自建
    // 慢退出 fake:kill 后 consume loop 仍挂 150ms, 确定性站在窗口里。
    const slowFactory: SdkQueryFactory = (opts) => {
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-x', cwd: opts.cwd, model: opts.model };
        for await (const _userMsg of opts.inputStream) {
          yield { type: 'assistant', message: { role: 'assistant', content: [] } };
        }
        await new Promise((r) => setTimeout(r, 150));
        yield { type: 'result', subtype: 'success' };
      }
      const g = gen();
      return {
        [Symbol.asyncIterator]: () => g,
        async interrupt() {},
        async setModel() {},
        async setPermissionMode() {},
        async applyFlagSettings() {},
      } as SdkQueryLike;
    };
    const socketPath = makeIpcPath();
    const registry = new SessionRegistry({ sdkQueryFactory: slowFactory });
    const server = new ManagerServer({
      socketPath,
      managerVersion: 'test-0.0.0',
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    wireSdkHandlers(server, registry);
    await server.start();
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const client = new RpcClient(socket, { onNotification: () => undefined });
    await client.hello();
    try {
      await client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm', env: {} });
      const killP = client.request('session/kill', { sessionId: 's1' }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 30)); // kill handler 已置 killing, loop 仍卡
      try {
        await client.request('query/send', { sessionId: 's1', message: { text: 'hi' } });
        throw new Error('expected rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcClientError);
        expect((err as RpcClientError).rpcError.code).toBe('SESSION_KILL_PENDING');
      }
      await killP;
    } finally {
      client.dispose();
      socket.destroy();
      await server.stop();
    }
  });

  it('query/start rejects in-process MCP server config (instance field)', async () => {
    try {
      await ctx!.client.request('query/start', {
        sessionId: 's1',
        cwd: '/a',
        model: 'm',
        env: {},
        mcpServers: {
          inproc: { instance: { name: 'fake-mcp' } },
        },
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcClientError);
      expect((err as RpcClientError).rpcError.code).toBe('INVALID_PARAMS');
    }
  });

  it('query/start rejects routing guards with ambiguous plain-text selectors', async () => {
    try {
      await ctx!.client.request('query/start', {
        sessionId: 's1',
        cwd: '/a',
        model: 'm',
        env: {},
        toolGuards: [
          {
            toolNamePrefix: 'mcp__plugin_guard__',
            invocation: 'explicit-only',
            explicitSelectors: ['Feishu Delegate'],
          },
        ],
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcClientError);
      expect((err as RpcClientError).rpcError.code).toBe('INVALID_PARAMS');
    }
  });

  it('query/start rejects invalid routing guard prefixes', async () => {
    for (const [index, toolNamePrefix] of ['   ', 'not-an-mcp-prefix'].entries()) {
      try {
        await ctx!.client.request('query/start', {
          sessionId: `s-invalid-prefix-${index}`,
          cwd: '/a',
          model: 'm',
          env: {},
          toolGuards: [
            {
              toolNamePrefix,
              invocation: 'disabled',
            },
          ],
        });
        throw new Error('expected rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcClientError);
        expect((err as RpcClientError).rpcError.code).toBe('INVALID_PARAMS');
      }
    }
  });

  it('query/start normalizes routing guard identities before matching', async () => {
    await ctx!.client.request('query/start', {
      sessionId: 's1',
      cwd: '/a',
      model: 'm',
      env: {},
      toolGuards: [
        {
          toolNamePrefix: '  mcp__plugin_guard__  ',
          sourceServerId: '  plugin:guard  ',
          invocation: 'explicit-only',
        },
      ],
    });
    await waitFor(() => ctx!.notifications.length >= 1);

    const preToolUse = latestFactoryOptions?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(preToolUse).toBeDefined();
    await expect(
      preToolUse!({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__plugin_guard__call',
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('query/start accepts an exact root-only Orca tool guard', async () => {
    await ctx!.client.request('query/start', {
      sessionId: 's-root-only',
      cwd: '/a',
      model: 'm',
      env: {},
      toolGuards: [{
        toolNamePrefix: 'mcp__orca_worker_bridge__send_to_lead',
        sourceServerId: 'orca_worker_bridge',
        invocation: 'root-only',
      }],
    });
    await waitFor(() => ctx!.notifications.length >= 1);
    expect(latestFactoryOptions?.hooks?.PreToolUse?.[0]?.hooks[0]).toBeDefined();
  });

  it('query/close ends consume loop → session.alive=false + closed notification', async () => {
    await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm', env: {} });
    await waitFor(() => ctx!.notifications.length >= 1);
    await ctx!.client.request('query/close', { sessionId: 's1' });
    // Detach happened in handler → no more event notifications go to us. But
    // close notification should still arrive *before* detach (close handler
    // detaches AFTER calling registry.close, the closed event fires before).
    // Either way, session/list should report alive=false eventually.
    await waitFor(() => {
      // Just check via a fresh session/list call.
      return true;
    }, { timeoutMs: 100 });
    const list = await ctx!.client.request<{ sessions: Array<{ alive: boolean }> }>('session/list', {});
    // Allow a brief delay for consume loop to settle.
    await waitFor(() => list.sessions[0].alive === false || true, { timeoutMs: 50 });
    // Re-check after another tick.
    await new Promise((r) => setTimeout(r, 20));
    const list2 = await ctx!.client.request<{ sessions: Array<{ alive: boolean }> }>('session/list', {});
    expect(list2.sessions[0].alive).toBe(false);
  });

  it('control methods (setModel / setPermissionMode / applyFlagSettings / interrupt) all return ok', async () => {
    await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm', env: {} });
    await waitFor(() => ctx!.notifications.length >= 1);
    expect(await ctx!.client.request('query/setModel', { sessionId: 's1', model: 'claude-haiku-4-5' })).toEqual({ ok: true });
    expect(await ctx!.client.request('query/setPermissionMode', { sessionId: 's1', mode: 'plan' })).toEqual({ ok: true });
    expect(await ctx!.client.request('query/applyFlagSettings', { sessionId: 's1', settings: { effortLevel: 'high' } })).toEqual({ ok: true });
    expect(await ctx!.client.request('query/interrupt', { sessionId: 's1' })).toEqual({ ok: true });
    expect(await ctx!.client.request('query/stopTask', { sessionId: 's1', taskId: 't1' })).toEqual({ ok: true });
  });

  it('query/stopTask rejects when taskId is missing', async () => {
    await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm', env: {} });
    await waitFor(() => ctx!.notifications.length >= 1);
    await expect(ctx!.client.request('query/stopTask', { sessionId: 's1' })).rejects.toThrow(/taskId/);
  });

  it('query/getContextUsage returns SDK structured context data', async () => {
    await ctx!.client.request('query/start', { sessionId: 's1', cwd: '/a', model: 'm-context', env: {} });
    await waitFor(() => ctx!.notifications.length >= 1);
    const usage = await ctx!.client.request<{ totalTokens: number; model: string }>('query/getContextUsage', {
      sessionId: 's1',
    });
    expect(usage).toMatchObject({ totalTokens: 42, model: 'm-context' });
  });
});
