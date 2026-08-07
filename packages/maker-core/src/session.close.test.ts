import { describe, expect, it, vi } from 'vitest';

import { Session } from './session.js';
import type { AgentSessionHandle } from './agents/base-agent.js';

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
});
