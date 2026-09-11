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
