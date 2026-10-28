/** 测试价值：unit；真实 store 验证宿主卡片的恢复、终态保留与消退，不接收凭证。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn() } }));

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
  aroundClientId: vi.fn(async (_sessionId: string, clientId: string) => [{
    clientId, role: 'ask_user', content: { requestId: 'async-1', status: 'cancelled' },
  }]),
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
    model: 'test', effort: 'medium', permissionMode: 'ask', workingDir: '/repo',
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

import { makerChatStore, dismissMcpSetupResult } from '@/lib/makerChatStore';

const SESSION_ID = 'mcp-setup-lifecycle';
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
          steer: vi.fn(async () => false),
          stop: vi.fn(async (sessionId: string) => ({ ...emptyProjection(sessionId), queuePaused: true })),
          resume: vi.fn(async (sessionId: string) => emptyProjection(sessionId)),
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

const request = { kind: 'mcp_setup', requestId: 'desktop-mcp-test', operationId: '00000000-0000-4000-8000-000000000001', revision: 0, expiresAt: 9999999999999, status: 'awaiting_user', draft: { name: 'Demo', url: 'https://example.test/mcp', transport: 'http', headerNames: [] } };
describe('MCP card lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks(); getPendingInteractions.mockReset().mockResolvedValue([]); installElectronBridge();
    makerChatStore.__teardownGlobalListeners(); makerChatStore.purgeSession(SESSION_ID); makerChatStore.initGlobalListeners();
  });
  afterEach(() => { makerChatStore.__teardownGlobalListeners(); makerChatStore.purgeSession(SESSION_ID); vi.restoreAllMocks(); });
  it('survives Agent turn completion and rejects older revision pushes', () => {
    onInteractionRequest?.({ sessionId: SESSION_ID, request: { ...request, revision: 2 } });
    onEvent?.({ sessionId: SESSION_ID, event: { type: 'done', source: 'codex', data: { type: 'task_complete' } } });
    onInteractionRequest?.({ sessionId: SESSION_ID, request });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup?.revision).toBe(2);
  });
  it('restores pending metadata after reload and retires a missing pending request', async () => {
    getPendingInteractions.mockResolvedValue([{ request }]);
    await makerChatStore.reconcilePendingInteractions(SESSION_ID);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup).toMatchObject(request);
    getPendingInteractions.mockResolvedValue([]); await makerChatStore.reconcilePendingInteractions(SESSION_ID);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup).toBeNull();
  });
  it('keeps saved feedback through dismissal and reconciliation until the user closes it', async () => {
    onInteractionRequest?.({ sessionId: SESSION_ID, request: { ...request, status: 'saved' } });
    onInteractionDismissed?.({ sessionId: SESSION_ID, requestId: request.requestId, reason: 'resolved' });
    await makerChatStore.reconcilePendingInteractions(SESSION_ID);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup?.status).toBe('saved');
    dismissMcpSetupResult(SESSION_ID);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup).toBeNull();
    onInteractionRequest?.({ sessionId: SESSION_ID, request: { ...request, status: 'saved', activation: 'next_session', revision: 2 } });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup).toBeNull();
    onInteractionRequest?.({ sessionId: SESSION_ID, request: { ...request, requestId: 'desktop-mcp-new' } });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup?.requestId).toBe('desktop-mcp-new');
  });
  it('clears a cancelled request on host dismissal', () => {
    onInteractionRequest?.({ sessionId: SESSION_ID, request });
    onInteractionDismissed?.({ sessionId: SESSION_ID, requestId: request.requestId, reason: 'resolved' });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingMcpSetup).toBeNull();
  });
});
