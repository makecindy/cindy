/**
 * HermesAgent against a fake hermes-mgr socket daemon.
 *
 * The fixture is a real `net.Server` on a temp socket path that speaks the
 * production wire protocol (hello / query/start / query/send / query/interrupt /
 * query/close plus the three notifications). Tests therefore exercise the real
 * transport, event projection, and lifecycle without a Hermes install or home.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentStartupStoppedError,
  TurnPermissionPolicyUnsupportedError,
  type AgentDeps,
  type AgentSessionHandle,
} from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import { NotSupportedError } from '../../../types/capabilities.js';
import type { AgentEvent } from '../../../types/events.js';
import { HermesAgent } from '../agent.js';
import { HermesProtocolMismatchError } from '../protocol.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

type FakeHelloMode = 'ok' | 'version-error' | 'version-mismatch';
type FakeTurnMode = 'happy' | 'abort' | 'abort-result' | 'manual' | 'init-first';

interface FakeDaemonOptions {
  hello?: FakeHelloMode;
  turn?: FakeTurnMode;
  /** When set, `query/start` reports this Hermes-native id (resumable). */
  startHermesSessionId?: string;
}

interface FakeDaemon {
  socketPath: string;
  methods: string[];
  startParams: Array<Record<string, unknown>>;
  sendTexts: string[];
  setModels: string[];
  emit(event: unknown): void;
  closeSession(reason: 'completed' | 'closed' | 'killed' | 'error', detail?: string): void;
  waitForNoConnections(): Promise<void>;
  close(): Promise<void>;
}

/** Windows named pipes live outside the filesystem; tests need a real pipe name there. */
function socketPathFor(dir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\hermes-agent-test-${path.basename(dir)}`;
  }
  return path.join(dir, 'hermes-mgr.sock');
}

async function startFakeDaemon(
  socketPath: string,
  options: FakeDaemonOptions = {},
): Promise<FakeDaemon> {
  const helloMode = options.hello ?? 'ok';
  const turnMode = options.turn ?? 'happy';
  const startHermesSessionId = options.startHermesSessionId;
  const methods: string[] = [];
  const startParams: Array<Record<string, unknown>> = [];
  const sendTexts: string[] = [];
  const setModels: string[] = [];
  const sockets = new Set<net.Socket>();
  const emptyWaiters: Array<() => void> = [];
  let client: net.Socket | null = null;
  let sessionId = '';
  let seq = 0;
  let serverClosed = false;

  const write = (message: unknown): void => {
    if (client && !client.destroyed) client.write(`${JSON.stringify(message)}\n`);
  };
  const respond = (id: number, result: unknown): void => {
    write({ type: 'response', id, result });
  };
  const notify = (method: string, params: unknown): void => {
    write({ type: 'notification', method, params });
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    client = socket;
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        for (const resolve of emptyWaiters.splice(0)) resolve();
      }
    });

    const reader = createInterface({ input: socket });
    reader.on('line', (line) => {
      if (!line.trim()) return;
      let message: { type?: string; id?: number; method?: string; params?: Record<string, unknown> };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type !== 'request' || typeof message.method !== 'string') return;
      methods.push(message.method);
      switch (message.method) {
        case 'protocol/hello':
          if (helloMode === 'version-error') {
            write({
              type: 'response',
              id: message.id,
              error: {
                code: 'INVALID_PROTOCOL_VERSION',
                message: 'client version 1 != server version 2',
              },
            });
            return;
          }
          if (helloMode === 'version-mismatch') {
            respond(message.id!, { protocolVersion: 2, managerVersion: 'fake-hermes-mgr' });
            return;
          }
          respond(message.id!, { protocolVersion: 1, managerVersion: 'fake-hermes-mgr' });
          return;
        case 'query/start':
          startParams.push({ ...(message.params ?? {}) });
          sessionId = String(message.params?.sessionId ?? '');
          respond(message.id!, {
            sessionId,
            ...(startHermesSessionId ? { hermesSessionId: startHermesSessionId } : {}),
          });
          return;
        case 'query/setModel':
          setModels.push(String((message.params as { model?: unknown } | undefined)?.model ?? ''));
          respond(message.id!, { sessionId });
          return;
        case 'query/send':
          sendTexts.push(String((message.params as { text?: unknown } | undefined)?.text ?? ''));
          respond(message.id!, { sessionId });
          if (turnMode === 'manual') return;
          // The real CLI opens every spawned run with system/init, carrying the
          // model that run used and an empty session_id. 'init-first' only
          // reports it on the first turn, so a later turn has no model of its
          // own to report.
          if (turnMode !== 'init-first' || sendTexts.length === 1) {
            notify('query/event', {
              sessionId,
              seq: ++seq,
              ts: new Date().toISOString(),
              event: {
                type: 'system',
                subtype: 'init',
                model: 'hermes-turn-model',
                session_id: '',
              },
            });
          }
          notify('query/event', {
            sessionId,
            seq: ++seq,
            ts: new Date().toISOString(),
            event: {
              type: 'hermes-mgr',
              subtype: 'session-bound',
              hermesSessionId: 'hermes-session-1',
            },
          });
          for (const text of ['hello ', 'world']) {
            notify('query/event', {
              sessionId,
              seq: ++seq,
              ts: new Date().toISOString(),
              event: { type: 'text', text },
            });
          }
          notify('query/event', {
            sessionId,
            seq: ++seq,
            ts: new Date().toISOString(),
            event: {
              type: 'tool_use',
              tool_call_id: 'call-1',
              name: 'read_file',
              input: { path: 'a.txt' },
            },
          });
          notify('query/event', {
            sessionId,
            seq: ++seq,
            ts: new Date().toISOString(),
            event: {
              type: 'tool_result',
              tool_call_id: 'call-1',
              name: 'read_file',
              output: 'file body',
              is_error: false,
            },
          });
          if (turnMode === 'abort' || turnMode === 'abort-result') return;
          notify('query/event', {
            sessionId,
            seq: ++seq,
            ts: new Date().toISOString(),
            event: {
              type: 'result',
              session_id: 'hermes-session-1',
              exit_code: 0,
              text: 'hello world',
              tokens: { input: 10, output: 5, total: 15, cache_read: 2, cache_write: 1 },
              duration_ms: 12,
            },
          });
          notify('session/closed', { sessionId, reason: 'completed' });
          return;
        case 'query/interrupt':
          respond(message.id!, {});
          if (turnMode === 'abort-result') {
            // The real CLI answers SIGINT with a failing terminal result
            // (exit code 130 = 128 + SIGINT) on stdout before it dies; the
            // daemon's killed close follows it (observed live 2026-10-31).
            notify('query/event', {
              sessionId,
              seq: ++seq,
              ts: new Date().toISOString(),
              event: {
                type: 'result',
                session_id: 'hermes-session-1',
                exit_code: 130,
                text: '',
              },
            });
          }
          notify('session/closed', { sessionId, reason: 'killed' });
          return;
        case 'query/close':
          respond(message.id!, {});
          notify('session/closed', { sessionId, reason: 'closed' });
          return;
        default:
          write({
            type: 'response',
            id: message.id,
            error: { code: 'UNKNOWN_METHOD', message: `no handler for ${message.method}` },
          });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    socketPath,
    methods,
    startParams,
    sendTexts,
    setModels,
    emit(event: unknown) {
      notify('query/event', {
        sessionId,
        seq: ++seq,
        ts: new Date().toISOString(),
        event,
      });
    },
    closeSession(reason, detail) {
      notify('session/closed', {
        sessionId,
        reason,
        ...(detail ? { detail } : {}),
      });
    },
    waitForNoConnections() {
      if (sockets.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => emptyWaiters.push(resolve));
    },
    async close() {
      if (serverClosed) return;
      serverClosed = true;
      client = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    },
  };
}

/** Consumes one shared event iterator so tests can await specific milestones. */
function createEventPump(handle: AgentSessionHandle) {
  const iterator = handle.events()[Symbol.asyncIterator]();
  const seen: AgentEvent[] = [];
  return {
    seen,
    async until(predicate: (event: AgentEvent) => boolean): Promise<AgentEvent[]> {
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error('event stream ended before the expected event');
        seen.push(next.value);
        if (predicate(next.value)) return seen;
      }
    },
  };
}

const isText = (value: string) => (event: AgentEvent): boolean =>
  event.type === 'text' && (event.data as { text?: string } | null)?.text === value;

describe('HermesAgent', () => {
  let workDir = '';
  let socketPath = '';
  const daemons: FakeDaemon[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'hermes-agent-'));
    socketPath = socketPathFor(workDir);
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
      await daemon.close();
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  async function startDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
    const daemon = await startFakeDaemon(socketPath, options);
    daemons.push(daemon);
    return daemon;
  }

  /**
   * `socketPath: null` leaves the host resolver absent (daemon not provisioned).
   * BaseAgent still requires a binaryPath for every agent; Hermes does not spawn it.
   */
  function buildAgent(
    options: { socketPath?: string | null; deps?: Partial<AgentDeps> } = {},
  ): HermesAgent {
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => undefined,
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {},
      binaryPath: path.join(workDir, 'unused-hermes-mgr.mjs'),
      logger: noopLogger,
    };
    if (options.socketPath !== null) {
      const resolved = options.socketPath ?? socketPath;
      deps.resolveHermesManagerSocketPath = () => resolved;
    }
    return new HermesAgent({ ...deps, ...options.deps });
  }

  const start = (agent: HermesAgent): Promise<AgentSessionHandle> =>
    agent.startSession({ sessionId: 'business-1', workingDir: workDir, model: 'hermes-default' });

  const startResuming = (
    agent: HermesAgent,
    resumeSessionId: string,
  ): Promise<AgentSessionHandle> =>
    agent.startSession({
      sessionId: 'business-1',
      workingDir: workDir,
      model: 'hermes-default',
      resumeSessionId,
    });

  it('refuses to start when the host has not provisioned a daemon socket', async () => {
    const agent = buildAgent({ socketPath: null });
    const failure = await start(agent).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentStartupStoppedError);
    if (!(failure instanceof AgentStartupStoppedError)) throw new Error('expected startup stop');
    expect(failure.message).toContain('hermes daemon not provisioned');
  });

  it('reports a confirmed startup stop when the daemon socket is unreachable, then starts cleanly', async () => {
    const agent = buildAgent();
    const failure = await start(agent).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentStartupStoppedError);
    if (!(failure instanceof AgentStartupStoppedError)) throw new Error('expected startup stop');
    expect(failure.message).toContain('unreachable');

    // No leaked listeners/queue may wedge the next attempt: a daemon appearing
    // later on the same socket path must serve a fresh start.
    await startDaemon();
    const handle = await start(agent);
    await handle.close();
  });

  it('leaves the handle id empty on a fresh start and never forwards an empty resume id', async () => {
    const daemon = await startDaemon();
    const handle = await startResuming(buildAgent(), '');
    try {
      expect(handle.id).toBe('');
      expect(daemon.startParams[0]).not.toHaveProperty('resumeHermesSessionId');
    } finally {
      await handle.close();
    }
  });

  it('uses the daemon-reported Hermes session id as the resumable handle id and forwards it', async () => {
    const daemon = await startDaemon({ startHermesSessionId: 'hermes-session-resume' });
    const first = await start(buildAgent());
    expect(first.id).toBe('hermes-session-resume');
    await first.close();

    const second = await startResuming(buildAgent(), first.id);
    try {
      expect(second.id).toBe('hermes-session-resume');
      expect(daemon.startParams[1]).toMatchObject({
        resumeHermesSessionId: 'hermes-session-resume',
      });
    } finally {
      await second.close();
    }
  });

  it('maps the daemon INVALID_PROTOCOL_VERSION rejection to a stopped startup with mismatch cause', async () => {
    const daemon = await startDaemon({ hello: 'version-error' });
    const failure = await start(buildAgent()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentStartupStoppedError);
    if (!(failure instanceof AgentStartupStoppedError)) throw new Error('expected startup stop');
    expect(failure.cause).toBeInstanceOf(HermesProtocolMismatchError);
    expect(failure.message).toContain('protocol mismatch');
    expect(failure.message).toContain('expected v1');
    expect(failure.message).toContain('got vunknown');
    expect(failure.message).toContain('Upgrade the bundled hermes-mgr and Cindy together');
    await daemon.waitForNoConnections();
  });

  it('maps a mismatched hello result to a stopped startup with mismatch cause', async () => {
    const daemon = await startDaemon({ hello: 'version-mismatch' });
    const failure = await start(buildAgent()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentStartupStoppedError);
    if (!(failure instanceof AgentStartupStoppedError)) throw new Error('expected startup stop');
    expect(failure.cause).toBeInstanceOf(HermesProtocolMismatchError);
    expect(failure.message).toContain('protocol mismatch');
    expect(failure.message).toContain('expected v1');
    expect(failure.message).toContain('got v2');
    expect(failure.message).toContain('Upgrade the bundled hermes-mgr and Cindy together');
    await daemon.waitForNoConnections();
  });

  it('projects Hermes events and usage from a completed turn', async () => {
    const daemon = await startDaemon();
    const handle = await start(buildAgent());
    try {
      const pump = createEventPump(handle);
      await handle.send({ type: 'user', content: 'read a.txt' });
      const events = await pump.until((event) => event.type === 'done');

      const sessionIdEvents = events.filter((event) => event.type === 'session_id');
      expect(sessionIdEvents).toHaveLength(1);
      expect(sessionIdEvents[0]?.data).toBe('hermes-session-1');

      expect(
        events.filter((event) => event.type === 'text')
          .map((event) => (event.data as { text: string }).text),
      ).toEqual(['hello ', 'world']);

      expect(events.find((event) => event.type === 'tool_use')?.data).toEqual({
        toolUseId: 'call-1',
        toolName: 'read_file',
        input: { path: 'a.txt' },
      });
      expect(events.find((event) => event.type === 'tool_result_full')?.data).toEqual({
        toolUseId: 'call-1',
        fullText: 'file body',
        isError: false,
      });
      expect(events.find((event) => event.type === 'tool_result')?.data).toEqual({
        summary: 'done',
        toolUseIds: ['call-1'],
      });

      // The turn opens with a running status; the terminal one follows it.
      const status = events.filter((event) => event.type === 'status').at(-1);
      expect(status?.data).toMatchObject({
        isRunning: false,
        tokenUsage: 15,
        contextTokens: 13,
        contextWindow: 200_000,
      });
      expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
        status: 'completed',
        result: 'hello world',
      });
      // The done event names the model the turn ran on, so the desktop can
      // price the tokens instead of showing a bare token count.
      expect(
        (events.find((event) => event.type === 'done')?.data as { usage?: unknown }).usage,
      ).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
        model: 'hermes-turn-model',
      });
      expect(handle.getUsageSnapshot()).toEqual({
        tokenUsage: 15,
        contextTokens: 13,
        contextWindow: 200_000,
        costUsd: 0,
      });
      expect(daemon.methods).toEqual(
        expect.arrayContaining(['protocol/hello', 'query/start', 'query/send']),
      );
    } finally {
      await handle.close();
    }
  });

  it('does not carry the previous turn\'s model into a turn that reported none', async () => {
    const daemon = await startDaemon({ turn: 'init-first' });
    const handle = await start(buildAgent());
    try {
      const first = createEventPump(handle);
      await handle.send({ type: 'user', content: 'first' });
      const firstEvents = await first.until((event) => event.type === 'done');
      expect(
        (firstEvents.find((event) => event.type === 'done')?.data as { usage?: unknown }).usage,
      ).toMatchObject({ model: 'hermes-turn-model' });

      // The second run never reported a model. It must not inherit the first
      // turn's model: the tokens would be priced against the wrong tariff.
      const second = createEventPump(handle);
      await handle.send({ type: 'user', content: 'second' });
      const secondEvents = await second.until((event) => event.type === 'done');
      const usage = (secondEvents.find((event) => event.type === 'done')?.data as {
        usage?: Record<string, unknown>;
      }).usage;
      expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
      expect(usage).not.toHaveProperty('model');
    } finally {
      await handle.close();
    }
  });

  it('rides provider-key env on query/start', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const daemon = await startDaemon();
    const handle = await start(buildAgent());
    try {
      // The daemon runs secret-free; provider credentials ride query/start env.
      expect((daemon.startParams[0] as { env?: Record<string, string> }).env?.DEEPSEEK_API_KEY).toBe(
        'test-key',
      );
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      await handle.close();
    }
  });

  it('registers the bridge identity with the Cindy session id, rides its env, and disposes on close', async () => {
    const daemon = await startDaemon();
    const calls: Array<{ sessionId: string; workingDir: string; permissionMode?: string }> = [];
    let disposed = 0;
    const agent = buildAgent({
      deps: {
        prepareHermesBridgeSession: async (info) => {
          calls.push({ sessionId: info.sessionId, workingDir: info.workingDir, permissionMode: info.permissionMode });
          return { env: { CINDY_BRIDGE_SESSION: info.sessionId }, dispose: () => { disposed += 1; } };
        },
      },
    });
    const handle = await start(agent);
    expect(calls).toEqual([{ sessionId: 'business-1', workingDir: workDir, permissionMode: 'default' }]);
    expect((daemon.startParams[0] as { env?: Record<string, string> }).env?.CINDY_BRIDGE_SESSION)
      .toBe('business-1');
    expect(disposed).toBe(0);
    await handle.close();
    expect(disposed).toBe(1);
  });

  it('starts without Cindy tools when bridge preparation fails', async () => {
    const daemon = await startDaemon();
    const agent = buildAgent({
      deps: { prepareHermesBridgeSession: async () => { throw new Error('bridge down'); } },
    });
    const handle = await start(agent);
    try {
      const env = (daemon.startParams[0] as { env?: Record<string, string> }).env ?? {};
      expect(env).not.toHaveProperty('CINDY_BRIDGE_SESSION');
    } finally {
      await handle.close();
    }
  });

  it('disposes the bridge identity when the daemon start fails', async () => {
    let disposed = 0;
    const agent = buildAgent({
      deps: {
        prepareHermesBridgeSession: async () => ({ env: {}, dispose: () => { disposed += 1; } }),
      },
    });
    // No daemon listening: startSession must fail and still release the identity.
    await expect(start(agent)).rejects.toBeInstanceOf(AgentStartupStoppedError);
    expect(disposed).toBe(1);
  });

  it('per-session setModel forwards the model and maps the home-default sentinel to an empty override', async () => {
    const daemon = await startDaemon();
    const handle = await start(buildAgent());
    try {
      await handle.setModel!('deepseek-v4-flash');
      expect(daemon.setModels).toEqual(['deepseek-v4-flash']);

      await handle.setModel!('hermes-default');
      expect(daemon.setModels).toEqual(['deepseek-v4-flash', '']);
      expect(daemon.methods).toContain('query/setModel');
    } finally {
      await handle.close();
    }
  });

  it('handle.model follows a successful setModel, keeping the Cindy sentinel', async () => {
    // Session.model reads handle.model and assumes it tracks switches; runtime
    // profiles (desktop readSessionRuntimeProfiles) report live.model. A fixed
    // start-time value made a mid-session switch report the old model.
    await startDaemon();
    const handle = await start(buildAgent());
    try {
      const startModel = handle.model;
      await handle.setModel!('qwen3-8b');
      expect(handle.model).toBe('qwen3-8b');
      expect(handle.model).not.toBe(startModel);
      await handle.setModel!('hermes-default');
      expect(handle.model).toBe('hermes-default');
    } finally {
      await handle.close();
    }
  });

  it('advertises switchModel so the session gate lets a per-session model change through', () => {
    // Regression: the capability said unsupported while handle.setModel already
    // implemented the per-session override (query/setModel). Session.setModel checks
    // the capability first, so it threw NotSupportedError before reaching the handle and
    // the desktop picker could never change a Hermes session's model (1.8c-2).
    const agent = buildAgent();
    expect(agent.capabilities.switchModel).toEqual({ supported: true });
  });

  it('sends query/interrupt on abort, and close is idempotent', async () => {
    const daemon = await startDaemon({ turn: 'abort' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);

    await handle.send({ type: 'user', content: 'start a long task' });
    await handle.abort();
    const events = await pump.until((event) => event.type === 'done');

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
      status: 'cancelled',
    });

    await handle.close();
    await handle.close();

    expect(daemon.methods).toContain('query/interrupt');
    expect(daemon.methods.filter((method) => method === 'query/close')).toHaveLength(1);
  });

  it('accepts a new turn after a cancelled turn (the session stays resumable)', async () => {
    // ROADMAP 1.10: a Stop ends the turn, not the conversation. The handle
    // must not latch closedByUser/connectionLost from a killed turn.
    const daemon = await startDaemon({ turn: 'abort' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'start a long task' });
      await handle.abort();
      const events = await pump.until((event) => event.type === 'done');
      expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
        status: 'cancelled',
      });

      await handle.send({ type: 'user', content: 'carry on' });
      expect(daemon.sendTexts).toEqual(['start a long task', 'carry on']);
      expect(daemon.methods.filter((method) => method === 'query/send')).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });

  it('settles a user-stopped turn whose result reports failure as cancelled, not failed', async () => {
    // Real Hermes answers SIGINT with an exit-code-130 result before the
    // killed close (observed live 2026-10-31, ROADMAP 1.10b). Without the
    // abort-intent record that result surfaced a "Hermes exited with code
    // 130" error banner and counted as a provider-group failure for a plain
    // Stop.
    const daemon = await startDaemon({ turn: 'abort-result' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'write a detailed 2000-word essay' });
      await handle.abort();
      const events = await pump.until((event) => event.type === 'done');

      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
        status: 'cancelled',
      });
      expect(daemon.methods).toContain('query/interrupt');
    } finally {
      await handle.close();
    }
  });

  it('still surfaces a genuine failing result when the user did not stop the turn', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'doomed task' });
      daemon.emit({
        type: 'result',
        session_id: 'hermes-session-1',
        exit_code: 1,
        text: '',
        error: 'simulated hermes crash',
      });
      const events = await pump.until((event) => event.type === 'done');

      expect(events.some((event) => event.type === 'error')).toBe(true);
      expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
        status: 'failed',
      });
    } finally {
      await handle.close();
    }
  });

  it('announces a running status before the provider emits anything', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'long silent first call' });
      const seen = await pump.until((event) => event.type === 'status');
      expect(seen[seen.length - 1]?.data).toMatchObject({ isRunning: true });
      expect(daemon.methods).toContain('query/send');
    } finally {
      await handle.close();
    }
  });

  it('inlines a text file attachment into the turn', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'hermes-attach-'));
    const file = join(dir, 'PromDeck idea.txt');
    writeFileSync(file, 'brainstorm notes: three tools, not eleven');
    const daemon = await startDaemon();
    const handle = await start(buildAgent());
    try {
      await handle.send({
        type: 'user',
        content: [
          { type: 'text', text: 'see the attached idea' },
          { type: 'file', path: file },
        ],
      });
      expect(daemon.sendTexts).toHaveLength(1);
      expect(daemon.sendTexts[0]).toContain('see the attached idea');
      expect(daemon.sendTexts[0]).toContain('Attached file `PromDeck idea.txt`');
      expect(daemon.sendTexts[0]).toContain('brainstorm notes: three tools, not eleven');
    } finally {
      await handle.close();
    }
  });

  it('rejects binary attachments without dispatching a turn', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'hermes-attach-bin-'));
    const file = join(dir, 'blob.bin');
    writeFileSync(file, Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    const daemon = await startDaemon();
    const handle = await start(buildAgent());
    try {
      await expect(handle.send({
        type: 'user',
        content: [{ type: 'file', path: file }],
      })).rejects.toThrow(/binary file attachments are not supported/i);
      expect(daemon.methods).not.toContain('query/send');
    } finally {
      await handle.close();
    }
  });

  it('tells the user which permission mode carries Cindy tools (1.5b-5d)', () => {
    const modes = buildAgent().capabilities.permissionModes;
    const text = (id: string) => modes.find((mode) => mode.id === id)?.description ?? '';
    expect(text('default')).toMatch(/Cindy document tools are off/);
    expect(text('bypassPermissions')).toMatch(/cindy_docs.*starts in this mode/);
  });

  it('inlines image attachment references into the turn text', async () => {
    const daemon = await startDaemon();
    const agent = buildAgent();
    expect(agent.capabilities.multimodal.image.supported).toBe(true);
    const handle = await start(agent);
    try {
      await handle.send({
        type: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', path: '/tmp/screenshot.png', mimeType: 'image/png' },
        ],
      });
      expect(daemon.methods).toContain('query/send');
      expect(daemon.sendTexts[0]).toContain('describe this');
      expect(daemon.sendTexts[0]).toContain(
        'Attached image `screenshot.png` (image/png) located at: `/tmp/screenshot.png` (available on the local filesystem).',
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects unsupported attachment blocks without dispatching a turn', async () => {
    const daemon = await startDaemon();
    const handle = await start(buildAgent());
    try {
      await expect(handle.send({
        type: 'user',
        content: [
          { type: 'text', text: 'listen to this' },
          { type: 'audio' as never, path: '/tmp/clip.mp3' } as never,
        ],
      })).rejects.toThrow(/attachments are not supported yet/i);
      expect(daemon.methods).not.toContain('query/send');
    } finally {
      await handle.close();
    }
  });

  it('fails closed on unsupported per-turn safety options before dispatch', async () => {
    const daemon = await startDaemon();
    const handle = await start(buildAgent());
    try {
      await expect(handle.send(
        { type: 'user', content: 'text only' },
        { toolsDisabled: true },
      )).rejects.toBeInstanceOf(NotSupportedError);
      await expect(handle.send(
        { type: 'user', content: 'forced confirmation' },
        {
          turnPermissionPolicy: {
            origin: { kind: 'desktop' },
            confirmationSurface: 'desktop',
            forceConfirmToolCall: () => true,
          },
        },
      )).rejects.toBeInstanceOf(TurnPermissionPolicyUnsupportedError);
      expect(daemon.methods).not.toContain('query/send');
    } finally {
      await handle.close();
    }
  });

  it('surfaces a durable notice when the daemon replaced a lost resume id', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'continue' });
      daemon.emit({
        type: 'hermes-mgr',
        subtype: 'resume-reset',
        previousHermesSessionId: 'local-lost',
      });
      daemon.emit({ type: 'system', subtype: 'init', session_id: 'local-fresh' });
      daemon.emit({ type: 'text', text: 'Fresh start' });
      daemon.emit({
        type: 'result',
        session_id: 'local-fresh',
        exit_code: 0,
        text: 'Fresh start',
        tokens: { input: 1, output: 1 },
      });
      daemon.closeSession('completed');
      await pump.until((event) => event.type === 'done');

      const notice = pump.seen.find((event) => event.standaloneText === true);
      expect(notice).toMatchObject({
        type: 'text',
        source: 'hermes',
        standaloneText: true,
        data: { isFinal: true },
      });
      expect((notice?.data as { text?: string }).text).toMatch(/starts a new one/);
      // The notice is not model output: the reply and the fresh resumable id
      // still arrive as their own events for the host to persist.
      expect((pump.seen.find(isText('Fresh start'))?.data as { text?: string }).text)
        .toBe('Fresh start');
      expect(pump.seen.filter((event) => event.type === 'session_id').map((event) => event.data))
        .toEqual(['local-fresh']);
      expect(pump.seen.find((event) => event.type === 'done')?.data)
        .toMatchObject({ status: 'completed', result: 'Fresh start' });
    } finally {
      await handle.close();
    }
  });

  it('does not let a stale session/closed settle a newer turn', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'turn one' });
      daemon.emit({
        type: 'result',
        session_id: 'hermes-session-1',
        exit_code: 0,
        text: 'one',
        tokens: { input: 1, output: 1 },
      });
      await pump.until((event) => event.type === 'done');

      await handle.send({ type: 'user', content: 'turn two' });
      // Turn one's close arrives only now, while turn two is active.
      daemon.closeSession('completed');
      daemon.emit({ type: 'text', text: 'two' });
      daemon.emit({
        type: 'result',
        session_id: 'hermes-session-1',
        exit_code: 0,
        text: 'two',
        tokens: { input: 2, output: 2 },
      });
      await pump.until((event) => event.type === 'done' && (
        event.data as { result?: string } | null
      )?.result === 'two');

      expect(pump.seen.filter((event) => event.type === 'done')).toHaveLength(2);
      expect(pump.seen.filter((event) => event.type === 'done')[1]?.data).toMatchObject({
        status: 'completed',
        result: 'two',
      });
    } finally {
      await handle.close();
    }
  });

  it('keeps a multi-turn conversation alive across per-turn session/closed', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'turn one' });
      daemon.emit({ type: 'text', text: 'one' });
      daemon.closeSession('completed');
      await pump.until((event) => event.type === 'done');

      // session/closed ended only the turn; the daemon keeps the session record.
      await handle.send({ type: 'user', content: 'turn two' });
      daemon.emit({ type: 'text', text: 'two' });
      daemon.closeSession('completed');
      await pump.until((event) => event.type === 'done'
        && pump.seen.filter((seen) => seen.type === 'done').length === 2);

      expect(pump.seen.filter((event) => event.type === 'done')).toHaveLength(2);
      expect(daemon.methods.filter((method) => method === 'query/send')).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });

  it('settles an active turn once when session/closed arrives', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'turn one' });
      daemon.emit({ type: 'text', text: 'working' });
      daemon.closeSession('killed');
      daemon.closeSession('completed');
      daemon.emit({ type: 'text', text: 'sentinel' });
      await pump.until((event) => event.type === 'done');
      await pump.until(isText('sentinel'));

      expect(pump.seen.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(pump.seen.find((event) => event.type === 'done')?.data).toMatchObject({
        status: 'cancelled',
      });
      expect(pump.seen.some((event) => event.type === 'error')).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('maps a session/closed error to the terminal error path', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'turn one' });
      daemon.closeSession('error', 'hermes crashed');
      daemon.emit({ type: 'text', text: 'sentinel' });
      await pump.until((event) => event.type === 'done');
      await pump.until(isText('sentinel'));

      const error = pump.seen.find((event) => event.type === 'error');
      expect(error?.data).toMatchObject({ isTerminal: true, message: 'hermes crashed' });
      expect(pump.seen.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(pump.seen.find((event) => event.type === 'done')?.data).toMatchObject({
        status: 'failed',
        result: '',
      });

      // A failed turn does not poison the daemon session: the next send resumes it.
      await handle.send({ type: 'user', content: 'turn two' });
      daemon.emit({ type: 'text', text: 'recovered' });
      daemon.closeSession('completed');
      await pump.until((event) => event.type === 'done'
        && pump.seen.filter((seen) => seen.type === 'done').length === 2);
      expect(daemon.methods.filter((method) => method === 'query/send')).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });

  it('turns transport loss into a terminal error and fails later sends fast', async () => {
    const daemon = await startDaemon({ turn: 'manual' });
    const handle = await start(buildAgent());
    const pump = createEventPump(handle);
    try {
      await handle.send({ type: 'user', content: 'turn one' });
      await daemon.close();

      const events = await pump.until((event) => event.type === 'done');
      const error = events.find((event) => event.type === 'error');
      expect(error?.data).toMatchObject({ isTerminal: true });
      expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
        status: 'failed',
      });

      await expect(handle.send({ type: 'user', content: 'turn two' }))
        .rejects.toThrow(/daemon connection lost/i);
    } finally {
      await handle.close();
    }
  });
});
