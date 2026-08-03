import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import { Maker, type CreateSessionOptions } from './maker.js';
import { Session } from './session.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import type { AgentSessionHandle, BaseAgent } from './agents/base-agent.js';
import type { SessionMeta, SessionStorage } from './interfaces/session-storage.js';
import type { AgentKind, PermissionMode } from './types/common.js';
import type { AgentEvent } from './types/events.js';

/** A generator that never completes — simulates a live session handle. */
async function* neverEndingIterator(): AsyncGenerator<AgentEvent> {
  await new Promise<never>(() => {}); // never resolves
  yield undefined as never;
}

function createStorage(): SessionStorage {
  const rows = new Map<string, SessionMeta>();
  return {
    async create(meta) {
      const now = Date.now();
      const row = { ...meta, createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error(`missing ${id}`);
      const next = { ...row, ...patch, updatedAt: Date.now() };
      rows.set(id, next);
      return next;
    },
    async compareAndClearSdkSessionId(id, expectedSdkSessionId) {
      const row = rows.get(id);
      if (!row || row.sdkSessionId !== expectedSdkSessionId) return false;
      rows.set(id, { ...row, sdkSessionId: undefined, updatedAt: Date.now() });
      return true;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

function createLogger() {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn: vi.fn(),
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

describe('Maker agent status', () => {
  it('represents an optional unregistered runtime as binary-missing', async () => {
    const maker = new Maker({
      agents: {},
      storage: createStorage(),
      logger: createLogger(),
    });
    await expect(maker.getAgentStatus('pi')).resolves.toEqual({
      binaryReady: false,
      binaryPath: null,
      authReady: false,
    });
  });
});

function createAgent(
  startSession: (opts: CreateSessionOptions) => Promise<unknown>,
  kind: AgentKind = 'codex',
): BaseAgent {
  return {
    kind,
    capabilities: {
      availableModels: [],
      effortLevels: [],
      permissionModes: [],
      reasoning: { supported: false },
      images: { supported: false },
      slashCommands: { supported: false },
      customSlashCommands: { supported: false },
      memory: { supported: false },
      fork: { supported: false },
      rewind: { supported: false },
      extraDirs: { supported: false },
    },
    startSession,
  } as unknown as BaseAgent;
}

function createHandle(args: {
  id: string;
  agentKind?: AgentKind;
  delivery?: { threadId: string; historyHasProductPrompt: boolean };
}): AgentSessionHandle {
  return {
    id: args.id,
    agentKind: args.agentKind ?? 'codex',
    model: 'gpt-5.4',
    codexProductPromptDelivery: args.delivery,
    async send() {},
    async steer() {},
    async abort() {},
    async close() {},
    async *events() { yield* neverEndingIterator(); },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
    isTurnRunning: () => false,
  };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Maker session creation singleflight', () => {
  it('binds each rebuilt business session to a fresh runtime instance id', async () => {
    const seenInstanceIds: string[] = [];
    const startSession = vi.fn(async (opts: CreateSessionOptions) => {
      seenInstanceIds.push(opts.sessionInstanceId ?? '');
      return createHandle({ id: `thread-${seenInstanceIds.length}` });
    });
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const options: CreateSessionOptions = {
      id: 'session-rebuilt',
      sessionInstanceId: 'caller-must-not-control-this',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    };

    const first = await maker.createSession(options);
    expect(first.instanceId).toBe(seenInstanceIds[0]);
    expect(first.instanceId).not.toBe('caller-must-not-control-this');

    await maker.closeSession(options.id!);
    const second = await maker.createSession(options);

    expect(second.instanceId).toBe(seenInstanceIds[1]);
    expect(second.instanceId).not.toBe(first.instanceId);
  });

  it('shares one startup when the same business session is restored concurrently', async () => {
    let resolveStart!: (handle: AgentSessionHandle) => void;
    const startPending = new Promise<AgentSessionHandle>((resolve) => {
      resolveStart = resolve;
    });
    const startSession = vi.fn(() => startPending);
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const created = vi.fn();
    maker.on((event) => {
      if (event.type === 'session:created') created(event.session);
    });
    const options: CreateSessionOptions = {
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: 'thread-1',
    };

    const first = maker.createSession(options);
    const second = maker.createSession({ ...options });

    expect(startSession).toHaveBeenCalledTimes(1);
    resolveStart(createHandle({ id: 'thread-1' }));
    const [firstSession, secondSession] = await Promise.all([first, second]);

    expect(secondSession).toBe(firstSession);
    expect(maker.listActiveSessions()).toEqual([firstSession]);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith(firstSession);
  });

  it('clears a failed startup so the same business session can be retried', async () => {
    const startupError = new Error('start failed');
    const startSession = vi.fn()
      .mockRejectedValueOnce(startupError)
      .mockResolvedValueOnce(createHandle({ id: 'thread-recovered' }));
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const options: CreateSessionOptions = {
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: 'thread-1',
    };

    const first = maker.createSession(options);
    const joined = maker.createSession({ ...options });
    await expect(Promise.all([first, joined])).rejects.toBe(startupError);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(maker.listActiveSessions()).toEqual([]);

    await expect(maker.createSession({ ...options })).resolves.toBeInstanceOf(Session);
    expect(startSession).toHaveBeenCalledTimes(2);
  });

  it('rejects a second business task using the same live Codex thread until close completes', async () => {
    const threadId = '11111111-1111-1111-1111-111111111111';
    const closeGate = createDeferred();
    const firstHandle = createHandle({ id: threadId });
    firstHandle.close = vi.fn(() => closeGate.promise);
    const secondHandle = createHandle({ id: threadId });
    const startSession = vi.fn()
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle);
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const options = (id: string): CreateSessionOptions => ({
      id,
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: threadId,
    });

    await maker.createSession(options('session-a'));
    await expect(maker.createSession(options('session-b'))).rejects.toThrow(
      /already active in another Cindy task/i,
    );
    expect(startSession).toHaveBeenCalledTimes(1);

    const closing = maker.closeSession('session-a');
    await vi.waitFor(() => expect(firstHandle.close).toHaveBeenCalledTimes(1));
    await expect(maker.createSession(options('session-b'))).rejects.toThrow(
      /already active in another Cindy task/i,
    );
    expect(startSession).toHaveBeenCalledTimes(1);

    closeGate.resolve();
    await closing;
    const replacement = await maker.createSession(options('session-b'));
    expect(replacement.sdkSessionId).toBe(threadId);
    expect(startSession).toHaveBeenCalledTimes(2);
    await replacement.close();
  });

  it('scopes Codex thread claims by remote target and permits different threads', async () => {
    const sharedThread = '22222222-2222-2222-2222-222222222222';
    const otherThread = '33333333-3333-3333-3333-333333333333';
    const startSession = vi.fn(async (opts: CreateSessionOptions) =>
      createHandle({ id: opts.resumeSessionId! }),
    );
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const base = {
      agentKind: 'codex' as const,
      workingDir: '/repo',
      model: 'gpt-5.4',
    };

    const local = await maker.createSession({
      ...base,
      id: 'session-local',
      resumeSessionId: sharedThread,
    });
    const remote = await maker.createSession({
      ...base,
      id: 'session-remote',
      remoteHostId: 'remote-1',
      resumeSessionId: sharedThread,
    });
    const other = await maker.createSession({
      ...base,
      id: 'session-other-thread',
      resumeSessionId: otherThread,
    });

    expect(startSession).toHaveBeenCalledTimes(3);
    await Promise.all([local.close(), remote.close(), other.close()]);
  });

  it('releases a provisional Codex thread claim when startup fails', async () => {
    const threadId = '44444444-4444-4444-4444-444444444444';
    const startSession = vi.fn()
      .mockRejectedValueOnce(new Error('resume failed'))
      .mockResolvedValueOnce(createHandle({ id: threadId }));
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const options = (id: string): CreateSessionOptions => ({
      id,
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: threadId,
    });

    await expect(maker.createSession(options('session-failed'))).rejects.toThrow('resume failed');
    const recovered = await maker.createSession(options('session-recovered'));

    expect(startSession).toHaveBeenCalledTimes(2);
    await recovered.close();
  });

  it('moves the Codex thread claim when the live handle reports a replacement id', async () => {
    const firstThread = '55555555-5555-5555-5555-555555555555';
    const nextThread = '66666666-6666-6666-6666-666666666666';
    const firstEvents = createAsyncQueue<AgentEvent>();
    const firstHandle = createHandle({ id: firstThread });
    firstHandle.events = () => firstEvents;
    const startSession = vi.fn(async (opts: CreateSessionOptions) =>
      opts.id === 'session-a'
        ? firstHandle
        : createHandle({ id: opts.resumeSessionId! }),
    );
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const base = {
      agentKind: 'codex' as const,
      workingDir: '/repo',
      model: 'gpt-5.4',
    };
    const first = await maker.createSession({
      ...base,
      id: 'session-a',
      resumeSessionId: firstThread,
    });
    const moved = new Promise<void>((resolve) => {
      const unsubscribe = first.onEvent((event) => {
        if (event.type !== 'session_id' || event.data !== nextThread) return;
        unsubscribe();
        resolve();
      });
    });

    firstEvents.push({ type: 'session_id', data: nextThread, source: 'codex' });
    await moved;

    const oldThreadReuse = await maker.createSession({
      ...base,
      id: 'session-old-thread-reuse',
      resumeSessionId: firstThread,
    });
    await expect(maker.createSession({
      ...base,
      id: 'session-next-thread-conflict',
      resumeSessionId: nextThread,
    })).rejects.toThrow(/already active in another Cindy task/i);

    await Promise.all([first.close(), oldThreadReuse.close()]);
  });

  it('closes the Codex handle and releases its claim when session storage fails', async () => {
    const threadId = '77777777-7777-7777-7777-777777777777';
    const storage = createStorage();
    const create = storage.create.bind(storage);
    storage.create = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementation(create);
    const failedHandle = createHandle({ id: threadId });
    failedHandle.close = vi.fn(async () => {});
    const startSession = vi.fn()
      .mockResolvedValueOnce(failedHandle)
      .mockResolvedValueOnce(createHandle({ id: threadId }));
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage,
      logger: createLogger(),
    });
    const options = (id: string): CreateSessionOptions => ({
      id,
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: threadId,
    });

    await expect(maker.createSession(options('session-storage-failed'))).rejects.toThrow(
      'storage unavailable',
    );
    expect(failedHandle.close).toHaveBeenCalledTimes(1);

    const recovered = await maker.createSession(options('session-storage-recovered'));
    expect(startSession).toHaveBeenCalledTimes(2);
    await recovered.close();
  });
});

describe('Maker session close events', () => {
  it('preserves the explicit close reason and exact Session identity', async () => {
    const maker = new Maker({
      agents: {
        codex: createAgent(async () => createHandle({ id: 'thread-1' })),
      },
      storage: createStorage(),
      logger: createLogger(),
    });
    const closed = vi.fn();
    maker.on((event) => {
      if (event.type === 'session:closed') closed(event);
    });
    const session = await maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    });

    await maker.closeSession('session-1', 'agent-switch');

    expect(closed).toHaveBeenCalledWith({
      type: 'session:closed',
      sessionId: 'session-1',
      session,
      reason: 'agent-switch',
    });
  });

  it('removes a session whose event iterator crashes and recreates it on the next request', async () => {
    const crashingHandle = createHandle({ id: 'thread-crashed' });
    crashingHandle.events = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            throw new Error('iterator crashed');
          },
        };
      },
    });
    crashingHandle.close = vi.fn(async () => undefined);
    const healthyHandle = createHandle({ id: 'thread-rebuilt' });
    const startSession = vi.fn()
      .mockResolvedValueOnce(crashingHandle)
      .mockResolvedValueOnce(healthyHandle);
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    maker.on((event) => {
      if (event.type === 'session:closed' && event.sessionId === 'session-crash') {
        expect(event.reason).toBe('unexpected');
        resolveClosed();
      }
    });
    const options: CreateSessionOptions = {
      id: 'session-crash',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    };

    await maker.createSession(options);
    await closed;
    expect(maker.getSession('session-crash')).toBeUndefined();
    expect(maker.listActiveSessions()).toEqual([]);

    const rebuilt = await maker.createSession(options);
    expect(rebuilt.sdkSessionId).toBe('thread-rebuilt');
    expect(startSession).toHaveBeenCalledTimes(2);
  });

  it('retries a failed crash cleanup before recreating the session', async () => {
    const crashingHandle = createHandle({ id: 'thread-crashed-close-retry' });
    crashingHandle.events = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            throw new Error('iterator crashed');
          },
        };
      },
    });
    let closeAttempts = 0;
    crashingHandle.close = vi.fn(async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('transport close failed');
    });
    const healthyHandle = createHandle({ id: 'thread-rebuilt-after-close-retry' });
    const startSession = vi.fn()
      .mockResolvedValueOnce(crashingHandle)
      .mockResolvedValueOnce(healthyHandle);
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
    });
    const options: CreateSessionOptions = {
      id: 'session-crash-close-retry',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    };

    const crashed = await maker.createSession(options);
    await vi.waitFor(() => expect(crashed.getStatus()).toBe('error'));
    expect(maker.getSession('session-crash-close-retry')).toBe(crashed);

    const rebuilt = await maker.createSession(options);
    expect(rebuilt.sdkSessionId).toBe('thread-rebuilt-after-close-retry');
    expect(maker.getSession('session-crash-close-retry')).toBe(rebuilt);
    expect(closeAttempts).toBe(2);
    expect(startSession).toHaveBeenCalledTimes(2);
  });
});

describe('Maker before-start lifecycle hook', () => {
  it('awaits host preparation before starting the agent', async () => {
    const order: string[] = [];
    const onBeforeStart = vi.fn(async () => {
      order.push('prepare');
    });
    const startSession = vi.fn(async () => {
      order.push('start');
      return createHandle({ id: 'thread-1' });
    });
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: { onBeforeStart },
    });

    await maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    });

    expect(order).toEqual(['prepare', 'start']);
    expect(onBeforeStart).toHaveBeenCalledWith({
      agentKind: 'codex',
      workingDir: '/repo',
    });
  });

  it('keeps session startup fail-soft when host preparation fails', async () => {
    const logger = createLogger();
    const startSession = vi.fn(async () => createHandle({ id: 'thread-1' }));
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger,
      lifecycleHooks: {
        onBeforeStart: async () => {
          throw new Error('prepare failed');
        },
      },
    });

    await expect(maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    })).resolves.toBeInstanceOf(Session);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'lifecycleHooks.onBeforeStart threw; continuing session startup',
      expect.objectContaining({ sessionId: 'session-1', workingDir: '/repo' }),
    );
  });
});

describe('Maker start-option lifecycle hooks', () => {
  it('prepares mutable start options before the agent and marks success before publish', async () => {
    const order: string[] = [];
    const startSession = vi.fn(async (opts: CreateSessionOptions) => {
      order.push('start');
      expect(opts.vendorOptions).toMatchObject({ orcaRole: 'lead' });
      expect(opts.userPrompt).toBe('orca instructions');
      return createHandle({ id: 'thread-1' });
    });
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        prepareStartOptions: async (_sessionId, opts) => {
          order.push('prepare');
          opts.vendorOptions = { orcaRole: 'lead' };
          opts.userPrompt = 'orca instructions';
        },
        onStartSucceeded: async (sessionId, opts) => {
          order.push('succeeded');
          expect(sessionId).toBe('session-1');
          expect(opts.vendorOptions).toMatchObject({ orcaRole: 'lead' });
          expect(maker.getSession(sessionId)).toBeUndefined();
        },
      },
    });
    maker.on((event) => {
      if (event.type === 'session:created') order.push('publish');
    });

    await maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    });

    expect(order).toEqual(['prepare', 'start', 'succeeded', 'publish']);
  });

  it('blocks agent startup when start-option preparation fails', async () => {
    const startSession = vi.fn(async () => createHandle({ id: 'thread-1' }));
    const onStartSucceeded = vi.fn();
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        prepareStartOptions: async () => {
          throw new Error('prepare failed');
        },
        onStartSucceeded,
      },
    });

    await expect(maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    })).rejects.toThrow('prepare failed');
    expect(startSession).not.toHaveBeenCalled();
    expect(onStartSucceeded).not.toHaveBeenCalled();
    expect(maker.listActiveSessions()).toEqual([]);
  });

  it('does not run the success hook when agent startup fails', async () => {
    const onStartSucceeded = vi.fn();
    const maker = new Maker({
      agents: { codex: createAgent(vi.fn().mockRejectedValue(new Error('start failed'))) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: { onStartSucceeded },
    });

    await expect(maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    })).rejects.toThrow('start failed');
    expect(onStartSucceeded).not.toHaveBeenCalled();
  });
});

describe('Maker codex prompt lifecycle hooks', () => {
  it('hydrates codex history prompt state before startSession and persists delivery facts after success', async () => {
    const startSession = vi.fn(async () => ({
      id: 'thread-1',
      agentKind: 'codex',
      model: 'gpt-5.4',
      codexProductPromptDelivery: {
        threadId: 'thread-1',
        historyHasProductPrompt: false,
      },
      async send() {},
      async steer() {},
      async abort() {},
      async close() {},
      async *events() {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver() {},
      isTurnRunning: () => false,
    }));
    const getCodexHistoryHasProductPrompt = vi.fn(async () => false);
    const onCodexProductPromptDelivery = vi.fn(async () => undefined);
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        getCodexHistoryHasProductPrompt,
        onCodexProductPromptDelivery,
      },
    });

    await maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: 'thread-1',
    });

    expect(getCodexHistoryHasProductPrompt).toHaveBeenCalledWith('session-1');
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      codexHistoryHasProductPrompt: false,
    }));
    expect(onCodexProductPromptDelivery).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
      historyHasProductPrompt: false,
    });
  });

  it('does not persist codex prompt state for broken handles', async () => {
    const startSession = vi.fn(async () => ({
      id: '<failed>',
      agentKind: 'codex',
      model: 'gpt-5.4',
      codexProductPromptDelivery: {
        threadId: 'thread-1',
        historyHasProductPrompt: true,
      },
      async send() {},
      async abort() {},
      async close() {},
      async *events() {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver() {},
      isTurnRunning: () => false,
    }));
    const onCodexProductPromptDelivery = vi.fn(async () => undefined);
    const maker = new Maker({
      agents: { codex: createAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: { onCodexProductPromptDelivery },
    });

    await maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: 'thread-1',
    });

    expect(onCodexProductPromptDelivery).not.toHaveBeenCalled();
  });

  it('routes codex prompt lifecycle hooks only through createSession resume success paths', async () => {
    const codexStartSession = vi.fn(async (opts: CreateSessionOptions) => {
      if (opts.id === 'codex-resume') {
        return createHandle({
          id: 'thread-resume',
          delivery: { threadId: 'thread-resume', historyHasProductPrompt: true },
        });
      }
      if (opts.id === 'codex-failed') {
        return createHandle({
          id: '<failed>',
          delivery: { threadId: 'thread-failed', historyHasProductPrompt: false },
        });
      }
      return createHandle({ id: 'thread-new' });
    });
    const claudeStartSession = vi.fn(async () => createHandle({
      id: 'claude-thread',
      agentKind: 'claude-code',
    }));
    const getCodexHistoryHasProductPrompt = vi.fn(async () => false);
    const onCodexProductPromptDelivery = vi.fn(async () => undefined);
    const maker = new Maker({
      agents: {
        codex: createAgent(codexStartSession),
        'claude-code': createAgent(claudeStartSession, 'claude-code'),
      },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        getCodexHistoryHasProductPrompt,
        onCodexProductPromptDelivery,
      },
    });

    await maker.createSession({
      id: 'codex-resume',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: 'thread-resume',
    });
    await maker.createSession({
      id: 'codex-failed',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      resumeSessionId: 'thread-failed',
    });
    await maker.createSession({
      id: 'codex-new',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    });
    await maker.createSession({
      id: 'claude-resume',
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-sonnet-4-5',
      resumeSessionId: 'claude-thread',
    });

    expect(getCodexHistoryHasProductPrompt).toHaveBeenCalledTimes(2);
    expect(getCodexHistoryHasProductPrompt).toHaveBeenNthCalledWith(1, 'codex-resume');
    expect(getCodexHistoryHasProductPrompt).toHaveBeenNthCalledWith(2, 'codex-failed');
    expect(codexStartSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codex-resume',
      sessionId: 'codex-resume',
      resumeSessionId: 'thread-resume',
      codexHistoryHasProductPrompt: false,
    }));
    expect(onCodexProductPromptDelivery).toHaveBeenCalledTimes(1);
    expect(onCodexProductPromptDelivery).toHaveBeenCalledWith({
      sessionId: 'codex-resume',
      threadId: 'thread-resume',
      historyHasProductPrompt: true,
    });
  });
});

describe('Maker session capabilities', () => {
  it('persists dialogue workspace kind separately from the allocated working directory', async () => {
    const storage = createStorage();
    const maker = new Maker({
      agents: { codex: createAgent(async () => createHandle({ id: 'dialogue-thread' }), 'codex') },
      storage,
      logger: createLogger(),
    });

    await maker.createSession({
      id: 'dialogue-session',
      agentKind: 'codex',
      workingDir: '/userData/dialogues/2026-06-29/dialogue-session',
      workspaceKind: 'dialogue',
      model: 'gpt-5.4',
    });

    await expect(maker.getSessionMeta('dialogue-session')).resolves.toMatchObject({
      id: 'dialogue-session',
      workDir: '/userData/dialogues/2026-06-29/dialogue-session',
      workspaceKind: 'dialogue',
    });
  });

  it('marks remote Codex session rewind as platform-limited without mutating agent capabilities', async () => {
    const agent = createAgent(async () => createHandle({ id: 'remote-thread' }), 'codex');
    agent.capabilities.rewind = { supported: true };
    const maker = new Maker({
      agents: { codex: agent },
      storage: createStorage(),
      logger: createLogger(),
    });

    const session = await maker.createSession({
      id: 'remote-session',
      agentKind: 'codex',
      workingDir: '/remote/repo',
      model: 'gpt-5.4',
      remoteHostId: 'remote-1',
    });

    expect(session.capabilities.rewind).toMatchObject({
      supported: false,
      reason: 'platform-limited',
    });
    expect(agent.capabilities.rewind).toEqual({ supported: true });
  });
});

describe('Session turn send guard', () => {
  it('reserves the turn synchronously while handle.send is still awaiting', async () => {
    let publishRelease!: (release: () => void) => void;
    const releaseReady = new Promise<() => void>((resolve) => {
      publishRelease = resolve;
    });
    let handleTurnRunning = false;
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        publishRelease(resolve);
      });
      handleTurnRunning = true;
    });
    handle.isTurnRunning = () => handleTurnRunning;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: path.join('workspace', 'repo'),
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const firstSend = session.send('first');
    await Promise.resolve();

    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(handle.send).toHaveBeenCalledTimes(1);

    const releaseSend = await releaseReady;
    releaseSend();
    await firstSend;

    expect(session.isTurnRunning()).toBe(true);
  });

  it('keeps the reservation when abort runs before handle.send observes a running turn', async () => {
    let publishRelease!: (release: () => void) => void;
    const releaseReady = new Promise<() => void>((resolve) => {
      publishRelease = resolve;
    });
    let handleTurnRunning = false;
    let sendCalls = 0;
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => {
      sendCalls += 1;
      if (sendCalls > 1) {
        throw new Error('second send reached handle');
      }
      await new Promise<void>((resolve) => {
        publishRelease(() => {
          handleTurnRunning = true;
          resolve();
        });
      });
    });
    handle.isTurnRunning = () => handleTurnRunning;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: path.join('workspace', 'repo'),
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const firstSend = session.send('first');
    const releaseSend = await releaseReady;

    await session.abort();

    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(handle.send).toHaveBeenCalledTimes(1);

    releaseSend();
    await firstSend;
  });

  it('cancels a dispatching reservation before handle.send accepts input', async () => {
    let releaseSend!: () => void;
    let resolveSendStarted!: () => void;
    let sendOpts: Parameters<AgentSessionHandle['send']>[1];
    const sendStarted = new Promise<void>((resolve) => {
      resolveSendStarted = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async (_message, opts) => {
      sendOpts = opts;
      resolveSendStarted();
      await new Promise<void>((resolve, reject) => {
        releaseSend = resolve;
        opts?.signal?.addEventListener('abort', () => reject(new Error('send cancelled')), { once: true });
      });
    });
    handle.abort = vi.fn(async () => undefined);
    handle.isTurnRunning = () => false;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: path.join('workspace', 'repo'),
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const firstSend = session.send('first');
    await sendStarted;
    await session.abort();
    const signalWasAborted = sendOpts?.signal?.aborted;
    releaseSend();

    await expect(firstSend).resolves.toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(signalWasAborted).toBe(true);
    expect(handle.abort).toHaveBeenCalledTimes(1);
  });

  it('does not release a dispatching reservation from an older terminal event', async () => {
    let releaseSend!: () => void;
    let resolveSendStarted!: () => void;
    let sendCalls = 0;
    const sendStarted = new Promise<void>((resolve) => {
      resolveSendStarted = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    const events = createAsyncQueue<AgentEvent>();
    handle.events = () => events;
    handle.send = vi.fn(async () => {
      sendCalls += 1;
      if (sendCalls > 1) {
        throw new Error('second send reached handle');
      }
      resolveSendStarted();
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });
    handle.isTurnRunning = () => false;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const terminalEventObserved = new Promise<void>((resolveEvent) => {
      const unsubscribe = session.onEvent(() => {
        unsubscribe();
        resolveEvent();
      });
    });

    const firstSend = session.send('first');
    await sendStarted;
    events.push({ type: 'done', data: {}, source: 'codex' });
    await terminalEventObserved;

    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    releaseSend();
    await expect(firstSend).resolves.toEqual({ accepted: true });
    events.end();
  });

  it('does not start handle.send when onAccepted fails', async () => {
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    const acceptError = new Error('accept failed');
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    await expect(session.send('first', { onAccepted: () => { throw acceptError; } })).rejects.toBe(acceptError);
    expect(handle.send).not.toHaveBeenCalled();
    await expect(session.send('second')).resolves.toEqual({ accepted: true });
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('does not run accepted persistence or provider send when beforeProviderStart fails', async () => {
    const beforeError = new Error('durable acceptance CAS failed');
    const handle = createHandle({ id: 'thread-before-provider-start' });
    handle.send = vi.fn(async () => undefined);
    const session = new Session({
      id: 'before-provider-start-failure',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const onAccepted = vi.fn();

    await expect(
      session.send('first', {
        beforeProviderStart: () => {
          throw beforeError;
        },
        onAccepted,
      }),
    ).rejects.toBe(beforeError);

    expect(onAccepted).not.toHaveBeenCalled();
    expect(handle.send).not.toHaveBeenCalled();
    await expect(session.send('second')).resolves.toEqual({ accepted: true });
  });

  it('runs provider option preflight before durable or accepted side effects', async () => {
    const preflightError = new Error('unsupported policy/mode combination');
    const handle = createHandle({ id: 'thread-send-preflight' });
    handle.validateSendOptions = vi.fn(() => {
      throw preflightError;
    });
    handle.send = vi.fn(async () => undefined);
    const session = new Session({
      id: 'send-preflight',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const beforeProviderStart = vi.fn();
    const onAccepted = vi.fn();

    await expect(
      session.send('first', {
        beforeProviderStart,
        onAccepted,
      }),
    ).rejects.toBe(preflightError);

    expect(handle.validateSendOptions).toHaveBeenCalledOnce();
    expect(beforeProviderStart).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(handle.send).not.toHaveBeenCalled();
  });

  it('runs reservation state preparation before provider option preflight', async () => {
    const order: string[] = [];
    const handle = createHandle({ id: 'thread-reserved-preflight' });
    handle.validateSendOptions = vi.fn(() => {
      order.push('preflight');
    });
    handle.send = vi.fn(async () => {
      order.push('provider');
    });
    const session = new Session({
      id: 'reserved-preflight',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    await expect(
      session.send('first', {
        afterTurnReserved: () => {
          order.push('reserved');
        },
      }),
    ).resolves.toEqual({ accepted: true });

    expect(order).toEqual(['reserved', 'preflight', 'provider']);
  });

  it('stops before validation or durable acceptance when cancelled during reservation preparation', async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const handle = createHandle({ id: 'thread-reserved-cancelled' });
    handle.validateSendOptions = vi.fn();
    handle.send = vi.fn(async () => undefined);
    handle.abort = vi.fn(async () => undefined);
    const session = new Session({
      id: 'reserved-cancelled',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const beforeProviderStart = vi.fn();
    const onAccepted = vi.fn();
    const sending = session.send('first', {
      afterTurnReserved: () => preparation,
      beforeProviderStart,
      onAccepted,
    });
    await Promise.resolve();

    await session.abort();
    releasePreparation();

    await expect(sending).resolves.toEqual({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    });
    expect(handle.validateSendOptions).not.toHaveBeenCalled();
    expect(beforeProviderStart).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(handle.send).not.toHaveBeenCalled();
  });

  it('does not run reservation preparation when the external signal is already aborted', async () => {
    const handle = createHandle({ id: 'thread-pre-cancelled' });
    handle.send = vi.fn(handle.send);
    const session = new Session({
      id: 'reserved-pre-cancelled',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const afterTurnReserved = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      session.send('first', { signal: controller.signal, afterTurnReserved }),
    ).resolves.toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(afterTurnReserved).not.toHaveBeenCalled();
    expect(handle.send).not.toHaveBeenCalled();
  });

  it('does not run reservation state preparation when another turn is active', async () => {
    let releaseSend!: () => void;
    const sendBarrier = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const handle = createHandle({ id: 'thread-reserved-busy' });
    handle.send = vi.fn(async () => sendBarrier);
    const session = new Session({
      id: 'reserved-busy',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const firstSend = session.send('first');
    await vi.waitFor(() => expect(handle.send).toHaveBeenCalledOnce());
    const afterTurnReserved = vi.fn();

    await expect(session.send('second', { afterTurnReserved })).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
    expect(afterTurnReserved).not.toHaveBeenCalled();

    releaseSend();
    await expect(firstSend).resolves.toEqual({ accepted: true });
  });

  it('awaits beforeProviderStart before accepted persistence and provider dispatch', async () => {
    const order: string[] = [];
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const handle = createHandle({ id: 'thread-before-provider-order' });
    handle.send = vi.fn(async () => {
      order.push('provider');
    });
    const session = new Session({
      id: 'before-provider-start-order',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const sending = session.send('first', {
      beforeProviderStart: async () => {
        order.push('barrier-start');
        await barrier;
        order.push('barrier-end');
      },
      onAccepted: () => {
        order.push('accepted');
      },
    });
    await vi.waitFor(() => expect(order).toEqual(['barrier-start']));
    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    releaseBarrier();
    await expect(sending).resolves.toEqual({ accepted: true });
    expect(order).toEqual(['barrier-start', 'barrier-end', 'accepted', 'provider']);
  });

  it('does not persist acceptance when cancelled during the pre-provider barrier', async () => {
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const handle = createHandle({ id: 'thread-before-provider-cancelled' });
    handle.send = vi.fn(async () => undefined);
    handle.abort = vi.fn(async () => undefined);
    const session = new Session({
      id: 'before-provider-cancelled',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const onAccepted = vi.fn();
    const sending = session.send('first', {
      beforeProviderStart: () => barrier,
      onAccepted,
    });
    await Promise.resolve();

    await session.abort();
    releaseBarrier();

    await expect(sending).resolves.toEqual({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    });
    expect(onAccepted).not.toHaveBeenCalled();
    expect(handle.send).not.toHaveBeenCalled();
  });

  it('runs onDispatching after acceptance and immediately before vendor send', async () => {
    const calls: string[] = [];
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => {
      calls.push('vendor');
    });
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    await expect(session.send('first', {
      onAccepted: () => {
        calls.push('accepted');
      },
      onDispatching: () => {
        calls.push('dispatching');
      },
    })).resolves.toEqual({ accepted: true });

    expect(calls).toEqual(['accepted', 'dispatching', 'vendor']);
  });

  it('keeps the reservation while onAccepted is awaiting', async () => {
    let releaseAccepted!: () => void;
    const acceptedReady = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const firstSend = session.send('first', { onAccepted: () => acceptedReady });
    await Promise.resolve();

    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(handle.send).not.toHaveBeenCalled();

    releaseAccepted();
    await firstSend;
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('does not release an accepting reservation from an older terminal event', async () => {
    let releaseAccepted!: () => void;
    const acceptedReady = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const events = createAsyncQueue<AgentEvent>();
    const handle = createHandle({ id: 'thread-1' });
    handle.events = () => events;
    handle.send = vi.fn(async () => undefined);
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const terminalEventObserved = new Promise<void>((resolve) => {
      const unsubscribe = session.onEvent(() => {
        unsubscribe();
        resolve();
      });
    });

    const firstSend = session.send('first', { onAccepted: () => acceptedReady });
    await Promise.resolve();
    events.push({ type: 'status', data: { isRunning: false }, source: 'codex' });
    await terminalEventObserved;

    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(handle.send).not.toHaveBeenCalled();

    releaseAccepted();
    await firstSend;
    expect(handle.send).toHaveBeenCalledTimes(1);
    events.end();
  });

  it('does not start handle.send when abort happens while onAccepted is awaiting', async () => {
    let releaseAccepted!: () => void;
    const acceptedReady = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    handle.abort = vi.fn(async () => undefined);
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const firstSend = session.send('first', { onAccepted: () => acceptedReady });
    await Promise.resolve();

    await session.abort();
    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    releaseAccepted();
    await expect(firstSend).resolves.toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(handle.send).not.toHaveBeenCalled();

    await session.send('second');
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('emits a terminal error and closes the session after the event iterator crashes', async () => {
    const crash = new Error('events crashed');
    let crashIterator!: () => void;
    const crashReady = new Promise<void>((resolve) => {
      crashIterator = resolve;
    });
    let releaseClose!: () => void;
    const closeReady = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    handle.close = vi.fn(async () => closeReady);
    const crashingEvents: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            await crashReady;
            throw crash;
          },
        };
      },
    };
    handle.events = () => crashingEvents;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const order: string[] = [];
    const terminalEvents: AgentEvent[] = [];
    session.onEvent((event) => {
      if (event.type === 'error') {
        terminalEvents.push(event);
        order.push('error');
      }
    });
    let closedObserved = false;
    const statusChanged = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') {
          closedObserved = true;
          order.push('closed');
          resolve();
        }
      });
    });

    await session.send('first');
    crashIterator();
    await Promise.resolve();
    await Promise.resolve();

    expect(terminalEvents).toContainEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        reason: 'session_event_loop_crashed',
        isTerminal: true,
      }),
    }));
    expect(order).toEqual(['error']);
    expect(closedObserved).toBe(false);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(session.getStatus()).toBe('active');
    await expect(session.send('second')).rejects.toThrow('is closing');

    releaseClose();
    await statusChanged;
    expect(order).toEqual(['error', 'closed']);
    expect(session.getStatus()).toBe('closed');
    await expect(session.send('third')).rejects.toThrow('is closed');
    expect(handle.send).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('does not publish closed when an iterator crash cannot close the handle', async () => {
    const handle = createHandle({ id: 'thread-crash-close-failed' });
    handle.close = vi.fn(async () => {
      throw new Error('transport close failed');
    });
    handle.events = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            throw new Error('events crashed');
          },
        };
      },
    });
    const session = new Session({
      id: 'session-crash-close-failed',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const terminalErrors: AgentEvent[] = [];
    session.onEvent((event) => {
      if (event.type === 'error') terminalErrors.push(event);
    });
    const statusChanged = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'error') resolve();
      });
    });

    await statusChanged;

    expect(terminalErrors).toContainEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        reason: 'session_event_loop_crashed',
        isTerminal: true,
      }),
    }));
    expect(session.getStatus()).toBe('error');
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('emits a terminal error before closing when the event iterator ends during an active turn', async () => {
    let releaseEnd!: () => void;
    const endReady = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    let running = false;
    const handle = createHandle({ id: 'thread-natural-end-active-turn' });
    handle.send = vi.fn(async () => {
      running = true;
    });
    handle.isTurnRunning = () => running;
    handle.events = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            await endReady;
            return { done: true, value: undefined as never };
          },
        };
      },
    });
    const session = new Session({
      id: 'session-natural-end-active-turn',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const order: string[] = [];
    const terminalErrors: AgentEvent[] = [];
    session.onEvent((event) => {
      if (event.type === 'error') {
        terminalErrors.push(event);
        order.push('error');
      }
    });
    const closed = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') {
          order.push('closed');
          resolve();
        }
      });
    });

    await session.send('first');
    releaseEnd();
    await closed;

    expect(terminalErrors).toContainEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        reason: 'session_event_loop_crashed',
        isTerminal: true,
      }),
    }));
    expect(order).toEqual(['error', 'closed']);
    expect(session.getStatus()).toBe('closed');
  });

  it('clears the turn stall watchdog when the event iterator ends naturally', async () => {
    vi.useFakeTimers();
    try {
      let releaseEnd!: () => void;
      const endReady = new Promise<void>((resolve) => {
        releaseEnd = resolve;
      });
      let running = false;
      const handle = createHandle({ id: 'thread-natural-end' });
      handle.send = vi.fn(async () => {
        running = true;
      });
      handle.isTurnRunning = () => running;
      handle.events = () => ({
        [Symbol.asyncIterator]() {
          let ended = false;
          return {
            async next(): Promise<IteratorResult<AgentEvent>> {
              if (!ended) {
                ended = true;
                await endReady;
                return { done: false, value: { type: 'done', data: {}, source: 'codex' } };
              }
              return { done: true, value: undefined as never };
            },
          };
        },
      });
      const session = new Session({
        id: 'session-natural-end',
        agentKind: 'codex',
        workDir: '/repo',
        handle,
        capabilities: createAgent(async () => handle).capabilities,
        logger: createLogger(),
        turnStallMs: 1_000,
      });
      const closed = new Promise<void>((resolve) => {
        session.onStatusChange((status) => {
          if (status === 'closed') resolve();
        });
      });

      await session.send('first');
      const terminalErrors: AgentEvent[] = [];
      session.onEvent((event) => {
        if (event.type === 'error') terminalErrors.push(event);
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      running = false;
      releaseEnd();
      await closed;
      expect(vi.getTimerCount()).toBe(0);
      expect(terminalErrors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an in-flight send when the event iterator ends naturally', async () => {
    let releaseEnd!: () => void;
    const endReady = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    let sendEntered!: () => void;
    const sendReady = new Promise<void>((resolve) => {
      sendEntered = resolve;
    });
    const handle = createHandle({ id: 'thread-natural-end-pending-send' });
    handle.send = vi.fn(async (_message, opts) => {
      sendEntered();
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) {
          resolve();
          return;
        }
        opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    handle.events = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            await endReady;
            return { done: true, value: undefined as never };
          },
        };
      },
    });
    const session = new Session({
      id: 'session-natural-end-pending-send',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const closed = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });
    const terminalErrors: AgentEvent[] = [];

    session.onEvent((event) => {
      if (event.type === 'error') terminalErrors.push(event);
    });
    const sendPromise = session.send('first');
    await sendEntered;
    releaseEnd();
    await closed;

    await expect(sendPromise).resolves.toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(terminalErrors).toContainEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        reason: 'session_event_loop_crashed',
        isTerminal: true,
      }),
    }));
    expect(session.getStatus()).toBe('closed');
  });

  it('lets an explicit close own the closed status when the event iterator ends first', async () => {
    let releaseEnd!: () => void;
    const endReady = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    let releaseClose!: () => void;
    const closeReady = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const handle = createHandle({ id: 'thread-natural-end-during-close' });
    handle.close = vi.fn(async () => closeReady);
    handle.events = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            await endReady;
            return { done: true, value: undefined as never };
          },
        };
      },
    });
    const session = new Session({
      id: 'session-natural-end-during-close',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const terminalErrors: AgentEvent[] = [];
    session.onEvent((event) => {
      if (event.type === 'error') terminalErrors.push(event);
    });

    const closePromise = session.close();
    releaseEnd();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.getStatus()).toBe('active');
    expect(terminalErrors).toEqual([]);

    releaseClose();
    await closePromise;
    expect(session.getStatus()).toBe('closed');
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('does not revive a closed session when abort is called after the event iterator crashes', async () => {
    const crash = new Error('events crashed');
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    handle.abort = vi.fn(async () => undefined);
    const crashingEvents: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            throw crash;
          },
        };
      },
    };
    handle.events = () => crashingEvents;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const statusChanged = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });

    await session.send('first');
    await statusChanged;
    await session.abort();

    expect(session.getStatus()).toBe('closed');
    await expect(session.send('second')).rejects.toThrow('is closed');
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('does not revive a closed session when the event iterator crashes while abort is awaiting', async () => {
    let releaseAbort!: () => void;
    const abortReady = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    let crashIterator!: () => void;
    const crashReady = new Promise<void>((resolve) => {
      crashIterator = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    handle.abort = vi.fn(async () => {
      await abortReady;
    });
    const crashingEvents: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            await crashReady;
            throw new Error('events crashed during abort');
          },
        };
      },
    };
    handle.events = () => crashingEvents;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const statusChanged = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });

    await session.send('first');
    const abortPromise = session.abort();
    crashIterator();
    await statusChanged;
    releaseAbort();
    await abortPromise;

    expect(session.getStatus()).toBe('closed');
    await expect(session.send('second')).rejects.toThrow('is closed');
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a current terminal error when the iterator crashes while provider send is pending', async () => {
    let markSendEntered!: () => void;
    const sendEntered = new Promise<void>((resolve) => {
      markSendEntered = resolve;
    });
    let releaseSend!: () => void;
    const sendReady = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => {
      markSendEntered();
      await sendReady;
    });
    handle.isTurnRunning = () => false;
    handle.close = vi.fn(async () => undefined);
    handle.events = () => ({
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (first) {
              first = false;
              await sendEntered;
              return {
                done: false,
                value: {
                  type: 'error',
                  data: {
                    message: 'terminal error before provider send settled',
                    reason: 'original_terminal',
                    isTerminal: true,
                  },
                  source: 'codex',
                },
              };
            }
            throw new Error('events crashed after terminal error');
          },
        };
      },
    });
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const terminalReasons: Array<string | undefined> = [];
    session.onEvent((event) => {
      if (event.type === 'error') {
        terminalReasons.push((event.data as { reason?: string }).reason);
      }
    });
    const closed = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });

    const sendPromise = session.send('first');
    await closed;
    releaseSend();
    await sendPromise;

    expect(terminalReasons).toEqual(['original_terminal']);
  });

  it('does not attribute a queued prior-turn error to a newer non-Codex dispatch', async () => {
    let releasePriorError!: () => void;
    const priorErrorReady = new Promise<void>((resolve) => {
      releasePriorError = resolve;
    });
    let releaseCrash!: () => void;
    const crashReady = new Promise<void>((resolve) => {
      releaseCrash = resolve;
    });
    let sendEntered!: () => void;
    const sendReady = new Promise<void>((resolve) => {
      sendEntered = resolve;
    });
    let running = false;
    const handle = createHandle({ id: 'thread-queued-prior-error', agentKind: 'claude-code' });
    handle.isTurnRunning = () => running;
    handle.send = vi.fn(async (message, opts) => {
      if (message.content === 'first') {
        running = false;
        return;
      }
      sendEntered();
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) {
          resolve();
          return;
        }
        opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    handle.events = () => ({
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (first) {
              first = false;
              await priorErrorReady;
              return {
                done: false,
                value: {
                  type: 'error',
                  data: {
                    message: 'queued prior-turn terminal error',
                    reason: 'prior_terminal',
                    isTerminal: true,
                  },
                  source: 'claude-code',
                },
              };
            }
            await crashReady;
            throw new Error('events crashed during newer dispatch');
          },
        };
      },
    });
    const session = new Session({
      id: 'session-queued-prior-error',
      agentKind: 'claude-code',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle, 'claude-code').capabilities,
      logger: createLogger(),
    });
    const terminalReasons: Array<string | undefined> = [];
    session.onEvent((event) => {
      if (event.type === 'error') {
        terminalReasons.push((event.data as { reason?: string }).reason);
      }
    });
    const closed = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });

    await session.send('first');
    const secondSend = session.send('second');
    await sendReady;
    releasePriorError();
    await Promise.resolve();
    releaseCrash();
    await closed;

    await expect(secondSend).resolves.toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    expect(terminalReasons).toEqual(['prior_terminal', 'session_event_loop_crashed']);
  });

  it('reports a crash after a queued prior-turn terminal event when a newer turn is running', async () => {
    let releasePriorDone!: () => void;
    const priorDoneReady = new Promise<void>((resolve) => {
      releasePriorDone = resolve;
    });
    let releaseCrash!: () => void;
    const crashReady = new Promise<void>((resolve) => {
      releaseCrash = resolve;
    });
    let running = false;
    const handle = createHandle({ id: 'thread-1' });
    handle.isTurnRunning = () => running;
    handle.send = vi.fn(async (message) => {
      running = message.content === 'second';
    });
    handle.close = vi.fn(async () => undefined);
    handle.events = () => ({
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (first) {
              first = false;
              await priorDoneReady;
              return { done: false, value: { type: 'done', data: {}, source: 'codex' } };
            }
            await crashReady;
            throw new Error('events crashed during newer turn');
          },
        };
      },
    });
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const terminalErrors: AgentEvent[] = [];
    session.onEvent((event) => {
      if (event.type === 'error') terminalErrors.push(event);
    });
    const closed = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });

    await session.send('first');
    running = false;
    await session.send('second');
    releasePriorDone();
    await Promise.resolve();
    releaseCrash();
    await closed;

    expect(terminalErrors).toContainEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        reason: 'session_event_loop_crashed',
        isTerminal: true,
      }),
    }));
  });

  it('does not call handle.send when close happens during onAccepted', async () => {
    let releaseAccepted!: () => void;
    const acceptedReady = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const firstSend = session.send('first', { onAccepted: () => acceptedReady });
    await Promise.resolve();
    await session.close();
    releaseAccepted();

    await expect(firstSend).rejects.toThrow('is closed');
    expect(handle.send).not.toHaveBeenCalled();
    expect(session.isTurnRunning()).toBe(false);
  });

  it('keeps the session open when closeIfIdle loses to an accepting send', async () => {
    let releaseAccepted!: () => void;
    const acceptedReady = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    handle.close = vi.fn(async () => undefined);
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const send = session.send('first', { onAccepted: () => acceptedReady });
    await Promise.resolve();

    await expect(session.closeIfIdle()).resolves.toBe(false);
    expect(handle.close).not.toHaveBeenCalled();

    releaseAccepted();
    await expect(send).resolves.toEqual({ accepted: true });
  });

  it('rejects a send that starts after closeIfIdle reserves the session close', async () => {
    let releaseClose!: () => void;
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
    handle.close = vi.fn(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });

    const close = session.closeIfIdle();

    await expect(session.send('late send')).rejects.toThrow('is closing');
    expect(handle.send).not.toHaveBeenCalled();

    releaseClose();
    await expect(close).resolves.toBe(true);
  });

  it('releases the failed send reservation but fences reuse until terminal drain closes', async () => {
    const handle = createHandle({ id: 'thread-1' });
    const firstError = new Error('boom');
    handle.close = vi.fn(async () => undefined);
    handle.send = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(undefined);
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: createAgent(async () => handle).capabilities,
      logger: createLogger(),
    });
    const closed = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });

    await expect(session.send('first')).rejects.toBe(firstError);
    expect(session.isTurnRunning()).toBe(false);
    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(handle.send).toHaveBeenCalledTimes(1);

    await closed;
    expect(session.getStatus()).toBe('closed');
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});

describe('Session permission mode leases', () => {
  it('serializes live changes and skips a stale conditional restore', async () => {
    const handle = createHandle({ id: 'permission-thread' });
    const applied: PermissionMode[] = [];
    handle.setPermissionMode = vi.fn(async (mode: PermissionMode) => {
      applied.push(mode);
    });
    const baseCapabilities = createAgent(async () => handle).capabilities;
    const session = new Session({
      id: 'permission-session',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {
        ...baseCapabilities,
        permissionModes: [
          { id: 'ask', displayName: 'Ask' },
          { id: 'auto', displayName: 'Auto' },
          { id: 'bypassPermissions', displayName: 'Full access' },
        ],
        setPermissionModeMidSession: { supported: true },
      },
      logger: createLogger(),
      permissionMode: 'bypassPermissions',
    });

    const temporary = await session.setPermissionModeTracked('ask');
    const userChange = session.setPermissionMode('auto');
    const restored = session.setPermissionModeIfUnchanged(temporary, 'bypassPermissions');

    await expect(userChange).resolves.toBeUndefined();
    await expect(restored).resolves.toBe(false);
    expect(applied).toEqual(['ask', 'auto']);
    expect(session.permissionModeState).toEqual({ mode: 'auto', generation: 2 });
  });

  it('waits for an in-flight permission transition before reserving the next turn', async () => {
    const handle = createHandle({ id: 'permission-transition-thread' });
    handle.send = vi.fn(async () => undefined);
    let releasePermission!: () => void;
    handle.setPermissionMode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePermission = resolve;
        }),
    );
    const baseCapabilities = createAgent(async () => handle).capabilities;
    const session = new Session({
      id: 'permission-transition-session',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {
        ...baseCapabilities,
        permissionModes: [
          { id: 'ask', displayName: 'Ask' },
          { id: 'bypassPermissions', displayName: 'Full access' },
        ],
        setPermissionModeMidSession: { supported: true },
      },
      logger: createLogger(),
      permissionMode: 'bypassPermissions',
    });

    const permissionChange = session.setPermissionModeTracked('ask');
    expect(session.stablePermissionModeState).toBeNull();
    const nextTurn = session.send('after permission restore');
    await vi.waitFor(() => expect(handle.setPermissionMode).toHaveBeenCalledOnce());

    expect(handle.send).not.toHaveBeenCalled();
    releasePermission();
    await expect(permissionChange).resolves.toMatchObject({ mode: 'ask' });
    expect(session.stablePermissionModeState).toEqual({ mode: 'ask', generation: 1 });
    await expect(nextTurn).resolves.toEqual({ accepted: true });
    expect(handle.send).toHaveBeenCalledOnce();
  });

  it('defers an unsafe external permission switch until a host turn lease is released', async () => {
    const handle = createHandle({ id: 'permission-host-lease-thread' });
    const applied: PermissionMode[] = [];
    handle.setPermissionMode = vi.fn(async (mode: PermissionMode) => {
      applied.push(mode);
    });
    handle.send = vi.fn(async () => undefined);
    const baseCapabilities = createAgent(async () => handle).capabilities;
    const session = new Session({
      id: 'permission-host-lease-session',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {
        ...baseCapabilities,
        permissionModes: [
          { id: 'ask', displayName: 'Ask' },
          { id: 'auto', displayName: 'Auto' },
          { id: 'bypassPermissions', displayName: 'Full access' },
        ],
        setPermissionModeMidSession: { supported: true },
        turnPermissionPolicy: {
          supported: { supported: true },
          unsupportedPermissionModes: ['bypassPermissions'],
        },
      },
      logger: createLogger(),
      permissionMode: 'bypassPermissions',
    });

    const releaseLease = session.acquireTurnLease();
    const temporary = await session.setPermissionModeTracked('ask');
    const externalChange = session.setPermissionMode('bypassPermissions');
    await Promise.resolve();

    expect(applied).toEqual(['ask']);
    expect(session.stablePermissionModeState).toBeNull();
    await expect(
      session.setPermissionModeIfUnchanged(temporary, 'bypassPermissions'),
    ).resolves.toBe(false);
    expect(applied).toEqual(['ask']);

    const nextTurn = session.send('after leased permission change');
    releaseLease();
    await expect(externalChange).resolves.toBeUndefined();
    await expect(nextTurn).resolves.toEqual({ accepted: true });
    expect(applied).toEqual(['ask', 'bypassPermissions']);
    expect(handle.send).toHaveBeenCalledOnce();
  });

  it('allows a safe external permission switch during a host turn lease', async () => {
    const handle = createHandle({ id: 'permission-safe-host-lease-thread' });
    const applied: PermissionMode[] = [];
    handle.setPermissionMode = vi.fn(async (mode: PermissionMode) => {
      applied.push(mode);
    });
    const baseCapabilities = createAgent(async () => handle).capabilities;
    const session = new Session({
      id: 'permission-safe-host-lease-session',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {
        ...baseCapabilities,
        permissionModes: [
          { id: 'ask', displayName: 'Ask' },
          { id: 'auto', displayName: 'Auto' },
          { id: 'bypassPermissions', displayName: 'Full access' },
        ],
        setPermissionModeMidSession: { supported: true },
        turnPermissionPolicy: {
          supported: { supported: true },
          unsupportedPermissionModes: ['bypassPermissions'],
        },
      },
      logger: createLogger(),
      permissionMode: 'bypassPermissions',
    });

    const releaseLease = session.acquireTurnLease();
    const temporary = await session.setPermissionModeTracked('ask');
    await expect(session.setPermissionMode('auto')).resolves.toBeUndefined();
    await expect(
      session.setPermissionModeIfUnchanged(temporary, 'bypassPermissions'),
    ).resolves.toBe(false);
    releaseLease();

    expect(applied).toEqual(['ask', 'auto']);
    expect(session.permissionModeState).toEqual({ mode: 'auto', generation: 2 });
  });
});

describe('Maker invalid-resume persistence bridge', () => {
  it('injects a compare-and-clear callback for resumed Claude sessions', async () => {
    const storage = createStorage();
    await storage.create({
      id: 'session-1',
      agentKind: 'claude-code',
      workDir: '/repo',
      title: 'Resume me',
      model: 'claude-opus-4-6',
      sdkSessionId: 'sdk-old',
    });
    const startSession = vi.fn(async (opts: CreateSessionOptions) => {
      expect(await opts.onInvalidResumeSession?.('sdk-old')).toBe(true);
      expect(await opts.onInvalidResumeSession?.('sdk-old')).toBe(false);
      return createHandle({ id: '<pending>', agentKind: 'claude-code' });
    });
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession, 'claude-code') },
      storage,
      logger: createLogger(),
    });
    await maker.createSession({
      id: 'session-1',
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-opus-4-6',
      resumeSessionId: 'sdk-old',
    });
    expect((await storage.get('session-1'))?.sdkSessionId).toBeUndefined();
  });

  it('injects a compare-and-clear callback for fresh (non-resume) Claude sessions too', async () => {
    // 全新会话(无 resumeSessionId)也可能把首个 turn 崩溃前落库的 fresh sdk id 变成幽灵 id,
    // 需要同一把 CAS 才能清掉。之前该回调只对 resume 会话装配,全新会话会漏。
    const storage = createStorage();
    let captured: CreateSessionOptions['onInvalidResumeSession'];
    const startSession = vi.fn(async (opts: CreateSessionOptions) => {
      captured = opts.onInvalidResumeSession;
      return createHandle({ id: 'sdk-fresh', agentKind: 'claude-code' });
    });
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession, 'claude-code') },
      storage,
      logger: createLogger(),
    });
    await maker.createSession({
      id: 'session-fresh',
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-opus-4-6',
      // 无 resumeSessionId —— 全新会话
    });

    expect(captured).toBeDefined();
    // fresh id 已落库;CAS 能把它清掉(index.ts 的 fresh-session self-reference 恢复会调它)。
    expect((await storage.get('session-fresh'))?.sdkSessionId).toBe('sdk-fresh');
    expect(await captured?.('sdk-fresh')).toBe(true);
    expect((await storage.get('session-fresh'))?.sdkSessionId).toBeUndefined();
    // CAS 不匹配(已清)时再次调用返回 false,不误覆盖。
    expect(await captured?.('sdk-fresh')).toBe(false);
  });

  it('clears after in-flight writes and ignores stale session_id events that arrive after recovery', async () => {
    const baseStorage = createStorage();
    await baseStorage.create({
      id: 'session-1',
      agentKind: 'claude-code',
      workDir: '/repo',
      title: 'Resume me',
      model: 'claude-opus-4-6',
      sdkSessionId: 'sdk-old',
    });

    let releaseOldWrite!: () => void;
    let markOldWriteStarted!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => {
      markOldWriteStarted = resolve;
    });
    const oldWriteGate = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    let shouldBlockOldWrite = true;
    const persistedSdkSessionIds: string[] = [];
    const compareAndClear = vi.fn((id: string, expectedSdkSessionId: string) =>
      baseStorage.compareAndClearSdkSessionId(id, expectedSdkSessionId),
    );
    const storage: SessionStorage = {
      ...baseStorage,
      async update(id, patch) {
        if (typeof patch.sdkSessionId === 'string') {
          persistedSdkSessionIds.push(patch.sdkSessionId);
          if (patch.sdkSessionId === 'sdk-old' && shouldBlockOldWrite) {
            shouldBlockOldWrite = false;
            markOldWriteStarted();
            await oldWriteGate;
          }
        }
        return baseStorage.update(id, patch);
      },
      compareAndClearSdkSessionId: compareAndClear,
    };

    const oldEvents = createAsyncQueue<AgentEvent>();
    const freshEvents = createAsyncQueue<AgentEvent>();
    const oldHandle = createHandle({ id: '<pending>', agentKind: 'claude-code' });
    oldHandle.events = () => oldEvents;
    oldHandle.close = vi.fn(async () => oldEvents.end());
    const freshHandle = createHandle({ id: '<pending>', agentKind: 'claude-code' });
    freshHandle.events = () => freshEvents;
    freshHandle.close = vi.fn(async () => freshEvents.end());

    let startCount = 0;
    const startSession = vi.fn(async (opts: CreateSessionOptions) => {
      startCount += 1;
      if (startCount === 1) return oldHandle;
      expect(await opts.onInvalidResumeSession?.('sdk-old')).toBe(true);
      return freshHandle;
    });
    const maker = new Maker({
      agents: { 'claude-code': createAgent(startSession, 'claude-code') },
      storage,
      logger: createLogger(),
    });

    await maker.createSession({
      id: 'session-1',
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-opus-4-6',
      resumeSessionId: 'sdk-old',
    });
    oldEvents.push({ type: 'session_id', data: 'sdk-old', source: 'claude-code' });
    await oldWriteStarted;
    await maker.closeSession('session-1');

    const recoveredSessionPromise = maker.createSession({
      id: 'session-1',
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-opus-4-6',
      resumeSessionId: 'sdk-old',
    });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(2));
    expect(compareAndClear).not.toHaveBeenCalled();

    releaseOldWrite();
    await recoveredSessionPromise;
    expect(compareAndClear).toHaveBeenCalledTimes(1);
    expect((await storage.get('session-1'))?.sdkSessionId).toBeUndefined();

    // CAS 后晚到的旧 query 事件必须跳过；fresh query 的新 id 仍按原路径回填。
    freshEvents.push({ type: 'session_id', data: 'sdk-old', source: 'claude-code' });
    freshEvents.push({ type: 'session_id', data: 'sdk-fresh', source: 'claude-code' });
    await vi.waitFor(async () =>
      expect((await storage.get('session-1'))?.sdkSessionId).toBe('sdk-fresh'),
    );
    expect(persistedSdkSessionIds).toEqual(['sdk-old', 'sdk-fresh']);
    await maker.closeSession('session-1');
  });
});
