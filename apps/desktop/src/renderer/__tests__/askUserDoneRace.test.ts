/**
 * Codex ask_user 是 turn 间可存活交互：code-mode 可能在提问未答时就
 * turn/completed。done 不得把卡片标 expired；真正放弃仍走 dismissal。
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

import { updateContent as updateMessageContent } from '@/lib/messageService';
import { makerChatStore, type AskUserQuestionItem } from '@/lib/makerChatStore';

const SESSION_ID = 'ask-user-done-race';
const getPendingInteractions = vi.fn<() => Promise<unknown[]>>(async () => []);

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
let onInteractionRequest: ((data: unknown) => void) | undefined;
let onInteractionDismissed: ((data: unknown) => void) | undefined;

function installElectronBridge(): void {
  onEvent = undefined;
  onInteractionRequest = undefined;
  onInteractionDismissed = undefined;
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
        resolveInteraction: vi.fn(async () => ({ accepted: true })),
        abortSession: vi.fn(async () => {}),
        closeSession: vi.fn(async () => {}),
        listActive: vi.fn(async () => []),
      },
      localDb: {
        messages: {
          onCreated: vi.fn(() => vi.fn()),
        },
      },
    },
  };
}

function emitAskUserRequest(
  requestId: string,
  questions: AskUserQuestionItem[] = [{ question: '桌面版这次要采用哪种范围？', header: '词典编辑' }],
): void {
  onInteractionRequest?.({
    sessionId: SESSION_ID,
    request: {
      kind: 'ask_user_question',
      requestId,
      questions,
    },
    persistId: `persist-${requestId}`,
  });
}

function emitDone(source: 'codex' | 'claude-code'): void {
  onEvent?.({
    sessionId: SESSION_ID,
    event: {
      type: 'done',
      source,
      data: { type: 'task_complete', raw: { id: 'turn-1', status: 'completed' } },
    },
  });
}

function pendingAskStatuses(): string[] {
  return makerChatStore
    .getSnapshot(SESSION_ID)
    .messages.filter((m) => m.role === 'ask_user')
    .map((m) => m.askUserStatus ?? 'unknown');
}

describe('ask_user 与 done 的时序', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPendingInteractions.mockReset().mockResolvedValue([]);
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

  it('codex:done 不吞掉未答提问卡', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitAskUserRequest('ask-1');
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingAskUser?.requestId).toBe('ask-1');

    emitDone('codex');

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingAskUser?.requestId).toBe('ask-1');
    expect(pendingAskStatuses()).toEqual(['pending']);
  });

  it('codex:done 的 Host 快照重放保留答题状态及 questions 引用', async () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitAskUserRequest('ask-replay', [{
      question: 'Pick details',
      header: 'Details',
      multiSelect: true,
      options: [{ label: 'A', description: 'First option' }],
    }]);
    makerChatStore.setAskUserDraft(SESSION_ID, {
      requestId: 'ask-replay', currentIndex: 0, answers: {},
    });
    makerChatStore.setAskUserViewerState(SESSION_ID, 'minimized');
    const before = makerChatStore.getSnapshot(SESSION_ID);
    // A fresh IPC payload, including different object key order, is still the same question.
    const questions: AskUserQuestionItem[] = [{
      options: [{ description: 'First option', label: 'A' }],
      multiSelect: true,
      header: 'Details',
      question: 'Pick details',
    }];
    getPendingInteractions.mockResolvedValue([{
      request: { kind: 'ask_user_question', requestId: 'ask-replay', questions },
      persistId: 'persist-ask-replay',
    }]);

    emitDone('codex');

    // Wait for the actual async snapshot replay, not just the synchronous done reducer.
    await vi.waitFor(() => {
      expect(makerChatStore.getSnapshot(SESSION_ID).messages.find(
        (m) => m.askUserRequestId === 'ask-replay',
      )?.askUserQuestions).toBe(questions);
    });
    const after = makerChatStore.getSnapshot(SESSION_ID);
    // The prompt restores local unsubmitted text/checkboxes whenever questions changes identity.
    expect(after.pendingAskUser).toBe(before.pendingAskUser);
    expect(after.askUserDraft).toBe(before.askUserDraft);
    expect(after.askUserViewerState).toBe('minimized');
    expect(pendingAskStatuses()).toEqual(['pending']);
  });

  it.each([
    ['new request', 'ask-new', [{ question: 'Pick', options: [{ label: 'A' }] }]],
    ['changed question', 'ask-edit', [{ question: 'Different', options: [{ label: 'A' }] }]],
    ['changed option', 'ask-edit', [{ question: 'Pick', options: [{ label: 'B' }] }]],
    ['changed mode', 'ask-edit', [{ question: 'Pick', options: [{ label: 'A' }], multiSelect: true }]],
  ] as const)('%s still initializes a fresh question', (_name, requestId, questions) => {
    emitAskUserRequest('ask-edit', [{ question: 'Pick', options: [{ label: 'A' }] }]);
    makerChatStore.setAskUserDraft(SESSION_ID, {
      requestId: 'ask-edit', currentIndex: 0, answers: {},
    });
    makerChatStore.setAskUserViewerState(SESSION_ID, 'minimized');
    const before = makerChatStore.getSnapshot(SESSION_ID);

    emitAskUserRequest(requestId, questions.map((q) => ({
      ...q, options: q.options.map((option) => ({ ...option })),
    })));

    const after = makerChatStore.getSnapshot(SESSION_ID);
    expect(after.pendingAskUser).not.toBe(before.pendingAskUser);
    expect(after.pendingAskUser?.questions).toEqual(questions);
    expect(after.askUserDraft).toBeNull();
    expect(after.askUserViewerState).toBe('expanded');
  });

  it('claude:turn 结束仍将 pending 提问卡标过期', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'claude-code' });
    emitAskUserRequest('ask-2');
    emitDone('claude-code');

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingAskUser).toBeNull();
    expect(pendingAskStatuses()).toEqual(['expired']);
  });

  it('codex:main 的 dismissal 仍能把存活提问卡标过期', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitAskUserRequest('ask-3');
    emitDone('codex');
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingAskUser?.requestId).toBe('ask-3');

    onInteractionDismissed?.({
      sessionId: SESSION_ID,
      requestId: 'ask-3',
      reason: 'session_aborted',
      resolvedAs: 'deny',
    });

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingAskUser).toBeNull();
    expect(pendingAskStatuses()).toEqual(['expired']);
  });

  it('codex:答题只走 resolveInteraction，不本地落库', async () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitAskUserRequest('ask-4');
    emitDone('codex');
    makerChatStore.answerUserQuestion(SESSION_ID, 'ask-4', {
      '桌面版这次要采用哪种范围？': '完整编辑（推荐）',
    });
    await Promise.resolve();
    expect(updateMessageContent).not.toHaveBeenCalled();
    const resolveInteraction = (globalThis as unknown as {
      window: { electronAPI: { maker: { resolveInteraction: ReturnType<typeof vi.fn> } } };
    }).window.electronAPI.maker.resolveInteraction;
    expect(resolveInteraction).toHaveBeenCalledWith('ask-4', {
      kind: 'ask_user_question',
      answers: { '桌面版这次要采用哪种范围？': '完整编辑（推荐）' },
    });
  });

  it('codex:输家乐观答案会被赢家 dismissal 覆盖', () => {
    makerChatStore.setSessionRuntime(SESSION_ID, { agentKind: 'codex' });
    emitAskUserRequest('ask-5');
    emitDone('codex');
    makerChatStore.answerUserQuestion(SESSION_ID, 'ask-5', {
      '桌面版这次要采用哪种范围？': '只展示和搜索',
    });
    expect(makerChatStore.getSnapshot(SESSION_ID).messages.find((m) => m.role === 'ask_user'))
      .toMatchObject({
        askUserStatus: 'answered',
        askUserAnswers: { '桌面版这次要采用哪种范围？': '只展示和搜索' },
      });

    onInteractionDismissed?.({
      sessionId: SESSION_ID,
      requestId: 'ask-5',
      reason: 'resolved',
      resolvedAs: 'deny',
      decision: {
        kind: 'ask_user_question',
        answers: { '桌面版这次要采用哪种范围？': '完整编辑（推荐）' },
      },
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).messages.find((m) => m.role === 'ask_user'))
      .toMatchObject({
        askUserStatus: 'answered',
        askUserAnswers: { '桌面版这次要采用哪种范围？': '完整编辑（推荐）' },
      });
  });
});
