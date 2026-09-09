import { describe, expect, it } from 'vitest';
import {
  DeviceLinkTopicRegistry,
  markHeldRemoteTopicsSubscribed,
  markRemoteTopicsSubscribed,
  markRemoteTopicsUnsubscribed,
  resolvePeerRecoveryPlan,
  topicsMissingRemoteAck,
} from '@/device-link/topicRegistry';

describe('DeviceLinkTopicRegistry', () => {
  it('records open links and subscribed topics as a replayable plan', () => {
    const registry = new DeviceLinkTopicRegistry();

    registry.trackOpenLink('dev-1');
    registry.trackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']);
    registry.trackSubscribe('session:s1', 'dev-1', ['session:s1', 'unsafe']);

    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'sessions'] },
    ]);
  });

  it('builds one peer recovery plan without reading neighboring peers', () => {
    const registry = new DeviceLinkTopicRegistry();
    registry.trackOpenLink('dev-b');
    registry.trackSubscribe('list-a', 'dev-a', ['sessions']);
    registry.trackSubscribe('session-b', 'dev-b', ['session:s2']);

    expect(registry.snapshotDevice('dev-a')).toEqual({
      deviceId: 'dev-a',
      openLink: false,
      topics: ['sessions'],
    });
    expect(registry.snapshotDevice('dev-b')).toEqual({
      deviceId: 'dev-b',
      openLink: true,
      topics: ['session:s2'],
    });
    expect(registry.snapshotDevice('dev-missing')).toBeNull();
    expect(registry.deviceIds()).toEqual(['dev-a', 'dev-b']);
  });

  it('queues visible topic holders before historical open-link-only peers', () => {
    const registry = new DeviceLinkTopicRegistry();
    registry.trackOpenLink('dev-a-hidden');
    registry.trackOpenLink('dev-z-visible');
    registry.trackSubscribe('device-list', 'dev-z-visible', ['sessions']);

    expect(registry.deviceIds()).toEqual(['dev-z-visible', 'dev-a-hidden']);
  });

  it('removes topics independently from the open link intent', () => {
    const registry = new DeviceLinkTopicRegistry();

    registry.trackOpenLink('dev-1');
    registry.trackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']);
    registry.untrackSubscribe('session:s1', 'dev-1', ['session:s1']);

    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: true, topics: ['sessions'] },
    ]);

    registry.untrackOpenLink('dev-1');
    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: false, topics: ['sessions'] },
    ]);
  });

  it('keeps a shared topic until the last owner releases it', () => {
    const registry = new DeviceLinkTopicRegistry();

    // Device list and a session screen both hold `sessions`; the session screen also holds session:s1.
    registry.trackSubscribe('device-list', 'dev-1', ['sessions']);
    registry.trackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']);

    // Session screen unmounts: session:s1's last owner left, but `sessions` is still held by the list.
    expect(registry.untrackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1'])).toEqual([
      'session:s1',
    ]);
    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: false, topics: ['sessions'] },
    ]);

    // Device list unmounts: now `sessions`'s last owner is gone too.
    expect(registry.untrackSubscribe('device-list', 'dev-1', ['sessions'])).toEqual(['sessions']);
    expect(registry.snapshot()).toEqual([]);
  });

  it('lets Home release a hidden device without interrupting its focused session owner', () => {
    const registry = new DeviceLinkTopicRegistry();

    registry.trackSubscribe('device-list', 'dev-1', ['sessions']);
    registry.trackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']);

    expect(registry.untrackSubscribe('device-list', 'dev-1', ['sessions'])).toEqual([]);
    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: false, topics: ['session:s1', 'sessions'] },
    ]);
  });

  it('releases a focused session stream without dropping the list subscription', () => {
    const registry = new DeviceLinkTopicRegistry();

    registry.trackSubscribe('session:s1', 'dev-1', ['sessions']);
    registry.trackSubscribe('session:s1:focus:1', 'dev-1', ['session:s1']);
    expect(registry.hasTopic('dev-1', 'session:s1')).toBe(true);

    expect(registry.untrackSubscribe('session:s1:focus:1', 'dev-1', ['session:s1'])).toEqual(['session:s1']);
    expect(registry.hasTopic('dev-1', 'session:s1')).toBe(false);
    expect(registry.hasTopic('dev-1', 'sessions')).toBe(true);
    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: false, topics: ['sessions'] },
    ]);
  });

  it('treats repeated subscribes from the same owner as idempotent (no over-count leak)', () => {
    const registry = new DeviceLinkTopicRegistry();

    // The session screen resubscribes many times across resync/retry, but cleanup unsubscribes once.
    for (let i = 0; i < 5; i += 1) {
      registry.trackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']);
    }

    // A single unsubscribe by that owner releases both topics — the count never accumulated.
    expect(registry.untrackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']).sort()).toEqual([
      'session:s1',
      'sessions',
    ]);
    expect(registry.snapshot()).toEqual([]);
  });

  it('releases all of an owner\'s topics when topics are omitted (unmount cleanup)', () => {
    const registry = new DeviceLinkTopicRegistry();
    registry.trackSubscribe('device-list', 'dev-1', ['sessions']);
    registry.trackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']);

    // Omitting topics releases every topic this owner holds; `sessions` survives via device-list.
    expect(registry.untrackSubscribe('session:s1', 'dev-1')).toEqual(['session:s1']);
    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: false, topics: ['sessions'] },
    ]);
  });

  it('returns no released topics when another owner still holds them or they were never tracked', () => {
    const registry = new DeviceLinkTopicRegistry();
    registry.trackSubscribe('device-list', 'dev-1', ['sessions']);
    registry.trackSubscribe('automations:dev-1', 'dev-1', ['sessions']);

    expect(registry.untrackSubscribe('automations:dev-1', 'dev-1', ['sessions'])).toEqual([]); // device-list still holds it
    expect(registry.untrackSubscribe('device-list', 'dev-1', ['session:never'])).toEqual([]); // never tracked
    expect(registry.snapshot()).toEqual([
      { deviceId: 'dev-1', openLink: false, topics: ['sessions'] },
    ]);
  });

  it('tracks remote topic acknowledgements separately from local intent', () => {
    const acked = new Map();

    expect(topicsMissingRemoteAck(acked, 'dev-1', ['sessions', 'sessions'])).toEqual(['sessions']);

    markRemoteTopicsSubscribed(acked, 'dev-1', ['sessions']);
    expect(topicsMissingRemoteAck(acked, 'dev-1', ['sessions', 'session:s1'])).toEqual(['session:s1']);

    markRemoteTopicsUnsubscribed(acked, 'dev-1', ['sessions']);
    expect(topicsMissingRemoteAck(acked, 'dev-1', ['sessions'])).toEqual(['sessions']);
  });

  it('does not keep a remote ack when the local owner left before subscribe resolves', () => {
    const acked = new Map();
    const registry = new DeviceLinkTopicRegistry();

    registry.trackSubscribe('session:s1', 'dev-1', ['sessions', 'session:s1']);
    registry.untrackSubscribe('session:s1', 'dev-1', ['sessions']);

    expect(markHeldRemoteTopicsSubscribed(acked, registry, 'dev-1', ['sessions', 'session:s1'])).toEqual([
      'session:s1',
    ]);
    expect(topicsMissingRemoteAck(acked, 'dev-1', ['sessions', 'session:s1'])).toEqual(['sessions']);
  });

  it('builds an open-only recovery plan when ACK reset outlives durable owners', () => {
    expect(resolvePeerRecoveryPlan('dev-1', null, false)).toBeNull();
    expect(resolvePeerRecoveryPlan('dev-1', null, true)).toEqual({
      deviceId: 'dev-1',
      openLink: true,
      topics: [],
    });
    expect(resolvePeerRecoveryPlan(
      'dev-1',
      { deviceId: 'dev-1', openLink: false, topics: ['sessions'] },
      true,
    )).toEqual({
      deviceId: 'dev-1',
      openLink: true,
      topics: ['sessions'],
    });
  });
});
