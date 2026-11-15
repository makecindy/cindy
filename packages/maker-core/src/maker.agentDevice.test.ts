/**
 * 「Agent 在另一台电脑运行」的 Maker 路由:任务仍是本机任务(本机存储、本机 Session),
 * 只把 Agent 的启动交给 startDeviceAgentSession;那台电脑记进任务记录,恢复时回到同一台。
 */
import { describe, expect, it, vi } from 'vitest';

import { Maker } from './maker.js';
import { createAsyncQueue, type AsyncQueue } from './agents/shared/async-queue.js';
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
  it('starts local and hosted tasks as standard after relaxation when the task has not re-enabled Fast', async () => {
    const agent = localAgent();
    const policy = {
      isAllowed: () => true,
      isRequestAllowed: () => false,
      subscribe: () => () => {},
    };
    const maker = new Maker({
      agents: { pi: agent }, storage: storage(), logger,
      lifecycleHooks: { prepareStartOptions: (_id, opts) => { opts.fastModePolicy = policy; } },
    });
    await maker.createSession({ id: 'task-standard', agentKind: 'pi', workingDir: '/repo', model: 'm', fastMode: true });
    expect(agent.startSession.mock.lastCall?.[0].fastMode).toBe(false);
    const hosted = await maker.startHostedAgentSession('pi', {
      workingDir: '/shadow', model: 'm', fastMode: true, fastModePolicy: policy,
      deviceHosted: {
        workingDir: '/repo', extraDirs: [], writableDirs: [], platform: 'darwin', shell: 'zsh', isGitRepo: false,
        tunnelUrl: 'http://127.0.0.1:1', tunnelToken: 't', mcpServers: [],
      },
    });
    expect(agent.startSession.mock.lastCall?.[0].fastMode).toBe(false);
    await hosted.close();
    await maker.shutdown();
  });

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
    // 发送边界据此判断供应商目录在对端，不能拿本机目录裁决。
    expect(session.agentDeviceId).toBe('dev-b');
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
    expect(session.agentDeviceId).toBeNull();
    await maker.shutdown();
  });

  it('marks the session by the branch that actually started it, not a stored device id', async () => {
    const store = storage();
    await store.create({ id: 'task-d', agentKind: 'pi', workDir: '/repo', title: 't', model: 'm', agentDeviceId: 'dev-b' } as SessionMeta);
    const agent = localAgent();
    const startDeviceAgentSession = vi.fn(async () => handle('remote-sdk'));
    const maker = new Maker({ agents: { pi: agent }, storage: store, logger, startDeviceAgentSession });
    // 宿主读取任务记录失败、按本机降级启动时不带 agentDeviceId；事后读回的记录仍写着那台电脑。
    const session = await maker.createSession({ id: 'task-d', agentKind: 'pi', workingDir: '/repo', model: 'm' });
    expect(startDeviceAgentSession).not.toHaveBeenCalled();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(session.agentDeviceId).toBeNull();
    await maker.shutdown();
  });

  it('treats an empty agent device id as local at the send boundary', async () => {
    const agent = localAgent();
    const startDeviceAgentSession = vi.fn(async () => handle('remote-sdk'));
    const maker = new Maker({ agents: { pi: agent }, storage: storage(), logger, startDeviceAgentSession });
    const session = await maker.createSession({
      id: 'task-empty-device', agentKind: 'pi', workingDir: '/repo', model: 'm', agentDeviceId: '',
    });
    expect(startDeviceAgentSession).not.toHaveBeenCalled();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(session.agentDeviceId).toBeNull();
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

// ── 远程 Claude Code：fork 出的新编号要等这一轮成功才写成持久编号 ──────────────────
const SDK_A = '11111111-1111-4111-8111-111111111111';
const SDK_B = '22222222-2222-4222-8222-222222222222';

function claudeAgent(): BaseAgent {
  return {
    kind: 'claude-code',
    capabilities: {
      availableModels: [], effortLevels: [], permissionModes: [], reasoning: { supported: false },
      images: { supported: false }, slashCommands: { supported: false }, customSlashCommands: { supported: false },
      memory: { supported: false }, fork: { supported: false }, rewind: { supported: true }, extraDirs: { supported: false },
    },
    startSession: vi.fn(async () => {
      throw new Error('local Claude start is not wired in this test');
    }),
    filterActiveSkillCommands: (result: unknown) => result,
    async dispose() {},
  } as unknown as BaseAgent;
}

/** 一个把事件交给测试的 Claude 句柄；`remote` 决定它走设备通道还是本机通道。 */
async function openClaudeTask(input: { id: string; remote: boolean; persistedSdkSessionId?: string }) {
  const store = storage();
  await store.create({
    id: input.id,
    agentKind: 'claude-code',
    workDir: '/repo',
    title: 't',
    model: 'claude-opus-4-6',
    ...(input.persistedSdkSessionId ? { sdkSessionId: input.persistedSdkSessionId } : {}),
    ...(input.remote ? { agentDeviceId: 'dev-b' } : {}),
  } as SessionMeta);

  const queues: Array<AsyncQueue<AgentEvent>> = [];
  const open = async (): Promise<AgentSessionHandle> => {
    const events = createAsyncQueue<AgentEvent>();
    queues.push(events);
    return {
      id: input.persistedSdkSessionId ?? '<pending>',
      agentKind: 'claude-code',
      model: 'claude-opus-4-6',
      async send() {},
      async steer() {},
      async abort() {},
      async close() { events.end(); },
      events: () => events,
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
  };

  const agent = claudeAgent();
  (agent.startSession as ReturnType<typeof vi.fn>).mockImplementation(open);
  const startDeviceAgentSession = vi.fn<(request: { options: { resumeSessionId?: string } }) => Promise<AgentSessionHandle>>(open);
  const maker = new Maker({
    agents: { 'claude-code': agent },
    storage: store,
    logger,
    ...(input.remote ? { startDeviceAgentSession } : {}),
  });
  const create = (resumeSessionId?: string) => maker.createSession({
    id: input.id,
    agentKind: 'claude-code',
    workingDir: '/repo',
    model: 'claude-opus-4-6',
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(input.remote ? { agentDeviceId: 'dev-b' } : {}),
  });
  /** 让已推入的事件和它们排队的持久化都跑完。 */
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { maker, store, queues, startDeviceAgentSession, create, settle };
}

const connectionLostError: AgentEvent = {
  type: 'error',
  data: {
    message: '[REMOTE_AGENT_EXPIRED] The task is no longer running on the other computer.',
    isTerminal: true,
    reason: 'remote_agent_closed',
  },
  source: 'claude-code',
};

describe('Maker: remote Claude keeps the last good sdkSessionId when a turn is lost', () => {
  it('keeps A after resume reports a new id B and the turn then fails with REMOTE_AGENT_EXPIRED', async () => {
    const task = await openClaudeTask({ id: 'remote-lost', remote: true, persistedSdkSessionId: SDK_A });
    await task.create(SDK_A);

    task.queues[0].push({ type: 'session_id', data: SDK_B, source: 'claude-code' });
    task.queues[0].push(connectionLostError);
    await task.settle();

    // 修复前这里是 B：B 在对方电脑上没有对话记录，下一次 resume 会开出空会话。
    expect((await task.store.get('remote-lost'))?.sdkSessionId).toBe(SDK_A);

    // 失败后重发走 lazy create-session：它读库里的编号去 resume，必须还是 A。
    task.queues[0].end();
    await task.settle();
    const persisted = (await task.maker.getSessionMeta('remote-lost'))?.sdkSessionId;
    await task.create(persisted);
    expect(task.startDeviceAgentSession).toHaveBeenCalledTimes(2);
    expect(task.startDeviceAgentSession.mock.calls[1][0].options.resumeSessionId).toBe(SDK_A);
    await task.maker.shutdown();
  });

  it('keeps A when the remote session closes before the turn finished', async () => {
    const task = await openClaudeTask({ id: 'remote-closed', remote: true, persistedSdkSessionId: SDK_A });
    await task.create(SDK_A);

    task.queues[0].push({ type: 'session_id', data: SDK_B, source: 'claude-code' });
    task.queues[0].end();
    await task.settle();

    expect((await task.store.get('remote-closed'))?.sdkSessionId).toBe(SDK_A);
    await task.maker.shutdown();
  });

  it('keeps A when the remote stream crashes after reporting B', async () => {
    const task = await openClaudeTask({ id: 'remote-crashed', remote: true, persistedSdkSessionId: SDK_A });
    await task.create(SDK_A);

    task.queues[0].push({ type: 'session_id', data: SDK_B, source: 'claude-code' });
    task.queues[0].push({
      type: 'error',
      data: { message: 'stream crashed', isTerminal: true },
      source: 'claude-code',
    });
    // 崩溃收尾：终止错误之后还会补一条 done(reason: sdk_stream_crashed)，它不能把 B 提交掉。
    task.queues[0].push({ type: 'done', data: { reason: 'sdk_stream_crashed' }, source: 'claude-code' });
    await task.settle();

    expect((await task.store.get('remote-crashed'))?.sdkSessionId).toBe(SDK_A);
    await task.maker.shutdown();
  });

  it('still commits B when the user stops the remote turn', async () => {
    const task = await openClaudeTask({ id: 'remote-stopped', remote: true, persistedSdkSessionId: SDK_A });
    await task.create(SDK_A);

    task.queues[0].push({ type: 'session_id', data: SDK_B, source: 'claude-code' });
    // Stop 之后 Claude 已写下这一轮的记录，下一轮要接着 B 走。
    task.queues[0].push({ type: 'done', data: { reason: 'user_stop_unconfirmed_wake_tasks' }, source: 'claude-code' });
    await task.settle();

    expect((await task.store.get('remote-stopped'))?.sdkSessionId).toBe(SDK_B);
    await task.maker.shutdown();
  });

  it('commits B once the remote turn finishes', async () => {
    const task = await openClaudeTask({ id: 'remote-ok', remote: true, persistedSdkSessionId: SDK_A });
    await task.create(SDK_A);

    task.queues[0].push({ type: 'session_id', data: SDK_B, source: 'claude-code' });
    await task.settle();
    expect((await task.store.get('remote-ok'))?.sdkSessionId).toBe(SDK_A);

    task.queues[0].push({ type: 'done', data: { reason: 'completed' }, source: 'claude-code' });
    await task.settle();
    expect((await task.store.get('remote-ok'))?.sdkSessionId).toBe(SDK_B);
    await task.maker.shutdown();
  });

  it('saves the first id right away when there is nothing to fall back to', async () => {
    const task = await openClaudeTask({ id: 'remote-first', remote: true });
    await task.create();

    task.queues[0].push({ type: 'session_id', data: SDK_B, source: 'claude-code' });
    await task.settle();

    expect((await task.store.get('remote-first'))?.sdkSessionId).toBe(SDK_B);
    await task.maker.shutdown();
  });

  it('still saves a local Claude session_id right away', async () => {
    const task = await openClaudeTask({ id: 'local-claude', remote: false, persistedSdkSessionId: SDK_A });
    await task.create(SDK_A);

    task.queues[0].push({ type: 'session_id', data: SDK_B, source: 'claude-code' });
    task.queues[0].push(connectionLostError);
    await task.settle();

    expect((await task.store.get('local-claude'))?.sdkSessionId).toBe(SDK_B);
    await task.maker.shutdown();
  });
});
