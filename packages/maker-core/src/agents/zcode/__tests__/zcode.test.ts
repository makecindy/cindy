import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ZCodeRpcClient } from '../rpc-client.js';
import { ZCodeAgent } from '../index.js';
import { AgentStartupCleanupPendingError, type AgentDeps } from '../../base-agent.js';
import { Maker, type SessionStartFailureContext } from '../../../maker.js';
import type { AgentEvent } from '../../../types/events.js';
import type { SessionStorage } from '../../../interfaces/session-storage.js';

// Production boundary: real client framing and AgentSessionHandle, with an in-memory child.
// Rule: independent ZCode protocol, permission decisions, cancellation and no credential events.
// Existing Pi/Codex fixtures cannot cover these session/* and interaction/* envelopes.
// Minimal failures: fragmented frame, pending request at exit, denied approval and cancelled turn.
// Tier: unit; no real child, account, filesystem, network or timed wait.
interface TestFrame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message?: string };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function fakeProcess() {
  const frames: TestFrame[] = [];
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  let receive: ((frame: TestFrame) => void) | undefined;
  proc.stdin = new Writable({ write(chunk, _encoding, done) {
    const frame = JSON.parse(String(chunk)) as TestFrame;
    frames.push(frame);
    receive?.(frame);
    done();
  } });
  proc.kill = vi.fn(() => { queueMicrotask(() => proc.emit('close', 0, null)); return true; });
  const spawnProcess = vi.fn(() => proc) as unknown as typeof spawn;
  const send = (frame: unknown) => proc.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
  return { proc, frames, spawnProcess, send, receive(fn: typeof receive) { receive = fn; } };
}

function deps(): AgentDeps {
  const noop = () => {};
  const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => logger };
  return { binaryPath: '/runtime/node', runtimeConfig: {}, logger, auth: {
    getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}),
    triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
  } };
}

function runtime(extra: Partial<import('../index.js').ZCodeAgentOptions> = {}) {
  const fake = fakeProcess();
  fake.receive((frame) => {
    if (!frame.method) return;
    const result = frame.method === 'session/create' || frame.method === 'session/resume'
      ? { session: { sessionId: frame.params?.sessionId ?? 'native-session' }, projection: { totalTokenCount: 0, contextUsed: 0, contextWindow: 1000 } }
      : frame.method === 'session/subscribe' ? { events: [], eventSeq: 0 }
        : frame.method === 'session/send' ? { accepted: true, sessionId: frame.params?.sessionId, stateRevision: 1 } : {};
    queueMicrotask(() => fake.send({ id: frame.id, result }));
  });
  const agent = new ZCodeAgent(deps(), {
    args: ['zcode.cjs', 'app-server', '--stdio'], spawn: fake.spawnProcess,
    resolveModelSelection: (modelId) => ({ providerId: 'account:team', modelId }),
    ...extra,
  });
  return { ...fake, agent };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function startupMaker(agent: ZCodeAgent) {
  const leases = new Set<object>();
  const cleanup = deferred<void>();
  const onStartFailed = vi.fn((context: SessionStartFailureContext) => {
    if (!context.runtimeMayBeAlive) leases.delete(context.options);
  });
  const storage: SessionStorage = {
    create: async () => { throw new Error('Unexpected persistence during failed startup'); },
    get: async () => null, list: async () => [],
    update: async () => { throw new Error('Unexpected storage update'); },
    compareAndClearSdkSessionId: async () => false, delete: async () => {},
  };
  const maker = new Maker({ agents: { zcode: agent }, storage, logger: deps().logger,
    lifecycleHooks: {
      prepareStartOptions: (_id, options) => { leases.add(options); },
      onStartFailed,
      onStartCleanupSucceeded: async (_id, options) => { leases.delete(options); cleanup.resolve(); },
    },
  });
  return { maker, leases, onStartFailed, cleanup };
}

describe('ZCode RPC', () => {
  it('frames split UTF-8 replies and keeps errors free of raw server details', async () => {
    const f = fakeProcess();
    const client = new ZCodeRpcClient({ binaryPath: '/node', cwd: '/work', spawn: f.spawnProcess });
    const result = client.request('runtime/capabilities', {});
    const bytes = Buffer.from(`${JSON.stringify({ id: f.frames[0].id, result: { label: '中文' } })}\n`);
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    f.proc.stdout.emit('data', bytes.subarray(0, split));
    f.proc.stdout.emit('data', bytes.subarray(split));
    await expect(result).resolves.toEqual({ label: '中文' });
    const failure = client.request('session/send', {});
    f.send({ id: f.frames[1].id, error: { code: -32001, message: 'secret-token-value' } });
    await expect(failure).rejects.toMatchObject({ message: 'ZCode RPC session/send failed (-32001)' });
    await client.close();
  });

  it('answers reverse requests and rejects pending calls at process exit', async () => {
    const f = fakeProcess();
    const client = new ZCodeRpcClient({ binaryPath: '/node', cwd: '/work', spawn: f.spawnProcess });
    client.setRequestHandler(async () => ({ decision: 'deny' }));
    f.send({ id: 'approval', method: 'interaction/requestPermission', params: {} });
    await vi.waitFor(() => expect(f.frames).toContainEqual({ id: 'approval', result: { decision: 'deny' } }));
    const request = client.request('session/read', {});
    f.proc.emit('close', 1, null);
    await expect(request).rejects.toThrow('ZCode process closed');
    await client.close();
  });
});

describe('ZCodeAgent', () => {
  it('binds the complete native model selection to each accepted input', async () => {
    // CLI 0.17.0 can lose create/setModel reasoning options unless send carries
    // the canonical input intent: the real first turn failed with invalid_model_request.
    const f = runtime({ resolveModelSelection: (modelId) => ({
      providerId: 'account:team', modelId, options: { reasoningLevel: 'high' },
    }) });
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'm' });
    try {
      await handle.send({ type: 'user', content: 'hello' });
      expect(f.frames.find((frame) => frame.method === 'session/send')?.params).toMatchObject({
        sessionId: handle.id, inputId: expect.any(String),
        modelSelection: { providerId: 'account:team', modelId: 'm', options: { reasoningLevel: 'high' } },
      });
    } finally { await handle.close(); }
  });

  it('reports known native failure codes without forwarding account-bearing error detail', async () => {
    const f = runtime();
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'm' });
    const events: AgentEvent[] = [];
    const consuming = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'test' });
    f.send({ method: 'session/event', params: {
      sessionId: handle.id, seq: 1, type: 'turn.failed', payload: {
        error: { code: 'invalid_model_request', message: 'private account detail', stack: 'private trace' },
      },
    } });
    await handle.close();
    await consuming;
    expect(events.find((event) => event.type === 'error')?.data).toMatchObject({
      sdkError: 'invalid_model_request', isTerminal: true,
      message: 'ZCode rejected the model request configuration.',
    });
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('creates a native session and translates text, tools and terminal usage exactly once', async () => {
    const f = runtime();
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'glm-test' });
    const events: AgentEvent[] = [];
    const consuming = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'hello' });
    const event = (seq: number, type: string, payload: unknown) => f.send({ method: 'session/event', params: { sessionId: handle.id, seq, type, payload } });
    event(1, 'model.streaming', { kind: 'text_delta', delta: 'hello' });
    event(1, 'model.streaming', { kind: 'text_delta', delta: 'hello' });
    event(2, 'tool.updated', { kind: 'scheduled', toolCallId: 'tool-1', toolName: 'Read', input: { file_path: 'a.txt' } });
    event(3, 'tool.updated', { kind: 'result', toolCallId: 'tool-1', result: { content: 'file content', success: true }, duration: 2 });
    event(4, 'turn.completed', { response: 'done', tokenCount: 15, resultType: 'success', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheCreationTokens: 1 } });
    await handle.close();
    await consuming;
    expect(events.filter((e) => e.type === 'text' && !object(e.data).isFinal)).toHaveLength(1);
    expect(object(events.find((e) => e.type === 'tool_result_full')?.data).fullText).toBe('file content');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(handle.getUsageSnapshot().tokenUsage).toBe(15);
    expect(handle.getUsageSnapshot().requestUsage?.models).toEqual([{
      model: 'glm-test', inputTokens: 5, outputTokens: 5, cacheReadTokens: 4, cacheCreateTokens: 1,
    }]);
    expect(f.frames.find((v) => v.method === 'session/create')?.params).toMatchObject({ mode: 'build', model: { providerId: 'account:team', modelId: 'glm-test' } });
  });

  it('passes deny decisions and cancels unresolved interactions on Stop', async () => {
    const f = runtime();
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'glm-test', resumeSessionId: 'saved-session' });
    expect(handle.id).toBe('saved-session');
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'deny', reason: 'no' }));
    const permission = { sessionId: handle.id, requestId: 'r1', toolCallId: 't1', toolName: 'Bash', input: {}, options: [] };
    f.send({ id: 'p1', method: 'interaction/requestPermission', params: permission });
    await vi.waitFor(() => expect(f.frames.find((v) => v.id === 'p1')?.result?.decision).toBe('deny'));
    handle.setInteractionResolver(() => new Promise(() => {}));
    f.send({ id: 'p2', method: 'interaction/requestPermission', params: { ...permission, requestId: 'r2' } });
    await handle.abort();
    await vi.waitFor(() => expect(f.frames.find((v) => v.id === 'p2')?.result?.decision).toBe('deny'));
    await handle.close();
  });

  it('rejects unsupported execution locations and per-turn restrictions before sending', async () => {
    const f = runtime();
    await expect(f.agent.startSession({ workingDir: '/work', model: 'm', remoteHostId: 'remote' })).rejects.toThrow('ZCode');
    expect(f.frames).toHaveLength(0);
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'm' });
    await expect(handle.send({ type: 'user', content: 'x' }, { toolsDisabled: true })).rejects.toThrow('ZCode');
    expect(f.frames.filter((v) => v.method === 'session/send')).toHaveLength(0);
    await handle.close();
  });

  it('waits for native cancellation before allowing the next turn', async () => {
    const f = runtime();
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'm' });
    const events: AgentEvent[] = [];
    const consuming = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'first' });
    const stopped = handle.abort();
    await vi.waitFor(() => expect(f.frames.some((frame) => frame.method === 'session/stop')).toBe(true));
    await expect(handle.send({ type: 'user', content: 'too early' })).rejects.toThrow('busy');
    const done = { method: 'session/event', params: { sessionId: handle.id, seq: 1, type: 'turn.completed', payload: { resultType: 'cancelled', tokenCount: 0 } } };
    f.send(done);
    await stopped;
    await handle.send({ type: 'user', content: 'second' });
    f.send(done);
    expect(handle.isTurnRunning?.()).toBe(true);
    f.send({ ...done, params: { ...done.params, seq: 2, payload: { resultType: 'success', tokenCount: 0 } } });
    await handle.close();
    await consuming;
    expect(events.filter((event) => event.type === 'done').map((event) => object(event.data).status)).toEqual(['cancelled', 'completed']);
  });

  it('answers native questions and never returns late authentication after Stop', async () => {
    let finishAuth!: (result: Record<string, unknown>) => void;
    const authStarted = vi.fn();
    const f = runtime({ createSessionHooks: () => ({
      resolveProviderRuntimeHeaders: () => {
        authStarted();
        return new Promise((resolve) => { finishAuth = resolve; });
      },
    }) });
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'm' });
    handle.setInteractionResolver(async () => ({ kind: 'ask_user_question', answers: { 'Which file?': 'A' } }));
    f.send({ id: 'q', method: 'interaction/requestUserInput', params: {
      sessionId: handle.id, requestId: 'q1', questions: [{ question: 'Which file?', header: 'File', options: [{ value: 'A', label: 'A' }] }],
    } });
    await vi.waitFor(() => expect(f.frames.find((v) => v.id === 'q')?.result).toEqual({ action: 'accept', content: { answers: { 'Which file?': 'A' } } }));
    f.send({ id: 'auth', method: 'interaction/requestProviderRuntimeHeaders', params: { sessionId: handle.id } });
    await vi.waitFor(() => expect(authStarted).toHaveBeenCalledOnce());
    await handle.abort();
    finishAuth({ headersApplied: true, requestAuth: { apiKey: 'not-a-real-secret' } });
    await vi.waitFor(() => expect(f.frames.find((v) => v.id === 'auth')?.error?.code).toBe(-32603));
    expect(JSON.stringify(f.frames)).not.toContain('not-a-real-secret');
    await handle.close();
  });

  it('closes account sessions without disposing the reusable agent', async () => {
    const first = runtime(), second = runtime();
    const spawnProcess = vi.fn().mockImplementationOnce(first.spawnProcess).mockImplementationOnce(second.spawnProcess);
    const agent = new ZCodeAgent(deps(), {
      spawn: spawnProcess as unknown as typeof spawn,
      resolveModelSelection: (modelId) => ({ providerId: 'account:team', modelId }),
    });
    const previous = await agent.startSession({ workingDir: '/work', model: 'm' });
    await previous.send({ type: 'user', content: 'first account' });
    await agent.closeAccountSessions();
    expect(first.proc.kill).toHaveBeenCalled();
    await expect(previous.send({ type: 'user', content: 'stale' })).rejects.toThrow('closed');
    const current = await agent.startSession({ workingDir: '/work', model: 'm' });
    await current.send({ type: 'user', content: 'new connection' });
    expect(second.frames.find((frame) => frame.method === 'session/send')?.params?.content).toBe('new connection');
    await agent.dispose();
    expect(second.proc.kill).toHaveBeenCalled();
  });

  it('honors native cancellation of exactly one pending authentication request', async () => {
    const pending = new Map<string, { signal: AbortSignal; resolve: (value: Record<string, unknown>) => void }>();
    const f = runtime({ createSessionHooks: () => ({
      resolveProviderRuntimeHeaders: (params, signal) => new Promise((resolve) => {
        pending.set(String(params.requestId), { signal, resolve });
      }),
    }) });
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'm' });
    for (const requestId of ['expired', 'current']) {
      f.send({ id: requestId, method: 'interaction/requestProviderRuntimeHeaders', params: { sessionId: handle.id, requestId } });
    }
    await vi.waitFor(() => expect(pending.size).toBe(2));
    f.send({ method: 'interaction/providerRuntimeHeadersCancelled', params: { sessionId: handle.id, requestId: 'expired' } });
    expect(pending.get('expired')?.signal.aborted).toBe(true);
    expect(pending.get('current')?.signal.aborted).toBe(false);
    pending.get('expired')!.resolve({ headersApplied: true, requestAuth: { apiKey: 'expired-fake-key' } });
    pending.get('current')!.resolve({ headersApplied: true, requestAuth: { apiKey: 'current-fake-key' } });
    await vi.waitFor(() => expect(f.frames.find((frame) => frame.id === 'expired')?.error?.code).toBe(-32603));
    expect(object(f.frames.find((frame) => frame.id === 'current')?.result?.requestAuth).apiKey).toBe('current-fake-key');
    expect(JSON.stringify(f.frames)).not.toContain('expired-fake-key');
    await handle.close();
  });

  it('does not spawn a delayed startup from a revoked account generation', async () => {
    let release!: (hooks: import('../index.js').ZCodeSessionHooks) => void;
    const f = runtime({ createSessionHooks: () => new Promise((resolve) => { release = resolve; }) });
    const starting = f.agent.startSession({ workingDir: '/work', model: 'm' });
    await f.agent.closeAccountSessions();
    release({});
    await expect(starting).rejects.toThrow('account changed');
    expect(f.spawnProcess).not.toHaveBeenCalled();
  });

  it('routes native child approvals through the task without mixing child text into its transcript', async () => {
    const resolveAuth = vi.fn(async (params: Record<string, unknown>) => {
      if (params.providerId !== 'account:team') throw new Error('native account mismatch');
      return { headersApplied: true, requestAuth: { apiKey: 'child-fixture-key' } };
    });
    const f = runtime({ createSessionHooks: () => ({ resolveProviderRuntimeHeaders: resolveAuth }) });
    const handle = await f.agent.startSession({ workingDir: '/work', model: 'm' });
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const events: AgentEvent[] = [];
    const consuming = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'root' });
    f.send({ id: 'child-auth', method: 'interaction/requestProviderRuntimeHeaders', params: {
      sessionId: 'native-child', requestId: 'child-auth-request', providerId: 'account:team',
    } });
    f.send({ id: 'child-approval', method: 'interaction/requestPermission', params: {
      sessionId: 'native-child', requestId: 'child-permission', toolCallId: 'child-tool', toolName: 'Write', input: {},
    } });
    f.send({ method: 'session/event', params: { sessionId: 'native-child', seq: 1, type: 'model.streaming', payload: { kind: 'text_delta', delta: 'private child text' } } });
    await vi.waitFor(() => expect(f.frames.find((frame) => frame.id === 'child-approval')?.result?.decision).toBe('allow'));
    expect(resolveAuth).toHaveBeenCalledOnce();
    expect(f.frames.find((frame) => frame.id === 'child-auth')?.result?.headersApplied).toBe(true);
    await handle.close();
    await consuming;
    expect(events.filter((event) => event.type === 'text')).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('child-fixture-key');
  });
});

describe('ZCode startup resource receipts', () => {
  // Review #3: Maker owns host leases; only a confirmed adapter stop may release them.
  // Existing generic Maker tests inject receipt errors and cannot prove ZCode emits them.
  // These cases enter the real Maker + ZCode adapter with in-memory child/storage boundaries.
  it.each(['validation', 'factory', 'prepare', 'create', 'ready'] as const)(
    'releases the startup lease after a confirmed %s failure', async (stage) => {
      const failure = new Error('Fixture startup failure');
      const f = runtime(stage === 'factory' ? { createSessionHooks: async () => { throw failure; } }
        : stage === 'prepare' ? { prepareClient: async () => { throw failure; } }
          : stage === 'ready' ? { createSessionHooks: () => ({ onSessionReady: async () => { throw failure; } }) }
            : {});
      if (stage === 'create') f.receive((frame) => {
        if (frame.method === 'session/create') f.send({ id: frame.id, error: { code: -32004 } });
      });
      const lifecycle = startupMaker(f.agent);
      try {
        await expect(lifecycle.maker.createSession({ id: 'startup-test', agentKind: 'zcode',
          workingDir: '/work', model: 'm', ...(stage === 'validation' ? { remoteHostId: 'unsupported' } : {}),
        })).rejects.toBeInstanceOf(Error);
        expect(lifecycle.onStartFailed).toHaveBeenCalledWith(expect.objectContaining({
          stage: 'agent-start', runtimeMayBeAlive: false,
        }));
        expect(lifecycle.leases.size).toBe(0);
      } finally { await lifecycle.maker.shutdown(); }
    },
  );

  it('retains the lease after a close timeout until a real process exit is observed', async () => {
    vi.useFakeTimers();
    const closing = deferred<void>();
    const f = runtime({ prepareClient: async () => { throw new Error('Fixture prepare failure'); } });
    f.proc.kill = vi.fn(() => { closing.resolve(); return true; });
    const lifecycle = startupMaker(f.agent);
    try {
      const starting = lifecycle.maker.createSession({ id: 'pending-startup', agentKind: 'zcode', workingDir: '/work', model: 'm' })
        .catch((error: unknown) => error);
      await closing.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      const error = await starting;
      expect(error).toBeInstanceOf(AgentStartupCleanupPendingError);
      expect(lifecycle.onStartFailed).toHaveBeenCalledWith(expect.objectContaining({ runtimeMayBeAlive: true }));
      expect(lifecycle.leases.size).toBe(1);
      let receiptResolved = false;
      void (error as AgentStartupCleanupPendingError).whenStopped.then(() => { receiptResolved = true; });
      f.proc.stdout.emit('end');
      await Promise.resolve();
      expect(receiptResolved).toBe(false);
      expect(lifecycle.leases.size).toBe(1);
      f.proc.emit('close', 0, null);
      await lifecycle.cleanup.promise;
      expect(receiptResolved).toBe(true);
      expect(lifecycle.leases.size).toBe(0);
    } finally {
      f.proc.emit('close', 0, null);
      await lifecycle.maker.shutdown();
      vi.useRealTimers();
    }
  });

  it.each([
    { resumeSessionId: undefined, revoke: false },
    { resumeSessionId: 'restored-native', revoke: false },
    { resumeSessionId: undefined, revoke: true },
  ])(
    'awaits the native-identity receipt: $resumeSessionId / revoked=$revoke', async ({ resumeSessionId, revoke }) => {
      const ready = deferred<void>(), entered = deferred<string>();
      const onSessionReady = vi.fn(async (nativeId: string) => { entered.resolve(nativeId); await ready.promise; });
      const f = runtime({ createSessionHooks: () => ({ onSessionReady }) });
      let published = false;
      const starting = f.agent.startSession({ workingDir: '/work', model: 'm', resumeSessionId }).then((handle) => {
        published = true;
        return handle;
      });
      try {
        expect(await entered.promise).toBe(resumeSessionId ?? 'native-session');
        expect(published).toBe(false);
        if (revoke) await f.agent.closeAccountSessions();
        ready.resolve();
        if (revoke) {
          await expect(starting).rejects.toThrow('account changed');
          expect(published).toBe(false);
        } else {
          const handle = await starting;
          expect(onSessionReady).toHaveBeenCalledOnce();
          await handle.close();
        }
      } finally { ready.resolve(); await f.agent.dispose(); }
    },
  );
});
