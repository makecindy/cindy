/**
 * localSentUserMessage.test.ts
 * ---------------------------------------------------------------------------
 * #2194: MessageStream 的「末尾新 user 消息强制回底」只应响应本端 composer
 * 发出的消息。makerChatStore 在 sendMessageCore / steerMessageCore 登记本端
 * 发送的 clientId，外部入口（IM 渠道 / 手机端 device-link / 定时任务）注入
 * 的 user 消息不在集合中，按普通新内容处理。
 *
 * 这里锁定 store 侧契约：本端发送可查到、未知（外部注入）clientId 查不到、
 * purge 后标记随会话清除。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentInputProjection,
  AgentInputQueuedMessage,
} from '../../shared/agentInputQueue';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => ({ items: [], hasMore: false, oldestId: null })),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  touchUserSend: vi.fn(async () => {}),
  update: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => 'test user prompt',
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
import * as sessionService from '@/lib/sessionService';

const MODEL = 'claude-opus-4-7';
const EFFORT = 'medium';
const PERM = 'default';
const WD = 'C:\\workspace';

function projection(
  sessionId: string,
  patch: Partial<AgentInputProjection> = {},
): AgentInputProjection {
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
    credentialSwitchWait: null,
    ...patch,
  };
}

function queuedItem(
  clientId: string,
  text: string,
  opts?: {
    supersedesUserClientId?: string;
    originalSyntheticTrigger?: 'continue';
    autoResume?: boolean;
  },
): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: JSON.stringify({ text, images: [], files: [] }),
    model: MODEL,
    effort: EFFORT,
    permissionMode: PERM,
    workingDir: WD,
    ...(opts?.supersedesUserClientId && {
      supersedesUserClientId: opts.supersedesUserClientId,
    }),
    ...(opts?.originalSyntheticTrigger && {
      originalSyntheticTrigger: opts.originalSyntheticTrigger,
    }),
    ...(opts?.autoResume ? { autoResume: true } : {}),
    chatMessage: {
      clientId,
      role: 'user',
      content: text,
      isStreaming: false,
      createdAt: '2026-06-07T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: WD,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERM,
      userPrompt: 'test user prompt',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
  };
}

const enqueue = vi.fn((sessionId: string, item: AgentInputQueuedMessage) =>
  Promise.resolve(projection(sessionId, { pendingQueue: [item] })),
);

const retryLastError = vi.fn((sessionId: string) => Promise.resolve(projection(sessionId)));

const resume = vi.fn((sessionId: string) => Promise.resolve(projection(sessionId)));

const steer = vi.fn((_sessionId: string, _item: AgentInputQueuedMessage) =>
  Promise.resolve(true),
);

let projectionHandler: ((projection: AgentInputProjection) => void) | null = null;

const onInputProjection = vi.fn((cb: (projection: AgentInputProjection) => void) => {
  projectionHandler = cb;
  return vi.fn();
});

function installElectronBridge(): void {
  projectionHandler = null;
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  if (!w.window) w.window = {};
  w.window.electronAPI = {
    maker: {
      input: { enqueue, retryLastError, resume, steer },
      onInputProjection,
      onEvent: vi.fn(() => vi.fn()),
      onStatusChanged: vi.fn(() => vi.fn()),
      onInteractionRequest: vi.fn(() => vi.fn()),
      onInteractionDismissed: vi.fn(() => vi.fn()),
      send: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      generateTitle: vi.fn(async () => ({ title: 't' })),
      abortSession: vi.fn(async () => {}),
      closeSession: vi.fn(async () => {}),
      listActive: vi.fn(async () => []),
    },
    localDb: {
      messages: {
        onCreated: vi.fn(() => vi.fn()),
      },
    },
    deviceLink: { invoke: vi.fn().mockResolvedValue(undefined) },
  };
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  remoteProjectsStore.clear();
  __resetStickySessionOriginForTest();
  makerChatStore.__teardownGlobalListeners();
  installElectronBridge();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  __resetStickySessionOriginForTest();
});

describe('isLocalSentUserMessage (#2194)', () => {
  it('本端 sendMessage 发出的 user 消息登记为本端发送', async () => {
    const sid = `local-${Math.random().toString(36).slice(2, 8)}`;

    makerChatStore.sendMessage(sid, 'hello', MODEL, EFFORT, PERM, WD);
    await flushPromises();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const item = enqueue.mock.calls[0][1];
    expect(makerChatStore.isLocalSentUserMessage(sid, item.clientId)).toBe(true);
  });

  it('外部入口注入的 user 消息（未知 clientId）不算本端发送', () => {
    const sid = `external-${Math.random().toString(36).slice(2, 8)}`;

    // IM / 手机端 / 定时任务注入的消息不经 sendMessageCore，clientId 不在集合中。
    expect(makerChatStore.isLocalSentUserMessage(sid, 'injected-from-im')).toBe(false);
  });

  it('purgeSession 后本端发送标记随会话清除', async () => {
    const sid = `purge-${Math.random().toString(36).slice(2, 8)}`;

    makerChatStore.sendMessage(sid, 'bye', MODEL, EFFORT, PERM, WD);
    await flushPromises();
    const item = enqueue.mock.calls[0][1];
    expect(makerChatStore.isLocalSentUserMessage(sid, item.clientId)).toBe(true);

    makerChatStore.purgeSession(sid);

    expect(makerChatStore.isLocalSentUserMessage(sid, item.clientId)).toBe(false);
  });

  // review P1（第三轮）: 人工 Retry 的零产出克隆项自带 supersedesUserClientId
  // （仅 manual 非 auto 设置），renderer 按字段直接辨认——不猜队首差分，
  // 异步窗口内混入的外部入队不会被误认。
  it('人工 Retry 的克隆项（带 supersedesUserClientId）按本端发送登记', async () => {
    const sid = `retry-${Math.random().toString(36).slice(2, 8)}`;
    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [queuedItem('retry-clone', 'failed text', { supersedesUserClientId: 'orig-user' })],
      }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();
    expect(retryLastError).toHaveBeenCalledTimes(1);

    expect(makerChatStore.isLocalSentUserMessage(sid, 'retry-clone')).toBe(true);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'injected-from-im')).toBe(false);
  });

  it('Retry 回执里的外部入队项（无 supersedesUserClientId）不被误认', async () => {
    const sid = `retry-race-${Math.random().toString(36).slice(2, 8)}`;
    // Greptile P1 场景：retry 未生成新项，异步窗口内外部消息入队到队首。
    retryLastError.mockResolvedValueOnce(
      projection(sid, { pendingQueue: [queuedItem('external-enqueue', 'from im')] }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'external-enqueue')).toBe(false);
  });

  it('Retry 未生成新项（superseded / no-op）时不做标记', async () => {
    const sid = `retry-noop-${Math.random().toString(36).slice(2, 8)}`;

    // 默认 mock 返回空 pendingQueue——无克隆项，等价 superseded / no-op。
    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'anything')).toBe(false);
  });

  // review P1（第四轮，Greptile）: main 的 drain 可能在 retry 回执 apply 之后、
  // renderer 登记之前抢先消费克隆并推送新投影覆盖 state.pendingQueue——登记
  // 必须读回执自带的投影快照（main 在 scheduleDrain 前同步生成），不能扫
  // 当前 state，否则克隆漏记、重试气泡被按外部消息处理。
  it('drain 抢先消费克隆并覆盖 state 时，仍按回执快照登记克隆', async () => {
    const sid = `retry-drain-${Math.random().toString(36).slice(2, 8)}`;

    makerChatStore.initGlobalListeners();
    expect(projectionHandler).toBeTypeOf('function');

    let resolveRetry!: (p: AgentInputProjection) => void;
    retryLastError.mockImplementationOnce(
      () => new Promise<AgentInputProjection>((res) => (resolveRetry = res)),
    );

    const p = makerChatStore.retryLastError(sid);
    resolveRetry(
      projection(sid, {
        pendingQueue: [
          queuedItem('retry-clone', 'failed text', { supersedesUserClientId: 'orig-user' }),
        ],
      }),
    );
    // 让回执 apply 先跑一拍，再模拟 drain 推送：克隆已被消费，队列空了。
    await Promise.resolve();
    projectionHandler!(projection(sid, { pendingQueue: [] }));
    await p;
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'retry-clone')).toBe(true);
  });

  // Copilot review nit：重复登记同一 clientId 时，旧实现会先无谓逐出最旧 id，
  // 容量掉到 CAP-1、误丢更早的本端发送记录。已存在应直接返回。
  it('重复登记同一 clientId 不会逐出最旧记录（容量守卫）', async () => {
    const sid = `retry-cap-${Math.random().toString(36).slice(2, 8)}`;
    // LOCAL_SENT_IDS_CAP = 200（makerChatStore.ts），借 retry 回执填满。
    for (let i = 0; i < 200; i++) {
      retryLastError.mockResolvedValueOnce(
        projection(sid, {
          pendingQueue: [queuedItem(`clone-${i}`, 't', { supersedesUserClientId: 'orig' })],
        }),
      );
      await makerChatStore.retryLastError(sid);
    }
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'clone-0')).toBe(true);

    // 重复登记 clone-5：不应逐出 clone-0。
    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [queuedItem('clone-5', 't', { supersedesUserClientId: 'orig' })],
      }),
    );
    await makerChatStore.retryLastError(sid);
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'clone-0')).toBe(true);

    // 真正的新 id 仍按 LRU 逐出最旧记录。
    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [queuedItem('clone-new', 't', { supersedesUserClientId: 'orig' })],
      }),
    );
    await makerChatStore.retryLastError(sid);
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'clone-0')).toBe(false);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'clone-new')).toBe(true);
  });

  // Copilot review nit：retry 回执到达前会话已被 purge 时，登记会把
  // localSentUserMessageIds 条目重新创建出来——泄漏，且同 id 会话重建后
  // 旧标记会复活。settle 时会话不存在则直接不登记。
  it('retry 回执到达前会话已 purge 时不登记，会话重建后旧标记不复活', async () => {
    const sid = `retry-purge-${Math.random().toString(36).slice(2, 8)}`;

    let resolveRetry!: (p: AgentInputProjection) => void;
    retryLastError.mockImplementationOnce(
      () => new Promise<AgentInputProjection>((res) => (resolveRetry = res)),
    );

    const p = makerChatStore.retryLastError(sid);
    makerChatStore.purgeSession(sid);
    resolveRetry(
      projection(sid, {
        pendingQueue: [
          queuedItem('retry-clone', 'failed text', { supersedesUserClientId: 'orig-user' }),
        ],
      }),
    );
    await p;
    await flushPromises();

    // 会话重建（一次新发送）后，purge 前那次 retry 的克隆标记不得复活。
    makerChatStore.sendMessage(sid, 'again', MODEL, EFFORT, PERM, WD);
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'retry-clone')).toBe(false);
  });

  // Codex review P1（第八轮）: 本地 UI 触发器（silent-stop「继续」/ 中断横幅
  // 「继续任务」/ Mivo 触发）是本端点击意图——合成行虽不渲染气泡，但点击后
  // 用户要看到续跑产出，必须按本端发送登记以触发强制回底。
  it('本地 UI 触发器（sendUiTrigger）的合成行登记为本端意图', async () => {
    const sid = `uitrigger-${Math.random().toString(36).slice(2, 8)}`;
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      agentKind: 'claude-code',
      sdkSessionId: null,
      fastMode: false,
      workingDir: WD,
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERM,
    } as unknown as Awaited<ReturnType<typeof sessionService.get>>);

    await makerChatStore.sendUiTrigger(sid, '[UI_ACTION_TRIGGER] test');
    await flushPromises();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const item = enqueue.mock.calls[0][1];
    expect(makerChatStore.isLocalSentUserMessage(sid, item.clientId)).toBe(true);
    // 外部注入的 clientId 不受影响。
    expect(makerChatStore.isLocalSentUserMessage(sid, 'injected-from-im')).toBe(false);
  });

  // Codex review P2（第九轮）: queue-head（派发前失败）的人工 Retry 由 main
  // 原样重发既有队首项——无新 clientId、无 supersedesUserClientId。renderer
  // 以点击时刻镜像的 inputRecovery（projection 线上自带字段）取权威 clientId，
  // 回执确认生效（error / recovery 清空）后登记；重载后内存标记丢失时续跑
  // 落库的新行仍能识别为本端意图。
  it('queue-head 人工 Retry 在回执确认生效后登记队首为本端意图', async () => {
    const sid = `retry-qh-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    // 建立 queue-head 失败镜像：队首项 + error + recovery。
    projectionHandler!(
      projection(sid, {
        pendingQueue: [queuedItem('head-1', 'stuck head')],
        error: 'dispatch failed',
        recovery: { kind: 'queue-head', clientId: 'head-1' },
      }),
    );
    // 人工 Retry 生效：error / recovery 清空，队首原样保留（无克隆项）。
    retryLastError.mockResolvedValueOnce(
      projection(sid, { pendingQueue: [queuedItem('head-1', 'stuck head')] }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'head-1')).toBe(true);
  });

  it('queue-head Retry 被 superseded（回执 recovery 未清）时不登记队首', async () => {
    const sid = `retry-qh-super-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [queuedItem('head-2', 'stuck head')],
        error: 'dispatch failed',
        recovery: { kind: 'queue-head', clientId: 'head-2' },
      }),
    );
    // superseded：main 未处理本次 retry，error / recovery 原样保留。
    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [queuedItem('head-2', 'stuck head')],
        error: 'dispatch failed',
        recovery: { kind: 'queue-head', clientId: 'head-2' },
      }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'head-2')).toBe(false);
  });

  it('active-turn 失败时不误标无关队首', async () => {
    const sid = `retry-at-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    // active-turn 失败 + 队首是无关的外部入队消息。
    projectionHandler!(
      projection(sid, {
        pendingQueue: [queuedItem('head-ext', 'from im')],
        error: 'turn failed',
        recovery: { kind: 'active-turn', item: queuedItem('failed-turn', 'original') },
      }),
    );
    // 有产出续跑分支：回执 error / recovery 清空，队首换成隐藏续跑指令。
    retryLastError.mockResolvedValueOnce(
      projection(sid, { pendingQueue: [queuedItem('continue-item', 'continue')] }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'head-ext')).toBe(false);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'continue-item')).toBe(false);
  });

  // Greptile review P1（第十轮）: 并发 drain 抢在 Retry 回执前消费并派发
  // queue-head（recovery 随之清空）时，本次 Retry 实为 superseded——仅凭
  // error / recovery 为空会误登记。真正的 queue-head 重试项在回执快照里
  // 仍在队列（main 同步 getProjection 先于 drain），不在队列即不登记。
  it('queue-head 被并发 drain 抢先消费（回执队列已无该项）时不登记', async () => {
    const sid = `retry-qh-drain-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [queuedItem('head-3', 'stuck head')],
        error: 'dispatch failed',
        recovery: { kind: 'queue-head', clientId: 'head-3' },
      }),
    );
    // 并发 drain 已消费并派发 head-3：回执 error / recovery 为空，但队列空了。
    retryLastError.mockResolvedValueOnce(projection(sid, { pendingQueue: [] }));

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'head-3')).toBe(false);
  });

  // Codex review P1（第十轮）: 有产出人工 Retry 的隐藏续跑指令由 main 生成
  // （originalSyntheticTrigger='continue' 且非 autoResume），合成行渲染 null，
  // 不登记则续跑产出在屏幕外开始。auto 自动续跑不标记。
  it('有产出人工 Retry 的隐藏续跑指令登记为本端意图，auto 续跑不登记', async () => {
    const sid = `retry-cont-${Math.random().toString(36).slice(2, 8)}`;

    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [
          queuedItem('continue-manual', 'continue', { originalSyntheticTrigger: 'continue' }),
        ],
      }),
    );
    await makerChatStore.retryLastError(sid);
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'continue-manual')).toBe(true);

    const sid2 = `retry-cont-auto-${Math.random().toString(36).slice(2, 8)}`;
    retryLastError.mockResolvedValueOnce(
      projection(sid2, {
        pendingQueue: [
          queuedItem('continue-auto', 'continue', {
            originalSyntheticTrigger: 'continue',
            autoResume: true,
          }),
        ],
      }),
    );
    await makerChatStore.retryLastError(sid2);
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid2, 'continue-auto')).toBe(false);
  });

  // Codex review P2（第十一轮）: 暂停队列的「继续」与队列项 steer 也是本端
  // 点击意图——队列可能来自上一次 renderer 生命周期或外部入口，发送侧登记
  // 不到，动作触发时按点击归属补上。
  it('暂停队列「继续」（resumeQueue）生效后登记队首为本端意图', async () => {
    const sid = `resume-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, { pendingQueue: [queuedItem('q1', 'queued')], queuePaused: true }),
    );
    resume.mockResolvedValueOnce(
      projection(sid, { pendingQueue: [queuedItem('q1', 'queued')], queuePaused: false }),
    );

    makerChatStore.resumeQueue(sid);
    await flushPromises();
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'q1')).toBe(true);
  });

  it('resume 未生效（回执仍 paused）时不登记', async () => {
    const sid = `resume-noop-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, { pendingQueue: [queuedItem('q2', 'queued')], queuePaused: true }),
    );
    // 默认 mock 返回 queuePaused: false——这里显式保持 paused，模拟未生效。
    resume.mockResolvedValueOnce(
      projection(sid, { pendingQueue: [queuedItem('q2', 'queued')], queuePaused: true }),
    );

    // 预登记后回执确认未生效需回滚——回执回调链不止 3 个 tick，多刷几轮。
    makerChatStore.resumeQueue(sid);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'q2')).toBe(false);
  });

  it('队列项 steer 成功后登记为本端意图，失败不登记', async () => {
    const sid = `steer-q-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [queuedItem('q3', 'queued'), queuedItem('q4', 'queued too')],
      }),
    );

    steer.mockResolvedValueOnce(true);
    await makerChatStore.steerQueuedMessage(sid, 'q3');
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'q3')).toBe(true);

    steer.mockResolvedValueOnce(false);
    await makerChatStore.steerQueuedMessage(sid, 'q4');
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'q4')).toBe(false);
  });

  // Greptile review P1（第十二轮）: 回执队列里点击前就存在的外部项（例如被
  // main 按文本标记 originalSyntheticTrigger='continue' 的外部入队项）不属于
  // 本次点击的产物——只登记点击后**新出现**的项。
  it('Retry 回执里点击前就存在的外部 continue 项不被误认', async () => {
    const sid = `retry-ext-cont-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [
          queuedItem('ext-continue', 'external continue', { originalSyntheticTrigger: 'continue' }),
        ],
        error: 'turn failed',
      }),
    );
    // 回执：点击前的外部 continue 项仍在 + 本次 retry 的新克隆项。
    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [
          queuedItem('retry-clone-2', 'failed text', { supersedesUserClientId: 'orig' }),
          queuedItem('ext-continue', 'external continue', { originalSyntheticTrigger: 'continue' }),
        ],
      }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'ext-continue')).toBe(false);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'retry-clone-2')).toBe(true);
  });

  // Greptile review P1（第十三轮）: 点击后、回执前由外部入口并发入队的
  // continue 项不在点击快照里（通过「新出现」校验），但 main 的
  // performRetryLastError 把本次续跑指令 unshift 到队首且回执同步生成——
  // 只登记回执队首的 continue 项，队尾的外部并发项不得误认。
  it('Retry 回执里点击后并发入队的外部 continue 项（非队首）不被误认', async () => {
    const sid = `retry-ext-race-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(projection(sid, { pendingQueue: [], error: 'turn failed' }));
    // 回执：队首是 main 为本次点击生成的续跑指令，队尾是点击后并发入队的外部
    // continue 项（同为新出现的 continue 项，只能靠队首位置区分）。
    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [
          queuedItem('continue-manual-2', 'continue', { originalSyntheticTrigger: 'continue' }),
          queuedItem('ext-continue-race', 'external continue', {
            originalSyntheticTrigger: 'continue',
          }),
        ],
      }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'continue-manual-2')).toBe(true);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'ext-continue-race')).toBe(false);
  });

  // Codex review P2（第十三轮）: main 的 resume 在返回 projection 前就会 emit
  // 并 scheduleDrain，队首行可能抢在回执回调前落库——resumeQueue 必须在 IPC
  // 前同步预登记；回执确认未生效或 IPC 失败时回滚。
  it('resumeQueue 在 IPC 回执前同步预登记队首，生效后保留', async () => {
    const sid = `resume-pre-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, { pendingQueue: [queuedItem('q5', 'queued')], queuePaused: true }),
    );
    resume.mockResolvedValueOnce(
      projection(sid, { pendingQueue: [queuedItem('q5', 'queued')], queuePaused: false }),
    );

    makerChatStore.resumeQueue(sid);
    // 回执未到，登记已同步生效（main 的 drain / 落库可能抢在回执前）。
    expect(makerChatStore.isLocalSentUserMessage(sid, 'q5')).toBe(true);

    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'q5')).toBe(true);
  });

  it('resume IPC 失败时回滚预登记', async () => {
    const sid = `resume-rollback-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, { pendingQueue: [queuedItem('q6', 'queued')], queuePaused: true }),
    );
    resume.mockRejectedValueOnce(new Error('ipc down'));

    makerChatStore.resumeQueue(sid);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'q6')).toBe(true);

    // IPC 拒绝 → 回滚。回执回调链不止 3 个 tick，多刷几轮。
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'q6')).toBe(false);
  });

  // Greptile review P1（第十四轮）: retry 被 supersede / no-op 时回执里没有
  // 本次点击的产物——此时并发出现在回执队首的外部 continue 项（如外部入口的
  // steer-fallback 把新项抬到队首）不得误认。生效（resumed）的回执
  // error / recovery 必然双空（main 在 unshift 前同步清掉），据此门控。
  it('Retry 被 supersede（回执 recovery 保留）时队首的外部 continue 项不被误认', async () => {
    const sid = `retry-super-head-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [],
        error: 'turn failed',
        recovery: { kind: 'active-turn', item: queuedItem('failed-turn-x', 'original') },
      }),
    );
    // superseded：main 未处理本次 retry，error / recovery 原样保留；并发窗口里
    // 外部入口的新 continue 项出现在回执队首。
    retryLastError.mockResolvedValueOnce(
      projection(sid, {
        pendingQueue: [
          queuedItem('ext-head-continue', 'external continue', {
            originalSyntheticTrigger: 'continue',
          }),
        ],
        error: 'turn failed',
        recovery: { kind: 'active-turn', item: queuedItem('failed-turn-x', 'original') },
      }),
    );

    await makerChatStore.retryLastError(sid);
    await flushPromises();

    expect(makerChatStore.isLocalSentUserMessage(sid, 'ext-head-continue')).toBe(false);
  });

  // Codex review P2（第十四轮）: queue-head 重试的 clientId 点击时刻已知，而
  // main 的 scheduleDrain 经 queueMicrotask 在返回 projection 前就会跑——重发
  // 的队首行可能抢在回执回调前落库，必须 IPC 前预登记；IPC 失败时回滚。
  it('queue-head Retry 在 IPC 回执前同步预登记，生效后保留', async () => {
    const sid = `retry-qh-pre-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [queuedItem('qh-1', 'stuck head')],
        error: 'dispatch failed',
        recovery: { kind: 'queue-head', clientId: 'qh-1' },
      }),
    );
    retryLastError.mockResolvedValueOnce(
      projection(sid, { pendingQueue: [queuedItem('qh-1', 'stuck head')] }),
    );

    const p = makerChatStore.retryLastError(sid);
    // 回执未到，预登记已同步生效。
    expect(makerChatStore.isLocalSentUserMessage(sid, 'qh-1')).toBe(true);

    await p;
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'qh-1')).toBe(true);
  });

  it('queue-head Retry IPC 失败时回滚预登记', async () => {
    const sid = `retry-qh-rej-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [queuedItem('qh-2', 'stuck head')],
        error: 'dispatch failed',
        recovery: { kind: 'queue-head', clientId: 'qh-2' },
      }),
    );
    retryLastError.mockRejectedValueOnce(new Error('ipc down'));

    const p = makerChatStore.retryLastError(sid);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'qh-2')).toBe(true);

    await expect(p).rejects.toThrow('ipc down');
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'qh-2')).toBe(false);
  });

  // Codex review P1（第十五轮）: active-turn 人工 Retry 的产物由 main 在返回
  // projection 前 scheduleDrain（queueMicrotask）落库，可能抢在 IPC 回执前经
  // onCreated 到达 MessageStream。main 的 emit 先于 drain——凭点击时的一次性
  // 意图在投影事件里同步认领，不等回执。
  it('active-turn Retry 产物在 IPC 回执前经投影事件同步认领', async () => {
    const sid = `retry-intent-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [],
        error: 'turn failed',
        recovery: { kind: 'active-turn', item: queuedItem('failed-turn-y', 'original') },
      }),
    );
    let resolveRetry!: (p: AgentInputProjection) => void;
    retryLastError.mockImplementationOnce(
      () => new Promise<AgentInputProjection>((res) => (resolveRetry = res)),
    );

    const p = makerChatStore.retryLastError(sid);
    // main 的 emit 先于 scheduleDrain：生效投影（error/recovery 清空、队首是
    // 本次续跑指令）在回执 settle 前到达，凭一次性意图同步认领。
    projectionHandler!(
      projection(sid, {
        pendingQueue: [
          queuedItem('continue-fast', 'continue', { originalSyntheticTrigger: 'continue' }),
        ],
      }),
    );
    // 回执尚未 settle，登记已生效。
    expect(makerChatStore.isLocalSentUserMessage(sid, 'continue-fast')).toBe(true);

    resolveRetry(
      projection(sid, {
        pendingQueue: [
          queuedItem('continue-fast', 'continue', { originalSyntheticTrigger: 'continue' }),
        ],
      }),
    );
    await p;
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'continue-fast')).toBe(true);
  });

  it('Retry 意图不被未生效投影（error 仍在）误消费', async () => {
    const sid = `retry-intent-gate-${Math.random().toString(36).slice(2, 8)}`;
    makerChatStore.initGlobalListeners();

    projectionHandler!(
      projection(sid, {
        pendingQueue: [],
        error: 'turn failed',
        recovery: { kind: 'active-turn', item: queuedItem('failed-turn-z', 'original') },
      }),
    );
    let resolveRetry!: (p: AgentInputProjection) => void;
    retryLastError.mockImplementationOnce(
      () => new Promise<AgentInputProjection>((res) => (resolveRetry = res)),
    );

    const p = makerChatStore.retryLastError(sid);
    // 未生效投影：error / recovery 仍在——队首的外部 continue 项不认领，意图保留。
    projectionHandler!(
      projection(sid, {
        pendingQueue: [
          queuedItem('ext-cont-pending', 'external', { originalSyntheticTrigger: 'continue' }),
        ],
        error: 'turn failed',
        recovery: { kind: 'active-turn', item: queuedItem('failed-turn-z', 'original') },
      }),
    );
    expect(makerChatStore.isLocalSentUserMessage(sid, 'ext-cont-pending')).toBe(false);

    // 生效投影到达：认领本次产物，外部项仍不认。
    projectionHandler!(
      projection(sid, {
        pendingQueue: [
          queuedItem('continue-real', 'continue', { originalSyntheticTrigger: 'continue' }),
          queuedItem('ext-cont-pending', 'external', { originalSyntheticTrigger: 'continue' }),
        ],
      }),
    );
    expect(makerChatStore.isLocalSentUserMessage(sid, 'continue-real')).toBe(true);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'ext-cont-pending')).toBe(false);

    resolveRetry(projection(sid, { pendingQueue: [] }));
    await p;
    await flushPromises();
    expect(makerChatStore.isLocalSentUserMessage(sid, 'continue-real')).toBe(true);
  });
});
