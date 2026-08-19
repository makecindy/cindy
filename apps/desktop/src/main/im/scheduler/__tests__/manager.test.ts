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
  remoteRevocationHandler: null as ((deviceId: string) => void) | null,
  revoked: new Set<string>(),
  hooks: null as {
    isTransportAllowed(identity?: string | null): boolean;
    onConfigurationChanged?: () => void;
  } | null,
  sendPush: vi.fn(),
  fetchDeviceSnapshot: vi.fn(),
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
  onDeviceLinkAccessRevokedByRemote: (handler: (deviceId: string) => void) => {
    harness.remoteRevocationHandler = handler;
    return () => {
      harness.remoteRevocationHandler = null;
    };
  },
  sendDeviceLinkPush: harness.sendPush,
}));

vi.mock('../../../logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../deviceSnapshot', () => ({
  fetchSchedulerDesktopDeviceSnapshot: harness.fetchDeviceSnapshot,
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
  isSchedulerTransportConnecting: ReturnType<typeof vi.fn>;
  closeSchedulerIngress: ReturnType<typeof vi.fn>;
  markSchedulerOfflineGap: ReturnType<typeof vi.fn>;
  onStatusChange: ReturnType<typeof vi.fn>;
  setSchedulerHooks: ReturnType<typeof vi.fn>;
}

function createDiscord(
  identity = '12345678901234567',
  options: { activateOnInit?: boolean } = {},
): FakeDiscord {
  let active = false;
  let connecting = false;
  let status: FakeDiscordStatus = { kind: 'idle' };
  let statusHandler: ((nextStatus: FakeDiscordStatus) => void) | null = null;
  return {
    emitStatus: (nextStatus) => {
      status = nextStatus;
      connecting = nextStatus.kind === 'connecting';
      if (nextStatus.kind === 'error' || nextStatus.kind === 'standby' || nextStatus.kind === 'idle') {
        active = false;
      }
      if (nextStatus.kind === 'connecting') active = false;
      if (nextStatus.kind === 'connected') active = true;
      statusHandler?.(nextStatus);
    },
    getStatus: vi.fn(() => status),
    init: vi.fn(async () => { active = options.activateOnInit !== false; }),
    enterSchedulerStandby: vi.fn(async () => {
      active = false;
      connecting = false;
    }),
    getSchedulerIdentity: vi.fn(() => identity),
    hasPendingSchedulerOfflineNotice: vi.fn(() => false),
    isSchedulerTransportActive: vi.fn(() => active),
    isSchedulerTransportConnecting: vi.fn(() => connecting),
    closeSchedulerIngress: vi.fn(async () => {
      active = false;
      // Closing ingress keeps the REST/client handle alive until the ordered
      // standby drain performs the final destroy.
      connecting = true;
    }),
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
  runtimeGaps?: Array<{
    identity: string;
    generation: string;
    state: 'dirty';
  }>,
): void {
  harness.pushHandler?.(deviceId, {
    kind: 'advertisement',
    sentAt: Date.now(),
    channels,
    ...(runtime ? { runtime } : {}),
    ...(runtimeGaps ? { runtimeGaps } : {}),
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
  harness.remoteRevocationHandler = null;
  harness.revoked.clear();
  harness.hooks = null;
  harness.sendPush.mockReset();
  harness.fetchDeviceSnapshot.mockReset();
  harness.fetchDeviceSnapshot.mockImplementation(async () => ({
    selfDeviceId: harness.selfDeviceId,
    peers: harness.peers.map((peer) => ({
      deviceId: peer.deviceId,
      platform: peer.platform,
    })),
  }));
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

  it('keeps both Desktops in standby until delayed peer presence completes the account snapshot', async () => {
    harness.owner = false;
    harness.peers = [];
    harness.fetchDeviceSnapshot
      .mockResolvedValueOnce({
        selfDeviceId: 'a',
        peers: [{ deviceId: 'z', platform: 'darwin' }],
      })
      .mockResolvedValueOnce({
        selfDeviceId: 'z',
        peers: [{ deviceId: 'a', platform: 'darwin' }],
      });
    const discordA = createDiscord();
    const discordZ = createDiscord();

    harness.selfDeviceId = 'a';
    const managerA = createManager(discordA);
    await managerA.start();
    harness.selfDeviceId = 'z';
    const managerZ = createManager(discordZ);
    await managerZ.start();

    // Both sockets have received hello-ack and the full REST snapshot, but the
    // relay has not delivered either incremental peer presence event yet.
    await vi.advanceTimersByTimeAsync(3_500);
    harness.owner = true;
    harness.selfDeviceId = 'a';
    await managerA.reconcile();
    harness.selfDeviceId = 'z';
    await managerZ.reconcile();

    expect(discordA.init).not.toHaveBeenCalled();
    expect(discordZ.init).not.toHaveBeenCalled();

    await managerA.stop();
    await managerZ.stop();
  });

  it('probes and elects every Desktop from the REST snapshot without incremental presence', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [];
    harness.fetchDeviceSnapshot.mockResolvedValue({
      selfDeviceId: 'z',
      peers: [{ deviceId: 'a', platform: 'darwin' }],
    });
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await vi.waitFor(() => expect(latestProbeNonce('a')).toEqual(expect.any(String)));
    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);
    await manager.stop();
  });

  it('stays fail-closed when the account device snapshot is unavailable', async () => {
    harness.selfDeviceId = 'a';
    harness.fetchDeviceSnapshot.mockRejectedValue(new Error('snapshot unavailable'));
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await vi.advanceTimersByTimeAsync(7_000);
    await manager.reconcile();

    expect(discord.init).not.toHaveBeenCalled();
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);

    await manager.stop();
  });

  it('restarts discovery when an offline presence races the account snapshot', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    let resolveFirstSnapshot!: (snapshot: {
      selfDeviceId: string;
      peers: Array<{ deviceId: string; platform: string }>;
    }) => void;
    let resolveSecondSnapshot!: (snapshot: {
      selfDeviceId: string;
      peers: Array<{ deviceId: string; platform: string }>;
    }) => void;
    harness.fetchDeviceSnapshot
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSnapshot = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecondSnapshot = resolve;
      }));
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    harness.peers = [];
    harness.presenceHandler?.({
      deviceId: 'a',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
    resolveFirstSnapshot({
      selfDeviceId: 'z',
      peers: [{ deviceId: 'a', platform: 'darwin' }],
    });
    await vi.waitFor(() => expect(harness.fetchDeviceSnapshot).toHaveBeenCalledTimes(2));
    expect(discord.init).not.toHaveBeenCalled();

    resolveSecondSnapshot({ selfDeviceId: 'z', peers: [] });
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it('invalidates an in-flight snapshot when an unknown peer reports offline', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [];
    let resolveFirstSnapshot!: (snapshot: {
      selfDeviceId: string;
      peers: Array<{ deviceId: string; platform: string }>;
    }) => void;
    let resolveSecondSnapshot!: (snapshot: {
      selfDeviceId: string;
      peers: Array<{ deviceId: string; platform: string }>;
    }) => void;
    harness.fetchDeviceSnapshot
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSnapshot = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecondSnapshot = resolve;
      }));
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    harness.presenceHandler?.({
      deviceId: 'a',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
    resolveFirstSnapshot({
      selfDeviceId: 'z',
      peers: [{ deviceId: 'a', platform: 'darwin' }],
    });

    await vi.waitFor(() => expect(harness.fetchDeviceSnapshot).toHaveBeenCalledTimes(2));
    resolveSecondSnapshot({ selfDeviceId: 'z', peers: [] });
    await finishDiscovery(manager);

    expect(discord.init).toHaveBeenCalledOnce();
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

    harness.peers = [];
    harness.presenceHandler?.({
      deviceId: 'a',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
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
      [{
        identity: '12345678901234567',
        generation: cleanGeneration,
        state: 'dirty',
      }],
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

    harness.peers = [];
    harness.presenceHandler?.({
      deviceId: 'a',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
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

  it('keeps concurrent dirty generations and resolves only the matching clean generation', async () => {
    harness.owner = false;
    harness.peers = [
      { deviceId: 'a', platform: 'darwin', online: true, lastSeenAt: Date.now() },
      { deviceId: 'b', platform: 'darwin', online: true, lastSeenAt: Date.now() },
    ];
    const lowerGeneration = '1'.repeat(32);
    const higherGeneration = 'e'.repeat(32);

    for (const generations of [
      [higherGeneration, lowerGeneration],
      [lowerGeneration, higherGeneration],
    ]) {
      harness.sendPush.mockClear();
      const manager = createManager(createDiscord());
      await manager.start();
      confirmPeer('a', [], {
        identity: '12345678901234567',
        generation: generations[0],
        state: 'dirty',
      });
      confirmPeer('b', [], {
        identity: '12345678901234567',
        generation: generations[1],
        state: 'dirty',
      });

      harness.presenceHandler?.({
        deviceId: 'a',
        platform: 'darwin',
        online: true,
        lastSeenAt: Date.now(),
      });
      const advertisement = [...harness.sendPush.mock.calls].reverse().find(
        ([target, , payload]) => target === 'a'
          && typeof payload === 'object'
          && payload !== null
          && (payload as { kind?: unknown }).kind === 'advertisement',
      )?.[2] as {
        runtime?: { generation?: string };
        runtimeGaps?: Array<{ identity?: string; generation?: string }>;
      } | undefined;
      expect(advertisement?.runtime?.generation).toBe(lowerGeneration);
      expect(advertisement?.runtimeGaps?.map((gap) => gap.generation)).toEqual([
        lowerGeneration,
        higherGeneration,
      ]);

      confirmPeer('a', [], {
        identity: '12345678901234567',
        generation: lowerGeneration,
        state: 'clean',
      });
      harness.presenceHandler?.({
        deviceId: 'a',
        platform: 'darwin',
        online: true,
        lastSeenAt: Date.now(),
      });
      const afterClean = [...harness.sendPush.mock.calls].reverse().find(
        ([target, , payload]) => target === 'a'
          && typeof payload === 'object'
          && payload !== null
          && (payload as { kind?: unknown }).kind === 'advertisement',
      )?.[2] as {
        runtime?: { generation?: string };
        runtimeGaps?: Array<{ identity?: string; generation?: string }>;
      } | undefined;
      expect(afterClean?.runtime?.generation).toBe(higherGeneration);
      expect(afterClean?.runtimeGaps).toBeUndefined();
      await manager.stop();
    }
  });

  it('advertises dirty runtime gaps for multiple Discord identities without overwriting either one', async () => {
    harness.owner = false;
    harness.peers = [
      { deviceId: 'a', platform: 'darwin', online: true, lastSeenAt: Date.now() },
      { deviceId: 'b', platform: 'win32', online: true, lastSeenAt: Date.now() },
    ];
    const manager = createManager(createDiscord());

    await manager.start();
    confirmPeer(
      'a',
      [],
      undefined,
      [{ identity: '12345678901234567', generation: '1'.repeat(32), state: 'dirty' }],
    );
    confirmPeer(
      'b',
      [],
      undefined,
      [{ identity: '76543210987654321', generation: '2'.repeat(32), state: 'dirty' }],
    );
    harness.presenceHandler?.({
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    });
    const advertisement = [...harness.sendPush.mock.calls].reverse().find(
      ([target, , payload]) => target === 'a'
        && typeof payload === 'object'
        && payload !== null
        && (payload as { kind?: unknown }).kind === 'advertisement',
    )?.[2] as { runtimeGaps?: Array<{ identity?: string; generation?: string }> } | undefined;

    expect(advertisement?.runtimeGaps).toEqual([
      { identity: '12345678901234567', generation: '1'.repeat(32), state: 'dirty' },
      { identity: '76543210987654321', generation: '2'.repeat(32), state: 'dirty' },
    ]);
    await manager.stop();
  });

  it('keeps runtime gap advertisements within the protocol limit deterministically', async () => {
    harness.owner = false;
    harness.peers = Array.from({ length: 9 }, (_, index) => ({
      deviceId: String.fromCharCode('a'.charCodeAt(0) + index),
      platform: 'darwin',
      online: true as const,
      lastSeenAt: Date.now(),
    }));
    const manager = createManager(createDiscord());

    await manager.start();
    for (let index = 0; index < 9; index += 1) {
      confirmPeer(
        String.fromCharCode('a'.charCodeAt(0) + index),
        [],
        undefined,
        [{
          identity: `123456789012345${String(index).padStart(2, '0')}`,
          generation: `${index + 1}`.repeat(32),
          state: 'dirty',
        }],
      );
    }
    harness.presenceHandler?.({
      deviceId: 'i',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    });

    const advertisement = [...harness.sendPush.mock.calls].reverse().find(
      ([target, , payload]) => target === 'i'
        && typeof payload === 'object'
        && payload !== null
        && (payload as { kind?: unknown }).kind === 'advertisement',
    )?.[2] as { runtimeGaps?: Array<{ identity?: string; generation?: string }> } | undefined;

    expect(advertisement?.runtimeGaps).toHaveLength(8);
    expect(advertisement?.runtimeGaps?.map((gap) => gap.generation)).toEqual([
      '1'.repeat(32),
      '2'.repeat(32),
      '3'.repeat(32),
      '4'.repeat(32),
      '5'.repeat(32),
      '6'.repeat(32),
      '7'.repeat(32),
      '8'.repeat(32),
    ]);
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

    expect(discord.closeSchedulerIngress).toHaveBeenCalledOnce();
    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(1);
    expect(discord.enterSchedulerStandby).toHaveBeenCalledWith({ closeIngress: true });
    await manager.stop();
  });

  it('keeps the active runtime when the remote winner disappears during handoff drain', async () => {
    harness.selfDeviceId = 'z';
    const discord = createDiscord();
    let releaseHandoff!: () => void;
    const handoffGate = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    discord.enterSchedulerStandby.mockImplementation(async () => {
      await handoffGate;
      if (!harness.hooks?.isTransportAllowed('12345678901234567')) {
        discord.emitStatus({ kind: 'standby', appId: '12345678901234567' });
      }
    });
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    expect(discord.isSchedulerTransportActive()).toBe(true);

    const peer = {
      deviceId: 'a',
      platform: 'darwin',
      online: true as const,
      lastSeenAt: Date.now(),
    };
    harness.peers = [peer];
    harness.presenceHandler?.(peer);
    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await vi.waitFor(() => expect(discord.enterSchedulerStandby).toHaveBeenCalledOnce());

    harness.sendPush.mockClear();
    harness.peers = [];
    harness.presenceHandler?.({ ...peer, online: false });
    await vi.waitFor(() => {
      expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(true);
    });
    releaseHandoff();
    await manager.reconcile();

    expect(discord.isSchedulerTransportActive()).toBe(true);
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).not.toContainEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({ state: 'clean' }),
      }),
    );
    await manager.stop();
  });

  it('closes ingress immediately when ownership is lost during a handoff drain', async () => {
    harness.selfDeviceId = 'z';
    const discord = createDiscord();
    let releaseHandoff!: () => void;
    const handoffGate = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    discord.enterSchedulerStandby.mockImplementation(async () => {
      await handoffGate;
      discord.emitStatus({ kind: 'standby', appId: '12345678901234567' });
    });
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    harness.presenceHandler?.(harness.peers[0]);
    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await vi.waitFor(() => expect(discord.enterSchedulerStandby).toHaveBeenCalledOnce());

    harness.owner = false;
    harness.ownershipHandler?.(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(discord.closeSchedulerIngress).toHaveBeenCalledOnce();

    releaseHandoff();
    await manager.reconcile();
    await manager.stop();
  });

  it('does not start a second client while the active Gateway is reconnecting', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledTimes(1);

    discord.emitStatus({ kind: 'connecting' });
    await manager.reconcile();

    expect(discord.isSchedulerTransportConnecting()).toBe(true);
    expect(discord.init).toHaveBeenCalledTimes(1);
    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();

    await manager.stop();
  });

  it('withdraws a winner when initial Gateway activation exceeds its timeout', async () => {
    harness.selfDeviceId = 'a';
    const discord = createDiscord();
    let releaseActivation!: () => void;
    let resolveSnapshot!: (snapshot: {
      selfDeviceId: string;
      peers: Array<{ deviceId: string; platform: string }>;
    }) => void;
    harness.fetchDeviceSnapshot.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));
    discord.init.mockImplementation(() => new Promise<void>((resolve) => {
      releaseActivation = resolve;
    }));
    const manager = createManager(discord);

    await manager.start();
    resolveSnapshot({ selfDeviceId: 'a', peers: [] });
    await vi.waitFor(() => expect(discord.init).toHaveBeenCalledOnce());

    vi.advanceTimersByTime(15_000);
    await vi.waitFor(() => expect(discord.enterSchedulerStandby).toHaveBeenCalledWith({ closeIngress: true }));

    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);

    releaseActivation();
    await manager.stop();
  });

  it('keeps the scheduler fail-closed until an in-flight activation settles during stop', async () => {
    harness.selfDeviceId = 'a';
    harness.owner = false;
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
    harness.owner = true;
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

  it('closes a reconnecting Gateway and preserves a dirty runtime on shutdown', async () => {
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

    discord.emitStatus({ kind: 'connecting' });
    await manager.stop({ preserveTransportForDispose: true });
    // Mirrors im.dispose(): the Gateway is already gone before scheduler
    // finishStop() receives the transportDisposed signal.
    discord.emitStatus({ kind: 'idle' });
    await manager.finishStop({ transportDisposed: true });

    expect(discord.enterSchedulerStandby).toHaveBeenCalledOnce();
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual(
      expect.objectContaining({
        kind: 'advertisement',
        runtime: expect.objectContaining({
          identity: '12345678901234567',
          state: 'dirty',
        }),
      }),
    );
  });

  it('does not advertise the previous account runtime after the scheduler restarts', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    let identity = '12345678901234567';
    const discord = createDiscord();
    discord.getSchedulerIdentity.mockImplementation(() => identity);
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('z', [{ channel: 'discord', identity }]);
    await finishDiscovery(manager);
    expect(discord.isSchedulerTransportActive()).toBe(true);

    await manager.stop({ preserveTransportForDispose: true });
    discord.emitStatus({ kind: 'idle' });
    await manager.finishStop({ transportDisposed: true });
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toContainEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({ identity, state: 'clean' }),
      }),
    );

    harness.sendPush.mockClear();
    identity = '76543210987654321';
    await manager.start();

    expect(harness.sendPush).toHaveBeenCalled();
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channels: [{ channel: 'discord', identity: '76543210987654321' }],
        }),
      ]),
    );
    expect(harness.sendPush.mock.calls.map(([, , payload]) => payload)).not.toContainEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({ identity: '12345678901234567' }),
      }),
    );

    await manager.stop();
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

  it('closes ingress immediately when the relay goes offline during a handoff drain', async () => {
    harness.selfDeviceId = 'z';
    const discord = createDiscord();
    let releaseHandoff!: () => void;
    const handoffGate = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    discord.enterSchedulerStandby.mockImplementation(async () => {
      await handoffGate;
      discord.emitStatus({ kind: 'standby', appId: '12345678901234567' });
    });
    const manager = createManager(discord);

    await manager.start();
    await finishDiscovery(manager);
    harness.peers = [{
      deviceId: 'a',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    harness.presenceHandler?.(harness.peers[0]);
    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await vi.waitFor(() => expect(discord.enterSchedulerStandby).toHaveBeenCalledOnce());

    harness.deviceLinkStatus = 'offline';
    harness.statusHandler?.('offline');
    await Promise.resolve();
    await Promise.resolve();
    expect(discord.closeSchedulerIngress).toHaveBeenCalledOnce();

    releaseHandoff();
    await manager.reconcile();
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

  it('rejects a delayed advertisement reply from an older discovery nonce', async () => {
    harness.selfDeviceId = 'z';
    harness.peers = [
      {
        deviceId: 'a',
        platform: 'darwin',
        online: true,
        lastSeenAt: Date.now(),
      },
    ];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    const oldNonce = latestProbeNonce('a');
    confirmPeer('a', []);
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledOnce();

    harness.hooks?.onConfigurationChanged?.();
    const currentNonce = latestProbeNonce('a');
    expect(currentNonce).not.toBe(oldNonce);
    confirmPeer('a', []);
    await finishDiscovery(manager);
    const standbyCalls = discord.enterSchedulerStandby.mock.calls.length;

    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: Date.now() + 60_000,
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      inReplyTo: oldNonce,
    });
    await manager.reconcile();

    expect(discord.enterSchedulerStandby).toHaveBeenCalledTimes(standbyCalls);
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(true);
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

  it('re-probes a restored Desktop retained by the authoritative snapshot', async () => {
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

    harness.revoked.delete('a');
    harness.sendPush.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.sendPush.mock.calls).toContainEqual([
      'a',
      expect.any(String),
      expect.objectContaining({ kind: 'probe' }),
    ]);
    confirmPeer('a', [{ channel: 'discord', identity: '12345678901234567' }]);
    await manager.reconcile();

    expect(discord.enterSchedulerStandby).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it('closes local ingress immediately when an elected peer revokes this Desktop', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [
      {
        deviceId: 'z',
        platform: 'darwin',
        online: true,
        lastSeenAt: Date.now(),
      },
    ];
    const discord = createDiscord();
    const manager = createManager(discord);

    await manager.start();
    confirmPeer('z', [{ channel: 'discord', identity: '12345678901234567' }]);
    await finishDiscovery(manager);
    expect(discord.init).toHaveBeenCalledOnce();

    harness.remoteRevocationHandler?.('z');
    await manager.reconcile();

    expect(discord.closeSchedulerIngress).toHaveBeenCalledOnce();
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);
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

  it('accepts a current-nonce reply after the peer clock rolls back', async () => {
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
    const nonce = latestProbeNonce('a');
    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: 9_999_999_999,
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      inReplyTo: nonce,
    });
    await finishDiscovery(manager);
    const probesBeforeRollback = harness.sendPush.mock.calls.filter(([, , payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as { kind?: unknown }).kind === 'probe'
    )).length;

    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: 1,
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
      inReplyTo: nonce,
    });
    await vi.advanceTimersByTimeAsync(7_900);
    await manager.reconcile();

    const probesAfterRollback = harness.sendPush.mock.calls.filter(([, , payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as { kind?: unknown }).kind === 'probe'
    )).length;
    expect(probesAfterRollback).toBe(probesBeforeRollback);
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

    harness.peers = [];
    harness.presenceHandler?.({
      deviceId: 'z',
      platform: 'darwin',
      online: false,
      lastSeenAt: Date.now(),
    });
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

  it('publishes reconnect withdrawal before waiting for accepted work to drain', async () => {
    harness.selfDeviceId = 'a';
    harness.peers = [{
      deviceId: 'z',
      platform: 'darwin',
      online: true,
      lastSeenAt: Date.now(),
    }];
    const discord = createDiscord();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    discord.enterSchedulerStandby.mockImplementation(async () => {
      await drain;
      discord.emitStatus({ kind: 'standby', appId: 'bot#0000' });
    });
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
    await vi.waitFor(() => expect(discord.enterSchedulerStandby).toHaveBeenCalledWith({ closeIngress: true }));

    const withdrawal = [...harness.sendPush.mock.calls].reverse().find(([, , payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as { kind?: unknown }).kind === 'advertisement'
      && (payload as { channels?: unknown }).channels instanceof Array
      && (payload as { channels: unknown[] }).channels.length === 0
    ))?.[2] as {
      channels?: unknown[];
      runtime?: { identity?: string; state?: string };
    } | undefined;
    expect(withdrawal).toMatchObject({
      channels: [],
      runtime: {
        identity: '12345678901234567',
        state: 'dirty',
      },
    });
    expect(harness.hooks?.isTransportAllowed('12345678901234567')).toBe(false);

    releaseDrain();
    await manager.reconcile();
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
