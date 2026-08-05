/**
 * staleErrorClearedOnTurnStart.test.ts
 * ---------------------------------------------------------------------------
 * PR #485 review 回归:会话残留终态 error(ErrorBanner)时,后续 direct turn
 * (scheduler / send-to-session 等不走 coordinator、不发 projection 的路径)
 * 启动必须清掉旧 error —— 否则该 turn 成功结束时 running→stopped 判定经
 * hasSessionTerminalError fallback 读到旧值,误发「执行失败」通知。
 * 同时锁定 skipTurnReset(mivo 等 side-channel running 信号)不误清。
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
  stringifyUserContent: vi.fn((text: string) => text),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';

const SESSION_ID = 'stale-error-turn-start';

let onEvent: ((data: unknown) => void) | undefined;

function installElectronBridge(): void {
  onEvent = undefined;
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: {
        input: {
          getProjection: vi.fn(async (sessionId: string) => ({
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
          })),
        },
        onInputProjection: vi.fn(() => vi.fn()),
        onEvent: (cb: (data: unknown) => void) => {
          onEvent = cb;
          return vi.fn();
        },
        onStatusChanged: vi.fn(() => vi.fn()),
        onInteractionRequest: vi.fn(() => vi.fn()),
        onInteractionDismissed: vi.fn(() => vi.fn()),
        send: vi.fn(async () => ({ accepted: true })),
        resolveInteraction: vi.fn(async () => {}),
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

function emitTerminalError(): void {
  onEvent?.({
    sessionId: SESSION_ID,
    event: {
      type: 'error',
      source: 'codex',
      data: { message: 'boom', isTerminal: true },
    },
  });
}

function emitStatus(data: Record<string, unknown>): void {
  onEvent?.({
    sessionId: SESSION_ID,
    event: { type: 'status', source: 'codex', data },
  });
}

describe('残留终态 error 在新 turn 启动时清除', () => {
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

  it('direct turn 启动(isRunning false→true)清掉旧 error, 成功结束不再误判失败', () => {
    emitTerminalError();
    expect(makerChatStore.hasSessionTerminalError(SESSION_ID)).toBe(true);

    // direct send(scheduler / send-to-session)只有事件流,无 projection。
    emitStatus({ isRunning: true, status: 'Working' });
    expect(makerChatStore.hasSessionTerminalError(SESSION_ID)).toBe(false);
    expect(makerChatStore.getSnapshot(SESSION_ID).error).toBeNull();

    // 本轮成功结束: running→stopped 判定读到的 error 为空 → done 而非「执行失败」。
    emitStatus({ isRunning: false, status: 'Done', contextTokens: 0, contextWindow: 0 });
    expect(makerChatStore.hasSessionTerminalError(SESSION_ID)).toBe(false);
  });

  it('skipTurnReset 的 side-channel running 信号不清 error(banner 保留)', () => {
    emitTerminalError();
    expect(makerChatStore.getSnapshot(SESSION_ID).error).not.toBeNull();

    emitStatus({ isRunning: true, status: 'Mivo …', skipTurnReset: true });
    // banner(state.error)保留 —— 上一轮真实失败的展示不被侧任务清掉。
    expect(makerChatStore.getSnapshot(SESSION_ID).error).not.toBeNull();
  });

  it('side-task 结束不把保留的旧 error 当作本次 run 的终态失败', () => {
    emitTerminalError();
    emitStatus({ isRunning: true, status: 'Mivo …', skipTurnReset: true });
    makerChatStore.getRunningSnapshot();

    emitStatus({ isRunning: false, status: 'Done', skipTurnReset: true });
    // transition snapshot 与 fallback 双路豁免: 成功的侧任务不误报「执行失败」,
    // 且整个 transition 标记 sideTask → done/error 终态通知全跳过。
    const info = makerChatStore.getRunningSnapshot().get(SESSION_ID);
    expect(info?.isRunning).toBe(false);
    expect(info?.hasError).toBe(false);
    expect(info?.sideTask).toBe(true);
    expect(makerChatStore.hasSessionTerminalError(SESSION_ID)).toBe(false);
    expect(makerChatStore.wasLastStopSideTask(SESSION_ID)).toBe(true);
    // 但 banner 本身保留(仅通知判定豁免)。
    expect(makerChatStore.getSnapshot(SESSION_ID).error).not.toBeNull();

    // 之后真实 turn 起止: 标记复位, 真实失败照常判定。
    emitStatus({ isRunning: true, status: 'Working' });
    emitTerminalError();
    emitStatus({ isRunning: false, status: 'Done', contextTokens: 0, contextWindow: 0 });
    expect(makerChatStore.hasSessionTerminalError(SESSION_ID)).toBe(true);
  });
});
