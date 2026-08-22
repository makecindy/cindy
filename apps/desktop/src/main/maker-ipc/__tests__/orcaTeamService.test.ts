import { describe, expect, it, vi } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import {
  createOrcaTeamService,
  findFocusTargetWorker,
  type DispatchWorkerMessageResult,
  type OrcaTeamServiceDeps,
  type OrcaWorkerRecordSnapshot,
  type OrcaWorkerStatus,
  type SendToWorkerResult,
} from '../orcaTeamService';

function createWorker(overrides: Partial<OrcaWorkerRecordSnapshot> = {}): OrcaWorkerRecordSnapshot {
  return {
    id: 'worker-1',
    teamId: 'team-1',
    leadSessionId: 'lead-1',
    sessionId: 'worker-session-1',
    status: 'idle',
    label: 'research',
    role: 'Researcher',
    focused: false,
    idleSince: null,
    session: {
      title: 'Worker',
      agentKind: 'codex',
      model: 'gpt-5.4',
      effort: 'medium',
      permissionMode: 'bypassPermissions',
      fastMode: false,
    },
    ...overrides,
  };
}

describe('findFocusTargetWorker', () => {
  const a = createWorker({ id: 'wid-a', sessionId: 'sid-a', label: 'tester' });
  const b = createWorker({ id: 'wid-b', sessionId: 'sid-b', label: 'dev' });
  const workers = [a, b];

  it('matches by worker_id', () => {
    expect(findFocusTargetWorker(workers, 'wid-b')).toBe(b);
  });

  it('matches by session_id', () => {
    expect(findFocusTargetWorker(workers, 'sid-a')).toBe(a);
  });

  it('matches by label as fallback', () => {
    expect(findFocusTargetWorker(workers, 'dev')).toBe(b);
  });

  it('matches the canonical worker label case-insensitively', () => {
    expect(findFocusTargetWorker(workers, 'DEV')).toBe(b);
  });

  it('prefers id/session_id over a colliding label', () => {
    // label of `a` happens to equal worker_id of `b` → id match wins, no wrong focus.
    const collide = createWorker({ id: 'wid-x', sessionId: 'sid-x', label: 'wid-a' });
    expect(findFocusTargetWorker([a, collide], 'wid-a')).toBe(a);
  });

  it('returns null when nothing matches', () => {
    expect(findFocusTargetWorker(workers, 'nope')).toBeNull();
  });

  it('ignores null labels', () => {
    const noLabel = createWorker({ id: 'wid-c', sessionId: 'sid-c', label: null });
    expect(findFocusTargetWorker([noLabel], 'wid-c')).toBe(noLabel);
    expect(findFocusTargetWorker([noLabel], 'whatever')).toBeNull();
  });
});

function createDeps(overrides: Partial<OrcaTeamServiceDeps> = {}) {
  const calls: string[] = [];
  let workers = [createWorker()];
  let manualInterrupt: { reason: string } | null = null;
  const findWorkerBySessionId = (sessionId: string) => workers.find((item) => item.sessionId === sessionId);
  const findWorkerById = (workerId: string) => workers.find((item) => item.id === workerId);

  const deps: OrcaTeamServiceDeps = {
    getWorkerLinkBySessionId: vi.fn(async (workerSessionId: string) => {
      const worker = findWorkerBySessionId(workerSessionId);
      return worker
        ? {
            workerId: worker.id,
            teamId: worker.teamId,
            workerSessionId: worker.sessionId,
            leadSessionId: worker.leadSessionId,
          }
        : null;
    }),
    getWorkerLinkByWorkerId: vi.fn(async (workerId: string) => {
      const worker = findWorkerById(workerId);
      return worker
        ? {
            workerId: worker.id,
            teamId: worker.teamId,
            workerSessionId: worker.sessionId,
            leadSessionId: worker.leadSessionId,
          }
        : null;
    }),
    listWorkersByLead: vi.fn(async (leadSessionId: string) => (
      workers.filter((worker) => worker.leadSessionId === leadSessionId)
    )),
    getLiveSession: vi.fn(() => null),
    resumeWorkerSession: vi.fn(async () => {}),
    updateWorkerStatus: vi.fn(async (workerId, status) => {
      calls.push(`updateWorkerStatus:${status}`);
      workers = workers.map((worker) => (
        worker.id === workerId
          ? {
              ...worker,
              status,
              idleSince: status === 'running' ? null : worker.idleSince,
            }
          : worker
      ));
    }),
    markWorkerIdle: vi.fn(async (workerId) => {
      calls.push('markWorkerIdle');
      workers = workers.map((worker) => (
        worker.id === workerId
          ? {
              ...worker,
              status: 'idle',
            }
          : worker
      ));
    }),
    markWorkerIdleIfStatus: vi.fn(async (workerId, expectedStatus) => {
      const worker = workers.find((item) => item.id === workerId);
      if (!worker || worker.status !== expectedStatus) return false;
      calls.push('markWorkerIdleIfStatus');
      workers = workers.map((item) => (
        item.id === workerId
          ? {
              ...item,
              status: 'idle',
            }
          : item
      ));
      return true;
    }),
    restoreWorkerDoneIfIdle: vi.fn(async (workerId) => {
      const worker = workers.find((item) => item.id === workerId);
      if (!worker || worker.status !== 'idle') return false;
      calls.push('restoreWorkerDoneIfIdle');
      workers = workers.map((item) => (
        item.id === workerId
          ? {
              ...item,
              status: 'done',
              idleSince: null,
            }
          : item
      ));
      return true;
    }),
    cancelWorkerSessionOperations: vi.fn(async (sessionId) => {
      calls.push(`cancelWorkerSessionOperations:${sessionId}`);
    }),
    closeWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`closeWorkerSession:${sessionId}`);
    }),
    closeWorkerSessionIfIdle: vi.fn(async (sessionId) => {
      calls.push(`closeWorkerSessionIfIdle:${sessionId}`);
      return true;
    }),
    hasPendingWorkerInput: vi.fn(async () => false),
    hasSendToSessionLock: vi.fn(() => false),
    archiveWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`archiveWorkerSession:${sessionId}`);
    }),
    getManualInterrupt: vi.fn(() => manualInterrupt),
    clearManualInterrupt: vi.fn(() => {
      manualInterrupt = null;
    }),
    broadcastOrcaWorkerChanged: vi.fn(() => {
      calls.push('broadcastOrcaWorkerChanged');
    }),
    dispatchWorkerMessage: vi.fn(async (params) => {
      calls.push(`dispatchWorkerMessage:${params.workerId}`);
      await params.onAccepted?.();
      return {
        ok: true,
        mode: 'dispatched',
        clientId: 'client-1',
        dispatchOutcome: {
          kind: 'session-dispatch',
          source: params.dispatchMeta.source,
          dispatched: true,
        },
        targetTitle: 'Worker',
        targetLastUserSendAt: null,
      } satisfies DispatchWorkerMessageResult;
    }),
    sendAutoBridgeToLead: vi.fn(async () => ({ accepted: true })),
    getSessionQueueSnapshot: vi.fn(async () => ({
      pendingQueue: [],
      steeringClientIds: [],
      consumingClientIds: [],
    })),
    removeQueuedMessage: vi.fn(() => true),
    replaceQueuedMessage: vi.fn(() => true),
    log: {
      warn: vi.fn(),
      info: vi.fn(),
    },
    ...overrides,
  };

  return {
    calls,
    deps,
    getWorker: () => workers[0]!,
    setWorker: (next: OrcaWorkerRecordSnapshot) => {
      workers = [next];
    },
    setWorkers: (next: OrcaWorkerRecordSnapshot[]) => {
      workers = next;
    },
    setManualInterrupt: (reason: string) => {
      manualInterrupt = { reason };
    },
    service: createOrcaTeamService(deps),
  };
}

describe('OrcaTeamService', () => {
  it('dispatches worker task through shared primitive after accepted updates running, broadcast, and pending', async () => {
    const leadMessages: string[] = [];
    const { calls, deps, service } = createDeps({
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await expect(
      service.dispatchWorkerTask({
        targetSessionId: 'worker-session-1',
        message: '实现需求',
        dispatchMeta: { source: 'test-source', context: 'test-context' },
      }),
    ).resolves.toMatchObject({
      dispatched: true,
      dispatchOutcome: { kind: 'session-dispatch', source: 'test-source', dispatched: true },
    });

    expect(calls).toEqual([
      'dispatchWorkerMessage:worker-1',
      'updateWorkerStatus:running',
      'broadcastOrcaWorkerChanged',
    ]);
    expect(deps.dispatchWorkerMessage).toHaveBeenCalledWith(expect.objectContaining({
      workerId: 'worker-1',
      dispatchMeta: { source: 'test-source', context: 'test-context' },
    }));

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '完成了',
    });

    expect(leadMessages).toEqual(['[Auto-bridged: worker 完成但未调 send_to_lead]\n\n完成了']);
  });

  it('resumes a stale running worker before dispatching the next task', async () => {
    const { deps, service, setWorker } = createDeps();
    setWorker(createWorker({
      status: 'running',
      session: {
        title: 'Worker',
        agentKind: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
        permissionMode: 'auto',
        fastMode: false,
      },
    }));

    await expect(
      service.dispatchWorkerTask({
        targetSessionId: 'worker-session-1',
        message: '继续任务',
        dispatchMeta: { source: 'test-source', context: 'stale-running-worker' },
      }),
    ).resolves.toMatchObject({ dispatched: true });

    expect(deps.resumeWorkerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        session: expect.objectContaining({ permissionMode: 'auto' }),
      }),
      expect.objectContaining({ workerSessionId: 'worker-session-1' }),
    );
    expect(vi.mocked(deps.resumeWorkerSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.dispatchWorkerMessage).mock.invocationCallOrder[0]!,
    );
  });

  it('does not resume a running worker that still has a live session', async () => {
    const { deps, service, setWorker } = createDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
    });
    setWorker(createWorker({ status: 'running' }));

    await expect(
      service.dispatchWorkerTask({
        targetSessionId: 'worker-session-1',
        message: '继续任务',
        dispatchMeta: { source: 'test-source', context: 'live-running-worker' },
      }),
    ).resolves.toMatchObject({ dispatched: true });

    expect(deps.resumeWorkerSession).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerMessage).toHaveBeenCalledOnce();
  });

  it('marks only a non-running worker session running on direct turn start', async () => {
    const { calls, deps, getWorker, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'done' }));

    await service.handleWorkerTurnStarted('worker-session-1');

    expect(getWorker().status).toBe('running');
    expect(calls).toEqual([
      'updateWorkerStatus:running',
      'broadcastOrcaWorkerChanged',
    ]);

    setWorker(createWorker({ status: 'running' }));
    calls.length = 0;
    vi.mocked(deps.updateWorkerStatus).mockClear();
    vi.mocked(deps.broadcastOrcaWorkerChanged).mockClear();

    await service.handleWorkerTurnStarted('worker-session-1');

    expect(calls).toEqual([]);
    expect(deps.updateWorkerStatus).not.toHaveBeenCalled();
    expect(deps.broadcastOrcaWorkerChanged).not.toHaveBeenCalled();

    vi.mocked(deps.getWorkerLinkBySessionId).mockResolvedValueOnce(null);
    vi.mocked(deps.updateWorkerStatus).mockClear();
    vi.mocked(deps.broadcastOrcaWorkerChanged).mockClear();
    await service.handleWorkerTurnStarted('regular-session-1');

    expect(calls).toEqual([]);
    expect(deps.updateWorkerStatus).not.toHaveBeenCalled();
    expect(deps.broadcastOrcaWorkerChanged).not.toHaveBeenCalled();
  });

  it('resolves sendToWorker worker id to session id before dispatching', async () => {
    const { calls, deps, getWorker, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'idle', idleSince: '2026-07-21T10:00:00.000Z' }));

    await expect(
      service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-1', message: '继续' }),
    ).resolves.toMatchObject({
      ok: true,
      wakeKind: 'resumed',
    } satisfies Partial<Extract<SendToWorkerResult, { ok: true }>>);

    expect(deps.getWorkerLinkBySessionId).toHaveBeenCalledWith('worker-session-1');
    expect(deps.getWorkerLinkBySessionId).not.toHaveBeenCalledWith('worker-1');
    expect(deps.resumeWorkerSession).toHaveBeenCalledOnce();
    expect(getWorker().idleSince).toBeNull();
    expect(deps.dispatchWorkerMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'worker-session-1',
      workerId: 'worker-1',
      dispatchMeta: {
        source: 'maker-ipc/collab',
        context: 'send_to_worker/worker-session-1/dispatch-worker-message',
      },
    }));
    expect(calls).toEqual([
      'dispatchWorkerMessage:worker-1',
      'updateWorkerStatus:running',
      'broadcastOrcaWorkerChanged',
    ]);
  });

  it('rejects ambiguous sendToWorker worker references before resume or dispatch', async () => {
    const { calls, deps, service, setWorkers } = createDeps();
    setWorkers([
      createWorker({
        id: 'ambiguous-ref',
        sessionId: 'worker-session-a',
        status: 'running',
      }),
      createWorker({
        id: 'worker-b',
        sessionId: 'ambiguous-ref',
        status: 'running',
      }),
    ]);

    await expect(
      service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'ambiguous-ref', message: '继续' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'worker reference ambiguous-ref matched multiple workers',
    });

    expect(calls).toEqual([]);
    expect(deps.resumeWorkerSession).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerMessage).not.toHaveBeenCalled();
  });

  it('sends to worker by session id and broadcasts after dispatch is accepted', async () => {
    const { calls, deps, service } = createDeps();

    await expect(
      service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '继续' }),
    ).resolves.toMatchObject({
      ok: true,
      wakeKind: 'resumed',
    } satisfies Partial<Extract<SendToWorkerResult, { ok: true }>>);

    expect(deps.dispatchWorkerMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'worker-session-1',
      workerId: 'worker-1',
      dispatchMeta: {
        source: 'maker-ipc/collab',
        context: 'send_to_worker/worker-session-1/dispatch-worker-message',
      },
    }));
    expect(calls).toEqual([
      'dispatchWorkerMessage:worker-1',
      'updateWorkerStatus:running',
      'broadcastOrcaWorkerChanged',
    ]);
  });

  it.each([
    ['worker id', 'worker-1'],
    ['worker session id', 'worker-session-1'],
  ] as const)('treats cross-lead sendToWorker by %s as not found at the external caller boundary', async (_label, targetSessionId) => {
    const { calls, deps, service } = createDeps();

    await expect(
      service.sendToWorker({
        callerLeadSessionId: 'lead-other',
        targetSessionId,
        message: '继续',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });

    expect(calls).toEqual([]);
    expect(deps.resumeWorkerSession).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerMessage).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for unknown sendToWorker target before resume or dispatch', async () => {
    const { calls, deps, service } = createDeps();

    await expect(
      service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'missing-worker-session', message: '继续' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });

    expect(calls).toEqual([]);
    expect(deps.resumeWorkerSession).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerMessage).not.toHaveBeenCalled();
  });

  it('normalizes resume failures to AGENT_NOT_READY for sendToWorker', async () => {
    const { deps, service } = createDeps({
      resumeWorkerSession: vi.fn(async () => {
        throw new Error('rehydrate failed');
      }),
    });

    await expect(
      service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '继续' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'AGENT_NOT_READY',
      message: 'rehydrate failed',
    });

    expect(deps.dispatchWorkerMessage).not.toHaveBeenCalled();
    expect(deps.updateWorkerStatus).not.toHaveBeenCalled();
    expect(deps.broadcastOrcaWorkerChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['SESSION_RUNNING', 'BUSY'],
    ['SEND_FAILED', 'AGENT_NOT_READY'],
  ] as const)('normalizes host dispatch failure %s to public %s for sendToWorker', async (hostCode, publicCode) => {
    const { service } = createDeps({
      dispatchWorkerMessage: vi.fn(async (params) => ({
        ok: false,
        dispatchOutcome: {
          kind: 'host-send',
          accepted: false,
          code: hostCode,
          message: `${hostCode} failure`,
          source: params.dispatchMeta.source,
          context: params.dispatchMeta.context,
        },
      } satisfies DispatchWorkerMessageResult)),
    });

    await expect(
      service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '继续' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: publicCode,
    });
  });

  it('does not auto-bridge a queued worker task until dispatch is accepted', async () => {
    const acceptedCallback: { current: (() => void | Promise<void>) | null } = { current: null };
    const leadMessages: string[] = [];
    const { service } = createDeps({
      dispatchWorkerMessage: vi.fn(async (params) => {
        acceptedCallback.current = params.onAccepted ?? null;
        return {
          ok: true,
          mode: 'queued',
          clientId: 'client-queued-1',
          dispatchOutcome: {
            kind: 'session-dispatch',
            source: params.dispatchMeta.source,
            dispatched: true,
            wakeKind: 'queued',
          },
          targetTitle: 'Worker',
          targetLastUserSendAt: null,
        } satisfies DispatchWorkerMessageResult;
      }),
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await expect(
      service.dispatchWorkerTask({
        targetSessionId: 'worker-session-1',
        message: '分析 issue',
        dispatchMeta: { source: 'test-source', context: 'queued-test' },
      }),
    ).resolves.toMatchObject({
      dispatched: false,
      queued: true,
      dispatchOutcome: { kind: 'session-dispatch', source: 'test-source', dispatched: true, wakeKind: 'queued' },
    });

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '完成了',
    });

    expect(leadMessages).toEqual([]);

    const accept = acceptedCallback.current;
    if (!accept) throw new Error('accepted callback was not captured');
    await accept();
    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '完成了',
    });

    expect(leadMessages).toEqual(['[Auto-bridged: worker 完成但未调 send_to_lead]\n\n完成了']);
  });

  it('rolls back running status and pending auto-bridge when accepted dispatch returns failure', async () => {
    const leadMessages: string[] = [];
    const failure = {
      kind: 'session-dispatch' as const,
      source: 'test-source',
      dispatched: false as const,
      reason: 'cancelled-before-dispatch' as const,
      context: 'failure-test',
      message: 'Session send was cancelled before vendor dispatch: failure-test',
    };
    const { calls, getWorker, service } = createDeps({
      dispatchWorkerMessage: vi.fn(async (params) => {
        calls.push(`dispatchWorkerMessage:${params.workerId}`);
        await params.onAccepted?.();
        return {
          ok: false,
          dispatchOutcome: failure,
        } satisfies DispatchWorkerMessageResult;
      }),
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await expect(
      service.dispatchWorkerTask({
        targetSessionId: 'worker-session-1',
        message: '会失败',
        dispatchMeta: { source: 'test-source', context: 'failure-test' },
      }),
    ).resolves.toEqual({
      dispatched: false,
      dispatchOutcome: failure,
    });

    expect(getWorker().status).toBe('idle');
    expect(calls).toEqual([
      'dispatchWorkerMessage:worker-1',
      'updateWorkerStatus:running',
      'broadcastOrcaWorkerChanged',
      'updateWorkerStatus:idle',
      'broadcastOrcaWorkerChanged',
    ]);

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '不应 bridge',
    });
    expect(leadMessages).toEqual([]);
  });

  it('rolls back running status and pending auto-bridge when accepted dispatch throws', async () => {
    const leadMessages: string[] = [];
    const { calls, getWorker, service } = createDeps({
      dispatchWorkerMessage: vi.fn(async (params) => {
        calls.push(`dispatchWorkerMessage:${params.workerId}`);
        await params.onAccepted?.();
        throw new Error('dispatch exploded');
      }),
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await expect(
      service.dispatchWorkerTask({
        targetSessionId: 'worker-session-1',
        message: '会抛错',
        dispatchMeta: { source: 'test-source', context: 'throw-test' },
      }),
    ).resolves.toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        source: 'test-source',
        context: 'throw-test',
        code: 'SEND_FAILED',
      },
    });

    expect(getWorker().status).toBe('idle');
    expect(calls).toEqual([
      'dispatchWorkerMessage:worker-1',
      'updateWorkerStatus:running',
      'broadcastOrcaWorkerChanged',
      'updateWorkerStatus:idle',
      'broadcastOrcaWorkerChanged',
    ]);

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '不应 bridge',
    });
    expect(leadMessages).toEqual([]);
  });

  it('rolls back queued dispatch from accepted-boundary state instead of enqueue-time pending', async () => {
    const queuedAccepted: { current: (() => void | Promise<void>) | null } = { current: null };
    const queuedRollback: { current: (() => void | Promise<void>) | null } = { current: null };
    const leadMessages: string[] = [];
    let dispatchCount = 0;
    const { getWorker, service, setWorker } = createDeps({
      dispatchWorkerMessage: vi.fn(async (params) => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          await params.onAccepted?.();
          return {
            ok: true,
            mode: 'dispatched',
            clientId: 'client-a',
            dispatchOutcome: {
              kind: 'session-dispatch',
              source: params.dispatchMeta.source,
              dispatched: true,
            },
            targetTitle: 'Worker',
            targetLastUserSendAt: null,
          } satisfies DispatchWorkerMessageResult;
        }

        queuedAccepted.current = params.onAccepted ?? null;
        queuedRollback.current = params.onAcceptedRollback ?? null;
        return {
          ok: true,
          mode: 'queued',
          clientId: 'client-b',
          dispatchOutcome: {
            kind: 'session-dispatch',
            source: params.dispatchMeta.source,
            dispatched: true,
            wakeKind: 'queued',
          },
          targetTitle: 'Worker',
          targetLastUserSendAt: null,
        } satisfies DispatchWorkerMessageResult;
      }),
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await service.dispatchWorkerTask({
      targetSessionId: 'worker-session-1',
      message: '任务 A',
      dispatchMeta: { source: 'test-source', context: 'task-a' },
    });
    await expect(
      service.dispatchWorkerTask({
        targetSessionId: 'worker-session-1',
        message: '任务 B',
        dispatchMeta: { source: 'test-source', context: 'task-b' },
      }),
    ).resolves.toMatchObject({ dispatched: false, queued: true });

    service.clearAutoBridgeState('worker-session-1');
    setWorker({ ...getWorker(), status: 'done' });

    const accept = queuedAccepted.current;
    const rollback = queuedRollback.current;
    if (!accept || !rollback) throw new Error('queued callbacks were not captured');
    await accept();
    await rollback();

    expect(getWorker().status).toBe('done');

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '不应复活旧 pending',
    });
    expect(leadMessages).toEqual([]);
  });

  it('keeps pending auto-bridge state when lead delivery is not accepted', async () => {
    const leadMessages: string[] = [];
    const sendAutoBridgeToLead = vi.fn(async (_leadSessionId: string, message: string) => {
      leadMessages.push(message);
      return { accepted: leadMessages.length > 1 };
    });
    const { service } = createDeps({ sendAutoBridgeToLead });

    await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '分析 issue' });

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '第一次结果',
    });
    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '第二次结果',
    });

    expect(sendAutoBridgeToLead).toHaveBeenCalledTimes(2);
    expect(leadMessages).toEqual([
      '[Auto-bridged: worker 完成但未调 send_to_lead]\n\n第一次结果',
      '[Auto-bridged: worker 完成但未调 send_to_lead]\n\n第二次结果',
    ]);
  });

  it('does not auto-bridge when there is no worker link', async () => {
    const leadMessages: string[] = [];
    const { deps, service } = createDeps({
      getWorkerLinkBySessionId: vi.fn(async () => null),
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '完成了',
    });

    expect(deps.listWorkersByLead).not.toHaveBeenCalled();
    expect(deps.updateWorkerStatus).not.toHaveBeenCalled();
    expect(deps.broadcastOrcaWorkerChanged).not.toHaveBeenCalled();
    expect(leadMessages).toEqual([]);
  });

  it('clears pending runtime state when the worker row is missing', async () => {
    const leadMessages: string[] = [];
    const { deps, service } = createDeps({
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '分析 issue' });
    vi.mocked(deps.listWorkersByLead).mockResolvedValueOnce([]);

    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '不应 bridge',
    });
    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '仍不应 bridge',
    });

    expect(deps.clearManualInterrupt).toHaveBeenCalledWith('worker-session-1');
    expect(leadMessages).toEqual([]);
  });

  it.each(['done', 'error', 'idle'] satisfies OrcaWorkerStatus[])(
    'skips auto-bridge when the worker is already %s',
    async (status) => {
      const leadMessages: string[] = [];
      const { deps, service, setWorker } = createDeps({
        sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
          leadMessages.push(message);
          return { accepted: true };
        }),
      });

      await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '分析 issue' });
      setWorker(createWorker({ status }));
      await service.handleWorkerTerminalTurn({
        sessionId: 'worker-session-1',
        status: 'done',
        finalText: '不应 bridge',
      });
      setWorker(createWorker({ status: 'running' }));
      await service.handleWorkerTerminalTurn({
        sessionId: 'worker-session-1',
        status: 'done',
        finalText: '仍不应 bridge',
      });

      expect(deps.clearManualInterrupt).toHaveBeenCalledWith('worker-session-1');
      expect(leadMessages).toEqual([]);
    },
  );

  it.each(['input_stop', 'abort_session'])(
    'keeps %s manual interrupt silent and marks the worker idle',
    async (reason) => {
      const leadMessages: string[] = [];
      const { calls, deps, service, setManualInterrupt } = createDeps({
        sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
          leadMessages.push(message);
          return { accepted: true };
        }),
      });

      await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '分析 issue' });
      service.captureWorkerText('worker-session-1', '部分输出');
      setManualInterrupt(reason);
      await service.handleWorkerTerminalTurn({
        sessionId: 'worker-session-1',
        status: 'done',
        finalText: '',
      });

      expect(calls).toEqual([
        'dispatchWorkerMessage:worker-1',
        'updateWorkerStatus:running',
        'broadcastOrcaWorkerChanged',
        'markWorkerIdle',
        'broadcastOrcaWorkerChanged',
      ]);
      expect(deps.clearManualInterrupt).toHaveBeenCalledWith('worker-session-1');
      expect(deps.log.info).toHaveBeenCalledWith('worker manual interrupt: suppressed auto-bridge', {
        workerId: 'worker-1',
        leadSessionId: 'lead-1',
        sessionId: 'worker-session-1',
        reason,
        status: 'done',
      });
      expect(leadMessages).toEqual([]);
    },
  );

  it.each(['done', 'error'] as const)(
    'updates worker %s status, broadcasts, and auto-bridges pending output',
    async (status) => {
      const leadMessages: string[] = [];
      const { calls, getWorker, service } = createDeps({
        sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
          leadMessages.push(message);
          return { accepted: true };
        }),
      });

      await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '分析 issue' });
      await service.handleWorkerTerminalTurn({
        sessionId: 'worker-session-1',
        status,
        finalText: '完成了',
      });

      expect(getWorker().status).toBe(status);
      expect(calls).toEqual([
        'dispatchWorkerMessage:worker-1',
        'updateWorkerStatus:running',
        'broadcastOrcaWorkerChanged',
        `updateWorkerStatus:${status}`,
        'broadcastOrcaWorkerChanged',
      ]);
      expect(leadMessages).toEqual([
        `${status === 'error' ? '[Auto-bridged: worker 异常终止]' : '[Auto-bridged: worker 完成但未调 send_to_lead]'}\n\n完成了`,
      ]);
    },
  );

  it.each(['done', 'error'] as const)(
    'updates worker %s status and broadcasts without auto-bridge when no pending bridge exists',
    async (status) => {
      const sendAutoBridgeToLead = vi.fn(async () => ({ accepted: true }));
      const { calls, getWorker, service, setWorker } = createDeps({ sendAutoBridgeToLead });
      setWorker(createWorker({ status: 'running' }));

      await service.handleWorkerTerminalTurn({
        sessionId: 'worker-session-1',
        status,
        finalText: '完成了',
      });

      expect(getWorker().status).toBe(status);
      expect(calls).toEqual([
        `updateWorkerStatus:${status}`,
        'broadcastOrcaWorkerChanged',
      ]);
      expect(sendAutoBridgeToLead).not.toHaveBeenCalled();
    },
  );

  it('does not inherit captured text into the next dispatch', async () => {
    const leadMessages: string[] = [];
    const { service } = createDeps({
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '第一次' });
    service.captureWorkerText('worker-session-1', '旧输出');
    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '',
    });

    await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '第二次' });
    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '',
    });

    expect(leadMessages).toEqual([
      '[Auto-bridged: worker 完成但未调 send_to_lead]\n\n旧输出',
      '[Auto-bridged: worker 完成但未调 send_to_lead]\n\n(no output captured)',
    ]);
  });

  it('uses final text chunks as captured fallback instead of appending duplicate deltas', async () => {
    const leadMessages: string[] = [];
    const { service } = createDeps({
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '分析 issue' });
    service.captureWorkerText('worker-session-1', '部分', { isFinal: false });
    service.captureWorkerText('worker-session-1', '部分输出', { isFinal: true });
    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'done',
      finalText: '',
    });

    expect(leadMessages).toEqual(['[Auto-bridged: worker 完成但未调 send_to_lead]\n\n部分输出']);
  });

  it('bridges the terminal diagnostic when an errored worker produced no output', async () => {
    const leadMessages: string[] = [];
    const { service } = createDeps({
      sendAutoBridgeToLead: vi.fn(async (_leadSessionId, message) => {
        leadMessages.push(message);
        return { accepted: true };
      }),
    });

    await service.sendToWorker({ callerLeadSessionId: 'lead-1', targetSessionId: 'worker-session-1', message: '只读审计' });
    await service.handleWorkerTerminalTurn({
      sessionId: 'worker-session-1',
      status: 'error',
      finalText: '',
      diagnostic: 'Claude session exited before producing a result',
    });

    expect(leadMessages).toEqual([
      '[Auto-bridged: worker 异常终止]\n\nClaude session exited before producing a result',
    ]);
  });

  it('marks worker idle and clears bridge state before closing its session', async () => {
    const { calls, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(service.idleWorker({ callerLeadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toEqual({
      ok: true,
      workerId: 'worker-1',
    });

    expect(calls).toEqual([
      'markWorkerIdle',
      'closeWorkerSession:worker-session-1',
      'broadcastOrcaWorkerChanged',
    ]);
  });

  it('marks a done worker idle when the caller confirms the viewed status', async () => {
    const { calls, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'done' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({ ok: true, workerId: 'worker-1' });

    expect(calls).toEqual([
      'markWorkerIdleIfStatus',
      'closeWorkerSessionIfIdle:worker-session-1',
      'broadcastOrcaWorkerChanged',
    ]);
  });

  it('does not clear runtime or close a done worker when the conditional idle update loses a race', async () => {
    const { calls, deps, service, setWorker } = createDeps({
      markWorkerIdleIfStatus: vi.fn(async () => false),
    });
    setWorker(createWorker({ status: 'done' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 is no longer done',
    });

    expect(calls).toEqual([]);
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.closeWorkerSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.markWorkerIdle).not.toHaveBeenCalled();
  });

  it('does not acknowledge or close a done worker while a new dispatch is in flight', async () => {
    let releaseDispatch!: () => void;
    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const { calls, deps, service, setWorker } = createDeps({
      dispatchWorkerMessage: vi.fn(async (params) => {
        markDispatchStarted();
        await new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        });
        await params.onAccepted?.();
        return {
          ok: true,
          mode: 'dispatched',
          clientId: 'client-race',
          dispatchOutcome: {
            kind: 'session-dispatch',
            source: params.dispatchMeta.source,
            dispatched: true,
          },
          targetTitle: 'Worker',
          targetLastUserSendAt: null,
        } satisfies DispatchWorkerMessageResult;
      }),
    });
    setWorker(createWorker({ status: 'done' }));

    const dispatch = service.dispatchWorkerTask({
      targetSessionId: 'worker-session-1',
      message: 'new task',
      dispatchMeta: { source: 'test-source', context: 'done-ack-race' },
    });
    await dispatchStarted;

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 has a dispatch in progress',
    });
    expect(deps.markWorkerIdleIfStatus).not.toHaveBeenCalled();
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.closeWorkerSessionIfIdle).not.toHaveBeenCalled();

    releaseDispatch();
    await expect(dispatch).resolves.toMatchObject({ dispatched: true });
    expect(calls).toContain('updateWorkerStatus:running');
  });

  it('does not acknowledge a done worker while a resumed send-to-session lock is active', async () => {
    const { calls, deps, service, setWorker } = createDeps({
      hasSendToSessionLock: vi.fn(() => true),
    });
    setWorker(createWorker({ status: 'done' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 has a send in progress',
    });

    expect(deps.hasSendToSessionLock).toHaveBeenCalledWith('worker-session-1');
    expect(deps.markWorkerIdleIfStatus).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('does not acknowledge or close a done worker while its live session has a direct turn', async () => {
    const { calls, deps, service, setWorker } = createDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });
    setWorker(createWorker({ status: 'done' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 has an active turn',
    });

    expect(deps.getLiveSession).toHaveBeenCalledWith('worker-session-1');
    expect(deps.markWorkerIdleIfStatus).not.toHaveBeenCalled();
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.closeWorkerSessionIfIdle).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('does not close a direct send that wins the atomic idle-close reservation after the CAS', async () => {
    const { calls, deps, getWorker, service, setWorker } = createDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
      closeWorkerSessionIfIdle: vi.fn(async () => false),
    });
    setWorker(createWorker({ status: 'done' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 has an active turn',
    });

    expect(deps.getLiveSession).toHaveBeenCalledTimes(1);
    expect(deps.closeWorkerSessionIfIdle).toHaveBeenCalledWith('worker-session-1');
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.restoreWorkerDoneIfIdle).toHaveBeenCalledWith('worker-1');
    expect(deps.broadcastOrcaWorkerChanged).toHaveBeenCalledTimes(1);
    expect(getWorker().status).toBe('done');
    expect(calls).toContain('restoreWorkerDoneIfIdle');
  });

  it('preserves queued worker input before acknowledging a done worker', async () => {
    const { deps, service, setWorker } = createDeps({
      hasPendingWorkerInput: vi.fn(async () => true),
    });
    setWorker(createWorker({ status: 'done' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 has queued input',
    });

    expect(deps.markWorkerIdleIfStatus).not.toHaveBeenCalled();
    expect(deps.closeWorkerSessionIfIdle).not.toHaveBeenCalled();
  });

  it('preserves worker input queued while the done-status CAS is awaiting I/O', async () => {
    let queueChecks = 0;
    const { deps, getWorker, service, setWorker } = createDeps({
      hasPendingWorkerInput: vi.fn(async () => {
        queueChecks += 1;
        return queueChecks === 2;
      }),
    });
    setWorker(createWorker({ status: 'done' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 has queued input',
    });

    expect(deps.markWorkerIdleIfStatus).toHaveBeenCalledWith('worker-1', 'done');
    expect(deps.restoreWorkerDoneIfIdle).toHaveBeenCalledWith('worker-1');
    expect(deps.closeWorkerSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.broadcastOrcaWorkerChanged).toHaveBeenCalledTimes(1);
    expect(getWorker().status).toBe('done');
  });

  it('rejects a viewed-status idle request when the worker became running', async () => {
    const { calls, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(service.idleWorker({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 is running, expected done',
    });

    expect(calls).toEqual([]);
  });

  it.each([
    ['worker id', 'worker-1'],
    ['worker session id', 'worker-session-1'],
  ] as const)('marks worker idle when addressed by %s', async (_label, workerRef) => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(service.idleWorker({ callerLeadSessionId: 'lead-1', workerId: workerRef })).resolves.toEqual({
      ok: true,
      workerId: 'worker-1',
    });

    expect(deps.markWorkerIdle).toHaveBeenCalledWith('worker-1');
    expect(calls).toEqual([
      'markWorkerIdle',
      'closeWorkerSession:worker-session-1',
      'broadcastOrcaWorkerChanged',
    ]);
  });

  it('rejects ambiguous idleWorker references before side effects', async () => {
    const { calls, deps, service, setWorkers } = createDeps();
    setWorkers([
      createWorker({ id: 'ambiguous-ref', sessionId: 'worker-session-a', status: 'running' }),
      createWorker({ id: 'worker-b', sessionId: 'ambiguous-ref', status: 'running' }),
    ]);

    await expect(
      service.idleWorker({ callerLeadSessionId: 'lead-1', workerId: 'ambiguous-ref' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'worker reference ambiguous-ref matched multiple workers',
    });

    expect(calls).toEqual([]);
    expect(deps.markWorkerIdle).not.toHaveBeenCalled();
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
  });

  it('treats cross-lead idleWorker as not found at the external caller boundary', async () => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(
      service.idleWorker({ callerLeadSessionId: 'lead-other', workerId: 'worker-1' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker worker-1 not found',
    });

    expect(calls).toEqual([]);
    expect(deps.markWorkerIdle).not.toHaveBeenCalled();
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
  });

  it('treats cross-lead idleWorker by session id as not found at the external caller boundary', async () => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(
      service.idleWorker({ callerLeadSessionId: 'lead-other', workerId: 'worker-session-1' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker worker-session-1 not found',
    });

    expect(calls).toEqual([]);
    expect(deps.markWorkerIdle).not.toHaveBeenCalled();
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
  });

  it('returns WORKER_NOT_FOUND for unknown idleWorker refs before side effects', async () => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(
      service.idleWorker({ callerLeadSessionId: 'lead-1', workerId: 'missing-worker-ref' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker missing-worker-ref not found',
    });

    expect(calls).toEqual([]);
    expect(deps.markWorkerIdle).not.toHaveBeenCalled();
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
  });

  it('returns ALREADY_IDLE without closing the session when the worker is already idle', async () => {
    const { calls, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'idle' }));

    await expect(service.idleWorker({ callerLeadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'ALREADY_IDLE',
      message: 'worker worker-1 is already idle',
    });

    expect(calls).toEqual([]);
  });

  it('keeps idle successful when closing its session fails', async () => {
    const { calls, deps, service, setWorker } = createDeps({
      closeWorkerSession: vi.fn(async (sessionId) => {
        calls.push(`closeWorkerSession:${sessionId}`);
        throw new Error('close failed');
      }),
    });
    setWorker(createWorker({ status: 'running' }));

    await expect(service.idleWorker({ callerLeadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toEqual({
      ok: true,
      workerId: 'worker-1',
    });

    expect(calls).toEqual([
      'markWorkerIdle',
      'closeWorkerSession:worker-session-1',
      'broadcastOrcaWorkerChanged',
    ]);
    expect(deps.log.warn).toHaveBeenCalledWith('idleWorker: close worker session failed', {
      sessionId: 'worker-session-1',
      err: 'close failed',
    });
  });

  it('clears bridge state and archives worker session before marking worker done', async () => {
    const { calls, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(service.archiveWorker({ callerLeadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toEqual({
      ok: true,
      workerId: 'worker-1',
    });

    expect(calls).toEqual([
      'cancelWorkerSessionOperations:worker-session-1',
      'closeWorkerSession:worker-session-1',
      'archiveWorkerSession:worker-session-1',
      'cancelWorkerSessionOperations:worker-session-1',
      'updateWorkerStatus:done',
      'broadcastOrcaWorkerChanged',
    ]);
  });

  it.each([
    ['worker id', 'worker-1'],
    ['worker session id', 'worker-session-1'],
  ] as const)('archives worker when addressed by %s', async (_label, workerRef) => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(service.archiveWorker({ callerLeadSessionId: 'lead-1', workerId: workerRef })).resolves.toEqual({
      ok: true,
      workerId: 'worker-1',
    });

    expect(deps.updateWorkerStatus).toHaveBeenCalledWith('worker-1', 'done');
    expect(calls).toEqual([
      'cancelWorkerSessionOperations:worker-session-1',
      'closeWorkerSession:worker-session-1',
      'archiveWorkerSession:worker-session-1',
      'cancelWorkerSessionOperations:worker-session-1',
      'updateWorkerStatus:done',
      'broadcastOrcaWorkerChanged',
    ]);
  });

  it('rejects ambiguous archiveWorker references before side effects', async () => {
    const { calls, deps, service, setWorkers } = createDeps();
    setWorkers([
      createWorker({ id: 'ambiguous-ref', sessionId: 'worker-session-a', status: 'running' }),
      createWorker({ id: 'worker-b', sessionId: 'ambiguous-ref', status: 'running' }),
    ]);

    await expect(
      service.archiveWorker({ callerLeadSessionId: 'lead-1', workerId: 'ambiguous-ref' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'worker reference ambiguous-ref matched multiple workers',
    });

    expect(calls).toEqual([]);
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.archiveWorkerSession).not.toHaveBeenCalled();
    expect(deps.updateWorkerStatus).not.toHaveBeenCalled();
  });

  it('treats cross-lead archiveWorker as not found at the external caller boundary', async () => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(
      service.archiveWorker({ callerLeadSessionId: 'lead-other', workerId: 'worker-1' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker worker-1 not found',
    });

    expect(calls).toEqual([]);
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.archiveWorkerSession).not.toHaveBeenCalled();
  });

  it('treats cross-lead archiveWorker by session id as not found at the external caller boundary', async () => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(
      service.archiveWorker({ callerLeadSessionId: 'lead-other', workerId: 'worker-session-1' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker worker-session-1 not found',
    });

    expect(calls).toEqual([]);
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.archiveWorkerSession).not.toHaveBeenCalled();
  });

  it('returns WORKER_NOT_FOUND for unknown archiveWorker refs before side effects', async () => {
    const { calls, deps, service, setWorker } = createDeps();
    setWorker(createWorker({ status: 'running' }));

    await expect(
      service.archiveWorker({ callerLeadSessionId: 'lead-1', workerId: 'missing-worker-ref' }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker missing-worker-ref not found',
    });

    expect(calls).toEqual([]);
    expect(deps.closeWorkerSession).not.toHaveBeenCalled();
    expect(deps.archiveWorkerSession).not.toHaveBeenCalled();
    expect(deps.updateWorkerStatus).not.toHaveBeenCalled();
  });

  it('continues archiving when closing its session fails', async () => {
    const { calls, deps, service, setWorker } = createDeps({
      closeWorkerSession: vi.fn(async (sessionId) => {
        calls.push(`closeWorkerSession:${sessionId}`);
        throw new Error('close failed');
      }),
    });
    setWorker(createWorker({ status: 'running' }));

    await expect(service.archiveWorker({ callerLeadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toEqual({
      ok: true,
      workerId: 'worker-1',
    });

    expect(calls).toEqual([
      'cancelWorkerSessionOperations:worker-session-1',
      'closeWorkerSession:worker-session-1',
      'archiveWorkerSession:worker-session-1',
      'cancelWorkerSessionOperations:worker-session-1',
      'updateWorkerStatus:done',
      'broadcastOrcaWorkerChanged',
    ]);
    expect(deps.log.warn).toHaveBeenCalledWith('archiveWorker: close worker session failed', {
      sessionId: 'worker-session-1',
      err: 'close failed',
    });
  });
});

describe('OrcaTeamService worker queued message control', () => {
  function queuedItem(
    clientId: string,
    origin?: AgentInputQueuedMessage['origin'],
    text = `text-${clientId}`,
  ): AgentInputQueuedMessage {
    return {
      clientId,
      text,
      persistedContent: text,
      model: 'gpt-5.4',
      effort: 'medium',
      permissionMode: 'bypassPermissions',
      workingDir: '/repo',
      chatMessage: {
        clientId,
        role: 'user',
        content: text,
        createdAt: '2026-07-21T00:00:00.000Z',
      },
      createOpts: {
        agentKind: 'codex',
        workingDir: '/repo',
        model: 'gpt-5.4',
      },
      ...(origin ? { origin } : {}),
    };
  }

  const leadOrigin = { kind: 'orca' as const, senderLabel: 'Lead', displayText: '原始任务' };

  it('lists queue with content for all sources and marks consuming', async () => {
    const { deps, service } = createDeps({
      getSessionQueueSnapshot: vi.fn(async () => ({
        pendingQueue: [
          queuedItem('q-lead', leadOrigin),
          queuedItem('q-user'),
          queuedItem('q-sched', { kind: 'scheduler', scheduleId: 's1', scheduleName: 'beat' }),
        ],
        steeringClientIds: ['q-user'],
        consumingClientIds: ['q-user'],
      })),
    });

    const result = await service.listWorkerQueuedMessages({
      callerLeadSessionId: 'lead-1',
      workerRef: 'worker-1',
    });

    expect(result).toMatchObject({ ok: true, workerId: 'worker-1', workerSessionId: 'worker-session-1' });
    if (!result.ok) throw new Error('unreachable');
    // 口径「看得全、只能动自己的」:lead 条目回 displayText 原始正文,用户 /
    // scheduler 条目回排队正文;可操作性由 update/cancel 的 NOT_LEAD_MESSAGE 把关。
    expect(result.messages).toEqual([
      { queuedMessageId: 'q-lead', position: 0, source: 'lead', content: '原始任务', consuming: false },
      { queuedMessageId: 'q-user', position: 1, source: 'user', content: 'text-q-user', consuming: true },
      { queuedMessageId: 'q-sched', position: 2, source: 'scheduler', content: 'text-q-sched', consuming: false },
    ]);
    expect(deps.getSessionQueueSnapshot).toHaveBeenCalledWith('worker-session-1');
  });

  it('rejects queue access for a worker outside the caller lead scope', async () => {
    const { service } = createDeps();
    await expect(
      service.listWorkerQueuedMessages({ callerLeadSessionId: 'other-lead', workerRef: 'worker-1' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'WORKER_NOT_FOUND' });
    await expect(
      service.updateWorkerQueuedMessage({
        callerLeadSessionId: 'other-lead',
        workerRef: 'worker-1',
        queuedMessageId: 'q-lead',
        message: '新内容',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'WORKER_NOT_FOUND' });
  });

  it('updates a lead queued entry by rebuilding dispatch-format content in place', async () => {
    const replaceQueuedMessage = vi.fn(() => true);
    const { service } = createDeps({
      getSessionQueueSnapshot: vi.fn(async () => ({
        pendingQueue: [queuedItem('q-lead', leadOrigin)],
        steeringClientIds: [],
        consumingClientIds: [],
      })),
      replaceQueuedMessage,
    });

    await expect(
      service.updateWorkerQueuedMessage({
        callerLeadSessionId: 'lead-1',
        workerRef: 'worker-1',
        queuedMessageId: 'q-lead',
        message: '改后的任务',
      }),
    ).resolves.toEqual({ ok: true, workerId: 'worker-1', queuedMessageId: 'q-lead' });

    expect(replaceQueuedMessage).toHaveBeenCalledTimes(1);
    const [sessionId, clientId, next] = replaceQueuedMessage.mock.calls[0] as unknown as [
      string,
      string,
      AgentInputQueuedMessage,
    ];
    expect(sessionId).toBe('worker-session-1');
    expect(clientId).toBe('q-lead');
    // 派发格式重建:text 走 formatAgentMessage(lead + workerId 桥注),持久化走
    // formatOrcaCommunicationMessage(JSON),displayText 是原始正文;身份字段锚定原条目。
    expect(next.clientId).toBe('q-lead');
    expect(next.text).toContain('[From Orca Lead]');
    expect(next.text).toContain('改后的任务');
    expect(next.text).toContain('worker-1');
    expect(JSON.parse(next.persistedContent)).toEqual({ orcaSource: 'lead', content: '改后的任务' });
    expect(next.chatMessage.content).toBe(next.persistedContent);
    expect(next.chatMessage.createdAt).toBe('2026-07-21T00:00:00.000Z');
    expect(next.origin).toEqual({ kind: 'orca', senderLabel: 'Lead', displayText: '改后的任务' });
  });

  it('refuses to touch entries that are missing, non-lead, or consuming', async () => {
    const removeQueuedMessage = vi.fn(() => true);
    const replaceQueuedMessage = vi.fn(() => true);
    const { service } = createDeps({
      getSessionQueueSnapshot: vi.fn(async () => ({
        pendingQueue: [
          queuedItem('q-user'),
          queuedItem('q-consuming', leadOrigin),
        ],
        steeringClientIds: ['q-consuming'],
        consumingClientIds: ['q-consuming'],
      })),
      removeQueuedMessage,
      replaceQueuedMessage,
    });
    const base = { callerLeadSessionId: 'lead-1', workerRef: 'worker-1' };

    await expect(
      service.updateWorkerQueuedMessage({ ...base, queuedMessageId: 'q-gone', message: 'x' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'QUEUED_MESSAGE_NOT_FOUND' });
    await expect(
      service.updateWorkerQueuedMessage({ ...base, queuedMessageId: 'q-user', message: 'x' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_LEAD_MESSAGE' });
    await expect(
      service.updateWorkerQueuedMessage({ ...base, queuedMessageId: 'q-consuming', message: 'x' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });
    await expect(
      service.updateWorkerQueuedMessage({ ...base, queuedMessageId: 'q-user', message: '   ' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });

    await expect(
      service.cancelWorkerQueuedMessage({ ...base, queuedMessageId: 'q-user' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_LEAD_MESSAGE' });
    await expect(
      service.cancelWorkerQueuedMessage({ ...base, queuedMessageId: 'q-consuming' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });

    expect(removeQueuedMessage).not.toHaveBeenCalled();
    expect(replaceQueuedMessage).not.toHaveBeenCalled();
  });

  it('cancels a lead queued entry via coordinator remove and reports consumed races', async () => {
    const removeQueuedMessage = vi.fn(() => true);
    const { service } = createDeps({
      getSessionQueueSnapshot: vi.fn(async () => ({
        pendingQueue: [queuedItem('q-lead', leadOrigin)],
        steeringClientIds: [],
        consumingClientIds: [],
      })),
      removeQueuedMessage,
    });

    await expect(
      service.cancelWorkerQueuedMessage({
        callerLeadSessionId: 'lead-1',
        workerRef: 'worker-1',
        queuedMessageId: 'q-lead',
      }),
    ).resolves.toEqual({ ok: true, workerId: 'worker-1', queuedMessageId: 'q-lead' });
    expect(removeQueuedMessage).toHaveBeenCalledWith('worker-session-1', 'q-lead');

    // resolve 与 remove 之间的窄竞态:条目已被 drain 取走 → 明确报已消费。
    removeQueuedMessage.mockReturnValueOnce(false);
    await expect(
      service.cancelWorkerQueuedMessage({
        callerLeadSessionId: 'lead-1',
        workerRef: 'worker-1',
        queuedMessageId: 'q-lead',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'QUEUED_MESSAGE_NOT_FOUND' });
  });

  it('threads queuedMessageId through queued dispatch results', async () => {
    const { service } = createDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
      dispatchWorkerMessage: vi.fn(async (params) => ({
        ok: true,
        mode: 'queued',
        clientId: 'client-queued-9',
        dispatchOutcome: {
          kind: 'session-dispatch',
          source: params.dispatchMeta.source,
          dispatched: true,
          wakeKind: 'queued',
        },
        targetTitle: 'Worker',
        targetLastUserSendAt: null,
      } satisfies DispatchWorkerMessageResult)),
    });

    await expect(
      service.sendToWorker({
        callerLeadSessionId: 'lead-1',
        targetSessionId: 'worker-session-1',
        message: '排队任务',
      }),
    ).resolves.toMatchObject({
      ok: true,
      wakeKind: 'queued',
      queuedMessageId: 'client-queued-9',
    });
  });
});
