import { describe, expect, it } from 'vitest';

import { ImSchedulerManager } from '../manager';
import type { SchedulerTransport, SchedulerTransportEvent } from '../transport';

const identity = '12345678901234567';

function createTransport(
  overrides: Partial<{
    status: 'online' | 'offline';
    owner: boolean;
  }> = {},
) {
  let listener: ((event: SchedulerTransportEvent) => void) | null = null;
  const pushes: Array<{ peerDeviceId: string; payload: unknown }> = [];
  const transport: SchedulerTransport = {
    selfDeviceId: 'z',
    platform: 'darwin',
    getStatus: () => overrides.status ?? 'online',
    isOwner: () => overrides.owner ?? true,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    sendPush: (peerDeviceId, payload) => pushes.push({ peerDeviceId, payload }),
  };
  return {
    transport,
    pushes,
    emit(event: SchedulerTransportEvent) {
      listener?.(event);
    },
  };
}

describe('dormant scheduler manager', () => {
  it('fails closed until the authoritative peer view is confirmed', () => {
    const harness = createTransport();
    const decisions: string[] = [];
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      onDecision: (decision) => decisions.push(`${decision.state}:${decision.reason}`),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'incomplete-peer-view',
    });

    const probe = harness.pushes.find((push) => push.peerDeviceId === 'a')?.payload as {
      nonce?: string;
    };
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 2,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
      },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'peer-won',
    });
    expect(decisions).toContain('standby:incomplete-peer-view');
  });

  it('elects the local Desktop only after relay and ownership gates pass', () => {
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 },
    });
    expect(manager.getDecision()).toEqual({
      state: 'active',
      channel: { channel: 'discord', identity },
      reason: 'elected',
    });

    harness.transport.getStatus = () => 'offline';
    harness.emit({ type: 'relay-status', status: 'offline' });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'relay-offline',
    });
  });

  it('restarts the discovery round when ownership returns', () => {
    const owner = { value: false };
    const harness = createTransport();
    harness.transport.isOwner = () => owner.value;
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: (() => {
        let count = 0;
        return () => `round-${String(++count).padStart(14, '0')}`;
      })(),
    });
    manager.start();
    harness.emit({ type: 'snapshot', snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 } });
    expect(manager.getDecision().reason).toBe('not-owner');
    owner.value = true;
    harness.emit({ type: 'ownership', owner: true });
    expect(manager.getDecision().reason).toBe('elected');
  });

  it('drops an older snapshot instead of reviving a stale election view', () => {
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 10 },
    });
    expect(manager.getDecision().state).toBe('active');

    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 9 },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'missing-snapshot',
    });
  });
});
