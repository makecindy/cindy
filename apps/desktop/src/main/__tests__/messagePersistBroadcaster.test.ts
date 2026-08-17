/**
 * messagePersistBroadcaster.test.ts
 * ---------------------------------------------------------------------------
 * F1-a Option C:tool_result 的内容重排(summary↔全文、buffer、eager-create、多
 * toolUseId 归并、done orphan)在收口到 main 后,逻辑全在 messagePersistBroadcaster。
 * 这里覆盖那套解析 + 落库:
 *   - 返回的 { persistId, content } 与实际落库内容**同源同值**(Option C 不 diverge 的命门);
 *   - 两种到达顺序都最终落全文;buffer / eager-create / done-orphan 三条路径;
 *   - 幂等(内容未变不重复 update)、guard。
 *
 * createMessage / updateMessageContent(better-sqlite3 路径)被 mock 掉,只断言调用入参;
 * 落库走模块内 writeChain microtask,断言前先 flush 一个宏任务边界。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../localDb/ipc/messages.js', () => ({
  broadcastMessageAgentMetaUpdate: vi.fn(async () => true),
  broadcastMessageRow: vi.fn(),
  createMessage: vi.fn(async () => ({}) as unknown),
  patchMessageAgentMetaWithResult: vi.fn(async (_sessionId, _clientId, patch) => ({
    previous: {},
    next: patch,
  })),
  updateMessageContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../localDb/codexPlanState.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../localDb/codexPlanState.js')>()),
  markCodexPlanInterrupted: vi.fn(async () => undefined),
  writeCodexPlanTerminal: vi.fn(async () => undefined),
  writeCodexPlanUpdate: vi.fn(async () => undefined),
}));

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
const ownerScopeState = vi.hoisted(() => ({
  current: true,
  scope: { ownerScopeKey: 'owner-a', ownerStamp: undefined },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }] },
}));
vi.mock('../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => ownerScopeState.scope),
  isDataOwnerBroadcastScopeCurrent: vi.fn(() => ownerScopeState.current),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));

import {
  broadcastMessageAgentMetaUpdate,
  broadcastMessageRow,
  createMessage,
  patchMessageAgentMetaWithResult,
  updateMessageContent,
} from '../localDb/ipc/messages.js';
import {
  markCodexPlanInterrupted,
  writeCodexPlanTerminal,
  writeCodexPlanUpdate,
} from '../localDb/codexPlanState.js';
import {
  recordMediaToolResult,
  __resetMediaToolResultPoolForTesting,
} from '../mcp-integrations/mediaToolResultFallback.js';
import {
  onToolUseEvent,
  persistCodexPlanOnDone,
  persistCodexPlanOnTerminalError,
  onToolResultEvent,
  onToolResultFullEvent,
  prepareSyntheticToolEventForBroadcast,
  onAssistantTextEvent,
  onInteractionMessage,
  onThinkingEvent,
  flushAssistantBlock,
  flushOrphanToolResults,
  isSuccessfulCodexDoneEventData,
  onTurnErrorEvent,
  resetTurnPersistState,
  clearCodexPlanRowsForSession,
  clearSessionPersistState,
  consumeLastAssistantPersistId,
  consumeLastTopLevelAssistantPersistId,
  markAssistantTurnCompleted,
  markAssistantTurnFailed,
  noteSessionClearBoundary,
  noteSessionAgentKind,
  noteAgentMeta,
  enqueueDurableWrite,
  noteTurnStarted,
  saveTurnStartedAtForDeferred,
  preserveTurnPersistStateForBackground,
} from '../messagePersistBroadcaster.js';

const SESSION = 'sess-tr';
const FULL =
  '{"ok":true,"text":"...","xdt_image_urls":["xdt-image://feishu-media-images/abc.jpg"]}';
const SUMMARY = 'tool finished';

// 落库走 writeChain microtask,断言前 flush 一个宏任务边界把队列排空。
const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 0));
const broadcastGuard = () => expect.objectContaining({ shouldBroadcast: expect.any(Function) });

describe('Codex done completion boundary', () => {
  it('only treats successful terminal data as a completed turn', () => {
    expect(isSuccessfulCodexDoneEventData({ raw: { status: 'completed' } })).toBe(true);
    expect(isSuccessfulCodexDoneEventData({ raw: { status: 'interrupted' } })).toBe(false);
    expect(isSuccessfulCodexDoneEventData({ raw: { status: 'failed' } })).toBe(false);
    expect(isSuccessfulCodexDoneEventData({ cancelled: true })).toBe(false);
    expect(isSuccessfulCodexDoneEventData({ raw: { id: 'legacy-turn' } })).toBe(false);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  ownerScopeState.current = true;
  noteSessionClearBoundary(SESSION, null);
  clearSessionPersistState(SESSION);
});

describe('update_plan tool_use persistence', () => {
  it('persists native Codex plan state without relying on the session agent cache', async () => {
    noteSessionAgentKind(SESSION, 'codex');
    onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-state',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Persist state', status: 'in_progress' }] },
      },
      null,
    );
    await flushWrites();

    expect(writeCodexPlanUpdate).toHaveBeenCalledWith(SESSION, {
      turnId: 'turn-state',
      plan: [{ step: 'Persist state', status: 'in_progress' }],
    });
  });

  it('does not restore a queued plan update after /clear advances the session boundary', async () => {
    noteSessionAgentKind(SESSION, 'codex');
    onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-before-clear',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Old plan', status: 'in_progress' }] },
      },
      null,
    );
    noteSessionClearBoundary(SESSION, Date.now());

    await flushWrites();

    expect(writeCodexPlanUpdate).not.toHaveBeenCalled();
  });

  it('rejects a late old-turn plan update that arrives after /clear', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      noteTurnStarted(SESSION);
      noteSessionAgentKind(SESSION, 'codex');

      nowSpy.mockReturnValue(1_700_000_001_000);
      noteSessionClearBoundary(SESSION, Date.now());
      onToolUseEvent(
        SESSION,
        {
          toolUseId: 'plan:late-old-turn',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Late old plan', status: 'in_progress' }] },
        },
        null,
      );

      await flushWrites();

      expect(writeCodexPlanUpdate).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects an old-turn plan update without a token after a new turn has started', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_000_000);
      noteTurnStarted(SESSION, 1);
      noteSessionAgentKind(SESSION, 'codex');

      nowSpy.mockReturnValue(1_700_000_001_000);
      noteSessionClearBoundary(SESSION, Date.now());
      resetTurnPersistState(SESSION);

      nowSpy.mockReturnValue(1_700_000_002_000);
      noteTurnStarted(SESSION, 2);
      onToolUseEvent(
        SESSION,
        {
          toolUseId: 'plan:late-replaced-turn',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Late replaced plan', status: 'in_progress' }] },
        },
        null,
        'turn',
      );

      await flushWrites();

      expect(writeCodexPlanUpdate).not.toHaveBeenCalled();

      onToolUseEvent(
        SESSION,
        {
          toolUseId: 'plan:current-replacement-turn',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Current plan', status: 'in_progress' }] },
        },
        null,
        'turn',
        undefined,
        2,
      );
      await flushWrites();

      expect(writeCodexPlanUpdate).toHaveBeenCalledWith(SESSION, {
        turnId: 'current-replacement-turn',
        plan: [{ step: 'Current plan', status: 'in_progress' }],
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('updates the existing tool_use row when Codex repeats update_plan with the same toolUseId', async () => {
    const firstPersistId = onToolUseEvent(
      SESSION,
      { toolUseId: 'plan-1', toolName: 'update_plan', input: { text: '1. Read code' } },
      null,
    );
    const secondPersistId = onToolUseEvent(
      SESSION,
      { toolUseId: 'plan-1', toolName: 'update_plan', input: { text: '1. Read code\n2. Run tests' } },
      null,
    );

    expect(secondPersistId).toBe(firstPersistId);

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: firstPersistId,
        role: 'tool_use',
        content: {
          toolUseId: 'plan-1',
          toolName: 'update_plan',
          input: { text: '1. Read code' },
        },
      }),
      broadcastGuard(),
    );
    expect(updateMessageContent).toHaveBeenCalledWith(
      SESSION,
      firstPersistId,
      {
        toolUseId: 'plan-1',
        toolName: 'update_plan',
        input: { text: '1. Read code\n2. Run tests' },
      },
    );
  });

  it('updates the existing web_search row when completed carries authoritative input', async () => {
    const firstPersistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'search-1',
        toolName: 'web_search',
        input: { query: 'early query', action: { type: 'search', query: 'early query' } },
      },
      null,
    );
    const secondPersistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'search-1',
        toolName: 'web_search',
        input: { query: 'https://example.com/final', action: { type: 'openPage', url: 'https://example.com/final' } },
      },
      null,
    );

    expect(secondPersistId).toBe(firstPersistId);

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(updateMessageContent).toHaveBeenCalledWith(
      SESSION,
      firstPersistId,
      {
        toolUseId: 'search-1',
        toolName: 'web_search',
        input: {
          query: 'https://example.com/final',
          action: { type: 'openPage', url: 'https://example.com/final' },
        },
      },
    );
  });

  it('keeps a successful turn with open plan steps available for reconciliation', async () => {
    const persistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: {
          explanation: 'keep this field',
          plan: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Start dev', status: 'in_progress' },
          ],
        },
      },
      null,
    );

    expect(persistCodexPlanOnDone(SESSION, {
      raw: { id: 'turn-1', status: 'completed' },
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Start dev', status: 'in_progress' },
      ],
    })).toBe(true);

    await flushWrites();
    expect(writeCodexPlanTerminal).toHaveBeenCalledWith(SESSION, {
      turnId: 'turn-1',
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Start dev', status: 'in_progress' },
      ],
      state: 'interrupted',
    });
    expect(updateMessageContent).toHaveBeenCalledWith(
      SESSION,
      persistId,
      expect.objectContaining({
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        // 步骤原样落库(Codex 报的就是 in_progress),退场靠下面这枚章,
        // 不靠把没干完的步骤改成 completed。
        input: {
          explanation: 'keep this field',
          plan: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Start dev', status: 'in_progress' },
          ],
        },
        terminalPlanSnapshot: true,
        terminalPlanAtMs: expect.any(Number),
      }),
    );
    expect(broadcastMessageRow).toHaveBeenCalledWith(
      SESSION,
      expect.any(Object),
      ownerScopeState.scope,
    );
  });

  /**
   * 现场 bug 的确切形态:活儿干完了,Codex 收尾时没有再发一次 plan 更新,
   * 于是 done 上压根没有 plan 快照,库里那份仍停在 in_progress/pending。
   * 必须只靠章收口——胶囊据此退场,步骤事实一个不动。
   */
  it('seals a successful turn that ended without any final plan snapshot', async () => {
    const openPlan = [
      { step: 'Find the capsule', status: 'completed' },
      { step: 'Reopen the task', status: 'in_progress' },
      { step: 'Confirm it stays gone', status: 'pending' },
    ];
    const persistId = onToolUseEvent(
      SESSION,
      { toolUseId: 'plan:turn-no-snapshot', toolName: 'update_plan', input: { plan: openPlan } },
      null,
    );

    expect(persistCodexPlanOnDone(SESSION, {
      raw: { id: 'turn-no-snapshot', status: 'completed' },
    })).toBe(true);

    await flushWrites();
    expect(updateMessageContent).toHaveBeenCalledWith(SESSION, persistId, {
      toolUseId: 'plan:turn-no-snapshot',
      toolName: 'update_plan',
      input: { plan: openPlan },
      terminalPlanSnapshot: true,
      terminalPlanAtMs: expect.any(Number),
    });
  });

  it('still seals after a continuation boundary cleared the per-segment maps', async () => {
    // 分段 turn:S1 产出计划 → continuation done(reset 清空 per-segment 映射)
    // → S2 最终 done。计划行的引用按 turnId 存活,最终 done 仍找得到它并盖章;
    // 否则重载后胶囊无章无失败印记 → 走旧版全勾完兜底 → 永久钉住(review P1-1)。
    const persistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-seg',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Segmented work', status: 'in_progress' }] },
      },
      null,
    );

    // continuation boundary 上 register 只跑 resetTurnPersistState(不 persist)。
    resetTurnPersistState(SESSION);

    expect(persistCodexPlanOnDone(SESSION, {
      raw: { id: 'turn-seg', status: 'completed' },
    })).toBe(true);

    await flushWrites();
    expect(updateMessageContent).toHaveBeenCalledWith(
      SESSION,
      persistId,
      expect.objectContaining({
        toolUseId: 'plan:turn-seg',
        toolName: 'update_plan',
        terminalPlanSnapshot: true,
      }),
    );
  });

  it('scopes a terminal-error failure stamp to the owning turn', async () => {
    onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-old',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Old turn work', status: 'in_progress' }] },
      },
      null,
    );
    const currentPersistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-current',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Current work', status: 'in_progress' }] },
      },
      null,
    );

    expect(persistCodexPlanOnTerminalError(SESSION, 'turn-current')).toBe(true);
    await flushWrites();

    expect(markCodexPlanInterrupted).toHaveBeenCalledTimes(1);
    expect(markCodexPlanInterrupted).toHaveBeenCalledWith(SESSION, 'turn-current');

    expect(updateMessageContent).toHaveBeenCalledWith(
      SESSION,
      currentPersistId,
      expect.objectContaining({ toolUseId: 'plan:turn-current', turnCompleted: false }),
    );
    // 同会话里其它 turn 的计划行不得被顺手盖失败印记。
    expect(updateMessageContent).not.toHaveBeenCalledWith(
      SESSION,
      expect.anything(),
      expect.objectContaining({ toolUseId: 'plan:turn-old' }),
    );
  });

  it('does not mutate durable plan state when an id-less error has no owned plan turn', async () => {
    expect(persistCodexPlanOnTerminalError(SESSION)).toBe(false);
    await flushWrites();

    expect(markCodexPlanInterrupted).not.toHaveBeenCalled();
  });

  it('carries repeated update_plan snapshots into the terminal write', async () => {
    // 同一 turn 的第二次 update_plan 走 persistId 复用分支。按-turn 缓存若只在
    // 首次记录,终态写入会拿首版快照整行覆盖,已勾完的进度在重载/远端同步后
    // 倒退回第一版(review P1)。
    const persistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-multi',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Inspect', status: 'in_progress' }, { step: 'Patch', status: 'pending' }] },
      },
      null,
    );
    const secondPersistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-multi',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Patch', status: 'in_progress' }] },
      },
      null,
    );
    expect(secondPersistId).toBe(persistId);

    // done 不带 plan(常见):内容只能来自缓存,必须是最新那一版。
    expect(persistCodexPlanOnDone(SESSION, {
      raw: { id: 'turn-multi', status: 'completed' },
    })).toBe(true);

    await flushWrites();
    expect(updateMessageContent).toHaveBeenLastCalledWith(
      SESSION,
      persistId,
      expect.objectContaining({
        input: { plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Patch', status: 'in_progress' }] },
        terminalPlanSnapshot: true,
      }),
    );
  });

  it('stamps a terminal-error failure onto the latest repeated plan snapshot', async () => {
    const persistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-multi-err',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Inspect', status: 'in_progress' }] },
      },
      null,
    );
    onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-multi-err',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Inspect', status: 'completed' }] },
      },
      null,
    );

    expect(persistCodexPlanOnTerminalError(SESSION, 'turn-multi-err')).toBe(true);
    await flushWrites();
    expect(updateMessageContent).toHaveBeenLastCalledWith(
      SESSION,
      persistId,
      expect.objectContaining({
        input: { plan: [{ step: 'Inspect', status: 'completed' }] },
        turnCompleted: false,
      }),
    );
  });

  it('stamps an already-completed plan as terminal at the successful done boundary', async () => {
    const persistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-complete',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Ship', status: 'completed' }] },
      },
      null,
    );

    expect(persistCodexPlanOnDone(SESSION, {
      raw: { id: 'turn-complete', status: 'completed' },
      plan: [{ step: 'Ship', status: 'completed' }],
    })).toBe(true);

    await flushWrites();
    expect(writeCodexPlanTerminal).toHaveBeenCalledWith(SESSION, {
      turnId: 'turn-complete',
      plan: [{ step: 'Ship', status: 'completed' }],
      state: 'sealed',
    });
    expect(updateMessageContent).toHaveBeenCalledWith(
      SESSION,
      persistId,
      {
        toolUseId: 'plan:turn-complete',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Ship', status: 'completed' }] },
        terminalPlanSnapshot: true,
        terminalPlanAtMs: expect.any(Number),
      },
    );
    expect(broadcastMessageRow).toHaveBeenCalledWith(
      SESSION,
      expect.any(Object),
      ownerScopeState.scope,
    );
  });

  it('persists non-success boundaries without inferring completion or touching unrelated turns', async () => {
    const persistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Wait for user', status: 'in_progress' }] },
      },
      null,
    );

    expect(persistCodexPlanOnDone(SESSION, {
      raw: { id: 'turn-1', status: 'interrupted' },
    })).toBe(true);
    expect(persistCodexPlanOnDone(SESSION, {
      cancelled: true,
      raw: { id: 'turn-1', status: 'completed' },
    })).toBe(true);
    expect(persistCodexPlanOnDone(SESSION, {
      raw: { id: 'turn-2', status: 'completed' },
    })).toBe(false);

    await flushWrites();
    expect(updateMessageContent).toHaveBeenCalledWith(
      SESSION,
      persistId,
      {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Wait for user', status: 'in_progress' }] },
        turnCompleted: false,
      },
    );
  });

  it('stamps the current turn plan as failed at a terminal error without a done', async () => {
    // Codex 在 terminal error 后显式压掉迟到的 turnCompleted,该 turn 永远等不到
    // done → persistCodexPlanOnDone 不会跑。此时必须由 error 边界补 turnCompleted:false,
    // 否则全勾完的失败计划没有任何存活印记,面板会当旧数据兜底退场。
    const persistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-err',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Ship', status: 'completed' }] },
      },
      null,
    );

    expect(persistCodexPlanOnTerminalError(SESSION)).toBe(true);

    await flushWrites();
    expect(updateMessageContent).toHaveBeenCalledWith(SESSION, persistId, {
      toolUseId: 'plan:turn-err',
      toolName: 'update_plan',
      // 只盖存活标记,步骤状态一个不动——失败不是把勾去掉的理由。
      input: { plan: [{ step: 'Ship', status: 'completed' }] },
      turnCompleted: false,
    });
    expect(broadcastMessageRow).toHaveBeenCalledWith(
      SESSION,
      expect.any(Object),
      ownerScopeState.scope,
    );
  });

  it('terminal error stamping is a no-op when the turn has no plan row', () => {
    expect(persistCodexPlanOnTerminalError(SESSION)).toBe(false);
  });

  it('does not carry a reconciled turn plan into a later id-less terminal error', () => {
    onToolUseEvent(
      SESSION,
      {
        toolUseId: 'plan:turn-reconciled',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Old turn work', status: 'completed' }] },
      },
      null,
    );

    // reconcileSessionTurnIdle treats the lost-terminal path as a logical turn
    // boundary and clears this cross-segment ownership before the next turn.
    clearCodexPlanRowsForSession(SESSION);
    resetTurnPersistState(SESSION);

    expect(persistCodexPlanOnTerminalError(SESSION)).toBe(false);
  });

  it('does not dedupe ordinary repeated tool_use ids', async () => {
    const firstPersistId = onToolUseEvent(
      SESSION,
      { toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'echo one' } },
      null,
    );
    const secondPersistId = onToolUseEvent(
      SESSION,
      { toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'echo two' } },
      null,
    );

    expect(secondPersistId).not.toBe(firstPersistId);

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(updateMessageContent).not.toHaveBeenCalled();
  });
});

describe('agent_kind enqueue snapshot', () => {
  it('owner boundary after commit keeps the durable result instead of triggering retry', async () => {
    const result = await enqueueDurableWrite('post-commit-owner-switch', () => {
      ownerScopeState.current = false;
      return { committed: true };
    });

    expect(result).toEqual({ committed: true });
  });

  it('writeChain 延迟期间切换引擎,消息仍使用事件入队时的 agent_kind', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = enqueueDurableWrite('agent-kind-test-blocker', () => gate);

    noteSessionAgentKind(SESSION, 'cc');
    onToolUseEvent(
      SESSION,
      { toolUseId: 'before-switch', toolName: 'Read', input: { file_path: '/tmp/a' } },
      null,
    );
    noteSessionAgentKind(SESSION, 'codex');
    release();
    await blocker;
    await flushWrites();

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ role: 'tool_use', agentKind: 'cc' }),
      broadcastGuard(),
    );
  });
});

describe('tool_result 顺序:先 tool_result(摘要)后 tool_result_full(全文)', () => {
  it('摘要先建,全文覆盖更新;返回内容与落库内容同源', async () => {
    const r1 = onToolResultEvent(SESSION, { summary: SUMMARY, toolUseIds: ['tu_42'] }, null);
    expect(r1).toEqual({ persistId: expect.any(String), content: SUMMARY });

    const r2 = onToolResultFullEvent(SESSION, { toolUseId: 'tu_42', fullText: FULL }, null);
    // 全文更新到同一条(persistId 不变),内容变 FULL。
    expect(r2).toEqual({ persistId: r1!.persistId, content: FULL });

    await flushWrites();
    // 同源证明:create 落的内容 == r1.content;update 落的内容 == r2.content。
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: r1!.persistId, role: 'tool_result', content: r1!.content }),
      broadcastGuard(),
    );
    expect(updateMessageContent).toHaveBeenCalledWith(SESSION, r1!.persistId, r2!.content);
  });
});

describe('background tool_result persistence', () => {
  it('reconstructs a completed-only background collab tool context', async () => {
    const lateMeta = { uuid: 'late-completed-only-turn' };
    const toolUsePersistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'late-completed-only-child',
        toolName: 'collab:spawnAgent',
        input: { receiverThreadIds: ['child-thread'] },
      },
      lateMeta,
      'background',
    );

    const fullResult = onToolResultFullEvent(
      SESSION,
      { toolUseId: 'late-completed-only-child', fullText: FULL },
      null,
      'background',
    );
    const result = onToolResultEvent(
      SESSION,
      { summary: SUMMARY, toolUseIds: ['late-completed-only-child'] },
      null,
      'background',
    );

    await flushWrites();

    expect(fullResult).toEqual({ persistId: expect.any(String), content: FULL });
    expect(result).toEqual(fullResult);
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: toolUsePersistId,
        role: 'tool_use',
        toolUseId: 'late-completed-only-child',
        agentMeta: lateMeta,
      }),
      broadcastGuard(),
    );
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        role: 'tool_result',
        content: FULL,
        toolUseId: 'late-completed-only-child',
        agentMeta: lateMeta,
      }),
      broadcastGuard(),
    );
  });

  it('drops a completed-only background collab context owned by a pre-clear turn', async () => {
    const turnStartedAt = Date.parse('2026-06-20T10:05:00.000Z');
    const clearAt = Date.parse('2026-06-20T10:05:05.000Z');
    const lateItemAt = Date.parse('2026-06-20T10:05:10.000Z');
    noteSessionClearBoundary(SESSION, clearAt);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(lateItemAt);

    const toolUsePersistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'late-completed-only-cleared-child',
        toolName: 'collab:spawnAgent',
        input: { receiverThreadIds: ['child-thread'] },
      },
      null,
      'background',
      turnStartedAt,
    );
    const fullResult = onToolResultFullEvent(
      SESSION,
      { toolUseId: 'late-completed-only-cleared-child', fullText: FULL },
      null,
      'background',
    );
    const result = onToolResultEvent(
      SESSION,
      { summary: SUMMARY, toolUseIds: ['late-completed-only-cleared-child'] },
      null,
      'background',
    );
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(toolUsePersistId).toBeUndefined();
    expect(fullResult).toBeNull();
    expect(result).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('keeps a completed-only background collab context owned by a post-clear turn', async () => {
    const clearAt = Date.parse('2026-06-20T10:05:00.000Z');
    const turnStartedAt = Date.parse('2026-06-20T10:05:05.000Z');
    const lateItemAt = Date.parse('2026-06-20T10:05:10.000Z');
    noteSessionClearBoundary(SESSION, clearAt);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(lateItemAt);

    const toolUsePersistId = onToolUseEvent(
      SESSION,
      {
        toolUseId: 'late-completed-only-post-clear-child',
        toolName: 'collab:spawnAgent',
        input: { receiverThreadIds: ['child-thread'] },
      },
      null,
      'background',
      turnStartedAt,
    );
    const fullResult = onToolResultFullEvent(
      SESSION,
      { toolUseId: 'late-completed-only-post-clear-child', fullText: FULL },
      null,
      'background',
    );
    const result = onToolResultEvent(
      SESSION,
      { summary: SUMMARY, toolUseIds: ['late-completed-only-post-clear-child'] },
      null,
      'background',
    );
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(toolUsePersistId).toEqual(expect.any(String));
    expect(fullResult).toEqual({ persistId: expect.any(String), content: FULL });
    expect(result).toEqual(fullResult);
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: toolUsePersistId,
        role: 'tool_use',
        toolUseId: 'late-completed-only-post-clear-child',
      }),
      broadcastGuard(),
    );
  });

  it('keeps the completed turn context after the next turn resets live state', async () => {
    const oldMeta = { uuid: 'old-turn' };
    const nextMeta = { uuid: 'new-turn' };
    noteAgentMeta(SESSION, oldMeta);
    onToolUseEvent(
      SESSION,
      { toolUseId: 'late-child', toolName: 'collab:spawnAgent', input: {} },
      oldMeta,
    );
    preserveTurnPersistStateForBackground(SESSION);
    resetTurnPersistState(SESSION);
    // Simulate the next turn repopulating the live fallback before the old
    // child result arrives.
    noteAgentMeta(SESSION, nextMeta);
    onToolUseEvent(
      SESSION,
      { toolUseId: 'next-turn-tool', toolName: 'Read', input: {} },
      nextMeta,
    );

    const fullResult = onToolResultFullEvent(
      SESSION,
      { toolUseId: 'late-child', fullText: FULL },
      null,
      'background',
    );
    const result = onToolResultEvent(
      SESSION,
      { summary: SUMMARY, toolUseIds: ['late-child'] },
      null,
      'background',
    );

    await flushWrites();

    expect(fullResult).toEqual({ persistId: expect.any(String), content: FULL });
    expect(result).toEqual(fullResult);
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        role: 'tool_result',
        content: FULL,
        agentMeta: oldMeta,
      }),
      broadcastGuard(),
    );
  });

  it('retains an in-flight background context beyond four later turns', async () => {
    const oldMeta = { uuid: 'old-in-flight-turn' };
    noteAgentMeta(SESSION, oldMeta);
    onToolUseEvent(
      SESSION,
      { toolUseId: 'late-child-long', toolName: 'collab:spawnAgent', input: {} },
      oldMeta,
    );
    preserveTurnPersistStateForBackground(SESSION);
    resetTurnPersistState(SESSION);

    for (let i = 0; i < 5; i += 1) {
      const meta = { uuid: `later-turn-${i}` };
      noteAgentMeta(SESSION, meta);
      onToolUseEvent(
        SESSION,
        { toolUseId: `later-child-${i}`, toolName: 'collab:spawnAgent', input: {} },
        meta,
      );
      preserveTurnPersistStateForBackground(SESSION);
      resetTurnPersistState(SESSION);
    }

    const result = onToolResultEvent(
      SESSION,
      { summary: SUMMARY, toolUseIds: ['late-child-long'] },
      null,
      'background',
    );

    await flushWrites();

    expect(result).toEqual({ persistId: expect.any(String), content: SUMMARY });
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ role: 'tool_result', agentMeta: oldMeta }),
      broadcastGuard(),
    );
  });

  it('drops a late background result whose parent tool_use predates session clear', async () => {
    const toolUseAt = Date.parse('2026-06-20T10:05:00.000Z');
    const clearAt = Date.parse('2026-06-20T10:05:05.000Z');
    const lateResultAt = Date.parse('2026-06-20T10:05:10.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(toolUseAt);
    onToolUseEvent(
      SESSION,
      { toolUseId: 'late-cleared-child', toolName: 'collab:spawnAgent', input: {} },
      { uuid: 'old-turn' },
    );
    preserveTurnPersistStateForBackground(SESSION);
    resetTurnPersistState(SESSION);
    await flushWrites();
    vi.clearAllMocks();
    noteSessionClearBoundary(SESSION, clearAt);
    nowSpy.mockReturnValue(lateResultAt);

    const result = onToolResultEvent(
      SESSION,
      { summary: SUMMARY, toolUseIds: ['late-cleared-child'] },
      null,
      'background',
    );
    const fullResult = onToolResultFullEvent(
      SESSION,
      { toolUseId: 'late-cleared-child', fullText: FULL },
      null,
      'background',
    );
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(result).toBeNull();
    expect(fullResult).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('tool_result 顺序:先 tool_result_full(全文)后 tool_result(摘要)', () => {
  it('全文先 buffer(无显示),摘要到达时建消息并用全文', async () => {
    const r1 = onToolResultFullEvent(SESSION, { toolUseId: 'tu_99', fullText: FULL }, null);
    // tool_use / tool_result 都没到 → buffer,无 persistId(renderer no-op)。
    expect(r1).toBeNull();
    await flushWrites();
    expect(createMessage).not.toHaveBeenCalled();

    const r2 = onToolResultEvent(SESSION, { summary: SUMMARY, toolUseIds: ['tu_99'] }, null);
    // 建消息时消费 buffer,内容用更长的全文(非摘要)。
    expect(r2).toEqual({ persistId: expect.any(String), content: FULL });

    await flushWrites();
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ role: 'tool_result', content: FULL, clientId: r2!.persistId }),
      broadcastGuard(),
    );
  });

  it('clamps buffered full-result rows after their later tool_use', async () => {
    const fullAt = Date.parse('2026-06-20T10:05:00.000Z');
    const toolUseAt = Date.parse('2026-06-20T10:05:02.000Z');
    const summaryAt = Date.parse('2026-06-20T10:05:04.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(fullAt);
    expect(onToolResultFullEvent(SESSION, { toolUseId: 'tu_late_summary', fullText: FULL }, null)).toBeNull();
    nowSpy.mockReturnValue(toolUseAt);
    const toolUsePersistId = onToolUseEvent(SESSION, { toolUseId: 'tu_late_summary', toolName: 'Edit', input: {} }, null);
    nowSpy.mockReturnValue(summaryAt);
    const result = onToolResultEvent(SESSION, { summary: SUMMARY, toolUseIds: ['tu_late_summary'] }, null);
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: toolUsePersistId, role: 'tool_use', createdAt: toolUseAt }),
      broadcastGuard(),
    );
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: result?.persistId,
        role: 'tool_result',
        content: FULL,
        toolUseId: 'tu_late_summary',
        createdAt: toolUseAt + 1,
      }),
      broadcastGuard(),
    );
  });

  it('clamps grouped buffered tool_result after the latest known parent tool_use', async () => {
    const fullAt = Date.parse('2026-06-20T10:05:00.000Z');
    const earlyToolUseAt = Date.parse('2026-06-20T10:05:01.000Z');
    const primaryToolUseAt = Date.parse('2026-06-20T10:05:04.000Z');
    const summaryAt = Date.parse('2026-06-20T10:05:06.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(fullAt);
    expect(onToolResultFullEvent(SESSION, { toolUseId: 'tu_early_full', fullText: FULL }, null)).toBeNull();
    nowSpy.mockReturnValue(earlyToolUseAt);
    onToolUseEvent(SESSION, { toolUseId: 'tu_early_full', toolName: 'Read', input: {} }, null);
    nowSpy.mockReturnValue(primaryToolUseAt);
    const primaryPersistId = onToolUseEvent(
      SESSION,
      { toolUseId: 'tu_primary_late', toolName: 'Edit', input: {} },
      null,
    );
    nowSpy.mockReturnValue(summaryAt);
    const result = onToolResultEvent(
      SESSION,
      { summary: SUMMARY, toolUseIds: ['tu_primary_late', 'tu_early_full'] },
      null,
    );
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: primaryPersistId,
        role: 'tool_use',
        toolUseId: 'tu_primary_late',
        createdAt: primaryToolUseAt,
      }),
      broadcastGuard(),
    );
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: result?.persistId,
        role: 'tool_result',
        content: FULL,
        toolUseId: 'tu_primary_late',
        createdAt: primaryToolUseAt + 1,
      }),
      broadcastGuard(),
    );
  });
});

describe('eager-create:tool_use 已到,tool_result_full 早于摘要', () => {
  it('直接建一条带全文的 tool_result(同源)', async () => {
    onToolUseEvent(SESSION, { toolUseId: 'tu_live', toolName: 'Edit', input: { file_path: '/tmp/a.ts' } }, null);
    vi.clearAllMocks();

    const r = onToolResultFullEvent(SESSION, { toolUseId: 'tu_live', fullText: FULL }, null);
    expect(r).toEqual({ persistId: expect.any(String), content: FULL });

    await flushWrites();
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ role: 'tool_result', content: FULL, toolUseId: 'tu_live', clientId: r!.persistId }),
      broadcastGuard(),
    );

    // 随后摘要到达 → 命中已有映射、内容没增长 → 不重复建、不 update。
    vi.clearAllMocks();
    const r2 = onToolResultEvent(SESSION, { summary: SUMMARY, toolUseIds: ['tu_live'] }, null);
    expect(r2!.persistId).toBe(r!.persistId);
    expect(r2!.content).toBe(FULL); // 保留全文
    await flushWrites();
    expect(createMessage).not.toHaveBeenCalled();
    expect(updateMessageContent).not.toHaveBeenCalled();
  });
});

describe('synthetic tool events:本地合成事件也返回 renderer 展示所需 payload', () => {
  it('Codex imageGeneration 合成 imagegen 三联事件时带 persistId/resolvedContent', async () => {
    const toolUse = prepareSyntheticToolEventForBroadcast(
      SESSION,
      {
        type: 'tool_use',
        data: { toolUseId: 'codex-img-1', toolName: 'imagegen', input: { status: 'completed' } },
      },
      null,
    );
    expect(toolUse).toEqual({ persistId: expect.any(String) });

    const imageResult = JSON.stringify({
      ok: true,
      kind: 'generation',
      xdt_image_url: 'xdt-image://sess-tr/generated.png',
    });

    const full = prepareSyntheticToolEventForBroadcast(
      SESSION,
      { type: 'tool_result_full', data: { toolUseId: 'codex-img-1', fullText: imageResult } },
      null,
    );
    expect(full).toEqual({ persistId: expect.any(String), resolvedContent: imageResult });

    const summary = prepareSyntheticToolEventForBroadcast(
      SESSION,
      { type: 'tool_result', data: { summary: 'image generated', toolUseIds: ['codex-img-1'] } },
      null,
    );
    expect(summary).toEqual(full);

    await flushWrites();
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: toolUse.persistId,
        role: 'tool_use',
        toolUseId: 'codex-img-1',
      }),
      broadcastGuard(),
    );
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: full.persistId,
        role: 'tool_result',
        content: imageResult,
        toolUseId: 'codex-img-1',
      }),
      broadcastGuard(),
    );
  });
});

describe('done orphan:残留 buffer 在 turn 末 flush', () => {
  it('buffer 的全文在 flushOrphanToolResults 落成 orphan tool_result', async () => {
    const r = onToolResultFullEvent(SESSION, { toolUseId: 'tu_orphan', fullText: FULL }, null);
    expect(r).toBeNull(); // buffered
    await flushWrites();
    expect(createMessage).not.toHaveBeenCalled();

    flushOrphanToolResults(SESSION, null);
    await flushWrites();
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ role: 'tool_result', content: FULL, toolUseId: 'tu_orphan' }),
      broadcastGuard(),
    );
  });

  it('clamps buffered orphan tool_result after its later tool_use', async () => {
    const fullAt = Date.parse('2026-06-20T10:06:00.000Z');
    const toolUseAt = Date.parse('2026-06-20T10:06:02.000Z');
    const doneAt = Date.parse('2026-06-20T10:06:05.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(fullAt);
    expect(onToolResultFullEvent(SESSION, { toolUseId: 'tu_late_orphan', fullText: FULL }, null)).toBeNull();
    nowSpy.mockReturnValue(toolUseAt);
    const toolUsePersistId = onToolUseEvent(SESSION, { toolUseId: 'tu_late_orphan', toolName: 'Edit', input: {} }, null);
    nowSpy.mockReturnValue(doneAt);
    try {
      flushOrphanToolResults(SESSION, null);
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: toolUsePersistId, role: 'tool_use', createdAt: toolUseAt }),
      broadcastGuard(),
    );
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        role: 'tool_result',
        content: FULL,
        toolUseId: 'tu_late_orphan',
        createdAt: toolUseAt + 1,
      }),
      broadcastGuard(),
    );
  });
});

describe('thinking persistence', () => {
  it('uses the final event timestamp instead of delayed write time', async () => {
    const finishedAt = Date.parse('2026-06-20T09:10:00.000Z');
    const delayedWriteTime = Date.parse('2026-06-20T09:10:04.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(finishedAt).mockReturnValue(delayedWriteTime);
    try {
      onThinkingEvent(
        SESSION,
        { stage: 'final', blockId: 'thinking-1', text: 'reasoned answer', durationMs: 7_000 },
        null,
      );
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: 'thinking-1',
        role: 'thinking',
        content: {
          kind: 'thinking',
          text: 'reasoned answer',
          durationMs: 7_000,
          isRedacted: false,
          finishedAt,
        },
        createdAt: finishedAt,
      }),
      broadcastGuard(),
    );
  });

  it('persists redacted thinking as a structured hidden row', async () => {
    const finishedAt = Date.parse('2026-06-20T09:11:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(finishedAt);
    try {
      onThinkingEvent(
        SESSION,
        { stage: 'redacted', blockId: 'thinking-redacted' },
        null,
      );
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: 'thinking-redacted',
        role: 'thinking',
        content: {
          kind: 'thinking',
          text: '',
          durationMs: 0,
          isRedacted: true,
          finishedAt,
        },
        createdAt: finishedAt,
      }),
      broadcastGuard(),
    );
  });
});

describe('event timestamp persistence', () => {
  it('uses the first assistant delta timestamp when the block is flushed later', async () => {
    const startedAt = Date.parse('2026-06-20T10:00:00.000Z');
    const delayedWriteTime = Date.parse('2026-06-20T10:00:05.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(startedAt);
    const persistId = onAssistantTextEvent(SESSION, { text: 'hello', isFinal: false }, null);
    nowSpy.mockReturnValue(delayedWriteTime);
    try {
      flushAssistantBlock(SESSION, null);
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: persistId,
        role: 'assistant',
        content: 'hello',
        createdAt: startedAt,
      }),
      broadcastGuard(),
    );
  });

  it('captures non-thinking create timestamps before queued writes drain', async () => {
    const eventAt = Date.parse('2026-06-20T10:01:00.000Z');
    const delayedWriteTime = Date.parse('2026-06-20T10:01:07.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(eventAt);
    const toolUseId = onToolUseEvent(SESSION, { toolUseId: 'tu_time', toolName: 'Bash', input: {} }, null);
    const toolResult = onToolResultEvent(SESSION, { summary: SUMMARY, toolUseIds: ['tu_time'] }, null);
    const askId = onInteractionMessage(SESSION, {
      kind: 'ask_user_question',
      requestId: 'ask-time',
      questions: [{ question: 'Continue?' }],
    });
    nowSpy.mockReturnValue(delayedWriteTime);
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: toolUseId, role: 'tool_use', createdAt: eventAt }),
      broadcastGuard(),
    );
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: toolResult?.persistId, role: 'tool_result', createdAt: eventAt }),
      broadcastGuard(),
    );
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: askId, role: 'ask_user', createdAt: eventAt }),
      broadcastGuard(),
    );
  });

  it('keeps the early full-result event timestamp when a later summary creates the row', async () => {
    const fullAt = Date.parse('2026-06-20T10:02:00.000Z');
    const summaryAt = Date.parse('2026-06-20T10:02:03.000Z');
    const delayedWriteTime = Date.parse('2026-06-20T10:02:09.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(fullAt);
    expect(onToolResultFullEvent(SESSION, { toolUseId: 'tu_buffered', fullText: FULL }, null)).toBeNull();
    nowSpy.mockReturnValue(summaryAt);
    const result = onToolResultEvent(SESSION, { summary: SUMMARY, toolUseIds: ['tu_buffered'] }, null);
    nowSpy.mockReturnValue(delayedWriteTime);
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: result?.persistId,
        role: 'tool_result',
        content: FULL,
        createdAt: fullAt,
      }),
      broadcastGuard(),
    );
  });

  it('suppresses broadcasts for queued event-time rows hidden by /clear', async () => {
    const eventAt = Date.parse('2026-06-20T10:03:00.000Z');
    const clearAt = Date.parse('2026-06-20T10:03:01.000Z');
    const delayedWriteTime = Date.parse('2026-06-20T10:03:05.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(eventAt);
    const persistId = onAssistantTextEvent(SESSION, { text: 'stale after clear', isFinal: true }, null);
    noteSessionClearBoundary(SESSION, clearAt);
    nowSpy.mockReturnValue(delayedWriteTime);
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: persistId,
        role: 'assistant',
        content: 'stale after clear',
        createdAt: eventAt,
      }),
      broadcastGuard(),
    );
    const opts = (createMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[2] as
      | { shouldBroadcast?: () => boolean }
      | undefined;
    expect(opts?.shouldBroadcast?.()).toBe(false);
  });

  it('suppresses broadcasts when /clear happens after the DB write starts', async () => {
    const eventAt = Date.parse('2026-06-20T10:03:10.000Z');
    const clearAt = Date.parse('2026-06-20T10:03:11.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(eventAt);
    const persistId = onAssistantTextEvent(SESSION, { text: 'stale during write', isFinal: true }, null);
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: persistId,
        role: 'assistant',
        content: 'stale during write',
        createdAt: eventAt,
      }),
      broadcastGuard(),
    );

    const opts = (createMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[2] as
      | { shouldBroadcast?: () => boolean }
      | undefined;
    noteSessionClearBoundary(SESSION, clearAt);
    expect(opts?.shouldBroadcast?.()).toBe(false);
  });

  it('keeps the latest /clear boundary when older async updates arrive later', async () => {
    const firstClearAt = Date.parse('2026-06-20T10:03:20.000Z');
    const eventAt = Date.parse('2026-06-20T10:03:21.000Z');
    const secondClearAt = Date.parse('2026-06-20T10:03:22.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(eventAt);
    const persistId = onAssistantTextEvent(SESSION, { text: 'between clears', isFinal: true }, null);
    noteSessionClearBoundary(SESSION, secondClearAt);
    noteSessionClearBoundary(SESSION, firstClearAt);
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: persistId,
        role: 'assistant',
        content: 'between clears',
        createdAt: eventAt,
      }),
      broadcastGuard(),
    );

    const opts = (createMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[2] as
      | { shouldBroadcast?: () => boolean }
      | undefined;
    expect(opts?.shouldBroadcast?.()).toBe(false);
  });

  it('keeps /clear broadcast guard when session close cleanup runs before queued writes drain', async () => {
    const eventAt = Date.parse('2026-06-20T10:04:00.000Z');
    const clearAt = Date.parse('2026-06-20T10:04:01.000Z');
    const delayedWriteTime = Date.parse('2026-06-20T10:04:05.000Z');
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(eventAt);
    const persistId = onAssistantTextEvent(SESSION, { text: 'stale after close', isFinal: true }, null);
    noteSessionClearBoundary(SESSION, clearAt);
    clearSessionPersistState(SESSION);
    nowSpy.mockReturnValue(delayedWriteTime);
    try {
      await flushWrites();
    } finally {
      nowSpy.mockRestore();
    }

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: persistId,
        role: 'assistant',
        content: 'stale after close',
        createdAt: eventAt,
      }),
      broadcastGuard(),
    );
    const opts = (createMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[2] as
      | { shouldBroadcast?: () => boolean }
      | undefined;
    expect(opts?.shouldBroadcast?.()).toBe(false);
  });
});

describe('guard / 幂等', () => {
  it('空 toolUseId 或非字符串 fullText 直接忽略(返回 null、不落库)', async () => {
    expect(onToolResultFullEvent(SESSION, { toolUseId: '', fullText: FULL }, null)).toBeNull();
    expect(
      onToolResultFullEvent(SESSION, { toolUseId: 'tu_x', fullText: 123 as unknown as string }, null),
    ).toBeNull();
    await flushWrites();
    expect(createMessage).not.toHaveBeenCalled();
    expect(updateMessageContent).not.toHaveBeenCalled();
  });

  it('内容未变的 tool_result_full → 返回 null、不重复 update', async () => {
    onToolResultEvent(SESSION, { summary: FULL, toolUseIds: ['tu_dup'] }, null);
    await flushWrites();
    vi.clearAllMocks();

    const r = onToolResultFullEvent(SESSION, { toolUseId: 'tu_dup', fullText: FULL }, null);
    expect(r).toBeNull();
    await flushWrites();
    expect(updateMessageContent).not.toHaveBeenCalled();
  });
});

describe('assistant isFinal burst DUP-SKIP(P1:main 对称去重,防重复 isFinal 落第二行)', () => {
  it('紧邻的同内容 isFinal burst 连发两次 → 只落一行、复用同一 persistId', async () => {
    const r1 = onAssistantTextEvent(SESSION, { text: 'Done.', isFinal: true }, null);
    const r2 = onAssistantTextEvent(SESSION, { text: 'Done.', isFinal: true }, null);
    expect(typeof r1).toBe('string');
    expect(r2).toBe(r1); // 复用,不新建
    await flushWrites();
    // 只 create 一次(第二次被 DUP-SKIP 挡在落库层)。
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ role: 'assistant', content: 'Done.', clientId: r1 }),
      broadcastGuard(),
    );
  });

  it('中间夹了别的消息(tool_use)→ 同内容 assistant 不被误删(与 renderer 1:1)', async () => {
    const r1 = onAssistantTextEvent(SESSION, { text: 'Done.', isFinal: true }, null);
    onToolUseEvent(SESSION, { toolUseId: 'tu_mid', toolName: 'Edit', input: {} }, null);
    const r3 = onAssistantTextEvent(SESSION, { text: 'Done.', isFinal: true }, null);
    // 相邻的上一条是 tool_use,不是 assistant → 第二条 'Done.' 正常新建,不被吞。
    expect(r3).not.toBe(r1);
    await flushWrites();
    const assistantCreates = (createMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => (c[1] as { role?: string }).role === 'assistant');
    expect(assistantCreates).toHaveLength(2);
  });

  it('P1b:跨 turn(reset 之后)同内容 burst 不去重 → 两次 create、不丢消息', async () => {
    // turn1 非流式 burst "X";turn 结束 reset(用户消息走 renderer、不更新 main tracker,
    // 故必须靠 reset 清 tracker,否则 turn2 同内容 burst 会被误判重复跳 create → 丢回复)。
    const r1 = onAssistantTextEvent(SESSION, { text: 'X', isFinal: true }, null);
    resetTurnPersistState(SESSION);
    const r2 = onAssistantTextEvent(SESSION, { text: 'X', isFinal: true }, null);
    expect(r2).not.toBe(r1); // 跨 turn 不复用
    await flushWrites();
    const assistantCreates = (createMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => (c[1] as { role?: string }).role === 'assistant');
    expect(assistantCreates).toHaveLength(2);
  });
});

describe('streamed assistant final calibration', () => {
  it('persists the authoritative final text even when it is shorter than accumulated deltas', async () => {
    const persistId = onAssistantTextEvent(
      SESSION,
      { text: 'Hello worxderful', isFinal: false },
      null,
    );
    expect(onAssistantTextEvent(
      SESSION,
      { text: 'Hello wonderful', isFinal: true, isFullText: true },
      null,
    )).toBe(persistId);

    flushAssistantBlock(SESSION, null);
    await flushWrites();

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        clientId: persistId,
        role: 'assistant',
        content: 'Hello wonderful',
      }),
      broadcastGuard(),
    );
  });

  it('drops stale streamed deltas when the authoritative final text is empty', async () => {
    const persistId = onAssistantTextEvent(
      SESSION,
      { text: '撤回前的流式内容', isFinal: false },
      null,
    );
    expect(onAssistantTextEvent(
      SESSION,
      { text: '', isFinal: true, isFullText: true },
      null,
    )).toBe(persistId);

    flushAssistantBlock(SESSION, null);
    await flushWrites();

    expect(createMessage).not.toHaveBeenCalled();
  });

  it('does not treat a shorter unmarked isFinal tail as a complete replacement', async () => {
    const persistId = onAssistantTextEvent(
      SESSION,
      { text: 'Hello ', isFinal: false },
      null,
    );
    expect(onAssistantTextEvent(
      SESSION,
      { text: 'world', isFinal: true },
      null,
    )).toBe(persistId);

    flushAssistantBlock(SESSION, null);
    await flushWrites();

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ content: 'Hello ' }),
      broadcastGuard(),
    );
  });

  it('accepts a longer unmarked final prefix when Claude deltas missed the tail', async () => {
    const persistId = onAssistantTextEvent(
      SESSION,
      { text: 'Hello ', isFinal: false },
      null,
    );
    expect(onAssistantTextEvent(
      SESSION,
      { text: 'Hello world', isFinal: true },
      null,
    )).toBe(persistId);

    flushAssistantBlock(SESSION, null);
    await flushWrites();

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: persistId, content: 'Hello world' }),
      broadcastGuard(),
    );
  });

  it('does not replace a streamed block with a longer unrelated local text block', async () => {
    const persistId = onAssistantTextEvent(
      SESSION,
      { text: 'first', isFinal: false },
      null,
    );
    onAssistantTextEvent(SESSION, { text: 'second block', isFinal: true }, null);

    flushAssistantBlock(SESSION, null);
    await flushWrites();

    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ clientId: persistId, content: 'first' }),
      broadcastGuard(),
    );
  });
});

describe('consumeLastAssistantPersistId(per-turn 费用挂载的目标消息追踪)', () => {
  it('流式 block 经边界 flush 落库后能取到其 persistId,取后即清', () => {
    const persistId = onAssistantTextEvent(SESSION, { text: 'hello', isFinal: false }, null);
    flushAssistantBlock(SESSION, null);
    expect(consumeLastAssistantPersistId(SESSION)).toBe(persistId);
    // consume 即清:第二次取(下一轮纯 tool 轮场景)拿不到旧 id。
    expect(consumeLastAssistantPersistId(SESSION)).toBeUndefined();
  });

  it('非流式 isFinal burst 路径也记录 persistId', () => {
    const persistId = onAssistantTextEvent(SESSION, { text: 'burst', isFinal: true }, null);
    expect(consumeLastAssistantPersistId(SESSION)).toBe(persistId);
  });

  it('does not persist a leaked Grok stop token as the last assistant', async () => {
    const first = onAssistantTextEvent(SESSION, { text: '现有 reviewer 空闲。', isFinal: true }, null);
    const leaked = onAssistantTextEvent(SESSION, { text: '<|eos|>', isFinal: true }, null);
    await flushWrites();
    expect(leaked).toBeUndefined();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(consumeLastAssistantPersistId(SESSION)).toBe(first);
  });

  it('keeps an embedded stop token when it arrives as a later streaming delta', async () => {
    onAssistantTextEvent(SESSION, { text: 'The token is ', isFinal: false }, null);
    onAssistantTextEvent(SESSION, { text: '<|eos|>', isFinal: false }, null);
    flushAssistantBlock(SESSION, null);
    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ content: 'The token is <|eos|>' }),
      expect.anything(),
    );
  });

  it('同 turn 多条 assistant → 取到最后一条的 persistId', () => {
    onAssistantTextEvent(SESSION, { text: 'first', isFinal: true }, null);
    onToolUseEvent(SESSION, { toolUseId: 'tu_seq', toolName: 'Bash', input: {} }, null);
    const last = onAssistantTextEvent(SESSION, { text: 'second', isFinal: true }, null);
    expect(consumeLastAssistantPersistId(SESSION)).toBe(last);
  });

  it('Subagent 文本最后落库时，usage 仍取最后一条但 title seal 锁定最后一条顶层 Assistant', () => {
    const topLevel = onAssistantTextEvent(
      SESSION,
      { text: '顶层正式答复', isFinal: true },
      { uuid: 'top-level' },
    );
    onToolUseEvent(
      SESSION,
      { toolUseId: 'toolu_subagent', toolName: 'Agent', input: {} },
      null,
    );
    const subagent = onAssistantTextEvent(
      SESSION,
      { text: 'Subagent 内部文本', isFinal: true },
      { uuid: 'subagent', parentUuid: 'toolu_subagent' },
    );

    expect(consumeLastAssistantPersistId(SESSION)).toBe(subagent);
    expect(consumeLastTopLevelAssistantPersistId(SESSION)).toBe(topLevel);
    expect(consumeLastTopLevelAssistantPersistId(SESSION)).toBeUndefined();
  });

  it('无 assistant 文本(纯 tool 轮)→ undefined', () => {
    onToolUseEvent(SESSION, { toolUseId: 'tu_only', toolName: 'Bash', input: {} }, null);
    expect(consumeLastAssistantPersistId(SESSION)).toBeUndefined();
  });

  it('clearSessionPersistState 清理追踪(session 关闭防泄漏)', () => {
    onAssistantTextEvent(SESSION, { text: 'gone', isFinal: true }, null);
    clearSessionPersistState(SESSION);
    expect(consumeLastAssistantPersistId(SESSION)).toBeUndefined();
    expect(consumeLastTopLevelAssistantPersistId(SESSION)).toBeUndefined();
  });

  it('done seal 以 durable patch 落库', async () => {
    await expect(markAssistantTurnCompleted(SESSION, 'assistant-final')).resolves.toBe(true);
    expect(patchMessageAgentMetaWithResult).toHaveBeenCalledWith(
      SESSION,
      'assistant-final',
      { turnCompleted: true },
    );
    expect(broadcastMessageAgentMetaUpdate).toHaveBeenCalledWith(
      SESSION,
      'assistant-final',
      expect.objectContaining({ ownerStamp: undefined }),
    );
  });

  it('terminal error seal 以 durable patch 写 false', async () => {
    await expect(markAssistantTurnFailed(SESSION, 'assistant-failed')).resolves.toBe(true);
    expect(patchMessageAgentMetaWithResult).toHaveBeenCalledWith(
      SESSION,
      'assistant-failed',
      { turnCompleted: false },
    );
    expect(broadcastMessageAgentMetaUpdate).toHaveBeenCalledWith(
      SESSION,
      'assistant-failed',
      expect.objectContaining({ ownerStamp: undefined }),
    );
  });

  it('纯 tool turn 没有 assistant 时不写 seal', async () => {
    await expect(markAssistantTurnCompleted(SESSION, undefined)).resolves.toBe(false);
    await expect(markAssistantTurnFailed(SESSION, undefined)).resolves.toBe(false);
    expect(patchMessageAgentMetaWithResult).not.toHaveBeenCalled();
  });
});

describe('onTurnErrorEvent — terminal error 持久化', () => {
  it('落一条 role=error 行,content 保留 message/reason/sdkError,且绝不广播', async () => {
    const persistId = onTurnErrorEvent(SESSION, {
      message: '任务执行失败（模型未返回错误详情）。',
      reason: 'turn-failed',
      sdkError: 'invalid_request',
    });
    expect(persistId).toBeTruthy();

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(1);
    const [sessionArg, bodyArg, optsArg] = vi.mocked(createMessage).mock.calls[0];
    expect(sessionArg).toBe(SESSION);
    expect(bodyArg).toMatchObject({
      clientId: persistId,
      role: 'error',
      content: {
        message: '任务执行失败（模型未返回错误详情）。',
        reason: 'turn-failed',
        sdkError: 'invalid_request',
      },
    });
    // messages:created 不广播:live 展示由 ErrorBanner 负责,广播会把这行 push 进
    // live 消息流与 banner 双显示(设计取舍见 onTurnErrorEvent 头注释)。
    expect((optsArg as { shouldBroadcast?: () => boolean })?.shouldBroadcast?.()).toBe(false);
    // 脏信号必须发:让已加载历史的后台会话下次打开时从 DB 重拉,error 卡正常浮现。
    expect(mockSend).toHaveBeenCalledWith(
      'local-db:session:error-persisted',
      { sessionId: SESSION },
      undefined,
    );
  });

  it('message 为空 → 不落库也不发脏信号', async () => {
    expect(onTurnErrorEvent(SESSION, { reason: 'turn-failed' })).toBeUndefined();
    expect(onTurnErrorEvent(SESSION, null)).toBeUndefined();
    await flushWrites();
    expect(createMessage).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reason / sdkError 缺省时 content 只含 message', async () => {
    onTurnErrorEvent(SESSION, { message: 'boom' });
    await flushWrites();
    const [, bodyArg] = vi.mocked(createMessage).mock.calls[0];
    expect((bodyArg as { content: unknown }).content).toEqual({ message: 'boom' });
  });

  it('redacts credentials before writing terminal errors to the local database', async () => {
    onTurnErrorEvent(SESSION, {
      message: 'Authorization: Basic dXNlcjpwYXNz; key=sk-live-123456789',
      sdkError: 'access_token=secret-token',
    });

    await flushWrites();
    const [, bodyArg] = vi.mocked(createMessage).mock.calls[0];
    const content = (bodyArg as { content: { message: string; sdkError: string } }).content;
    expect(content.message).toBe('Authorization: [REDACTED]; key=[REDACTED_KEY]');
    expect(content.sdkError).toBe('access_token=[REDACTED]');
  });

  it('content 携带错误发生时的 provider 快照(session-provider-store 同步取值)', async () => {
    const { setSessionProvider } = await import('../maker-host/session-provider-store.js');
    const sid = 'session-provider-snapshot';
    setSessionProvider(sid, 'xd');
    try {
      onTurnErrorEvent(sid, { message: '网关余额不足(provider 快照用例)' });
      await flushWrites();
      const body = vi.mocked(createMessage).mock.calls.at(-1)?.[1] as {
        content: Record<string, unknown>;
      };
      expect(body.content.providerId).toBe('xd');
    } finally {
      setSessionProvider(sid, null);
    }
  });

  it('未显式选择 provider(默认路由)时不写 providerId —— 来源不明的行读侧 fail-closed', async () => {
    const sid = 'session-provider-unset';
    onTurnErrorEvent(sid, { message: '无显式 provider 的失败(快照用例)' });
    await flushWrites();
    const body = vi.mocked(createMessage).mock.calls.at(-1)?.[1] as {
      content: Record<string, unknown>;
    };
    expect('providerId' in body.content).toBe(false);
  });

  it('error 前的在飞 assistant 文本先 flush 落库,error 行排在其后', async () => {
    onAssistantTextEvent(SESSION, { text: '正在收尾…', isFinal: false }, null);
    onTurnErrorEvent(SESSION, { message: 'turn 崩了' });

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(2);
    const roles = vi.mocked(createMessage).mock.calls.map(
      (c) => (c[1] as { role: string }).role,
    );
    expect(roles).toEqual(['assistant', 'error']);
  });

  it('error 事件自带的 agentMeta 透传给 flush 边界与 error 行(rewind/fork 锚点不丢)', async () => {
    // 失败轮只有 error 边界携带 SDK uuid 的场景:在飞 assistant 无自带 meta,
    // 会话级兜底也为空 —— 若不透传,assistant 行以 null meta 落库(greptile P1)。
    const boundaryMeta = { uuid: 'uuid-err-boundary', sdkSessionId: 'sdk-1' };
    onAssistantTextEvent(SESSION, { text: '写到一半…', isFinal: false }, null);
    onTurnErrorEvent(SESSION, { message: 'turn 崩了' }, boundaryMeta as never);

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(2);
    const bodies = vi.mocked(createMessage).mock.calls.map(
      (c) => c[1] as { role: string; agentMeta?: unknown },
    );
    expect(bodies[0].role).toBe('assistant');
    expect(bodies[0].agentMeta).toMatchObject({ uuid: 'uuid-err-boundary' });
    expect(bodies[1].role).toBe('error');
    expect(bodies[1].agentMeta).toMatchObject({ uuid: 'uuid-err-boundary' });
  });

  it('同一 session 同一 message 同步重复调用只落一条（多窗 dedup：并发调用在 300ms 内命中）', async () => {
    // 模拟多窗口各自触发 persistTurnErrorDeferred——各调用近乎同时（< 100ms），300ms 窗口命中。
    const msg = '远程 auth 失败';
    const id1 = onTurnErrorEvent(SESSION, { message: msg, sdkError: 'authentication_failed' });
    const id2 = onTurnErrorEvent(SESSION, { message: msg, sdkError: 'authentication_failed' });
    const id3 = onTurnErrorEvent(SESSION, { message: msg });

    expect(id1).toBeTruthy();
    expect(id2).toBeUndefined(); // dedup 命中（同步调用 < 300ms）
    expect(id3).toBeUndefined(); // dedup 命中（同步调用 < 300ms）

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(1); // 只落一条
  });

  it('不同 message 不受 dedup 影响', async () => {
    onTurnErrorEvent(SESSION, { message: '错误 A' });
    onTurnErrorEvent(SESSION, { message: '错误 B' });

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('相同 message 但不同 requestId（不同 turn）不受 dedup 影响', async () => {
    // 场景：立即 retry 后第二个 turn 也以相同 message 失败。requestId 唯一标识 turn，不误 dedup。
    const msg = 'authentication_failed';
    const id1 = onTurnErrorEvent(SESSION, { message: msg }, { requestId: 'req-turn-1' } as import('@/lib/ccAgent.types').AgentMeta);
    const id2 = onTurnErrorEvent(SESSION, { message: msg }, { requestId: 'req-turn-2' } as import('@/lib/ccAgent.types').AgentMeta);

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy(); // 不同 turn → 不 dedup

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('相同 message 但不同 recorded turn（无 agentMeta 的 Codex 路径）不受 dedup 影响', async () => {
    const msg = 'gateway startup failed';
    noteTurnStarted(SESSION);
    const id1 = onTurnErrorEvent(SESSION, { message: msg });
    resetTurnPersistState(SESSION);
    noteTurnStarted(SESSION);
    const id2 = onTurnErrorEvent(SESSION, { message: msg });

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('相同 turn（requestId 相同）多窗重复调用只落一条', async () => {
    const msg = '网络错误';
    const meta = { requestId: 'req-same-turn' } as import('@/lib/ccAgent.types').AgentMeta;
    const id1 = onTurnErrorEvent(SESSION, { message: msg }, meta);
    const id2 = onTurnErrorEvent(SESSION, { message: msg }, meta);

    expect(id1).toBeTruthy();
    expect(id2).toBeUndefined(); // 同 requestId → dedup 命中

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('相同 recorded turn 的 deferred error 即使晚到也只落一条', async () => {
    const msg = '远程 auth 失败';
    const startSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    noteTurnStarted(SESSION);
    startSpy.mockRestore();

    const firstSpy = vi.spyOn(Date, 'now').mockReturnValue(10_100);
    const id1 = onTurnErrorEvent(SESSION, { message: msg, sdkError: 'authentication_failed' });
    firstSpy.mockRestore();
    const secondSpy = vi.spyOn(Date, 'now').mockReturnValue(12_500);
    const id2 = onTurnErrorEvent(SESSION, { message: msg, sdkError: 'authentication_failed' });
    secondSpy.mockRestore();

    expect(id1).toBeTruthy();
    expect(id2).toBeUndefined();

    await flushWrites();
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('/clear 在 error 事件之前发生时，createdAt 被 cap 在 clear 边界之下（不出现在清空后的会话中）', async () => {
    // 场景：turn 在 /clear 之前启动，/clear 后 terminal error 才到达。
    // noteTurnStarted 记录 turn 开始时刻（< clearBoundaryTs），使 onTurnErrorEvent
    // 识别为 stale pre-clear turn，cap error.createdAt <= clearedAt。
    const preClearTs = Date.now() - 200;
    const clearBoundaryTs = Date.now() - 100; // /clear 发生在 100ms 前

    // 模拟 turn 在 clear 之前启动
    const startSpy = vi.spyOn(Date, 'now').mockReturnValue(preClearTs);
    noteTurnStarted(SESSION);
    startSpy.mockRestore();

    noteSessionClearBoundary(SESSION, clearBoundaryTs);

    // error 事件发生在 clear 之后（capturedAt ≈ Date.now() > clearBoundaryTs）
    onTurnErrorEvent(SESSION, { message: '后台失败' });
    await flushWrites();

    expect(createMessage).toHaveBeenCalledTimes(1);
    const [, bodyArg] = vi.mocked(createMessage).mock.calls[0];
    const createdAt = (bodyArg as { createdAt?: number }).createdAt;
    // error.createdAt 必须 <= clearBoundaryTs，否则 messages:list 会把它展示出来
    expect(createdAt).toBeLessThanOrEqual(clearBoundaryTs);
  });

  it('/clear 之后发起新 turn 失败时，createdAt 不被 cap（error 卡正常浮现）', async () => {
    // 场景：用户 /clear 精简上下文后发新消息、启动新 turn，新 turn 失败。
    // noteTurnStarted 记录 post-clear turn 开始时刻（> clearBoundaryTs），
    // onTurnErrorEvent 识别为新 turn，不 cap，error 卡正常浮现。
    const clearBoundaryTs = Date.now() - 200;
    const postClearTurnTs = clearBoundaryTs + 50; // clear 后 50ms 启动的新 turn
    noteSessionClearBoundary(SESSION, clearBoundaryTs);

    // 模拟 clear 后的新 turn 启动：noteTurnStarted 用 post-clear 时间戳
    const startSpy = vi.spyOn(Date, 'now').mockReturnValue(postClearTurnTs);
    noteTurnStarted(SESSION);
    startSpy.mockRestore();

    // 也创建一个 assistant block（post-clear 时间戳）以验证 blockCreatedAt 路径
    const blockSpy = vi.spyOn(Date, 'now').mockReturnValue(postClearTurnTs);
    onAssistantTextEvent(SESSION, { text: 'partial output', isFinal: false }, null);
    blockSpy.mockRestore();

    // turn 失败；turnStartedAt = postClearTurnTs > clearBoundaryTs，不 cap。
    onTurnErrorEvent(SESSION, { message: 'clear 后新 turn 失败' });
    await flushWrites();

    // createMessage 被调两次：assistant block + error 行
    const errorCall = vi.mocked(createMessage).mock.calls.find(
      ([, body]) => (body as { role?: string }).role === 'error',
    );
    expect(errorCall).toBeDefined();
    const createdAt = (errorCall![1] as { createdAt?: number }).createdAt;
    // error.createdAt 必须 > clearBoundaryTs，messages:list (gt) 才能返回该行
    expect(createdAt).toBeGreaterThan(clearBoundaryTs);
  });

  it('mid-turn isRunning:true 进度事件不覆盖 pre-clear 起点，/clear 竞态 cap 仍生效', async () => {
    // 场景（Codex bot P2 repro）：
    //   1. turn 在 /clear 之前启动（noteTurnStarted 记录 preClearTs）
    //   2. /clear 发生（clearBoundaryTs）
    //   3. Claude 工具进度或 Codex stage 再次发 isRunning:true（noteTurnStarted 被再次调用）
    //      → 若非 first-write-wins，时间戳被 post-clear 值覆盖，cap 失效
    //   4. turn 失败 → error.createdAt 必须仍 <= clearBoundaryTs（cap 不受步骤 3 影响）
    const preClearTs = 1000;
    const clearBoundaryTs = 2000;
    const midTurnProgressTs = 2500; // mid-turn 进度事件到达时间（post-clear）

    // 1. turn 在 /clear 之前启动
    const startSpy = vi.spyOn(Date, 'now').mockReturnValue(preClearTs);
    noteTurnStarted(SESSION);
    startSpy.mockRestore();

    // 2. /clear 发生
    noteSessionClearBoundary(SESSION, clearBoundaryTs);

    // 3. mid-turn 进度事件再次调 noteTurnStarted（模拟 Claude 工具进度 / Codex stage update）
    const midSpy = vi.spyOn(Date, 'now').mockReturnValue(midTurnProgressTs);
    noteTurnStarted(SESSION); // first-write-wins 应忽略这次调用
    midSpy.mockRestore();

    // 4. error 到达（capturedAt = midTurnProgressTs > clearBoundaryTs）
    const capturedSpy = vi.spyOn(Date, 'now').mockReturnValue(midTurnProgressTs);
    onTurnErrorEvent(SESSION, { message: '进度后错误' });
    capturedSpy.mockRestore();
    resetTurnPersistState(SESSION);
    await flushWrites();

    const errorCall = vi.mocked(createMessage).mock.calls.find(
      ([, body]) => (body as { role?: string }).role === 'error',
    );
    expect(errorCall).toBeDefined();
    const createdAt = (errorCall![1] as { createdAt?: number }).createdAt;
    // turnStartedAt 保持 preClearTs(1000) <= clearBoundary(2000)，cap 生效
    expect(createdAt).toBeLessThanOrEqual(clearBoundaryTs);
  });

  it('remote auth retry deferred 持久化在 reset 后仍使用 pre-clear turn 起点做 cap', async () => {
    const preClearTs = 1000;
    const clearBoundaryTs = 2000;
    const deferredCapturedAtTs = 3500;

    const startSpy = vi.spyOn(Date, 'now').mockReturnValue(preClearTs);
    noteTurnStarted(SESSION);
    startSpy.mockRestore();

    noteSessionClearBoundary(SESSION, clearBoundaryTs);

    // 模拟 register.ts 的 remote auth retry 顺序：
    // error 事件先不落库，resetTurnPersistState 前保存 turn 起点，之后 deferred IPC 再落库。
    saveTurnStartedAtForDeferred(SESSION);
    resetTurnPersistState(SESSION);

    const capturedSpy = vi.spyOn(Date, 'now').mockReturnValue(deferredCapturedAtTs);
    onTurnErrorEvent(SESSION, { message: '认证失败', sdkError: 'authentication_failed' });
    capturedSpy.mockRestore();
    await flushWrites();

    const errorCall = vi.mocked(createMessage).mock.calls.find(
      ([, body]) => (body as { role?: string }).role === 'error',
    );
    expect(errorCall).toBeDefined();
    const createdAt = (errorCall![1] as { createdAt?: number }).createdAt;
    expect(createdAt).toBeLessThanOrEqual(clearBoundaryTs);
  });

  it('竞态场景：旧 turn 在 /clear 后且用户已发新消息后才收到 error，createdAt 被正确 cap', async () => {
    // 场景（greptile P1 repro）：
    //   1. turn 在 /clear 之前启动（noteTurnStarted 记录 preClearTs）
    //   2. /clear 发生（clearBoundaryTs）
    //   3. 用户发新消息（T=3000 > clearBoundaryTs，已写入 DB）
    //   4. 旧 turn 的 terminal error 才到达（capturedAt > clearBoundaryTs）
    // 若用 rawLatestTs（异步查到 post-clear 新消息时间戳）判断，会跳过 cap，error 串入新会话。
    // 用 turnStartedAtSnapshot <= clearBoundary 判断可正确 cap。
    const preClearTs = 1000;
    const clearBoundaryTs = 2000;
    const capturedAtTs = 3500;   // error 事件到达时间

    // 1. turn 在 /clear 之前启动
    const startSpy = vi.spyOn(Date, 'now').mockReturnValue(preClearTs);
    noteTurnStarted(SESSION);
    startSpy.mockRestore();

    // 2. /clear 发生
    noteSessionClearBoundary(SESSION, clearBoundaryTs);

    // 3. error 到达（capturedAt = capturedAtTs）。
    // 在单测环境中 latestMessageCreatedAt 返回 undefined（drizzle mock 未配置），
    // latestTs = capturedAt（= capturedAtTs）。关键验证：turnStartedAtSnapshot <= clearBoundary 使 cap 生效。
    const capturedSpy = vi.spyOn(Date, 'now').mockReturnValue(capturedAtTs);
    onTurnErrorEvent(SESSION, { message: '后台定时任务失败' });
    capturedSpy.mockRestore();
    // 模拟 register.ts 生产调用序列：onTurnErrorEvent 之后同步调 resetTurnPersistState，
    // 从而在 enqueueWrite 的 async 回调执行前删掉 _turnStartedAtBySession 条目。
    // 生产路径下如果不同步捕获 turnStartedAtSnapshot，这里会让 cap 失效。
    resetTurnPersistState(SESSION);
    await flushWrites();

    const errorCall = vi.mocked(createMessage).mock.calls.find(
      ([, body]) => (body as { role?: string }).role === 'error',
    );
    expect(errorCall).toBeDefined();
    const createdAt = (errorCall![1] as { createdAt?: number }).createdAt;
    // turnStartedAt (1000) <= clearBoundary (2000) → cap 生效
    // createdAt 必须 <= clearBoundaryTs，error 卡不出现在清空后的新会话
    expect(createdAt).toBeLessThanOrEqual(clearBoundaryTs);
  });
});

describe('媒体 echo 兜底:flushOrphanToolResults 从 fallback 池认领', () => {
  const MEDIA_RESULT =
    '{"ok":true,"jobId":"job-echo-lost","xdt_image_urls":["xdt-image://lizi-art-media-images/x.png"]}';

  beforeEach(() => {
    __resetMediaToolResultPoolForTesting();
  });

  it('lizi_mivo tool_use 无 echo → 按 jobId 认领并落库 orphan tool_result', async () => {
    onToolUseEvent(
      SESSION,
      {
        toolUseId: 'tu_media_lost',
        toolName: 'mcp__lizi_mivo__call_tool',
        input: { name: 'poll_result', args: { jobId: 'job-echo-lost' } },
      },
      null,
    );
    recordMediaToolResult({ args: { jobId: 'job-echo-lost' }, resultText: MEDIA_RESULT });
    await flushWrites();
    vi.mocked(createMessage).mockClear();

    flushOrphanToolResults(SESSION, null);
    await flushWrites();
    expect(createMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        role: 'tool_result',
        content: MEDIA_RESULT,
        toolUseId: 'tu_media_lost',
      }),
      broadcastGuard(),
    );
  });

  it('echo 正常到达 → flush 不认领、不产生重复 tool_result', async () => {
    onToolUseEvent(
      SESSION,
      {
        toolUseId: 'tu_media_ok',
        toolName: 'mcp__lizi_mivo__call_tool',
        input: { name: 'poll_result', args: { jobId: 'job-echo-ok' } },
      },
      null,
    );
    recordMediaToolResult({ args: { jobId: 'job-echo-ok' }, resultText: MEDIA_RESULT });
    onToolResultFullEvent(SESSION, { toolUseId: 'tu_media_ok', fullText: MEDIA_RESULT }, null);
    await flushWrites();
    vi.mocked(createMessage).mockClear();

    flushOrphanToolResults(SESSION, null);
    await flushWrites();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('非 lizi 媒体工具的 tool_use 不参与认领', async () => {
    onToolUseEvent(
      SESSION,
      { toolUseId: 'tu_bash', toolName: 'Bash', input: { command: 'ls' } },
      null,
    );
    recordMediaToolResult({ args: { command: 'ls' }, resultText: MEDIA_RESULT });
    await flushWrites();
    vi.mocked(createMessage).mockClear();

    flushOrphanToolResults(SESSION, null);
    await flushWrites();
    expect(createMessage).not.toHaveBeenCalled();
  });
});
