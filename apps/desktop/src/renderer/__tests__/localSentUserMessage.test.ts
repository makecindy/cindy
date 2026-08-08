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

const enqueue = vi.fn(
  async (sessionId: string, item: AgentInputQueuedMessage): Promise<AgentInputProjection> => ({
    sessionId,
    pendingQueue: [item],
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
  }),
);

const retryLastError = vi.fn(async (sessionId: string): Promise<AgentInputProjection> => ({
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
}));

let messageCreatedHandler: ((payload: unknown) => void) | null = null;

function installElectronBridge(): void {
  messageCreatedHandler = null;
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
        onCreated: vi.fn((cb: (payload: unknown) => void) => {
          messageCreatedHandler = cb;
          return vi.fn();
        }),
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

  // review P1: 人工 Retry 的克隆重发行由 main 以新 clientId 落库，发送侧登记不到；
  // renderer 在点击时记基线，此后第一条新 user 消息按本端发送认领（一次性）。
  it('人工 Retry 后的克隆 user 行按本端发送认领，且只认领一次', async () => {
    const sid = `retry-${Math.random().toString(36).slice(2, 8)}`;

    makerChatStore.initGlobalListeners();
    messageCreatedHandler?.({
      sessionId: sid,
      message: {
        id: 'm-1',
        clientId: 'orig-user',
        sessionId: sid,
        role: 'user',
        content: 'failed text',
        toolUseId: null,
        agentMeta: null,
        createdAt: '2026-06-07T00:00:00.000Z',
      },
    });

    await makerChatStore.retryLastError(sid);
    await flushPromises();
    expect(retryLastError).toHaveBeenCalledTimes(1);

    // 基线消息本身不被误领（渲染期对既有末尾消息的查询不消费标记）。
    expect(makerChatStore.isLocalSentUserMessage(sid, 'orig-user')).toBe(false);
    // main 以新 clientId 落库的克隆行 → 认领为本端意图，消费后失效。
    expect(makerChatStore.isLocalSentUserMessage(sid, 'retry-clone')).toBe(true);
    expect(makerChatStore.isLocalSentUserMessage(sid, 'later-im-message')).toBe(false);
  });
});
