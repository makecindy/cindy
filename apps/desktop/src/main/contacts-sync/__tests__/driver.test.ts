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
    emptyState,
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
      activateDeviceSync: () => harness.emptyState,
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
}));

vi.mock('../../maker-ipc/contacts-ipc.js', () => ({
  broadcastContactsChanged: vi.fn(),
}));

vi.mock('../keyStore.js', () => ({
  contactsSyncKeyStore: {
    getIdentity: () => ({ publicKey: 'own-public', privateKey: 'own-private' }),
    getPeerPublicKey: () => 'peer-public',
    pinPeerPublicKey: () => false,
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
  isContactsSyncWireFrame: () => false,
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
});
