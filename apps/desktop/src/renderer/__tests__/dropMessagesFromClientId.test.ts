/**
 * dropMessagesFromClientId.test.ts
 * ---------------------------------------------------------------------------
 * edit-last-message: store 级内存裁剪的契约。
 *
 * dropMessagesFromClientId 必须镜像后端 rewind.commit 事务的软删语义:从
 * target clientId(含)裁到尾;clientId 不在列表时严格 no-op(状态引用不变,
 * 不触发订阅方重渲)。harness 复用 pendingQueueDefer.test.ts 的桥接假件,
 * 消息经 localDb onCreated 广播喂入(与生产同路径)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let messageCreatedHandler: ((payload: unknown) => void) | null = null;
let messageDeletedHandler: ((payload: unknown) => void) | null = null;
let makerEventHandler: ((payload: unknown) => void) | null = null;

function installElectronBridge(): void {
  messageCreatedHandler = null;
  messageDeletedHandler = null;
  makerEventHandler = null;
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  if (!w.window) w.window = {};
  w.window.electronAPI = {
    maker: {
      input: {},
      onInputProjection: vi.fn(() => vi.fn()),
      onEvent: vi.fn((cb: (payload: unknown) => void) => {
        makerEventHandler = cb;
        return vi.fn();
      }),
      onStatusChanged: vi.fn(() => vi.fn()),
      onInteractionRequest: vi.fn(() => vi.fn()),
      onInteractionDismissed: vi.fn(() => vi.fn()),
      listActive: vi.fn(async () => []),
    },
    localDb: {
      messages: {
        onCreated: vi.fn((cb: (payload: unknown) => void) => {
          messageCreatedHandler = cb;
          return vi.fn();
        }),
        onDeleted: vi.fn((cb: (payload: unknown) => void) => {
          messageDeletedHandler = cb;
          return vi.fn();
        }),
      },
    },
  };
}

function seedMessage(
  sessionId: string,
  clientId: string,
  role: 'user' | 'assistant',
  createdAt: string,
): void {
  messageCreatedHandler?.({
    sessionId,
    message: {
      id: `row-${clientId}`,
      clientId,
      sessionId,
      role,
      content: `content of ${clientId}`,
      toolUseId: null,
      agentMeta: null,
      createdAt,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  makerChatStore.__teardownGlobalListeners();
  installElectronBridge();
  makerChatStore.initGlobalListeners();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
});

function seedConversation(sid: string): void {
  seedMessage(sid, 'u1', 'user', '2026-07-01T00:00:00.000Z');
  seedMessage(sid, 'a1', 'assistant', '2026-07-01T00:00:01.000Z');
  seedMessage(sid, 'u2', 'user', '2026-07-01T00:00:02.000Z');
  seedMessage(sid, 'a2', 'assistant', '2026-07-01T00:00:03.000Z');
}

function seedTaskUpdate(sid: string, taskId: string): void {
  makerEventHandler?.({
    sessionId: sid,
    event: {
      type: 'agent_task_update',
      source: 'claude-code',
      data: { taskId, status: 'running', description: 'subagent working' },
    },
  });
}

describe('makerChatStore.dropMessagesFromClientId', () => {
  it('整轮删除推送一次移除全部 AI 行，并清掉关联 task update', () => {
    const sid = `delete-${Math.random().toString(36).slice(2, 8)}`;
    seedConversation(sid);
    seedTaskUpdate(sid, 'a1');

    messageDeletedHandler?.({
      sessionId: sid,
      clientId: 'a2',
      clientIds: ['a1', 'a2'],
    });

    const snap = makerChatStore.getSnapshot(sid);
    expect(snap.messages.map((message) => message.clientId)).toEqual(['u1', 'u2']);
    expect(snap.taskUpdates?.size ?? 0).toBe(0);
  });

  it('被删消息不在当前窗口时仍清掉同 id 的孤儿 task update', () => {
    const sid = `delete-orphan-${Math.random().toString(36).slice(2, 8)}`;
    seedConversation(sid);
    seedTaskUpdate(sid, 'orphan-task');
    const beforeClientIds = makerChatStore
      .getSnapshot(sid)
      .messages.map((message) => message.clientId);

    messageDeletedHandler?.({
      sessionId: sid,
      clientId: 'orphan-task',
      clientIds: ['orphan-task'],
    });

    const snap = makerChatStore.getSnapshot(sid);
    expect(snap.messages.map((message) => message.clientId)).toEqual(beforeClientIds);
    expect(snap.taskUpdates?.size ?? 0).toBe(0);
  });

  it('从 target clientId(含)裁到尾 — 镜像 rewind.commit 的软删范围', () => {
    const sid = `drop-${Math.random().toString(36).slice(2, 8)}`;
    seedConversation(sid);
    expect(makerChatStore.getSnapshot(sid).messages).toHaveLength(4);

    makerChatStore.dropMessagesFromClientId(sid, 'u2');

    const snap = makerChatStore.getSnapshot(sid);
    expect(snap.messages.map((m) => m.clientId)).toEqual(['u1', 'a1']);
    expect(snap.isStreaming).toBe(false);
  });

  it('裁剪同时重置 taskUpdates — 被裁 turn 的残留 update 否则会被兜底渲染成孤儿任务卡片', () => {
    const sid = `drop-${Math.random().toString(36).slice(2, 8)}`;
    seedConversation(sid);
    seedTaskUpdate(sid, 'task-in-dropped-turn');
    expect(makerChatStore.getSnapshot(sid).taskUpdates?.size ?? 0).toBeGreaterThan(0);

    makerChatStore.dropMessagesFromClientId(sid, 'u2');

    expect(makerChatStore.getSnapshot(sid).taskUpdates?.size ?? 0).toBe(0);
  });

  it('target 是首条时全部裁掉', () => {
    const sid = `drop-${Math.random().toString(36).slice(2, 8)}`;
    seedConversation(sid);

    makerChatStore.dropMessagesFromClientId(sid, 'u1');

    expect(makerChatStore.getSnapshot(sid).messages).toHaveLength(0);
  });

  it('clientId 不存在时严格 no-op(state 引用不变,不触发订阅方重渲)', () => {
    const sid = `drop-${Math.random().toString(36).slice(2, 8)}`;
    seedConversation(sid);
    const before = makerChatStore.getSnapshot(sid);

    makerChatStore.dropMessagesFromClientId(sid, 'does-not-exist');

    const after = makerChatStore.getSnapshot(sid);
    expect(after).toBe(before);
    expect(after.messages.map((m) => m.clientId)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});
