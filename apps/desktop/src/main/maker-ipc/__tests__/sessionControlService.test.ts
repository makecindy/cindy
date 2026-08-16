import { describe, expect, it, vi } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  createSessionControlService,
  sessionQueueOriginForDispatcher,
} from '../sessionControlService.js';

function item(origin?: AgentInputQueuedMessage['origin']): AgentInputQueuedMessage {
  return {
    clientId: 'queued-1',
    text: 'before',
    persistedContent: 'before',
    model: 'model',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: { clientId: 'queued-1', role: 'user', content: 'before' },
    createOpts: {
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'model',
      effort: 'medium',
      permissionMode: 'default',
    },
    ...(origin ? { origin } : {}),
  };
}

function setup(opts?: {
  exists?: boolean;
  running?: boolean;
  steerSupported?: boolean;
  steerAccepted?: boolean;
  queueItem?: AgentInputQueuedMessage;
}) {
  const runtime = {
    active: true,
    turnGeneration: 3,
    startedAtMs: 1,
    lastActivityAtMs: 2,
    currentActionSummary: '正在思考',
    gracefulStopState: 'none' as const,
  };
  const live = {
    agentKind: 'codex' as const,
    capabilities: { sameTurnSteer: { supported: opts?.steerSupported ?? true } },
    isTurnRunning: vi.fn(() => opts?.running ?? true),
    requestGracefulStop: vi.fn(async () => ({
      status: 'waiting-for-safe-point' as const,
      turnGeneration: 3,
    })),
    getRuntimeSnapshot: vi.fn(() => runtime),
  };
  const getLiveSession = vi.fn<() => typeof live | null>(() => live);
  const queueItem =
    opts?.queueItem ??
    item({
      kind: 'session',
      senderSessionId: 'caller',
      displayText: 'before',
    });
  const deps = {
    sessionExists: vi.fn(async () => opts?.exists ?? true),
    getLiveSession,
    assertExternalInputAllowed: vi.fn(async () => undefined),
    createQueuedMessage: vi.fn(
      async ({
        queuedMessageId,
        callerSessionId,
        message,
      }: {
        queuedMessageId: string;
        callerSessionId: string;
        message: string;
      }) => ({
        ...item({ kind: 'session', senderSessionId: callerSessionId, displayText: message }),
        clientId: queuedMessageId,
        chatMessage: { clientId: queuedMessageId, role: 'user' as const, content: message },
      }),
    ),
    steerQueuedMessage: vi.fn(async () => opts?.steerAccepted ?? true),
    getQueueSnapshot: vi.fn(async () => ({ pendingQueue: [queueItem], consumingClientIds: [] })),
    replaceQueuedMessage: vi.fn(() => true),
    removeQueuedMessage: vi.fn(() => true),
    createId: vi.fn(() => 'steer-1'),
  };
  return { deps, live, service: createSessionControlService(deps) };
}

describe('session control domain service', () => {
  it('marks ordinary send_to_session queue rows with the dispatcher identity', () => {
    expect(
      sessionQueueOriginForDispatcher({
        dispatcherSessionId: 'caller',
        message: 'follow-up',
      }),
    ).toEqual({
      kind: 'session',
      senderSessionId: 'caller',
      displayText: 'follow-up',
    });
    const explicit = { kind: 'scheduler' as const, scheduleId: 's', scheduleName: 'nightly' };
    expect(
      sessionQueueOriginForDispatcher({
        dispatcherSessionId: 'caller',
        message: 'follow-up',
        explicitOrigin: explicit,
      }),
    ).toBe(explicit);
  });

  it('shares queue lifecycle while enforcing sender ownership and preserving identity', async () => {
    const { deps, service } = setup();
    await expect(
      service.updateQueuedMessage({
        callerSessionId: 'caller',
        targetSessionId: 'target',
        queuedMessageId: 'queued-1',
        message: 'after',
      }),
    ).resolves.toEqual({ ok: true, queuedMessageId: 'queued-1' });
    expect(deps.replaceQueuedMessage).toHaveBeenCalledWith(
      'target',
      'queued-1',
      expect.objectContaining({
        clientId: 'queued-1',
        text: 'after',
        origin: expect.objectContaining({ displayText: 'after' }),
      }),
    );

    const foreign = setup({
      queueItem: item({ kind: 'session', senderSessionId: 'other', displayText: 'before' }),
    });
    await expect(
      foreign.service.cancelQueuedMessage({
        callerSessionId: 'caller',
        targetSessionId: 'target',
        queuedMessageId: 'queued-1',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });
    expect(foreign.deps.removeQueuedMessage).not.toHaveBeenCalled();
  });

  it('steers only a live supported turn and never falls back after a terminal race', async () => {
    const { deps, service } = setup();
    await expect(
      service.steerSession({
        callerSessionId: 'caller',
        targetSessionId: 'target',
        message: 'urgent',
      }),
    ).resolves.toEqual({ ok: true, queuedMessageId: 'steer-1' });
    expect(deps.assertExternalInputAllowed).toHaveBeenCalledWith('target');
    expect(deps.createQueuedMessage).toHaveBeenCalledWith({
      callerSessionId: 'caller',
      targetSessionId: 'target',
      queuedMessageId: 'steer-1',
      message: 'urgent',
    });

    await expect(
      setup({ running: false }).service.steerSession({
        callerSessionId: 'caller',
        targetSessionId: 'target',
        message: 'urgent',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NO_ACTIVE_TURN' });
    await expect(
      setup({ steerSupported: false }).service.steerSession({
        callerSessionId: 'caller',
        targetSessionId: 'target',
        message: 'urgent',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });

    const raced = setup({ steerAccepted: false });
    raced.live.isTurnRunning.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(
      raced.service.steerSession({
        callerSessionId: 'caller',
        targetSessionId: 'target',
        message: 'urgent',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NO_ACTIVE_TURN' });
  });

  it('requests graceful stop without hard-abort semantics and reports offline runtime as inactive', async () => {
    const { live, service } = setup();
    await expect(service.stopSessionTurn({ targetSessionId: 'target' })).resolves.toEqual({
      ok: true,
      status: 'waiting-for-safe-point',
      turnGeneration: 3,
    });
    expect(live.requestGracefulStop).toHaveBeenCalledOnce();
    await expect(service.getSessionRuntime({ targetSessionId: 'target' })).resolves.toEqual({
      ok: true,
      runtime: expect.objectContaining({ active: true, currentActionSummary: '正在思考' }),
    });

    const offline = setup();
    offline.deps.getLiveSession.mockReturnValue(null);
    await expect(offline.service.stopSessionTurn({ targetSessionId: 'target' })).resolves.toEqual({
      ok: true,
      status: 'no-active-turn',
    });
    await expect(offline.service.getSessionRuntime({ targetSessionId: 'target' })).resolves.toEqual(
      {
        ok: true,
        runtime: expect.objectContaining({ active: false, gracefulStopState: 'none' }),
      },
    );
  });

  it('returns NOT_FOUND before reading mutable target state', async () => {
    const { deps, service } = setup({ exists: false });
    await expect(
      service.cancelQueuedMessage({
        callerSessionId: 'caller',
        targetSessionId: 'gone',
        queuedMessageId: 'queued-1',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    await expect(service.stopSessionTurn({ targetSessionId: 'gone' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });
    expect(deps.getQueueSnapshot).not.toHaveBeenCalled();
    expect(deps.getLiveSession).not.toHaveBeenCalled();
  });
});
