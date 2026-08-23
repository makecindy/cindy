import { describe, expect, it, vi } from 'vitest';

import { Session } from './session.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import type {
  AgentEvent,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
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

function createSession(stub: ReturnType<typeof createHandle>): Session {
  return new Session({
    id: 'session-control',
    agentKind: 'claude-code',
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
