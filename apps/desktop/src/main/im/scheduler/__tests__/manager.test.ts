import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  owner: true,
  deviceLinkStatus: 'online' as 'online' | 'offline',
  selfDeviceId: 'z' as string | null,
  peers: [] as Array<{
    deviceId: string;
    platform: string;
    online: true;
    lastSeenAt: number;
  }>,
  pushHandler: null as ((sourceDeviceId: string, payload: unknown) => void) | null,
  presenceHandler: null as ((snapshot: {
    deviceId: string;
    platform: string;
    online: boolean;
    lastSeenAt: number;
  }) => void) | null,
  ownershipHandler: null as ((owner: boolean) => void) | null,
  statusHandler: null as ((status: 'online' | 'offline') => void) | null,
  revoked: new Set<string>(),
  hooks: null as {
    isTransportAllowed(identity?: string | null): boolean;
    onConfigurationChanged?: () => void;
  } | null,
  sendPush: vi.fn(),
}));

vi.mock('../../../device-link', () => ({
  getDeviceLinkStatus: () => harness.deviceLinkStatus,
  getSelfDeviceId: () => harness.selfDeviceId,
  isDeviceRevoked: (deviceId: string) => harness.revoked.has(deviceId),
  isDeviceLinkOwner: () => harness.owner,
  listOnlineDesktopDevices: () => harness.peers,
  onDeviceLinkOwnershipChanged: (handler: (owner: boolean) => void) => {
    harness.ownershipHandler = handler;
    return () => { harness.ownershipHandler = null; };
  },
  onDeviceLinkPresenceChanged: (handler: typeof harness.presenceHandler) => {
    harness.presenceHandler = handler;
    return () => { harness.presenceHandler = null; };
  },
  onDeviceLinkPush: (
    _channel: string,
    handler: (sourceDeviceId: string, payload: unknown) => void,
  ) => {
    harness.pushHandler = handler;
    return () => { harness.pushHandler = null; };
  },
  onDeviceLinkStatusChanged: (handler: (status: 'online' | 'offline') => void) => {
    harness.statusHandler = handler;
    return () => { harness.statusHandler = null; };
  },
  sendDeviceLinkPush: harness.sendPush,
}));

vi.mock('../../../logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { ImSchedulerManager } from '../manager';

type FakeDiscordStatus =
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'error'; reason: string }
  | { kind: 'standby'; appId: string }
  | { kind: 'idle' };

interface FakeDiscord {
  emitStatus: (status: FakeDiscordStatus) => void;
  getStatus: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  enterSchedulerStandby: ReturnType<typeof vi.fn>;
  getSchedulerIdentity: ReturnType<typeof vi.fn>;
  hasPendingSchedulerOfflineNotice: ReturnType<typeof vi.fn>;
  isSchedulerTransportActive: ReturnType<typeof vi.fn>;
  markSchedulerOfflineGap: ReturnType<typeof vi.fn>;
  onStatusChange: ReturnType<typeof vi.fn>;
  setSchedulerHooks: ReturnType<typeof vi.fn>;
}

function createDiscord(
  identity = '12345678901234567',
  options: { activateOnInit?: boolean } = {},
): FakeDiscord {
  let active = false;
  let status: FakeDiscordStatus = { kind: 'idle' };
  let statusHandler: ((nextStatus: FakeDiscordStatus) => void) | null = null;
  return {
    emitStatus: (nextStatus) => {
      status = nextStatus;
      if (nextStatus.kind === 'error' || nextStatus.kind === 'standby' || nextStatus.kind === 'idle') {
        active = false;
      }
      statusHandler?.(nextStatus);
    },
    getStatus: vi.fn(() => status),
    init: vi.fn(async () => { active = options.activateOnInit !== false; }),
    enterSchedulerStandby: vi.fn(async () => { active = false; }),
    getSchedulerIdentity: vi.fn(() => identity),
    hasPendingSchedulerOfflineNotice: vi.fn(() => false),
    isSchedulerTransportActive: vi.fn(() => active),
    markSchedulerOfflineGap: vi.fn(),
    onStatusChange: vi.fn((handler) => {
      statusHandler = handler;
      return () => { statusHandler = null; };
    }),
    setSchedulerHooks: vi.fn((hooks) => { harness.hooks = hooks; }),
  };
}

function createManager(discord: FakeDiscord): ImSchedulerManager {
  return new ImSchedulerManager(discord as never);
}

async function finishDiscovery(manager: ImSchedulerManager): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_500);
  await manager.reconcile();
}

function latestProbeNonce(deviceId = 'a'): string {
  const call = [...harness.sendPush.mock.calls].reverse().find(
    ([target, , payload]) => target === deviceId
      && typeof payload === 'object'
      && payload !== null
      && (payload as { kind?: unknown }).kind === 'probe',
  );
  const nonce = (call?.[2] as { nonce?: unknown } | undefined)?.nonce;
  if (typeof nonce !== 'string') throw new Error(`missing scheduler probe for ${deviceId}`);
  return nonce;
}

function confirmPeer(
  deviceId: string,
  channels: Array<{ channel: 'discord'; identity: string }>,
  runtime?: {
    identity: string;
    generation: string;
    state: 'active' | 'dirty' | 'clean';
    predecessor?: string;
  },
): void {
  harness.pushHandler?.(deviceId, {
    kind: 'advertisement',
    sentAt: Date.now(),
    channels,
    ...(runtime ? { runtime } : {}),
    inReplyTo: latestProbeNonce(deviceId),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.owner = true;
  harness.deviceLinkStatus = 'online';
  harness.selfDeviceId = 'z';
  harness.peers = [];
  harness.pushHandler = null;
  harness.presenceHandler = null;
  harness.ownershipHandler = null;
  harness.statusHandler = null;
  harness.revoked.clear();
  harness.hooks = null;
  harness.sendPush.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Discord scheduler manager', () => {
  it('keeps the non-winning Desktop in standby and advertises only Discord', async () => {
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();
    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    expect(harness.sendPush).toHaveBeenCalled();
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual({
      kind: 'advertisement',
      sentAt: expect.any(Number),
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
    });

    await manager.stop();
  });

  it('starts the deterministic winner and lets a standby take over after it goes offline', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await finishDiscovery(manager);
    expect(discord.init).not.toHaveBeenCalled();

    harness.presenceHandler?.({
      deviceId: 'a',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
    harness.peers = [];
    await manager.reconcile();
    expect(discord.init).toHaveBeenCalledTimes(1);

    await manager.stop();
  });

  it('waits for a clean runtime handoff before replacing an online active peer', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);
    const generation = 'b'.repeat(32);

    await manager.start();
    confirmPeer(
      'z',
      [{ channel: 'discord', identity: '12345678901234567' }],
      {
        identity: '12345678901234567',
        generation,
        state: 'active',
      },
    );
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();

    confirmPeer(
      'z',
      [{ channel: 'discord', identity: '12345678901234567' }],
      {
        identity: '12345678901234567',
        generation,
        state: 'clean',
      },
    );
    await manager.reconcile();

    expect(discord.init).toHaveBeenCalledTimes(1);
    expect(discord.markSchedulerOfflineGap).not.toHaveBeenCalled();
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual(
      expect.objectContaining({
        kind: 'advertisement',
        runtime: expect.objectContaining({
          identity: '12345678901234567',
          generation: expect.any(String),
          state: 'active',
        }),
      }),
    );
    await manager.stop();
  });

  it('publishes a dirty generation when activation fails after a clean handoff', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord('12345678901234567', { activateOnInit: false });
    const manager = createManager(discord);
    const cleanGeneration = 'd'.repeat(32);

    await manager.start();
    confirmPeer(
      'z',
      [{ channel: 'discord', identity: '12345678901234567' }],
      {
        identity: '12345678901234567',
        generation: cleanGeneration,
        state: 'active',
      },
    );
    await finishDiscovery(manager);
    expect(discord.init).not.toHaveBeenCalled();

    confirmPeer(
      'z',
      [{ channel: 'discord', identity: '12345678901234567' }],
      {
        identity: '12345678901234567',
        generation: cleanGeneration,
        state: 'clean',
      },
    );
    await manager.reconcile();

    expect(discord.init).toHaveBeenCalledOnce();
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual({
      kind: 'advertisement',
      sentAt: expect.any(Number),
      channels: [],
      runtime: {
        identity: '12345678901234567',
        generation: expect.not.stringMatching(new RegExp(`^${cleanGeneration}$`)),
        state: 'dirty',
      },
    });
    await manager.stop();
  });

  it('replaces a previous local clean runtime when the next handoff activation fails', async () => {
    harness.selfDeviceId = 'z';
    const discord = createDiscord();
    const manager = createManager(discord);
    const peerGeneration = 'f'.repeat(32);

    await manager.start();
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledOnce();

    const peer = {
      deviceId: 'a',
      platform: 'darwin',
      online: true as const,
      lastSeenAt: Date.now(),
    };
    harness.peers = [peer];
    harness.presenceHandler?.(peer);
    confirmPeer(
      'a',
      [{ channel: 'discord', identity: '12345678901234567' }],
      {
        identity: '12345678901234567',
        generation: peerGeneration,
        state: 'active',
      },
    );
    await manager.reconcile();
    expect(discord.enterSchedulerStandby).toHaveBeenCalledOnce();

    discord.init.mockImplementationOnce(async () => undefined);
    confirmPeer(
      'a',
      [],
      {
        identity: '12345678901234567',
        generation: peerGeneration,
        state: 'clean',
      },
    );
    await manager.reconcile();

    expect(discord.init).toHaveBeenCalledTimes(2);
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual({
      kind: 'advertisement',
      sentAt: expect.any(Number),
      channels: [],
      runtime: {
        identity: '12345678901234567',
        generation: expect.not.stringMatching(new RegExp(`^${peerGeneration}$`)),
        state: 'dirty',
      },
    });
    await manager.stop();
  });

  it('inherits an active peer generation after a crash and compensates before takeover', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);
    const generation = 'c'.repeat(32);

    await manager.start();
    confirmPeer(
      'a',
      [{ channel: 'discord', identity: '12345678901234567' }],
      {
        identity: '12345678901234567',
        generation,
        state: 'active',
      },
    );
    await finishDiscovery(manager);
    expect(discord.init).not.toHaveBeenCalled();

    harness.presenceHandler?.({
      deviceId: 'a',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
    harness.peers = [];
    await manager.reconcile();

    expect(discord.markSchedulerOfflineGap).toHaveBeenCalledTimes(1);
    expect(discord.init).toHaveBeenCalledTimes(1);
    harness.peers = [{
      deviceId: 'y',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    harness.presenceHandler?.({
      deviceId: 'y',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    });
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual(
      expect.objectContaining({
        kind: 'advertisement',
        runtime: expect.objectContaining({
          identity: '12345678901234567',
          generation: expect.any(String),
          state: 'active',
          predecessor: generation,
        }),
      }),
    );
    await manager.stop();
  });

  it('stops the active transport immediately when Device Link ownership is lost', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledTimes(1);

    harness.owner = false;
    harness.ownershipHandler?.(false);
    await manager.reconcile();

    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it('keeps the scheduler fail-closed until an in-flight activation settles during stop', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    let releaseActivation!: () => void;
    discord.init.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseActivation = resolve; });
      expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);
    });
    discord.enterSchedulerStandby.mockImplementation(async () => {
      releaseActivation();
    });
    const manager = createManager(discord);

    await manager.start();
    await vi.advanceTimersByTimeAsync(3_500);
    const activation = manager.reconcile();
    await vi.waitFor(() => expect(discord.init).toHaveBeenCalledTimes(1));

    await manager.stop();
    await activation;

    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(1);
    expect(harness.hooks).toBeNull();
  });

  it('preserves the active Gateway for normal dispose while scheduler hooks stay fail-closed', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    expect(discord.isSchedulerTransportActive()).toBe(true);
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];

    await manager.stop({ preserveTransportForDispose: true });

    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);

    discord.emitStatus({ kind: 'idle' });
    await manager.finishStop({ transportDisposed: true });

    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    expect(harness.hooks).toBeNull();
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual(
      expect.objectContaining({
        kind: 'advertisement',
        runtime: expect.objectContaining({
          identity: '12345678901234567',
          state: 'clean',
        }),
      }),
    );
  });

  it('fails closed when Device Link has no stable self device id', async () => {
    harness.selfDeviceId = null;
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);
    await manager.stop();
  });

  it('stops the active transport when the relay goes offline', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledTimes(1);

    harness.deviceLinkStatus = 'offline';
    harness.statusHandler?.('offline');
    await manager.reconcile();

    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it('stays fail-closed when an online legacy peer cannot confirm the scheduler protocol', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    // A legacy Desktop never replies to scheduler probes. It remains an
    // unknown candidate because it may already be running the same Bot.
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();
    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('requires a current probe reply after the local Discord identity changes', async () => {
    harness.selfDeviceId = null;
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('a', []);
    await finishDiscovery(manager);
    expect(discord.init).not.toHaveBeenCalled();

    harness.selfDeviceId = 'z';
    harness.hooks?.onConfigurationChanged?.();
    await manager.reconcile();
    expect(discord.init).not.toHaveBeenCalled();

    // An in-flight advertisement from before the configuration change is not
    // proof that the peer observed the new discovery round.
    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: [],
    });
    await finishDiscovery(manager);
    expect(discord.init).not.toHaveBeenCalled();

    confirmPeer('a', []);
    await manager.reconcile();

    expect(discord.init).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it('does not confirm a new discovery round from a delayed peer probe', async () => {
    harness.selfDeviceId = null;
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('a', []);
    await finishDiscovery(manager);
    expect(discord.init).not.toHaveBeenCalled();

    harness.selfDeviceId = 'z';
    harness.hooks?.onConfigurationChanged?.();
    harness.pushHandler?.('a', {
      kind: 'probe',
      sentAt: Date.now() + 60_000,
      nonce: 'delayed-remote-generation',
      channels: [],
    });
    await finishDiscovery(manager);

    // The probe is answered, but only a reply to our current nonce may
    // authorize election after the local configuration generation changed.
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual(
      expect.objectContaining({
        kind: 'advertisement',
        inReplyTo: 'delayed-remote-generation',
      }),
    );
    expect(discord.init).not.toHaveBeenCalled();

    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await manager.reconcile();
    expect(discord.init).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('retires an active runtime even when the provider transport is already gone', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledOnce();

    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    discord.emitStatus({ kind: 'idle' });
    harness.owner = false;
    harness.ownershipHandler?.(false);
    await manager.reconcile();

    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual(
      expect.objectContaining({
        kind: 'advertisement',
        runtime: expect.objectContaining({
          identity: '12345678901234567',
          state: 'dirty',
        }),
      }),
    );
    await manager.stop();
  });

  it('excludes revoked Desktops from Discord election and scheduler frames', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    harness.revoked.add('a');
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);

    expect(discord.init).toHaveBeenCalledOnce();
    expect(harness.sendPush.mock.calls.some(([target]) => target === 'a')).toBe(false);

    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      runtime: {
        identity: '12345678901234567',
        generation: 'e'.repeat(32),
        state: 'active',
      },
    });
    await manager.reconcile();

    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('re-probes a peer after its advertisement expires despite a wall-clock rollback', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: 9_999_999_999,
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      inReplyTo: latestProbeNonce('a'),
    });
    await finishDiscovery(manager);
    const probesBeforeExpiry = harness.sendPush.mock.calls.filter(([, , payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as { kind?: unknown }).kind === 'probe'
    )).length;

    await vi.advanceTimersByTimeAsync(8_001);
    await manager.reconcile();

    const probesAfterExpiry = harness.sendPush.mock.calls.filter(([, , payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as { kind?: unknown }).kind === 'probe'
    )).length;
    expect(probesAfterExpiry).toBeGreaterThan(probesBeforeExpiry);
    await manager.stop();
  });

  it('invalidates an active lease when the peer starts a new discovery generation', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('a', []);
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledTimes(1);

    harness.pushHandler?.('a', {
      kind: 'probe',
      sentAt: Date.now() + 1,
      nonce: 'remoteconfig1234',
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
    });
    await manager.reconcile();
    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(1);
    expect(discord.enterSchedulerStandby).toHaveBeenCalledWith({ clearRuntimeActiveMarker: true });

    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: 99,
      channels: [],
    });
    await manager.reconcile();
    expect(discord.init).toHaveBeenCalledTimes(1);

    await manager.stop();
  });

  it('withdraws a failed winner until the healthy peer disappears', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord('12345678901234567', { activateOnInit: false });
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('z', [{ channel: 'discord', identity: '12345678901234567' }]);
    await finishDiscovery(manager);

    expect(discord.init).toHaveBeenCalledTimes(1);
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual({
      kind: 'advertisement',
      sentAt: expect.any(Number),
      channels: [],
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await manager.reconcile();
    expect(discord.init).toHaveBeenCalledTimes(1);

    harness.presenceHandler?.({
      deviceId: 'z',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
    harness.peers = [];
    await manager.reconcile();

    expect(discord.init).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('withdraws a winner after a terminal runtime Discord disconnect', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('z', [{ channel: 'discord', identity: '12345678901234567' }]);
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledTimes(1);

    discord.emitStatus({
      kind: 'error',
      reason: 'Discord authentication failed: invalid bot token',
    });
    await manager.reconcile();

    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual({
      kind: 'advertisement',
      sentAt: expect.any(Number),
      channels: [],
      runtime: {
        identity: '12345678901234567',
        generation: expect.any(String),
        state: 'dirty',
      },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await manager.reconcile();
    expect(discord.init).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it('keeps the active winner during a transient Discord reconnect', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    discord.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    discord.emitStatus({ kind: 'connecting' });

    await vi.advanceTimersByTimeAsync(14_999);
    discord.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await vi.advanceTimersByTimeAsync(1);
    await manager.reconcile();

    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(true);
    await manager.stop();
  });

  it('re-arms reconnect grace when a new discovery generation starts mid-reconnect', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    discord.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    discord.emitStatus({ kind: 'connecting' });

    await vi.advanceTimersByTimeAsync(5_000);
    harness.statusHandler?.('online');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_001);
    await manager.reconcile();
    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(1);

    await manager.stop();
  });

  it('withdraws a winner when Discord reconnecting exceeds the grace period', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('z', [{ channel: 'discord', identity: '12345678901234567' }]);
    await finishDiscovery(manager);
    discord.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    discord.emitStatus({ kind: 'connecting' });

    for (let elapsed = 0; elapsed < 14_000; elapsed += 2_000) {
      await vi.advanceTimersByTimeAsync(2_000);
      confirmPeer('z', [{ channel: 'discord', identity: '12345678901234567' }]);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.reconcile();

    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(1);
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual({
      kind: 'advertisement',
      sentAt: expect.any(Number),
      channels: [],
      runtime: {
        identity: '12345678901234567',
        generation: expect.any(String),
        state: 'dirty',
      },
    });
    await manager.stop();
  });
});
