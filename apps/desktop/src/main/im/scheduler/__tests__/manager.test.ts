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
  const snapshotRequests: Array<{ accountGeneration: string; requestId: string }> = [];
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
    requestSnapshot: (accountGeneration, requestId) =>
      snapshotRequests.push({ accountGeneration, requestId }),
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

  it('fails closed when the authoritative snapshot disappears', () => {
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
    expect(manager.getDecision()).toEqual({
      state: 'active',
      channel: { channel: 'discord', identity },
      reason: 'elected',
    });

    harness.emit({ type: 'snapshot', snapshot: null });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'missing-snapshot',
    });
  });

  it('retries a lost discovery probe and starts a fresh round after the bound', async () => {
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

    await vi.advanceTimersByTimeAsync(50);
    const secondRoundCount = harness.pushes.filter((push) => push.peerDeviceId === 'a').length;
    expect(secondRoundCount).toBeGreaterThan(probes.length);
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.pushes.filter((push) => push.peerDeviceId === 'a').length).toBeGreaterThan(
      secondRoundCount,
    );
    manager.stop();
  });

  it('recomputes election when an active peer advertises a newly bound channel', () => {
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
    const probe = harness.pushes.find((push) => push.peerDeviceId === 'a')?.payload as {
      nonce?: string;
    };
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 2,
        channels: [],
        inReplyTo: probe?.nonce,
      },
    });
    expect(manager.getDecision().state).toBe('active');

    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'probe',
        sentAt: 3,
        nonce: 'round-peer-00000',
        channels: [{ channel: 'discord', identity }],
      },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'peer-won',
    });
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

  it('retains the previous binding identity until its reset clears old gaps', () => {
    let localIdentity = identity;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity: localIdentity }),
      nonceFactory: () => 'round-000000000000',
    });
    manager.start();
    manager.getRuntimeGaps().adopt({ identity, generation: 'a'.repeat(32), state: 'dirty' });

    localIdentity = nextIdentity;
    harness.emit({ type: 'ownership', owner: true });
    manager.resetBindingDiscovery();
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

  it('ignores snapshot responses from before an account reset', () => {
    let round = 0;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => `nonce-${String(++round).padStart(14, '0')}`,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 },
    });
    expect(manager.getDecision().state).toBe('active');

    manager.resetAccountDiscovery();
    const request = harness.snapshotRequests.at(-1);
    expect(request).toBeTruthy();
    expect(manager.getDecision().reason).toBe('missing-snapshot');

    harness.emit({
      type: 'snapshot',
      requestId: 'nonce-old-account',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 2 },
    });
    expect(manager.getDecision().reason).toBe('missing-snapshot');

    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 3 },
    });
    expect(manager.getDecision().state).toBe('active');
  });

  it('ignores presence changes for non-Desktop devices', () => {
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
    harness.emit({ type: 'peer-presence', deviceId: 'phone', platform: 'ios', online: false });
    expect(manager.getDecision()).toEqual({
      state: 'active',
      channel: { channel: 'discord', identity },
      reason: 'elected',
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

  it('ignores a late snapshot after a discovery retry starts a new round', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: (() => {
        let count = 0;
        return () => `nonce-${String(++count).padStart(14, '0')}`;
      })(),
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    await vi.advanceTimersByTimeAsync(100);
    const request = harness.snapshotRequests[0];
    expect(request).toBeTruthy();
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');

    harness.emit({
      type: 'snapshot',
      accountGeneration: request.accountGeneration,
      requestId: 'nonce-old-response',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 2 },
    });
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');

    harness.emit({
      type: 'snapshot',
      accountGeneration: request.accountGeneration,
      requestId: request.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 2 },
    });
    expect(manager.getDecision().state).toBe('active');
    manager.stop();
  });

  it('accepts a current snapshot after the observed clock moves backwards', () => {
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: (() => {
        let count = 0;
        return () => `nonce-${String(++count).padStart(14, '0')}`;
      })(),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 10 },
    });
    expect(manager.getDecision().state).toBe('active');

    harness.emit({ type: 'peer-presence', deviceId: 'a', platform: 'win32', online: true });
    const request = harness.snapshotRequests.at(-1);
    expect(manager.getDecision().reason).toBe('missing-snapshot');
    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 5 },
    });
    expect(manager.getDecision()).toEqual({
      state: 'active',
      channel: { channel: 'discord', identity },
      reason: 'elected',
    });
  });

  it('starts a new discovery round when the final snapshot response times out', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: (() => {
        let count = 0;
        return () => `nonce-${String(++count).padStart(14, '0')}`;
      })(),
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    await vi.advanceTimersByTimeAsync(100);
    const pushesAtFinalRequest = harness.pushes.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.snapshotRequests).toHaveLength(1);
    expect(harness.pushes.length).toBeGreaterThan(pushesAtFinalRequest);
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');
    manager.stop();
  });

  it('retries an unbinding declaration until the peer view is confirmed', async () => {
    vi.useFakeTimers();
    let localIdentity: string | null = identity;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () =>
        localIdentity ? { channel: 'discord', identity: localIdentity } : null,
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    localIdentity = null;
    manager.resetBindingDiscovery();
    const probesAfterReset = harness.pushes.filter(
      (push) => push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
    );
    expect((probesAfterReset.at(-1)?.payload as { channels?: unknown }).channels).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    const probesAfterRetry = harness.pushes.filter(
      (push) => push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
    );
    expect(probesAfterRetry.length).toBeGreaterThan(probesAfterReset.length);
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: null,
      reason: 'missing-binding',
    });
    manager.stop();
  });

  it('accepts a peer binding probe even when its remote clock moved backwards', () => {
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
    const probe = harness.pushes.find((push) => push.peerDeviceId === 'a')?.payload as {
      nonce?: string;
    };
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 100,
        channels: [],
        inReplyTo: probe?.nonce,
      },
    });
    expect(manager.getDecision().state).toBe('active');

    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'probe',
        sentAt: 10,
        nonce: 'round-peer-00000',
        channels: [{ channel: 'discord', identity }],
      },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'peer-won',
    });
  });

  it('keeps overlapping snapshot responses isolated by request id', () => {
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: (() => {
        let count = 0;
        return () => `nonce-${String(++count).padStart(14, '0')}`;
      })(),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 10 },
    });
    harness.emit({ type: 'peer-presence', deviceId: 'a', platform: 'win32', online: true });
    const first = harness.snapshotRequests.at(-1);
    harness.emit({ type: 'peer-presence', deviceId: 'b', platform: 'win32', online: true });
    const second = harness.snapshotRequests.at(-1);
    expect(first?.requestId).not.toBe(second?.requestId);

    harness.emit({
      type: 'snapshot',
      accountGeneration: first?.accountGeneration,
      requestId: first?.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 11 },
    });
    expect(manager.getDecision().reason).toBe('missing-snapshot');

    harness.emit({
      type: 'snapshot',
      accountGeneration: second?.accountGeneration,
      requestId: second?.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 5 },
    });
    expect(manager.getDecision().state).toBe('active');
  });
});
