import type { SessionSendOptions, SessionSendResult, UserMessage } from '@cindy/maker-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  createOrcaInterAgentDispatcher,
  type OrcaInterAgentDispatcherDeps,
} from '../orcaInterAgentDispatcher.js';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mocks.logger,
}));

interface TestSessionMeta {
  agentKind: 'codex';
  workDir: string;
  model: string;
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createLiveSession(
  send: (message: UserMessage, opts?: SessionSendOptions) => Promise<SessionSendResult>,
) {
  return {
    id: 'target-session',
    agentKind: 'codex' as const,
    isTurnRunning: vi.fn(() => false),
    send: vi.fn(send),
  };
}

function createHarness(overrides: Partial<OrcaInterAgentDispatcherDeps<TestSessionMeta>> = {}) {
  const order: string[] = [];
  const queuedItems: AgentInputQueuedMessage[] = [];
  const createOpts = {
    agentKind: 'codex' as const,
    workingDir: 'C:\\repo',
    model: 'gpt-5.4',
    permissionMode: 'bypassPermissions',
  };
  const meta: TestSessionMeta = {
    agentKind: 'codex',
    workDir: 'C:\\repo',
    model: 'gpt-5.4',
  };
  const dbRow = {
    title: 'Target Session',
    status: 'active',
    userSendAt: Date.parse('2026-06-12T01:02:03.000Z'),
  };
  const liveSession = createLiveSession(async (_message, opts) => {
    order.push('send-called');
    await opts?.onAccepted?.();
    opts?.onDispatching?.();
    const releaseVendorDispatchLease = await opts?.acquireVendorDispatchLease?.();
    try {
      order.push('vendor-released');
      return { accepted: true };
    } finally {
      await releaseVendorDispatchLease?.();
    }
  });
  const deps: OrcaInterAgentDispatcherDeps<TestSessionMeta> = {
    createId: vi.fn(() => 'client-1'),
    getSessionMeta: vi.fn(async () => meta),
    getSessionRowSnapshot: vi.fn(async () => dbRow),
    getLiveSession: vi.fn(() => liveSession),
    shouldQueueNewTurn: vi.fn(() => false),
    hasSendToSessionLock: vi.fn(() => false),
    buildCreateOptsForQueuedSession: vi.fn(async () => createOpts),
    enqueueQueuedMessage: vi.fn((_sessionId, item) => {
      queuedItems.push(item);
    }),
    sendToSessionInternal: vi.fn(async () => ({
      ok: true,
      targetSessionId: 'target-session',
      agentKind: 'codex',
      wakeKind: 'resumed',
      targetTitle: dbRow.title,
      targetLastUserSendAt: new Date(dbRow.userSendAt).toISOString(),
    } as const)),
    createDbMessage: vi.fn(async () => {
      order.push('db');
    }),
    rewindPersistedUserMessage: vi.fn(async () => {
      order.push('rewind-user-row');
    }),
    retainPersistedUserMessageCleanup: vi.fn(() => {}),
    trackPersistedUserMessageBeforeVendorDispatch: vi.fn(() => {}),
    untrackPersistedUserMessageBeforeVendorDispatch: vi.fn(() => {}),
    beginDirectTurnChangeSet: vi.fn(async () => {
      order.push('change-set');
    }),
    abortDirectTurnChangeSet: vi.fn(() => {
      order.push('abort-change-set');
    }),
    isOrcaTeamActive: vi.fn(async () => true),
    reserveOrcaTeamPreVendorDispatch: vi.fn(() => vi.fn()),
    waitForOrcaTeamTerminalTransition: vi.fn(async () => 'open' as const),
    acquireVendorDispatchLease: vi.fn(async () => vi.fn()),
    resolveWorkerSenderLabel: vi.fn(async (_workerId, fallback) => fallback),
    isSessionRunningError: vi.fn((err) =>
      err instanceof Error && (err as { code?: string }).code === 'SESSION_RUNNING'
    ),
    log: mocks.logger,
    ...overrides,
  };
  const dispatcher = createOrcaInterAgentDispatcher(deps);
  return { dispatcher, deps, order, queuedItems, liveSession };
}

function firstQueuedItem(items: AgentInputQueuedMessage[]): AgentInputQueuedMessage {
  const item = items[0];
  expect(item).toBeDefined();
  if (!item) throw new Error('expected a queued item');
  return item;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Orca lead/worker dispatcher', () => {
  it('runs direct accepted side effects after DB persistence and before vendor turn release', async () => {
    const h = createHarness();

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Implement feature',
      source: 'lead',
      senderLabel: 'Lead',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'direct-test' },
      onAccepted: async () => {
        h.order.push('accepted');
      },
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dispatched',
      clientId: 'client-1',
      dispatchOutcome: { kind: 'session-dispatch', source: 'orca', dispatched: true },
      targetTitle: 'Target Session',
      targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
    });
    expect(h.order).toEqual(['send-called', 'db', 'change-set', 'accepted', 'vendor-released']);
    expect(h.deps.beginDirectTurnChangeSet).toHaveBeenCalledWith('target-session', 'client-1');
    expect(h.deps.abortDirectTurnChangeSet).not.toHaveBeenCalled();
    expect(h.deps.rewindPersistedUserMessage).not.toHaveBeenCalled();
    expect(h.deps.trackPersistedUserMessageBeforeVendorDispatch).toHaveBeenCalledWith(
      'target-session',
      expect.objectContaining({
        clientId: 'client-1',
        origin: expect.objectContaining({ kind: 'orca', teamId: 'team-1' }),
      }),
    );
    expect(h.deps.untrackPersistedUserMessageBeforeVendorDispatch).toHaveBeenCalledWith(
      'client-1',
    );
    expect(h.deps.createDbMessage).toHaveBeenCalledWith('target-session', {
      clientId: 'client-1',
      role: 'user',
      content: '{"orcaSource":"lead","content":"Implement feature"}',
    });
    expect(h.liveSession.send).toHaveBeenCalledWith(
      {
        type: 'user',
        content:
          '[From Orca Lead]\nImplement feature\n\n---\n(Bridge note: your worker_id for tool calls is worker-1.)',
      },
      expect.objectContaining({ throwOnStartFailure: true }),
    );
  });

  it('holds the cross-process lease across the live-direct vendor boundary', async () => {
    const leaseRelease = vi.fn(() => {
      h.order.push('lease-release');
    });
    const acquireVendorDispatchLease = vi.fn(async (teamId: string) => {
      h.order.push(`lease-acquire:${teamId}`);
      return leaseRelease;
    });
    const h = createHarness({ acquireVendorDispatchLease });

    await expect(h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Dispatch under the durable lease',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'direct-lease-test' },
    })).resolves.toMatchObject({ ok: true, mode: 'dispatched' });

    expect(h.order).toEqual([
      'send-called',
      'db',
      'change-set',
      'lease-acquire:team-1',
      'vendor-released',
      'lease-release',
    ]);
    expect(acquireVendorDispatchLease).toHaveBeenCalledWith('team-1');
    expect(leaseRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps cleanup tracking until the provider dispatch lease is acquired', async () => {
    const leaseEntered = deferredVoid();
    const allowLease = deferredVoid();
    const releaseLease = vi.fn();
    const lifecycle: string[] = [];
    const h = createHarness({
      trackPersistedUserMessageBeforeVendorDispatch: vi.fn(() => {
        lifecycle.push('tracked');
      }),
      untrackPersistedUserMessageBeforeVendorDispatch: vi.fn(() => {
        lifecycle.push('untracked');
      }),
      acquireVendorDispatchLease: vi.fn(async () => {
        lifecycle.push('lease-entered');
        leaseEntered.resolve();
        await allowLease.promise;
        lifecycle.push('lease-acquired');
        return releaseLease;
      }),
    });

    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Retain cleanup intent across lease acquisition',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'cleanup-lease-race-test' },
    });

    await leaseEntered.promise;
    expect(lifecycle).toEqual(['tracked', 'lease-entered']);

    allowLease.resolve();
    await expect(dispatch).resolves.toMatchObject({ ok: true, mode: 'dispatched' });
    expect(lifecycle).toEqual([
      'tracked',
      'lease-entered',
      'lease-acquired',
      'untracked',
    ]);
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('retains the team reservation and exposes direct accepted settlement to end_team', async () => {
    const acceptedEntered = deferredVoid();
    const acceptedRelease = deferredVoid();
    const releaseReservation = vi.fn();
    const reserveOrcaTeamPreVendorDispatch = vi.fn(() => releaseReservation);
    const h = createHarness({ reserveOrcaTeamPreVendorDispatch });

    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Long accepted hook',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'direct-settlement-test' },
      onAccepted: async () => {
        acceptedEntered.resolve();
        await acceptedRelease.promise;
      },
    });

    await acceptedEntered.promise;
    let endTeamWaitSettled = false;
    const endTeamWait = h.dispatcher.waitForTeamDispatchSettlements('team-1').then(() => {
      endTeamWaitSettled = true;
    });
    await Promise.resolve();

    expect(reserveOrcaTeamPreVendorDispatch).toHaveBeenCalledWith('team-1');
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(endTeamWaitSettled).toBe(false);

    acceptedRelease.resolve();
    await Promise.all([dispatch, endTeamWait]);
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(endTeamWaitSettled).toBe(true);
  });

  it('retains a direct send until a pending terminal transition rolls back', async () => {
    const transitionSettled = deferredVoid();
    const releaseReservation = vi.fn();
    const reserveOrcaTeamPreVendorDispatch = vi
      .fn<() => () => void>()
      .mockImplementationOnce(() => {
        throw new Error(
          '[PRECONDITION_FAILED] ORCA_TEAM_TERMINATING: team team-1 terminal transition is still pending',
        );
      })
      .mockImplementationOnce(() => releaseReservation);
    const waitForOrcaTeamTerminalTransition = vi.fn(async () => {
      await transitionSettled.promise;
      return 'open' as const;
    });
    const h = createHarness({
      reserveOrcaTeamPreVendorDispatch,
      waitForOrcaTeamTerminalTransition,
    });

    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Do not lose this message',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'pending-terminal-rollback-test' },
    });
    await Promise.resolve();

    expect(waitForOrcaTeamTerminalTransition).toHaveBeenCalledWith('team-1');
    expect(h.liveSession.send).not.toHaveBeenCalled();

    transitionSettled.resolve();
    await expect(dispatch).resolves.toMatchObject({ ok: true, mode: 'dispatched' });
    expect(reserveOrcaTeamPreVendorDispatch).toHaveBeenCalledTimes(2);
    expect(h.liveSession.send).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledTimes(1);
  });

  it('rejects a retained direct send when the pending terminal transition commits', async () => {
    const h = createHarness({
      reserveOrcaTeamPreVendorDispatch: vi.fn(() => {
        throw new Error(
          '[PRECONDITION_FAILED] ORCA_TEAM_TERMINATING: team team-1 terminal transition is still pending',
        );
      }),
      waitForOrcaTeamTerminalTransition: vi.fn(async () => 'terminal' as const),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Do not dispatch after commit',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'pending-terminal-commit-test' },
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        code: 'SEND_FAILED',
        message: 'ORCA_TEAM_INACTIVE: team team-1 has already ended',
      },
    });
    expect(h.liveSession.send).not.toHaveBeenCalled();
  });

  it('retries a queued send when its final pending fence rolls back', async () => {
    let fenceAttempt = 0;
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      createId: vi
        .fn<() => string>()
        .mockReturnValueOnce('client-queued-pending')
        .mockReturnValueOnce('client-queued-retry'),
      assertOrcaTeamActiveBeforeVendorDispatch: vi.fn(() => {
        fenceAttempt += 1;
        if (fenceAttempt === 1) {
          throw new Error(
            '[PRECONDITION_FAILED] ORCA_TEAM_TERMINATING: team team-1 terminal transition is still pending',
          );
        }
      }),
      waitForOrcaTeamTerminalTransition: vi.fn(async () => 'open' as const),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queue after rollback',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-pending-rollback-test' },
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'queued',
      clientId: 'client-queued-retry',
    });
    expect(h.queuedItems.map((item) => item.clientId)).toEqual(['client-queued-retry']);
    expect(h.deps.waitForOrcaTeamTerminalTransition).toHaveBeenCalledWith('team-1');
  });

  it('retries a resumed send when its pending terminal failure rolls back', async () => {
    const sendToSessionInternal = vi
      .fn<OrcaInterAgentDispatcherDeps<TestSessionMeta>['sendToSessionInternal']>()
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'INTERNAL',
        message:
          '[PRECONDITION_FAILED] ORCA_TEAM_TERMINATING: team team-1 terminal transition is still pending',
      })
      .mockResolvedValueOnce({
        ok: true,
        targetSessionId: 'target-session',
        agentKind: 'codex',
        wakeKind: 'resumed',
        targetTitle: 'Target Session',
        targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
      });
    const h = createHarness({
      getLiveSession: vi.fn(() => null),
      createId: vi
        .fn<() => string>()
        .mockReturnValueOnce('client-resume-pending')
        .mockReturnValueOnce('client-resume-retry'),
      sendToSessionInternal,
      waitForOrcaTeamTerminalTransition: vi.fn(async () => 'open' as const),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Resume after rollback',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'resume-pending-rollback-test' },
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dispatched',
      clientId: 'client-resume-retry',
    });
    expect(sendToSessionInternal).toHaveBeenCalledTimes(2);
    expect(sendToSessionInternal.mock.calls[1]?.[0]).toMatchObject({
      clientId: 'client-resume-retry',
    });
  });

  it('exposes a pre-resume team reservation to end_team until explicitly released', async () => {
    const releaseReservation = vi.fn();
    const h = createHarness({
      reserveOrcaTeamPreVendorDispatch: vi.fn(() => releaseReservation),
    });

    const releaseSettlement = h.dispatcher.reserveTeamDispatchSettlement('team-1');
    let endTeamWaitSettled = false;
    const endTeamWait = h.dispatcher.waitForTeamDispatchSettlements('team-1').then(() => {
      endTeamWaitSettled = true;
    });
    await Promise.resolve();

    expect(endTeamWaitSettled).toBe(false);
    expect(releaseReservation).not.toHaveBeenCalled();

    releaseSettlement();
    await endTeamWait;
    expect(releaseReservation).toHaveBeenCalledOnce();
    expect(endTeamWaitSettled).toBe(true);
  });

  it('delays queued accepted side effects until the coordinator accepted hook runs', async () => {
    const accepted = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queued task',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-test' },
      onAccepted: accepted,
    });

    expect(result).toMatchObject({ ok: true, mode: 'queued' });
    expect(accepted).not.toHaveBeenCalled();
    expect(h.queuedItems).toHaveLength(1);
    expect(h.deps.beginDirectTurnChangeSet).not.toHaveBeenCalled();

    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', firstQueuedItem(h.queuedItems));

    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('discards queued accepted callbacks without rollback when the queued item never ran', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Discard me',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'discard-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    const queued = firstQueuedItem(h.queuedItems);
    h.dispatcher.discardQueuedOrcaInterAgentAcceptedCallback(queued.clientId);
    await h.dispatcher.rollbackQueuedOrcaInterAgentAcceptedCallback('target-session', queued.clientId);

    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not roll back direct dispatch failures before accepted runs', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async () => {
          h.order.push('send-called');
          return { accepted: false, reason: 'cancelled-before-dispatch' };
        })
      ),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Will fail before accepted',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'pre-accept-failure-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(h.order).toEqual(['send-called']);
    expect(h.deps.createDbMessage).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back direct accepted side effects when dispatch fails after accepted', async () => {
    const accepted = vi.fn(() => {
      h.order.push('accepted');
    });
    const rollback = vi.fn(() => {
      h.order.push('rollback');
    });
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async (_message, opts) => {
          h.order.push('send-called');
          await opts?.onAccepted?.();
          h.order.push('send-returned-cancelled');
          return { accepted: false, reason: 'cancelled-before-dispatch' };
        })
      ),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Will cancel',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'rollback-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(h.order).toEqual([
      'send-called',
      'db',
      'change-set',
      'accepted',
      'send-returned-cancelled',
      'abort-change-set',
      'rewind-user-row',
      'rollback',
    ]);
    expect(h.deps.abortDirectTurnChangeSet).toHaveBeenCalledWith('target-session');
    expect(h.deps.rewindPersistedUserMessage).toHaveBeenCalledWith(
      'target-session',
      'client-1',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('preserves the direct row and accepted state when provider acceptance is unconfirmed', async () => {
    const accepted = vi.fn(() => {
      h.order.push('accepted');
    });
    const rollback = vi.fn(() => {
      h.order.push('rollback');
    });
    const unconfirmed = new Error('provider response lost') as Error & { code?: string };
    unconfirmed.code = 'TURN_DISPATCH_UNCONFIRMED';
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async (_message, opts) => {
          h.order.push('send-called');
          await opts?.onAccepted?.();
          throw unconfirmed;
        })
      ),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Possibly accepted work',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'unconfirmed-direct-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        code: 'SEND_FAILED',
        dispatchUnconfirmed: true,
      },
    });
    expect(h.order).toEqual(['send-called', 'db', 'change-set', 'accepted']);
    expect(h.deps.abortDirectTurnChangeSet).not.toHaveBeenCalled();
    expect(h.deps.rewindPersistedUserMessage).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('preserves resumed-send accepted state when provider acceptance is unconfirmed', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const sendToSessionInternal = vi
      .fn<OrcaInterAgentDispatcherDeps<TestSessionMeta>['sendToSessionInternal']>()
      .mockImplementationOnce(async (params) => {
        await params.onAccepted?.();
        return {
          ok: false,
          errorCode: 'AGENT_NOT_READY',
          message: 'provider response lost',
          dispatchUnconfirmed: true,
        };
      });
    const h = createHarness({
      getLiveSession: vi.fn(() => null),
      sendToSessionInternal,
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Possibly accepted resumed work',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'unconfirmed-resumed-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        code: 'SEND_FAILED',
        dispatchUnconfirmed: true,
      },
    });
    expect(accepted).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rewinds the persisted direct user row when the final team fence cancels dispatch', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async (_message, opts) => {
          h.order.push('send-called');
          await opts?.onAccepted?.();
          opts?.onDispatching?.();
          return { accepted: true };
        })
      ),
      assertOrcaTeamActiveBeforeVendorDispatch: vi.fn(() => {
        throw new Error('ORCA_TEAM_INACTIVE: team team-1 has already ended');
      }),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Stale direct report',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'final-fence-rewind-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        code: 'SEND_FAILED',
        message: expect.stringContaining('failed before vendor dispatch'),
      },
    });
    expect(h.deps.rewindPersistedUserMessage).toHaveBeenCalledWith(
      'target-session',
      'client-1',
    );
    expect(h.deps.retainPersistedUserMessageCleanup).not.toHaveBeenCalled();
    expect(h.deps.untrackPersistedUserMessageBeforeVendorDispatch).toHaveBeenCalledWith(
      'client-1',
    );
    expect(h.order).toEqual([
      'send-called',
      'db',
      'change-set',
      'abort-change-set',
      'rewind-user-row',
    ]);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('returns a direct dispatch failure when the final-fence row rewind fails', async () => {
    const rollback = vi.fn();
    const cleanupPersisted = deferredVoid();
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async (_message, opts) => {
          await opts?.onAccepted?.();
          opts?.onDispatching?.();
          return { accepted: true };
        })
      ),
      assertOrcaTeamActiveBeforeVendorDispatch: vi.fn(() => {
        throw new Error('ORCA_TEAM_INACTIVE: team team-1 has already ended');
      }),
      rewindPersistedUserMessage: vi.fn(async () => {
        throw new Error('database busy');
      }),
      retainPersistedUserMessageCleanup: vi.fn(() => cleanupPersisted.promise),
    });

    let dispatchSettled = false;
    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Stale direct report',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'final-fence-rewind-failure-test' },
      onAcceptedRollback: rollback,
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(h.deps.retainPersistedUserMessageCleanup).toHaveBeenCalledOnce()
    );
    expect(dispatchSettled).toBe(false);

    cleanupPersisted.resolve();
    const result = await dispatch;

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        code: 'SEND_FAILED',
        message: 'database busy',
      },
    });
    expect(h.deps.rewindPersistedUserMessage).toHaveBeenCalledWith(
      'target-session',
      'client-1',
    );
    expect(h.deps.retainPersistedUserMessageCleanup).toHaveBeenCalledWith(
      'target-session',
      expect.objectContaining({
        clientId: 'client-1',
        origin: expect.objectContaining({ kind: 'orca', teamId: 'team-1' }),
      }),
      expect.objectContaining({ message: 'database busy' }),
    );
    expect(h.deps.untrackPersistedUserMessageBeforeVendorDispatch).toHaveBeenCalledWith(
      'client-1',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'direct Orca user row rewind failed',
      expect.objectContaining({ clientId: 'client-1', error: 'database busy' }),
    );
  });

  it('retries a direct send when a later pending terminal transition rolls back', async () => {
    const transitionSettled = deferredVoid();
    const accepted = vi.fn();
    const rollback = vi.fn();
    const releases = [vi.fn(), vi.fn()];
    let dispatchAttempt = 0;
    const liveSession = createLiveSession(async (_message, opts) => {
      await opts?.onAccepted?.();
      dispatchAttempt += 1;
      opts?.onDispatching?.();
      return { accepted: true };
    });
    const h = createHarness({
      createId: vi
        .fn<() => string>()
        .mockReturnValueOnce('client-pending')
        .mockReturnValueOnce('client-retry'),
      getLiveSession: vi.fn(() => liveSession),
      reserveOrcaTeamPreVendorDispatch: vi
        .fn<() => () => void>()
        .mockReturnValueOnce(releases[0])
        .mockReturnValueOnce(releases[1]),
      assertOrcaTeamActiveBeforeVendorDispatch: vi.fn(() => {
        if (dispatchAttempt === 1) {
          throw new Error(
            '[PRECONDITION_FAILED] ORCA_TEAM_TERMINATING: team team-1 terminal transition is still pending',
          );
        }
      }),
      waitForOrcaTeamTerminalTransition: vi.fn(async () => {
        await transitionSettled.promise;
        return 'open' as const;
      }),
    });

    let dispatchSettled = false;
    const dispatch = h.dispatcher
      .dispatchOrEnqueueOrcaInterAgentMessage({
        targetSessionId: 'target-session',
        teamId: 'team-1',
        rawContent: 'Retry after rollback',
        source: 'worker',
        senderLabel: 'Worker',
        meta: { source: 'orca', context: 'late-pending-rollback-test' },
        onAccepted: accepted,
        onAcceptedRollback: rollback,
      })
      .then((result) => {
        dispatchSettled = true;
        return result;
      });
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledOnce());

    expect(dispatchSettled).toBe(false);
    expect(h.deps.rewindPersistedUserMessage).toHaveBeenCalledWith(
      'target-session',
      'client-pending',
    );
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);

    transitionSettled.resolve();
    await expect(dispatch).resolves.toMatchObject({
      ok: true,
      mode: 'dispatched',
      clientId: 'client-retry',
    });
    expect(liveSession.send).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it('retries a direct send when the vendor lease detects a pending terminal transition', async () => {
    const transitionSettled = deferredVoid();
    const releaseLease = vi.fn();
    const acquireVendorDispatchLease = vi
      .fn<() => Promise<() => void>>()
      .mockRejectedValueOnce(new Error(
        'ORCA_TEAM_TERMINATING: team team-1 terminal transition is still pending',
      ))
      .mockResolvedValueOnce(releaseLease);
    const h = createHarness({
      createId: vi
        .fn<() => string>()
        .mockReturnValueOnce('client-lease-pending')
        .mockReturnValueOnce('client-lease-retry'),
      acquireVendorDispatchLease,
      waitForOrcaTeamTerminalTransition: vi.fn(async () => {
        await transitionSettled.promise;
        return 'open' as const;
      }),
    });

    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Retry after lease fence rollback',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'lease-pending-rollback-test' },
    });
    await vi.waitFor(() => {
      expect(h.deps.waitForOrcaTeamTerminalTransition).toHaveBeenCalledWith('team-1');
    });

    transitionSettled.resolve();
    await expect(dispatch).resolves.toMatchObject({
      ok: true,
      mode: 'dispatched',
      clientId: 'client-lease-retry',
    });
    expect(acquireVendorDispatchLease).toHaveBeenCalledTimes(2);
    expect(h.deps.rewindPersistedUserMessage).toHaveBeenCalledWith(
      'target-session',
      'client-lease-pending',
    );
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('does not retry a direct send when a later pending terminal transition commits', async () => {
    const releaseReservation = vi.fn();
    const liveSession = createLiveSession(async (_message, opts) => {
      await opts?.onAccepted?.();
      opts?.onDispatching?.();
      return { accepted: true };
    });
    const h = createHarness({
      getLiveSession: vi.fn(() => liveSession),
      reserveOrcaTeamPreVendorDispatch: vi.fn(() => releaseReservation),
      assertOrcaTeamActiveBeforeVendorDispatch: vi.fn(() => {
        throw new Error(
          '[PRECONDITION_FAILED] ORCA_TEAM_TERMINATING: team team-1 terminal transition is still pending',
        );
      }),
      waitForOrcaTeamTerminalTransition: vi.fn(async () => 'terminal' as const),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Stop after commit',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'late-pending-commit-test' },
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: { message: 'ORCA_TEAM_INACTIVE: team team-1 has already ended' },
    });
    expect(liveSession.send).toHaveBeenCalledTimes(1);
    expect(h.deps.rewindPersistedUserMessage).toHaveBeenCalledWith(
      'target-session',
      'client-1',
    );
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it('leaves lazy-resume turn capture to sendToSessionInternal', async () => {
    const h = createHarness({
      getLiveSession: vi.fn(() => null),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Resume target',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'resume-test' },
    });

    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(h.deps.sendToSessionInternal).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'target-session',
      clientId: 'client-1',
    }));
    expect(h.deps.beginDirectTurnChangeSet).not.toHaveBeenCalled();
    expect(h.deps.abortDirectTurnChangeSet).not.toHaveBeenCalled();
  });

  it('rolls back queued accepted side effects when dispatch settles as not dispatched', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queued failure',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-rollback-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      {
        kind: 'session-dispatch',
        source: 'maker-ipc',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'queued-rollback-test',
        message: 'Session send was cancelled before vendor dispatch: queued-rollback-test',
      },
    );

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('discards an unaccepted queued callback for a structured inactive-team failure', async () => {
    const accepted = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queued stale report',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'inactive-team-cleanup-test' },
      onAccepted: accepted,
    });

    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      {
        kind: 'session-dispatch',
        source: 'maker-ipc',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'ORCA_TEAM_INACTIVE/target-session/team-1',
        message: 'Session send was cancelled before vendor dispatch',
      },
    );

    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    expect(accepted).not.toHaveBeenCalled();
  });

  it('discards an unaccepted queued callback for a host-send inactive-team failure with [CODE] prefix', async () => {
    const accepted = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queued stale report',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'host-send-inactive-team-prefix-test' },
      onAccepted: accepted,
    });

    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      {
        kind: 'host-send',
        accepted: false,
        code: 'SEND_FAILED',
        message: '[PRECONDITION_FAILED] ORCA_TEAM_INACTIVE: team team-1 has already ended',
      },
    );

    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    expect(accepted).not.toHaveBeenCalled();
  });

  it('does not treat an incidental inactive-team substring as a lifecycle failure', async () => {
    const accepted = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queued retryable report',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'generic-cancellation-test' },
      onAccepted: accepted,
    });

    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      {
        kind: 'session-dispatch',
        source: 'maker-ipc',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'retry/ORCA_TEAM_INACTIVE/not-a-lifecycle-fence',
        message: 'Session send was cancelled before vendor dispatch',
      },
    );

    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('preserves an unexpected final-fence error instead of reporting an inactive team', async () => {
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      assertOrcaTeamActiveBeforeVendorDispatch: vi.fn(() => {
        throw new Error('unexpected lifecycle assertion failure');
      }),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queued report',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'final-fence-error-test' },
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        code: 'SEND_FAILED',
        message: 'unexpected lifecycle assertion failure',
      },
    });
    expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
  });

  it('preserves an enqueue failure and discards its unaccepted callback', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    let attemptedItem: AgentInputQueuedMessage | undefined;
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      enqueueQueuedMessage: vi.fn((_sessionId, item) => {
        attemptedItem = item;
        throw new Error('queue persistence unavailable');
      }),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      teamId: 'team-1',
      rawContent: 'Queued report',
      source: 'worker',
      senderLabel: 'Worker',
      meta: { source: 'orca', context: 'enqueue-error-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        code: 'SEND_FAILED',
        message: 'queue persistence unavailable',
      },
    });
    expect(attemptedItem).toBeDefined();
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      attemptedItem!,
    );
    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('returns receipt fields and preserves queued Orca origin metadata', async () => {
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      resolveWorkerSenderLabel: vi.fn(async () => 'Reviewer'),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Done',
      source: 'worker',
      senderLabel: 'Worker',
      workerId: 'worker-1',
      teamId: 'team-1',
      meta: { source: 'orca', context: 'receipt-test' },
    });

    expect(result).toEqual({
      ok: true,
      mode: 'queued',
      clientId: 'client-1',
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: true,
        wakeKind: 'queued',
      },
      targetTitle: 'Target Session',
      targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
    });
    expect(h.queuedItems[0]).toMatchObject({
      clientId: 'client-1',
      text: '[From Orca Worker]\nDone',
      persistedContent: '{"orcaSource":"worker","content":"Done"}',
      origin: {
        kind: 'orca',
        teamId: 'team-1',
        senderLabel: 'Reviewer',
        displayText: 'Done',
      },
    });
  });

  it('rejects an ended team before reading or rehydrating the target session', async () => {
    const h = createHarness({
      isOrcaTeamActive: vi.fn(async () => false),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Late report',
      source: 'worker',
      senderLabel: 'Reviewer',
      workerId: 'worker-1',
      teamId: 'team-ended',
      meta: { source: 'orca', context: 'ended-team-test' },
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'host-send',
        message: expect.stringContaining('ORCA_TEAM_INACTIVE'),
      },
    });
    expect(h.deps.getSessionMeta).not.toHaveBeenCalled();
    expect(h.deps.getSessionRowSnapshot).not.toHaveBeenCalled();
    expect(h.deps.sendToSessionInternal).not.toHaveBeenCalled();
  });
});
