import { startFocusedTopicSubscription } from '../device-link/focusedTopicSubscription';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmTrackedSubscription,
  releaseTrackedSubscription,
  SubscriptionAcknowledgements,
} from '../device-link/subscriptionAcknowledgements';
import {
  DeviceLinkTopicRegistry,
  markHeldRemoteTopicsSubscribed,
  markRemoteTopicsSubscribed,
  markRemoteTopicsUnsubscribed,
  topicsMissingRemoteAck,
} from '../device-link/topicRegistry';

describe('subscription recovery identity', () => {
  it.each([false, true])(
    'keeps an unrelated pending ACK valid while respecting its own release (release B=%s)',
    async (releaseB) => {
      const table = new SubscriptionAcknowledgements(() => {});
      const registry = new DeviceLinkTopicRegistry();
      registry.trackSubscribe('list', 'host', ['sessions']);
      registry.trackSubscribe('a', 'host', ['session:a']);
      registry.trackSubscribe('b', 'host', ['session:b']);
      markRemoteTopicsSubscribed(table, 'host', ['sessions', 'session:a']);
      const replies: Array<(sent: boolean) => void> = [];
      const send = vi.fn(() => new Promise<boolean>((resolve) => replies.push(resolve)));
      const run = confirmTrackedSubscription({
        isCurrent: () => true,
        generation: () => String(table.generation('host', ['session:b'])),
        missing: () =>
          topicsMissingRemoteAck(table, 'host', ['session:b']).filter((topic) =>
            registry.hasTopic('host', topic),
          ),
        send,
        acknowledge: (topics) => {
          markHeldRemoteTopicsSubscribed(table, registry, 'host', topics);
        },
      });
      markRemoteTopicsUnsubscribed(table, 'host', registry.untrackSubscribe('a', 'host'));
      if (releaseB) registry.untrackSubscribe('b', 'host');
      replies[0](true);
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(1);
      await run;
      expect(table.identity('host', ['session:b']) !== null).toBe(!releaseB);
      expect(table.identity('host', ['sessions'])).not.toBeNull();
    },
  );

  it('requires both ACKs and invalidates only the affected peer on release', () => {
    const changed = vi.fn();
    const table = new SubscriptionAcknowledgements(changed);
    const topics = ['sessions', 'session:a'] as const;
    markRemoteTopicsSubscribed(table, 'host', ['sessions']);
    expect(table.identity('host', topics)).toBeNull();
    markRemoteTopicsSubscribed(table, 'host', ['session:a']);
    const first = table.identity('host', topics);
    expect(first).not.toBeNull();
    markRemoteTopicsSubscribed(table, 'neighbor', topics);
    const neighbor = table.identity('neighbor', topics);
    markRemoteTopicsUnsubscribed(table, 'host', ['session:a']);
    expect(table.identity('host', topics)).toBeNull();
    expect(table.identity('neighbor', topics)).toBe(neighbor);
    markRemoteTopicsSubscribed(table, 'host', ['session:a']);
    expect(table.identity('host', topics)).not.toBe(first);
    const calls = changed.mock.calls.length;
    markRemoteTopicsSubscribed(table, 'host', topics);
    expect(changed).toHaveBeenCalledTimes(calls);
  });

  it('fences an ACK started before peer reset, background release or relay reconnect', () => {
    const table = new SubscriptionAcknowledgements(() => {});
    const pendingGeneration = table.generation('host', ['sessions', 'session:a']);
    table.delete('host'); // even when the pending first ACK has not arrived yet
    expect(table.generation('host', ['sessions', 'session:a'])).not.toBe(pendingGeneration);
    markRemoteTopicsSubscribed(table, 'host', ['sessions', 'session:a']);
    const active = table.generation('host', ['sessions', 'session:a']);
    markRemoteTopicsUnsubscribed(table, 'host', ['session:a']);
    expect(table.generation('host', ['sessions', 'session:a'])).not.toBe(active);
    const released = table.generation('host', ['sessions', 'session:a']);
    table.clear();
    expect(table.generation('host', ['sessions', 'session:a'])).not.toBe(released);
    expect(table.identity('host', ['sessions'])).toBeNull();
  });
});

// PR #8979 / unit: real registry + confirmation path with a delayed transport
// ACK. Completed ACK dedupe did not protect simultaneous history owners.
it('shares a pending topic ACK without losing independently registered owners', async () => {
  const table = new SubscriptionAcknowledgements(() => {});
  const registry = new DeviceLinkTopicRegistry();
  const scope = {};
  let finish!: (sent: boolean) => void;
  const ack = new Promise<boolean>(resolve => { finish = resolve; });
  const send = vi.fn(() => ack);
  const pending = Array.from({ length: 100 }, (_, i) => {
    registry.trackSubscribe(`owner-${i}`, 'host', ['session:lane']);
    return confirmTrackedSubscription({
      share: { scope, deviceId: 'host' },
      isCurrent: () => true, generation: () => String(table.generation('host', ['session:lane'])),
      missing: () => topicsMissingRemoteAck(table, 'host', ['session:lane']).filter(topic => registry.hasTopic('host', topic)),
      send, acknowledge: topics => { markHeldRemoteTopicsSubscribed(table, registry, 'host', topics); },
    });
  });
  try {
    expect(send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 99; i++) expect(registry.untrackSubscribe(`owner-${i}`, 'host')).toEqual([]);
    finish(true); await Promise.all(pending);
    expect(table.identity('host', ['session:lane'])).not.toBeNull();
    expect(registry.untrackSubscribe('owner-99', 'host')).toEqual(['session:lane']);
  } finally { finish(true); await Promise.all(pending); }
});

it('retries a rejected shared topic ACK instead of retaining its failure', async () => {
  const scope = {};
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(true);
  let held = false;
  const deps = { share: { scope, deviceId: 'host' }, isCurrent: () => true, generation: () => '1',
    missing: () => held ? [] : ['session:lane' as const], send, acknowledge: () => { held = true; } };
  await expect(confirmTrackedSubscription(deps)).rejects.toThrow('offline');
  await confirmTrackedSubscription(deps);
  expect(send).toHaveBeenCalledTimes(2);
  expect(held).toBe(true);
});

it.each(['scope', 'device', 'generation'])('does not share a pending ACK across a different %s', async difference => {
  const scope = {};
  const replies: Array<(sent: boolean) => void> = [];
  const send = vi.fn(() => new Promise<boolean>(resolve => replies.push(resolve)));
  const request = (deviceId: string, generation: string, scopeKey = scope) => confirmTrackedSubscription({ share: { scope: scopeKey, deviceId },
    isCurrent: () => true, generation: () => generation, missing: () => ['session:lane'], send, acknowledge: () => {} });
  const first = request('host', '1');
  const second = request(difference === 'device' ? 'neighbor' : 'host', difference === 'generation' ? '2' : '1', difference === 'scope' ? {} : scope);
  expect(send).toHaveBeenCalledTimes(2);
  replies.forEach(resolve => resolve(true)); await Promise.all([first, second]);
});

// PR #8979 / unit: blur can release the last owner before its first ACK.
// A replacement must acquire a new ACK, while old callers join the new generation.
it('does not reuse an acquisition released before its first ACK', async () => {
  const table = new SubscriptionAcknowledgements(() => {});
  const registry = new DeviceLinkTopicRegistry();
  const scope = {};
  const replies: Array<(sent: boolean) => void> = [];
  const send = vi.fn(() => new Promise<boolean>(resolve => replies.push(resolve)));
  const request = () => confirmTrackedSubscription({ share: { scope, deviceId: 'host' },
    isCurrent: () => true, generation: () => String(table.generation('host', ['session:lane'])),
    missing: () => topicsMissingRemoteAck(table, 'host', ['session:lane']).filter(topic => registry.hasTopic('host', topic)),
    send, acknowledge: topics => { markHeldRemoteTopicsSubscribed(table, registry, 'host', topics); } });
  registry.trackSubscribe('old', 'host', ['session:lane']);
  const old = request();
  expect(registry.untrackSubscribe('old', 'host')).toEqual(['session:lane']);
  table.release('host', ['session:lane']);
  registry.trackSubscribe('replacement', 'host', ['session:lane']);
  const replacement = request();
  expect(send).toHaveBeenCalledTimes(2);
  replies[0](true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(table.identity('host', ['session:lane'])).toBeNull();
  replies[1](true); await Promise.all([old, replacement]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(table.identity('host', ['session:lane'])).not.toBeNull();
});

// PR #8979 / unit: the real ACK table previously gave every topic on a device
// one revision. Adding/removing an unrelated lane must not invalidate an intact
// lane or a multi-topic task binding; dropping/re-ACKing the requested lane must.
it('keeps ACK identities scoped to the requested topics on one host', () => {
  const table = new SubscriptionAcknowledgements(() => {});
  markRemoteTopicsSubscribed(table, 'host', ['sessions', 'session:lane']);
  const lane = table.identity('host', ['session:lane']);
  const task = table.identity('host', ['sessions', 'session:lane']);
  markRemoteTopicsSubscribed(table, 'host', ['session:other']);
  expect(table.identity('host', ['session:lane'])).toBe(lane);
  expect(table.identity('host', ['sessions', 'session:lane'])).toBe(task);
  markRemoteTopicsUnsubscribed(table, 'host', ['session:other']);
  expect(table.identity('host', ['session:lane'])).toBe(lane);
  expect(table.identity('host', ['sessions', 'session:lane'])).toBe(task);
  markRemoteTopicsUnsubscribed(table, 'host', ['session:lane']);
  expect(table.identity('host', ['session:lane'])).toBeNull();
  expect(table.identity('host', ['sessions', 'session:lane'])).toBeNull();
  markRemoteTopicsSubscribed(table, 'host', ['session:lane']);
  expect(table.identity('host', ['session:lane'])).not.toBe(lane);
  expect(table.identity('host', ['sessions', 'session:lane'])).not.toBe(task);
});

// PR #8979: exercise the real confirmation, ACK table and ownership registry.
// Releasing B must not resend A, whether B itself has received its ACK or not.
it.each([false, true])('does not invalidate pending A when topic B is released (ACKed=%s)', async acked => {
  const table = new SubscriptionAcknowledgements(() => {});
  const registry = new DeviceLinkTopicRegistry();
  const scope = {};
  const replies = new Map<string, (ok: boolean) => void>();
  const send = vi.fn((topics: readonly string[]) => new Promise<boolean>(resolve => { replies.set(topics[0], resolve); }));
  const request = (topic: 'session:a' | 'session:b') => {
    registry.trackSubscribe(topic, 'host', [topic]);
    return confirmTrackedSubscription({ share: { scope, deviceId: 'host' }, isCurrent: () => true,
      generation: () => String(table.generation('host', [topic])),
      missing: () => topicsMissingRemoteAck(table, 'host', [topic]).filter(t => registry.hasTopic('host', t)),
      send, acknowledge: topics => { markHeldRemoteTopicsSubscribed(table, registry, 'host', topics); } });
  };
  const a = request('session:a'), b = request('session:b');
  if (acked) { replies.get('session:b')!(true); await b; }
  table.release('host', registry.untrackSubscribe('session:b', 'host'));
  replies.get('session:a')!(true);
  if (!acked) replies.get('session:b')!(true);
  await Promise.all([a, b]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(table.identity('host', ['session:a'])).not.toBeNull();
  expect(table.identity('host', ['session:b'])).toBeNull();
});

// A page can own one shared ACK before any history is opened. Reuse the real
// focus helper as well as registry/confirmation; control calls are the boundary.
it('merges late cleanup after a shared ACK without leaking the released stream', async () => {
  const table = new SubscriptionAcknowledgements(() => {}), registry = new DeviceLinkTopicRegistry(), scope = {};
  let finish!: (ok: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const release = vi.fn(async () => {});
  const acquisitions: Promise<void>[] = [], releases: Promise<void>[] = [];
  const subscribe = (owner: string, deviceId: string, topics: string[]) => {
    registry.trackSubscribe(owner, deviceId, topics);
    const run = confirmTrackedSubscription({ share: { scope, deviceId }, isCurrent: () => true,
      generation: () => String(table.generation(deviceId, ['session:lane'])),
      missing: () => topicsMissingRemoteAck(table, deviceId, ['session:lane']).filter(t => registry.hasTopic(deviceId, t)),
      send, acknowledge: topics => { markHeldRemoteTopicsSubscribed(table, registry, deviceId, topics); } });
    acquisitions.push(run); return run;
  };
  const unsubscribe = (owner: string, deviceId: string, topics: string[]) => {
    const last = registry.untrackSubscribe(owner, deviceId, topics);
    table.release(deviceId, last);
    const unheld = topics.filter(t => !registry.hasTopic(deviceId, t)) as 'session:lane'[];
    const run = releaseTrackedSubscription({ share: { scope, deviceId }, topics: unheld,
      generation: topic => String(table.generation(deviceId, [topic])), send: release });
    releases.push(run); return run;
  };
  const cleanups = Array.from({ length: 100 }, (_, i) => startFocusedTopicSubscription({
    owner: `history-${i}`, deviceId: 'host', topic: 'session:lane', subscribe, unsubscribe }));
  cleanups.forEach(off => off());
  await Promise.all(releases);
  expect(release).toHaveBeenCalledTimes(1);
  finish(true); await Promise.all(acquisitions); await Promise.all(releases);
  expect(send).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenLastCalledWith(['session:lane']);
  expect(registry.hasTopic('host', 'session:lane')).toBe(false);
});

it('does not share a pending release with a new generation, peer or client and retries failures', async () => {
  const scope = {}, replies: Array<() => void> = [];
  const send = vi.fn(() => new Promise<void>(resolve => { replies.push(resolve); }));
  const run = (generation: string, deviceId = 'host', client = scope) => releaseTrackedSubscription({
    share: { scope: client, deviceId }, topics: ['session:lane'], generation: () => generation, send });
  const pending = [run('1'), run('1'), run('2'), run('1', 'neighbor'), run('1', 'host', {})];
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(4);
  replies.forEach(done => done()); await Promise.all(pending);
  const failed = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const retry = () => releaseTrackedSubscription({ share: { scope, deviceId: 'host' }, topics: ['session:lane'], generation: () => '1', send: failed });
  await expect(retry()).rejects.toThrow('offline');
  await retry(); expect(failed).toHaveBeenCalledTimes(2);
});
