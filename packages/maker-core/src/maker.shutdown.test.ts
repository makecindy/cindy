import { CodexAgent } from './agents/codex/index.js';
import { describe, expect, it, vi } from 'vitest';

import { Maker } from './maker.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import { AgentStartupCleanupPendingError, type BaseAgent } from './agents/base-agent.js';
import type { Logger } from './interfaces/logger.js';
import type { SessionMeta, SessionStorage } from './interfaces/session-storage.js';

const logger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => logger,
};

function createStorage(): SessionStorage {
  const rows = new Map<string, SessionMeta>();
  return {
    async create(meta) {
      const row: SessionMeta = {
        ...meta,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      rows.set(row.id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return Array.from(rows.values());
    },
    async update(id, patch) {
      const prev = rows.get(id);
      if (!prev) throw new Error(`missing session ${id}`);
      const next = { ...prev, ...patch, updatedAt: Date.now() };
      rows.set(id, next);
      return next;
    },
    async compareAndClearSdkSessionId(id, expectedSdkSessionId) {
      const prev = rows.get(id);
      if (!prev || prev.sdkSessionId !== expectedSdkSessionId) return false;
      rows.set(id, { ...prev, sdkSessionId: undefined, updatedAt: Date.now() });
      return true;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

function createHandle(overrides: Partial<AgentSessionHandle>): AgentSessionHandle {
  return {
    id: 'sdk-1',
    agentKind: 'claude-code',
    model: 'm',
    send: async () => undefined,
    steer: async () => undefined,
    abort: async () => undefined,
    close: async () => undefined,
    events: async function* () {
      yield* [];
      await new Promise<never>(() => undefined);
    },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver: () => undefined,
    ...overrides,
  };
}

function createAgent(handle: AgentSessionHandle): BaseAgent {
  return {
    capabilities: {
      switchModel: { supported: false, reason: 'not-implemented' },
      effort: { supported: false, reason: 'not-implemented' },
      permissionModes: [],
      setPermissionModeMidSession: { supported: false, reason: 'not-implemented' },
      rewind: { supported: false, reason: 'not-implemented' },
      memory: { supported: false, reason: 'not-implemented' },
    } as never,
    startSession: vi.fn(async () => handle),
    dispose: vi.fn(async () => undefined),
  } as unknown as BaseAgent;
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('Maker.shutdown', () => {
  it.each(['exhaust', 'exhaust-route', 'cancel'] as const)('settles Maker startup after native initialization %s', async mode => {
    const module = await import('./agents/codex/app-server/stdioTransport.js');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const methods: string[] = [];
    let routeCurrent = true;
    const spawn = vi.spyOn(module, 'createStdioTransport').mockImplementation(() => {
      const closeHandlers = new Set<import('./agents/codex/app-server/transport.js').CloseHandler>();
      let failed = false;
      return {
        nativeSqliteInitializationFailed: () => failed,
        onLine: () => () => {},
        onClose: handler => { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
        writeLine: async line => {
          methods.push(JSON.parse(line).method);
          if (mode === 'exhaust-route' && methods.length === 3) routeCurrent = false;
          failed = true;
          for (const handler of closeHandlers) handler({ reason: 'native exited before initialize' });
        },
        close: async () => { if (mode === 'cancel') await gate; },
      };
    });
    const agent = new CodexAgent({ logger, binaryPath: 'synthetic', runtimeConfig: {},
      resolveCodexLocalAuthPolicy: () => ({ policy: 'legacy-shared', isCurrent: () => routeCurrent }),
      auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}), triggerLogin: async () => ({ authenticated: true }), logout: async () => {} },
    });
    let guarded = false;
    const failed = vi.fn(({ runtimeMayBeAlive }: { runtimeMayBeAlive?: boolean }) => { if (!runtimeMayBeAlive) guarded = false; });
    const maker = new Maker({ agents: { codex: agent }, storage: createStorage(), logger,
      lifecycleHooks: { onBeforeStart: async () => { guarded = true; }, onStartFailed: failed },
    });
    try {
      const startup = maker.createSession({ id: 'native-stop', agentKind: 'codex', model: 'fixture', providerId: 'openai', workingDir: '/fixture' });
      const rejection = expect(startup).rejects.toThrow(mode === 'cancel' ? /cancelled/ : /initialization stopped/);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
      if (mode === 'cancel') { const disposing = agent.dispose(); release(); await disposing; }
      await rejection;
      expect(spawn).toHaveBeenCalledTimes(mode === 'cancel' ? 1 : 3);
      expect(methods.every(method => method === 'initialize')).toBe(true);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ runtimeMayBeAlive: false }));
      expect(guarded).toBe(false);
      expect(maker.listActiveSessions()).toEqual([]);
    } finally { release(); await maker.shutdown(); spawn.mockRestore(); }
  });

  it.each(['cancel', 'exhaust', 'spawn-exhaust'] as const)('releases the real Codex startup guard after route %s before any host exists', async (mode) => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let revision = 0;
    const prepareSpawn = vi.fn(async () => { revision++; return { extraArgs: [], extraEnv: {}, codexProxyActive: true }; });
    const resolveRoute = vi.fn(async () => {
      entered();
      if (mode === 'cancel') await new Promise<void>(() => {});
      const captured = revision;
      return { policy: 'isolated' as const, isCurrent: () => mode === 'spawn-exhaust' && captured === revision };
    });
    const agent = new CodexAgent({
      logger, binaryPath: process.execPath, runtimeConfig: {},
      auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}), triggerLogin: async () => ({ authenticated: true }), logout: async () => {} },
      resolveCodexLocalAuthPolicy: resolveRoute,
      ...(mode === 'spawn-exhaust' ? { prepareCodexExtraSpawnConfig: prepareSpawn } : {}),
    });
    let guarded = false;
    const failed = vi.fn(({ runtimeMayBeAlive }: { runtimeMayBeAlive?: boolean }) => { if (!runtimeMayBeAlive) guarded = false; });
    const maker = new Maker({ agents: { codex: agent }, storage: createStorage(), logger,
      lifecycleHooks: { onBeforeStart: async () => { guarded = true; }, onStartFailed: failed },
    });
    const result = maker.createSession({ id: 'route-stop', agentKind: 'codex', model: 'fixture', providerId: 'cprov-fixture', workingDir: '/fixture' });
    const rejection = expect(result).rejects.toThrow(mode === 'cancel' ? /cancelled/ : /changed repeatedly/);
    await waiting;
    if (mode === 'cancel') await agent.dispose();
    await rejection;
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agent-start', runtimeMayBeAlive: false }));
    expect(guarded).toBe(false);
    expect(maker.listActiveSessions()).toEqual([]);
    if (mode !== 'cancel') expect(resolveRoute).toHaveBeenCalledTimes(8);
    if (mode === 'spawn-exhaust') expect(prepareSpawn).toHaveBeenCalledTimes(8);
    await maker.shutdown();
  });

  it('waits for deferred startup cleanup hooks before resolving', async () => {
    const stopped = createDeferred();
    const cleanupGate = createDeferred();
    let cleanupEntered = false;
    const pending = new AgentStartupCleanupPendingError('startup cleanup pending', {
      cause: new Error('adapter startup failed'),
      whenStopped: stopped.promise,
    });
    const agent = createAgent(createHandle({ agentKind: 'pi' }));
    agent.startSession = vi.fn().mockRejectedValue(pending);
    const maker = new Maker({
      agents: { pi: agent },
      storage: createStorage(),
      logger,
      lifecycleHooks: {
        onStartCleanupSucceeded: async () => {
          cleanupEntered = true;
          await cleanupGate.promise;
        },
      },
    });
    await expect(maker.createSession({ id: 's-deferred-cleanup', agentKind: 'pi', workingDir: '/w', model: 'm' }))
      .rejects.toBe(pending);

    let shutdownSettled = false;
    const shutdown = maker.shutdown().then(() => { shutdownSettled = true; });
    stopped.resolve();
    await vi.waitFor(() => expect(cleanupEntered).toBe(true));
    expect(shutdownSettled).toBe(false);

    cleanupGate.resolve();
    await shutdown;
    expect(shutdownSettled).toBe(true);
  });

  it('waits for session lifecycle cleanup hooks before resolving', async () => {
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupEntered = false;
    const maker = new Maker({
      agents: { 'claude-code': createAgent(createHandle({})) },
      storage: createStorage(),
      logger,
      lifecycleHooks: {
        onClose: async () => {
          cleanupEntered = true;
          await cleanupGate;
        },
      },
    });
    await maker.createSession({ id: 's-cleanup', agentKind: 'claude-code', workingDir: '/w', model: 'm' });

    let shutdownSettled = false;
    const shutdown = maker.shutdown().then(() => { shutdownSettled = true; });
    await vi.waitFor(() => expect(cleanupEntered).toBe(true));
    expect(shutdownSettled).toBe(false);

    releaseCleanup();
    await shutdown;
    expect(shutdownSettled).toBe(true);
  });

  it('detaches remote-capable sessions instead of full-closing them', async () => {
    const close = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const handle = createHandle({ close, detach });
    const maker = new Maker({
      agents: { 'claude-code': createAgent(handle) },
      storage: createStorage(),
      logger,
    });

    const session = await maker.createSession({
      id: 's-remote',
      agentKind: 'claude-code',
      workingDir: '/w',
      model: 'm',
      remoteHostId: 'host-1',
    });
    const closeReasons: string[] = [];
    maker.on((event) => {
      if (event.type === 'session:closed') closeReasons.push(event.reason);
    });
    expect(session.getStatus()).toBe('active');
    expect(maker.listActiveSessions()).toHaveLength(1);
    await maker.shutdown();

    expect(detach).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(0);
    expect(closeReasons).toEqual(['requested']);
    expect(maker.getSessionCloseReason(session)).toBe('requested');
  });
});
