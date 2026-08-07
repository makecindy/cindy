import { describe, expect, it, vi } from 'vitest';

import { createSerializedConnectionLifecycle } from '../connectionLifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('serialized IM connection lifecycle', () => {
  it('waits for an in-flight start before stopping the connection', async () => {
    const starting = deferred();
    const events: string[] = [];
    const lifecycle = createSerializedConnectionLifecycle({
      startConnection: async () => {
        events.push('start:begin');
        await starting.promise;
        events.push('start:end');
      },
      stopConnection: async () => {
        events.push('stop');
      },
      onStartError: vi.fn(),
    });

    lifecycle.start();
    await vi.waitFor(() => expect(events).toEqual(['start:begin']));
    const stopping = lifecycle.stop();

    starting.resolve();
    await stopping;

    expect(events).toEqual(['start:begin', 'start:end', 'stop']);
    expect(lifecycle.isStarted()).toBe(false);
  });

  it('is idempotent within one login and reconnects after logout', async () => {
    const startConnection = vi.fn(async () => undefined);
    const stopConnection = vi.fn(async () => undefined);
    const lifecycle = createSerializedConnectionLifecycle({
      startConnection,
      stopConnection,
      onStartError: vi.fn(),
    });

    lifecycle.start();
    lifecycle.start();
    await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(1));
    await lifecycle.stop();
    await lifecycle.stop();
    lifecycle.start();
    await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
    await lifecycle.stop();

    expect(startConnection).toHaveBeenCalledTimes(2);
    expect(stopConnection).toHaveBeenCalledTimes(2);
  });

  it('forwards the stop reason to the serialized connection teardown', async () => {
    const stopConnection = vi.fn(async (_reason?: string) => undefined);
    const lifecycle = createSerializedConnectionLifecycle({
      startConnection: vi.fn(async () => undefined),
      stopConnection,
      onStartError: vi.fn(),
    });

    lifecycle.start();
    await vi.waitFor(() => expect(lifecycle.isStarted()).toBe(true));
    await lifecycle.stop('quit');

    expect(stopConnection).toHaveBeenCalledWith('quit');
  });

  it('cancels a queued start when logout wins the race', async () => {
    const startConnection = vi.fn(async () => undefined);
    const stopConnection = vi.fn(async () => undefined);
    const lifecycle = createSerializedConnectionLifecycle({
      startConnection,
      stopConnection,
      onStartError: vi.fn(),
    });

    lifecycle.start();
    await lifecycle.stop();

    expect(startConnection).not.toHaveBeenCalled();
    expect(stopConnection).toHaveBeenCalledOnce();
    expect(lifecycle.isStarted()).toBe(false);
  });

  it('recovers after a failed start without poisoning later operations', async () => {
    const startError = new Error('connect failed');
    const startConnection = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(startError)
      .mockResolvedValueOnce(undefined);
    const onStartError = vi.fn();
    const lifecycle = createSerializedConnectionLifecycle({
      startConnection,
      stopConnection: vi.fn(async () => undefined),
      onStartError,
    });

    lifecycle.start();
    await vi.waitFor(() => expect(onStartError).toHaveBeenCalledWith(startError));
    expect(lifecycle.isStarted()).toBe(false);

    lifecycle.start();
    await vi.waitFor(() => expect(startConnection).toHaveBeenCalledTimes(2));
    await lifecycle.stop();
    expect(startConnection).toHaveBeenCalledTimes(2);
  });

  it('serializes account-scoped operations and cancels queued work on logout', async () => {
    const starting = deferred();
    const operation = vi.fn(async () => 'connected' as const);
    const lifecycle = createSerializedConnectionLifecycle({
      startConnection: async () => starting.promise,
      stopConnection: vi.fn(async () => undefined),
      onStartError: vi.fn(),
    });

    lifecycle.start();
    const reconnecting = lifecycle.runWhileStarted(operation);
    const stopping = lifecycle.stop();
    starting.resolve();

    await expect(reconnecting).rejects.toThrow('[IM_NOT_READY]');
    await stopping;
    expect(operation).not.toHaveBeenCalled();
  });

  it('waits for an in-flight account operation before stopping its transport', async () => {
    const operationGate = deferred();
    const events: string[] = [];
    const lifecycle = createSerializedConnectionLifecycle({
      startConnection: async () => {
        events.push('start');
      },
      stopConnection: async () => {
        events.push('stop');
      },
      onStartError: vi.fn(),
    });

    lifecycle.start();
    await vi.waitFor(() => expect(events).toEqual(['start']));
    const saving = lifecycle.runWhileStarted(async () => {
      events.push('save:begin');
      await operationGate.promise;
      events.push('save:end');
    });
    await vi.waitFor(() => expect(events).toContain('save:begin'));

    const stopping = lifecycle.stop();
    expect(events).toEqual(['start', 'save:begin']);

    operationGate.resolve();
    await saving;
    await stopping;

    expect(events).toEqual(['start', 'save:begin', 'save:end', 'stop']);
  });
});
