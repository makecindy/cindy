import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/ccAgent.types';
import type { AgentInputProjection } from '../../shared/agentInputQueue';
import { makerChatStore } from '@/lib/makerChatStore';
import { getDraft, saveDraft, setComposerDraftOwner } from '@/lib/composerDraftStore';
import { setDataOwnerGeneration, __testing as ownerTesting } from '@/contexts/dataOwnerGeneration';
import * as messageService from '@/lib/messageService';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []), create: vi.fn(), updateContent: vi.fn(),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({ agentKind: 'cc', remoteHostId: null, sdkSessionId: null })),
  update: vi.fn(), touchUserSend: vi.fn(),
}));

// Unit, real chat and draft stores with the preload boundary controlled. Existing
// Device Link tests don't exercise a local Host's missed terminal event. No real
// timers, accounts or model execution. Assert visible state, not source patterns.
// Measured standalone: 4 cases, 1.9 s total (11 ms test body).
const id = 'host-recovery-task';
const flush = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };
const projection = (): AgentInputProjection => ({
  sessionId: id, turnInProgress: false, pendingQueue: [], steeringQueueClientIds: [],
  queuePaused: false, queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [],
  queueAbortPending: false, error: null, recovery: null, errorRetryText: null, credentialSwitchWait: null,
});
const row = (content: string): Message => ({
  id: 'row-1', clientId: 'client-1', sessionId: id, role: 'assistant', content,
  createdAt: '2026-11-10T00:00:00Z', toolUseId: null, agentMeta: null,
});
let listeners: Record<string, (value: unknown) => void>;
let getProjection: ReturnType<typeof vi.fn>;
let pending: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
const subscribe = (name: string) => (cb: (value: unknown) => void) => {
  listeners[name] = cb;
  return () => { delete listeners[name]; };
};

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  ownerTesting.reset(); setDataOwnerGeneration('owner', 1); setComposerDraftOwner('owner');
  makerChatStore.__teardownGlobalListeners(); makerChatStore.purgeSession(id);
  listeners = {};
  getProjection = vi.fn(async () => projection()); pending = vi.fn(async () => []); send = vi.fn();
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: {
    maker: {
      input: { getProjection, enqueue: send }, getPendingInteractions: pending, send,
      onEvent: subscribe('event'), onStatusChanged: subscribe('status'),
      onInputProjection: subscribe('projection'), onInteractionRequest: subscribe('interaction'),
      onInteractionDismissed: subscribe('dismissed'),
    },
    localDb: { messages: { onCreated: subscribe('message') } },
  } });
  vi.mocked(messageService.list).mockResolvedValue([row('before disconnect')]);
  makerChatStore.initGlobalListeners();
});
afterEach(() => {
  makerChatStore.__teardownGlobalListeners(); makerChatStore.purgeSession(id);
  vi.unstubAllGlobals(); vi.useRealTimers(); ownerTesting.reset();
});
async function load() { makerChatStore.ensureInitialMessages(id); await flush(); }

it('repairs final history, queue and expired permissions while retaining the editor draft', async () => {
  await load();
  listeners.event({ sessionId: id, event: { type: 'status', data: { status: 'Running', isRunning: true } } });
  listeners.interaction({ sessionId: id, request: { kind: 'permission', requestId: 'old', toolName: 'Read', input: {} } });
  saveDraft(id, { text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'still editing' }] }] }, attachments: [] });
  const draft = getDraft(id);
  expect(makerChatStore.getSnapshot(id).pendingPermission).not.toBeNull();
  vi.mocked(messageService.list).mockResolvedValue([row('completed while disconnected')]);
  const queued = { clientId: 'queued-on-host', text: 'next', model: '', effort: '', permissionMode: '' };
  getProjection.mockResolvedValue({ ...projection(), pendingQueue: [queued], queuePaused: true });
  await makerChatStore.reconcileHostConnection(() => true);
  const state = makerChatStore.getSnapshot(id);
  expect(state.messages.find(m => m.clientId === 'client-1')?.content).toBe('completed while disconnected');
  expect(state.agentStatus.isRunning).toBe(false);
  expect(state.isStreaming).toBe(false);
  expect(state.pendingPermission).toBeNull();
  expect(state.pendingQueue.map(q => q.clientId)).toEqual(['queued-on-host']);
  expect(state.queuePaused).toBe(true);
  expect(getDraft(id)).toEqual(draft);
  expect(send).not.toHaveBeenCalled();
  expect(messageService.create).not.toHaveBeenCalled();
});

it('ignores old projection and history responses after another disconnect or owner change', async () => {
  await load();
  let resolve!: (value: AgentInputProjection) => void;
  getProjection.mockReturnValueOnce(new Promise<AgentInputProjection>(r => { resolve = r; }));
  let current = true;
  const first = makerChatStore.reconcileHostConnection(() => current);
  current = false;
  resolve({ ...projection(), error: 'stale failure' }); await first;
  expect(makerChatStore.getSnapshot(id).error).toBeNull();
  let finishHistory!: (value: Message[]) => void;
  vi.mocked(messageService.list).mockReturnValueOnce(new Promise(r => { finishHistory = r; }));
  const second = makerChatStore.reconcileHostConnection(() => true); await flush();
  setDataOwnerGeneration('another-owner', 2);
  finishHistory([row('wrong owner')]); await second;
  expect(makerChatStore.getSnapshot(id).messages.some(m => m.content === 'wrong owner')).toBe(false);
});

it('keeps a newer live turn and queue when recovery reads return late', async () => {
  await load();
  let resolve!: (value: AgentInputProjection) => void;
  getProjection.mockReturnValueOnce(new Promise<AgentInputProjection>(r => { resolve = r; }));
  const recovering = makerChatStore.reconcileHostConnection(() => true);
  listeners.projection({ ...projection(), turnInProgress: true, queuePaused: true });
  listeners.event({ sessionId: id, event: { type: 'status', data: { status: 'Running', isRunning: true } } });
  expect(makerChatStore.getSnapshot(id).agentStatus.isRunning).toBe(true);
  resolve(projection());
  await recovering;
  expect(makerChatStore.getSnapshot(id).agentStatus.isRunning).toBe(true);
  expect(makerChatStore.getSnapshot(id).queuePaused).toBe(true);
});

it('retries the real read path after an initial history failure without reloading the editor', async () => {
  vi.mocked(messageService.list).mockRejectedValueOnce(new Error('offline'));
  const leave = makerChatStore.enterView(id);
  await load();
  expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(false);
  await makerChatStore.reconcileHostConnection(() => true);
  expect(makerChatStore.getSnapshot(id).historyLoaded).toBe(true);
  expect(makerChatStore.getSnapshot(id).messages.find(m => m.clientId === 'client-1')?.content).toBe('before disconnect');
  leave();
});
