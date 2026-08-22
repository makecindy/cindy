import { describe, expect, it, vi } from 'vitest';

import { Maker } from '@cindy/maker-core';
import type { AgentSessionHandle, BaseAgent } from '@cindy/maker-core';
import type { SessionMeta, SessionStorage } from '@cindy/maker-core';

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
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createHandle(id: string): AgentSessionHandle {
  return {
    id,
    agentKind: 'codex',
    model: 'gpt-5.4',
    async send() {},
    async steer() {},
    async abort() {},
    async close() {},
    async *events() {
      await new Promise<never>(() => {});
      yield undefined as never;
    },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
    isTurnRunning: () => false,
  };
}

function createCodexAgent(
  startSession: (opts: unknown) => Promise<AgentSessionHandle>,
): BaseAgent {
  return {
    kind: 'codex',
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

describe('local codex session start preparation', () => {
  it('refreshes CODEX_HOME assets in onBeforeStart before starting the agent', async () => {
    const order: string[] = [];
    const ensureGlobalCodexAssets = vi.fn(async () => {
      order.push('assets');
      return { skillsProjectionEpoch: 0 };
    });
    const beforeLocalCodexSessionStart = vi.fn(async () => {
      order.push('deferred-restart');
    });
    const startSession = vi.fn(async () => {
      order.push('start');
      return createHandle('thread-1');
    });

    const maker = new Maker({
      agents: { codex: createCodexAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        onBeforeStart: async ({ agentKind, remoteHostId }) => {
          if (agentKind === 'codex' && !remoteHostId) {
            await ensureGlobalCodexAssets();
            await beforeLocalCodexSessionStart();
          }
        },
      },
    });

    await maker.createSession({
      id: 'session-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    });

    expect(order).toEqual(['assets', 'deferred-restart', 'start']);
    expect(ensureGlobalCodexAssets).toHaveBeenCalledTimes(1);
    expect(beforeLocalCodexSessionStart).toHaveBeenCalledTimes(1);
  });

  it('force-reloads Codex skills/list after a rebuilt global projection', async () => {
    const order: string[] = [];
    const dirtyByCwd = new Set<string>(['/repo']);
    const ensureGlobalCodexAssets = vi.fn(async () => {
      order.push('assets');
      return { skillsProjectionEpoch: 1 };
    });
    const codexSkillsListReloadEpoch = vi.fn((workingDir?: string | null) =>
      dirtyByCwd.has(workingDir || '') ? 1 : null,
    );
    const listAgentSkills = vi.fn(
      async (_opts: { workingDir?: string; forceReload?: boolean }) => {
        order.push('force-reload');
        return { skills: [] };
      },
    );
    const markCodexSkillsListCacheReloaded = vi.fn(
      (workingDir: string | null | undefined, _reloadedEpoch: number) => {
        dirtyByCwd.delete(workingDir || '');
        order.push('mark-reloaded');
      },
    );
    const startSession = vi.fn(async () => {
      order.push('start');
      return createHandle('thread-1');
    });

    const maker = new Maker({
      agents: { codex: createCodexAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        onBeforeStart: async ({ agentKind, workingDir, remoteHostId }) => {
          let globalSkillsReloadEpoch: number | null = null;
          if (agentKind === 'codex' && !remoteHostId) {
            await ensureGlobalCodexAssets();
            globalSkillsReloadEpoch = codexSkillsListReloadEpoch(workingDir);
          }
          if (agentKind === 'codex' && !remoteHostId && globalSkillsReloadEpoch !== null) {
            await listAgentSkills({ workingDir, forceReload: true });
            markCodexSkillsListCacheReloaded(workingDir, globalSkillsReloadEpoch);
          }
        },
      },
    });

    await maker.createSession({
      id: 'session-reload',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
    });

    expect(order).toEqual(['assets', 'force-reload', 'mark-reloaded', 'start']);
    expect(listAgentSkills).toHaveBeenCalledWith({ workingDir: '/repo', forceReload: true });
    expect(markCodexSkillsListCacheReloaded).toHaveBeenCalledWith('/repo', 1);
  });

  it('keeps skills/list dirty for other cwds after one cwd is force-reloaded', async () => {
    const dirtyByCwd = new Set<string>(['/repo-a', '/repo-b']);
    const ensureGlobalCodexAssets = vi.fn(async () => ({ skillsProjectionEpoch: 1 }));
    const codexSkillsListReloadEpoch = vi.fn((workingDir?: string | null) =>
      dirtyByCwd.has(workingDir || '') ? 1 : null,
    );
    const listAgentSkills = vi.fn(
      async (_opts: { workingDir?: string; forceReload?: boolean }) => ({ skills: [] }),
    );
    const markCodexSkillsListCacheReloaded = vi.fn(
      (workingDir: string | null | undefined, _reloadedEpoch: number) => {
        dirtyByCwd.delete(workingDir || '');
      },
    );
    const startSession = vi.fn(async () => createHandle('thread-multi-cwd'));

    const maker = new Maker({
      agents: { codex: createCodexAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        onBeforeStart: async ({ agentKind, workingDir, remoteHostId }) => {
          let globalSkillsReloadEpoch: number | null = null;
          if (agentKind === 'codex' && !remoteHostId) {
            await ensureGlobalCodexAssets();
            globalSkillsReloadEpoch = codexSkillsListReloadEpoch(workingDir);
          }
          if (agentKind === 'codex' && !remoteHostId && globalSkillsReloadEpoch !== null) {
            await listAgentSkills({ workingDir, forceReload: true });
            markCodexSkillsListCacheReloaded(workingDir, globalSkillsReloadEpoch);
          }
        },
      },
    });

    await maker.createSession({
      id: 'session-a',
      agentKind: 'codex',
      workingDir: '/repo-a',
      model: 'gpt-5.4',
    });
    expect(listAgentSkills).toHaveBeenCalledWith({ workingDir: '/repo-a', forceReload: true });
    expect(markCodexSkillsListCacheReloaded).toHaveBeenCalledWith('/repo-a', 1);
    expect(codexSkillsListReloadEpoch('/repo-a')).toBeNull();
    expect(codexSkillsListReloadEpoch('/repo-b')).toBe(1);

    await maker.createSession({
      id: 'session-b',
      agentKind: 'codex',
      workingDir: '/repo-b',
      model: 'gpt-5.4',
    });
    expect(listAgentSkills).toHaveBeenCalledWith({ workingDir: '/repo-b', forceReload: true });
    expect(markCodexSkillsListCacheReloaded).toHaveBeenCalledWith('/repo-b', 1);
    expect(codexSkillsListReloadEpoch('/repo-b')).toBeNull();
  });

  it('skips CODEX_HOME asset refresh for remote codex sessions', async () => {
    const ensureGlobalCodexAssets = vi.fn(async () => ({ skillsProjectionEpoch: 0 }));
    const startSession = vi.fn(async () => createHandle('thread-remote'));
    const maker = new Maker({
      agents: { codex: createCodexAgent(startSession) },
      storage: createStorage(),
      logger: createLogger(),
      lifecycleHooks: {
        onBeforeStart: async ({ agentKind, remoteHostId }) => {
          if (agentKind === 'codex' && !remoteHostId) {
            await ensureGlobalCodexAssets();
          }
        },
      },
    });

    await maker.createSession({
      id: 'session-remote',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.4',
      remoteHostId: 'ssh-host-1',
    });

    expect(ensureGlobalCodexAssets).not.toHaveBeenCalled();
    expect(startSession).toHaveBeenCalledTimes(1);
  });
});
