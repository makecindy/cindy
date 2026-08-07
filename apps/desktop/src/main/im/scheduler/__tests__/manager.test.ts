import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImSchedulerManager } from '../manager';
import type { SchedulerTransport, SchedulerTransportEvent } from '../transport';

const identity = '12345678901234567';
const nextIdentity = '12345678901234568';

function createTransport(
  overrides: Partial<{
    status: 'online' | 'offline';
    owner: boolean;
  }> = {},
) {
  let listener: ((event: SchedulerTransportEvent) => void) | null = null;
  const pushes: Array<{ peerDeviceId: string; payload: unknown }> = [];
  const snapshotRequests: number[] = [];
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
    requestSnapshot: () => snapshotRequests.push(Date.now()),
  };
  return {
    transport,
    pushes,
    snapshotRequests,
    emit(event: SchedulerTransportEvent) {
      listener?.(event);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

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
      state: 'active',
      channel: { channel: 'discord', identity },
      reason: 'elected',
    });
  });

  it('retries a lost discovery probe with the same nonce and stops at the bound', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 2,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    await vi.advanceTimersByTimeAsync(250);
    const probes = harness.pushes
      .filter((push) => push.peerDeviceId === 'a')
      .map((push) => push.payload)
      .filter(
        (payload): payload is { kind: 'probe'; nonce: string } =>
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { kind?: unknown }).kind === 'probe',
      );
    expect(probes).toHaveLength(3);
    expect(new Set(probes.map((probe) => probe.nonce))).toEqual(new Set(['round-000000000000']));
    expect(harness.snapshotRequests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.pushes.filter((push) => push.peerDeviceId === 'a')).toHaveLength(3);
    manager.stop();
  });

  it('propagates a binding change in the next peer probe and scopes runtime gaps', () => {
    let localIdentity = identity;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity: localIdentity }),
      nonceFactory: (() => {
        let round = 0;
        return () => `round-${String(++round).padStart(14, '0')}`;
      })(),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    manager.getRuntimeGaps().adopt({ identity, generation: 'a'.repeat(32), state: 'dirty' });

    localIdentity = nextIdentity;
    manager.resetBindingDiscovery();
    const latestProbe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { channels?: Array<{ identity: string }> } | undefined;
    expect(latestProbe?.channels).toEqual([{ channel: 'discord', identity: nextIdentity }]);
    expect(manager.getRuntimeGaps().values()).toEqual([]);

    manager
      .getRuntimeGaps()
      .adopt({ identity: nextIdentity, generation: 'b'.repeat(32), state: 'dirty' });
    manager.resetAccountDiscovery();
    expect(manager.getRuntimeGaps().values()).toEqual([]);
  });

  it('lets a peer learn the new binding before it elects an ingress', () => {
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity: nextIdentity }),
      nonceFactory: () => 'round-000000000000',
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    const probe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string } | undefined;

    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'probe',
        sentAt: 2,
        nonce: 'round-peer-00000',
        channels: [{ channel: 'discord', identity: nextIdentity }],
      },
    });
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 3,
        channels: [{ channel: 'discord', identity: nextIdentity }],
        inReplyTo: probe?.nonce,
      },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity: nextIdentity },
      reason: 'peer-won',
    });
  });

  it('does not reply to probes from devices outside the current authoritative snapshot', () => {
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    const before = harness.pushes.length;
    harness.emit({
      type: 'push',
      sourceDeviceId: 'unknown',
      payload: {
        kind: 'probe',
        sentAt: 2,
        nonce: 'round-unknown000',
        channels: [{ channel: 'discord', identity }],
      },
    });
    expect(harness.pushes).toHaveLength(before);
  });
});
