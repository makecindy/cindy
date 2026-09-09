/**
 * End-to-end test: spin up a real ManagerServer + fake SDK + connect via
 * RpcClient + drive RemoteQuery exactly as ClaudeCodeAgent would in production.
 *
 * Verifies the "fake Query" actually fulfils the Query-like interface:
 *   - AsyncIterable yields SDK events in arrival order
 *   - send() pushes user messages and triggers echo events
 *   - setModel / interrupt / etc. resolve
 *   - close() ends iteration cleanly
 *   - SESSION_CLOSED notification ends iteration too (manager-side close)
 */

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient, RpcClientError } from '../src/client.js';
import { ManagerServer } from '../src/server.js';
import { SessionRegistry, type SdkQueryFactory, type SdkQueryLike } from '../src/session-registry.js';
import { wireSdkHandlers } from '../src/sdk-handlers.js';
import { createRemoteQuery, type RemoteQuery } from '../src/remote-query.js';

interface Ctx {
  server: ManagerServer;
  socketPath: string;
  socket: net.Socket;
  client: RpcClient;
}

let ctx: Ctx | null = null;

function makeIpcPath(): string {
  const uniq = `cc-mgr-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${uniq}`;
  }
  return path.join(os.tmpdir(), `${uniq}.sock`);
}

/** 记录 daemon 侧 SDK stopTask 被调到的 taskId(round-trip 断言用)。 */
const stopTaskCalls: string[] = [];

function buildFakeFactory(): SdkQueryFactory {
  return (opts): SdkQueryLike => {
    async function* gen(): AsyncGenerator<unknown> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-uuid-x',
        cwd: opts.cwd,
        model: opts.model,
      };
      for await (const userMsg of opts.inputStream) {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${JSON.stringify(userMsg)}` }] },
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
      async stopTask(taskId: string) {
        stopTaskCalls.push(taskId);
      },
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
  stopTaskCalls.length = 0;
  const socketPath = makeIpcPath();
  const registry = new SessionRegistry({ sdkQueryFactory: buildFakeFactory() });
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
  const client = new RpcClient(socket);
  await client.hello();
  ctx = { server, socketPath, socket, client };
});

afterEach(async () => {
  if (!ctx) return;
  ctx.client.dispose();
  ctx.socket.destroy();
  await ctx.server.stop();
  ctx = null;
});

describe('RemoteQuery', () => {
  it('classifies only correlated RPC errors as authoritative rejections', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's-error-classification',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });

    expect(remote.isAuthoritativeResponseError(
      new RpcClientError({ code: 'SESSION_NOT_FOUND', message: 'missing' }),
    )).toBe(true);
    expect(remote.isAuthoritativeResponseError(new Error('transport closed'))).toBe(false);
    await remote.close();
  });

  it('iterates init message after createRemoteQuery with startParams', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's1',
      startParams: {
        cwd: '/tmp/w',
        model: 'claude-opus-4-7[1m]',
        env: {},
      },
    });
    // Pull events.
    const events = await collect(remote, 1);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
    await remote.close();
  });

  it('send() round-trips through manager into SDK input stream', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's2',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    // Drain init
    await collect(remote, 1);
    await remote.send({ type: 'user', text: 'hello' });
    // echo + result
    const more = await collect(remote, 2);
    expect((more[0] as { type: string }).type).toBe('assistant');
    expect((more[1] as { type: string }).type).toBe('result');
    await remote.close();
  });

  it('setModel / setPermissionMode / applyFlagSettings / interrupt resolve without throwing', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's3',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    await remote.setModel('claude-haiku-4-5-20251001');
    await remote.setPermissionMode('plan');
    await remote.applyFlagSettings({ effortLevel: 'high' });
    await remote.interrupt();
    await remote.close();
  });

  it('stopTask() round-trips taskId through manager into SDK stopTask', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's-stop-task',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    await remote.stopTask('task-abc');
    expect(stopTaskCalls).toEqual(['task-abc']);
    await remote.close();
  });

  it('getContextUsage() round-trips through manager into SDK control request', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's-context',
      startParams: { cwd: '/w', model: 'm-context', env: {} },
    });
    await collect(remote, 1);
    const usage = await remote.getContextUsage() as { totalTokens: number; model: string };
    expect(usage).toMatchObject({ totalTokens: 42, model: 'm-context' });
    await remote.close();
  });

  it('close() ends iterator (consumer for-await sees done)', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's4',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    const doneP = drainToDone(remote);
    await remote.close();
    await doneP;
  });

  it('detach() preserves daemon-side session for reattach', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's-detach',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    const doneP = drainToDone(remote);
    await remote.detach();
    await doneP;

    const list = await ctx!.client.request<{ sessions: Array<{ sessionId: string; alive: boolean }> }>(
      'session/list',
      {},
    );
    expect(list.sessions.find((s) => s.sessionId === 's-detach')).toMatchObject({ alive: true });
  });

  it('close() terminates daemon-side session', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's-full-close',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    await remote.close();

    const list = await ctx!.client.request<{ sessions: Array<{ sessionId: string; alive: boolean }> }>(
      'session/list',
      {},
    );
    expect(list.sessions.find((s) => s.sessionId === 's-full-close')).toMatchObject({ alive: false });
  });

  it('manager-side session/kill closes the iterator', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's5',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    const doneP = drainToDone(remote);
    await ctx!.client.request('session/kill', { sessionId: 's5' });
    await doneP;
  });

  it('attach mode resumes an existing session (via second client)', async () => {
    // Client A: creates the session (auto-attached as part of query/start).
    await ctx!.client.request('query/start', {
      sessionId: 's-attach',
      cwd: '/w',
      model: 'm',
      env: {},
    });
    // Client B: brand-new RpcClient on a brand-new socket. Attaching from
    // this client replaces client A's attach (single-attach policy).
    const socketB = net.connect(ctx!.socketPath);
    await new Promise<void>((resolve, reject) => {
      socketB.once('connect', () => resolve());
      socketB.once('error', reject);
    });
    const clientB = new RpcClient(socketB);
    await clientB.hello();
    const remote = await createRemoteQuery({
      client: clientB,
      sessionId: 's-attach',
      attach: {},
    });
    // Push a user message and assert we see echo (new events).
    await remote.send({ type: 'user', text: 'after-attach' });
    const events = await collect(remote, 2);
    expect((events[0] as { type: string }).type).toBe('assistant');
    expect((events[1] as { type: string }).type).toBe('result');
    await remote.close();
    clientB.dispose();
    socketB.destroy();
  });

  it('throws when both startParams and attach are provided', async () => {
    await expect(
      createRemoteQuery({
        client: ctx!.client,
        sessionId: 'sx',
        startParams: { cwd: '/w', model: 'm', env: {} },
        attach: {},
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('throws when neither startParams nor attach is provided', async () => {
    await expect(
      createRemoteQuery({
        client: ctx!.client,
        sessionId: 'sx',
      }),
    ).rejects.toThrow(/must specify either/);
  });

  // U4: daemon-side abrupt death (force-upgrade pkill / SIGKILL / network blip).
  // SESSION_CLOSED notification may not flush; RemoteQuery must still end its
  // iterator on stream close so ClaudeCodeAgent's for-await exits and U2
  // fallback fires (emits error + done → maker session lifecycle cleanup).
  it('iterator ends when underlying RPC stream closes (peer killed)', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's-stream-close',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    const doneP = drainToDone(remote);
    // Simulate peer death: destroy the socket from underneath. Server-side
    // SESSION_CLOSED would normally also race here, but we're testing the
    // **stream-close** path explicitly.
    ctx!.socket.destroy();
    await doneP;
  });

  // Verifies RpcClient.dispose() also ends the iterator (our own teardown,
  // not peer-driven). Mirrors what cc-manager-client.openCcManagerSession's
  // dispose() does when forceUpgrade soft-closes the cc session.
  it('iterator ends when RpcClient.dispose() runs', async () => {
    const remote = await createRemoteQuery({
      client: ctx!.client,
      sessionId: 's-client-dispose',
      startParams: { cwd: '/w', model: 'm', env: {} },
    });
    await collect(remote, 1);
    const doneP = drainToDone(remote);
    ctx!.client.dispose();
    await doneP;
  });
});

/* ============================== helpers ============================== */

async function collect(remote: RemoteQuery, count: number, timeoutMs = 2000): Promise<unknown[]> {
  const out: unknown[] = [];
  const start = Date.now();
  for await (const ev of remote) {
    out.push(ev);
    if (out.length >= count) return out;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`collect timed out after ${timeoutMs}ms (got ${out.length}/${count})`);
    }
  }
  return out;
}

async function drainToDone(remote: RemoteQuery, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for await (const _ of remote) {
    void _;
    if (Date.now() - start > timeoutMs) {
      throw new Error('drainToDone timed out');
    }
  }
}
