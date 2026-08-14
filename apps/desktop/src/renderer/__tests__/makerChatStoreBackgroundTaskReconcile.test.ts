/**
 * makerChatStoreBackgroundTaskReconcile.test.ts
 * ---------------------------------------------------------------------------
 * 后台任务 stale running 对账自愈(终态 agent_task_update 丢失后的收口):
 *   - seedBackgroundTaskSnapshots + staleRunningCandidates:候选集内、仍
 *     running、不在快照中的 claude-code 条目收口为 stopped;快照命中 / 非候选 /
 *     非 claude-code / 已终态条目一律不动;收口后迟到的真实事件仍能覆盖。
 *   - captureRunningClaudeTaskIds:候选集捕获口径。
 *   - initGlobalListeners 的活动熄灭触发:active:false → 延迟拉快照对账;
 *     active:true 取消;远程会话豁免;无 running 条目不发 IPC。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'cc',
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

// 远程判定按 id 前缀 + 可动态标记的集合,便于测「远程会话豁免对账」以及
// 「调度后、触发前才识别为远程」的粘滞复查分支。
const transportMocks = vi.hoisted(() => ({ dynamicRemoteIds: new Set<string>() }));
const isMockRemote = (sessionId: string): boolean =>
  sessionId.startsWith('remote-') || transportMocks.dynamicRemoteIds.has(sessionId);

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
  isRemoteSession: (sessionId: string) => isMockRemote(sessionId),
  isRemoteSessionSticky: (sessionId: string) => isMockRemote(sessionId),
}));

import { makerChatStore } from '@/lib/makerChatStore';

const applyTask = (sessionId: string, data: Record<string, unknown>): void => {
  makerChatStore.__applyStreamEventForTest(sessionId, {
    sessionId,
    type: 'agent_task_update',
    source: 'claude-code',
    data: { provider: 'claude-code', ...data },
  } as CCAgentStreamEvent);
};

describe('seedBackgroundTaskSnapshots stale running 对账', () => {
  it('候选集内不在快照的 running 条目收口为 stopped;别名双键共享同一对象', () => {
    const sid = `rec-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, {
        taskId: 't-stale',
        parentToolUseId: 'tu-stale',
        status: 'running',
        taskType: 'local_agent',
      });
      const candidates = makerChatStore.captureRunningClaudeTaskIds(sid);
      expect(candidates.has('t-stale')).toBe(true);

      makerChatStore.seedBackgroundTaskSnapshots(sid, [], {
        staleRunningCandidates: candidates,
      });

      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      expect(tasks?.get('t-stale')?.status).toBe('stopped');
      expect(tasks?.get('tu-stale')?.status).toBe('stopped');
      // 别名键共享同一新对象(isSameAgentTaskAlias 语义不被破坏)
      expect(tasks?.get('t-stale')).toBe(tasks?.get('tu-stale'));
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('快照命中(taskId 或 toolUseId 别名)的候选条目保持 running', () => {
    const sid = `rec2-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't-alive', status: 'running', taskType: 'local_agent' });
      applyTask(sid, {
        taskId: 't-alias',
        parentToolUseId: 'tu-alias',
        status: 'running',
        taskType: 'local_bash',
      });
      const candidates = makerChatStore.captureRunningClaudeTaskIds(sid);

      makerChatStore.seedBackgroundTaskSnapshots(
        sid,
        [
          { taskId: 't-alive' },
          // main 侧快照以 toolUseId 报同一任务(别名命中同样算存活)
          { taskId: 't-alias-renamed', toolUseId: 'tu-alias' },
        ],
        { staleRunningCandidates: candidates },
      );

      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      expect(tasks?.get('t-alive')?.status).toBe('running');
      expect(tasks?.get('t-alias')?.status).toBe('running');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('候选集外的 running(请求在飞窗口内新启动)与已终态条目不动;codex 条目不受空快照影响', () => {
    const sid = `rec3-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't-old', status: 'running', taskType: 'local_agent' });
      const candidates = makerChatStore.captureRunningClaudeTaskIds(sid);
      // 候选捕获之后才启动的任务(模拟请求在飞窗口)
      applyTask(sid, { taskId: 't-fresh', status: 'running', taskType: 'local_agent' });
      // 已终态条目
      applyTask(sid, { taskId: 't-done', status: 'completed', taskType: 'local_agent' });
      // codex 任务:快照通道只覆盖 claude-code,空快照对它没有含义
      makerChatStore.__applyStreamEventForTest(sid, {
        sessionId: sid,
        type: 'agent_task_update',
        source: 'codex',
        data: { provider: 'codex', taskId: 't-codex', status: 'running' },
      } as CCAgentStreamEvent);

      makerChatStore.seedBackgroundTaskSnapshots(sid, [], {
        staleRunningCandidates: candidates,
      });

      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      expect(tasks?.get('t-old')?.status).toBe('stopped');
      expect(tasks?.get('t-fresh')?.status).toBe('running');
      expect(tasks?.get('t-done')?.status).toBe('completed');
      expect(tasks?.get('t-codex')?.status).toBe('running');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('收口非终局:迟到的真实事件仍能覆盖(终态 → completed / 进度 → running)', () => {
    const sid = `rec4-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't-late', status: 'running', taskType: 'local_agent' });
      applyTask(sid, { taskId: 't-back', status: 'running', taskType: 'local_bash' });
      const candidates = makerChatStore.captureRunningClaudeTaskIds(sid);
      makerChatStore.seedBackgroundTaskSnapshots(sid, [], {
        staleRunningCandidates: candidates,
      });
      expect(makerChatStore.getSnapshot(sid).taskUpdates?.get('t-late')?.status).toBe('stopped');

      // 迟到的 task_notification 终态:stopped → completed(真实结局胜出)
      applyTask(sid, { taskId: 't-late', status: 'completed' });
      // 迟到的 task_progress:任务实际存活,翻回 running(自愈,不误杀)
      applyTask(sid, { taskId: 't-back', status: 'running' });

      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      expect(tasks?.get('t-late')?.status).toBe('completed');
      expect(tasks?.get('t-back')?.status).toBe('running');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('captureRunningClaudeTaskIds 只含 running 的 claude-code 任务,按 taskId 去重', () => {
    const sid = `cap-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, {
        taskId: 't-run',
        parentToolUseId: 'tu-run',
        status: 'running',
        taskType: 'local_agent',
      });
      applyTask(sid, { taskId: 't-done', status: 'completed' });
      makerChatStore.__applyStreamEventForTest(sid, {
        sessionId: sid,
        type: 'agent_task_update',
        source: 'codex',
        data: { provider: 'codex', taskId: 't-codex', status: 'running' },
      } as CCAgentStreamEvent);

      const ids = makerChatStore.captureRunningClaudeTaskIds(sid);
      expect([...ids]).toEqual(['t-run']);
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('seed 与对账同次完成:快照新任务补进、stale 候选同时收口', () => {
    const sid = `rec5-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't-stale', status: 'running', taskType: 'local_agent' });
      const candidates = makerChatStore.captureRunningClaudeTaskIds(sid);

      makerChatStore.seedBackgroundTaskSnapshots(
        sid,
        [{ taskId: 't-new', taskType: 'local_bash', title: 'dev server' }],
        { staleRunningCandidates: candidates },
      );

      const tasks = makerChatStore.getSnapshot(sid).taskUpdates;
      expect(tasks?.get('t-new')?.status).toBe('running');
      expect(tasks?.get('t-stale')?.status).toBe('stopped');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });
});

// ── 活动熄灭触发的延迟自动对账(initGlobalListeners)─────────────────────────

type FanOutCb = (data: unknown) => void;

function makeElectronApiStub(listTasks: ReturnType<typeof vi.fn>) {
  let activityCb: FanOutCb | null = null;
  const fanOut = () => () => () => {};
  const stub = {
    maker: {
      onEvent: fanOut(),
      onStatusChanged: fanOut(),
      onInputProjection: fanOut(),
      onInteractionRequest: fanOut(),
      onInteractionDismissed: fanOut(),
      onSessionBackgroundActivityChanged: (cb: FanOutCb) => {
        activityCb = cb;
        return () => {
          activityCb = null;
        };
      },
      listSessionBackgroundTasks: listTasks,
      input: {
        getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
      },
    },
    localDb: { messages: { onCreated: fanOut() } },
    deviceLink: { onRemotePush: fanOut() },
  };
  return { stub, emitActivity: (payload: unknown) => activityCb?.(payload) };
}

describe('活动熄灭触发的 stale running 对账', () => {
  let emitActivity: (payload: unknown) => void;
  let listTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    listTasks = vi.fn(async () => ({ tasks: [] }));
    const made = makeElectronApiStub(listTasks);
    emitActivity = made.emitActivity;
    (globalThis as { window?: unknown }).window = { electronAPI: made.stub };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    transportMocks.dynamicRemoteIds.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('active:false → 延迟拉快照,stale running 收口为 stopped', async () => {
    const sid = `act-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });

      emitActivity({ sessionId: sid, active: false });
      expect(listTasks).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(listTasks).toHaveBeenCalledWith(sid);
      // list promise → seed 的微任务落地
      await vi.advanceTimersByTimeAsync(0);

      expect(makerChatStore.getSnapshot(sid).taskUpdates?.get('t1')?.status).toBe('stopped');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('到点前 active:true 取消对账;仍在快照中的任务不被收口', async () => {
    const sid = `act2-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });

      emitActivity({ sessionId: sid, active: false });
      emitActivity({ sessionId: sid, active: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(listTasks).not.toHaveBeenCalled();
      expect(makerChatStore.getSnapshot(sid).taskUpdates?.get('t1')?.status).toBe('running');

      // 再次熄灭:这次快照证明任务仍在(main 表有它)→ 保持 running
      listTasks.mockResolvedValueOnce({ tasks: [{ taskId: 't1' }] });
      emitActivity({ sessionId: sid, active: false });
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(0);
      expect(makerChatStore.getSnapshot(sid).taskUpdates?.get('t1')?.status).toBe('running');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('调度后、触发前才识别为远程(重连窗口误放行)→ 触发沿粘滞复查拦下,不发本机 IPC', async () => {
    const sid = `late-remote-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });

      // 调度沿:此刻远程注册表尚未水合,会话被当成本机 → 定时器挂上
      emitActivity({ sessionId: sid, active: false });
      // 触发前:注册表水合,会话被识别为远程
      transportMocks.dynamicRemoteIds.add(sid);
      await vi.advanceTimersByTimeAsync(3000);

      // 触发沿粘滞复查必须拦下:不发本机 IPC,镜像里的 running 不被空快照错误收口
      expect(listTasks).not.toHaveBeenCalled();
      expect(makerChatStore.getSnapshot(sid).taskUpdates?.get('t1')?.status).toBe('running');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('在飞窗口:快照响应落地前会话被识别为远程 → 丢弃本机快照,镜像 running 不被收口', async () => {
    const sid = `inflight-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(sid, { taskId: 't1', status: 'running', taskType: 'local_agent' });
      let resolveList!: (v: unknown) => void;
      listTasks.mockReturnValue(
        new Promise((r) => {
          resolveList = r;
        }),
      );

      emitActivity({ sessionId: sid, active: false });
      // timer 到点:粘滞复查通过(此刻仍判本机)、候选捕获、请求发出
      await vi.advanceTimersByTimeAsync(3000);
      expect(listTasks).toHaveBeenCalledWith(sid);

      // 请求在飞期间远程注册表完成会话水合,随后本机空表才落地
      transportMocks.dynamicRemoteIds.add(sid);
      resolveList({ tasks: [] });
      await vi.advanceTimersByTimeAsync(0);

      expect(makerChatStore.getSnapshot(sid).taskUpdates?.get('t1')?.status).toBe('running');
    } finally {
      makerChatStore.purgeSession(sid);
    }
  });

  it('远程会话豁免;无 running 条目不发 IPC', async () => {
    const remoteSid = 'remote-act3';
    const idleSid = `act4-${Math.random().toString(36).slice(2, 8)}`;
    try {
      applyTask(remoteSid, { taskId: 't1', status: 'running', taskType: 'local_agent' });
      emitActivity({ sessionId: remoteSid, active: false });
      await vi.advanceTimersByTimeAsync(3000);
      expect(listTasks).not.toHaveBeenCalled();
      expect(makerChatStore.getSnapshot(remoteSid).taskUpdates?.get('t1')?.status).toBe(
        'running',
      );

      // 本机会话但没有 running 条目:调度前粗筛直接跳过
      applyTask(idleSid, { taskId: 't2', status: 'completed', taskType: 'local_agent' });
      emitActivity({ sessionId: idleSid, active: false });
      await vi.advanceTimersByTimeAsync(3000);
      expect(listTasks).not.toHaveBeenCalled();
    } finally {
      makerChatStore.purgeSession(remoteSid);
      makerChatStore.purgeSession(idleSid);
    }
  });
});
