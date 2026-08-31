import { describe, expect, it } from 'vitest';

import {
  acceptSteerDeliveryState,
  beginSteerDeliveryState,
  canStartComposerSteer,
  canStartQueuedSteer,
  clearRetryErrorState,
  failSteerDeliveryState,
  getDrainableQueueHead,
  isDispatchBoundaryBusy,
  isQueuePausedWithPending,
  isSendBusyForQueue,
  QUEUE_TRANSACTION_CONTRACT,
  removeFromQueueState,
  rollbackPreAcceptSendFailure,
  stopQueueState,
} from '@/lib/makerQueueState';
import type {
  AgentStatus,
  ChatMessage,
  QueuedMessage,
  SessionChatState,
} from '@/lib/makerChatStore';

const agentStatus = (running = false): AgentStatus => ({
  status: running ? 'Running' : 'Idle',
  tokenUsage: 0,
  costUsd: 0,
  contextTokens: 0,
  contextWindow: 0,
  isRunning: running,
  startedAt: running ? Date.now() : null,
});

const queued = (id: string, text = id): QueuedMessage => ({
  clientId: id,
  text,
  persistedContent: JSON.stringify({ text }),
  model: 'claude-opus-4-7',
  effort: 'medium',
  permissionMode: 'default',
  workingDir: 'C:\\workspace',
  createOpts: {
    agentKind: 'claude-code',
    workingDir: 'C:\\workspace',
    model: 'claude-opus-4-7',
    effort: 'medium',
    permissionMode: 'default',
  },
  chatMessage: {
    clientId: id,
    role: 'user',
    content: text,
    createdAt: `2026-06-07T00:00:0${id.length}.000Z`,
  },
});

const userMessage = (id: string, text = id): ChatMessage => ({
  clientId: id,
  role: 'user',
  content: text,
  createdAt: '2026-06-07T00:00:00.000Z',
});

const state = (overrides: Partial<SessionChatState> = {}): SessionChatState => ({
  agentKind: 'claude-code',
  agentSwitchIntent: null,
  agentSwitchIntentRev: 0,
  remoteHostId: null,
  messages: [],
  isStreaming: false,
  agentStatus: agentStatus(false),
  error: null,
  recoverableError: null,
  inputRecovery: null,
  activeTurnRetryText: null,
  errorRetryText: null,
  errorPersistId: null,
  disposedErrorPersistId: null,
  credentialSwitchWait: null,
  continuationInFlightClientId: null,
  continuationTurnClientId: null,
  continuationInFlightProjectionCapability: 'unknown',
  isLoadingMore: false,
  hasMoreMessages: false,
  isFirstMessage: false,
  streamingClientId: null,
  streamingText: '',
  oldestMessageId: null,
  historyLoaded: true,
  sdkSessionId: null,
  pendingPermission: null,
  pendingAskUser: null,
  askUserViewerState: 'expanded',
  askUserDraft: null,
  pendingPluginSetup: null,
  pendingPluginSetupQueue: [],
  pluginSetupViewerState: 'expanded',
  pluginSetupCommandInFlight: null,
  pendingPlanReview: null,
  pendingIssueConfirm: null,
  pendingRenameSessionsConfirm: null,
  pendingGhostGrantConfirm: null,
  planViewerState: 'expanded',
  lastExpandedPlanViewerState: 'expanded',
  pendingQueue: [],
  steeringQueueClientIds: [],
  queuePaused: false,
  queueInteractionLocks: [],
  queueEditLocks: [],
  queueAbortPending: false,
  queueExpanded: false,
  fastMode: false,
  planModeEnabled: false,
  planModeRev: 0,
  lastStopWasSideTask: false,
  pendingTaskWake: 0,
  pendingTaskWakeDuringTurn: 0,
  pendingTaskWakeStarted: false,
  pendingTaskWakeArmedAt: null,
  pendingTaskWakeGen: 0,
  turnStoppedByUser: false,
  lastAgentMeta: null,
  ...overrides,
  pendingRemoteDesktopConfirmation: overrides.pendingRemoteDesktopConfirmation ?? null,
  pendingRemoteDesktopConfirmationQueue:
    overrides.pendingRemoteDesktopConfirmationQueue ?? [],
});

describe('makerQueueState', () => {
  it('documents the transaction contract for every queue entry path', () => {
    expect(QUEUE_TRANSACTION_CONTRACT.map((row) => row.path).sort()).toEqual([
      'close',
      'remove',
      'retry',
      'send',
      'steer',
      'stop',
    ]);

    for (const row of QUEUE_TRANSACTION_CONTRACT) {
      expect(row.queue).not.toHaveLength(0);
      expect(row.bubble).not.toHaveLength(0);
      expect(row.db).not.toHaveLength(0);
      expect(row.agentAccepted).not.toHaveLength(0);
      expect(row.preAcceptFailure).not.toHaveLength(0);
      expect(row.drainBoundary).not.toHaveLength(0);
    }
  });

  it('treats abort lock as busy even when the visible queue was emptied', () => {
    const s = state({ queueAbortPending: true, pendingQueue: [] });

    expect(isSendBusyForQueue(s)).toBe(true);
    expect(getDrainableQueueHead(s)).toBeNull();
  });

  it('treats pending steer markers as busy for new sends', () => {
    const s = state({ steeringQueueClientIds: ['steer-1'] });

    expect(isDispatchBoundaryBusy(s)).toBe(true);
    expect(isSendBusyForQueue(s)).toBe(true);
    expect(
      getDrainableQueueHead(
        state({
          pendingQueue: [queued('next')],
          steeringQueueClientIds: ['steer-1'],
        }),
      ),
    ).toBeNull();
  });

  it('pauses an idle blocked queue without installing an abort lock that no event can release', () => {
    const head = queued('head');
    const s = state({
      pendingQueue: [head],
      queueEditLocks: [head.clientId],
      agentStatus: agentStatus(false),
      isStreaming: false,
    });

    const next = stopQueueState(s, s.messages, { keepQueue: true, pauseQueue: true });

    expect(next.queuePaused).toBe(true);
    expect(next.queueAbortPending).toBe(false);
    expect(next.pendingQueue.map((q) => q.clientId)).toEqual([head.clientId]);
  });

  it('installs an abort lock when Stop has an in-flight steer boundary to wait for', () => {
    const head = queued('head');
    const s = state({
      pendingQueue: [head],
      steeringQueueClientIds: ['steer-1'],
    });

    const next = stopQueueState(s, s.messages, { keepQueue: true, pauseQueue: true });

    expect(next.queuePaused).toBe(true);
    expect(next.queueAbortPending).toBe(true);
    expect(next.steeringQueueClientIds).toEqual([]);
  });

  it('drains rows before an edited row but blocks once the edited row reaches the head', () => {
    const first = queued('first');
    const second = queued('second');

    expect(
      getDrainableQueueHead(
        state({
          pendingQueue: [first, second],
          queueEditLocks: [second.clientId],
        }),
      ),
    ).toBe(first);

    expect(
      getDrainableQueueHead(
        state({
          pendingQueue: [second],
          queueEditLocks: [second.clientId],
        }),
      ),
    ).toBeNull();
  });

  it('requeues a pre-accept failed head in front of tail rows and keeps a retry token', () => {
    const failed = queued('failed', '');
    const tail = queued('tail');
    const s = state({
      messages: [userMessage(failed.clientId, '')],
      pendingQueue: [tail],
      isStreaming: true,
    });

    const next = rollbackPreAcceptSendFailure(s, failed, 'send failed', { shiftQueueHead: true });

    expect(next.error).toBe('send failed');
    expect(next.errorRetryText).toBe(`__xdt_queue_retry__:${failed.clientId}`);
    expect(next.messages).toHaveLength(0);
    expect(next.pendingQueue.map((q) => q.clientId)).toEqual(['failed', 'tail']);
    expect(next.isStreaming).toBe(false);
  });

  it('keeps retry as a queue-head transaction instead of a new send', () => {
    const failed = queued('failed', 'retry me');
    const s = state({
      error: 'send failed',
      errorRetryText: failed.text,
      pendingQueue: [failed],
    });

    const next = clearRetryErrorState(s);

    expect(next.error).toBeNull();
    expect(next.errorRetryText).toBeNull();
    expect(next.pendingQueue.map((q) => q.clientId)).toEqual([failed.clientId]);
  });

  it('removes optimistic steer bubbles on Stop while preserving the paused queue', () => {
    const queuedRow = queued('queued-row');
    const composerSteer = queued('composer-steer');
    const s = state({
      messages: [userMessage('old'), composerSteer.chatMessage],
      pendingQueue: [queuedRow],
      steeringQueueClientIds: [composerSteer.clientId],
      queueInteractionLocks: ['drag'],
      queueEditLocks: [queuedRow.clientId],
    });

    const next = stopQueueState(s, s.messages, { keepQueue: true, pauseQueue: true });

    expect(next.messages.map((m) => m.clientId)).toEqual(['old']);
    expect(next.pendingQueue.map((q) => q.clientId)).toEqual([queuedRow.clientId]);
    expect(next.steeringQueueClientIds).toEqual([]);
    expect(next.queuePaused).toBe(true);
    expect(next.queueAbortPending).toBe(true);
    expect(next.queueInteractionLocks).toEqual(['drag']);
    expect(next.queueEditLocks).toEqual([queuedRow.clientId]);
  });

  it('rolls back failed steers without removing the queued row or persisting the bubble', () => {
    const first = queued('first');
    const second = queued('second');
    const inFlight = beginSteerDeliveryState(
      state({ pendingQueue: [first, second] }),
      first,
      '2026-06-07T01:02:03.000Z',
    );

    const failed = failSteerDeliveryState(inFlight, first, 'steer failed');

    expect(failed.error).toBe('steer failed');
    expect(failed.steeringQueueClientIds).toEqual([]);
    expect(failed.messages.map((m) => m.clientId)).toEqual([]);
    expect(failed.pendingQueue.map((q) => q.clientId)).toEqual([first.clientId, second.clientId]);
  });

  it('serializes queued-row steers per session and removes the row only after success', () => {
    const first = queued('first');
    const second = queued('second');
    const deliveryCreatedAt = '2026-06-07T01:02:03.000Z';
    const inFlight = beginSteerDeliveryState(
      state({ pendingQueue: [first, second] }),
      first,
      deliveryCreatedAt,
    );

    expect(canStartQueuedSteer(inFlight, second.clientId)).toBe(false);
    expect(canStartComposerSteer(inFlight)).toBe(false);
    expect(inFlight.messages.map((m) => m.clientId)).toEqual([first.clientId]);
    expect(inFlight.messages[0]?.createdAt).toBe(deliveryCreatedAt);
    expect(inFlight.pendingQueue.map((q) => q.clientId)).toEqual([first.clientId, second.clientId]);

    const accepted = acceptSteerDeliveryState(inFlight, first, { removeFromQueue: true });

    expect(accepted.steeringQueueClientIds).toEqual([]);
    expect(accepted.pendingQueue.map((q) => q.clientId)).toEqual([second.clientId]);
    expect(accepted.messages.map((m) => m.clientId)).toEqual([first.clientId]);
  });

  it('blocks new steers while a queue abort boundary is pending', () => {
    const first = queued('first');
    const s = state({
      pendingQueue: [first],
      queueAbortPending: true,
    });

    expect(canStartQueuedSteer(s, first.clientId)).toBe(false);
    expect(canStartComposerSteer(s)).toBe(false);
  });

  it('remove only affects undispatched queue rows and leaves accepted bubbles alone', () => {
    const first = queued('first');
    const second = queued('second');
    const s = state({
      messages: [userMessage('accepted')],
      pendingQueue: [first, second],
    });

    const next = removeFromQueueState(s, first.clientId);

    expect(next.messages.map((m) => m.clientId)).toEqual(['accepted']);
    expect(next.pendingQueue.map((q) => q.clientId)).toEqual([second.clientId]);
  });

  it('clears stale retry state when removing the failed restored queue head', () => {
    const failed = queued('failed', '');
    const second = queued('second');
    const s = state({
      error: 'send failed',
      errorRetryText: '__xdt_queue_retry__:failed',
      pendingQueue: [failed, second],
      queuePaused: true,
    });

    const next = removeFromQueueState(s, failed.clientId);

    expect(next.error).toBeNull();
    expect(next.errorRetryText).toBeNull();
    expect(next.pendingQueue.map((q) => q.clientId)).toEqual([second.clientId]);
    expect(next.queuePaused).toBe(true);
  });
});

describe('isQueuePausedWithPending', () => {
  it('is true only when the queue is paused AND has pending messages', () => {
    expect(
      isQueuePausedWithPending(state({ queuePaused: true, pendingQueue: [queued('a')] })),
    ).toBe(true);
  });

  it('is false when the queue is paused but empty', () => {
    expect(isQueuePausedWithPending(state({ queuePaused: true, pendingQueue: [] }))).toBe(false);
  });

  it('is false when there are pending messages but the queue is not paused (it is draining)', () => {
    expect(
      isQueuePausedWithPending(state({ queuePaused: false, pendingQueue: [queued('a')] })),
    ).toBe(false);
  });

  it('is false for a fresh/idle session', () => {
    expect(isQueuePausedWithPending(state())).toBe(false);
  });
});
