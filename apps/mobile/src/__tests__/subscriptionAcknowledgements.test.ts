import { describe, expect, it, vi } from 'vitest';
import {
  confirmTrackedSubscription,
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
    'retries an invalidated ACK only for topics still owned (release B=%s)',
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
        generation: () => String(table.generation('host')),
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
      expect(table.identity('host', ['session:b'])).toBeNull();
      expect(send).toHaveBeenCalledTimes(releaseB ? 1 : 2);
      if (!releaseB) replies[1](true);
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
    const pendingGeneration = table.generation('host');
    table.delete('host'); // even when the pending first ACK has not arrived yet
    expect(table.generation('host')).not.toBe(pendingGeneration);
    markRemoteTopicsSubscribed(table, 'host', ['sessions', 'session:a']);
    const active = table.generation('host');
    markRemoteTopicsUnsubscribed(table, 'host', ['session:a']);
    expect(table.generation('host')).not.toBe(active);
    const released = table.generation('host');
    table.clear();
    expect(table.generation('host')).not.toBe(released);
    expect(table.identity('host', ['sessions'])).toBeNull();
  });
});
