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
  hooks: null as {
    isTransportAllowed(identity?: string | null): boolean;
    onConfigurationChanged?: () => void;
  } | null,
  sendPush: vi.fn(),
}));

vi.mock('../../../device-link', () => ({
  getDeviceLinkStatus: () => harness.deviceLinkStatus,
  getSelfDeviceId: () => harness.selfDeviceId,
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

interface FakeDiscord {
  init: ReturnType<typeof vi.fn>;
  enterSchedulerStandby: ReturnType<typeof vi.fn>;
  getSchedulerIdentity: ReturnType<typeof vi.fn>;
  isSchedulerTransportActive: ReturnType<typeof vi.fn>;
  setSchedulerHooks: ReturnType<typeof vi.fn>;
}

function createDiscord(identity = '12345678901234567'): FakeDiscord {
  let active = false;
  return {
    init: vi.fn(async () => { active = true; }),
    enterSchedulerStandby: vi.fn(async () => { active = false; }),
    getSchedulerIdentity: vi.fn(() => identity),
    isSchedulerTransportActive: vi.fn(() => active),
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
    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
    });
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();
    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    expect(harness.sendPush).toHaveBeenCalled();
    expect(harness.sendPush.mock.calls[0]?.[2]).toEqual({
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
    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
    });
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

  it('stays fail-closed when an online peer has no fresh Discord advertisement', async () => {
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
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();
    expect(discord.enterSchedulerStandby).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('restarts discovery grace when the local Discord identity changes', async () => {
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
    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: [],
    });
    await finishDiscovery(manager);
    expect(discord.init).not.toHaveBeenCalled();

    harness.selfDeviceId = 'z';
    harness.hooks?.onConfigurationChanged?.();
    await manager.reconcile();
    expect(discord.init).not.toHaveBeenCalled();

    harness.pushHandler?.('a', {
      kind: 'advertisement',
      sentAt: Date.now(),
      channels: [{ channel: 'discord', identity: '12345678901234567' }],
    });
    await finishDiscovery(manager);

    expect(discord.init).not.toHaveBeenCalled();
    await manager.stop();
  });
});
