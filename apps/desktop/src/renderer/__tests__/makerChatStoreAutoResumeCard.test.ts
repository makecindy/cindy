/**
 * makerChatStoreAutoResumeCard.test.ts
 * ---------------------------------------------------------------------------
 * 中断自愈的两个 renderer 侧呈现，合起来就是「自愈过程在聊天流里可见、红色横幅只留给
 * 最终失败」这条产品约定：
 *
 * 1. **已完成**（`mapServerMessages`）：`agentMeta.autoResume` 的 user 行不渲染气泡，
 *    而是「已自动继续」分隔线。回归点是补发的续跑指令**带 `[UI_ACTION_TRIGGER]` 前缀**，
 *    会先命中合成指令行分支——那条分支若不带 systemCardType，分隔线就被吞掉，用户看到
 *    任务自己接着跑了却没有任何交代。silent-stop 的「继续」没有前缀、走另一条分支，
 *    两者必须投影出同一张卡。
 * 2. **进行中**（`applyInputProjection`）：`autoResumePending` 期间在流末尾挂一条
 *    ephemeral 提示卡且 `error` 保持空；接管结束或错误回落时撤掉。
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

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { EMPTY_SESSION_STATE, handleStreamEvent, makerChatStore } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import type { Message } from '@/lib/ccAgent.types';
import type { ChatMessage } from '@/lib/makerChatStore';
import { CONTINUE_AFTER_ERROR_PROMPT } from '../../shared/interruptedTurn.js';

const inputStop = vi.fn(async () => projection({ queuePaused: false }));
const inputGetProjection = vi.fn<() => Promise<unknown>>(async () =>
  Promise.reject(new Error('n/a in test')),
);

let inputProjectionCb: ((projection: unknown) => void) | null = null;
let makerEventCb: ((payload: unknown) => void) | null = null;
let makerStatusCb: ((payload: unknown) => void) | null = null;

function makeElectronApiStub() {
  const fanOut = () => () => () => {};
  return {
    maker: {
      onEvent: (cb: (payload: unknown) => void) => {
        makerEventCb = cb;
        return () => {
          makerEventCb = null;
        };
      },
      onStatusChanged: (cb: (payload: unknown) => void) => {
        makerStatusCb = cb;
        return () => {
          makerStatusCb = null;
        };
      },
      onInputProjection: (cb: (projection: unknown) => void) => {
        inputProjectionCb = cb;
        return () => {
          inputProjectionCb = null;
        };
      },
      onInteractionRequest: fanOut(),
      onInteractionDismissed: fanOut(),
      input: {
        getProjection: inputGetProjection,
        stop: inputStop,
      },
    },
    localDb: { messages: { onCreated: fanOut() } },
    deviceLink: { onRemotePush: fanOut() },
    onUsageMessageTurnCost: fanOut(),
  };
}

function serverMessage(over: Partial<Message>): Message {
  return {
    id: over.clientId ?? 'id',
    clientId: 'c1',
    sessionId: 'sess',
    role: 'assistant',
    content: 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    ...over,
  } as Message;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const SID = 'auto-resume-card-session';
const PENDING_CARD_ID = '__auto_resume_pending__';
const PENDING_INFO = {
  error: 'API Error: Connection closed mid-response.',
  attempt: 2,
  maxAttempts: 5,
  sessionTotal: 7,
};

/** 一份最小可用的 input projection；只覆盖本测试关心的字段。 */
function projection(over: Record<string, unknown> = {}) {
  return {
    sessionId: SID,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    continuationInFlightClientId: null,
    continuationTurnClientId: null,
    error: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    ...over,
  };
}

/** 旧被控端 wire 形状：字段完全不存在；不能用显式 undefined 伪装（own property 仍存在）。 */
function legacyProjection(over: Record<string, unknown> = {}) {
  const { continuationTurnClientId: _unsupported, ...legacy } = projection(over);
  return legacy;
}

describe('mapServerMessages auto-resume 分隔线', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { electronAPI: makeElectronApiStub() };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    vi.clearAllMocks();
  });

  it('带 [UI_ACTION_TRIGGER] 前缀的自动续跑指令仍投影出「已自动继续」卡', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({
        clientId: 'auto-continue',
        role: 'user',
        content: CONTINUE_AFTER_ERROR_PROMPT,
        agentMeta: {
          autoResume: true,
          delivery: 'turn',
          autoResumeInfo: PENDING_INFO,
        } as Message['agentMeta'],
      }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const row = makerChatStore
      .getSnapshot(SID)
      .messages.find((m) => m.clientId === 'auto-continue');
    expect(row?.systemCardType).toBe('auto-resume');
    expect(row?.systemCardData).toEqual(PENDING_INFO);
    // 原文绝不外泄:合成指令的英文正文既不渲染也不进投影内容。
    expect(row?.content).toBe('');
    expect(row?.isSyntheticTrigger).toBe(true);
  });

  it('silent-stop 的「继续」(无前缀) 投影出同一张卡', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({
        clientId: 'silent-stop-continue',
        role: 'user',
        content: '继续',
        agentMeta: { autoResume: true, delivery: 'turn' } as Message['agentMeta'],
      }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const row = makerChatStore
      .getSnapshot(SID)
      .messages.find((m) => m.clientId === 'silent-stop-continue');
    expect(row?.systemCardType).toBe('auto-resume');
    expect(row?.content).toBe('');
  });

  it('人工发的合成指令(无 autoResume)不渲染分隔线,只静默占位', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      serverMessage({
        clientId: 'manual-continue',
        role: 'user',
        content: CONTINUE_AFTER_ERROR_PROMPT,
        agentMeta: { delivery: 'turn' } as Message['agentMeta'],
      }),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const row = makerChatStore
      .getSnapshot(SID)
      .messages.find((m) => m.clientId === 'manual-continue');
    expect(row?.isSyntheticTrigger).toBe(true);
    expect(row?.systemCardType).toBeUndefined();
  });
});

describe('applyInputProjection 自愈进行中提示', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { electronAPI: makeElectronApiStub() };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    inputProjectionCb = null;
    makerEventCb = null;
    makerStatusCb = null;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('autoResumePending 时在流末尾插一条 ephemeral 提示卡,且不弹错误', () => {
    expect(inputProjectionCb).toBeTruthy();
    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));

    const snapshot = makerChatStore.getSnapshot(SID);
    const card = snapshot.messages.find((m) => m.clientId === PENDING_CARD_ID);
    expect(card?.systemCardType).toBe('auto-resume-pending');
    expect(card?.content).toBe('');
    // 展示信息进 systemCardData:活动行据此显示进度与展开详情。
    expect(card?.systemCardData).toEqual(PENDING_INFO);
    // 自愈期间红横幅必须是空的 —— 这正是本次交互改动的核心。
    expect(snapshot.error).toBeNull();
  });

  it('进度更新时同一张卡的 systemCardData 必须跟着变(1/5 → 2/5)', () => {
    inputProjectionCb!(projection({ autoResumePending: { ...PENDING_INFO, attempt: 1 } }));
    const first = makerChatStore
      .getSnapshot(SID)
      .messages.find((m) => m.clientId === PENDING_CARD_ID);
    expect((first?.systemCardData as { attempt?: number } | undefined)?.attempt).toBe(1);

    inputProjectionCb!(projection({ autoResumePending: { ...PENDING_INFO, attempt: 2 } }));
    const rows = makerChatStore.getSnapshot(SID).messages;
    expect(rows.filter((m) => m.clientId === PENDING_CARD_ID)).toHaveLength(1);
    const second = rows.find((m) => m.clientId === PENDING_CARD_ID);
    expect(
      (second?.systemCardData as { attempt?: number } | undefined)?.attempt,
      '卡已存在时也要写回最新进度,否则永远停在第一次',
    ).toBe(2);
  });

  it('重复投递同一接管态不会插出第二张卡(固定 clientId 保证幂等)', () => {
    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));
    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));

    const cards = makerChatStore
      .getSnapshot(SID)
      .messages.filter((m) => m.clientId === PENDING_CARD_ID);
    expect(cards).toHaveLength(1);
  });

  it('重复投影同一条相对时间限额错误时复用首次解析结果', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T10:00:00.000Z'));
    const error = 'Usage limit reached. Try again in 1h.';

    inputProjectionCb!(projection({ error }));
    const first = makerChatStore.getSnapshot(SID).usageLimitRecovery;
    expect(first?.resetAtMs).toBe(Date.parse('2026-01-24T11:00:00.000Z'));

    vi.setSystemTime(new Date('2026-01-24T10:15:00.000Z'));
    inputProjectionCb!(projection({ error }));
    const second = makerChatStore.getSnapshot(SID).usageLimitRecovery;

    expect(second).toBe(first);
    expect(second?.resetAtMs).toBe(Date.parse('2026-01-24T11:00:00.000Z'));
  });

  it('接管结束后撤掉提示卡', () => {
    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));
    expect(
      makerChatStore.getSnapshot(SID).messages.some((m) => m.clientId === PENDING_CARD_ID),
    ).toBe(true);

    inputProjectionCb!(projection());

    expect(
      makerChatStore.getSnapshot(SID).messages.some((m) => m.clientId === PENDING_CARD_ID),
    ).toBe(false);
  });

  it('无关 projection 不误删原生重连行,接管 projection 到达时才交棒', () => {
    makerEventCb?.({
      sessionId: SID,
      event: {
        type: 'error',
        source: 'codex',
        data: { message: 'Reconnecting... 1/5', isTerminal: false, willRetry: true },
      },
    });
    expect(
      makerChatStore
        .getSnapshot(SID)
        .messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(true);

    inputProjectionCb!(projection());
    expect(
      makerChatStore
        .getSnapshot(SID)
        .messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
      '普通队列 projection 不应打断仍在进行的原生重连',
    ).toBe(true);

    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));
    const rows = makerChatStore.getSnapshot(SID).messages;
    expect(rows.some((m) => m.clientId === '__codex_reconnect_pending__')).toBe(false);
    expect(rows.some((m) => m.clientId === PENDING_CARD_ID)).toBe(true);
  });

  it('credentialSwitchWait projection 会收掉原生重连行', () => {
    makerEventCb?.({
      sessionId: SID,
      event: {
        type: 'error',
        source: 'codex',
        data: { message: 'Reconnecting... 1/5', isTerminal: false, willRetry: true },
      },
    });
    expect(
      makerChatStore
        .getSnapshot(SID)
        .messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(true);

    inputProjectionCb!(
      projection({ credentialSwitchWait: { clientId: 'queued-1', blockedBySessionIds: [SID] } }),
    );

    const snapshot = makerChatStore.getSnapshot(SID);
    expect(snapshot.credentialSwitchWait).toEqual({
      clientId: 'queued-1',
      blockedBySessionIds: [SID],
    });
    expect(
      snapshot.messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(false);
  });

  it('Stop 会同步撤掉原生重连活动行', () => {
    makerEventCb?.({
      sessionId: SID,
      event: {
        type: 'error',
        source: 'codex',
        data: { message: 'Reconnecting... 1/5', isTerminal: false, willRetry: true },
      },
    });
    expect(
      makerChatStore
        .getSnapshot(SID)
        .messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(true);

    makerChatStore.stopSession(SID);

    expect(
      makerChatStore
        .getSnapshot(SID)
        .messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(false);
  });

  it('status=closed 即使缺少 done 也会撤掉 Cindy 接管活动行', () => {
    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));
    expect(
      makerChatStore.getSnapshot(SID).messages.some((m) => m.clientId === PENDING_CARD_ID),
    ).toBe(true);

    makerStatusCb?.({ sessionId: SID, status: 'closed' });

    expect(
      makerChatStore.getSnapshot(SID).messages.some((m) => m.clientId === PENDING_CARD_ID),
    ).toBe(false);
  });

  it('救不回来时错误回落成横幅,提示卡同时撤掉', () => {
    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));
    inputProjectionCb!(
      projection({ error: 'API Error: Connection closed mid-response.', errorRetryText: null }),
    );

    const snapshot = makerChatStore.getSnapshot(SID);
    expect(snapshot.messages.some((m) => m.clientId === PENDING_CARD_ID)).toBe(false);
    expect(snapshot.error).toBe('API Error: Connection closed mid-response.');
  });
});

describe('Codex 原生重连进行态与终态接管交棒', () => {
  const reconnectEvent = (message: string, isTerminal: boolean) => ({
    sessionId: SID,
    type: 'error' as const,
    source: 'codex' as const,
    data: {
      message,
      isTerminal,
      willRetry: !isTerminal,
    },
  });
  const stateWithCindyPending = (error = PENDING_INFO.error) => {
    const pendingCard = {
      ...serverMessage({
        clientId: PENDING_CARD_ID,
        content: '',
      }),
      systemCardType: 'auto-resume-pending' as const,
      systemCardData: { ...PENDING_INFO, error },
    } as ChatMessage;
    return {
      ...EMPTY_SESSION_STATE,
      messages: [pendingCard],
    };
  };

  it('Reconnecting N/M 原地更新到灰色活动行,正常事件到达后撤掉', () => {
    const first = handleStreamEvent(
      EMPTY_SESSION_STATE,
      reconnectEvent('Reconnecting... 1/5', false),
    );
    const firstCard = first.messages.find((m) => m.clientId === '__codex_reconnect_pending__');
    expect(firstCard?.systemCardType).toBe('auto-resume-pending');
    expect(firstCard?.systemCardData).toEqual({ attempt: 1, maxAttempts: 5 });
    expect(first.recoverableError).toBeNull();

    const second = handleStreamEvent(first, reconnectEvent('Reconnecting... 2/5', false));
    const cards = second.messages.filter((m) => m.clientId === '__codex_reconnect_pending__');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.systemCardData).toMatchObject({ attempt: 2, maxAttempts: 5 });
    expect(cards[0]?.createdAt).toBe(firstCard?.createdAt);

    const recovered = handleStreamEvent(second, {
      sessionId: SID,
      type: 'text',
      data: { text: '继续工作', isFinal: false },
    });
    expect(recovered.messages.some((m) => m.clientId === '__codex_reconnect_pending__')).toBe(
      false,
    );
  });

  it('重连期间无关任务更新和工具结果不会提前清除原生活动行', () => {
    const reconnecting = handleStreamEvent(
      EMPTY_SESSION_STATE,
      reconnectEvent('Reconnecting... 1/5', false),
    );
    const withTaskUpdate = handleStreamEvent(reconnecting, {
      sessionId: SID,
      type: 'agent_task_update',
      source: 'codex',
      data: { provider: 'codex', taskId: 'task-1', status: 'running' },
    });
    const withToolResult = handleStreamEvent(withTaskUpdate, {
      sessionId: SID,
      type: 'tool_result',
      source: 'codex',
      data: { toolUseIds: ['tool-1'] },
    });

    expect(withToolResult.messages.some((m) => m.clientId === '__codex_reconnect_pending__')).toBe(
      true,
    );
  });

  it('协作子代理的 collab tool_use 不会提前清除原生活动行', () => {
    const reconnecting = handleStreamEvent(
      EMPTY_SESSION_STATE,
      reconnectEvent('Reconnecting... 1/5', false),
    );
    const withCollabTool = handleStreamEvent(reconnecting, {
      sessionId: SID,
      type: 'tool_use',
      source: 'codex',
      data: { toolUseId: 'tool-1', toolName: 'collab:spawn', input: { task: '审查' } },
    });

    expect(
      withCollabTool.messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(true);
  });

  it('普通根 turn tool_use 仍会清除原生活动行', () => {
    const reconnecting = handleStreamEvent(
      EMPTY_SESSION_STATE,
      reconnectEvent('Reconnecting... 1/5', false),
    );
    const withRootTool = handleStreamEvent(reconnecting, {
      sessionId: SID,
      type: 'tool_use',
      source: 'codex',
      data: { toolUseId: 'tool-1', toolName: 'shell', input: { command: 'pwd' } },
    });

    expect(
      withRootTool.messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(false);
  });

  it('带 turnContinuationId 的 done 不会清除原生活动行', () => {
    const reconnecting = handleStreamEvent(
      EMPTY_SESSION_STATE,
      reconnectEvent('Reconnecting... 1/5', false),
    );
    const withContinuationDone = handleStreamEvent(reconnecting, {
      sessionId: SID,
      type: 'done',
      data: { reason: 'foreground-done' },
      turnContinuationId: 1,
    });

    expect(
      withContinuationDone.messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(true);
    expect(withContinuationDone.isStreaming).toBe(true);
    expect(withContinuationDone.agentStatus.isRunning).toBe(true);
  });

  it.each([
    ['认证', 'Reconnecting... 1/5 (401 Missing bearer)', { errorStatus: 401 }, /missing bearer/i],
    [
      '额度',
      'Reconnecting... 1/5 (rate limit)',
      { usageLimit: true, errorStatus: 429 },
      /rate limit/i,
    ],
  ])('无关任务更新不会吞掉%s类可操作错误', (_label, message, extra, expected) => {
    const event = reconnectEvent(message, false);
    const actionable = handleStreamEvent(EMPTY_SESSION_STATE, {
      ...event,
      data: { ...event.data, ...extra },
    });
    const afterTaskUpdate = handleStreamEvent(actionable, {
      sessionId: SID,
      type: 'agent_task_update',
      source: 'codex',
      data: { provider: 'codex', taskId: 'task-1', status: 'running' },
    });

    expect(afterTaskUpdate.recoverableError).toMatch(expected);
  });

  it('已有 Cindy 接管活动行时,迟到的非终态重连继续保持接管态', () => {
    const next = handleStreamEvent(
      stateWithCindyPending(),
      reconnectEvent('Reconnecting... 4/5', false),
    );
    expect(next.error).toBeNull();
    expect(next.recoverableError).toBeNull();
    expect(next.messages.some((m) => m.clientId === PENDING_CARD_ID)).toBe(true);
    expect(next.messages.some((m) => m.clientId === '__codex_reconnect_pending__')).toBe(false);
    expect(next.isStreaming).toBe(false);
    expect(next.agentStatus.isRunning).toBe(false);
  });

  it('认证和额度类非终态重连保留可操作错误,不伪装成灰色活动行', () => {
    const authEvent = reconnectEvent('Reconnecting... 1/5 (401 Missing bearer)', false);
    const authNext = handleStreamEvent(EMPTY_SESSION_STATE, {
      ...authEvent,
      data: { ...authEvent.data, errorStatus: 401 },
    });
    expect(authNext.messages.some((m) => m.clientId === '__codex_reconnect_pending__')).toBe(false);
    expect(authNext.recoverableError).toContain('Missing bearer');

    const usageEvent = reconnectEvent('Reconnecting... 1/5 (rate limit)', false);
    const usageNext = handleStreamEvent(EMPTY_SESSION_STATE, {
      ...usageEvent,
      data: { ...usageEvent.data, usageLimit: true, errorStatus: 429 },
    });
    expect(usageNext.messages.some((m) => m.clientId === '__codex_reconnect_pending__')).toBe(
      false,
    );
    expect(usageNext.recoverableError).toContain('rate limit');

    const stringStatusNext = handleStreamEvent(EMPTY_SESSION_STATE, {
      ...reconnectEvent('Reconnecting... 1/5', false),
      data: {
        ...reconnectEvent('Reconnecting... 1/5', false).data,
        status: '401',
      },
    });
    expect(
      stringStatusNext.messages.some((m) => m.clientId === '__codex_reconnect_pending__'),
    ).toBe(false);
    expect(stringStatusNext.recoverableError).toContain('Reconnecting');
  });

  it('已有 Cindy 接管活动行时,随后到达的终态 maker:event 不再点亮红 banner', () => {
    const message =
      'Codex backend unreachable — the daemon retried 4 times over 133s without success (last error: "Reconnecting... 3/5").';
    const next = handleStreamEvent(stateWithCindyPending(message), reconnectEvent(message, true));
    expect(next.error).toBeNull();
    expect(next.recoverableError).toBeNull();
    expect(next.messages.some((m) => m.clientId === PENDING_CARD_ID)).toBe(true);
  });

  it.each([
    [
      'codex reconnect stall',
      'Codex app-server has been reconnecting for 120s without making progress.',
      'codex_reconnect_stalled',
    ],
    ['network timeout', 'Request timed out', undefined],
    ['service unavailable', '503 Service Unavailable', undefined],
    ['upstream overload', 'Selected model is at capacity', 'upstream-overload'],
  ])('已有 Cindy 接管活动行时,%s 的终态广播保持灰色接管态', (_label, message, reason) => {
    const event = reconnectEvent(message, true);
    const next = handleStreamEvent(stateWithCindyPending(message), {
      ...event,
      data: { ...event.data, ...(reason ? { reason } : {}) },
    });
    expect(next.error).toBeNull();
    expect(next.messages.some((m) => m.clientId === PENDING_CARD_ID)).toBe(true);
  });

  it('残留接管卡不会吞掉正文不匹配的新网络终态错误', () => {
    const next = handleStreamEvent(
      stateWithCindyPending('Request timed out'),
      reconnectEvent('503 Service Unavailable', true),
    );
    expect(next.error).toContain('503 Service Unavailable');
    expect(next.messages.some((m) => m.clientId === PENDING_CARD_ID)).toBe(false);
  });

  it('残留接管卡不能吞掉新的认证终态错误', () => {
    const next = handleStreamEvent(stateWithCindyPending(), {
      ...reconnectEvent('Codex authentication failed: Missing bearer token.', true),
      data: {
        ...reconnectEvent('Codex authentication failed: Missing bearer token.', true).data,
        errorStatus: 401,
      },
    });
    expect(next.error).toMatch(/missing bearer/i);
    expect(next.messages.some((m) => m.clientId === PENDING_CARD_ID)).toBe(false);
  });

  it('终态错误之后的迟到非终态重连不会重新创建活动行或点亮 running', () => {
    const terminal = handleStreamEvent(
      EMPTY_SESSION_STATE,
      reconnectEvent('Codex backend unreachable — retry budget exhausted.', true),
    );
    const late = handleStreamEvent(terminal, reconnectEvent('Reconnecting... 5/5', false));
    expect(late.error).toContain('Codex backend unreachable');
    expect(late.messages.some((m) => m.clientId === '__codex_reconnect_pending__')).toBe(false);
    expect(late.isStreaming).toBe(false);
    expect(late.agentStatus.isRunning).toBe(false);
  });

  it('没有 Cindy 接管活动行时,同一终态仍回落红 banner', () => {
    const next = handleStreamEvent(
      EMPTY_SESSION_STATE,
      reconnectEvent('Codex backend unreachable — retry budget exhausted.', true),
    );
    expect(next.error).toContain('Codex backend unreachable');
  });
});

// Main now owns the vendor-turn continuation identity; Renderer mirrors it without a sticky seen marker.
describe('续跑边界投影能力与 vendor turn owner', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { electronAPI: makeElectronApiStub() };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
  });

  it('尚未收到投影时 capability=unknown，owner 为 null', () => {
    const snap = makerChatStore.getSnapshot(SID);
    expect(snap.continuationInFlightProjectionCapability).toBe('unknown');
    expect(snap.continuationTurnClientId).toBeNull();
  });

  it('新版显式 null 与非空 owner 都标记 supported，并原样镜像', () => {
    inputProjectionCb!(projection());
    let snap = makerChatStore.getSnapshot(SID);
    expect(snap.continuationInFlightProjectionCapability).toBe('supported');
    expect(snap.continuationTurnClientId).toBeNull();

    inputProjectionCb!(projection({ continuationTurnClientId: 'resume-1' }));
    snap = makerChatStore.getSnapshot(SID);
    expect(snap.continuationInFlightProjectionCapability).toBe('supported');
    expect(snap.continuationTurnClientId).toBe('resume-1');
  });

  it('owner 变回 null 时同步清除，不保留跨 turn 记忆', () => {
    inputProjectionCb!(projection({ continuationTurnClientId: 'resume-1' }));
    inputProjectionCb!(projection({ continuationTurnClientId: null }));
    const snap = makerChatStore.getSnapshot(SID);
    expect(snap.continuationTurnClientId).toBeNull();
  });

  it('字段完全缺省(旧被控端)→ capability=legacy', () => {
    inputProjectionCb!(legacyProjection());
    const snap = makerChatStore.getSnapshot(SID);
    expect(snap.continuationInFlightProjectionCapability).toBe('legacy');
    expect(snap.continuationTurnClientId).toBeNull();
  });

  it('同一会话的被控端升级后，显式字段会从 legacy 前进到 supported', () => {
    inputProjectionCb!(legacyProjection());
    inputProjectionCb!(projection({ continuationTurnClientId: null }));
    expect(makerChatStore.getSnapshot(SID).continuationInFlightProjectionCapability).toBe(
      'supported',
    );
  });

  it('done 终态清 owner后，迟到旧 projection 不能重新点亮转圈', async () => {
    const staleQuery = deferred<unknown>();
    inputGetProjection.mockImplementationOnce(() => staleQuery.promise);

    inputProjectionCb!(projection({ continuationTurnClientId: 'resume-1' }));
    makerChatStore.ensureInitialMessages(SID);
    makerChatStore.__applyStreamEventForTest(SID, {
      sessionId: SID,
      type: 'done',
      data: {},
    } as CCAgentStreamEvent);
    expect(makerChatStore.getSnapshot(SID).continuationTurnClientId).toBeNull();

    staleQuery.resolve(projection({ continuationTurnClientId: 'resume-stale' }));
    await flush();
    expect(makerChatStore.getSnapshot(SID).continuationTurnClientId).toBeNull();
  });

  it('Stop 立即清除续跑 owner，迟到旧 projection 不能重新点亮转圈', async () => {
    const staleQuery = deferred<unknown>();
    inputGetProjection.mockImplementationOnce(() => staleQuery.promise);

    // 先用普通 projection 建立 owner，再发起悬挂查询；这样测试不会依靠查询之后的
    // push 顺带推进 epoch，必须由 Stop 自己同步作废该查询。
    inputProjectionCb!(projection({ continuationTurnClientId: 'resume-1' }));
    makerChatStore.ensureInitialMessages(SID);
    expect(makerChatStore.getSnapshot(SID).continuationTurnClientId).toBe('resume-1');

    inputStop.mockResolvedValueOnce(projection({ queueExpanded: true }));
    makerChatStore.stopSession(SID);
    expect(makerChatStore.getSnapshot(SID).continuationTurnClientId).toBeNull();

    staleQuery.resolve(projection({ continuationTurnClientId: 'resume-stale' }));
    await flush();
    const snapshot = makerChatStore.getSnapshot(SID);
    expect(snapshot.continuationTurnClientId).toBeNull();
    // Stop 自己的响应属于推进后的新 authority 代际，不能被一并误杀。
    expect(snapshot.queueExpanded).toBe(true);
  });
});

describe('同一次中断事件的多次重连折叠成一行', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { electronAPI: makeElectronApiStub() };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    inputProjectionCb = null;
    vi.clearAllMocks();
  });

  const resumeRow = (
    clientId: string,
    attempt: number,
    outcome?: 'succeeded' | 'failed',
    at = '2026-06-12T00:00:0',
  ) =>
    serverMessage({
      clientId,
      role: 'user',
      content: CONTINUE_AFTER_ERROR_PROMPT,
      createdAt: `${at}${attempt}.000Z`,
      agentMeta: {
        autoResume: true,
        delivery: 'turn',
        autoResumeInfo: { error: 'boom', attempt, maxAttempts: 5, sessionTotal: attempt },
        ...(outcome ? { autoResumeOutcome: outcome } : {}),
      } as Message['agentMeta'],
    });

  it('连续三次重连只渲染最后一条(带最新计数),前两条退回隐藏占位', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      resumeRow('r1', 1, 'failed'),
      resumeRow('r2', 2, 'failed'),
      resumeRow('r3', 3),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const rows = makerChatStore.getSnapshot(SID).messages;
    const cards = rows.filter((m) => m.systemCardType === 'auto-resume');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.clientId).toBe('r3');
    expect((cards[0]?.systemCardData as { attempt?: number } | undefined)?.attempt).toBe(3);
    // 被折叠的两条仍在消息流里占位(参与时序),只是不渲染卡。
    for (const clientId of ['r1', 'r2']) {
      const row = rows.find((m) => m.clientId === clientId);
      expect(row?.systemCardType).toBeUndefined();
      expect(row?.isSyntheticTrigger).toBe(true);
    }
  });

  it('中间有模型产出时不折叠(那是两次独立的中断)', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([
      resumeRow('r1', 1, 'succeeded'),
      serverMessage({
        clientId: 'a1',
        role: 'assistant',
        content: '接着干活',
        createdAt: '2026-06-12T00:00:05.000Z',
      }),
      resumeRow('r2', 1, undefined, '2026-06-12T00:00:1'),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const cards = makerChatStore
      .getSnapshot(SID)
      .messages.filter((m) => m.systemCardType === 'auto-resume');
    expect(cards.map((m) => m.clientId)).toEqual(['r1', 'r2']);
  });

  it('中间只有 thinking 时仍折叠(main 也把它算在同一段里)', async () => {
    // 折叠边界必须与 main 的产出判据同语义(isSubstantiveProgressEvent:实义文本 / 工具调用,
    // thinking 不算)。不一致的话:开了 reasoning 的重连只吐 thinking 就再次失败时,main 记
    // attempt 2/5 属同一段,UI 却把卡片拆成两行(codex P1)。空白文本同理。
    vi.mocked(messageService.list).mockResolvedValueOnce([
      resumeRow('r1', 1, 'failed'),
      serverMessage({
        clientId: 't1',
        role: 'thinking',
        content: '在想怎么接着做',
        createdAt: '2026-06-12T00:00:05.000Z',
      }),
      serverMessage({
        clientId: 'ws1',
        role: 'assistant',
        // 纯空白 + 零宽字符:两者都是"用户看不见",都不该成为折叠边界(greptile P2)。
        content: '   \n \u200B\uFEFF ',
        createdAt: '2026-06-12T00:00:06.000Z',
      }),
      resumeRow('r2', 2, undefined, '2026-06-12T00:00:1'),
    ]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    const cards = makerChatStore
      .getSnapshot(SID)
      .messages.filter((m) => m.systemCardType === 'auto-resume');
    expect(
      cards.map((m) => m.clientId),
      '同一次中断只该留最新那一行',
    ).toEqual(['r2']);
  });

  it('进行中的 ephemeral 行会盖掉它前面那条已落库的重连行', async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce([resumeRow('r1', 1, 'failed')]);
    makerChatStore.ensureInitialMessages(SID);
    await flush();
    await flush();

    inputProjectionCb!(projection({ autoResumePending: PENDING_INFO }));

    const rows = makerChatStore.getSnapshot(SID).messages;
    const cards = rows.filter(
      (m) => m.systemCardType === 'auto-resume' || m.systemCardType === 'auto-resume-pending',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.clientId).toBe(PENDING_CARD_ID);
    expect(rows.find((m) => m.clientId === 'r1')?.systemCardType).toBeUndefined();
  });
});
