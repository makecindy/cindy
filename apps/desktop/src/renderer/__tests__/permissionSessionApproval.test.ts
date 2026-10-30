/**
 * permissionSessionApproval.test.ts
 * ---------------------------------------------------------------------------
 * Regression coverage for "Always allow for session".
 *
 * The UI is fed through maker interaction IPC, then responds through
 * resolveInteraction. Both hops must preserve vendor permission suggestions;
 * otherwise the button behaves like "Allow once".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => ({ items: [], hasMore: false, oldestId: null })),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  update: vi.fn(async () => {}),
  touchUserSend: vi.fn(async () => {}),
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

import { makerChatStore } from '@/lib/makerChatStore';
import { toast } from '@/lib/toast';

const SESSION_ID = 'perm-session-approval';

type ListenerKey = 'event' | 'statusChanged' | 'inputProjection' | 'interaction' | 'dismissed' | 'messageCreated';

let listeners: Partial<Record<ListenerKey, (data: unknown) => void>>;
let resolveInteraction: ReturnType<typeof vi.fn>;
let listActive: ReturnType<typeof vi.fn>;
let getPendingInteractions: ReturnType<typeof vi.fn>;

function subscribe(key: ListenerKey) {
  return (cb: (data: unknown) => void) => {
    listeners[key] = cb;
    return vi.fn();
  };
}

function installElectronBridge(): void {
  resolveInteraction = vi.fn(async () => ({ accepted: true }));
  getPendingInteractions = vi.fn(async () => []);
  listActive = vi.fn(async () => []);
  listeners = {};
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: {
        onEvent: subscribe('event'),
        onStatusChanged: subscribe('statusChanged'),
        onInputProjection: subscribe('inputProjection'),
        onInteractionRequest: subscribe('interaction'),
        onInteractionDismissed: subscribe('dismissed'),
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
        resolveInteraction,
        getPendingInteractions,
        send: vi.fn(async () => {}),
        generateTitle: vi.fn(async () => ({ title: 't' })),
        abortSession: vi.fn(async () => {}),
        closeSession: vi.fn(async () => {}),
        listActive,
      },
      localDb: {
        messages: {
          onCreated: subscribe('messageCreated'),
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  makerChatStore.__teardownGlobalListeners();
  makerChatStore.purgeSession(SESSION_ID);
  installElectronBridge();
});

afterEach(() => vi.useRealTimers());

function showPermission(requestId = 'receipt-1') {
  const request = { kind: 'permission', requestId, toolName: 'mcp:cindy', input: {} };
  listeners.interaction?.({ sessionId: SESSION_ID, request });
  return request;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('permission interaction IPC', () => {
  it('rehydrates a running turn from main after renderer listener init', async () => {
    listActive.mockResolvedValueOnce([
      {
        sessionId: SESSION_ID,
        agentKind: 'claude-code',
        workDir: '/tmp/project',
        capabilities: {},
        isTurnRunning: true,
      },
    ]);

    makerChatStore.initGlobalListeners();
    makerChatStore.syncActiveTurnsFromMain();
    await Promise.resolve();
    await Promise.resolve();

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.isStreaming).toBe(true);
    expect(snap.agentStatus.isRunning).toBe(true);
    expect(snap.agentStatus.status).toBe('Running');
  });

  it('rehydrates a running Pi turn instead of dropping the active snapshot', async () => {
    listActive.mockResolvedValueOnce([
      {
        sessionId: SESSION_ID,
        agentKind: 'pi',
        workDir: '/tmp/project',
        capabilities: {},
        isTurnRunning: true,
      },
    ]);

    makerChatStore.initGlobalListeners();
    makerChatStore.syncActiveTurnsFromMain();
    await Promise.resolve();
    await Promise.resolve();

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.agentKind).toBe('pi');
    expect(snap.isStreaming).toBe(true);
    expect(snap.agentStatus.isRunning).toBe(true);
  });

  it('preserves title, description, and suggestions from main to pendingPermission', () => {
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'mcp__lizi_feishu__call_tool' }],
        behavior: 'allow',
        destination: 'session',
      },
    ];

    makerChatStore.initGlobalListeners();
    listeners.interaction?.({
      sessionId: SESSION_ID,
      request: {
        kind: 'permission',
        requestId: 'perm-1',
        toolName: 'mcp:lizi_feishu',
        input: { serverName: 'lizi_feishu' },
        title: 'Allow Codex to use call_tool?',
        description: 'Allow the lizi_feishu MCP server to run tool "call_tool"?',
        suggestions,
      },
    });

    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toEqual({
      requestId: 'perm-1',
      toolName: 'mcp:lizi_feishu',
      input: { serverName: 'lizi_feishu' },
      title: 'Allow Codex to use call_tool?',
      displayName: undefined,
      description: 'Allow the lizi_feishu MCP server to run tool "call_tool"?',
      suggestions,
      autoReviewUnavailable: false,
    });
  });

  it('forwards updatedPermissions back through resolveInteraction', async () => {
    const permissionUpdates = [
      {
        type: 'addRules',
        rules: [{ toolName: 'mcp__lizi_feishu__call_tool' }],
        behavior: 'allow',
        destination: 'session',
      },
    ];

    makerChatStore.initGlobalListeners();
    listeners.interaction?.({
      sessionId: SESSION_ID,
      request: {
        kind: 'permission',
        requestId: 'perm-2',
        toolName: 'mcp:lizi_feishu',
        input: {},
        suggestions: permissionUpdates,
      },
    });

    makerChatStore.respondToPermission(SESSION_ID, {
      behavior: 'allow',
      updatedPermissions: permissionUpdates,
      decisionClassification: 'user_permanent',
    });

    expect(resolveInteraction).toHaveBeenCalledWith(
      'perm-2',
      expect.objectContaining({
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates,
      }),
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission?.submitting).toBe(true);
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull());
  });

  it('keeps the card until acknowledged and ignores duplicate decisions', async () => {
    const receipt = deferred<{ accepted: boolean }>();
    resolveInteraction.mockReturnValueOnce(receipt.promise);
    makerChatStore.initGlobalListeners();
    showPermission();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    // A repeated push must not re-enable buttons during submission.
    showPermission();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'deny' });
    expect(resolveInteraction).toHaveBeenCalledTimes(1);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission?.submitting).toBe(true);
    receipt.resolve({ accepted: true });
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull());
  });

  it('removes an expired request when the host refuses the receipt', async () => {
    resolveInteraction.mockResolvedValueOnce({ accepted: false });
    makerChatStore.initGlobalListeners();
    showPermission();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull());
    expect(getPendingInteractions).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledOnce();
  });

  it.each(['reject', 'throw', 'missing-receipt', 'timeout'] as const)('makes an undelivered decision retryable after %s', async (failure) => {
    if (failure === 'timeout') vi.useFakeTimers();
    if (failure === 'reject') resolveInteraction.mockRejectedValueOnce(new Error('offline'));
    if (failure === 'throw') resolveInteraction.mockImplementationOnce(() => { throw new Error('offline'); });
    if (failure === 'missing-receipt') resolveInteraction.mockResolvedValueOnce(undefined);
    if (failure === 'timeout') resolveInteraction.mockReturnValueOnce(new Promise(() => {}));
    makerChatStore.initGlobalListeners();
    const request = showPermission();
    getPendingInteractions.mockResolvedValueOnce([{ request }]);
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toMatchObject({
      requestId: 'receipt-1', submitting: false, submissionFailed: true,
    }));
    expect(resolveInteraction).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledOnce();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull());
    expect(resolveInteraction).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a request when the decision succeeded but its receipt was lost', async () => {
    resolveInteraction.mockRejectedValueOnce(new Error('reply lost'));
    makerChatStore.initGlobalListeners();
    showPermission();
    getPendingInteractions.mockResolvedValueOnce([]);
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    await vi.waitFor(() => expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull());
    expect(getPendingInteractions).toHaveBeenCalledWith(SESSION_ID);
    expect(resolveInteraction).toHaveBeenCalledTimes(1);
  });

  it('makes the card retryable even when both the receipt and reconciliation hang', async () => {
    vi.useFakeTimers();
    resolveInteraction.mockReturnValueOnce(new Promise(() => {}));
    getPendingInteractions.mockReturnValueOnce(new Promise(() => {}));
    makerChatStore.initGlobalListeners();
    showPermission();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toMatchObject({ submitting: false, submissionFailed: true });
    expect(resolveInteraction).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledOnce();
  });

  it.each(['accepted', 'rejected'] as const)('ignores a late %s receipt after dismiss or a newer request', async (outcome) => {
    const receipt = deferred<{ accepted: boolean }>();
    resolveInteraction.mockReturnValueOnce(receipt.promise);
    makerChatStore.initGlobalListeners();
    showPermission();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    listeners.dismissed?.({ sessionId: SESSION_ID, requestId: 'receipt-1', reason: 'resolved' });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull();
    showPermission('receipt-2');
    if (outcome === 'accepted') receipt.resolve({ accepted: true });
    else receipt.reject(new Error('late rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toMatchObject({ requestId: 'receipt-2' });
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission?.submitting).toBeUndefined();
    expect(getPendingInteractions).not.toHaveBeenCalled();
  });

  it('ignores a failure snapshot if a newer permission arrived while reading it', async () => {
    const snapshot = deferred<unknown[]>();
    resolveInteraction.mockRejectedValueOnce(new Error('offline'));
    getPendingInteractions.mockReturnValueOnce(snapshot.promise);
    makerChatStore.initGlobalListeners();
    showPermission();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    await vi.waitFor(() => expect(getPendingInteractions).toHaveBeenCalledOnce());
    showPermission('receipt-2');
    snapshot.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toMatchObject({ requestId: 'receipt-2' });
  });

  it('does not restore a submitted permission after the session is purged', async () => {
    const receipt = deferred<{ accepted: boolean }>();
    resolveInteraction.mockReturnValueOnce(receipt.promise);
    makerChatStore.initGlobalListeners();
    showPermission();
    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });
    makerChatStore.purgeSession(SESSION_ID);
    receipt.reject(new Error('late rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getPendingInteractions).not.toHaveBeenCalled();
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull();
  });
});

describe('PermissionPrompt source contract', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'components', 'new-chat', 'PermissionPrompt.tsx'),
    'utf8',
  );

  it('only renders Always allow for session when session suggestions exist', () => {
    expect(source).toMatch(/canAlwaysAllowForSession\s*&&/);
  });

  it('uses maker-provided session-scoped suggestions without rewriting vendor payloads', () => {
    expect(source).toMatch(/destination\s*===\s*'session'/);
    expect(source).not.toContain("...suggestion, destination: 'session'");
  });
});
