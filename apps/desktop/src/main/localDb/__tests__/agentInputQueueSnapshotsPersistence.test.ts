import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDbClient: vi.fn(),
}));

vi.mock('../client/current', () => ({
  getDbClient: mocks.getDbClient,
}));

import {
  AgentInputQueueSnapshotTooLargeError,
  awaitAgentInputQueueSnapshotPersistence,
  saveAgentInputQueueSnapshot,
} from '../agentInputQueueSnapshots.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queued(text = 'queued', clientId = `client-${text}`): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    model: 'test-model',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/tmp/cindy-test',
    chatMessage: { clientId, role: 'user' as const, content: text },
    createOpts: {
      agentKind: 'pi' as const,
      model: 'test-model',
      effort: 'medium',
      permissionMode: 'default',
      workingDir: '/tmp/cindy-test',
    },
  };
}

function installDb(
  opts: {
    write?: () => void | Promise<void>;
  } = {},
) {
  const onConflictDoUpdate = vi.fn(() => opts.write?.());
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const where = vi.fn(() => Promise.resolve());
  const del = vi.fn(() => ({ where }));
  const db = { insert, delete: del };
  mocks.getDbClient.mockReturnValue({ drizzle: db });
  return { db, insert, onConflictDoUpdate };
}

describe('agent input queue snapshot durability boundary', () => {
  it('waits for the current session write and resolves after the DB operation', async () => {
    const gate = deferred<void>();
    const { onConflictDoUpdate } = installDb({ write: () => gate.promise });

    const savePromise = saveAgentInputQueueSnapshot('snapshot-flush', [queued()]);
    const flushPromise = awaitAgentInputQueueSnapshotPersistence('snapshot-flush');

    let settled = false;
    void flushPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);

    gate.resolve();
    await expect(savePromise).resolves.toBeUndefined();
    await expect(flushPromise).resolves.toBeUndefined();
  });

  it('exposes a failed write to the durable waiter while allowing a later retry', async () => {
    const failure = new Error('db unavailable');
    let attempt = 0;
    const retryGate = deferred<void>();
    const { onConflictDoUpdate } = installDb({
      write: () => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(failure);
        return retryGate.promise;
      },
    });

    const failedSave = saveAgentInputQueueSnapshot('snapshot-retry', [queued('first')]);
    const failedFlush = awaitAgentInputQueueSnapshotPersistence('snapshot-retry');
    await expect(failedFlush).rejects.toBe(failure);
    await expect(failedSave).rejects.toBe(failure);
    await expect(awaitAgentInputQueueSnapshotPersistence('snapshot-retry')).rejects.toBe(failure);

    const retrySave = saveAgentInputQueueSnapshot('snapshot-retry', [queued('second')]);
    const retryFlush = awaitAgentInputQueueSnapshotPersistence('snapshot-retry');
    await Promise.resolve();
    await Promise.resolve();
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    retryGate.resolve();
    await expect(retrySave).resolves.toBeUndefined();
    await expect(retryFlush).resolves.toBeUndefined();
  });

  it('fails explicitly when sanitization still leaves the snapshot over the size cap', async () => {
    const { insert } = installDb();
    const hugeText = 'x'.repeat(16 * 1024 * 1024 + 1);
    const item = queued(hugeText, 'client-oversize');
    const savePromise = saveAgentInputQueueSnapshot('snapshot-oversize', [item]);
    const flushPromise = awaitAgentInputQueueSnapshotPersistence('snapshot-oversize');

    await expect(flushPromise).rejects.toBeInstanceOf(AgentInputQueueSnapshotTooLargeError);
    await expect(savePromise).rejects.toMatchObject({
      code: 'AGENT_INPUT_QUEUE_SNAPSHOT_TOO_LARGE',
      sessionId: 'snapshot-oversize',
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
