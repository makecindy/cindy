import { describe, expect, it, vi } from 'vitest';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  createSessionControlService,
  rebuildSessionQueueItem,
  sessionQueueOriginForDispatcher,
} from '../sessionControlService.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
  live?: boolean;
  running?: boolean;
  steerSupported?: boolean;
  steerAccepted?: boolean;
  queueItem?: AgentInputQueuedMessage;
}) {
  const activity: SessionActivitySnapshot = {
    sessionId: 'target',
    phase: 'running' as const,
    recordStatus: 'active' as const,
    attention: false,
    workflow: null,
    source: 'live' as const,
    startedAtMs: 1,
    lastActivityAtMs: 2,
    currentActionSummary: '正在思考',
    turnGeneration: null,
    gracefulStopState: 'none' as const,
  };
  const control = {
    active: true,
    turnGeneration: 3,
    activeToolCount: 0,
    pendingInteractionCount: 0,
    gracefulStopState: 'none' as const,
  };
  const live = {
    agentKind: 'codex' as const,
    capabilities: { sameTurnSteer: { supported: opts?.steerSupported ?? true } },
    isTurnRunning: vi.fn(() => opts?.running ?? true),
    getTurnGeneration: vi.fn(() => 3),
    requestGracefulStop: vi.fn(async () => ({
      status: 'waiting-for-safe-point' as const,
      turnGeneration: 3,
    })),
    getTurnControlSnapshot: vi.fn(() => control),
  };
  const getLiveSession = vi.fn<() => typeof live | null>(() =>
    opts?.live === false ? null : live,
  );
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
    getSessionActivitySnapshot: vi.fn(async () => activity),
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

  it.each([
    ['plain text', 'before', 'replacement'],
    ['JSON object', '{"action":"old"}', '{"action":"new"}'],
    ['JSON array', '["old"]', '["new"]'],
  ])(
    'replaces session-origin %s as raw provider and persisted history text',
    async (_label, before, replacement) => {
      const queued = item({
        kind: 'session',
        senderSessionId: 'caller',
        displayText: before,
      });
      queued.text = before;
      queued.persistedContent = before;
      queued.chatMessage.content = before;
      const { deps, service } = setup({ queueItem: queued });

      await expect(
        service.updateQueuedMessage({
          callerSessionId: 'caller',
          targetSessionId: 'target',
          queuedMessageId: 'queued-1',
          message: replacement,
        }),
      ).resolves.toEqual({ ok: true, queuedMessageId: 'queued-1' });

      expect(deps.replaceQueuedMessage).toHaveBeenCalledWith(
        'target',
        'queued-1',
        expect.objectContaining({
          text: replacement,
          persistedContent: replacement,
          chatMessage: expect.objectContaining({ content: replacement }),
          origin: expect.objectContaining({ displayText: replacement }),
        }),
      );
    },
  );

  it('keeps renderer composer envelopes intact when rebuilding a non-session queue item', () => {
    const queued = item();
    queued.persistedContent = JSON.stringify({
      text: 'before',
      images: [{ fileId: 'image-1' }],
      files: [{ name: 'notes.txt', path: '/repo/notes.txt' }],
    });

    const updated = rebuildSessionQueueItem(queued, 'replacement');

    expect(JSON.parse(updated.persistedContent)).toEqual({
      text: 'replacement',
      images: [{ fileId: 'image-1' }],
      files: [{ name: 'notes.txt', path: '/repo/notes.txt' }],
      slashCommandRanges: [],
    });
  });

  it('steers only a live supported turn and never falls back after a terminal race', async () => {
    const { deps, live, service } = setup();
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
    expect(deps.steerQueuedMessage).toHaveBeenCalledWith(
      'target',
      expect.objectContaining({ clientId: 'steer-1' }),
      { session: live, turnGeneration: 3 },
    );

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

  it('rejects when the original turn changes while the control message is being built', async () => {
    const generationRace = setup();
    const generationGate = deferred<AgentInputQueuedMessage>();
    generationRace.deps.createQueuedMessage.mockImplementationOnce(() => generationGate.promise);
    const generationResult = generationRace.service.steerSession({
      callerSessionId: 'caller',
      targetSessionId: 'target',
      message: 'urgent',
    });
    while (generationRace.deps.createQueuedMessage.mock.calls.length === 0) {
      await Promise.resolve();
    }
    generationRace.live.getTurnGeneration.mockReturnValue(4);
    generationGate.resolve(item());
    await expect(generationResult).resolves.toMatchObject({
      ok: false,
      errorCode: 'NO_ACTIVE_TURN',
    });
    expect(generationRace.deps.steerQueuedMessage).not.toHaveBeenCalled();

    const replacementRace = setup();
    const replacement = {
      ...replacementRace.live,
      isTurnRunning: vi.fn(() => true),
      getTurnGeneration: vi.fn(() => 3),
    };
    replacementRace.deps.createQueuedMessage.mockImplementationOnce(async () => {
      replacementRace.deps.getLiveSession.mockReturnValue(replacement);
      return item();
    });
    await expect(
      replacementRace.service.steerSession({
        callerSessionId: 'caller',
        targetSessionId: 'target',
        message: 'urgent',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NO_ACTIVE_TURN' });
    expect(replacementRace.deps.steerQueuedMessage).not.toHaveBeenCalled();
  });

  it('merges canonical activity with live stop control without hard-abort semantics', async () => {
    const { live, service } = setup();
    await expect(service.stopSessionTurn({ targetSessionId: 'target' })).resolves.toEqual({
      ok: true,
      status: 'waiting-for-safe-point',
      turnGeneration: 3,
    });
    expect(live.requestGracefulStop).toHaveBeenCalledOnce();
    await expect(service.getSessionRuntime({ targetSessionId: 'target' })).resolves.toEqual({
      ok: true,
      runtime: expect.objectContaining({
        phase: 'running',
        currentActionSummary: '正在思考',
        turnGeneration: 3,
        gracefulStopState: 'none',
      }),
    });

    const offline = setup();
    offline.deps.getLiveSession.mockReturnValue(null);
    offline.deps.getSessionActivitySnapshot.mockResolvedValue({
      sessionId: 'target',
      phase: 'completed',
      recordStatus: 'archived',
      startedAtMs: 1,
      lastActivityAtMs: 2,
      currentActionSummary: '上次运行已正常结束',
      attention: false,
      workflow: null,
      turnGeneration: null,
      gracefulStopState: 'none',
      source: 'persisted',
    });
    await expect(offline.service.stopSessionTurn({ targetSessionId: 'target' })).resolves.toEqual({
      ok: true,
      status: 'no-active-turn',
    });
    await expect(offline.service.getSessionRuntime({ targetSessionId: 'target' })).resolves.toEqual(
      {
        ok: true,
        runtime: expect.objectContaining({
          phase: 'completed',
          recordStatus: 'archived',
          turnGeneration: null,
          gracefulStopState: 'none',
        }),
      },
    );
  });

  it('prefers an in-memory live session when persisted metadata is unavailable', async () => {
    const { deps, live, service } = setup();
    deps.sessionExists.mockRejectedValue(new Error('localDb not ready'));

    await expect(service.stopSessionTurn({ targetSessionId: 'target' })).resolves.toEqual({
      ok: true,
      status: 'waiting-for-safe-point',
      turnGeneration: 3,
    });
    expect(live.requestGracefulStop).toHaveBeenCalledOnce();
    expect(deps.sessionExists).not.toHaveBeenCalled();
  });

  it('preserves metadata read failures when no live session can prove the target exists', async () => {
    const { deps, service } = setup({ live: false });
    const storageError = new Error('storage unavailable');
    deps.sessionExists.mockRejectedValue(storageError);

    await expect(service.stopSessionTurn({ targetSessionId: 'target' })).rejects.toBe(storageError);
  });

  it('returns NOT_FOUND before reading mutable target state', async () => {
    const { deps, service } = setup({ exists: false, live: false });
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
    expect(deps.getLiveSession).toHaveBeenCalled();
  });
});
