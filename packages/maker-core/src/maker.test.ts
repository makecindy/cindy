import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import { Maker, type CreateSessionOptions } from './maker.js';
import { Session } from './session.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import type { AgentSessionHandle, BaseAgent } from './agents/base-agent.js';
import type { SessionMeta, SessionStorage } from './interfaces/session-storage.js';
import type { AgentKind } from './types/common.js';
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

describe('Maker session creation singleflight', () => {
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

  it('rejects sends after the event iterator crashes', async () => {
    const crash = new Error('events crashed');
    const handle = createHandle({ id: 'thread-1' });
    handle.send = vi.fn(async () => undefined);
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
        if (status === 'error') resolve();
      });
    });

    await session.send('first');
    await statusChanged;

    await expect(session.send('second')).rejects.toThrow('is in error state');
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('does not revive an error session when abort is called after the event iterator crashes', async () => {
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
        if (status === 'error') resolve();
      });
    });

    await session.send('first');
    await statusChanged;
    await session.abort();

    expect(session.getStatus()).toBe('error');
    await expect(session.send('second')).rejects.toThrow('is in error state');
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('does not revive an error session when the event iterator crashes while abort is awaiting', async () => {
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
        if (status === 'error') resolve();
      });
    });

    await session.send('first');
    const abortPromise = session.abort();
    crashIterator();
    await statusChanged;
    releaseAbort();
    await abortPromise;

    expect(session.getStatus()).toBe('error');
    await expect(session.send('second')).rejects.toThrow('is in error state');
    expect(handle.send).toHaveBeenCalledTimes(1);
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

  it('releases the reservation when handle.send fails before a turn starts', async () => {
    const handle = createHandle({ id: 'thread-1' });
    const firstError = new Error('boom');
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

    await expect(session.send('first')).rejects.toBe(firstError);
    await expect(session.send('second')).resolves.toEqual({ accepted: true });
    expect(handle.send).toHaveBeenCalledTimes(2);
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
