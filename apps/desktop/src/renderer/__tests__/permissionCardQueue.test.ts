/**
 * permissionCardQueue.test.ts
 * ---------------------------------------------------------------------------
 * Regression coverage for issue #3092: parallel tool_use in one assistant
 * message broadcasts several permission requests near-simultaneously. The
 * renderer used to keep a single `pendingPermission` slot, so the later card
 * overwrote the earlier one — the earlier request could never be shown or
 * answered, its main-process resolver waited out the 10-minute timeout, and
 * the engine recorded deny('timeout') for a tool call that was never run.
 *
 * These tests pin the queue semantics: one card shown at a time, later
 * requests wait in pendingPermissionQueue, and the queue advances when the
 * current card is answered (respondToPermission) or dismissed by main.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const SESSION_ID = 'perm-card-queue';

type ListenerKey =
  | 'event'
  | 'statusChanged'
  | 'inputProjection'
  | 'interaction'
  | 'dismissed'
  | 'messageCreated';

let listeners: Partial<Record<ListenerKey, (data: unknown) => void>>;
let resolveInteraction: ReturnType<typeof vi.fn>;
let listActive: ReturnType<typeof vi.fn>;

function subscribe(key: ListenerKey) {
  return (cb: (data: unknown) => void) => {
    listeners[key] = cb;
    return vi.fn();
  };
}

function installElectronBridge(): void {
  resolveInteraction = vi.fn(async () => {});
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

function pushPermission(requestId: string, title?: string): void {
  listeners.interaction?.({
    sessionId: SESSION_ID,
    request: {
      kind: 'permission',
      requestId,
      toolName: 'Read',
      input: { file_path: `/outside/${requestId}.md` },
      title,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  makerChatStore.__teardownGlobalListeners();
  makerChatStore.purgeSession(SESSION_ID);
  installElectronBridge();
  makerChatStore.initGlobalListeners();
});

describe('permission card queue (issue #3092)', () => {
  it('queues a second concurrent request instead of overwriting the first', () => {
    pushPermission('perm-1');
    pushPermission('perm-2');

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPermission?.requestId).toBe('perm-1');
    expect(snap.pendingPermissionQueue.map((p) => p.requestId)).toEqual(['perm-2']);
  });

  it('advances to the queued card after the current one is answered', () => {
    pushPermission('perm-1');
    pushPermission('perm-2');

    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'allow' });

    expect(resolveInteraction).toHaveBeenCalledWith(
      'perm-1',
      expect.objectContaining({ kind: 'permission', behavior: 'allow' }),
    );
    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPermission?.requestId).toBe('perm-2');
    expect(snap.pendingPermissionQueue).toEqual([]);

    makerChatStore.respondToPermission(SESSION_ID, { behavior: 'deny' });
    expect(resolveInteraction).toHaveBeenCalledWith(
      'perm-2',
      expect.objectContaining({ kind: 'permission', behavior: 'deny' }),
    );
    expect(makerChatStore.getSnapshot(SESSION_ID).pendingPermission).toBeNull();
  });

  it('advances to the queued card when main dismisses the current one', () => {
    pushPermission('perm-1');
    pushPermission('perm-2');

    listeners.dismissed?.({
      sessionId: SESSION_ID,
      requestId: 'perm-1',
      reason: 'timeout',
    });

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPermission?.requestId).toBe('perm-2');
    expect(snap.pendingPermissionQueue).toEqual([]);
  });

  it('removes a queued card that main dismissed without touching the shown one', () => {
    pushPermission('perm-1');
    pushPermission('perm-2');
    pushPermission('perm-3');

    listeners.dismissed?.({
      sessionId: SESSION_ID,
      requestId: 'perm-2',
      reason: 'timeout',
    });

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPermission?.requestId).toBe('perm-1');
    expect(snap.pendingPermissionQueue.map((p) => p.requestId)).toEqual(['perm-3']);
  });

  it('refreshes on duplicate requestId without duplicating queue entries', () => {
    pushPermission('perm-1', 'first title');
    pushPermission('perm-2', 'queued title');
    // Reconcile replay re-broadcasts the same pending requests.
    pushPermission('perm-1', 'replayed title');
    pushPermission('perm-2', 'replayed queued title');

    const snap = makerChatStore.getSnapshot(SESSION_ID);
    expect(snap.pendingPermission?.requestId).toBe('perm-1');
    expect(snap.pendingPermission?.title).toBe('replayed title');
    expect(snap.pendingPermissionQueue.map((p) => p.requestId)).toEqual(['perm-2']);
    expect(snap.pendingPermissionQueue[0]?.title).toBe('replayed queued title');
  });
});
