/**
 * planReviewDoneRace.test.ts
 * ---------------------------------------------------------------------------
 * issue #475 计划模式 bug 回归:Codex 的 plan_review 是 turn 间交互,经 resolver
 * 直通通道先于队列里的 done 事件到达 renderer —— done 清扫曾把刚弹出的计划卡片
 * 瞬间标 expired(用户"画面一闪变过期")。断言:
 *   - codex 会话:interaction_request(plan_review) → done,卡片与气泡存活
 *   - claude 会话:同序列维持既有语义(turn 结束 pending 即过期)
 *   - codex 会话:main 的 dismissal(permission_dismissed)仍能正确标 expired
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { makerChatStore } from '@/lib/makerChatStore';

const SESSION_ID = 'plan-review-done-race';

function emptyProjection(sessionId: string) {
  return {
    sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    recovery: null,
    errorRetryText: null,
  };
}

let onEvent: ((data: unknown) => void) | undefined;
let onDbMessageCreated: ((data: unknown) => void) | undefined;
let onInteractionRequest: ((data: unknown) => void) | undefined;
let onInteractionDismissed: ((data: unknown) => void) | undefined;
let getPendingInteractions: ReturnType<typeof vi.fn>;

function installElectronBridge(): void {
  onEvent = undefined;
  onDbMessageCreated = undefined;
  onInteractionRequest = undefined;
  onInteractionDismissed = undefined;
  getPendingInteractions = vi.fn(async () => []);
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: {
        input: {
          getProjection: vi.fn(async (sessionId: string) => emptyProjection(sessionId)),
          enqueue: vi.fn(async (sessionId: string) => emptyProjection(sessionId)),
        },
        onInputProjection: vi.fn(() => vi.fn()),
        onEvent: (cb: (data: unknown) => void) => {
          onEvent = cb;
          return vi.fn();
        },
        onStatusChanged: vi.fn(() => vi.fn()),
        onInteractionRequest: (cb: (data: unknown) => void) => {
          onInteractionRequest = cb;
          return vi.fn();
        },
        onInteractionDismissed: (cb: (data: unknown) => void) => {
          onInteractionDismissed = cb;
          return vi.fn();
        },
        send: vi.fn(async () => ({ accepted: true })),
        generateTitle: vi.fn(async () => ({ title: 't' })),
        getPendingInteractions,
        setPlanMode: vi.fn(async () => {}),
        resolveInteraction: vi.fn(async () => {}),
        abortSession: vi.fn(async () => {}),
        closeSession: vi.fn(async () => {}),
        listActive: vi.fn(async () => []),
      },
      localDb: {
        messages: {
          onCreated: (cb: (data: unknown) => void) => {
            onDbMessageCreated = cb;
            return vi.fn();
          },
        },
      },
    },
  };
}

function emitPlanReviewRequest(requestId: string): void {
  onInteractionRequest?.({
    sessionId: SESSION_ID,
    request: { kind: 'plan_review', requestId, plan: '# 示例计划\n1. do X' },
    persistId: `persist-${requestId}`,
  });
}

function emitDone(
  source: 'codex' | 'claude-code',
  plan?: Array<{ step: string; status: string }>,
  turnId = 'turn-1',
  turnStatus?: string,
  turnContinuationId?: number,
): void {
  onEvent?.({
    sessionId: SESSION_ID,
    event: {
      type: 'done',
      source,
      ...(turnContinuationId !== undefined ? { turnContinuationId } : {}),
      data: {
        type: 'task_complete',
        raw: { id: turnId, ...(turnStatus ? { status: turnStatus } : {}) },
        ...(plan ? { plan } : {}),
      },
    },
  });
}

function emitPlanUpdate(source: 'codex' | 'claude-code', statuses: string[]): void {
  onEvent?.({
    sessionId: SESSION_ID,
    event: {
      type: 'tool_use',
      source,
      data: {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: {
          plan: statuses.map((status, index) => ({ step: `Step ${index + 1}`, status })),
        },
      },
    },
    persistId: 'plan-row-1',
  });
}

function emitPersistedPlanEcho(statuses: string[]): void {
  onDbMessageCreated?.({
    sessionId: SESSION_ID,
    message: {
      id: 'db-plan-row-1',
      sessionId: SESSION_ID,
      clientId: 'plan-row-1',
      role: 'tool_use',
      content: JSON.stringify({
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: {
          plan: statuses.map((status, index) => ({ step: `Step ${index + 1}`, status })),
        },
      }),
      toolUseId: 'plan:turn-1',
      agentMeta: null,
      createdAt: '2026-07-22T00:00:01.000Z',
    },
  });
}

function latestPlanStatuses(): string[] {
  const plan = makerChatStore
    .getSnapshot(SESSION_ID)
    .messages.findLast((message) => message.role === 'tool_use' && message.toolName === 'update_plan');
  const input = plan?.toolInput as { plan?: Array<{ status?: string }> } | undefined;
  return input?.plan?.map((item) => item.status ?? 'unknown') ?? [];
}

function pendingBubbleStatuses(): string[] {
  return makerChatStore
    .getSnapshot(SESSION_ID)
    .messages.filter((m) => m.role === 'plan_review')
    .map((m) => m.planReviewStatus ?? 'unknown');
}

describe('plan_review 与 done 的时序', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installElectronBridge();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    vi.restoreAllMocks();
  });

  it('codex:done 使用携带的权威快照收口最新结构化计划', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanUpdate('codex', ['completed', 'in_progress', 'pending']);

    emitDone('codex', [
      { step: 'Step 1', status: 'completed' },
      { step: 'Step 2', status: 'completed' },
      { step: 'Step 3', status: 'completed' },
    ]);

    expect(latestPlanStatuses()).toEqual(['completed', 'completed', 'completed']);
  });

  it('codex:延迟 DB create 回声不覆盖刚应用的终态计划', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanUpdate('codex', ['in_progress']);
    emitDone('codex', [{ step: 'Step 1', status: 'completed' }]);

    emitPersistedPlanEcho(['in_progress']);

    expect(latestPlanStatuses()).toEqual(['completed']);
  });

  it('codex:done 没有 plan 快照时不猜测旧计划已完成', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanUpdate('codex', ['in_progress', 'pending']);

    emitDone('codex');

    expect(latestPlanStatuses()).toEqual(['in_progress', 'pending']);
  });

  it('codex:成功完成但缺少最终 plan 快照时收口计划卡片', () => {
    const startedAtMs = 1_700_000_000_000;
    const completedAtMs = startedAtMs + 5_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAtMs);
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanUpdate('codex', ['in_progress', 'pending']);

    now.mockReturnValue(completedAtMs);
    emitDone('codex', undefined, 'turn-1', 'completed');

    expect(latestPlanStatuses()).toEqual(['completed', 'completed']);
    const completedPlan = makerChatStore
      .getSnapshot(SESSION_ID)
      .messages.findLast(
        (message) => message.role === 'tool_use' && message.toolName === 'update_plan',
      );
    expect(completedPlan).toMatchObject({ planUpdatedAtMs: completedAtMs });
  });

  it('claude:done 不改 Codex update_plan 展示状态', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'claude-code' });
    emitPlanUpdate('claude-code', ['in_progress', 'pending']);

    emitDone('claude-code');

    expect(latestPlanStatuses()).toEqual(['in_progress', 'pending']);
  });

  it('codex:done 不吞掉刚弹出的计划审阅(卡片与气泡存活)', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanReviewRequest('pr-1');
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe('pr-1');

    emitDone('codex');

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPlanReview?.requestId).toBe('pr-1');
    expect(pendingBubbleStatuses()).toEqual(['pending']);
  });

  it('codex:claimed done 不触发产品终态对账，后续无 claim done 才重建计划审阅', async () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanReviewRequest('pr-continuation');
    getPendingInteractions.mockResolvedValueOnce([
      {
        request: {
          kind: 'plan_review',
          requestId: 'pr-continuation',
          plan: '# 续跑后的计划\n1. do Y',
        },
        persistId: 'persist-pr-continuation',
      },
    ]);

    emitDone('codex', undefined, 'turn-1', undefined, 7);
    await Promise.resolve();

    expect(getPendingInteractions).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe(
      'pr-continuation',
    );

    emitDone('codex');

    await vi.waitFor(() => {
      expect(getPendingInteractions).toHaveBeenCalledTimes(1);
      expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe(
        'pr-continuation',
      );
    });
  });

  it('codex:done 作废在途旧快照后主动拉新快照重建计划审阅', async () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    let resolveStaleSnapshot!: (items: unknown[]) => void;
    getPendingInteractions
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleSnapshot = resolve;
          }),
      )
      .mockResolvedValueOnce([
        {
          request: {
            kind: 'plan_review',
            requestId: 'pr-fresh-snapshot',
            plan: '# 最新计划\n1. do Y',
          },
          persistId: 'persist-pr-fresh-snapshot',
        },
      ]);

    const staleReconcile = makerChatStore.reconcilePendingInteractions(SESSION_ID);
    emitDone('codex');

    await vi.waitFor(() => {
      expect(getPendingInteractions).toHaveBeenCalledTimes(2);
      expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe(
        'pr-fresh-snapshot',
      );
    });

    resolveStaleSnapshot([
      {
        request: {
          kind: 'plan_review',
          requestId: 'pr-stale-snapshot',
          plan: '# 旧计划',
        },
        persistId: 'persist-pr-stale-snapshot',
      },
    ]);
    await expect(staleReconcile).resolves.toBe(0);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe(
      'pr-fresh-snapshot',
    );
  });

  it('claude:turn 结束仍将 pending 计划审阅标过期(既有语义不变)', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'claude-code' });
    emitPlanReviewRequest('pr-2');
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe('pr-2');

    emitDone('claude-code');

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPlanReview).toBeNull();
    expect(pendingBubbleStatuses()).toEqual(['expired']);
  });

  it('codex:main 的 dismissal(abort/close)仍能把存活卡片标过期', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanReviewRequest('pr-3');
    emitDone('codex');
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe('pr-3');

    onInteractionDismissed?.({
      sessionId: SESSION_ID,
      requestId: 'pr-3',
      reason: 'session_aborted',
      resolvedAs: 'deny',
    });

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPlanReview).toBeNull();
    expect(pendingBubbleStatuses()).toEqual(['expired']);
  });
});

describe('setPlanMode 乐观时序(勾选后立即发送不丢武装态)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installElectronBridge();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
  });

  it('store 状态与 maker runtime 推送在任何 await 之前可见', async () => {
    const w = globalThis as unknown as {
      window: { electronAPI: { maker: { setPlanMode: ReturnType<typeof vi.fn> } } };
    };
    w.window.electronAPI.maker.setPlanMode = vi.fn(async () => {});
    const pending = makerChatStore.setPlanMode(SESSION_ID, true);
    // 未 await: 乐观值与 runtime IPC 均已可见(后续 send IPC 必然排在其后)。
    expect(makerChatStore.getSnapshot(SESSION_ID).planModeEnabled).toBe(true);
    expect(w.window.electronAPI.maker.setPlanMode).toHaveBeenCalledWith(SESSION_ID, true);
    await pending;
    expect(makerChatStore.getSnapshot(SESSION_ID).planModeEnabled).toBe(true);
  });

  it('持久化失败 → 回滚乐观值并通知 runtime 还原', async () => {
    const sessionService = await import('@/lib/sessionService');
    (sessionService.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    const w = globalThis as unknown as {
      window: { electronAPI: { maker: { setPlanMode: ReturnType<typeof vi.fn> } } };
    };
    w.window.electronAPI.maker.setPlanMode = vi.fn(async () => {});

    await expect(makerChatStore.setPlanMode(SESSION_ID, true)).rejects.toThrow('db down');
    expect(makerChatStore.getSnapshot(SESSION_ID).planModeEnabled).toBe(false);
    // 先乐观 true、失败后还原 false 各推送一次。
    expect(w.window.electronAPI.maker.setPlanMode).toHaveBeenCalledWith(SESSION_ID, true);
    expect(w.window.electronAPI.maker.setPlanMode).toHaveBeenCalledWith(SESSION_ID, false);
  });
});

describe('sendMessage 点击即消耗一次性勾选', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installElectronBridge();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
  });

  it('首条排队行携带计划快照,勾选同步熄灭 → 连发第二条不再携带', async () => {
    const w = globalThis as unknown as {
      window: {
        electronAPI: {
          maker: {
            setPlanMode: ReturnType<typeof vi.fn>;
            input: { enqueue: ReturnType<typeof vi.fn> };
          };
        };
      };
    };
    w.window.electronAPI.maker.setPlanMode = vi.fn(async () => {});
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex', planModeEnabled: true });

    makerChatStore.sendMessage(SESSION_ID, '先规划这个', 'gpt-5.4', 'high', 'auto', '/repo');
    // 点击瞬间: 行内快照 true, store 勾选已同步熄灭。
    const first = w.window.electronAPI.maker.input.enqueue.mock.calls[0][1];
    expect(first.createOpts.planMode).toBe(true);
    expect(makerChatStore.getSnapshot(SESSION_ID).planModeEnabled).toBe(false);

    makerChatStore.sendMessage(SESSION_ID, '再来一条普通的', 'gpt-5.4', 'high', 'auto', '/repo');
    const second = w.window.electronAPI.maker.input.enqueue.mock.calls[1][1];
    expect(second.createOpts.planMode).toBe(false);
  });
});

describe('水合陈旧行不复燃已消耗的勾选', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installElectronBridge();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
  });

  it('fetch 期间发生本地消耗 → 丢弃读回的 planModeEnabled=true', async () => {
    const sessionService = await import('@/lib/sessionService');
    let resolveGet!: (v: unknown) => void;
    (sessionService.get as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveGet = resolve; }),
    );

    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex', planModeEnabled: true });
    makerChatStore.ensureInitialMessages(SESSION_ID);
    // fetch 在飞期间, 首发消耗一次性勾选(本地写入 → rev 前进)。
    await makerChatStore.setPlanMode(SESSION_ID, false);
    expect(makerChatStore.getSnapshot(SESSION_ID).planModeEnabled).toBe(false);

    // 陈旧行(建会话时的 true)此刻才回来 → 必须被 rev 守卫丢弃, 勾选不复燃。
    resolveGet({
      agentKind: 'codex',
      remoteHostId: null,
      sdkSessionId: null,
      fastMode: false,
      planModeEnabled: true,
      contextTokens: 0,
      contextWindow: 0,
      totalCostUsd: 0,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(makerChatStore.getSnapshot(SESSION_ID).planModeEnabled).toBe(false);
  });
});

describe('cancelPlanReview(取消本次审阅)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installElectronBridge();
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.__teardownGlobalListeners();
    makerChatStore.purgeSession(SESSION_ID);
  });

  it('关卡片、气泡标 cancelled, 决策发 deny + dismissed', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitPlanReviewRequest('pr-cancel');
    emitDone('codex');
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPlanReview?.requestId).toBe('pr-cancel');

    makerChatStore.cancelPlanReview(SESSION_ID, 'pr-cancel');

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPlanReview).toBeNull();
    expect(pendingBubbleStatuses()).toEqual(['cancelled']);
    const w = globalThis as unknown as {
      window: { electronAPI: { maker: { resolveInteraction: ReturnType<typeof vi.fn> } } };
    };
    expect(w.window.electronAPI.maker.resolveInteraction).toHaveBeenCalledWith('pr-cancel', {
      kind: 'plan_review',
      behavior: 'deny',
      dismissed: true,
    });
  });
});
