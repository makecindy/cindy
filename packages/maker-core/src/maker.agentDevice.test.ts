/**
 * 「Agent 在另一台电脑运行」的 Maker 路由:任务仍是本机任务(本机存储、本机 Session),
 * 只把 Agent 的启动交给 startDeviceAgentSession;那台电脑记进任务记录,恢复时回到同一台。
 */
import { describe, expect, it, vi } from 'vitest';

import { Maker } from './maker.js';
import type { AgentSessionHandle, BaseAgent } from './agents/base-agent.js';
import { NotSupportedError } from './types/capabilities.js';
import type { SessionMeta, SessionStorage } from './interfaces/session-storage.js';
import type { AgentEvent } from './types/events.js';

function storage(): SessionStorage & { rows: Map<string, SessionMeta> } {
  const rows = new Map<string, SessionMeta>();
  return {
    rows,
    async create(meta) {
      const row = { ...meta, createdAt: Date.now(), updatedAt: Date.now() };
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
      const next = { ...rows.get(id)!, ...patch, updatedAt: Date.now() };
      rows.set(id, next);
      return next;
    },
    async compareAndClearSdkSessionId() {
      return false;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };

async function* idle(): AsyncGenerator<AgentEvent> {
  await new Promise<never>(() => {});
  yield undefined as never;
}

function handle(id: string): AgentSessionHandle {
  return {
    id,
    agentKind: 'pi',
    model: 'spark/qwen',
    async send() {},
    async steer() {},
    async abort() {},
    async close() {},
    events: () => idle(),
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
  } as unknown as AgentSessionHandle;
}

function localAgent(): BaseAgent & { startSession: ReturnType<typeof vi.fn> } {
  return {
    kind: 'pi',
    capabilities: {
      availableModels: [], effortLevels: [], permissionModes: [], reasoning: { supported: false },
      images: { supported: false }, slashCommands: { supported: false }, customSlashCommands: { supported: false },
      memory: { supported: false }, fork: { supported: false }, rewind: { supported: true }, extraDirs: { supported: false },
    },
    startSession: vi.fn(async () => handle('local-sdk')),
    filterActiveSkillCommands: (result: unknown) => result,
    async dispose() {},
  } as unknown as BaseAgent & { startSession: ReturnType<typeof vi.fn> };
}

describe('Maker: agent on another computer', () => {
  it('starts the agent through the device starter and records the computer on the task', async () => {
    const store = storage();
    const agent = localAgent();
    const startDeviceAgentSession = vi.fn<(input: { agentKind: string; deviceId: string; options: unknown }) => Promise<AgentSessionHandle>>(
      async () => handle('remote-sdk'),
    );
    const maker = new Maker({ agents: { pi: agent }, storage: store, logger, startDeviceAgentSession });
    const session = await maker.createSession({
      id: 'task-1', agentKind: 'pi', workingDir: '/repo', model: 'spark/qwen', providerId: 'spark', agentDeviceId: 'dev-b',
    });
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(startDeviceAgentSession).toHaveBeenCalledTimes(1);
    expect(startDeviceAgentSession.mock.calls[0][0]).toMatchObject({
      agentKind: 'pi',
      deviceId: 'dev-b',
      options: expect.objectContaining({ sessionId: 'task-1', workingDir: '/repo', model: 'spark/qwen', providerId: 'spark' }),
    });
    expect(store.rows.get('task-1')?.agentDeviceId).toBe('dev-b');
    // 那台的 Cindy 不能转发对话截断时不提供回退(文件按本机保存点回退，对话在那台截断)。
    expect(session.capabilities.rewind).toMatchObject({
      supported: false,
      message: expect.stringMatching(/Update Cindy on the computer running the agent/),
    });
    await maker.shutdown();
  });

  it('offers rewind when the agent computer forwards conversation truncation', async () => {
    const agent = localAgent();
    const remote = { ...handle('remote-sdk'), commitRewindFiles: vi.fn(async () => ({ ok: true })) } as unknown as AgentSessionHandle;
    const maker = new Maker({
      agents: { pi: agent }, storage: storage(), logger, startDeviceAgentSession: async () => remote,
    });
    const session = await maker.createSession({
      id: 'task-r', agentKind: 'pi', workingDir: '/repo', model: 'spark/qwen', agentDeviceId: 'dev-b',
    });
    expect(session.capabilities.rewind.supported).toBe(true);
    await maker.shutdown();
  });

  it('keeps the agent capabilities untouched for local tasks', async () => {
    const agent = localAgent();
    const maker = new Maker({ agents: { pi: agent }, storage: storage(), logger });
    const session = await maker.createSession({ id: 'task-l', agentKind: 'pi', workingDir: '/repo', model: 'm' });
    expect(session.capabilities).toBe(agent.capabilities);
    await maker.shutdown();
  });

  it('refuses to mix with SSH hosts and reports a missing starter instead of running here', async () => {
    const maker = new Maker({ agents: { pi: localAgent() }, storage: storage(), logger });
    await expect(maker.createSession({ id: 't2', agentKind: 'pi', workingDir: '/repo', model: 'm', agentDeviceId: 'dev-b' }))
      .rejects.toBeInstanceOf(NotSupportedError);
    const withStarter = new Maker({
      agents: { pi: localAgent() }, storage: storage(), logger, startDeviceAgentSession: async () => handle('x'),
    });
    await expect(withStarter.createSession({
      id: 't3', agentKind: 'pi', workingDir: '/repo', model: 'm', agentDeviceId: 'dev-b', remoteHostId: 'ssh-1',
    })).rejects.toThrow();
    await maker.shutdown();
    await withStarter.shutdown();
  });

  it('only starts hosted sessions that carry the controller workspace', async () => {
    const agent = localAgent();
    const maker = new Maker({ agents: { pi: agent }, storage: storage(), logger });
    await expect(maker.startHostedAgentSession('pi', { workingDir: '/shadow', model: 'm' })).rejects.toThrow(/deviceHosted/);
    await maker.startHostedAgentSession('pi', {
      workingDir: '/shadow',
      model: 'm',
      deviceHosted: {
        workingDir: '/repo', extraDirs: [], writableDirs: [], platform: 'darwin', shell: 'zsh', isGitRepo: false,
        tunnelUrl: 'http://127.0.0.1:1', tunnelToken: 't', mcpServers: [],
      },
    });
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    await maker.shutdown();
  });
});
