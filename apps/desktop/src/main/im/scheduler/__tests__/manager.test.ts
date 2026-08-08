import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImSchedulerManager } from '../manager';
import type { SchedulerTransport, SchedulerTransportEvent } from '../transport';

const identity = '12345678901234567';
const nextIdentity = '12345678901234568';
const peerBindingGeneration = 'peer-binding-0001';
const oldLocalBindingGeneration = 'local-binding-old1';
const nextLocalBindingGeneration = 'local-binding-next';
const currentLocalBindingGeneration = 'local-binding-current';

function sequenceFactory(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function dirtyGap(runtimeIdentity: string, generation: string, bindingGeneration: string) {
  return {
    identity: runtimeIdentity,
    bindingGeneration,
    generation,
    state: 'dirty' as const,
  };
}

function normalizeSchedulerPush(
  event: SchedulerTransportEvent,
  pushes: Array<{ peerDeviceId: string; payload: unknown }>,
): SchedulerTransportEvent {
  if (event.type !== 'push' || !event.payload || typeof event.payload !== 'object') return event;
  const payload = event.payload as Record<string, unknown>;
  const latestLocalBindingGeneration = [...pushes]
    .reverse()
    .map((push) => push.payload)
    .find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        (candidate as { kind?: unknown }).kind === 'probe',
    ) as { channels?: Array<{ bindingGeneration?: string }> } | undefined;
  const recipientBindingGeneration =
    latestLocalBindingGeneration?.channels?.[0]?.bindingGeneration ?? 'local-binding-0001';
  const bindRuntime = (runtime: unknown): unknown =>
    runtime && typeof runtime === 'object'
      ? { bindingGeneration: recipientBindingGeneration, ...runtime }
      : runtime;
  const channels = Array.isArray(payload.channels)
    ? payload.channels.map((channel) =>
        channel && typeof channel === 'object'
          ? { bindingGeneration: peerBindingGeneration, ...channel }
          : channel,
      )
    : payload.channels;
  return {
    ...event,
    payload: {
      ...payload,
      channels,
      ...(payload.runtime === undefined ? {} : { runtime: bindRuntime(payload.runtime) }),
      ...(Array.isArray(payload.runtimeGaps)
        ? { runtimeGaps: payload.runtimeGaps.map(bindRuntime) }
        : {}),
    },
  };
}

function createTransport(
  overrides: Partial<{
    status: 'online' | 'offline';
    owner: boolean;
    requestSnapshot: SchedulerTransport['requestSnapshot'];
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
    requestSnapshot:
      overrides.requestSnapshot ??
      ((accountGeneration, requestId) => {
        snapshotRequests.push({ accountGeneration, requestId });
      }),
  };
  return {
    transport,
    pushes,
    snapshotRequests,
    emit(event: SchedulerTransportEvent) {
      listener?.(normalizeSchedulerPush(event, pushes));
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

  it('rejects an untagged snapshot from before a relay disconnect', async () => {
    vi.useFakeTimers();
    let status: 'online' | 'offline' = 'online';
    const harness = createTransport();
    harness.transport.getStatus = () => status;
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
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 },
    });
    expect(manager.getDecision().state).toBe('active');

    status = 'offline';
    harness.emit({ type: 'relay-status', status: 'offline' });
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 2 },
    });
    status = 'online';
    harness.emit({ type: 'relay-status', status: 'online' });
    expect(manager.getDecision().reason).toBe('missing-snapshot');

    await vi.advanceTimersByTimeAsync(100);
    const request = harness.snapshotRequests.at(-1);
    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 },
    });
    expect(manager.getDecision().state).toBe('active');
    manager.stop();
  });

  it('refreshes the authoritative snapshot after relay recovery', () => {
    let status: 'online' | 'offline' = 'online';
    const harness = createTransport();
    harness.transport.getStatus = () => status;
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
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 },
    });
    expect(manager.getDecision().state).toBe('active');

    status = 'offline';
    harness.emit({ type: 'relay-status', status: 'offline' });
    status = 'online';
    harness.emit({ type: 'relay-status', status: 'online' });
    const request = harness.snapshotRequests.at(-1);
    expect(request).toBeTruthy();

    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: {
        selfDeviceId: 'z',
        peers: [{ deviceId: 'a', platform: 'win32' }],
        observedAt: 2,
      },
    });
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');
    manager.stop();
  });

  it('refreshes the peer snapshot while the local Discord binding is absent', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => null,
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: null,
      reason: 'missing-binding',
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.snapshotRequests).toHaveLength(1);
    manager.stop();
  });

  it('keeps bounded recovery alive when requestSnapshot throws synchronously', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const harness = createTransport({
      requestSnapshot: () => {
        attempts += 1;
        throw new Error('snapshot request failed');
      },
    });
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(1);
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'missing-snapshot',
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBeGreaterThan(1);
    manager.stop();
  });

  it('consumes a rejected requestSnapshot promise and keeps retrying', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const harness = createTransport({
      requestSnapshot: () => {
        attempts += 1;
        return Promise.reject(new Error('snapshot request rejected'));
      },
    });
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(manager.getDecision().reason).toBe('missing-snapshot');

    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBeGreaterThan(1);
    manager.stop();
  });

  it('does not let an older request rejection clear a newer account request', async () => {
    vi.useFakeTimers();
    const requests: Array<{
      accountGeneration: string;
      requestId: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];
    const harness = createTransport({
      requestSnapshot: (accountGeneration, requestId) =>
        new Promise<void>((resolve, reject) => {
          requests.push({ accountGeneration, requestId, resolve, reject });
        }),
    });
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
    await vi.advanceTimersByTimeAsync(100);
    expect(requests).toHaveLength(1);

    manager.resetAccountDiscovery();
    expect(requests).toHaveLength(2);
    requests[0].reject(new Error('stale snapshot request rejected'));
    await Promise.resolve();

    requests[1].resolve();
    harness.emit({
      type: 'snapshot',
      accountGeneration: requests[1].accountGeneration,
      requestId: requests[1].requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 2 },
    });
    expect(manager.getDecision().state).toBe('active');
    manager.stop();
  });

  it('does not clear a synchronously delivered snapshot after requestSnapshot returns', async () => {
    vi.useFakeTimers();
    const harness = createTransport({
      requestSnapshot: (accountGeneration, requestId) => {
        // The callback is invoked only after createTransport has returned.
        transportHarness.emit({
          type: 'snapshot',
          accountGeneration,
          requestId,
          snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 },
        });
      },
    });
    const transportHarness = harness;
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(manager.getDecision()).toEqual({
      state: 'active',
      channel: { channel: 'discord', identity },
      reason: 'elected',
    });
    manager.stop();
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
    expect(manager.getDecision().reason).toBe('missing-snapshot');
    const request = harness.snapshotRequests.at(-1);
    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 2 },
    });
    expect(manager.getDecision().reason).toBe('elected');
  });

  it('does not re-adopt a runtime gap from a probe delayed across a binding reset', () => {
    let localIdentity = identity;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity: localIdentity }),
      nonceFactory: () => 'round-000000000000',
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    manager.getRuntimeGaps().adopt(dirtyGap(identity, 'a'.repeat(32), oldLocalBindingGeneration));

    localIdentity = nextIdentity;
    manager.resetBindingDiscovery();
    expect(manager.getRuntimeGaps().values()).toEqual([]);

    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'probe',
        sentAt: 2,
        nonce: 'round-peer-00000',
        channels: [{ channel: 'discord', identity }],
        runtimeGaps: [{ identity, generation: 'a'.repeat(32), state: 'dirty' }],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([]);
  });

  it('allows a same-identity token refresh to adopt a new runtime gap', () => {
    let round = 0;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => `round-${String(++round).padStart(14, '0')}`,
      bindingGenerationFactory: sequenceFactory(
        oldLocalBindingGeneration,
        currentLocalBindingGeneration,
      ),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    const oldGap = dirtyGap(identity, 'a'.repeat(32), oldLocalBindingGeneration);
    manager.getRuntimeGaps().adopt(oldGap);

    manager.resetBindingDiscovery();
    expect(manager.getRuntimeGaps().values()).toEqual([]);
    const probe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    const refreshedGap = dirtyGap(identity, 'b'.repeat(32), currentLocalBindingGeneration);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 2,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [oldGap],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([]);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 3,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [refreshedGap],
      },
    });

    expect(manager.getRuntimeGaps().values()).toEqual([refreshedGap]);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 4,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [oldGap],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([refreshedGap]);
    manager.stop();
  });

  it('keeps the binding barrier after more stale gaps than the wire limit', () => {
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      bindingGenerationFactory: sequenceFactory(
        oldLocalBindingGeneration,
        currentLocalBindingGeneration,
      ),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    manager.resetBindingDiscovery();
    const probe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };

    for (let index = 0; index < 9; index += 1) {
      harness.emit({
        type: 'push',
        sourceDeviceId: 'a',
        payload: {
          kind: 'advertisement',
          sentAt: index + 2,
          channels: [{ channel: 'discord', identity }],
          inReplyTo: probe?.nonce,
          runtimeGaps: [
            dirtyGap(identity, index.toString(16).repeat(32), oldLocalBindingGeneration),
          ],
        },
      });
    }
    expect(manager.getRuntimeGaps().values()).toEqual([]);

    const currentGap = dirtyGap(identity, 'f'.repeat(32), currentLocalBindingGeneration);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 20,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [currentGap],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([currentGap]);
    manager.stop();
  });

  it('continues bounded discovery after a synchronous final snapshot with unresolved peers', async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const harness = createTransport({
      requestSnapshot: (accountGeneration, requestId) => {
        requestCount += 1;
        harness.emit({
          type: 'snapshot',
          accountGeneration,
          requestId,
          snapshot: {
            selfDeviceId: 'z',
            peers: [{ deviceId: 'a', platform: 'win32' }],
            observedAt: requestCount + 1,
          },
        });
      },
    });
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: (() => {
        let count = 0;
        return () => `round-${String(++count).padStart(14, '0')}`;
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
    expect(requestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(requestCount).toBe(2);
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');
    manager.stop();
  });

  it('rejects an unseen old generation observed only in a prior peer advertisement', () => {
    let localIdentity = identity;
    let round = 0;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity: localIdentity }),
      nonceFactory: () => `round-${String(++round).padStart(14, '0')}`,
      bindingGenerationFactory: sequenceFactory(
        oldLocalBindingGeneration,
        nextLocalBindingGeneration,
        currentLocalBindingGeneration,
      ),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    const oldGap = dirtyGap(identity, 'a'.repeat(32), oldLocalBindingGeneration);
    localIdentity = nextIdentity;
    manager.resetBindingDiscovery();
    let probe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 2,
        channels: [{ channel: 'discord', identity: nextIdentity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [oldGap],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([]);

    localIdentity = identity;
    manager.resetBindingDiscovery();
    probe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    const refreshedGap = dirtyGap(identity, 'b'.repeat(32), currentLocalBindingGeneration);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 3,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [oldGap],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([]);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 4,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [refreshedGap],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([refreshedGap]);
    manager.stop();
  });

  it('allows a same-identity rebind while rejecting the previous binding generation', () => {
    let localIdentity: string | null = identity;
    let round = 0;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () =>
        localIdentity ? { channel: 'discord', identity: localIdentity } : null,
      nonceFactory: () => `round-${String(++round).padStart(14, '0')}`,
      bindingGenerationFactory: sequenceFactory(
        oldLocalBindingGeneration,
        nextLocalBindingGeneration,
        currentLocalBindingGeneration,
      ),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    const oldGap = dirtyGap(identity, 'a'.repeat(32), oldLocalBindingGeneration);
    manager.getRuntimeGaps().adopt(oldGap);

    localIdentity = null;
    manager.resetBindingDiscovery();
    expect(manager.getRuntimeGaps().values()).toEqual([]);

    localIdentity = identity;
    manager.resetBindingDiscovery();
    const probe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    const refreshedGap = dirtyGap(identity, 'b'.repeat(32), currentLocalBindingGeneration);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 2,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [oldGap],
      },
    });

    expect(manager.getRuntimeGaps().values()).toEqual([]);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 3,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [refreshedGap],
      },
    });

    expect(manager.getRuntimeGaps().values()).toEqual([refreshedGap]);
    manager.stop();
  });

  it('allows a same-identity account reset to adopt a new runtime gap', () => {
    let round = 0;
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => `round-${String(++round).padStart(14, '0')}`,
      bindingGenerationFactory: sequenceFactory(
        oldLocalBindingGeneration,
        currentLocalBindingGeneration,
      ),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 1 },
    });
    manager.getRuntimeGaps().adopt({
      identity,
      bindingGeneration: oldLocalBindingGeneration,
      generation: 'a'.repeat(32),
      state: 'dirty',
    });

    manager.resetAccountDiscovery();
    const request = harness.snapshotRequests.at(-1);
    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: {
        selfDeviceId: 'z',
        peers: [{ deviceId: 'a', platform: 'win32' }],
        observedAt: 2,
      },
    });
    const probe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    const refreshedGap = dirtyGap(identity, 'b'.repeat(32), currentLocalBindingGeneration);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 3,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: probe?.nonce,
        runtimeGaps: [refreshedGap],
      },
    });

    expect(manager.getRuntimeGaps().values()).toEqual([refreshedGap]);
    manager.stop();
  });

  it('keeps rejecting untagged snapshots after a tagged recovery response', () => {
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

    owner.value = true;
    harness.emit({ type: 'ownership', owner: true });
    const request = harness.snapshotRequests.at(-1);
    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: {
        selfDeviceId: 'z',
        peers: [{ deviceId: 'a', platform: 'win32' }],
        observedAt: 2,
      },
    });
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');

    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 100 },
    });
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');
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

  it('retries when an authoritative snapshot names a different self device', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'other', peers: [], observedAt: 1 },
    });
    expect(manager.getDecision().reason).toBe('missing-snapshot');

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.snapshotRequests).toHaveLength(1);
    manager.stop();
  });

  it('retries a lost discovery probe and starts a fresh round after the bound', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      snapshotResponseTimeoutMs: 100,
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

  it('clamps a zero discovery retry limit to one recovery attempt', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      maxDiscoveryRetries: 0,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.snapshotRequests).toHaveLength(1);
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');
    manager.stop();
  });

  it('restarts discovery instead of applying a late peer probe', () => {
    const harness = createTransport();
    let round = 0;
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => `round-${String(++round).padStart(14, '0')}`,
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
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');

    const refreshedProbe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    expect(refreshedProbe.nonce).not.toBe(probe?.nonce);
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 4,
        channels: [],
        inReplyTo: refreshedProbe.nonce,
      },
    });
    expect(manager.getDecision()).toEqual({
      state: 'active',
      channel: { channel: 'discord', identity },
      reason: 'elected',
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
      bindingGenerationFactory: sequenceFactory(
        oldLocalBindingGeneration,
        currentLocalBindingGeneration,
      ),
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    manager.getRuntimeGaps().adopt(dirtyGap(identity, 'a'.repeat(32), oldLocalBindingGeneration));

    localIdentity = nextIdentity;
    manager.resetBindingDiscovery();
    const latestProbe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { channels?: Array<{ identity: string }>; nonce?: string } | undefined;
    expect(latestProbe?.channels).toEqual([
      {
        channel: 'discord',
        identity: nextIdentity,
        bindingGeneration: currentLocalBindingGeneration,
      },
    ]);
    expect(manager.getRuntimeGaps().values()).toEqual([]);

    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 2,
        channels: [{ channel: 'discord', identity: nextIdentity }],
        inReplyTo: latestProbe?.nonce,
        runtimeGaps: [
          dirtyGap(identity, 'a'.repeat(32), oldLocalBindingGeneration),
          dirtyGap(nextIdentity, 'b'.repeat(32), currentLocalBindingGeneration),
        ],
      },
    });
    expect(manager.getRuntimeGaps().values()).toEqual([
      dirtyGap(nextIdentity, 'b'.repeat(32), currentLocalBindingGeneration),
    ]);

    manager
      .getRuntimeGaps()
      .adopt(dirtyGap(nextIdentity, 'b'.repeat(32), currentLocalBindingGeneration));
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
    manager.getRuntimeGaps().adopt(dirtyGap(identity, 'a'.repeat(32), oldLocalBindingGeneration));

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
      snapshotResponseTimeoutMs: 100,
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

  it('retries after a final refresh returns an empty authoritative snapshot', async () => {
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
      snapshotResponseTimeoutMs: 500,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    await vi.advanceTimersByTimeAsync(100);
    const request = harness.snapshotRequests.at(-1);
    expect(request).toBeTruthy();
    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: null,
    });
    expect(manager.getDecision().reason).toBe('missing-snapshot');

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.snapshotRequests.length).toBeGreaterThan(1);
    manager.stop();
  });

  it('accepts a slow final snapshot response before its independent timeout', async () => {
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
      snapshotResponseTimeoutMs: 300,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });

    await vi.advanceTimersByTimeAsync(250);
    const request = harness.snapshotRequests.at(-1);
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');
    harness.emit({
      type: 'snapshot',
      accountGeneration: request?.accountGeneration,
      requestId: request?.requestId,
      snapshot: { selfDeviceId: 'z', peers: [], observedAt: 2 },
    });
    expect(manager.getDecision().state).toBe('active');
    manager.stop();
  });

  it('continues discovery when one peer probe send throws', async () => {
    vi.useFakeTimers();
    const harness = createTransport();
    const sendPush = harness.transport.sendPush;
    harness.transport.sendPush = (peerDeviceId, payload) => {
      if (peerDeviceId === 'a') throw new Error('peer queue closed');
      sendPush(peerDeviceId, payload);
    };
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => 'round-000000000000',
      discoveryRetryDelayMs: 100,
      snapshotResponseTimeoutMs: 300,
      maxDiscoveryRetries: 1,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: {
        selfDeviceId: 'z',
        peers: [
          { deviceId: 'a', platform: 'win32' },
          { deviceId: 'b', platform: 'darwin' },
        ],
        observedAt: 1,
      },
    });
    expect(
      harness.pushes.filter(
        (push) =>
          push.peerDeviceId === 'b' && (push.payload as { kind?: unknown }).kind === 'probe',
      ),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.snapshotRequests).toHaveLength(1);
    expect(
      harness.pushes.filter(
        (push) =>
          push.peerDeviceId === 'b' && (push.payload as { kind?: unknown }).kind === 'probe',
      ),
    ).toHaveLength(2);
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

  it('restarts discovery for a peer binding change despite remote clock rollback', () => {
    const harness = createTransport();
    let round = 0;
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity }),
      nonceFactory: () => `round-${String(++round).padStart(14, '0')}`,
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
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');

    const refreshedProbe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 11,
        channels: [{ channel: 'discord', identity }],
        inReplyTo: refreshedProbe.nonce,
      },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity },
      reason: 'peer-won',
    });
  });

  it('rejects an older binding advertisement after a newer binding probe', () => {
    const harness = createTransport();
    let round = 0;
    const manager = new ImSchedulerManager({
      transport: harness.transport,
      getLocalChannel: () => ({ channel: 'discord', identity: nextIdentity }),
      nonceFactory: () => `round-${String(++round).padStart(14, '0')}`,
    });
    manager.start();
    harness.emit({
      type: 'snapshot',
      snapshot: { selfDeviceId: 'z', peers: [{ deviceId: 'a', platform: 'win32' }], observedAt: 1 },
    });
    const probe = harness.pushes.find((push) => push.peerDeviceId === 'a')?.payload as {
      nonce?: string;
    };
    const oldChannel = {
      channel: 'discord' as const,
      identity: nextIdentity,
      bindingGeneration: peerBindingGeneration,
    };
    const newChannel = {
      channel: 'discord' as const,
      identity: nextIdentity,
      bindingGeneration: nextLocalBindingGeneration,
    };

    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'probe',
        sentAt: 3,
        nonce: 'round-peer-00000',
        channels: [newChannel],
      },
    });
    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 4,
        channels: [oldChannel],
        inReplyTo: probe?.nonce,
      },
    });
    expect(manager.getDecision().reason).toBe('incomplete-peer-view');

    const refreshedProbe = [...harness.pushes]
      .reverse()
      .find(
        (push) =>
          push.peerDeviceId === 'a' && (push.payload as { kind?: unknown }).kind === 'probe',
      )?.payload as { nonce?: string };
    expect(refreshedProbe.nonce).not.toBe(probe?.nonce);

    harness.emit({
      type: 'push',
      sourceDeviceId: 'a',
      payload: {
        kind: 'advertisement',
        sentAt: 5,
        channels: [newChannel],
        inReplyTo: refreshedProbe.nonce,
      },
    });
    expect(manager.getDecision()).toEqual({
      state: 'standby',
      channel: { channel: 'discord', identity: nextIdentity },
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
