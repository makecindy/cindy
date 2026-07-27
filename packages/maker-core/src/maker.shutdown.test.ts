import { describe, expect, it, vi } from 'vitest';

import { Maker } from './maker.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import type { BaseAgent } from './agents/base-agent.js';
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
      await new Promise<never>(() => undefined);
    },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver: () => undefined,
    ...overrides,
  };
}

function createAgent(
  handle: AgentSessionHandle,
  startSession = vi.fn(async () => handle),
): BaseAgent {
  return {
    capabilities: {
      switchModel: { supported: false, reason: 'not-implemented' },
      effort: { supported: false, reason: 'not-implemented' },
      permissionModes: [],
      setPermissionModeMidSession: { supported: false, reason: 'not-implemented' },
      rewind: { supported: false, reason: 'not-implemented' },
      memory: { supported: false, reason: 'not-implemented' },
    } as never,
    startSession,
    dispose: vi.fn(async () => undefined),
  } as unknown as BaseAgent;
}

describe('Maker.shutdown', () => {
  it('quiesces new session starts and waits for an in-flight start without closing it', async () => {
    let resolveStart!: (handle: AgentSessionHandle) => void;
    const handle = createHandle({});
    const startPending = new Promise<AgentSessionHandle>((resolve) => {
      resolveStart = resolve;
    });
    const startSession = vi.fn(() => startPending);
    const maker = new Maker({
      agents: { 'claude-code': createAgent(handle, startSession) },
      storage: createStorage(),
      logger,
    });
    const options = {
      agentKind: 'claude-code' as const,
      workingDir: '/w',
      model: 'm',
    };

    const creation = maker.createSession({ ...options, id: 'in-flight' });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(startSession).toHaveBeenCalledTimes(1);

    let quiesced = false;
    const drain = maker.quiesceSessionStarts().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    await expect(
      maker.createSession({ ...options, id: 'late-start' }),
    ).rejects.toThrow('new session starts are not accepted');

    resolveStart(handle);
    await expect(creation).resolves.toBeDefined();
    await drain;
    expect(quiesced).toBe(true);
    expect(startSession).toHaveBeenCalledTimes(1);
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
    expect(session.getStatus()).toBe('active');
    expect(maker.listActiveSessions()).toHaveLength(1);
    await maker.shutdown();

    expect(detach).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(0);
  });
});
