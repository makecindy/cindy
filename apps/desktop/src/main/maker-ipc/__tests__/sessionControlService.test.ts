import { formatForwardedRequest } from '../../../shared/forwardedRequest.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { admitPluginTaskAction, admitTaskAction } from '../taskActionAuthorization.js';
import {
  authorizeSessionQueueReorder,
  createSessionControlService,
  rebuildSessionQueueItem,
  sessionQueueOriginForDispatcher,
  type SessionSteerTurnIdentity,
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
    capabilities: {
      sameTurnSteer: { supported: opts?.steerSupported ?? true },
      permissionModes: [{ id: 'ask' as const }, { id: 'auto' as const }, { id: 'bypassPermissions' as const }],
      setPermissionModeMidSession: { supported: true },
    },
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
    setSessionPermissionMode: vi.fn(async ({ beforeMutation }: { sessionId: string; mode: string; beforeMutation?: () => Promise<void> }) => { await beforeMutation?.(); return true; }),
    getSessionRuntimeDetails: vi.fn(async () => ({
      ...activity,
      runtimeGeneration: 0,
      baselineProfile: {
        agentKind: 'codex' as const,
        model: 'model',
        providerId: 'openai',
        effort: 'medium' as const,
        fastMode: false,
      },
      effectiveProfile: {
        agentKind: 'codex' as const,
        model: 'model',
        providerId: 'openai',
        effort: 'medium' as const,
        fastMode: false,
      },
      pendingMutation: null,
      fallbackEnabled: false,
    })),
    setSessionRuntime: vi.fn(async () => ({
      ok: true as const,
      status: 'applied' as const,
      generation: 1,
      effectiveProfile: {
        agentKind: 'codex' as const,
        model: 'next',
        providerId: 'openai',
        effort: 'high' as const,
        fastMode: false,
      },
      pendingMutation: null,
    })),
    assertExternalInputAllowed: vi.fn(async () => undefined),
    createQueuedMessage: vi.fn(
      async ({
        queuedMessageId,
        callerSessionId,
        message,
      }: {
        queuedMessageId: string;
        callerSessionId?: string;
        message: string;
      }) => ({
        ...item(callerSessionId ? { kind: 'session', senderSessionId: callerSessionId, displayText: message } : undefined),
        clientId: queuedMessageId,
        chatMessage: { clientId: queuedMessageId, role: 'user' as const, content: message },
      }),
    ),
    steerQueuedMessage: vi.fn(async (
      _sessionId: string, _item: AgentInputQueuedMessage, _turn: SessionSteerTurnIdentity,
    ) => opts?.steerAccepted ?? true),
    getQueueSnapshot: vi.fn(async () => ({ pendingQueue: [queueItem], consumingClientIds: [] })),
    replaceQueuedMessage: vi.fn(() => true),
    removeQueuedMessage: vi.fn(() => true),
    steerStoredQueuedMessage: vi.fn(async () => ({ kind: 'steered' as const })),
    moveQueuedMessage: vi.fn(() => 0),
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

  it('snapshots the dispatcher title for the receiver source label', () => {
    expect(
      sessionQueueOriginForDispatcher({
        dispatcherSessionId: 'caller',
        dispatcherSessionTitle: '  Release checklist  ',
        message: 'follow-up',
      }),
    ).toEqual({
      kind: 'session',
      senderSessionId: 'caller',
      displayText: 'follow-up',
      senderSessionTitle: 'Release checklist',
    });
    expect(
      sessionQueueOriginForDispatcher({
        dispatcherSessionId: 'caller',
        dispatcherSessionTitle: '   ',
        message: 'follow-up',
      }),
    ).not.toHaveProperty('senderSessionTitle');
    expect(
      sessionQueueOriginForDispatcher({
        dispatcherSessionId: 'bot-task',
        dispatcherSessionTitle: 'Weekly feedback',
        dispatcherBot: { id: 'bot-1', name: 'Cindy' },
        message: 'follow-up',
      }),
    ).toMatchObject({ senderBotId: 'bot-1', senderBotName: 'Cindy' });
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
      expect.objectContaining({clientId:'queued-1',text:'before'}),
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

  it('steers and moves own-sent rows or machine rows in the caller\'s own queue only', async () => {
    const { deps, service } = setup();
    const base = { callerSessionId: 'caller', targetSessionId: 'target', queuedMessageId: 'queued-1' };
    await expect(service.steerQueuedMessage(base))
      .resolves.toEqual({ ok: true, queuedMessageId: 'queued-1', delivery: 'steered' });
    expect(deps.steerStoredQueuedMessage).toHaveBeenCalledWith('target', 'queued-1');
    await expect(service.moveQueuedMessage({ ...base, position: 0 }))
      .resolves.toEqual({ ok: true, queuedMessageId: 'queued-1', position: 0 });
    await expect(service.moveQueuedMessage({ ...base, position: -1 }))
      .resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });

    const own = (origin: AgentInputQueuedMessage['origin'], extra: Partial<AgentInputQueuedMessage> = {}) =>
      authorizeSessionQueueReorder({ ...item(origin), ...extra }, 'target', 'target').ok;
    expect(own({ kind: 'orca', senderLabel: 'reviewer', displayText: 'r' })).toBe(true);
    expect(own({ kind: 'session', senderSessionId: 'other', displayText: 'r' })).toBe(true);
    expect(own(undefined)).toBe(false);
    expect(own({ kind: 'session', senderSessionId: 'other', senderBotId: 'bot-1', displayText: 'r' })).toBe(true);
    expect(own({ kind: 'session', senderSessionId: 'other', displayText: 'r' }, {
      sourcePlugin: { pluginId: 'plugin-1', name: 'Plugin' },
    } as Partial<AgentInputQueuedMessage>)).toBe(false);
    // Someone else's queue: only rows this session sent itself.
    expect(authorizeSessionQueueReorder(
      item({ kind: 'session', senderSessionId: 'other', displayText: 'r' }), 'caller', 'target',
    ).ok).toBe(false);
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
        queued,
      );
    },
  );

  it('keeps the host attachment envelope when the sender edits its own attachment item', () => {
    const queued = item({ kind: 'session', senderSessionId: 'caller', displayText: 'before' });
    queued.files = [{ name: 'notes.txt', path: '/repo/notes.txt', category: 'file' } as never];
    queued.persistedContent = JSON.stringify({
      text: 'before',
      images: [],
      files: [{ name: 'notes.txt', path: '/repo/notes.txt' }],
    });

    const updated = rebuildSessionQueueItem(queued, 'replacement');

    expect(JSON.parse(updated.persistedContent)).toMatchObject({
      text: 'replacement',
      files: [{ name: 'notes.txt', path: '/repo/notes.txt' }],
    });
    expect(updated.origin).toMatchObject({ kind: 'session', displayText: 'replacement' });
  });

  it('edits only the supplement and preserves an existing delegated continuation receipt', () => {
    const queued = item({ kind: 'session', senderSessionId: 'caller', displayText: 'before' });
    const request = { userText: '  只检查\n不要发布  ', sessionId: 'owner', clientId: 'human' };
    queued.autoReviewUserText = { kind: 'delegated-continuation', request };
    const updated = rebuildSessionQueueItem(queued, '用户原话：可以发布');
    expect(updated.persistedContent).toBe(formatForwardedRequest(request, '用户原话：可以发布'));
    expect(updated.autoReviewUserText).toEqual(queued.autoReviewUserText);
  });

  // 2026-11-05: edited text is a new hand-off. It speaks for the owner only when the editor's
  // own request checked exactly that text; otherwise the item keeps its provenance only.
  it('re-checks an edited plain hand-off instead of carrying the old authority', () => {
    const queued = item({ kind: 'session', senderSessionId: 'caller', displayText: 'before' });
    const provenance = { sessionId: 'owner', clientId: 'human' };
    queued.autoReviewUserText = { kind: 'agent-request', request: { ...provenance,
      plainBody: true, delegatedText: 'before' } };
    const unchecked = rebuildSessionQueueItem(queued, 'Also deploy it.');
    expect(unchecked.persistedContent).toBe('Also deploy it.');
    expect(unchecked.autoReviewUserText).toEqual({ kind: 'agent-request', request: { ...provenance, plainBody: true } });
    const recheck = { ...provenance, plainBody: true as const, delegatedText: 'Merge it after checks.' };
    const checked = rebuildSessionQueueItem(queued, 'Merge it after checks.', { kind: 'agent-request', request: recheck });
    expect(checked.persistedContent).toBe('Merge it after checks.');
    expect(checked.autoReviewUserText).toEqual({ kind: 'agent-request', request: recheck });
  });

  // Review feedback on #9023: an ordinary queued message (no authority) later edited at the
  // user's request must adopt the editor's freshly checked receipt, not keep the empty one.
  it('adopts a freshly checked receipt when editing an ordinary queued message', () => {
    const queued = item({ kind: 'session', senderSessionId: 'caller', displayText: 'before' });
    queued.autoReviewUserText = { kind: 'agent-request' };
    const recheck = { sessionId: 'owner', clientId: 'human', plainBody: true as const, delegatedText: 'Merge it after checks.' };
    const checked = rebuildSessionQueueItem(queued, 'Merge it after checks.', { kind: 'agent-request', request: recheck });
    expect(checked.autoReviewUserText).toEqual({ kind: 'agent-request', request: recheck });
    const unchecked = rebuildSessionQueueItem(queued, 'Merge it after checks.');
    expect(unchecked.autoReviewUserText).toEqual({ kind: 'agent-request', request: { userText: null } });
  });

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

  // Unit parity #16: permission-only changes must use the UI commit service, preserving
  // the model profile/pending mutation; previous runtime tests only exercised model axes.
  it.each([0, 99])('changes permission without replacing the model profile (generation=%s)', async generation => {
    const { deps, service } = setup();
    const result = await service.setSessionRuntime({ targetSessionId: 'target', expectedGeneration: generation, patch: { permissionMode: 'bypassPermissions' } });
    expect(result).toMatchObject(generation === 0 ? { ok: true, permissionMode: 'bypassPermissions', generation: 0 } : { ok: false, errorCode: 'CONFLICT' });
    expect(deps.setSessionRuntime).not.toHaveBeenCalled();
    expect(deps.setSessionPermissionMode).toHaveBeenCalledTimes(generation === 0 ? 1 : 0);
  });

  // Unit, #9801 / 4537184245: an admitted caller's own permission generation is
  // part of its authority. Existing permission cases had no admission. Reject a
  // permission-only or mixed patch before either runtime or permission is written.
  it.each([false, true])('rejects admitted self permission changes without partial writes (mixed=%s)', async mixed => {
    const { deps, service } = setup();
    const patch = { permissionMode: 'bypassPermissions' as const, ...(mixed ? { model: 'next' } : {}) };
    const decision = await admitTaskAction(
      { server: 'cindy_helper', sessionId: 'target', tool: 'set_session_runtime', args: {} },
      { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => {} },
    );
    if (!decision.ok || !decision.run) throw new Error('missing action scope');
    await expect(decision.run(() => service.setSessionRuntime({ targetSessionId: 'target', patch })))
      .resolves.toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(deps.setSessionRuntime).not.toHaveBeenCalled();
    expect(deps.setSessionPermissionMode).not.toHaveBeenCalled();
  });

  it.each(['other-task', 'plugin'] as const)('preserves permission changes from an admitted %s caller', async caller => {
    const { deps, service } = setup();
    const call = { server: 'cindy_helper' as const, tool: 'set_session_runtime', args: {} };
    const decision = caller === 'plugin'
      ? admitPluginTaskAction({ ...call, sessionId: undefined, caller: { kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 } }, () => {})
      : await admitTaskAction({ ...call, sessionId: 'caller' },
        { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => {} });
    if (!decision.ok || !decision.run) throw new Error('missing action scope');
    await expect(decision.run(() => service.setSessionRuntime({ targetSessionId: 'target', patch: { permissionMode: 'auto' } })))
      .resolves.toMatchObject({ ok: true, permissionMode: 'auto' });
    expect(deps.setSessionPermissionMode).toHaveBeenCalledOnce();
  });

  // Unit #9801/uKm_: the real service previously wrote a model before a Codex
  // permission rejection. Existing cases only checked permission-only or self admission.
  it.each(['mode', 'mid-session'] as const)('rejects unsupported permission %s before a mixed model write', async unsupported => {
    const { deps, live, service } = setup();
    if (unsupported === 'mid-session') live.capabilities.setPermissionModeMidSession.supported = false;
    const result = await service.setSessionRuntime({ targetSessionId: 'target', expectedGeneration: 0,
      patch: { model: 'next', permissionMode: unsupported === 'mode' ? 'acceptEdits' : 'auto' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(deps.setSessionRuntime).not.toHaveBeenCalled();
    expect(deps.setSessionPermissionMode).not.toHaveBeenCalled();
  });

  it.each(['applied', 'deferred'] as const)('reports the actual %s model result when the later permission commit fails', async status => {
    const { deps, service } = setup();
    const runtime = { ...await deps.setSessionRuntime(), status, generation: 7 };
    deps.setSessionRuntime.mockClear().mockResolvedValueOnce(runtime as Awaited<ReturnType<typeof deps.setSessionRuntime>>);
    deps.setSessionPermissionMode.mockRejectedValueOnce(Object.assign(new Error('permission persistence failed'), { code: 'WRITE_FAILED' }));
    const result = await service.setSessionRuntime({ targetSessionId: 'target', expectedGeneration: 0,
      patch: { model: 'next', permissionMode: 'auto' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'INTERNAL', data: {
      runtime: { status, generation: 7, fields: ['model'] },
      failed: 'permission_mode', original_error: { code: 'WRITE_FAILED', message: 'permission persistence failed' },
    } });
    expect(deps.setSessionRuntime).toHaveBeenCalledOnce();
    expect(deps.setSessionPermissionMode).toHaveBeenCalledOnce();
  });

  it('keeps a supported model and permission change in one successful call', async () => {
    const { deps, service } = setup();
    await expect(service.setSessionRuntime({ targetSessionId: 'target', expectedGeneration: 0,
      patch: { model: 'next', permissionMode: 'auto' } }))
      .resolves.toMatchObject({ ok: true, status: 'applied', generation: 1, permissionMode: 'auto',
        effectiveProfile: { model: 'next' } });
    expect(deps.setSessionRuntime).toHaveBeenCalledOnce();
    expect(deps.setSessionPermissionMode).toHaveBeenCalledOnce();
  });

  it('preserves model-only changes by an admitted caller to itself', async () => {
    const { deps, service } = setup();
    const decision = await admitTaskAction(
      { server: 'cindy_helper', sessionId: 'target', tool: 'set_session_runtime', args: {} },
      { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => {} },
    );
    if (!decision.ok || !decision.run) throw new Error('missing action scope');
    await expect(decision.run(() => service.setSessionRuntime({ targetSessionId: 'target', patch: { model: 'next' } })))
      .resolves.toMatchObject({ ok: true, generation: 1 });
    expect(deps.setSessionRuntime).toHaveBeenCalledOnce();
    expect(deps.setSessionPermissionMode).not.toHaveBeenCalled();
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
      { session: live, turnGeneration: 3, beforeMutation: expect.any(Function) },
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

  // #6399: admission alone did not cover revocation during asynchronous steering.
  // Unit: real action scope + service; existing turn-race tests did not revoke authority.
  // Minimum: revoke at one awaited boundary, then verify no provider acceptance.
  it.each(['external-input', 'message-build', 'final-dispatch', 'host-check'] as const)(
    'rejects task action revocation at the %s steer boundary',
    async (boundary) => {
      const { deps, service } = setup();
      let current = true;
      const accepted: string[] = [];
      const decision = await admitTaskAction(
        { server: 'cindy_helper', sessionId: 'caller', tool: 'steer_session', args: {} },
        {
          key: 'input', ownerInput: true, delegated: false,
          assertCurrent: async () => {
            if (!current) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          },
        },
      );
      if (!decision.ok || !decision.run) throw new Error('missing action scope');
      if (boundary === 'external-input') {
        deps.assertExternalInputAllowed.mockImplementationOnce(async () => { current = false; });
      }
      if (boundary === 'message-build') {
        deps.createQueuedMessage.mockImplementationOnce(async () => {
          current = false;
          return item();
        });
      }
      deps.steerQueuedMessage.mockImplementationOnce(async (_id, _item, turn) => {
        if (boundary === 'final-dispatch') current = false;
        await turn.beforeMutation?.();
        accepted.push('sent');
        return true;
      });
      await expect(decision.run(() => service.steerSession({
        callerSessionId: 'caller', targetSessionId: 'target', message: 'urgent',
        ...(boundary === 'host-check' ? { beforeMutation: async () => { current = false; } } : {}),
      }))).rejects.toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
      expect(accepted).toEqual([]);
    },
  );

  it('passes a stable host steer ID to the coordinator without allocating a replacement', async () => {
    const { deps, service } = setup();
    const params = { callerSessionId: 'caller', targetSessionId: 'target', message: 'urgent', queuedMessageId: 'stable-steer' };
    expect(await service.steerSession(params)).toEqual({ ok: true, queuedMessageId: 'stable-steer' });
    expect(await service.steerSession(params)).toEqual({ ok: true, queuedMessageId: 'stable-steer' });
    expect(deps.createId).not.toHaveBeenCalled();
    expect(deps.createQueuedMessage).toHaveBeenNthCalledWith(1, params);
    expect(deps.createQueuedMessage).toHaveBeenNthCalledWith(2, params);
    expect(deps.steerQueuedMessage).toHaveBeenLastCalledWith('target',
      expect.objectContaining({ clientId: 'stable-steer' }), expect.any(Object));
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

  it('forwards an atomic runtime patch only after the target is known to exist', async () => {
    const { deps, service } = setup();
    await expect(
      service.setSessionRuntime({
        targetSessionId: 'target',
        expectedGeneration: 4,
        patch: { model: 'next', effort: 'high', fastMode: true },
      }),
    ).resolves.toMatchObject({ ok: true, status: 'applied', generation: 1 });
    expect(deps.setSessionRuntime).toHaveBeenCalledWith({
      beforeMutation: expect.any(Function),
      targetSessionId: 'target',
      expectedGeneration: 4,
      patch: { model: 'next', effort: 'high', fastMode: true },
    });

    const missing = setup({ exists: false, live: false });
    await expect(
      missing.service.setSessionRuntime({
        targetSessionId: 'gone',
        expectedGeneration: 0,
        patch: { effort: 'high' },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(missing.deps.setSessionRuntime).not.toHaveBeenCalled();
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
