import { describe, expect, it, vi } from 'vitest';

import { Session } from './session.js';
import { TurnDispatchRejectedError, type AgentSessionHandle } from './agents/base-agent.js';
import type {
  AgentEvent,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
  SendOrigin,
} from './types/events.js';

function createLogger() {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn: vi.fn(),
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createHandle(opts?: {
  gracefulStop?: (opts?: { signal?: AbortSignal }) => Promise<void>;
  supported?: boolean;
}) {
  let running = false;
  const pending: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  let interactionResolver: InteractionResolver | null = null;
  async function* events(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const event = pending.shift();
      if (event) yield event;
    }
  }
  const requestGracefulStop = vi.fn(opts?.gracefulStop ?? (async () => undefined));
  const abort = vi.fn(async () => {
    running = false;
  });
  const handle = {
    id: 'thread-control',
    agentKind: 'claude-code',
    model: 'claude-opus-5',
    events,
    async send() {
      running = true;
    },
    async steer() {},
    abort,
    ...(opts?.supported === false ? {} : { requestGracefulStop }),
    async close() {
      running = false;
    },
    isTurnRunning: () => running,
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver(resolver: InteractionResolver) {
      interactionResolver = resolver;
    },
  } as unknown as AgentSessionHandle;
  return {
    handle,
    requestGracefulStop,
    abort,
    push(event: AgentEvent) {
      if (event.type === 'done' || event.type === 'error') running = false;
      pending.push(event);
      notify?.();
      notify = null;
    },
    requestInteraction(request: InteractionRequest): Promise<InteractionDecision> {
      if (!interactionResolver) throw new Error('interaction resolver not installed');
      return interactionResolver(request);
    },
  };
}

function createSession(
  stub: ReturnType<typeof createHandle>,
  agentKind: Session['agentKind'] = 'claude-code',
): Session {
  return new Session({
    id: 'session-control',
    agentKind,
    workDir: '/repo',
    handle: stub.handle,
    capabilities: {} as never,
    logger: createLogger() as never,
    turnStallMs: 0,
  });
}

function waitForSessionEvent(session: Session, type: AgentEvent['type']): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.onEvent((event) => {
      if (event.type !== type) return;
      unsubscribe();
      resolve();
    });
  });
}

describe('Session graceful-stop control state', () => {
  it('cancels and joins a pre-acceptance send reservation before reporting stop requested', async () => {
    const stub = createHandle();
    let running = false;
    let sendSignal: AbortSignal | undefined;
    let releaseConversion!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const conversion = new Promise<void>((resolve) => { releaseConversion = resolve; });
    stub.handle.send = vi.fn(async (_message, opts) => {
      running = true;
      sendSignal = opts?.signal;
      markSendStarted();
      await conversion;
      if (opts?.signal?.aborted) {
        running = false;
        throw new Error('provider input cancelled before acceptance');
      }
    });
    stub.handle.isTurnRunning = () => running;
    const session = createSession(stub);

    const send = session.send('slow attachment');
    await sendStarted;
    const firstStop = session.requestGracefulStop();
    const secondStop = session.requestGracefulStop();

    expect(sendSignal?.aborted).toBe(true);
    expect(stub.requestGracefulStop).not.toHaveBeenCalled();
    releaseConversion();

    await expect(send).resolves.toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([
      { status: 'requested', turnGeneration: 1 },
      { status: 'requested', turnGeneration: 1 },
    ]);
    expect(stub.requestGracefulStop).not.toHaveBeenCalled();
    expect(session.getTurnControlSnapshot().active).toBe(false);
  });

  it('falls through to the provider soft interrupt when acceptance wins the reservation race', async () => {
    const stub = createHandle();
    let running = false;
    let releaseAcceptance!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const acceptance = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    stub.handle.send = vi.fn(async () => {
      running = true;
      markSendStarted();
      await acceptance;
    });
    stub.handle.isTurnRunning = () => running;
    const session = createSession(stub);

    const send = session.send('accept while stop races');
    await sendStarted;
    const stop = session.requestGracefulStop();
    releaseAcceptance();

    await expect(send).resolves.toEqual({ accepted: true });
    await expect(stop).resolves.toEqual({ status: 'requested', turnGeneration: 1 });
    expect(stub.requestGracefulStop).toHaveBeenCalledOnce();
    expect(stub.abort).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed stop when a cancelled reservation never settles', async () => {
    vi.useFakeTimers();
    try {
      const stub = createHandle();
      let running = false;
      let releaseAcceptance!: () => void;
      let markSendStarted!: () => void;
      let sendSignal: AbortSignal | undefined;
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
      const acceptance = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
      stub.handle.send = vi.fn(async (_message, opts) => {
        running = true;
        sendSignal = opts?.signal;
        markSendStarted();
        await acceptance;
        if (opts?.signal?.aborted) {
          running = false;
          throw new Error('provider input cancelled before acceptance');
        }
      });
      stub.handle.isTurnRunning = () => running;
      const session = createSession(stub);

      const send = session.send('hung acceptance');
      await sendStarted;
      const stop = session.requestGracefulStop();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(stop).resolves.toEqual({
        status: 'unconfirmed',
        turnGeneration: 1,
        reason: 'provider-acceptance-timeout',
      });
      expect(sendSignal?.aborted).toBe(true);
      expect(stub.requestGracefulStop).not.toHaveBeenCalled();

      releaseAcceptance();
      await expect(send).resolves.toEqual({ accepted: false, reason: 'cancelled-before-dispatch' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks only stop-control facts and clears them at terminal', async () => {
    const stub = createHandle();
    const session = createSession(stub);

    expect(session.getTurnControlSnapshot()).toEqual({
      active: false,
      turnGeneration: null,
      activeToolCount: 0,
      pendingInteractionCount: 0,
      gracefulStopState: 'none',
    });

    await session.send('start');
    expect(session.getTurnControlSnapshot()).toEqual({
      active: true,
      turnGeneration: 1,
      activeToolCount: 0,
      pendingInteractionCount: 0,
      gracefulStopState: 'none',
    });

    const toolObserved = waitForSessionEvent(session, 'tool_use');
    stub.push({
      type: 'tool_use',
      data: {
        toolUseId: 'tool-1',
        toolName: `Bash\n${'x'.repeat(100)}`,
        input: { command: 'secret-token-value' },
      },
    });
    await toolObserved;
    expect(session.getTurnControlSnapshot()).toMatchObject({ activeToolCount: 1 });
    expect(JSON.stringify(session.getTurnControlSnapshot())).not.toContain('secret-token-value');

    const doneObserved = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await doneObserved;
    expect(session.getTurnControlSnapshot().active).toBe(false);
  });

  it('waits for every active tool result before issuing one soft stop request', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    await session.send('start');
    stub.push({ type: 'tool_use', data: { toolUseId: 'tool-1', toolName: 'Read' } });
    stub.push({ type: 'tool_use', data: { toolUseId: 'tool-2', toolName: 'Write' } });
    await vi.waitFor(() => expect(session.getTurnControlSnapshot().activeToolCount).toBe(2));

    await expect(session.requestGracefulStop()).resolves.toEqual({
      status: 'waiting-for-safe-point',
      turnGeneration: 1,
    });
    expect(stub.requestGracefulStop).not.toHaveBeenCalled();

    stub.push({ type: 'tool_result_full', data: { toolUseId: 'tool-1', fullText: 'done' } });
    await vi.waitFor(() => expect(session.getTurnControlSnapshot().activeToolCount).toBe(1));
    expect(stub.requestGracefulStop).not.toHaveBeenCalled();

    stub.push({ type: 'tool_result', data: { toolUseIds: ['tool-2'], summary: 'done' } });
    await vi.waitFor(() => expect(stub.requestGracefulStop).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(session.getTurnControlSnapshot().gracefulStopState).toBe('requested');
    });
    await expect(session.requestGracefulStop()).resolves.toEqual({
      status: 'requested',
      turnGeneration: 1,
    });
    expect(stub.abort).not.toHaveBeenCalled();
  });

  it('does not count display-only plan snapshots as active tools', async () => {
    const snapshotStub = createHandle();
    const snapshotSession = createSession(snapshotStub);
    await snapshotSession.send('start');
    const snapshotObserved = waitForSessionEvent(snapshotSession, 'tool_use');
    snapshotStub.push({
      type: 'tool_use',
      data: {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        runtimeActivity: 'snapshot',
      },
    });
    await snapshotObserved;
    expect(snapshotSession.getTurnControlSnapshot().activeToolCount).toBe(0);

    await expect(snapshotSession.requestGracefulStop()).resolves.toEqual({
      status: 'requested',
      turnGeneration: 1,
    });
    expect(snapshotStub.requestGracefulStop).toHaveBeenCalledOnce();

    const toolStub = createHandle();
    const toolSession = createSession(toolStub);
    await toolSession.send('start');
    toolStub.push({
      type: 'tool_use',
      data: { toolUseId: 'plan-call-1', toolName: 'update_plan' },
    });
    await vi.waitFor(() => expect(toolSession.getTurnControlSnapshot().activeToolCount).toBe(1));

    await expect(toolSession.requestGracefulStop()).resolves.toEqual({
      status: 'waiting-for-safe-point',
      turnGeneration: 1,
    });
    expect(toolStub.requestGracefulStop).not.toHaveBeenCalled();

    toolStub.push({
      type: 'tool_result',
      data: { toolUseIds: ['plan-call-1'], summary: 'done' },
    });
    await vi.waitFor(() => expect(toolStub.requestGracefulStop).toHaveBeenCalledOnce());
  });

  it('treats a pending interaction as a safe stop boundary and exposes it in runtime state', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    const settleInteractions: Array<(decision: InteractionDecision) => void> = [];
    session.setInteractionListener(
      () =>
        new Promise<InteractionDecision>((resolve) => {
          settleInteractions.push(resolve);
        }),
    );
    await session.send('start');
    stub.push({ type: 'tool_use', data: { toolUseId: 'tool-1', toolName: 'Bash' } });
    await vi.waitFor(() => expect(session.getTurnControlSnapshot().activeToolCount).toBe(1));

    const firstInteraction = stub.requestInteraction({
      kind: 'permission',
      requestId: 'approval-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'echo safe' },
    });
    const secondInteraction = stub.requestInteraction({
      kind: 'permission',
      requestId: 'approval-2',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'echo safe again' },
    });
    await vi.waitFor(() => {
      expect(session.getTurnControlSnapshot().pendingInteractionCount).toBe(2);
      expect(settleInteractions).toHaveLength(2);
    });

    settleInteractions[0]?.({
      kind: 'permission',
      behavior: 'deny',
      reason: 'first approval settled',
    });
    await firstInteraction;

    await expect(session.requestGracefulStop()).resolves.toEqual({
      status: 'requested',
      turnGeneration: 1,
    });
    expect(stub.requestGracefulStop).toHaveBeenCalledOnce();
    expect(stub.abort).not.toHaveBeenCalled();

    settleInteractions[1]?.({
      kind: 'permission',
      behavior: 'deny',
      reason: 'graceful stop',
    });
    await secondInteraction;
  });

  it('waits for a parallel running tool even when another tool is awaiting permission', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    let settleInteraction!: (decision: InteractionDecision) => void;
    session.setInteractionListener(
      () =>
        new Promise<InteractionDecision>((resolve) => {
          settleInteraction = resolve;
        }),
    );
    await session.send('start');
    stub.push({ type: 'tool_use', data: { toolUseId: 'tool-waiting', toolName: 'Write' } });
    stub.push({ type: 'tool_use', data: { toolUseId: 'tool-running', toolName: 'Bash' } });
    await vi.waitFor(() => expect(session.getTurnControlSnapshot().activeToolCount).toBe(2));

    const interaction = stub.requestInteraction({
      kind: 'permission',
      requestId: 'approval-waiting',
      toolUseId: 'tool-waiting',
      toolName: 'Write',
      input: { file_path: '/repo/result.txt' },
    });
    await vi.waitFor(() => {
      expect(session.getTurnControlSnapshot().pendingInteractionCount).toBe(1);
    });

    await expect(session.requestGracefulStop()).resolves.toEqual({
      status: 'waiting-for-safe-point',
      turnGeneration: 1,
    });
    expect(stub.requestGracefulStop).not.toHaveBeenCalled();

    stub.push({
      type: 'tool_result_full',
      data: { toolUseId: 'tool-running', fullText: 'done' },
    });
    await vi.waitFor(() => expect(stub.requestGracefulStop).toHaveBeenCalledOnce());

    settleInteraction({
      kind: 'permission',
      behavior: 'deny',
      reason: 'graceful stop',
    });
    await interaction;
  });

  it('does not treat a missing or unrelated interaction tool id as a safe stop boundary', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    const pendingInteractions: Array<Promise<InteractionDecision>> = [];
    session.setInteractionListener(
      () => new Promise<InteractionDecision>(() => undefined),
    );
    await session.send('start');
    stub.push({ type: 'tool_use', data: { toolUseId: 'tool-running', toolName: 'Bash' } });
    await vi.waitFor(() => expect(session.getTurnControlSnapshot().activeToolCount).toBe(1));

    pendingInteractions.push(stub.requestInteraction({
      kind: 'permission',
      requestId: 'tool-running',
      toolName: 'Bash',
      input: {},
    }));
    pendingInteractions.push(stub.requestInteraction({
      kind: 'permission',
      requestId: 'approval-other',
      toolUseId: 'tool-other',
      toolName: 'Write',
      input: {},
    }));
    await vi.waitFor(() => {
      expect(session.getTurnControlSnapshot().pendingInteractionCount).toBe(1);
    });

    await expect(session.requestGracefulStop()).resolves.toEqual({
      status: 'waiting-for-safe-point',
      turnGeneration: 1,
    });
    expect(stub.requestGracefulStop).not.toHaveBeenCalled();

    // Keep the deliberately hanging interaction promises referenced until the assertion completes.
    expect(pendingInteractions).toHaveLength(2);
  });

  it('reports unsupported, no-active-turn and provider failure without falling back to abort', async () => {
    const unsupported = createSession(createHandle({ supported: false }));
    await unsupported.send('start');
    await expect(unsupported.requestGracefulStop()).resolves.toEqual({
      status: 'unsupported',
      reason: 'provider-not-supported',
    });

    const idleStub = createHandle();
    const idle = createSession(idleStub);
    await expect(idle.requestGracefulStop()).resolves.toEqual({ status: 'no-active-turn' });

    const failedStub = createHandle({
      gracefulStop: async () => {
        throw new Error('soft interrupt unavailable');
      },
    });
    const failed = createSession(failedStub);
    await failed.send('start');
    await expect(failed.requestGracefulStop()).resolves.toEqual({
      status: 'unconfirmed',
      turnGeneration: 1,
      reason: 'provider-request-failed',
    });
    expect(failedStub.abort).not.toHaveBeenCalled();
  });

  it('bounds a hanging provider stop request and reports it as unconfirmed', async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      const stub = createHandle({
        gracefulStop: (opts) => {
          providerSignal = opts?.signal;
          return new Promise<void>(() => undefined);
        },
      });
      const session = createSession(stub);
      await session.send('start');

      const result = session.requestGracefulStop();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toEqual({
        status: 'unconfirmed',
        turnGeneration: 1,
        reason: 'provider-confirmation-timeout',
      });
      expect(stub.abort).not.toHaveBeenCalled();
      expect(providerSignal?.aborted).toBe(true);
      expect(session.getTurnControlSnapshot().gracefulStopState).toBe('unconfirmed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a stop waiting at a tool boundary when that generation terminates', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    await session.send('start');
    stub.push({ type: 'tool_use', data: { toolUseId: 'tool-old', toolName: 'Bash' } });
    await vi.waitFor(() => expect(session.getTurnControlSnapshot().activeToolCount).toBe(1));
    await expect(session.requestGracefulStop()).resolves.toMatchObject({
      status: 'waiting-for-safe-point',
    });

    stub.push({ type: 'done', data: {} });
    await vi.waitFor(() => expect(session.getTurnControlSnapshot().active).toBe(false));
    expect(stub.requestGracefulStop).not.toHaveBeenCalled();
  });
});

describe('Session current-generation terminal observation', () => {
  it('reports done until the next reservation, and keeps error ahead of a paired done tail', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    const firstDone = waitForSessionEvent(session, 'done');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({ type: 'done', data: {} });
    await firstDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 1 });

    const secondSend = session.send('second');
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
    await expect(secondSend).resolves.toEqual({ accepted: true });
    const secondError = waitForSessionEvent(session, 'error');
    stub.push({
      type: 'error',
      data: {
        message: 'Authorization: Bearer secret-token',
        isTerminal: true,
        reason: 'empty-response',
        sdkError: 'server_error',
        errorStatus: 529,
      },
    });
    await secondError;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 2,
      message: 'Authorization: [REDACTED]',
      reason: 'empty-response',
      sdkError: 'server_error',
      errorStatus: 529,
    });
    stub.push({ type: 'done', data: {} });
    await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 2,
      message: 'Authorization: [REDACTED]',
      reason: 'empty-response',
      sdkError: 'server_error',
      errorStatus: 529,
    });
  });

  it('ignores background terminals when recording foreground evidence', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({ type: 'done', data: {}, turnScope: 'background' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
    const firstDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await firstDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 1 });
  });

  it('restores terminal evidence when a later send is rejected before dispatch', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    const firstDone = waitForSessionEvent(session, 'done');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({ type: 'done', data: {} });
    await firstDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 1 });

    stub.handle.send = vi.fn(async () => {
      throw new TurnDispatchRejectedError('provider rejected before acceptance');
    });
    await expect(session.send('second')).resolves.toEqual({
      accepted: false,
      reason: 'provider-rejected-before-dispatch',
    });
    expect(session.getTurnGeneration()).toBe(1);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 1 });
  });

  it('promotes a prior-generation terminal that arrives while a later send is rejected', async () => {
    const cases: Array<{
      event: AgentEvent;
      expected: ReturnType<Session['getObservedCurrentTurnTerminal']>;
    }> = [
      {
        event: { type: 'done', data: {} },
        expected: { kind: 'done', generation: 1 },
      },
      {
        event: {
          type: 'error',
          data: {
            message: 'Authorization: Bearer secret-token',
            isTerminal: true,
            reason: 'empty-response',
            sdkError: 'server_error',
            errorStatus: 529,
          },
        },
        expected: {
          kind: 'error',
          generation: 1,
          message: 'Authorization: [REDACTED]',
          reason: 'empty-response',
          sdkError: 'server_error',
          errorStatus: 529,
        },
      },
    ];

    for (const testCase of cases) {
      const stub = createHandle();
      const session = createSession(stub);
      await expect(session.send('first')).resolves.toEqual({ accepted: true });
      expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
      stub.handle.isTurnRunning = () => false;
      stub.handle.send = vi.fn(async () => {
        throw new TurnDispatchRejectedError('provider rejected before acceptance');
      });

      await expect(
        session.send('second', {
          afterTurnReserved: async () => {
            expect(session.getTurnGeneration()).toBe(2);
            expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
            stub.push(testCase.event);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
          },
        }),
      ).resolves.toEqual({
        accepted: false,
        reason: 'provider-rejected-before-dispatch',
      });
      expect(session.getTurnGeneration()).toBe(1);
      expect(session.getObservedCurrentTurnTerminal()).toEqual(testCase.expected);
    }
  });

  it('promotes a prior-generation error that arrives during a rejected handle.send', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.handle.isTurnRunning = () => false;

    let rejectSend!: (error: Error) => void;
    const pendingSend = new Promise<void>((_, reject) => {
      rejectSend = reject;
    });
    stub.handle.send = vi.fn(() => pendingSend);

    const secondSend = session.send('second');
    await vi.waitFor(() => expect(stub.handle.send).toHaveBeenCalled());
    stub.push({
      type: 'error',
      data: {
        message: 'Authorization: Bearer secret-token',
        isTerminal: true,
        reason: 'empty-response',
        sdkError: 'server_error',
        errorStatus: 529,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    rejectSend(new TurnDispatchRejectedError('provider rejected before acceptance'));
    await expect(secondSend).resolves.toEqual({
      accepted: false,
      reason: 'provider-rejected-before-dispatch',
    });
    expect(session.getTurnGeneration()).toBe(1);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'Authorization: [REDACTED]',
      reason: 'empty-response',
      sdkError: 'server_error',
      errorStatus: 529,
    });
    await expect(session.send('third')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.push({ type: 'done', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'Authorization: [REDACTED]',
      reason: 'empty-response',
      sdkError: 'server_error',
      errorStatus: 529,
    });

    stub.handle.send = vi.fn(async () => undefined);
    await expect(session.send('third')).resolves.toEqual({ accepted: true });
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
  });

  it('does not adopt a late paired done while the next handle.send is still pending', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'turn failed',
      reason: 'empty-response',
    });

    let releaseSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    stub.handle.send = vi.fn(() => pendingSend);

    const secondSend = session.send('second');
    await vi.waitFor(() => expect(stub.handle.send).toHaveBeenCalled());
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    stub.push({ type: 'done', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    releaseSend();
    await expect(secondSend).resolves.toEqual({ accepted: true });
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    stub.push({ type: 'status', data: { isRunning: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    const secondDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await secondDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
  });

  it('does not adopt a late paired done after handle.send flips running and releases reservation', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'turn failed',
      reason: 'empty-response',
    });

    let releaseSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    stub.handle.send = vi.fn(() => pendingSend);

    const secondSend = session.send('second');
    await vi.waitFor(() => expect(stub.handle.send).toHaveBeenCalled());
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    stub.handle.isTurnRunning = () => true;
    stub.push({ type: 'done', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    releaseSend();
    await expect(secondSend).resolves.toEqual({ accepted: true });
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    const secondError = waitForSessionEvent(session, 'error');
    stub.push({
      type: 'error',
      data: {
        message: 'n+1 failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await secondError;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 2,
      message: 'n+1 failed',
      reason: 'empty-response',
    });
  });

  it('does not let a leftover error rewrite an accepted later success after reservation release', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;

    let releaseSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    stub.handle.send = vi.fn(() => pendingSend);
    const secondSend = session.send('second');
    await vi.waitFor(() => expect(stub.handle.send).toHaveBeenCalled());
    stub.handle.isTurnRunning = () => true;
    stub.push({ type: 'done', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    releaseSend();
    await expect(secondSend).resolves.toEqual({ accepted: true });

    const secondDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await secondDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });

    stub.push({
      type: 'error',
      data: {
        message: 'late prior error',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
  });

  it('does not fan-out a late leftover error after the current generation recorded done', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const seen: AgentEvent[] = [];
    session.onEvent((event) => {
      seen.push({ ...event });
    });
    const onTerminal = vi.fn();
    session.setTurnLifecycleObserver({
      beforeProviderStart() {},
      onUndispatched() {},
      onTerminal,
    });

    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;

    stub.handle.send = vi.fn(async () => undefined);
    await expect(session.send('second')).resolves.toEqual({ accepted: true });
    const secondDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await secondDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
    const terminalsAfterDone = onTerminal.mock.calls.length;
    const seenAfterDone = seen.length;

    stub.push({
      type: 'error',
      data: {
        message: 'late prior error',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
    expect(seen.slice(seenAfterDone).some((event) => event.type === 'error')).toBe(false);
    expect(onTerminal.mock.calls.length).toBe(terminalsAfterDone);
    expect(
      onTerminal.mock.calls.some((call) => call[0]?.event?.type === 'error'
        && (call[0]?.event?.data as { message?: string } | undefined)?.message === 'late prior error'),
    ).toBe(false);
  });

  it('still fans out a current-generation terminal error when no done snapshot exists', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const seen: AgentEvent[] = [];
    session.onEvent((event) => {
      seen.push({ ...event });
    });
    const onTerminal = vi.fn();
    session.setTurnLifecycleObserver({
      beforeProviderStart() {},
      onUndispatched() {},
      onTerminal,
    });

    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'current turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'current turn failed',
      reason: 'empty-response',
    });
    expect(seen.some((event) => event.type === 'error')).toBe(true);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      turnGeneration: 1,
      isCurrentGeneration: true,
      event: expect.objectContaining({ type: 'error' }),
    }));
  });

  it('does not fan-out a reservation-window leftover error as the next generation', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const seen: AgentEvent[] = [];
    session.onEvent((event) => {
      seen.push({ ...event });
    });
    const onTerminal = vi.fn();
    session.setTurnLifecycleObserver({
      beforeProviderStart() {},
      onUndispatched() {},
      onTerminal,
    });

    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'turn failed',
      reason: 'empty-response',
    });

    let releaseSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    stub.handle.send = vi.fn(() => pendingSend);
    const secondSend = session.send('second');
    await vi.waitFor(() => expect(stub.handle.send).toHaveBeenCalled());
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
    const seenAfterReserve = seen.length;
    const terminalsAfterReserve = onTerminal.mock.calls.length;

    stub.push({
      type: 'error',
      data: {
        message: 'late prior error',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // In-flight error after N already observed error is N+1 start-failure.
    // Leftover fence only applies to terminals attributed to a prior generation.
    expect(session.getObservedCurrentTurnTerminal()).toMatchObject({
      kind: 'error',
      generation: 2,
      message: 'late prior error',
    });
    expect(session.getTurnGeneration()).toBe(2);
    expect(seen.slice(seenAfterReserve).some((event) => event.type === 'error')).toBe(true);
    expect(onTerminal.mock.calls.length).toBeGreaterThan(terminalsAfterReserve);
    expect(
      seen.some((event) =>
        event.type === 'error' &&
        event.sessionTurnGeneration === 2 &&
        (event.data as { message?: string }).message === 'late prior error'),
    ).toBe(true);

    releaseSend();
    await expect(secondSend).resolves.toEqual({ accepted: true });
    stub.push({ type: 'done', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toMatchObject({
      kind: 'error',
      generation: 2,
    });
  });

  it('keeps N+1 origin and attempt token after a leftover paired done in the reservation window', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const seen: AgentEvent[] = [];
    session.onEvent((event) => {
      seen.push({ ...event });
    });
    const firstOrigin: SendOrigin = { kind: 'scheduler', scheduleId: 'n', scheduleName: 'n' };
    const nextOrigin: SendOrigin = { kind: 'scheduler', scheduleId: 'n1', scheduleName: 'n1' };

    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first', { origin: firstOrigin })).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;

    let releaseSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    stub.handle.send = vi.fn(() => pendingSend);
    const secondSend = session.send('second', {
      origin: nextOrigin,
      turnAttemptToken: 7,
    });
    await vi.waitFor(() => expect(stub.handle.send).toHaveBeenCalled());
    expect(session.getTurnGeneration()).toBe(2);

    stub.push({ type: 'done', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
    expect(
      seen.some((event) => event.type === 'done' && event.sessionTurnGeneration === 2),
    ).toBe(false);

    releaseSend();
    await expect(secondSend).resolves.toEqual({ accepted: true });
    const secondText = waitForSessionEvent(session, 'text');
    stub.push({ type: 'text', data: { text: 'n+1', isFinal: false } });
    await secondText;
    const secondDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await secondDone;

    const n1Events = seen.filter((event) => event.sessionTurnGeneration === 2);
    expect(n1Events.some((event) => event.type === 'text')).toBe(true);
    expect(n1Events.some((event) => event.type === 'done')).toBe(true);
    expect(n1Events.every((event) => event.turnOrigin)).toEqual(true);
    expect(n1Events.map((event) => event.turnOrigin)).toEqual(
      n1Events.map(() => nextOrigin),
    );
    expect(n1Events.every((event) => event.turnAttemptToken === 7)).toBe(true);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
  });

  it('binds an accepted result-only done when the prior paired done was lost', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'turn failed',
      reason: 'empty-response',
    });

    stub.handle.send = vi.fn(async () => undefined);
    await expect(session.send('second')).resolves.toEqual({ accepted: true });
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    const secondDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await secondDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });

    stub.push({
      type: 'error',
      data: {
        message: 'late prior error',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
  });

  it('binds an accepted result-only done after the prior error tail is already attributed', async () => {
    const stub = createHandle();
    const session = createSession(stub, 'codex');
    const firstError = waitForSessionEvent(session, 'error');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({
      type: 'error',
      data: {
        message: 'turn failed',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await firstError;
    stub.push({ type: 'done', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.push({ type: 'status', data: { isRunning: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.handle.isTurnRunning = () => false;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({
      kind: 'error',
      generation: 1,
      message: 'turn failed',
      reason: 'empty-response',
    });

    stub.handle.send = vi.fn(async () => undefined);
    await expect(session.send('second')).resolves.toEqual({ accepted: true });
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    const secondDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await secondDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });

    stub.push({
      type: 'error',
      data: {
        message: 'late prior error',
        isTerminal: true,
        reason: 'empty-response',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
  });

  it('does not inherit a reservation-window terminal after a later send is accepted', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.handle.isTurnRunning = () => false;
    stub.handle.send = vi.fn(async () => undefined);

    await expect(
      session.send('second', {
        afterTurnReserved: async () => {
          stub.push({ type: 'done', data: {} });
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
        },
      }),
    ).resolves.toEqual({ accepted: true });
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
  });

  it('does not treat a late prior-generation error as the next reserved turn terminal', async () => {
    const stub = createHandle();
    const session = createSession(stub);
    const firstDone = waitForSessionEvent(session, 'done');
    await expect(session.send('first')).resolves.toEqual({ accepted: true });
    stub.push({ type: 'done', data: {} });
    await firstDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 1 });

    stub.handle.isTurnRunning = () => false;
    stub.handle.send = vi.fn(async () => undefined);
    await expect(
      session.send('second', {
        afterTurnReserved: async () => {
          expect(session.getTurnGeneration()).toBe(2);
          expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
          stub.push({
            type: 'error',
            data: {
              message: 'late prior error',
              isTerminal: true,
              reason: 'empty-response',
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
        },
      }),
    ).resolves.toEqual({ accepted: true });
    expect(session.getTurnGeneration()).toBe(2);
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });

    const secondDone = waitForSessionEvent(session, 'done');
    stub.push({ type: 'done', data: {} });
    await secondDone;
    expect(session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'done', generation: 2 });
  });
});
