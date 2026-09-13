import { describe, expect, it, vi } from 'vitest';

import { Session } from './session.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import type { AgentEvent } from './types/events.js';
import {
  TurnDispatchRejectedError,
  TurnDispatchUnconfirmedError,
  type AgentSessionHandle,
} from './agents/base-agent.js';

function createLogger() {
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  return logger;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Session close lifecycle', () => {
  function liveTurn(hostContinuation = true, terminalGate?: Promise<void>) {
    const queue = createAsyncQueue<AgentEvent>();
    let running = false;
    const handle = {
      id: 'pi-runtime', agentKind: 'pi', model: 'm',
      send: vi.fn(async () => { running = true; }),
      events: () => terminalGate ? (async function* () {
        for await (const event of queue) {
          if (event.type === 'done') await terminalGate;
          yield event;
        }
      })() : queue,
      isTurnRunning: () => running,
      close: vi.fn(async () => { running = false; queue.end(); }),
      abort: vi.fn(async () => { running = false; }),
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({ id: 'pi-task', agentKind: 'pi', workDir: '/repo',
      handle, capabilities: {} as never, logger: createLogger(), turnStallMs: 0 });
    const seen: AgentEvent[] = [];
    if (hostContinuation) session.setTurnLifecycleObserver({
      beforeProviderStart() {}, onUndispatched() {},
      onTerminal({ turnGeneration, event, isCurrentGeneration }) {
        if (isCurrentGeneration && event.type === 'done' && (event.data as { silentStop?: boolean }).silentStop) {
          session.claimHostTurnContinuation(turnGeneration);
        }
      },
    });
    session.onEvent((event) => seen.push(event));
    return { session, handle, queue, seen, idle: () => { running = false; } };
  }

  it('recycles unclaimed silent-stop terminals instead of inventing a Host owner', async () => {
    const { session, handle, queue, seen, idle } = liveTurn(false);
    await session.send('work');
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', silentStop: true } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(await session.closeIfIdle()).toBe(true);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(handle.send).toHaveBeenCalledOnce();
  });

  it('publishes deferred retirement failure before listeners are cleared, retaining successful work', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    const recovered: AgentEvent[] = [];
    session.onRuntimeRecovery((event) => recovered.push(event));
    const close = vi.mocked(handle.close);
    close.mockRejectedValueOnce(new Error('process exit unconfirmed'));
    const recovery: AgentEvent = { type: 'text', source: 'pi', data: {
      text: 'partial: restart-cindy-to-refresh-packages', isFinal: true,
    } };
    await session.send('work');
    await session.closeAfterCurrentTurn({ failureEvent: () => recovery });
    idle();
    queue.push({ type: 'text', source: 'pi', data: { text: 'saved result', isFinal: true } });
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', result: 'saved result' } });
    await vi.waitFor(() => expect(session.getStatus()).toBe('error'));
    expect(seen.map(event => event.type)).toEqual(['text', 'done']);
    expect(seen[0]?.data).toEqual({ text: 'saved result', isFinal: true });
    expect(seen[1]?.data).toMatchObject({ status: 'completed', result: 'saved result' });
    expect(recovered).toEqual([{ ...recovery, runtimeRecovery: true,
      sessionInstanceId: session.instanceId, sessionTurnGeneration: session.getTurnGeneration() }]);
    expect(handle.send).toHaveBeenCalledOnce();
    await session.close();
    expect(session.getStatus()).toBe('closed');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('publishes idle retirement failure without turning recovery into product output', async () => {
    const { session, handle, seen } = liveTurn();
    const recovered: AgentEvent[] = [];
    session.onRuntimeRecovery((event) => recovered.push(event));
    vi.mocked(handle.close).mockRejectedValueOnce(new Error('process exit unconfirmed'));
    const recovery: AgentEvent = { type: 'text', source: 'pi', data: {
      text: 'partial: restart-cindy-to-refresh-packages', isFinal: true,
    } };

    await expect(session.closeAfterCurrentTurn({ failureEvent: () => recovery }))
      .rejects.toThrow('process exit unconfirmed');
    expect(session.getStatus()).toBe('error');
    expect(recovered).toEqual([{ ...recovery, runtimeRecovery: true,
      sessionInstanceId: session.instanceId, sessionTurnGeneration: session.getTurnGeneration() }]);
    expect(seen).toEqual([]);
    expect(handle.send).not.toHaveBeenCalled();
    await session.close();
    expect(session.getStatus()).toBe('closed');
    expect(recovered).toHaveLength(1);
  });

  it('keeps a failed tool caller alive until its reply and product terminal are consumed', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    await session.send('update and report', { turnAttemptToken: 7 });
    queue.push({ type: 'tool_result', data: { toolUseId: 'update', isError: true }, source: 'pi' });
    expect(await session.closeAfterCurrentTurn()).toBe('deferred');
    expect(handle.close).not.toHaveBeenCalled();
    idle(); // Pi can become idle before Session consumes its queued tail.
    expect(await session.closeIfIdle()).toBe(false);
    queue.push({ type: 'text', data: { text: 'The command failed; the task can continue.' }, source: 'pi' });
    queue.push({ type: 'done', data: { status: 'completed' }, source: 'pi' });
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    expect(seen.map((e) => e.type)).toEqual(['tool_result', 'text', 'done']);
    expect(seen.at(-1)?.turnAttemptToken).toBe(7);
    expect(handle.send).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(['requested-close', 'process-exit'] as const)('settles an owned idle-without-terminal turn on %s', async (cause) => {
    const { session, handle, queue, seen, idle } = liveTurn();
    await session.send('perform a side effect', { turnAttemptToken: 8 });
    idle();
    if (cause === 'requested-close') await session.close();
    else queue.end();
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'error', turnAttemptToken: 8,
      data: { isTerminal: true, reason: 'session_event_loop_crashed' } });
    expect(handle.send).toHaveBeenCalledOnce();
  });

  it('preserves Stop as cancellation when retirement races a missing terminal', async () => {
    const { session, handle, seen } = liveTurn();
    await session.send('work', { turnAttemptToken: 9 });
    await session.closeAfterCurrentTurn();
    await session.abort();
    await session.close();
    expect(seen).toEqual([expect.objectContaining({ type: 'done', turnAttemptToken: 9,
      data: { status: 'cancelled' } })]);
    expect(handle.send).toHaveBeenCalledOnce();
  });

  it('rejects a new turn while a retiring provider is idle but its terminal is queued', async () => {
    const terminalGate = createDeferred();
    const { session, handle, queue, seen, idle } = liveTurn(true, terminalGate.promise);
    await session.send('in-flight work');
    const generation = session.getTurnGeneration();
    expect(await session.closeAfterCurrentTurn()).toBe('deferred');
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', result: 'finished' } });
    try {
      await expect(session.send('new work')).rejects.toThrow(/closing/);
      expect(session.getTurnGeneration()).toBe(generation);
      expect(handle.send).toHaveBeenCalledOnce();
      expect(handle.close).not.toHaveBeenCalled();
      terminalGate.resolve();
      await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
      expect(seen.at(-1)?.data).toMatchObject({ status: 'completed', result: 'finished' });
      expect(handle.close).toHaveBeenCalledOnce();
    } finally {
      terminalGate.resolve();
      await session.close();
    }
  });

  it('keeps the executor available to the existing Host silent-stop continuation', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    await session.send('work');
    await session.closeAfterCurrentTurn();
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', silentStop: true } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(await session.closeAfterCurrentTurn()).toBe('deferred');
    expect(await session.closeIfIdle()).toBe(false);
    expect(handle.close).not.toHaveBeenCalled();
    await session.sendHostTurnContinuation('continue'); // Host owns the existing bounded budget.
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', result: 'delivered' } });
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    expect(handle.send).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)?.data).toMatchObject({ result: 'delivered' });
  });

  it('rejects a non-Host send while a retiring silent-stop claim is live', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    await session.send('work');
    await session.closeAfterCurrentTurn();
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', silentStop: true } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await expect(session.send('user follow-up')).rejects.toThrow(/closing/);
    expect(handle.send).toHaveBeenCalledOnce();
    expect(handle.close).not.toHaveBeenCalled();
    await session.sendHostTurnContinuation('continue');
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', result: 'delivered' } });
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    expect(handle.send).toHaveBeenCalledTimes(2);
  });

  it('does not retire at a provider boundary with an outstanding continuation claim', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    handle.beginTurnContinuationWait = (id) => id === 4 ? 'awaiting' : null;
    await session.send('work', { turnAttemptToken: 11 });
    await session.closeAfterCurrentTurn();
    idle();
    queue.push({ type: 'done', source: 'pi', turnContinuationId: 4, data: {} });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(handle.close).not.toHaveBeenCalled();
    expect(await session.closeAfterCurrentTurn()).toBe('deferred');
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', result: 'finished' } });
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    expect(seen.at(-1)?.turnAttemptToken).toBe(11);
  });

  it('retires when the Host declines continuation, without replaying the completed tools', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    await session.send('work');
    const generation = session.getTurnGeneration();
    await session.closeAfterCurrentTurn();
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', silentStop: true } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    session.settleHostTurnContinuation(generation);
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    expect(handle.send).toHaveBeenCalledOnce();
  });

  it('retires on Stop while Host continuation is pending without starting another turn', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    await session.send('work');
    await session.closeAfterCurrentTurn();
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', silentStop: true } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await session.abort();
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    expect(handle.send).toHaveBeenCalledOnce();
    await expect(session.send('late continuation')).rejects.toThrow(/closed|closing/);
  });

  it('retires a stopped silent-stop caller without waiting for its hung abort RPC', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    const abortGate = createDeferred();
    vi.mocked(handle.abort).mockImplementation(() => abortGate.promise);
    await session.send('work');
    await session.closeAfterCurrentTurn();
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', silentStop: true } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const stopping = session.abort();
    try {
      await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
      expect(handle.abort).toHaveBeenCalledOnce();
      expect(handle.close).toHaveBeenCalledOnce();
      expect(handle.send).toHaveBeenCalledOnce();
      await expect(session.send('late continuation')).rejects.toThrow(/closed|closing/);
      abortGate.resolve();
      await stopping;
      expect(session.getStatus()).toBe('closed');
      expect(handle.close).toHaveBeenCalledOnce();
    } finally {
      abortGate.resolve();
      await stopping;
      await session.close();
    }
  });

  it('ignores a stale Host continuation settlement after a newer turn starts', async () => {
    const { session, handle, queue, seen, idle } = liveTurn();
    await session.send('work');
    const generation = session.getTurnGeneration();
    await session.closeAfterCurrentTurn();
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', silentStop: true } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await session.sendHostTurnContinuation('continue');
    session.settleHostTurnContinuation(generation);
    expect(handle.close).not.toHaveBeenCalled();
    idle();
    queue.push({ type: 'done', source: 'pi', data: { status: 'completed', result: 'done' } });
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
  });

  it('reserves teardown before notifying a reentrant close listener', async () => {
    const { session, handle } = liveTurn();
    await session.send('work');
    let reentrant: Promise<void> | undefined;
    session.onEvent(() => { reentrant = session.close(); });
    const closing = session.close();
    expect(reentrant).toBe(closing);
    await closing;
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('does not replace an already delivered success or expose late teardown events', async () => {
    const { session, queue, seen, idle } = liveTurn();
    await session.send('work');
    idle();
    queue.push({ type: 'done', data: { status: 'completed', result: 'delivered' }, source: 'pi' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await session.close();
    queue.push({ type: 'error', data: { isTerminal: true, message: 'late' }, source: 'pi' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'done', data: { result: 'delivered' } });
  });

  it('closes an ambiguous transport before surfacing an unconfirmed dispatch', async () => {
    const eventLoop = createDeferred();
    const abortController = new AbortController();
    const close = vi.fn(async () => {
      eventLoop.resolve();
      // Give the event iterator a chance to publish its queued terminal event
      // while Session.close() is still awaiting the handle.
      await Promise.resolve();
      await Promise.resolve();
    });
    const handle = {
      id: 'thread-unconfirmed',
      agentKind: 'pi',
      model: 'gpt-5.4',
      async send() {
        abortController.abort();
        throw new TurnDispatchUnconfirmedError('prompt acceptance timed out');
      },
      async *events() {
        await eventLoop.promise;
        yield {
          type: 'error',
          data: { message: 'late close error', isTerminal: true },
          source: 'pi',
        } as never;
      },
      close,
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({
      id: 'session-unconfirmed',
      agentKind: 'pi',
      workDir: '/repo',
      handle,
      capabilities: {} as never,
      logger: createLogger() as never,
    });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    await expect(session.send('continue the goal', {
      signal: abortController.signal,
    })).rejects.toMatchObject({
      code: 'TURN_DISPATCH_UNCONFIRMED',
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(session.getStatus()).toBe('closed');
    expect(events).toEqual([]);
  });

  it('returns a confirmed provider rejection as safely undispatched and remains reusable', async () => {
    const eventLoop = createDeferred();
    const close = vi.fn(async () => {
      eventLoop.resolve();
    });
    let sendAttempts = 0;
    const session = new Session({
      id: 'session-provider-rejected',
      agentKind: 'pi',
      workDir: '/repo',
      handle: {
        id: 'thread-provider-rejected',
        agentKind: 'pi',
        model: 'gpt-5.4',
        async send() {
          sendAttempts += 1;
          if (sendAttempts === 1) {
            throw new TurnDispatchRejectedError('provider rejected before acceptance');
          }
        },
        async *events() {
          await eventLoop.promise;
          yield* [];
        },
        close,
        setInteractionResolver() {},
      } as unknown as AgentSessionHandle,
      capabilities: {} as never,
      logger: createLogger() as never,
    });

    await expect(session.send('continue the goal')).resolves.toEqual({
      accepted: false,
      reason: 'provider-rejected-before-dispatch',
    });
    expect(session.getStatus()).toBe('active');
    expect(close).not.toHaveBeenCalled();

    await expect(session.send('continue the goal')).resolves.toEqual({ accepted: true });
    await session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a provider-accepted send accepted when cancellation races with its response', async () => {
    const sendStarted = createDeferred();
    const providerAccepted = createDeferred();
    const eventLoop = createDeferred();
    const abortController = new AbortController();
    const session = new Session({
      id: 'session-accepted-cancel-race',
      agentKind: 'pi',
      workDir: '/repo',
      handle: {
        id: 'thread-accepted-cancel-race',
        agentKind: 'pi',
        model: 'gpt-5.4',
        async send() {
          sendStarted.resolve();
          await providerAccepted.promise;
        },
        async *events() {
          await eventLoop.promise;
          yield* [];
        },
        async close() {
          eventLoop.resolve();
        },
        setInteractionResolver() {},
      } as unknown as AgentSessionHandle,
      capabilities: {} as never,
      logger: createLogger() as never,
    });

    const sending = session.send('continue the goal', { signal: abortController.signal });
    await sendStarted.promise;
    abortController.abort();
    providerAccepted.resolve();

    await expect(sending).resolves.toEqual({ accepted: true });
    await session.close();
  });

  it('serializes concurrent close calls onto the same transport shutdown', async () => {
    const transportClose = createDeferred();
    const close = vi.fn(() => transportClose.promise);
    const handle = {
      id: 'thread-1',
      agentKind: 'codex',
      model: 'gpt-5.4',
      close,
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({
      id: 'session-1',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {} as never,
      logger: createLogger() as never,
      permissionMode: 'bypassPermissions',
    });

    expect(session.stablePermissionModeState).toEqual({
      mode: 'bypassPermissions',
      generation: 0,
    });

    const firstClose = session.close();
    const secondClose = session.close();

    expect(secondClose).toBe(firstClose);
    expect(close).toHaveBeenCalledTimes(1);
    expect(session.getStatus()).not.toBe('closed');
    expect(session.stablePermissionModeState).toBeNull();

    transportClose.resolve();
    await Promise.all([firstClose, secondClose]);

    expect(session.getStatus()).toBe('closed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects permission changes once transport shutdown has started', async () => {
    const transportClose = createDeferred();
    const close = vi.fn(() => transportClose.promise);
    const setPermissionMode = vi.fn(async () => undefined);
    const handle = {
      id: 'thread-closing-permission',
      agentKind: 'codex',
      model: 'gpt-5.4',
      close,
      setPermissionMode,
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({
      id: 'session-closing-permission',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {
        permissionModes: [{ id: 'ask', displayName: 'Ask' }],
        setPermissionModeMidSession: { supported: true },
      } as never,
      logger: createLogger() as never,
      permissionMode: 'bypassPermissions',
    });

    const closing = session.close();

    await expect(session.setPermissionMode('ask')).rejects.toThrow('is closing');
    expect(setPermissionMode).not.toHaveBeenCalled();

    transportClose.resolve();
    await closing;
  });

  it('rejects a tracked permission change queued before transport shutdown', async () => {
    const firstModeChange = createDeferred();
    const transportClose = createDeferred();
    const setPermissionMode = vi
      .fn()
      .mockImplementationOnce(() => firstModeChange.promise)
      .mockResolvedValue(undefined);
    const session = new Session({
      id: 'session-queued-permission',
      agentKind: 'codex',
      workDir: '/repo',
      handle: {
        id: 'thread-queued-permission',
        agentKind: 'codex',
        model: 'gpt-5.4',
        close: vi.fn(() => transportClose.promise),
        setPermissionMode,
        setInteractionResolver() {},
      } as unknown as AgentSessionHandle,
      capabilities: {
        permissionModes: [{ id: 'ask', displayName: 'Ask' }],
        setPermissionModeMidSession: { supported: true },
      } as never,
      logger: createLogger() as never,
      permissionMode: 'bypassPermissions',
    });

    const first = session.setPermissionModeTracked('ask');
    await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledTimes(1));
    const queued = session.setPermissionModeTracked('ask');
    const closing = session.close();

    firstModeChange.resolve();
    await first;
    await expect(queued).rejects.toThrow(/is closing|is closed/);
    expect(setPermissionMode).toHaveBeenCalledTimes(1);

    transportClose.resolve();
    await closing;
  });

  it('rejects a conditional permission restore queued before transport shutdown', async () => {
    const firstModeChange = createDeferred();
    const transportClose = createDeferred();
    const setPermissionMode = vi
      .fn()
      .mockImplementationOnce(() => firstModeChange.promise)
      .mockResolvedValue(undefined);
    const session = new Session({
      id: 'session-queued-restore',
      agentKind: 'codex',
      workDir: '/repo',
      handle: {
        id: 'thread-queued-restore',
        agentKind: 'codex',
        model: 'gpt-5.4',
        close: vi.fn(() => transportClose.promise),
        setPermissionMode,
        setInteractionResolver() {},
      } as unknown as AgentSessionHandle,
      capabilities: {
        permissionModes: [{ id: 'ask', displayName: 'Ask' }],
        setPermissionModeMidSession: { supported: true },
      } as never,
      logger: createLogger() as never,
      permissionMode: 'bypassPermissions',
    });

    const first = session.setPermissionModeTracked('ask');
    await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledTimes(1));
    const queued = session.setPermissionModeIfUnchanged(
      { mode: 'ask', generation: 1 },
      'ask',
    );
    const closing = session.close();

    firstModeChange.resolve();
    await first;
    await expect(queued).rejects.toThrow(/is closing|is closed/);
    expect(setPermissionMode).toHaveBeenCalledTimes(1);

    transportClose.resolve();
    await closing;
  });

  it('does not publish closed when transport shutdown fails', async () => {
    const close = vi.fn(async () => {
      throw new Error('transport close failed');
    });
    const handle = {
      id: 'thread-close-failed',
      agentKind: 'codex',
      model: 'gpt-5.4',
      close,
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({
      id: 'session-close-failed',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {} as never,
      logger: createLogger() as never,
    });
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));

    await expect(session.close()).rejects.toThrow('transport close failed');

    expect(statuses).toEqual(['error']);
    expect(session.getStatus()).toBe('error');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retries a failed transport shutdown before publishing closed', async () => {
    let attempts = 0;
    const close = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transport close failed');
    });
    const handle = {
      id: 'thread-close-retry',
      agentKind: 'codex',
      model: 'gpt-5.4',
      close,
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({
      id: 'session-close-retry',
      agentKind: 'codex',
      workDir: '/repo',
      handle,
      capabilities: {} as never,
      logger: createLogger() as never,
    });
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));

    await expect(session.close()).rejects.toThrow('transport close failed');
    expect(session.getStatus()).toBe('error');

    await expect(session.close()).resolves.toBeUndefined();
    expect(statuses).toEqual(['error', 'closed']);
    expect(session.getStatus()).toBe('closed');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('keeps the status owner when detach fails and publishes closed only after retry', async () => {
    let attempts = 0;
    const detach = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transport detach failed');
    });
    const handle = {
      id: 'thread-detach-retry',
      agentKind: 'pi',
      model: 'gpt-5.4',
      close: vi.fn(async () => {}),
      detach,
      setInteractionResolver() {},
    } as unknown as AgentSessionHandle;
    const session = new Session({
      id: 'session-detach-retry',
      agentKind: 'pi',
      workDir: '/repo',
      handle,
      capabilities: {} as never,
      logger: createLogger() as never,
    });
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));

    await expect(session.detach()).rejects.toThrow('transport detach failed');
    expect(statuses).toEqual(['error']);
    expect(session.getStatus()).toBe('error');

    await expect(session.detach()).resolves.toBeUndefined();
    expect(statuses).toEqual(['error', 'closed']);
    expect(session.getStatus()).toBe('closed');
    expect(detach).toHaveBeenCalledTimes(2);
  });
});


describe('Host automatic review lifecycle', () => {
  function setup(agentKind: 'pi' | 'codex' | 'claude-code' = 'pi', permissionMode: 'auto' | 'ask' | 'bypassPermissions' = 'auto') {
    const events = createAsyncQueue<AgentEvent>();
    let running = false;
    const reviewGate = createDeferred();
    const closeGate = createDeferred();
    const modeGate = createDeferred();
    const planGate = createDeferred();
    let planMode: boolean | null = false;
    const review = vi.fn(async () => { await reviewGate.promise; return { verdict: 'allow' as const }; });
    const handle = { id: 'host-review', agentKind, model: 'm',
      send: async () => { running = true; }, events: () => events, isTurnRunning: () => running,
      requestGracefulStop: async () => ({ status: 'requested' }),
      close: () => closeGate.promise.finally(() => events.end()), setPermissionMode: () => modeGate.promise, abort: async () => {},
      setInteractionResolver() {}, reviewAutoPermissionAction: review,
      getPlanMode: () => planMode,
      setPlanMode: async (enabled: boolean) => { await planGate.promise; planMode = enabled; },
    } as unknown as AgentSessionHandle;
    const session = new Session({ id: 'host-review', agentKind, workDir: '/repo', handle,
      capabilities: { permissionModes: [{ id: 'ask', displayName: 'Ask' }], setPermissionModeMidSession: { supported: true }, planMode: { supported: true } } as never,
      logger: createLogger(), permissionMode, turnStallMs: 0,
    });
    const emit = async (event: AgentEvent) => {
      if (event.type === 'done') running = false;
      const seen = vi.fn();
      const unsubscribe = session.onEvent(seen);
      events.push(event);
      await vi.waitFor(() => expect(seen).toHaveBeenCalled());
      unsubscribe();
    };
    return { session, handle, review, reviewGate, closeGate, modeGate, planGate, setProviderPlanMode: (value: boolean | null) => { planMode = value; }, emit };
  }
  const action = { kind: 'other' as const, description: 'plugin file handoff' };
  it('uses execution Plan authority after the one-shot UI toggle has been consumed', async () => {
    const { session, handle, closeGate } = setup('claude-code', 'bypassPermissions');
    expect(session.getPlanMode()).toBe(false);
    for (const active of [true, null]) {
      handle.getExecutionPlanMode = () => active;
      expect(await session.reviewHostPermissionAction(action)).toMatchObject({ verdict: 'block' });
    }
    handle.getExecutionPlanMode = () => false;
    expect(await session.reviewHostPermissionAction(action)).toMatchObject({ verdict: 'allow' });
    closeGate.resolve();
    await session.close();
  });
  it('does not invalidate Host authority for a no-op Plan update', async () => {
    const { session, closeGate } = setup();
    const before = session.stablePlanModeState;
    await session.setPlanMode(false);
    expect(session.stablePlanModeState).toEqual(before);
    closeGate.resolve();
    await session.close();
  });
  it.each(['bypassPermissions', 'auto', 'ask'] as const)('Host %s cannot override enabled or unknown Plan mode', async (mode) => {
    const { session, review, setProviderPlanMode, closeGate } = setup('pi', mode);
    for (const enabled of [true, null]) {
      setProviderPlanMode(enabled);
      expect(await session.reviewHostPermissionAction(action)).toMatchObject({ verdict: 'block' });
    }
    expect(review).not.toHaveBeenCalled();
    closeGate.resolve();
    await session.close();
  });
  it.each(['enabled', 'restored', 'failed'] as const)('Plan changes invalidate pending Host approvals even when %s', async (outcome) => {
    const { session, handle, review, reviewGate, planGate, closeGate } = setup();
    const oldGeneration = session.stablePlanModeState?.generation;
    const pending = session.reviewHostPermissionAction(action);
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    const changing = session.setPlanMode(true);
    expect(session.stablePlanModeState).toBeNull();
    expect(await session.reviewHostPermissionAction(action)).toMatchObject({ verdict: 'block' });
    planGate.resolve();
    await changing;
    if (outcome !== 'enabled') await session.setPlanMode(false);
    if (outcome === 'failed') {
      // Even a provider transport failure invalidates the previous authority.
      handle.setPlanMode = async () => { throw new Error('transport failed'); };
      await expect(session.setPlanMode(true)).rejects.toThrow('transport failed');
    }
    expect(session.stablePlanModeState?.generation).not.toBe(oldGeneration);
    reviewGate.resolve();
    expect(await pending).toMatchObject({ verdict: 'block' });
    closeGate.resolve();
    await session.close();
  });
  it.each(['bypassPermissions', 'ask'] as const)('Host operations follow %s without AI review', async (mode) => {
    const { session, review, closeGate } = setup('pi', mode);
    expect(await session.reviewHostPermissionAction(action)).toEqual({ verdict: mode === 'ask' ? 'ask' : 'allow' });
    expect(review).not.toHaveBeenCalled();
    closeGate.resolve();
    await session.close();
    expect(await session.reviewHostPermissionAction(action)).toMatchObject({ verdict: 'block' });
  });
  it('does not use Full access while the permission mode is changing', async () => {
    const { session, modeGate, closeGate } = setup('pi', 'bypassPermissions');
    const changing = session.setPermissionMode('ask');
    await vi.waitFor(() => expect(session.stablePermissionModeState).toBeNull());
    expect(await session.reviewHostPermissionAction(action)).toMatchObject({ verdict: 'block' });
    modeGate.resolve();
    await changing;
    expect(await session.reviewHostPermissionAction(action)).toEqual({ verdict: 'ask' });
    closeGate.resolve();
    await session.close();
  });
  it('returns the reviewer decision while the session is stable', async () => {
    const { session, reviewGate } = setup();
    reviewGate.resolve();
    expect(await session.reviewHostPermissionAction(action)).toEqual({ verdict: 'allow' });
  });
  it.each(['root-done', 'next-root-turn'] as const)(
    'preserves an active background Host review across %s', async (boundary) => {
      const { session, reviewGate, closeGate, emit } = setup('codex');
      await session.send('Continue the approved background work.');
      await emit({ type: 'tool_use', source: 'codex', turnScope: 'background', data: { toolUseId: 'child-tool', name: 'ghost_call', input: {} } });
      const pending = session.reviewHostPermissionAction(action);
      await emit({ type: 'done', source: 'codex', data: {} });
      if (boundary === 'next-root-turn') await session.send('Continue the approved background work.');
      reviewGate.resolve();
      expect(await pending).toEqual({ verdict: 'allow' });
      closeGate.resolve();
      await session.close();
    },
  );
  it('rejects a late allow even after Stop has returned to active', async () => {
    const { session, reviewGate } = setup();
    const pending = session.reviewHostPermissionAction(action);
    await session.abort();
    expect(session.getStatus()).toBe('active');
    reviewGate.resolve();
    expect(await pending).toMatchObject({ verdict: 'block' });
  });
  it('retains graceful Stop invalidation after normal done clears foreground control', async () => {
    const { session, reviewGate, closeGate, emit } = setup('codex');
    await session.send('Continue the approved background work.');
    const pending = session.reviewHostPermissionAction(action);
    expect(await session.requestGracefulStop()).toMatchObject({ status: 'requested' });
    await emit({ type: 'done', source: 'codex', data: {} });
    expect(session.getTurnControlSnapshot().gracefulStopState).toBe('none');
    reviewGate.resolve();
    expect(await pending).toMatchObject({ verdict: 'block' });
    closeGate.resolve();
    await session.close();
  });
  it('rejects a late allow as soon as closing starts', async () => {
    const { session, reviewGate, closeGate } = setup();
    const pending = session.reviewHostPermissionAction(action);
    const closing = session.close();
    reviewGate.resolve();
    expect(await pending).toMatchObject({ verdict: 'block' });
    closeGate.resolve();
    await closing;
  });
  it('rejects reviews during a permission change and invalidates earlier results', async () => {
    const { session, review, reviewGate, modeGate } = setup();
    const pending = session.reviewHostPermissionAction(action);
    const changing = session.setPermissionMode('ask');
    await vi.waitFor(() => expect(session.stablePermissionModeState).toBeNull());
    expect(await session.reviewHostPermissionAction(action)).toMatchObject({ verdict: 'block' });
    expect(review).toHaveBeenCalledOnce();
    modeGate.resolve();
    await changing;
    reviewGate.resolve();
    expect(await pending).toMatchObject({ verdict: 'block' });
    expect(await session.reviewHostPermissionAction(action)).toEqual({ verdict: 'ask' });
  });
});
