import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackgroundConnection } from '@/device-link/backgroundConnection';
import { createRemoteSyncCoordinator, retryRemoteSyncRead } from '@/device-link/remoteSyncTask';
import { readProgressiveMessageWindow, settleProgressiveSnapshot, runSessionMessagesSnapshotSingleFlight } from '@/device-link/sessionSnapshotSingleFlight';
import { notificationRecoveryRoute } from '@/notifications/pushRegistrationModel';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { classifySnapshotBatchFailure, rehydrateDeviceLinkPeer } from '@/device-link/rehydrate';
import type { RemoteMessage } from '@/session/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('background push recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
  afterEach(() => vi.useRealTimers());

  function fixture() {
    let background = true;
    const release = deferred<void>();
    const stop = vi.fn();
    const connect = vi.fn();
    const releaseTopics = vi.fn(() => [release.promise]);
    const lifecycle = createBackgroundConnection({
      isBackground: () => background,
      releaseTopics, stop, connect,
      graceMs: 2500, releaseWaitMs: 1000, suspendMs: 10_000,
    });
    return { lifecycle, release, stop, connect, releaseTopics, active: () => { background = false; lifecycle.active(); } };
  }

  it('replaces a half-open socket immediately when JS was suspended during the final unsubscribe', async () => {
    const f = fixture();
    f.lifecycle.background();
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.releaseTopics).toHaveBeenCalledTimes(2);
    expect(f.stop).not.toHaveBeenCalled();
    // Wall time passes without running timers: iOS suspended the JS runtime.
    vi.setSystemTime(Date.now() + 60_000);
    f.active();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.connect.mock.invocationCallOrder[0]);
    f.release.resolve();
    await vi.runAllTimersAsync();
    expect(f.stop).toHaveBeenCalledTimes(1);
    f.lifecycle.dispose();
  });

  it('keeps the healthy socket for a quick app switch and releases heavy topics immediately', async () => {
    const f = fixture();
    f.lifecycle.background();
    expect(f.releaseTopics).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    f.active();
    f.release.resolve();
    await vi.runAllTimersAsync();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it('bounds final unsubscribe and prevents an old tail from stopping a later background generation', async () => {
    const f = fixture();
    f.lifecycle.background();
    await vi.advanceTimersByTimeAsync(2500);
    f.active();
    f.lifecycle.background();
    f.release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stop).not.toHaveBeenCalled();
    f.lifecycle.dispose();
    await vi.runAllTimersAsync();
    expect(f.stop).not.toHaveBeenCalled();
    const g = fixture();
    g.lifecycle.background();
    await vi.advanceTimersByTimeAsync(3500);
    expect(g.stop).toHaveBeenCalledTimes(1);
    g.lifecycle.dispose();
  });
});

describe('progressive push snapshots', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); remoteSessionStore.clear(); });
  afterEach(() => { remoteSessionStore.clear(); vi.useRealTimers(); });

  const message: RemoteMessage = {
    id: 'latest', sessionId: 'session-1', role: 'assistant', content: 'latest response',
    clientId: 'latest', toolUseId: null, agentMeta: null, createdAt: '2026-09-05T00:00:00Z',
  };

  it('shows push messages at 100ms while metadata and control state are still pending', async () => {
    const metadata = deferred<number>();
    const history = deferred<RemoteMessage[]>();
    const projection = deferred<void>();
    let recovered = false;
    const timeline: number[] = [];
    const result = readProgressiveMessageWindow({
      readMetadata: () => metadata.promise,
      readMessages: () => history.promise,
      eager: true, shouldReadMessages: () => true, isCurrent: () => true,
      commitMessages: (value) => { remoteSessionStore.setMessages('session-1', value); timeline.push(Date.now()); },
    });
    const complete = Promise.all([result, projection.promise]).then(() => { recovered = true; });
    await vi.advanceTimersByTimeAsync(100);
    history.resolve([message]);
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteSessionStore.getMessages('session-1')).toEqual([message]);
    expect(timeline).toEqual([100]);
    expect(recovered).toBe(false);
    metadata.resolve(1);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(recovered).toBe(false);
    projection.resolve();
    await complete;
    expect(recovered).toBe(true);
  });

  it('starts history on changed metadata without waiting for any auxiliary read', async () => {
    const metadata = deferred<number>();
    const readMessages = vi.fn(async () => [message]);
    const result = readProgressiveMessageWindow({
      readMetadata: () => metadata.promise, readMessages,
      eager: false, shouldReadMessages: (version) => version === 2,
      isCurrent: () => true, commitMessages: () => undefined,
    });
    expect(readMessages).not.toHaveBeenCalled();
    metadata.resolve(2);
    await result;
    expect(readMessages).toHaveBeenCalledTimes(1);
    await readProgressiveMessageWindow({
      readMetadata: async () => 1, readMessages,
      eager: false, shouldReadMessages: () => false,
      isCurrent: () => true, commitMessages: () => undefined,
    });
    expect(readMessages).toHaveBeenCalledTimes(1);
  });

  it('commits a recovery response before a sibling times out and retains the failure classification', async () => {
    const goal = deferred<void>();
    const result = Promise.all([
      settleProgressiveSnapshot(Promise.resolve([message]), (value) => remoteSessionStore.setMessages('session-1', value)),
      settleProgressiveSnapshot(goal.promise, () => undefined),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteSessionStore.getMessages('session-1')).toEqual([message]);
    goal.reject(new Error('INVOKE_TIMEOUT'));
    const settled = await result;
    expect(settled.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('does not reuse a pre-ACK message request for the post-ACK gap reconciliation', async () => {
    const old = deferred<string>();
    const scope = { deviceId: 'device', sessionId: 'session', connectionEpoch: 1 };
    const fence = { kind: 'detail' as const, generation: 1 };
    const before = runSessionMessagesSnapshotSingleFlight({ ...scope, subscriptionIdentity: null }, 20, fence, () => old.promise);
    const read = vi.fn(async () => 'after-ack');
    expect(await runSessionMessagesSnapshotSingleFlight({ ...scope, subscriptionIdentity: 7 }, 20, fence, read)).toBe('after-ack');
    expect(read).toHaveBeenCalledTimes(1);
    old.resolve('before-ack');
    await before;
  });

  it('cancels shared stale snapshots without touching another peer and fetches a fresh replacement', async () => {
    const old = deferred<string>();
    const other = deferred<string>();
    const scope = { deviceId: 'device-a', sessionId: 'session', connectionEpoch: 1 };
    const fence = { kind: 'detail' as const, generation: 1 };
    // Rehydrate starts first; detail joins it and can subsequently invalidate it.
    const rehydrate = runSessionMessagesSnapshotSingleFlight(scope, 20, fence, () => old.promise);
    const controller = new AbortController();
    const detail = runSessionMessagesSnapshotSingleFlight({ ...scope, signal: controller.signal }, 20, fence, async () => 'unused');
    expect(detail).toBe(rehydrate);
    const peerB = runSessionMessagesSnapshotSingleFlight({ ...scope, deviceId: 'device-b' }, 20, fence, () => other.promise);
    const cancelled = expect(detail).rejects.toThrow('superseded');
    controller.abort();
    await cancelled;
    expect(await runSessionMessagesSnapshotSingleFlight(scope, 20, fence, async () => 'fresh')).toBe('fresh');
    old.reject(new Error('late transport failure'));
    other.resolve('peer-b');
    expect(await peerB).toBe('peer-b');
  });

  it('rejects a late progressive window after its detail authority has been revoked', async () => {
    const history = deferred<RemoteMessage[]>();
    const authority = remoteSessionStore.enterSessionMessageDetail('session-1');
    const result = readProgressiveMessageWindow({
      readMetadata: async () => 1, readMessages: () => history.promise,
      eager: true, shouldReadMessages: () => true,
      isCurrent: () => remoteSessionStore.isSessionMessageAuthorityCurrent(authority),
      commitMessages: (value) => remoteSessionStore.setMessages('session-1', value, { authority }),
    });
    remoteSessionStore.clear();
    history.resolve([message]);
    await result;
    expect(remoteSessionStore.getMessages('session-1')).toEqual([]);
  });

  it('retries still-current rehydrate after a sharing detail is cancelled, fencing the late old reply', async () => {
    const old = deferred<RemoteMessage[]>();
    const scope = { deviceId: 'device-a', sessionId: 'session-1', connectionEpoch: 1 };
    const fence = { kind: 'detail' as const, generation: 1 };
    const read = vi.fn<() => Promise<RemoteMessage[]>>().mockImplementationOnce(() => old.promise).mockResolvedValue([message]);
    const deps = {
      createDeviceSendCohort: () => 1,
      capturePresenceEpoch: () => 1,
      captureResponseEvidenceEpoch: () => 1,
      isPresenceEpochCurrent: () => true,
      isResponseEvidenceEpochCurrent: () => true,
      openLink: () => ({ capturedPresenceEpoch: 1, capturedResponseEvidenceEpoch: 1, request: Promise.resolve() }),
      subscribe: async () => undefined,
      requestSessionsReseed: () => undefined,
      rebuildSessionSnapshot: async () => {
        const settled = await settleProgressiveSnapshot(
          runSessionMessagesSnapshotSingleFlight(scope, 20, fence, read),
          (value) => remoteSessionStore.setMessages('session-1', value),
        );
        // Same batch boundary as Provider: local invalidation is retried by the
        // existing peer recovery path, not treated as a permanent missing resource.
        const failure = classifySnapshotBatchFailure([settled]);
        if (failure.kind === 'partial-transient') throw Object.assign(new Error('partial snapshot needs retry'), { code: 'INVOKE_TIMEOUT' });
        if (failure.kind === 'reject') throw failure.error;
      },
    };
    const plan = { deviceId: 'device-a', openLink: false, topics: ['session:session-1' as const] };
    const recovery = rehydrateDeviceLinkPeer(plan, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const detail = runSessionMessagesSnapshotSingleFlight({ ...scope, signal: controller.signal }, 20, fence, read);
    const cancelled = expect(detail).rejects.toThrow('superseded');
    controller.abort();
    await cancelled;
    expect((await recovery).transientFailures).toBe(1);
    expect(remoteSessionStore.getMessages('session-1')).toEqual([]);
    expect((await rehydrateDeviceLinkPeer(plan, deps)).transientFailures).toBe(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(remoteSessionStore.getMessages('session-1')).toEqual([message]);
    old.resolve([{ ...message, content: 'obsolete' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteSessionStore.getMessages('session-1')).toEqual([message]);
  });

  it('preserves the device query and fragment while replacing an untrusted duplicate navigation hint', () => {
    const route = notificationRecoveryRoute('/sessions/a?deviceId=d&notificationResponse=old#tail', 'id:push&2');
    expect(route).toBe('/sessions/a?deviceId=d&notificationResponse=id%3Apush%262#tail');
    expect(notificationRecoveryRoute('/sessions/a', '1')).toBe('/sessions/a?notificationResponse=1');
  });
});

describe('superseded recovery reads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the new connection without waiting for the old transport timeout and ignores its late reply', async () => {
    const old = deferred<string>();
    const committed: string[] = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      const value = await retryRemoteSyncRead(run, () => run.reasons.includes('old') ? old.promise : Promise.resolve('new'));
      if (!run.isStale()) committed.push(value);
    });
    coordinator.setContext('connection-1');
    const task = coordinator.request({ reason: 'old' });
    coordinator.setContext('connection-2');
    void coordinator.request({ reason: 'new' });
    await vi.advanceTimersByTimeAsync(0);
    await task;
    expect(committed).toEqual(['new']);
    old.resolve('obsolete');
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toEqual(['new']);
  });

  it('does not retry or reopen after invalidation during backoff', async () => {
    const read = vi.fn(async () => { throw new Error('INVOKE_TIMEOUT'); });
    const coordinator = createRemoteSyncCoordinator((run) => retryRemoteSyncRead(run, read));
    coordinator.setContext('old');
    const task = coordinator.request({ reason: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    coordinator.setContext('new');
    await task;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('drops only a covered ACK follow-up and preserves manual refresh', async () => {
    const gate = deferred<void>();
    const runs: string[][] = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      runs.push([...run.reasons]);
      if (runs.length === 1) { await gate.promise; run.satisfy('subscription-acked'); }
    });
    const result = coordinator.request({ reason: 'mount' });
    void coordinator.request({ reason: 'subscription-acked' });
    void coordinator.request({ reason: 'manual' });
    gate.resolve();
    await result;
    expect(runs).toEqual([['mount'], ['manual']]);
  });

  it('invalidates late siblings of a failed batch when the same-context retry starts', async () => {
    const oldHistory = deferred<void>();
    const committed: string[] = [];
    let late!: Promise<void>;
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      if (run.reasons.includes('old')) {
        late = oldHistory.promise.then(() => { if (!run.isStale()) committed.push('old'); });
        throw new Error('projection failed');
      }
      committed.push('new');
    });
    await expect(coordinator.request({ reason: 'old' })).rejects.toThrow('projection failed');
    await coordinator.request({ reason: 'retry' });
    oldHistory.resolve();
    await late;
    expect(committed).toEqual(['new']);
  });

  it('rejects an awaited authoritative refresh with its real error while cancelling sibling reads', async () => {
    const failed = deferred<void>();
    const history = deferred<void>();
    const error = new Error('projection failed');
    const committed = vi.fn();
    let signal!: AbortSignal;
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      signal = run.signal;
      await Promise.all([
        failed.promise,
        retryRemoteSyncRead(run, () => history.promise).then(() => { if (!run.isStale()) committed(); }),
      ]);
    });
    // A passive caller may ignore the same promise; the awaited rewind caller
    // still receives the original failure, not a successful cancellation result.
    const refresh = coordinator.request({ reason: 'rewind-commit', replaceMessages: true });
    const rejected = expect(refresh).rejects.toBe(error);
    failed.reject(error);
    await rejected;
    expect(signal.aborted).toBe(true);
    history.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).not.toHaveBeenCalled();
  });
});
