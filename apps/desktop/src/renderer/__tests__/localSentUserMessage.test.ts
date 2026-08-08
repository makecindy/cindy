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
  opts?: { supersedesUserClientId?: string },
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

function installElectronBridge(): void {
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  if (!w.window) w.window = {};
  w.window.electronAPI = {
    maker: {
      input: { enqueue, retryLastError },
      onInputProjection: vi.fn(() => vi.fn()),
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
});
