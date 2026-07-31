import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const emptyState = {
    version: 1 as const,
    clocks: [],
    contacts: [],
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: [],
  };
  return {
    mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
    ownerId: 'owner-a' as string | null,
    settings: new Map<string, boolean>(),
    contactsChangeToken: 'initial-token' as string | null,
    emptyState,
    activateSync: vi.fn(() => emptyState),
    peerPublicKey: 'peer-public' as string | null,
    pinPeerPublicKey: vi.fn((_: string, publicKey: string) => {
      const firstSeen = harness.peerPublicKey === null;
      harness.peerPublicKey = publicKey;
      return firstSeen;
    }),
    lanSend: vi.fn(),
    lanStop: vi.fn(),
    relaySend: vi.fn(),
    keyReset: vi.fn(),
  };
});

vi.mock('@cindy/maker-core', () => ({
  createContactsSyncDelta: (state: unknown) => state,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: harness.mode, dataOwnerId: harness.ownerId }),
}));

vi.mock('../../maker-host/maker-contacts-host.js', () => ({
  getDesktopContactsManager: () => ({
    getStore: () => ({
      activateDeviceSync: harness.activateSync,
      readDeviceSyncState: () => harness.emptyState,
      mergeDeviceSyncState: () => false,
    }),
  }),
}));

vi.mock('../../maker-host/contacts-settings-store.js', () => ({
  readContactsSettings: () => ({
    enabled: false,
    deviceSyncEnabled: harness.ownerId ? (harness.settings.get(harness.ownerId) ?? false) : false,
  }),
  writeContactsDeviceSyncEnabled: (enabled: boolean) => {
    if (harness.ownerId) harness.settings.set(harness.ownerId, enabled);
  },
}));

vi.mock('../../maker-host/contacts-change-events.js', () => ({
  onLocalContactsChanged: () => vi.fn(),
  readContactsChangeToken: () => harness.contactsChangeToken,
}));

vi.mock('../../maker-host/contacts-change-broadcast.js', () => ({
  broadcastContactsChanged: vi.fn(),
}));

vi.mock('../keyStore.js', () => ({
  contactsSyncKeyStore: {
    getIdentity: () => ({ publicKey: 'own-public', privateKey: 'own-private' }),
    getPeerPublicKey: () => harness.peerPublicKey,
    pinPeerPublicKey: harness.pinPeerPublicKey,
    resetMemory: harness.keyReset,
  },
}));

vi.mock('../lanTransport.js', () => ({
  LanContactsSyncTransport: class {
    start(): void {}
    stop(): void {
      harness.lanStop();
    }
    send(deviceId: string, frame: unknown): Promise<boolean> {
      return harness.lanSend(deviceId, frame);
    }
  },
}));

vi.mock('../wire.js', () => ({
  createContactsSyncKeyFrame: () => ({ version: 1, type: 'key', publicKey: 'own-public' }),
  encodeContactsSyncMessage: () => [
    {
      version: 1,
      type: 'cipher-chunk',
      senderPublicKey: 'own-public',
      transferId: 'transfer',
      index: 0,
      total: 1,
      iv: 'iv',
      tag: 'tag',
      compression: 'gzip',
      data: 'data',
    },
  ],
  isContactsSyncWireFrame: (raw: unknown) =>
    typeof raw === 'object' && raw !== null && 'type' in raw,
  ContactsSyncWireDecoder: class {
    accept(): null {
      return null;
    }
    reset(): void {}
  },
}));

vi.mock('../statusStore.js', () => ({
  readPersistedContactsSyncStatus: () => ({
    lastSyncAt: null,
    lastSyncDeviceId: null,
    lastSyncDeviceName: null,
    lastRoute: null,
  }),
  writePersistedContactsSyncStatus: vi.fn(),
}));

const driver = await import('../driver.js');

beforeEach(() => {
  harness.mode = 'cloud';
  harness.ownerId = 'owner-a';
  harness.settings.clear();
  harness.contactsChangeToken = 'initial-token';
  harness.activateSync.mockClear();
  harness.peerPublicKey = 'peer-public';
  harness.pinPeerPublicKey.mockClear();
  harness.lanSend.mockReset();
  harness.lanStop.mockReset();
  harness.relaySend.mockReset();
  harness.keyReset.mockReset();
  driver.__testing.reset();
});

afterEach(() => {
  driver.__testing.reset();
});

describe('contacts sync runtime ownership', () => {
  it('local mode reports sign-in required and cannot enable device sync', async () => {
    harness.mode = 'local';
    harness.ownerId = 'local-v1';
    driver.__testing.reset();
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => null,
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });

    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      available: false,
      enabled: false,
      phase: 'off',
    });
    await expect(driver.setContactsDeviceSyncEnabled(true)).rejects.toThrow(
      /signed-in cloud account/,
    );
    expect(harness.settings.get('local-v1')).toBeUndefined();
    expect(harness.relaySend).not.toHaveBeenCalled();
  });

  it('does not relay an old owner transfer after the active account changes mid-send', async () => {
    let finishLanSend: ((sent: boolean) => void) | null = null;
    harness.lanSend.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishLanSend = resolve;
        }),
    );
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: (deviceId) => deviceId === 'peer-device',
      sendRelayFrame: harness.relaySend,
    });

    const enabling = driver.setContactsDeviceSyncEnabled(true);
    await vi.waitFor(() => expect(harness.lanSend).toHaveBeenCalledTimes(1));

    harness.ownerId = 'owner-b';
    expect(driver.getContactsDeviceSyncStatus().enabled).toBe(false);
    expect(harness.lanStop).toHaveBeenCalled();

    expect(finishLanSend).not.toBeNull();
    finishLanSend!(false);
    await enabling;

    expect(harness.relaySend).not.toHaveBeenCalled();
    expect(driver.getContactsDeviceSyncStatus().phase).toBe('off');
  });

  it('applies a sync toggle written by another shared-userData instance', () => {
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });

    harness.settings.set('owner-a', true);
    driver.pollContactsDeviceSyncSettingChange();
    expect(harness.activateSync).toHaveBeenCalled();
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: true,
      phase: 'waiting',
    });

    harness.settings.set('owner-a', false);
    driver.pollContactsDeviceSyncSettingChange();
    expect(harness.lanStop).toHaveBeenCalledTimes(1);
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: false,
      phase: 'off',
    });
  });

  it('responds to an incoming key even after a recent proactive announcement', async () => {
    harness.settings.set('owner-a', true);
    harness.peerPublicKey = null;
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: (deviceId) => deviceId === 'peer-device',
      sendRelayFrame: harness.relaySend,
    });
    const keyFrameCount = () =>
      harness.relaySend.mock.calls.filter(([, frame]) => frame.type === 'key').length;

    await vi.waitFor(() => expect(keyFrameCount()).toBe(1));
    driver.handleIncomingContactsRelayFrame('peer-device', {
      version: 1,
      type: 'key',
      publicKey: 'peer-public',
    });
    expect(keyFrameCount()).toBe(2);

    // 对端对响应的回声不能形成 key ping-pong；响应有独立的短节流。
    driver.handleIncomingContactsRelayFrame('peer-device', {
      version: 1,
      type: 'key',
      publicKey: 'peer-public',
    });
    expect(keyFrameCount()).toBe(2);
  });

  it('broadcasts a contact change written by another shared-userData instance', async () => {
    harness.settings.set('owner-a', true);
    harness.lanSend.mockResolvedValue(false);
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: (deviceId) => deviceId === 'peer-device',
      sendRelayFrame: harness.relaySend,
    });
    await vi.waitFor(() =>
      expect(harness.relaySend.mock.calls.some(([, frame]) => frame.type === 'cipher-chunk')).toBe(
        true,
      ),
    );
    harness.relaySend.mockClear();

    harness.contactsChangeToken = 'passive-instance-write';
    driver.pollContactsDeviceSyncDataChange();
    await vi.waitFor(() =>
      expect(harness.relaySend.mock.calls.some(([, frame]) => frame.type === 'cipher-chunk')).toBe(
        true,
      ),
    );

    const sent = harness.relaySend.mock.calls.length;
    driver.pollContactsDeviceSyncDataChange();
    expect(harness.relaySend).toHaveBeenCalledTimes(sent);
  });
});
