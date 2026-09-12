import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDbClient: vi.fn(),
  epoch: 1,
}));

vi.mock('../client/current', () => ({
  getDbClient: mocks.getDbClient,
  getCurrentDbClientSnapshot: () => ({ client: mocks.getDbClient(), userId: "test", clientEpoch: mocks.epoch }),
}));

import {
  AgentInputQueueSnapshotTooLargeError,
  awaitAgentInputQueueSnapshotPersistence,
  loadAgentInputQueueSnapshotCounts,
  saveAgentInputQueueSnapshot,
  saveCancelledInputDelivery,
  hasInputDeliveryCancellation,
  readInputDeliveryReceipts,
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
  it.each(['settled', 'pending', 'receipt-retry'] as const)('does not let %s cancellation replace a failed snapshot boundary', async (timing) => {
    const sid = `snapshot-cancel-${timing}`;
    const failure = new Error('snapshot failed');
    const gate = deferred<void>();
    const snapshotWrite = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const cancelWrite = vi.fn().mockResolvedValue(undefined);
    if (timing === 'receipt-retry') cancelWrite.mockRejectedValueOnce(new Error('cancel failed'));
    const select = vi.fn(() => ({ from: () => ({ where: async () => [{ role: 'message_tombstone' }] }) }));
    mocks.getDbClient.mockReturnValue({ drizzle: {
      insert: () => ({ values: () => ({ onConflictDoUpdate: snapshotWrite, onConflictDoNothing: cancelWrite }) }),
      select,
    } });
    const snapshot = saveAgentInputQueueSnapshot(sid, [queued()]);
    const rejectedSnapshot = expect(snapshot).rejects.toBe(failure);
    if (timing !== 'pending') { gate.reject(failure); await rejectedSnapshot; }
    const cancel = saveCancelledInputDelivery(sid, 'cancelled-other');
    if (timing === 'pending') { gate.reject(failure); await rejectedSnapshot; }
    if (timing === 'receipt-retry') await expect(cancel).rejects.toThrow('cancel failed');
    else await expect(cancel).resolves.toBe(true);
    await expect(awaitAgentInputQueueSnapshotPersistence(sid)).rejects.toBe(failure);
    const priorReads = select.mock.calls.length;
    await expect(readInputDeliveryReceipts(sid, ['client-queued'])).rejects.toBe(failure);
    expect(select.mock.calls.length).toBe(priorReads);
    expect(cancelWrite).toHaveBeenCalledTimes(timing === 'receipt-retry' ? 2 : 1);
    await saveAgentInputQueueSnapshot(sid, [queued()]);
    await expect(awaitAgentInputQueueSnapshotPersistence(sid)).resolves.toBeUndefined();
  });

  it('rejects through Promise handlers when the database owner is unavailable', async () => {
    mocks.getDbClient.mockImplementation(() => { throw new Error('DbClient not ready'); });
    try {
      const operations = [
        () => saveAgentInputQueueSnapshot('owner-unavailable', [queued()]),
        () => saveCancelledInputDelivery('owner-unavailable', 'client-1'),
        () => awaitAgentInputQueueSnapshotPersistence('owner-unavailable'),
        () => readInputDeliveryReceipts('owner-unavailable', ['client-1']),
      ];
      for (const operation of operations) {
        const cleanup = vi.fn();
        await operation().catch(cleanup);
        expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ message: 'DbClient not ready' }));
      }
    } finally {
      mocks.getDbClient.mockReset();
    }
  });

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

  it('counts selected snapshots in SQLite without returning payload bodies', async () => {
    const query = vi.fn().mockResolvedValue([{ sessionId: 'session-1', itemCount: 2 }]);
    mocks.getDbClient.mockReturnValue({ query } as never);

    await expect(
      loadAgentInputQueueSnapshotCounts(['session-1', 'session-2', 'session-1']),
    ).resolves.toEqual({ 'session-1': 2, 'session-2': 0 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('json_each(snapshot.payload)'), [
      'session-1',
      'session-2',
    ]);
    expect(query.mock.calls[0]?.[0]).not.toContain('SELECT payload');
  });

  it('matches restore de-duplication and clear-boundary filtering for cold queued counts', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cleared_at INTEGER
      );
      CREATE TABLE agent_input_queue_snapshots (
        session_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        UNIQUE(session_id, client_id)
      );
    `);
    const accepted = {
      ...queued('accepted', 'client-accepted'),
      hostAcceptedAtMs: 301,
    };
    const beforeClear = {
      ...queued('before clear', 'client-before-clear'),
      hostAcceptedAtMs: 299,
    };
    const missingReceipt = queued('missing receipt', 'client-missing-receipt');
    const waiting = {
      ...queued('waiting', 'client-waiting'),
      hostAcceptedAtMs: 301,
    };
    const staleScheduler = {
      ...queued('stale scheduler', 'client-stale-scheduler'),
      hostAcceptedAtMs: 301,
      origin: {
        kind: 'scheduler' as const,
        scheduleId: 'schedule-legacy',
        scheduleName: 'Legacy heartbeat',
      },
    };
    db.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, ?)').run(
      'session-crash-window',
      300,
    );
    db.prepare(
      'INSERT INTO agent_input_queue_snapshots (session_id, payload, updated_at) VALUES (?, ?, ?)',
    ).run(
      'session-crash-window',
      JSON.stringify([
        accepted,
        beforeClear,
        missingReceipt,
        waiting,
        staleScheduler,
        'malformed legacy row',
      ]),
      Date.now(),
    );
    db.prepare('INSERT INTO messages (session_id, client_id) VALUES (?, ?)').run(
      'session-crash-window',
      accepted.clientId,
    );
    const query = vi.fn(async <T = unknown>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...params) as T[]);
    mocks.getDbClient.mockReturnValue({ query } as never);

    try {
      await expect(
        loadAgentInputQueueSnapshotCounts(['session-crash-window']),
      ).resolves.toEqual({ 'session-crash-window': 1 });
      expect(query.mock.calls[0]?.[0]).toContain('NOT EXISTS');
      expect(query.mock.calls[0]?.[0]).toContain('FROM messages');
      expect(query.mock.calls[0]?.[0]).toContain('session.cleared_at');
      expect(query.mock.calls[0]?.[0]).toContain('$.hostAcceptedAtMs');
      expect(query.mock.calls[0]?.[0]).toContain('$.origin.kind');
    } finally {
      db.close();
    }
  });

  it('isolates corrupt snapshots while preserving database read failures', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        { sessionId: 'corrupt', itemCount: null },
        { sessionId: 'healthy', itemCount: 2 },
      ])
      .mockRejectedValueOnce(new Error('db unavailable'));
    mocks.getDbClient.mockReturnValue({ query } as never);

    await expect(loadAgentInputQueueSnapshotCounts(['corrupt', 'healthy'])).resolves.toEqual({
      corrupt: 0,
      healthy: 2,
    });
    await expect(loadAgentInputQueueSnapshotCounts(['unavailable'])).rejects.toThrow(
      'db unavailable',
    );
  });
  it('does not erase a snapshot when cancellation persistence fails, and retries the intent first', async () => {
    let failing = true;
    const inserted: Array<Record<string, unknown>> = [];
    const insert = vi.fn(() => ({ values: (row: Record<string, unknown>) => ({
      onConflictDoNothing: async () => {
        if (failing) throw new Error('disk full');
        inserted.push(row);
      },
      onConflictDoUpdate: async () => { inserted.push(row); },
    }) }));
    const where = vi.fn(async () => undefined);
    mocks.getDbClient.mockReturnValue({ drizzle: { insert, delete: () => ({ where }) } });
    await expect(saveCancelledInputDelivery('cancel-retry', 'cancelled-id')).rejects.toThrow('disk full');
    await expect(saveAgentInputQueueSnapshot('cancel-retry', [])).rejects.toThrow('disk full');
    expect(where).not.toHaveBeenCalled();
    failing = false;
    await saveAgentInputQueueSnapshot('cancel-retry', []);
    expect(inserted).toEqual([expect.objectContaining({ role: 'message_tombstone', content: 'null', clientId: 'cancelled-id' })]);
    expect(where).toHaveBeenCalledOnce();
    expect(hasInputDeliveryCancellation('cancel-retry', 'cancelled-id')).toBe(true);
    await expect(awaitAgentInputQueueSnapshotPersistence('cancel-retry')).resolves.toBeUndefined();
  });
  it.each(['user', 'rewound-user', 'message_tombstone', 'absent'])('only confirms cancellation when its durable namespace is sealed: %s', async (existing) => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE messages (session_id TEXT, client_id TEXT, role TEXT, content TEXT, rewind_at INTEGER, UNIQUE(session_id, client_id))');
    const sid = `cancel-conflict-${existing}`;
    const cid = 'same-client-id';
    if (existing !== 'absent') sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
      .run(sid, cid, existing === 'rewound-user' ? 'user' : existing, 'original', existing === 'rewound-user' ? 1 : null);
    mocks.getDbClient.mockReturnValue({ drizzle: {
      insert: () => ({ values: (row: Record<string, unknown>) => ({ onConflictDoNothing: async () => {
        sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .run(row.sessionId, row.clientId, row.role, row.content, row.rewindAt);
      } }) }),
      select: () => ({ from: () => ({ where: async () => sqlite.prepare('SELECT role FROM messages WHERE session_id = ? AND client_id = ?').all(sid, cid) }) }),
    } });
    try {
      const expected = existing === 'absent' || existing === 'message_tombstone';
      // Register synchronously to stop a late enqueue while the durable claim is checked.
      const cancellation = saveCancelledInputDelivery(sid, cid);
      expect(hasInputDeliveryCancellation(sid, cid)).toBe(true);
      expect(await cancellation).toBe(expected);
      // The replay fence stays closed even when executed history beat cancellation.
      expect(hasInputDeliveryCancellation(sid, cid)).toBe(true);
      // A repeated cancellation has the same answer and never replaces executed content.
      expect(await saveCancelledInputDelivery(sid, cid)).toBe(expected);
      expect(sqlite.prepare('SELECT content FROM messages').get()).toEqual({ content: existing === 'absent' ? 'null' : 'original' });
    } finally { sqlite.close(); }
  });
  it.each(['missing', 'read-error'])('does not acknowledge an unverified cancellation and can retry: %s', async (failure) => {
    const where = vi.fn();
    if (failure === 'missing') where.mockResolvedValueOnce([]);
    else where.mockRejectedValueOnce(new Error('db unavailable'));
    where.mockResolvedValue([{ role: 'message_tombstone' }]);
    mocks.getDbClient.mockReturnValue({ drizzle: {
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      select: () => ({ from: () => ({ where }) }),
    } });
    const sid = `cancel-unverified-${failure}`;
    await expect(saveCancelledInputDelivery(sid, 'id')).rejects.toThrow();
    expect(hasInputDeliveryCancellation(sid, 'id')).toBe(true);
    await expect(saveCancelledInputDelivery(sid, 'id')).resolves.toBe(true);
  });
  it('fences queued writes at an account switch without writing to the next account', async () => {
    const gate = deferred<void>();
    const first = installDb({ write: () => gate.promise });
    const write1 = saveAgentInputQueueSnapshot('owner-switch', [queued('a')]);
    const write2 = saveAgentInputQueueSnapshot('owner-switch', [queued('b')]);
    await Promise.resolve();
    mocks.epoch += 1;
    const second = installDb();
    gate.resolve();
    await expect(write1).rejects.toThrow('DbClient not ready');
    await expect(write2).rejects.toThrow('DbClient not ready');
    expect(first.insert).toHaveBeenCalledOnce();
    expect(second.insert).not.toHaveBeenCalled();
    await saveAgentInputQueueSnapshot('owner-switch', [queued('new-owner')]);
    expect(second.insert).toHaveBeenCalledOnce();
  });
  it('reads the queue before history so a queue-to-message transfer cannot appear unknown', async () => {
    const events: string[] = [];
    const where = vi.fn()
      .mockImplementationOnce(async () => { events.push('queue'); return [{ payload: JSON.stringify([queued('a', 'id-a')]) }]; })
      .mockImplementationOnce(async () => { events.push('history'); return [
        { clientId: 'id-a', role: 'user', rewindAt: null },
        { clientId: 'id-b', role: 'message_tombstone', rewindAt: 123 },
      ]; });
    mocks.getDbClient.mockReturnValue({ drizzle: { select: () => ({ from: () => ({ where }) }) } });
    expect(await readInputDeliveryReceipts('receipt-transfer', ['id-a', 'id-b', 'id-c'])).toEqual([
      { clientId: 'id-a', state: 'accepted' }, { clientId: 'id-b', state: 'removed' }, { clientId: 'id-c', state: 'unknown' },
    ]);
    expect(events).toEqual(['queue', 'history']);
  });
  it('does not report unknown when the delivery snapshot is corrupt or its database read fails', async () => {
    const where = vi.fn().mockResolvedValue([{ payload: '{invalid' }]);
    mocks.getDbClient.mockReturnValue({ drizzle: { select: () => ({ from: () => ({ where }) }) } });
    await expect(readInputDeliveryReceipts('receipt-invalid', ['id-a'])).rejects.toThrow();
    where.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(readInputDeliveryReceipts('receipt-invalid', ['id-a'])).rejects.toThrow('db unavailable');
  });

});
