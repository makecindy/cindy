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
import type {
  AgentInputProjection,
  AgentInputQueuedMessage,
} from '../../shared/agentInputQueue';

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

let projectionHandler: ((projection: AgentInputProjection) => void) | null = null;
let messageCreatedHandler: ((payload: unknown) => void) | null = null;

const legacySend = vi.fn(async () => {});
const legacySteer = vi.fn(async () => {});
const generateTitle = vi.fn(async () => ({ title: 't' }));

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

function queued(clientId: string, text: string): AgentInputQueuedMessage {
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
  };
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  makerChatStore.__teardownGlobalListeners();
  installElectronBridge();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
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
