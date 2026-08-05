import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'codex',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

vi.mock('@/lib/memorySettingsStore', () => ({
  getMakerMemoryEnabled: () => true,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string, images = [], files = []) =>
    JSON.stringify({ text, images, files }),
  ),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

// stopSession 会走 makerApiFor(...).input.stop —— 测试环境无 window.electronAPI,
// 整个 transport 层打桩(仅本文件用到的入口)。
// isRemoteSession 按 id 前缀判定,便于测「远程会话豁免折算」。
vi.mock('@/lib/makerTransport', () => ({
  makerApiFor: () => ({
    input: {
      stop: vi.fn(async () => ({ queue: [], paused: false })),
      clearSession: vi.fn(async () => ({ queue: [], paused: false })),
    },
    closeSession: vi.fn(async () => undefined),
  }),
  getSessionFor: vi.fn(async () => ({})),
  listMessagesFor: vi.fn(async () => []),
  aroundMessagesFor: vi.fn(async () => []),
  aroundMessagesByClientIdFor: vi.fn(async () => []),
  isRemoteSession: (sessionId: string) => sessionId.startsWith('remote-'),
}));

import { EMPTY_SESSION_STATE, handleStreamEvent, makerChatStore } from '@/lib/makerChatStore';
import type { SessionChatState } from '@/lib/makerChatStore';

describe('makerChatStore agent task updates', () => {
  it('preserves Pi as the task provider for explicit and source-derived updates', () => {
    const explicit = handleStreamEvent(
      { ...EMPTY_SESSION_STATE, messages: [], taskUpdates: new Map() },
      {
        sessionId: 's1',
        type: 'agent_task_update',
        source: 'pi',
        data: { provider: 'pi', taskId: 'pi-explicit', status: 'running' },
      } as CCAgentStreamEvent,
    );
    const derived = handleStreamEvent(
      explicit,
      {
        sessionId: 's1',
        type: 'agent_task_update',
        source: 'pi',
        data: { taskId: 'pi-derived', status: 'running' },
      } as CCAgentStreamEvent,
    );

    expect(derived.taskUpdates?.get('pi-explicit')?.provider).toBe('pi');
    expect(derived.taskUpdates?.get('pi-derived')?.provider).toBe('pi');
  });

  it('keeps taskId and parentToolUseId aliases synchronized when later updates only carry taskId', () => {
    const started = handleStreamEvent(
      { ...EMPTY_SESSION_STATE, messages: [], taskUpdates: new Map() },
      {
        sessionId: 's1',
        type: 'agent_task_update',
        source: 'claude-code',
        data: {
          provider: 'claude-code',
          taskId: 'task-1',
          parentToolUseId: 'toolu-1',
          status: 'running',
          title: 'Review auth flow',
        },
      } as CCAgentStreamEvent,
    );

    const completed = handleStreamEvent(
      started,
      {
        sessionId: 's1',
        type: 'agent_task_update',
        source: 'claude-code',
        data: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
          summary: 'Auth flow looks correct',
        },
      } as CCAgentStreamEvent,
    );

    const byTask = completed.taskUpdates?.get('task-1');
    const byParent = completed.taskUpdates?.get('toolu-1');
    expect(byTask).toBe(byParent);
    expect(byTask).toMatchObject({
      taskId: 'task-1',
      parentToolUseId: 'toolu-1',
      status: 'completed',
      title: 'Review auth flow',
      summary: 'Auth flow looks correct',
    });
  });

  it('keeps the authoritative resolved model across task id aliasing and later progress updates', () => {
    const resolved = handleStreamEvent(
      { ...EMPTY_SESSION_STATE, messages: [], taskUpdates: new Map() },
      {
        sessionId: 's1',
        type: 'agent_task_update',
        source: 'claude-code',
        data: {
          provider: 'claude-code',
          taskId: 'agent-a',
          parentToolUseId: 'toolu-1',
          status: 'running',
          model: 'codex/gpt-5.6-sol',
        },
      } as CCAgentStreamEvent,
    );
    const started = handleStreamEvent(
      resolved,
      {
        sessionId: 's1',
        type: 'agent_task_update',
        source: 'claude-code',
        data: {
          provider: 'claude-code',
          taskId: 'task-1',
          parentToolUseId: 'toolu-1',
          status: 'running',
          title: 'Math quiz agent A',
        },
      } as CCAgentStreamEvent,
    );
    const completed = handleStreamEvent(
      started,
      {
        sessionId: 's1',
        type: 'agent_task_update',
        source: 'claude-code',
        data: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
        },
      } as CCAgentStreamEvent,
    );

    expect(completed.taskUpdates?.get('toolu-1')).toMatchObject({
      taskId: 'task-1',
      status: 'completed',
      model: 'codex/gpt-5.6-sol',
      title: 'Math quiz agent A',
    });
  });
});

// ---------------------------------------------------------------------------
// 后台 subagent(local_agent / local_workflow)running 折算 + 唤醒桥接
// 背景:新版 claude 里 Task 默认后台跑,主 turn 先结束、subagent 完成后 SDK 经
// task_notification 自动开 wake turn。turn 间空窗里会话仍在工作,running 快照
// 不能熄灭、「已完成」通知不能提前发。
// ---------------------------------------------------------------------------

/** 构造 reducer 测试用的基础 state(带可写 taskUpdates)。 */
function baseState(overrides?: Partial<SessionChatState>): SessionChatState {
  return { ...EMPTY_SESSION_STATE, messages: [], taskUpdates: new Map(), ...overrides };
}

function taskEvent(
  data: Record<string, unknown>,
): CCAgentStreamEvent {
  return {
    sessionId: 's1',
    type: 'agent_task_update',
    source: 'claude-code',
    data: { provider: 'claude-code', ...data },
  } as CCAgentStreamEvent;
}

describe('pendingTaskWake (唤醒桥接标记)', () => {
  it('local_agent 在 turn 空窗内 completed → 置位;taskType 从 task_started 保留', () => {
    // task_started 带 taskType;终态事件(task_notification)不带——靠 merge 保留
    const started = handleStreamEvent(
      baseState(),
      taskEvent({ taskId: 'task-1', status: 'running', taskType: 'local_agent' }),
    );
    expect(started.pendingTaskWake).toBe(false);

    const completed = handleStreamEvent(
      started,
      taskEvent({ taskId: 'task-1', status: 'completed' }),
    );
    expect(completed.taskUpdates?.get('task-1')?.taskType).toBe('local_agent');
    expect(completed.pendingTaskWake).toBe(true);
  });

  it('failed 同样置位(SDK 对失败任务也会 wake)', () => {
    const started = handleStreamEvent(
      baseState(),
      taskEvent({ taskId: 'task-1', status: 'running', taskType: 'local_workflow' }),
    );
    const failed = handleStreamEvent(started, taskEvent({ taskId: 'task-1', status: 'failed' }));
    expect(failed.pendingTaskWake).toBe(true);
  });

  it('stopped(interrupt 杀掉)不置位——不会有 wake turn 跟进', () => {
    const started = handleStreamEvent(
      baseState(),
      taskEvent({ taskId: 'task-1', status: 'running', taskType: 'local_agent' }),
    );
    const stopped = handleStreamEvent(started, taskEvent({ taskId: 'task-1', status: 'stopped' }));
    expect(stopped.pendingTaskWake).toBe(false);
  });

  it('local_bash(后台 shell,可能长驻)不参与唤醒桥接', () => {
    const started = handleStreamEvent(
      baseState(),
      taskEvent({ taskId: 'bash-1', status: 'running', taskType: 'local_bash' }),
    );
    const completed = handleStreamEvent(started, taskEvent({ taskId: 'bash-1', status: 'completed' }));
    expect(completed.pendingTaskWake).toBe(false);
  });

  it('turn 还在跑时任务 completed 不置位(无空窗可桥)', () => {
    const running = baseState({
      agentStatus: { ...EMPTY_SESSION_STATE.agentStatus, isRunning: true },
    });
    const started = handleStreamEvent(
      running,
      taskEvent({ taskId: 'task-1', status: 'running', taskType: 'local_agent' }),
    );
    const completed = handleStreamEvent(started, taskEvent({ taskId: 'task-1', status: 'completed' }));
    expect(completed.pendingTaskWake).toBe(false);
  });

  it('缺失 taskType(白名单外)不置位——宁可少转不可多转', () => {
    const started = handleStreamEvent(baseState(), taskEvent({ taskId: 'task-1', status: 'running' }));
    const completed = handleStreamEvent(started, taskEvent({ taskId: 'task-1', status: 'completed' }));
    expect(completed.pendingTaskWake).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// workflowProgress(workflow 逐 agent 进度树):CLI 对纯心跳帧节流省略该字段 =
// 沿用上一帧;store 侧 merge 不得清树,入口必须防御收窄坏条目。
// ---------------------------------------------------------------------------

describe('agent_task_update workflowProgress', () => {
  it('第一帧带 workflowProgress、第二帧不带(节流)→ store 保留上一帧的树', () => {
    const first = handleStreamEvent(
      baseState(),
      taskEvent({
        taskId: 'wf-1',
        status: 'running',
        taskType: 'local_workflow',
        workflowProgress: [
          { type: 'workflow_phase', index: 0, title: 'Phase A' },
          { type: 'workflow_agent', index: 1, label: 'worker-a', state: 'progress' },
        ],
      }),
    );
    expect(first.taskUpdates?.get('wf-1')?.workflowProgress).toHaveLength(2);

    const second = handleStreamEvent(
      first,
      taskEvent({ taskId: 'wf-1', status: 'running', lastToolName: 'Bash' }),
    );
    const task = second.taskUpdates?.get('wf-1');
    expect(task?.lastToolName).toBe('Bash');
    expect(task?.workflowProgress).toEqual([
      { type: 'workflow_phase', index: 0, title: 'Phase A' },
      { type: 'workflow_agent', index: 1, label: 'worker-a', state: 'progress' },
    ]);
  });

  it('坏条目在入口被收窄:词表外 type / 非有限 index 丢弃,超长 lastToolSummary 截断', () => {
    const state = handleStreamEvent(
      baseState(),
      taskEvent({
        taskId: 'wf-2',
        status: 'running',
        taskType: 'local_workflow',
        workflowProgress: [
          null,
          { type: 'workflow_step', index: 0 },
          { type: 'workflow_agent', index: Number.NaN },
          { type: 'workflow_agent', index: 0, label: 'ok', lastToolSummary: 'S'.repeat(500) },
        ],
      }),
    );
    const entries = state.taskUpdates?.get('wf-2')?.workflowProgress;
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({ type: 'workflow_agent', index: 0, label: 'ok' });
    expect(entries?.[0]?.lastToolSummary).toHaveLength(160);
    expect(entries?.[0]?.lastToolSummary?.endsWith('…')).toBe(true);
  });
});

describe('getRunningSnapshot 后台 subagent 折算(真 store)', () => {
  const statusUpdate = (
    sessionId: string,
    isRunning: boolean,
    status = isRunning ? 'Generating...' : 'Done',
  ): CCAgentStatusUpdate => ({
    sessionId,
    status,
    tokenUsage: 0,
    costUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    isRunning,
  });

  const applyTask = (sessionId: string, data: Record<string, unknown>): void => {
    makerChatStore.__applyStreamEventForTest(sessionId, {
      sessionId,
      type: 'agent_task_update',
      source: 'claude-code',
      data: { provider: 'claude-code', ...data },
    } as CCAgentStreamEvent);
  };

  /**
   * running→stopped 的 transition 条目由 store 调度的 macrotask 显式清除
   * (getter 纯化后读取不再消费,见 getRunningSnapshot 注释)——等一拍让清除落地。
   */
  const flushStopTransition = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 1));

  it('主 turn 结束但 subagent 还在跑 → 快照保持 running;完成→桥接→wake turn→最终 Done 才转 stopped', async () => {
    const sid = `wake-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // turn start + subagent 启动
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);

      // 主 turn 结束 —— 修复点:subagent 仍在跑,快照必须还是 running
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, false));
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);

      // subagent 完成 —— 唤醒桥接撑住空窗,不闪 running→stopped
      applyTask(sid, { taskId: 't1', status: 'completed' });
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);

      // wake turn 启动(message_start 推 isRunning:true)→ 桥接清除,继续 running
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);

      // wake turn 结束,无 running 任务 → transition(isRunning:false)投递一个
      // 窗口(重复读取不消费),调度清除落地后条目消失
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, false));
      const transition = makerChatStore.getRunningSnapshot().get(sid);
      expect(transition?.isRunning).toBe(false);
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(false);
      await flushStopTransition();
      expect(makerChatStore.getRunningSnapshot().has(sid)).toBe(false);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('local_bash 后台任务不折算:主 turn 结束即 stopped(dev server 不永转)', async () => {
    const sid = `bash-${Math.random().toString(36).slice(2, 8)}`;
    try {
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      applyTask(sid, { taskId: 'b1', status: 'running', taskType: 'local_bash' });
      // 快照订阅方在 running 期间取过一次(真实使用中每次 emit 都会取)——
      // transition 条目依赖上一代快照里存在 running 记录。
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, false));
      const transition = makerChatStore.getRunningSnapshot().get(sid);
      expect(transition?.isRunning).toBe(false);
      await flushStopTransition();
      expect(makerChatStore.getRunningSnapshot().has(sid)).toBe(false);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('stopSession 把 wake 型 running 任务标 stopped、快照回落;非 wake 任务(bash)不动', async () => {
    const sid = `stop-${Math.random().toString(36).slice(2, 8)}`;
    try {
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });
      applyTask(sid, { taskId: 'b1', status: 'running', taskType: 'local_bash' });
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, false));
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);

      makerChatStore.stopSession(sid);
      const transition = makerChatStore.getRunningSnapshot().get(sid);
      expect(transition?.isRunning).toBe(false);
      await flushStopTransition();
      expect(makerChatStore.getRunningSnapshot().has(sid)).toBe(false);
      // scope='wake':subagent 收口、后台 bash(interrupt 杀不掉的长驻进程)不动
      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      expect(tasks?.get('t1')?.status).toBe('stopped');
      expect(tasks?.get('b1')?.status).toBe('running');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('远程(device-link)会话豁免折算:主 turn 结束即 stopped,不受后台任务影响', async () => {
    // review P1:远程 mirror 事件有设计内丢失窗口且 taskUpdates 不在 reconcile
    // 对账内,终态丢失会永久转圈——远程侧保持修复前行为换确定性。
    const sid = `remote-${Math.random().toString(36).slice(2, 8)}`;
    try {
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, false));
      const transition = makerChatStore.getRunningSnapshot().get(sid);
      expect(transition?.isRunning).toBe(false);
      await flushStopTransition();
      expect(makerChatStore.getRunningSnapshot().has(sid)).toBe(false);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('codex 会话的 agent_task_update 不参与折算(provider gate)', async () => {
    const sid = `codex-${Math.random().toString(36).slice(2, 8)}`;
    try {
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      makerChatStore.__applyStreamEventForTest(sid, {
        sessionId: sid,
        type: 'agent_task_update',
        source: 'codex',
        data: { provider: 'codex', taskId: 'c1', status: 'running', taskType: 'local_agent' },
      } as CCAgentStreamEvent);
      expect(makerChatStore.getRunningSnapshot().get(sid)?.isRunning).toBe(true);
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, false));
      const transition = makerChatStore.getRunningSnapshot().get(sid);
      expect(transition?.isRunning).toBe(false);
      await flushStopTransition();
      expect(makerChatStore.getRunningSnapshot().has(sid)).toBe(false);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('契约:两次 notify 之间连续读取返回同一引用,transition 不被读取消费', async () => {
    const sid = `contract-${Math.random().toString(36).slice(2, 8)}`;
    try {
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      const running1 = makerChatStore.getRunningSnapshot();
      const running2 = makerChatStore.getRunningSnapshot();
      expect(running2).toBe(running1); // 无 mutation → 同一引用

      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, false));
      const gen1 = makerChatStore.getRunningSnapshot();
      const gen2 = makerChatStore.getRunningSnapshot();
      const gen3 = makerChatStore.getRunningSnapshot();
      // useSyncExternalStore 契约:transition 投递窗口内引用稳定、内容不变,
      // 读取绝不消费(旧实现第二次读就删条目,触发 React getSnapshot 警告)。
      expect(gen2).toBe(gen1);
      expect(gen3).toBe(gen1);
      expect(gen1.get(sid)?.isRunning).toBe(false);

      // 显式清除(store 调度的 macrotask)落地后条目消失,之后继续引用稳定。
      await flushStopTransition();
      const cleared1 = makerChatStore.getRunningSnapshot();
      const cleared2 = makerChatStore.getRunningSnapshot();
      expect(cleared1.has(sid)).toBe(false);
      expect(cleared2).toBe(cleared1);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('seedBackgroundTaskSnapshots 只补未见过的任务,绝不复活已终态条目', () => {
    const sid = `seed-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // b1 已经走完整生命周期(running → completed),快照(可能落后)仍报 running。
      applyTask(sid, { taskId: 'b1', status: 'running', taskType: 'local_bash' });
      applyTask(sid, { taskId: 'b1', status: 'completed' });

      makerChatStore.seedBackgroundTaskSnapshots(sid, [
        { taskId: 'b1', taskType: 'local_bash', title: 'stale snapshot' },
        { taskId: 'b2', taskType: 'local_bash', toolUseId: 'tu-b2', title: 'pnpm test:unit' },
      ]);

      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      // 已存在的 b1 不被快照的 running 复活
      expect(tasks?.get('b1')?.status).toBe('completed');
      // 未见过的 b2 补进来,taskId / toolUseId 双 key 命中
      expect(tasks?.get('b2')?.status).toBe('running');
      expect(tasks?.get('b2')?.taskType).toBe('local_bash');
      expect(tasks?.get('b2')?.title).toBe('pnpm test:unit');
      expect(tasks?.get('tu-b2')?.taskId).toBe('b2');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('seedBackgroundTaskSnapshots 按 toolUseId 命中已存在条目时同样跳过', () => {
    const sid = `seed2-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, {
        taskId: 'b1',
        parentToolUseId: 'tu-b1',
        status: 'stopped',
        taskType: 'local_bash',
      });
      makerChatStore.seedBackgroundTaskSnapshots(sid, [
        { taskId: 'b1-renamed', toolUseId: 'tu-b1', taskType: 'local_bash' },
      ]);
      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      expect(tasks?.get('tu-b1')?.status).toBe('stopped');
      expect(tasks?.has('b1-renamed')).toBe(false);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('session closed 兜底(finalizeStuckRemoteTurn → forceFinalize):running 任务全收口、桥接清零', () => {
    const sid = `remote-closed-${Math.random().toString(36).slice(2, 8)}`;
    try {
      makerChatStore.__applyStatusUpdateForTest(sid, statusUpdate(sid, true));
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });
      applyTask(sid, { taskId: 'b1', status: 'running', taskType: 'local_bash' });

      makerChatStore.finalizeStuckRemoteTurn(sid);
      const state = makerChatStore.getSnapshot(sid);
      // scope='all':closed 后事件流已断,所有 running 任务(含 bash)都收口
      expect(state.taskUpdates?.get('t1')?.status).toBe('stopped');
      expect(state.taskUpdates?.get('b1')?.status).toBe('stopped');
      expect(state.pendingTaskWake).toBe(false);
      expect(state.agentStatus.isRunning).toBe(false);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });
});
