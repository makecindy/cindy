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
  const wireFrames = [
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
  ];
  return {
    mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
    ownerId: 'owner-a' as string | null,
    settings: new Map<string, boolean>(),
    contactsChangeToken: 'initial-token' as string | null,
    syncRequestToken: 'initial-request' as string | null,
    syncSettingIntent: null as null | { token: string; enabled: boolean },
    nextSyncSettingIntent: 0,
    runtimeStatus: null as null | Record<string, unknown>,
    emptyState,
    syncMaterialized: false,
    activateSync: vi.fn(() => emptyState),
    prepareDatabase: vi.fn(async () => ({ materialized: harness.syncMaterialized })),
    decoderAccept: vi.fn(async (...args: unknown[]) => {
      void args;
      return null;
    }),
    broadcastContactsChanged: vi.fn(),
    wireFrames,
    encodeContactsSyncMessage: vi.fn(async (options?: { signal?: AbortSignal }) => {
      void options;
      return { frames: wireFrames, materialized: false };
    }),
    peerPublicKey: 'peer-public' as string | null,
    prepareKeyStore: vi.fn(async (): Promise<void> => undefined),
    pinPeerPublicKey: vi.fn(async (_: string, publicKey: string) => {
      const firstSeen = harness.peerPublicKey === null;
      harness.peerPublicKey = publicKey;
      return firstSeen;
    }),
    lanStart: vi.fn(),
    lanSend: vi.fn(),
    lanStop: vi.fn(),
    relaySend: vi.fn(),
    keyReset: vi.fn(),
    writeRuntimeStatus: vi.fn((status: Record<string, unknown>) => {
      harness.runtimeStatus = status;
    }),
    writeSyncRequest: vi.fn(() => {
      harness.syncRequestToken = `request-${Date.now()}`;
    }),
    writeDeviceSync: vi.fn(async (enabled: boolean) => {
      if (harness.ownerId) harness.settings.set(harness.ownerId, enabled);
    }),
    commitSettingIntent: vi.fn(async (intent: { token: string; enabled: boolean }) => {
      if (
        harness.syncSettingIntent?.token !== intent.token ||
        harness.syncSettingIntent.enabled !== intent.enabled
      ) {
        return false;
      }
      await harness.writeDeviceSync(intent.enabled);
      return true;
    }),
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
  activeOwnerScopeKey: () => `${harness.mode}:${harness.ownerId ?? 'none'}`,
}));

vi.mock('../../maker-host/maker-contacts-host.js', () => ({
  getDesktopContactsManager: () => ({
    getDbPath: () => '/tmp/test-contacts.db',
    getStore: () => ({
      activateDeviceSync: harness.activateSync,
      readDeviceSyncState: () => harness.emptyState,
      activateDeviceSyncWithResult: () => ({
        state: harness.activateSync(),
        materialized: harness.syncMaterialized,
      }),
      readDeviceSyncStateWithResult: () => ({
        state: harness.emptyState,
        materialized: harness.syncMaterialized,
      }),
      mergeDeviceSyncState: () => false,
    }),
  }),
}));

vi.mock('../../localDb/betterSqliteFactory.js', () => ({
  resolveBetterSqliteModuleEntry: () => '/tmp/better-sqlite3.js',
  resolveBetterSqliteNativeBinding: () => undefined,
}));

vi.mock('../contactsSyncCodecWorkerClient.js', () => ({
  prepareContactsSyncDatabase: harness.prepareDatabase,
}));

vi.mock('../../maker-host/contacts-settings-store.js', () => ({
  readContactsSettings: () => ({
    enabled: false,
    deviceSyncEnabled: harness.ownerId ? (harness.settings.get(harness.ownerId) ?? false) : false,
  }),
  readContactsDeviceSyncSettingIntent: () => harness.syncSettingIntent,
  writeContactsDeviceSyncSettingIntent: vi.fn(async (enabled: boolean) => {
    const intent = { token: `intent-${++harness.nextSyncSettingIntent}`, enabled };
    harness.syncSettingIntent = intent;
    return intent;
  }),
  commitContactsDeviceSyncSettingIntent: harness.commitSettingIntent,
}));

vi.mock('../../maker-host/contacts-change-events.js', () => ({
  onLocalContactsChanged: () => vi.fn(),
  readContactsChangeToken: () => harness.contactsChangeToken,
}));

vi.mock('../../maker-host/contacts-change-broadcast.js', () => ({
  broadcastContactsChanged: harness.broadcastContactsChanged,
}));

vi.mock('../keyStore.js', () => ({
  contactsSyncKeyStore: {
    prepare: harness.prepareKeyStore,
    getIdentity: () => ({ publicKey: 'own-public', privateKey: 'own-private' }),
    getPeerPublicKey: () => harness.peerPublicKey,
    pinPeerPublicKey: harness.pinPeerPublicKey,
    resetMemory: harness.keyReset,
  },
}));

vi.mock('../lanTransport.js', () => ({
  LanContactsSyncTransport: class {
    start(): void {
      harness.lanStart();
    }
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
  encodeContactsSyncDatabaseState: harness.encodeContactsSyncMessage,
  isContactsSyncWireFrame: (raw: unknown) =>
    typeof raw === 'object' && raw !== null && 'type' in raw,
  ContactsSyncWireDecoder: class {
    async accept(...args: unknown[]): Promise<null> {
      return harness.decoderAccept(...args);
    }
    reset(): void {}
  },
}));

vi.mock('../statusStore.js', () => ({
  readContactsSyncRequestToken: () => harness.syncRequestToken,
  readPersistedContactsSyncStatus: () => ({
    lastSyncAt: null,
    lastSyncDeviceId: null,
    lastSyncDeviceName: null,
    lastRoute: null,
  }),
  readPersistedContactsSyncRuntimeStatus: () => harness.runtimeStatus,
  writeContactsSyncRequestToken: harness.writeSyncRequest,
  writePersistedContactsSyncStatus: vi.fn(),
  writePersistedContactsSyncRuntimeStatus: harness.writeRuntimeStatus,
}));

const driver = await import('../driver.js');

beforeEach(() => {
  harness.mode = 'cloud';
  harness.ownerId = 'owner-a';
  harness.settings.clear();
  harness.contactsChangeToken = 'initial-token';
  harness.syncRequestToken = 'initial-request';
  harness.syncSettingIntent = null;
  harness.nextSyncSettingIntent = 0;
  harness.runtimeStatus = null;
  harness.syncMaterialized = false;
  harness.activateSync.mockClear();
  harness.prepareDatabase.mockClear();
  harness.prepareDatabase.mockImplementation(async () => ({
    materialized: harness.syncMaterialized,
  }));
  harness.decoderAccept.mockReset();
  harness.decoderAccept.mockResolvedValue(null);
  harness.broadcastContactsChanged.mockClear();
  harness.encodeContactsSyncMessage.mockReset();
  harness.encodeContactsSyncMessage.mockImplementation(async () => ({
    frames: harness.wireFrames,
    materialized: false,
  }));
  harness.peerPublicKey = 'peer-public';
  harness.pinPeerPublicKey.mockClear();
  harness.prepareKeyStore.mockClear();
  harness.lanStart.mockReset();
  harness.lanSend.mockReset();
  harness.lanStop.mockReset();
  harness.relaySend.mockReset();
  harness.keyReset.mockReset();
  harness.writeRuntimeStatus.mockClear();
  harness.writeSyncRequest.mockClear();
  harness.writeDeviceSync.mockReset();
  harness.writeDeviceSync.mockImplementation(async (enabled: boolean) => {
    if (harness.ownerId) harness.settings.set(harness.ownerId, enabled);
  });
  harness.commitSettingIntent.mockReset();
  harness.commitSettingIntent.mockImplementation(async (intent) => {
    if (
      harness.syncSettingIntent?.token !== intent.token ||
      harness.syncSettingIntent.enabled !== intent.enabled
    ) {
      return false;
    }
    await harness.writeDeviceSync(intent.enabled);
    return true;
  });
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
    driver.setContactsDeviceLinkOwnerActive(true);

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

  it('aborts an old owner codec task when the active account changes', async () => {
    let oldOwnerSignal: AbortSignal | undefined;
    harness.encodeContactsSyncMessage.mockImplementation(
      (options?: { signal?: AbortSignal }) =>
        new Promise<{ frames: typeof harness.wireFrames; materialized: boolean }>((_, reject) => {
          oldOwnerSignal = options?.signal;
          options?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: (deviceId) => deviceId === 'peer-device',
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);

    const enabling = driver.setContactsDeviceSyncEnabled(true);
    await vi.waitFor(() => expect(oldOwnerSignal).toBeDefined());
    harness.ownerId = 'owner-b';
    driver.getContactsDeviceSyncStatus();

    expect(oldOwnerSignal?.aborted).toBe(true);
    await enabling;
    expect(harness.relaySend).not.toHaveBeenCalled();
  });

  it('applies a sync toggle written by another shared-userData instance', async () => {
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);

    harness.settings.set('owner-a', true);
    driver.pollContactsDeviceSyncSettingChange();
    await vi.waitFor(() => {
      expect(harness.prepareDatabase).toHaveBeenCalled();
      expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
        enabled: true,
        phase: 'waiting',
      });
    });

    harness.settings.set('owner-a', false);
    driver.pollContactsDeviceSyncSettingChange();
    expect(harness.lanStop).toHaveBeenCalledTimes(1);
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: false,
      phase: 'off',
    });
  });

  it('notifies renderers when local reconciliation rematerializes a hidden record', async () => {
    harness.syncMaterialized = true;
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);

    await driver.setContactsDeviceSyncEnabled(true);

    expect(harness.broadcastContactsChanged).toHaveBeenCalledWith({ origin: 'remote' });
  });

  it('reads the Device Link holder status in a passive shared-userData instance', () => {
    harness.settings.set('owner-a', true);
    harness.runtimeStatus = {
      available: true,
      enabled: true,
      phase: 'up-to-date',
      onlineDeviceCount: 2,
      errorCode: null,
      lastSyncAt: '2026-08-01T00:00:00.000Z',
      lastSyncDeviceId: 'peer-device',
      lastSyncDeviceName: 'Office Desktop',
      lastRoute: 'relay',
      updatedAt: Date.now(),
    };
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: () => true,
      sendRelayFrame: harness.relaySend,
    });

    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: true,
      phase: 'up-to-date',
      onlineDeviceCount: 2,
      lastSyncDeviceName: 'Office Desktop',
    });
    expect(harness.writeRuntimeStatus).not.toHaveBeenCalled();
    expect(harness.relaySend).not.toHaveBeenCalled();
  });

  it('ignores a stale holder status in a passive instance', () => {
    harness.settings.set('owner-a', true);
    driver.__testing.reset();
    harness.runtimeStatus = {
      available: true,
      enabled: true,
      phase: 'up-to-date',
      onlineDeviceCount: 2,
      errorCode: null,
      lastSyncAt: null,
      lastSyncDeviceId: null,
      lastSyncDeviceName: null,
      lastRoute: null,
      updatedAt: Date.now() - 60_000,
    };

    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: true,
      phase: 'waiting',
      onlineDeviceCount: 0,
    });
  });

  it('pushes holder status changes to passive-instance listeners', () => {
    harness.settings.set('owner-a', true);
    harness.runtimeStatus = {
      available: true,
      enabled: true,
      phase: 'syncing',
      onlineDeviceCount: 1,
      errorCode: null,
      lastSyncAt: null,
      lastSyncDeviceId: null,
      lastSyncDeviceName: null,
      lastRoute: null,
      updatedAt: Date.now(),
    };
    const listener = vi.fn();
    const unsubscribe = driver.onContactsDeviceSyncStatusChanged(listener);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'syncing', onlineDeviceCount: 1 }),
    );
    unsubscribe();
  });

  it('delegates sync-now from a passive instance to the Device Link holder', async () => {
    harness.settings.set('owner-a', true);
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: () => true,
      sendRelayFrame: harness.relaySend,
    });

    await driver.broadcastContactsNow(true);

    expect(harness.writeSyncRequest).toHaveBeenCalledTimes(1);
    expect(harness.relaySend).not.toHaveBeenCalled();
    expect(harness.writeRuntimeStatus).not.toHaveBeenCalled();
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: true,
      phase: 'syncing',
    });
  });

  it('stops publishing and sending after an initialized holder is demoted', async () => {
    harness.settings.set('owner-a', true);
    harness.lanSend.mockResolvedValue(false);
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: () => true,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);
    await vi.waitFor(() =>
      expect(harness.relaySend.mock.calls.some(([, frame]) => frame.type === 'cipher-chunk')).toBe(
        true,
      ),
    );

    driver.setContactsDeviceLinkOwnerActive(false);
    harness.relaySend.mockClear();
    harness.writeRuntimeStatus.mockClear();
    harness.writeSyncRequest.mockClear();
    harness.runtimeStatus = {
      available: true,
      enabled: true,
      phase: 'up-to-date',
      onlineDeviceCount: 1,
      errorCode: null,
      lastSyncAt: '2026-08-01T00:00:00.000Z',
      lastSyncDeviceId: 'peer-device',
      lastSyncDeviceName: 'Peer Desktop',
      lastRoute: 'relay',
      updatedAt: Date.now(),
    };

    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      phase: 'up-to-date',
      onlineDeviceCount: 1,
    });
    await driver.broadcastContactsNow(true);
    expect(harness.writeSyncRequest).toHaveBeenCalledTimes(1);
    expect(harness.relaySend).not.toHaveBeenCalled();
    expect(harness.writeRuntimeStatus).not.toHaveBeenCalled();
  });

  it('times out a delegated sync-now request when no holder consumes it', async () => {
    harness.settings.set('owner-a', true);
    driver.__testing.reset();
    vi.useFakeTimers();
    try {
      await driver.broadcastContactsNow(true);
      expect(driver.getContactsDeviceSyncStatus().phase).toBe('syncing');

      await vi.advanceTimersByTimeAsync(10_001);
      expect(driver.getContactsDeviceSyncStatus().phase).toBe('waiting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let the delegated timeout overwrite a fresh holder syncing status', async () => {
    harness.settings.set('owner-a', true);
    driver.__testing.reset();
    vi.useFakeTimers();
    try {
      await driver.broadcastContactsNow(true);
      await vi.advanceTimersByTimeAsync(9_000);
      harness.runtimeStatus = {
        available: true,
        enabled: true,
        phase: 'syncing',
        onlineDeviceCount: 1,
        errorCode: null,
        lastSyncAt: null,
        lastSyncDeviceId: null,
        lastSyncDeviceName: null,
        lastRoute: null,
        updatedAt: Date.now(),
      };
      expect(driver.getContactsDeviceSyncStatus().phase).toBe('syncing');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(driver.getContactsDeviceSyncStatus().phase).toBe('syncing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('consumes a passive-instance sync-now token in the Device Link holder', async () => {
    harness.settings.set('owner-a', true);
    harness.lanSend.mockResolvedValue(false);
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: (deviceId) => deviceId === 'peer-device',
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);
    await vi.waitFor(() =>
      expect(harness.relaySend.mock.calls.some(([, frame]) => frame.type === 'cipher-chunk')).toBe(
        true,
      ),
    );
    harness.relaySend.mockClear();

    harness.syncRequestToken = 'request-from-passive';
    driver.pollContactsDeviceSyncCrossProcessState();

    await vi.waitFor(() =>
      expect(harness.relaySend.mock.calls.some(([, frame]) => frame.type === 'cipher-chunk')).toBe(
        true,
      ),
    );
  });

  it('stops immediately and stays off when persisting disable is blocked then fails', async () => {
    harness.settings.set('owner-a', true);
    let rejectWrite: ((error: Error) => void) | null = null;
    harness.writeDeviceSync.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);
    await vi.waitFor(() => expect(harness.lanStart).toHaveBeenCalledTimes(1));

    const disabling = driver.setContactsDeviceSyncEnabled(false);
    expect(harness.lanStop).toHaveBeenCalledTimes(1);
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({ enabled: false, phase: 'off' });
    driver.pollContactsDeviceSyncSettingChange();
    expect(driver.getContactsDeviceSyncStatus().enabled).toBe(false);

    const failed = disabling.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(rejectWrite).not.toBeNull());
    rejectWrite!(new Error('disk unavailable'));
    await expect(failed).resolves.toEqual(expect.objectContaining({ message: 'disk unavailable' }));
    driver.pollContactsDeviceSyncSettingChange();
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({ enabled: false, phase: 'error' });

    // 另一实例稍后成功写入 durable false，本机错误态应自动收敛。
    harness.settings.set('owner-a', false);
    driver.pollContactsDeviceSyncSettingChange();
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: false,
      phase: 'off',
      errorCode: null,
    });
  });

  it('does not apply an old owner disable failure to the new owner status', async () => {
    harness.settings.set('owner-a', true);
    let rejectWrite: ((error: Error) => void) | null = null;
    harness.writeDeviceSync.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);

    const disabling = driver.setContactsDeviceSyncEnabled(false);
    const failed = disabling.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(rejectWrite).not.toBeNull());
    harness.ownerId = 'owner-b';
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: false,
      phase: 'off',
      errorCode: null,
    });
    rejectWrite!(new Error('old owner write failed'));
    await expect(failed).resolves.toEqual(
      expect.objectContaining({ message: 'old owner write failed' }),
    );
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({
      enabled: false,
      phase: 'off',
      errorCode: null,
    });
  });

  it('does not let an in-flight enable override a later disable intent', async () => {
    let releasePrepare: (() => void) | null = null;
    harness.prepareKeyStore.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePrepare = resolve;
        }),
    );

    const enabling = driver.setContactsDeviceSyncEnabled(true);
    await vi.waitFor(() => expect(harness.prepareKeyStore).toHaveBeenCalledTimes(1));
    const disabling = driver.setContactsDeviceSyncEnabled(false);
    await disabling;

    expect(releasePrepare).not.toBeNull();
    releasePrepare!();
    await enabling;

    expect(harness.settings.get('owner-a')).toBe(false);
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({ enabled: false, phase: 'off' });
    expect(harness.writeDeviceSync.mock.calls.map(([value]) => value)).toEqual([false]);
  });

  it('does not let another process disable be overwritten by an in-flight enable', async () => {
    let releasePrepare: (() => void) | null = null;
    harness.prepareKeyStore.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePrepare = resolve;
        }),
    );

    const enabling = driver.setContactsDeviceSyncEnabled(true);
    await vi.waitFor(() => expect(harness.prepareKeyStore).toHaveBeenCalledTimes(1));
    harness.syncSettingIntent = { token: 'intent-from-other-process', enabled: false };
    harness.settings.set('owner-a', false);
    releasePrepare!();
    await enabling;

    expect(harness.settings.get('owner-a')).toBe(false);
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({ enabled: false, phase: 'off' });
    expect(harness.writeDeviceSync).not.toHaveBeenCalledWith(true);
  });

  it('releases local disable suppression when a newer cross-process enable wins', async () => {
    harness.settings.set('owner-a', true);
    let releaseCommit: ((committed: boolean) => void) | null = null;
    harness.commitSettingIntent.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = resolve;
        }),
    );
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);

    const disabling = driver.setContactsDeviceSyncEnabled(false);
    await vi.waitFor(() => expect(releaseCommit).not.toBeNull());
    harness.syncSettingIntent = { token: 'newer-enable', enabled: true };
    harness.settings.set('owner-a', true);
    releaseCommit!(false);
    await disabling;

    await vi.waitFor(() =>
      expect(driver.getContactsDeviceSyncStatus()).toMatchObject({ enabled: true }),
    );
  });

  it('stays off and recovers durable false after a crash between disable intent and commit', async () => {
    harness.settings.set('owner-a', true);
    harness.syncSettingIntent = { token: 'pending-disable', enabled: false };
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [],
      isPeerAllowed: () => false,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);

    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({ enabled: false, phase: 'off' });
    expect(harness.relaySend).not.toHaveBeenCalled();
    driver.pollContactsDeviceSyncSettingChange();

    await vi.waitFor(() => expect(harness.settings.get('owner-a')).toBe(false));
    expect(driver.getContactsDeviceSyncStatus()).toMatchObject({ enabled: false, phase: 'off' });
  });

  it('does not answer a key frame after demotion while pinning is in flight', async () => {
    harness.settings.set('owner-a', true);
    harness.peerPublicKey = null;
    let releasePin: ((firstSeen: boolean) => void) | null = null;
    harness.pinPeerPublicKey.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePin = resolve;
        }),
    );
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: (deviceId) => deviceId === 'peer-device',
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);
    await vi.waitFor(() =>
      expect(harness.relaySend.mock.calls.some(([, frame]) => frame.type === 'key')).toBe(true),
    );
    harness.relaySend.mockClear();

    driver.handleIncomingContactsRelayFrame('peer-device', {
      version: 1,
      type: 'key',
      publicKey: 'peer-public',
    });
    await vi.waitFor(() => expect(harness.pinPeerPublicKey).toHaveBeenCalledTimes(1));
    driver.setContactsDeviceLinkOwnerActive(false);
    releasePin!(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.relaySend).not.toHaveBeenCalled();
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
    driver.setContactsDeviceLinkOwnerActive(true);
    const keyFrameCount = () =>
      harness.relaySend.mock.calls.filter(([, frame]) => frame.type === 'key').length;

    await vi.waitFor(() => expect(keyFrameCount()).toBe(1));
    driver.handleIncomingContactsRelayFrame('peer-device', {
      version: 1,
      type: 'key',
      publicKey: 'peer-public',
    });
    await vi.waitFor(() => expect(keyFrameCount()).toBe(2));

    // 对端对响应的回声不能形成 key ping-pong；响应有独立的短节流。
    driver.handleIncomingContactsRelayFrame('peer-device', {
      version: 1,
      type: 'key',
      publicKey: 'peer-public',
    });
    await vi.waitFor(() => expect(keyFrameCount()).toBe(2));
  });

  it('shares one cold database preparation across a max-size 128-chunk transfer', async () => {
    harness.settings.set('owner-a', true);
    let releasePreparation!: (value: { materialized: boolean }) => void;
    harness.prepareDatabase.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreparation = resolve;
        }),
    );
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => [{ deviceId: 'peer-device', deviceName: 'Peer Desktop' }],
      isPeerAllowed: (deviceId) => deviceId === 'peer-device',
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);
    await vi.waitFor(() => expect(harness.prepareDatabase).toHaveBeenCalledTimes(1));

    for (let index = 0; index < 128; index += 1) {
      driver.handleIncomingContactsRelayFrame('peer-device', {
        version: 1,
        type: 'cipher-chunk',
        senderPublicKey: 'peer-public',
        transferId: 'large-transfer',
        index,
        total: 128,
        iv: 'iv',
        tag: 'tag',
        compression: 'gzip',
        data: 'data',
      });
    }
    expect(harness.prepareDatabase).toHaveBeenCalledTimes(1);

    releasePreparation({ materialized: false });
    await vi.waitFor(() => expect(harness.decoderAccept).toHaveBeenCalledTimes(128));
    expect(harness.prepareDatabase).toHaveBeenCalledTimes(1);
  });

  it('serializes database encoding when broadcasting to more peers than the worker queue', async () => {
    harness.settings.set('owner-a', true);
    let activeEncodes = 0;
    let maxActiveEncodes = 0;
    harness.encodeContactsSyncMessage.mockImplementation(async () => {
      activeEncodes += 1;
      maxActiveEncodes = Math.max(maxActiveEncodes, activeEncodes);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeEncodes -= 1;
      return { frames: harness.wireFrames, materialized: false };
    });
    const peers = Array.from({ length: 12 }, (_, index) => ({
      deviceId: `peer-${index}`,
      deviceName: `Peer ${index}`,
    }));
    driver.initContactsDeviceSync({
      getSelfDeviceId: () => 'self-device',
      listOnlineDesktopDevices: () => peers,
      isPeerAllowed: () => true,
      sendRelayFrame: harness.relaySend,
    });
    driver.setContactsDeviceLinkOwnerActive(true);

    await vi.waitFor(() =>
      expect(
        harness.relaySend.mock.calls.filter(([, frame]) => frame.type === 'cipher-chunk'),
      ).toHaveLength(12),
    );
    expect(harness.encodeContactsSyncMessage).toHaveBeenCalledTimes(12);
    expect(maxActiveEncodes).toBe(1);
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
    driver.setContactsDeviceLinkOwnerActive(true);
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
