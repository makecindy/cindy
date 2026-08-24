import { describe, expect, it, vi } from 'vitest';
import {
  runConnectionScopedSessionMetadataRead,
  runIndependentSnapshotReads,
  runSessionMessagesSnapshotSingleFlight,
  runSessionPendingInteractionsSnapshotSingleFlight,
  runSessionProjectionSnapshotSingleFlight,
  runSessionSnapshotSingleFlight,
  sessionPendingInteractionsSnapshotVariant,
} from '@/device-link/sessionSnapshotSingleFlight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe('session snapshot single-flight', () => {
  it('shares one identical physical read and drops the entry after settle', async () => {
    const gate = deferred<string>();
    const read = vi.fn(() => gate.promise);
    const identity = {
      deviceId: 'device-1',
      sessionId: 'session-1',
      connectionEpoch: 3,
      resource: 'messages' as const,
      variant: 'limit=80;authority=detail:9',
    };

    const first = runSessionSnapshotSingleFlight(identity, read);
    const second = runSessionSnapshotSingleFlight(identity, read);
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);

    gate.resolve('snapshot');
    await expect(first).resolves.toBe('snapshot');
    await runSessionSnapshotSingleFlight(identity, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares page and rehydrate reads when their scope and authority fences match', async () => {
    const scope = {
      deviceId: 'device-1',
      sessionId: 'session-1',
      connectionEpoch: 7,
    };
    const pendingSnapshot: unknown[] = [];
    const callers = [
      (read: () => Promise<string>) =>
        runSessionMessagesSnapshotSingleFlight(
          scope,
          80,
          { kind: 'detail', generation: 4 },
          read,
        ),
      (read: () => Promise<string>) =>
        runSessionPendingInteractionsSnapshotSingleFlight(
          scope,
          pendingSnapshot,
          read,
        ),
      (read: () => Promise<string>) =>
        runSessionProjectionSnapshotSingleFlight(scope, 9, read),
    ];

    for (const run of callers) {
      const gate = deferred<string>();
      const pageRead = vi.fn(() => gate.promise);
      const rehydrateRead = vi.fn(async () => 'duplicate');
      const page = run(pageRead);
      const rehydrate = run(rehydrateRead);
      expect(rehydrate).toBe(page);
      expect(pageRead).toHaveBeenCalledTimes(1);
      expect(rehydrateRead).not.toHaveBeenCalled();
      gate.resolve('shared');
      await expect(page).resolves.toBe('shared');
    }
  });

  it('does not share across connection epochs, request variants, or authority fences', async () => {
    const read = vi.fn(async () => 'snapshot');
    const base = {
      deviceId: 'device-1',
      sessionId: 'session-1',
      resource: 'input-projection' as const,
    };

    await Promise.all([
      runSessionSnapshotSingleFlight(
        { ...base, connectionEpoch: 1, variant: 'authority=4' },
        read,
      ),
      runSessionSnapshotSingleFlight(
        { ...base, connectionEpoch: 2, variant: 'authority=4' },
        read,
      ),
      runSessionSnapshotSingleFlight(
        { ...base, connectionEpoch: 1, variant: 'authority=5' },
        read,
      ),
    ]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('uses pending snapshot identity as a content-free freshness fence', () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    expect(sessionPendingInteractionsSnapshotVariant(first)).toBe(
      sessionPendingInteractionsSnapshotVariant(first),
    );
    expect(sessionPendingInteractionsSnapshotVariant(second)).not.toBe(
      sessionPendingInteractionsSnapshotVariant(first),
    );
  });

  it('clears a rejected request so the next recovery attempt can run', async () => {
    const identity = {
      deviceId: 'device-1',
      sessionId: 'session-1',
      connectionEpoch: 1,
      resource: 'input-projection' as const,
      variant: 'snapshot',
    };
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('recovered');

    await expect(
      runSessionSnapshotSingleFlight(identity, read),
    ).rejects.toThrow('timeout');
    await expect(runSessionSnapshotSingleFlight(identity, read)).resolves.toBe(
      'recovered',
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('independent snapshot retries', () => {
  it('retries only the failed item instead of replaying the whole batch', async () => {
    const attempts = [0, 0, 0];
    const retry = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch {
        return read();
      }
    };
    const reads = [
      async () => {
        attempts[0] += 1;
        return 'meta';
      },
      async () => {
        attempts[1] += 1;
        if (attempts[1] === 1) throw new Error('transient');
        return 'messages';
      },
      async () => {
        attempts[2] += 1;
        return 'projection';
      },
    ] as const;

    await expect(runIndependentSnapshotReads(reads, retry)).resolves.toEqual([
      'meta',
      'messages',
      'projection',
    ]);
    expect(attempts).toEqual([1, 2, 1]);
  });

  it('commits session metadata even when a sibling snapshot later fails', async () => {
    const sibling = deferred<string>();
    const committed: string[] = [];
    const retry = <T,>(read: () => Promise<T>): Promise<T> => read();
    const reads = [
      () => runConnectionScopedSessionMetadataRead(
        async () => 'authoritative-meta',
        () => true,
        (value) => committed.push(value),
      ),
      () => sibling.promise,
    ] as const;

    const batch = runIndependentSnapshotReads(reads, retry);
    await vi.waitFor(() => expect(committed).toEqual(['authoritative-meta']));
    sibling.reject(new Error('projection retry exhausted'));

    await expect(batch).rejects.toThrow('projection retry exhausted');
    expect(committed).toEqual(['authoritative-meta']);
  });
});
