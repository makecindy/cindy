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
    });

    const firstClose = session.close();
    const secondClose = session.close();

    expect(secondClose).toBe(firstClose);
    expect(close).toHaveBeenCalledTimes(1);
    expect(session.getStatus()).not.toBe('closed');

    transportClose.resolve();
    await Promise.all([firstClose, secondClose]);

    expect(session.getStatus()).toBe('closed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps an idle session active and retries after its runtime close fails', async () => {
    const close = vi.fn()
      .mockRejectedValueOnce(new Error('archive failed'))
      .mockResolvedValueOnce(undefined);
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
    });

    await expect(session.closeIfIdle({ releaseRuntime: true })).rejects.toThrow('archive failed');
    expect(session.getStatus()).toBe('active');

    await expect(session.closeIfIdle({ releaseRuntime: true })).resolves.toBe(true);
    expect(session.getStatus()).toBe('closed');
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenNthCalledWith(1, { releaseRuntime: true });
    expect(close).toHaveBeenNthCalledWith(2, { releaseRuntime: true });
  });

  it('upgrades an in-flight generic close when a runtime release is requested', async () => {
    const genericClose = createDeferred();
    const close = vi.fn()
      .mockImplementationOnce(() => genericClose.promise)
      .mockResolvedValueOnce(undefined);
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
    });

    const firstClose = session.close();
    const releaseClose = session.close({ releaseRuntime: true });

    expect(releaseClose).toBe(firstClose);
    expect(close).toHaveBeenCalledOnce();

    genericClose.resolve();
    await Promise.all([firstClose, releaseClose]);

    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenNthCalledWith(1, undefined);
    expect(close).toHaveBeenNthCalledWith(2, { releaseRuntime: true });
    expect(session.getStatus()).toBe('closed');
  });
});
