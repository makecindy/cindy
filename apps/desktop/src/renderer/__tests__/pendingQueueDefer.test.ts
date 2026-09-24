/**
 * pendingQueueDefer.test.ts
 * ---------------------------------------------------------------------------
 * Renderer-side contract for queued input after queue/steer moved to main.
 *
 * The old tests asserted reducer-owned drain behavior in the renderer. That was
 * the architectural bug: renderer only sees a local UI slice, while one user
 * input crosses queue projection, visible bubble, SQLite persistence and the
 * maker-core accepted boundary. These tests now pin the renderer as a thin
 * intent/projection facade. Transaction behavior lives in
 * `agent-input-coordinator.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInputProjection, AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import type { AttachedFile } from '@/lib/fileTypes';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  __resetStickySessionOriginForTest,
  getStickySessionDeviceId,
} from '@/features/device-link/stickySessionOrigin';

const annotationBurnInMocks = vi.hoisted(() => ({
  materialize: vi.fn(
    async (files: readonly AttachedFile[] | undefined): Promise<AttachedFile[] | undefined> =>
      files ? [...files] : undefined,
  ),
}));

vi.mock('@/lib/annotationBurnIn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/annotationBurnIn')>()),
  materializeAnnotatedAttachmentsForSend: annotationBurnInMocks.materialize,
}));

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

import { makerChatStore, type QueuedMessage } from '@/lib/makerChatStore';

const MODEL = 'claude-opus-4-7';
const EFFORT = 'medium';
const PERM = 'default';
const WD = 'C:\\workspace';

let projectionHandler: ((projection: AgentInputProjection) => void) | null = null;
let messageCreatedHandler: ((payload: unknown) => void) | null = null;
let remoteInvoke = vi.fn();

const legacySend = vi.fn(async () => {});
const legacySteer = vi.fn(async () => {});
const generateTitle = vi.fn(async () => ({ title: 't' }));
const cacheMediaForSession = vi.fn(async () => ({
  url: 'xdt-image://session/copied.png',
  name: 'copied.png',
  ext: 'png',
  mimeType: 'image/png',
  size: 10,
}));
const cleanupCachedImages = vi.fn(async () => undefined);
const cleanupStagedChatAttachments = vi.fn(async () => undefined);

const input = {
  getProjection: vi.fn(async (sessionId: string) => projection(sessionId)),
  enqueue: vi.fn(async (
    sessionId: string,
    item: AgentInputQueuedMessage,
    opts?: { sendAtMs?: number },
  ) => {
    void opts;
    return projection(sessionId, { pendingQueue: [item] });
  }),
  steer: vi.fn(async () => true),
  stop: vi.fn(async (sessionId: string, opts?: { keepQueue?: boolean; pauseQueue?: boolean }) =>
    projection(sessionId, {
      queuePaused: Boolean(opts?.keepQueue && opts?.pauseQueue),
      queueAbortPending: Boolean(opts?.keepQueue && opts?.pauseQueue),
    }),
  ),
  resume: vi.fn(async (sessionId: string) => projection(sessionId, { queuePaused: false })),
  retryLastError: vi.fn(async (sessionId: string) => projection(sessionId)),
  clearError: vi.fn(async (sessionId: string) => projection(sessionId)),
  remove: vi.fn(async (sessionId: string) => projection(sessionId)),
  updateText: vi.fn(async (sessionId: string) => projection(sessionId)),
  updateContent: vi.fn(
    async (sessionId: string, _clientId: string, item: AgentInputQueuedMessage) =>
      projection(sessionId, { pendingQueue: [item] }),
  ),
  move: vi.fn(async (sessionId: string) => projection(sessionId)),
  setExpanded: vi.fn(async (sessionId: string, expanded: boolean) =>
    projection(sessionId, { queueExpanded: expanded }),
  ),
  setInteractionLock: vi.fn(async (sessionId: string) => projection(sessionId)),
  setEditLock: vi.fn(async (sessionId: string) => projection(sessionId)),
  clearSession: vi.fn(async (sessionId: string) => projection(sessionId)),
};

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

function queued(clientId: string, text: string): QueuedMessage {
  return {
    clientId,
    text,
    persistedContent: JSON.stringify({ text, images: [], files: [] }),
    model: MODEL,
    effort: EFFORT,
    permissionMode: PERM,
    workingDir: WD,
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

function installElectronBridge(): void {
  projectionHandler = null;
  messageCreatedHandler = null;
  remoteInvoke = vi.fn().mockResolvedValue(undefined);
  const w = (globalThis as unknown as { window?: Record<string, unknown> });
  if (!w.window) w.window = {};
  w.window.electronAPI = {
    maker: {
      input,
      onInputProjection: vi.fn((cb: (projection: AgentInputProjection) => void) => {
        projectionHandler = cb;
        return vi.fn();
      }),
      onEvent: vi.fn(() => vi.fn()),
      onStatusChanged: vi.fn(() => vi.fn()),
      onInteractionRequest: vi.fn(() => vi.fn()),
      onInteractionDismissed: vi.fn(() => vi.fn()),
      send: legacySend,
      steer: legacySteer,
      generateTitle,
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
    deviceLink: { invoke: remoteInvoke },
    cacheMediaForSession,
    cleanupCachedImages,
    cleanupStagedChatAttachments,
  };
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  annotationBurnInMocks.materialize.mockImplementation(async (files) =>
    files ? [...files] : undefined,
  );
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

describe('renderer input queue facade', () => {
  it('sends a prepared enqueue intent and mirrors the returned projection', async () => {
    const sid = `enqueue-${Math.random().toString(36).slice(2, 8)}`;
    const file = {
      id: 'file-1',
      name: 'report.pdf',
      path: 'C:\\workspace\\report.pdf',
      ext: '.pdf',
      size: 1234,
      category: 'pdf' as const,
      mimeType: 'application/pdf',
    };
    const mention = { type: 'file' as const, name: 'config.json', path: 'C:\\workspace\\config.json' };

    makerChatStore.sendMessage(
      sid,
      'hello',
      MODEL,
      EFFORT,
      PERM,
      WD,
      [file],
      [mention],
      { vendorOptions: { temperature: 0.2 } },
    );
    await flushPromises();

    expect(input.enqueue).toHaveBeenCalledTimes(1);
    const [sessionId, item, opts] = input.enqueue.mock.calls[0] as [
      string,
      AgentInputQueuedMessage,
      { sendAtMs: number },
    ];
    expect(sessionId).toBe(sid);
    expect(opts.sendAtMs).toEqual(expect.any(Number));
    expect(item).toMatchObject({
      text: 'hello',
      model: MODEL,
      effort: EFFORT,
      permissionMode: PERM,
      workingDir: WD,
      vendorOptions: { temperature: 0.2 },
      mentions: [mention],
      files: [expect.objectContaining({ path: 'C:\\workspace\\report.pdf' })],
      createOpts: {
        agentKind: 'claude-code',
        workingDir: WD,
        model: MODEL,
        effort: EFFORT,
        permissionMode: PERM,
        userPrompt: 'test user prompt',
        makerMemoryEnabled: true,
        displayReasoning: 'summarized',
        vendorOptions: { temperature: 0.2 },
      },
    });
    expect(item.chatMessage.clientId).toBe(item.clientId);
    expect(item.persistedContent).toContain('"hello"');
    expect(legacySend).not.toHaveBeenCalled();

    const snap = makerChatStore.getSnapshot(sid);
    expect(snap.pendingQueue.map((q) => q.text)).toEqual(['hello']);
    expect(snap.messages).toHaveLength(0);
    expect(snap.isFirstMessage).toBe(false);
  });

  it('clears first-message state when main broadcasts the persisted user row', () => {
    const sid = `db-user-${Math.random().toString(36).slice(2, 8)}`;

    makerChatStore.initGlobalListeners();
    expect(makerChatStore.getSnapshot(sid).isFirstMessage).toBe(true);

    messageCreatedHandler?.({
      sessionId: sid,
      message: {
        id: 'm-1',
        clientId: 'user-1',
        sessionId: sid,
        role: 'user',
        content: 'hello from db',
        toolUseId: null,
        agentMeta: null,
        createdAt: '2026-06-07T00:00:00.000Z',
      },
    });

    const snap = makerChatStore.getSnapshot(sid);
    expect(snap.isFirstMessage).toBe(false);
    expect(snap.messages).toMatchObject([
      { clientId: 'user-1', role: 'user', content: 'hello from db' },
    ]);
  });

  it('treats main input projection as the queue source of truth', () => {
    const sid = `projection-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-1', 'from main');

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, {
      pendingQueue: [item],
      continuationInFlightClientId: 'q-continue',
      steeringQueueClientIds: ['q-1'],
      queuePaused: true,
      queueExpanded: true,
      queueInteractionLocks: ['drag'],
      queueEditLocks: ['q-1'],
      queueAbortPending: true,
      error: 'paused',
      recovery: { kind: 'queue-head', clientId: 'q-1' },
      errorRetryText: 'from main',
    }));

    const snap = makerChatStore.getSnapshot(sid);
    expect(snap.pendingQueue).toEqual([item]);
    expect(snap.continuationInFlightClientId).toBe('q-continue');
    expect(snap.steeringQueueClientIds).toEqual(['q-1']);
    expect(snap.queuePaused).toBe(true);
    expect(snap.queueExpanded).toBe(true);
    expect(snap.queueInteractionLocks).toEqual(['drag']);
    expect(snap.queueEditLocks).toEqual(['q-1']);
    expect(snap.queueAbortPending).toBe(true);
    expect(snap.error).toBe('paused');
    expect(snap.errorRetryText).toBe('from main');

    // 旧被控端 projection 缺省新字段时回落 null，不能把前一轮 in-flight
    // Continue 标记永久留在 renderer。
    projectionHandler?.(projection(sid));
    expect(makerChatStore.getSnapshot(sid).continuationInFlightClientId).toBeNull();
  });

  it('delegates queue row operations to main input intents', async () => {
    const sid = `row-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-row', 'queued row');

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));

    const ok = await makerChatStore.steerQueuedMessage(sid, item.clientId);
    makerChatStore.updateQueueItem(sid, item.clientId, 'edited');
    makerChatStore.moveQueueItem(sid, item.clientId, 0);
    makerChatStore.removeFromQueue(sid, item.clientId);
    makerChatStore.setQueueExpanded(sid, true);
    makerChatStore.setQueueInteractionLock(sid, 'drag', true);
    makerChatStore.setQueueEditLock(sid, item.clientId, true);
    await flushPromises();

    expect(ok).toBe(true);
    expect(input.steer).toHaveBeenCalledWith(sid, item, { removeFromQueue: true });
    expect(input.updateText).toHaveBeenCalledWith(sid, item.clientId, 'edited', []);
    expect(input.move).toHaveBeenCalledWith(sid, item.clientId, 0);
    expect(input.remove).toHaveBeenCalledWith(sid, item.clientId);
    expect(input.setExpanded).toHaveBeenCalledWith(sid, true);
    expect(input.setInteractionLock).toHaveBeenCalledWith(sid, 'drag', true);
    expect(input.setEditLock).toHaveBeenCalledWith(sid, item.clientId, true);
    expect(legacySteer).not.toHaveBeenCalled();
  });

  it('replaces queued text and attachments through update-content', async () => {
    const sid = `content-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-content', 'keep metadata');
    item.chatMessage.quotesEncoded = true;
    item.chatMessage.slashCommandRanges = [{ start: 0, end: 4 }];

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [
        {
          id: 'new-image',
          name: 'new.png',
          path: 'C:\\images\\new.png',
          ext: 'png',
          size: 123,
          category: 'image',
          mimeType: 'image/png',
          url: 'xdt-image://session/new.png',
        },
      ],
    });

    expect(saved).toBe(true);
    expect(input.updateContent).toHaveBeenCalledWith(
      sid,
      item.clientId,
      expect.objectContaining({
        clientId: item.clientId,
        files: [expect.objectContaining({ id: 'new-image' })],
        chatMessage: expect.objectContaining({
          quotesEncoded: true,
          slashCommandRanges: [{ start: 0, end: 4 }],
        }),
      }),
    );
  });

  it('accepts queue attachment projections after transport materializes base64', async () => {
    const sid = `transport-fields-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-transport-fields', 'keep transport fields out of intent');
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    input.updateContent.mockImplementationOnce(
      async (sessionId: string, _clientId: string, replacement: AgentInputQueuedMessage) =>
        projection(sessionId, {
          pendingQueue: [
            {
              ...replacement,
              files: (replacement.files ?? []).map((file) => ({
                ...file,
                path: 'C:\\remote-cache\\materialized.png',
                url: 'xdt-image://remote/materialized.png',
                size: 87,
                sha256: 'a'.repeat(64),
                base64: undefined,
              })),
            },
          ],
        }),
    );

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [
        {
          id: 'transport-image',
          name: 'transport.png',
          path: 'C:\\images\\transport.png',
          ext: 'png',
          size: 123,
          category: 'image',
          mimeType: 'image/png',
          base64: 'dHJhbnNwb3J0LWltYWdl',
        },
      ],
    });

    expect(saved).toBe(true);
  });

  it('recycles an ordinary controller image after a remote queue edit is accepted', async () => {
    const sid = `remote-image-${Math.random().toString(36).slice(2, 8)}`;
    const deviceId = 'dev-remote-image';
    const item = queued('q-remote-image', 'ordinary remote image edit');
    const sourceUrl = 'xdt-image://session/ordinary-source.png';
    const source: AttachedFile = {
      id: 'remote-image',
      name: 'ordinary-source.png',
      path: 'C:\\images\\ordinary-source.png',
      ext: 'png',
      size: 123,
      category: 'image',
      mimeType: 'image/png',
      url: sourceUrl,
    };
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    remoteProjectsStore.setDeviceSessions(deviceId, 'Remote Mac', [{ id: sid } as never]);
    remoteInvoke.mockImplementation(async (_deviceId, channel, args) => {
      expect(channel).toBe('maker:input:update-content');
      const replacement = args[2] as AgentInputQueuedMessage;
      return projection(sid, {
        pendingQueue: [
          {
            ...replacement,
            files: (replacement.files ?? []).map((file) => ({
              ...file,
              path: 'C:\\remote-cache\\ordinary.png',
              url: 'xdt-image://remote/ordinary.png',
            })),
          },
        ],
      });
    });

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [source],
    });

    expect(saved).toBe(true);
    expect(cleanupCachedImages).toHaveBeenCalledWith([sourceUrl]);
  });

  it('recycles a newly annotated remote queue edit source only after acceptance', async () => {
    const sid = `remote-annotation-${Math.random().toString(36).slice(2, 8)}`;
    const deviceId = 'dev-remote-annotation';
    const item = queued('q-remote-annotation', 'annotated remote edit');
    const sourceUrl = 'xdt-image://session/annotation-source.png';
    const burnedUrl = 'xdt-image://session/annotation-burned.png';
    const source: AttachedFile = {
      id: 'remote-annotation',
      name: 'annotation-source.png',
      path: 'C:\\images\\annotation-source.png',
      ext: 'png',
      size: 123,
      category: 'image',
      mimeType: 'image/png',
      url: sourceUrl,
      annotationStrokes: [{ points: [{ x: 0.1, y: 0.2 }] }],
    };
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    remoteProjectsStore.setDeviceSessions(deviceId, 'Remote Mac', [{ id: sid } as never]);
    annotationBurnInMocks.materialize.mockResolvedValueOnce([
      {
        ...source,
        url: burnedUrl,
        annotated: true,
        annotationStrokes: undefined,
        annotationSourceUrl: undefined,
      },
    ]);
    remoteInvoke.mockImplementation(async (_deviceId, channel, args) => {
      expect(channel).toBe('maker:input:update-content');
      const replacement = args[2] as AgentInputQueuedMessage;
      return projection(sid, { pendingQueue: [replacement] });
    });

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [source],
    });

    expect(saved).toBe(true);
    expect(cleanupCachedImages).toHaveBeenCalledWith([sourceUrl]);
  });

  it('keeps an annotated remote queue edit source when the replacement is rejected', async () => {
    const sid = `remote-annotation-rejected-${Math.random().toString(36).slice(2, 8)}`;
    const deviceId = 'dev-remote-annotation-rejected';
    const item = queued('q-remote-annotation-rejected', 'annotated remote edit');
    const sourceUrl = 'xdt-image://session/rejected-annotation-source.png';
    const burnedUrl = 'xdt-image://session/rejected-annotation-burned.png';
    const source: AttachedFile = {
      id: 'remote-annotation-rejected',
      name: 'rejected-annotation-source.png',
      path: 'C:\\images\\rejected-annotation-source.png',
      ext: 'png',
      size: 123,
      category: 'image',
      mimeType: 'image/png',
      url: sourceUrl,
      annotationStrokes: [{ points: [{ x: 0.1, y: 0.2 }] }],
    };
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    remoteProjectsStore.setDeviceSessions(deviceId, 'Remote Mac', [{ id: sid } as never]);
    annotationBurnInMocks.materialize.mockResolvedValueOnce([
      {
        ...source,
        url: burnedUrl,
        annotated: true,
        annotationStrokes: undefined,
        annotationSourceUrl: undefined,
      },
    ]);
    remoteInvoke.mockResolvedValue(projection(sid, { pendingQueue: [item] }));

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [source],
    });

    expect(saved).toBe(false);
    expect(cleanupCachedImages).toHaveBeenCalledTimes(1);
    expect(cleanupCachedImages).toHaveBeenCalledWith([burnedUrl]);
  });

  it('cleans original queue attachment artifacts only after an accepted replacement', async () => {
    const sid = `cleanup-content-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-cleanup-content', 'keep text');
    item.files = [
      {
        id: 'old-image',
        name: 'old.png',
        path: 'C:\\images\\old.png',
        ext: 'png',
        size: 1,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://session/old.png',
        annotated: true,
      },
      {
        id: 'old-staged-file',
        name: 'old.exe',
        path: 'C:\\cache\\old.bin',
        ext: 'exe',
        size: 1,
        category: 'file',
        mimeType: 'application/octet-stream',
      },
    ];
    item.chatMessage.retryFiles = [
      {
        ...item.files[0],
        annotationSourceUrl: 'xdt-image://session/old-source.png',
        annotationStrokes: [{ points: [{ x: 0.25, y: 0.75 }] }],
      },
    ];

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [],
    });

    expect(saved).toBe(true);
    expect(cleanupCachedImages).toHaveBeenCalledWith([
      'xdt-image://session/old.png',
      'xdt-image://session/old-source.png',
    ]);
    expect(cleanupStagedChatAttachments).toHaveBeenCalledWith(['C:\\cache\\old.bin']);
  });

  it('uses the editor mentions when visible text is unchanged', async () => {
    const sid = 'same-text-mentions-' + Math.random().toString(36).slice(2, 8);
    const item = queued('q-same-text-mentions', 'keep @src/app.ts');
    item.mentions = [{ type: 'file', name: 'app.ts', path: 'src/app.ts' }];

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [],
    });

    expect(saved).toBe(true);
    expect(input.updateContent).toHaveBeenCalledWith(
      sid,
      item.clientId,
      expect.objectContaining({ mentions: [] }),
    );
  });

  it('rejects a queue edit when the projection keeps stale mentions', async () => {
    const sid = 'stale-mentions-' + Math.random().toString(36).slice(2, 8);
    const item = queued('q-stale-mentions', 'keep @src/app.ts');
    item.mentions = [{ type: 'file', name: 'app.ts', path: 'src/app.ts' }];

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    input.updateContent.mockImplementationOnce(async () =>
      projection(sid, { pendingQueue: [item] }),
    );

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [],
    });

    expect(saved).toBe(false);
  });

  it('falls back to update-text when an old device-link target lacks update-content', async () => {
    const sid = `legacy-content-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-legacy-content', 'old text');
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    input.updateContent.mockRejectedValueOnce(
      new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] update-content unavailable'),
    );
    input.updateText.mockImplementationOnce(async (sessionId: string) =>
      projection(sessionId, {
        pendingQueue: [{
          ...item,
          text: 'edited text',
          persistedContent: item.persistedContent,
          chatMessage: { ...item.chatMessage, content: 'edited text' },
        }],
      }),
    );

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: 'edited text',
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [],
    });

    expect(saved).toBe(true);
    expect(input.updateText).toHaveBeenCalledWith(sid, item.clientId, 'edited text', undefined);
  });

  it('falls back for an unchanged annotation on an old target but rejects changed strokes', async () => {
    const sid = `legacy-annotation-${Math.random().toString(36).slice(2, 8)}`;
    const deviceId = 'dev-legacy-annotation';
    const sourceUrl = 'xdt-image://session/legacy-source.jpg';
    const burnedUrl = 'xdt-image://session/legacy-burned.png';
    const rematerializedUrl = 'xdt-image://session/legacy-rematerialized.png';
    const strokes = [{ points: [{ x: 0.2, y: 0.8 }] }];
    const item = queued('q-legacy-annotation', 'old text');
    item.files = [{
      id: 'legacy-annotation',
      name: 'legacy-burned.png',
      originalName: 'legacy-burned.png',
      path: 'C:\\images\\legacy-burned.png',
      ext: '.png',
      size: 123,
      category: 'image',
      mimeType: 'image/png',
      url: burnedUrl,
      annotated: true,
    }];
    item.chatMessage.retryFiles = [{
      ...item.files[0],
      annotationSourceUrl: sourceUrl,
      annotationStrokes: strokes,
    }];
    const editableFile: AttachedFile = {
      ...item.files[0],
      path: sourceUrl,
      url: sourceUrl,
      ext: '.jpg',
      mimeType: 'image/jpeg',
      annotated: undefined,
      annotationStrokes: strokes.map((stroke) => ({
        points: stroke.points.map((point) => ({ ...point })),
      })),
      cacheUrlShared: true,
      stagedPathShared: true,
    };
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    remoteProjectsStore.setDeviceSessions(deviceId, 'Remote Mac', [{ id: sid } as never]);
    annotationBurnInMocks.materialize.mockResolvedValueOnce([{
      ...editableFile,
      name: 'legacy-rematerialized.png',
      originalName: 'legacy-rematerialized.png',
      url: rematerializedUrl,
      ext: '.png',
      mimeType: 'image/png',
      annotated: true,
      annotationStrokes: undefined,
    }]);
    remoteInvoke.mockImplementation(async (_deviceId, channel) => {
      if (channel === 'maker:input:update-content') {
        throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] update-content unavailable');
      }
      expect(channel).toBe('maker:input:update-text');
      return projection(sid, {
        pendingQueue: [{
          ...item,
          text: 'edited text',
          persistedContent: item.persistedContent,
          chatMessage: { ...item.chatMessage, content: 'edited text' },
        }],
      });
    });

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: 'edited text',
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [editableFile],
    });

    expect(saved).toBe(true);
    expect(remoteInvoke).toHaveBeenCalledWith(
      deviceId,
      'maker:input:update-content',
      expect.any(Array),
    );
    expect(remoteInvoke).toHaveBeenCalledWith(
      deviceId,
      'maker:input:update-text',
      expect.any(Array),
    );
    expect(cleanupCachedImages).toHaveBeenCalledWith([rematerializedUrl]);

    const updateTextCalls = remoteInvoke.mock.calls.filter(
      ([, channel]) => channel === 'maker:input:update-text',
    ).length;
    await expect(
      makerChatStore.updateQueueItemContent(sid, item.clientId, {
        content: {
          text: 'edited again',
          mentions: [],
          hasQuotes: false,
          agentReferences: [],
          pastedTextRanges: [],
          slashCommandRanges: [],
        },
        files: [{
          ...editableFile,
          annotationStrokes: [{ points: [{ x: 0.4, y: 0.6 }] }],
        }],
      }),
    ).rejects.toThrow('update-content unavailable');
    expect(
      remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:input:update-text'),
    ).toHaveLength(updateTextCalls);
  });

  it('does not fall back to update-text when queue edit attachments change', async () => {
    const sid = `legacy-attachment-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-legacy-attachment', 'keep text');
    item.files = [{
      id: 'old-file',
      name: 'old.png',
      path: 'C:\\images\\old.png',
      ext: 'png',
      size: 1,
      category: 'image',
      mimeType: 'image/png',
    }];
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    input.updateContent.mockRejectedValueOnce(
      new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] update-content unavailable'),
    );
    input.updateText.mockClear();

    await expect(
      makerChatStore.updateQueueItemContent(sid, item.clientId, {
        content: {
          text: 'edited text',
          mentions: [],
          hasQuotes: false,
          agentReferences: [],
          pastedTextRanges: [],
          slashCommandRanges: [],
        },
        files: [{
          id: 'new-file',
          name: 'new.png',
          path: 'C:\\images\\new.png',
          ext: 'png',
          size: 1,
          category: 'image',
          mimeType: 'image/png',
        }],
      }),
    ).rejects.toThrow('update-content unavailable');
    expect(input.updateText).not.toHaveBeenCalled();
  });

  it('supports attachment-only queue edits and rejects a fully empty replacement', async () => {
    const sid = `attachment-only-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-attachment-only', '');
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));

    const content = {
      text: '',
      mentions: [],
      hasQuotes: false,
      agentReferences: [],
      pastedTextRanges: [],
      slashCommandRanges: [],
    };
    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content,
      files: [
        {
          id: 'only-image',
          name: 'only.png',
          path: 'C:\\images\\only.png',
          ext: 'png',
          size: 1,
          category: 'image',
          mimeType: 'image/png',
          url: 'xdt-image://session/only.png',
        },
      ],
    });
    expect(saved).toBe(true);

    input.updateContent.mockClear();
    const rejected = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content,
      files: [],
    });
    expect(rejected).toBe(false);
    expect(input.updateContent).not.toHaveBeenCalled();
  });

  it('keeps an unchanged queued image in place instead of copying its shared draft view', async () => {
    const sid = `existing-image-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-existing-image', 'keep image');
    const existingImage = {
      id: 'existing-image',
      name: 'existing.png',
      path: 'C:\\images\\existing.png',
      ext: 'png',
      size: 10,
      category: 'image' as const,
      mimeType: 'image/png',
      url: 'xdt-image://session/existing.png',
    };
    item.files = [{ ...existingImage, pathOrigin: 'desktop-host' }];
    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: item.text,
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [{ ...existingImage, cacheUrlShared: true, stagedPathShared: true }],
    });

    expect(saved).toBe(true);
    expect(cacheMediaForSession).not.toHaveBeenCalled();
    expect(input.updateContent).toHaveBeenCalledWith(
      sid,
      item.clientId,
      expect.objectContaining({
        files: [expect.objectContaining({ url: existingImage.url })],
      }),
    );
  });

  it('keeps queue controls on the sticky remote device while the live mirror is rebuilding', async () => {
    const sid = `sticky-row-${Math.random().toString(36).slice(2, 8)}`;
    const deviceId = 'dev-sticky';
    remoteProjectsStore.setDeviceSessions(deviceId, 'Remote Mac', [
      { id: sid } as never,
    ]);
    expect(getStickySessionDeviceId(sid)).toBe(deviceId);
    remoteProjectsStore.clear();
    remoteInvoke.mockResolvedValue(projection(sid, { queueExpanded: true }));

    makerChatStore.setQueueExpanded(sid, true);
    await flushPromises();

    expect(remoteInvoke).toHaveBeenCalledWith(deviceId, 'maker:input:set-expanded', [sid, true]);
    expect(input.setExpanded).not.toHaveBeenCalled();
  });

  it('preserves queued source device hints while editing an anchored link', async () => {
    const sid = `row-ref-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-ref', 'compare cindy://session/source?message=old-anchor');
    item.sessionRefs = [{ sessionId: 'source', messageClientId: 'old-anchor', deviceId: 'source-device' }];

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));
    makerChatStore.updateQueueItem(sid, item.clientId, 'edited cindy://session/source?message=new-anchor');
    await flushPromises();

    expect(input.updateText).toHaveBeenCalledWith(sid, item.clientId, expect.any(String), [{
      sessionId: 'source',
      messageClientId: 'new-anchor',
      deviceId: 'source-device',
    }]);
  });

  it('preserves queued source device hints in composer queue edits', async () => {
    const sid = `content-ref-${Math.random().toString(36).slice(2, 8)}`;
    const item = queued('q-content-ref', 'compare cindy://session/source?message=old-anchor');
    item.sessionRefs = [
      { sessionId: 'source', messageClientId: 'old-anchor', deviceId: 'source-device' },
    ];

    makerChatStore.initGlobalListeners();
    projectionHandler?.(projection(sid, { pendingQueue: [item] }));

    const saved = await makerChatStore.updateQueueItemContent(sid, item.clientId, {
      content: {
        text: 'edited cindy://session/source?message=new-anchor',
        mentions: [],
        hasQuotes: false,
        agentReferences: [],
        pastedTextRanges: [],
        slashCommandRanges: [],
      },
      files: [],
    });

    expect(saved).toBe(true);
    expect(input.updateContent).toHaveBeenCalledWith(
      sid,
      item.clientId,
      expect.objectContaining({
        sessionRefs: [
          {
            sessionId: 'source',
            messageClientId: 'new-anchor',
            deviceId: 'source-device',
          },
        ],
      }),
    );
  });

  it('delegates composer steer, stop, resume and retry to main input intents', async () => {
    const sid = `intents-${Math.random().toString(36).slice(2, 8)}`;

    const ok = await makerChatStore.steerMessage(sid, 'interrupt me', MODEL, EFFORT, PERM, WD);
    makerChatStore.stopSession(sid, { keepQueue: true, pauseQueue: true });
    makerChatStore.resumeQueue(sid);
    makerChatStore.retryLastError(sid);
    makerChatStore.clearError(sid);
    await flushPromises();

    expect(ok).toBe(true);
    expect(input.steer).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({ text: 'interrupt me' }),
      { touchUserSend: true },
    );
    expect(input.stop).toHaveBeenCalledWith(sid, { keepQueue: true, pauseQueue: true });
    expect(input.resume).toHaveBeenCalledWith(sid);
    expect(input.retryLastError).toHaveBeenCalledWith(sid);
    expect(input.clearError).toHaveBeenCalledWith(sid);
    expect(legacySend).not.toHaveBeenCalled();
    expect(legacySteer).not.toHaveBeenCalled();
  });

  it('settles a materialized composer steer as handled so the composer draft clears', async () => {
    // review #939 第五轮:投递结果不确定时 coordinator 把 composer 插话物化进
    // 暂停队列;steer IPC 返回 false 但文本已由队列行接管,steerMessage 必须
    // 按"已处置"返回 true,否则草稿保留 + 暂停行并存,再发送会双份消费。
    const sid = `steer-materialized-${Math.random().toString(36).slice(2, 8)}`;
    input.steer.mockResolvedValueOnce(false);
    input.getProjection.mockImplementationOnce(async (sessionId: string) => {
      const steered = (input.steer.mock.calls.at(-1) as unknown as [string, AgentInputQueuedMessage, unknown])[1];
      return projection(sessionId, {
        pendingQueue: [steered],
        queuePaused: true,
        error: 'Codex turn/steer did not acknowledge within 10000ms',
      });
    });

    const ok = await makerChatStore.steerMessage(sid, 'uncertain text', MODEL, EFFORT, PERM, WD);
    await flushPromises();

    expect(ok).toBe(true);
  });

  it('keeps a plainly failed composer steer as unhandled so the draft is preserved', async () => {
    const sid = `steer-plain-fail-${Math.random().toString(36).slice(2, 8)}`;
    input.steer.mockResolvedValueOnce(false);

    const ok = await makerChatStore.steerMessage(sid, 'failed text', MODEL, EFFORT, PERM, WD);
    await flushPromises();

    expect(ok).toBe(false);
  });
});
