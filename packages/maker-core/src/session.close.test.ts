import { describe, expect, it, vi } from 'vitest';

import { Session } from './session.js';
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
