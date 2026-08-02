import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  root: '',
  ownerId: 'owner-a' as string | null,
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: harness.ownerId }),
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(harness.root, 'owners', harness.ownerId ?? 'none', ...parts),
}));

const store = await import('../statusStore.js');

describe('contacts sync cross-process status store', () => {
  beforeEach(() => {
    harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-contacts-sync-status-'));
    harness.ownerId = 'owner-a';
  });

  afterEach(() => {
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it('shares bounded runtime status and sync requests only inside the active owner scope', () => {
    const runtime = {
      available: true,
      enabled: true,
      phase: 'up-to-date' as const,
      onlineDeviceCount: 2,
      errorCode: null,
      lastSyncAt: '2026-08-01T00:00:00.000Z',
      lastSyncDeviceId: 'peer-device',
      lastSyncDeviceName: 'Office Desktop',
      lastRoute: 'relay' as const,
      updatedAt: Date.now(),
    };
    store.writePersistedContactsSyncRuntimeStatus(runtime);
    store.writeContactsSyncRequestToken();
    const ownerARequest = store.readContactsSyncRequestToken();

    expect(store.readPersistedContactsSyncRuntimeStatus()).toEqual(runtime);
    expect(ownerARequest).toMatch(/^[0-9a-f-]{36}$/);
    const ownerAFiles = fs.readdirSync(path.join(harness.root, 'owners', 'owner-a'));
    expect(ownerAFiles.some((name) => name.endsWith('.tmp'))).toBe(false);

    harness.ownerId = 'owner-b';
    expect(store.readPersistedContactsSyncRuntimeStatus()).toBeNull();
    expect(store.readContactsSyncRequestToken()).toBeNull();
    store.writeContactsSyncRequestToken();
    expect(store.readContactsSyncRequestToken()).not.toBe(ownerARequest);

    harness.ownerId = null;
    expect(store.readPersistedContactsSyncRuntimeStatus()).toBeNull();
    expect(store.readContactsSyncRequestToken()).toBeNull();
  });

  it('rejects malformed or oversized runtime status files', () => {
    const file = path.join(
      harness.root,
      'owners',
      'owner-a',
      'contacts-device-sync-runtime.v1.json',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        available: true,
        enabled: true,
        phase: 'up-to-date',
        onlineDeviceCount: 10_001,
        errorCode: null,
        updatedAt: Date.now(),
      }),
      'utf8',
    );

    expect(store.readPersistedContactsSyncRuntimeStatus()).toBeNull();
  });
});
