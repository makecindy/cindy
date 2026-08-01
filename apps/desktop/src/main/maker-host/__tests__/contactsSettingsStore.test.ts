import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ ownerId: 'owner-a' }));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-settings-store-test-'));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `cloud:${harness.ownerId}`,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: harness.ownerId }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tmpDir, harness.ownerId, ...parts),
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

const {
  commitContactsDeviceSyncSettingIntent,
  readContactsDeviceSyncSettingIntent,
  readContactsSettings,
  writeContactsDeviceSyncEnabled,
  writeContactsDeviceSyncSettingIntent,
  writeContactsEnabled,
} = await import('../contacts-settings-store.js');

beforeEach(() => {
  harness.ownerId = 'owner-a';
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('contacts settings store cross-process intent', () => {
  it('keeps the latest device-sync intent isolated by owner', async () => {
    const ownerAIntent = await writeContactsDeviceSyncSettingIntent(true);
    expect(readContactsDeviceSyncSettingIntent()).toEqual(ownerAIntent);

    harness.ownerId = 'owner-b';
    expect(readContactsDeviceSyncSettingIntent()).toBeNull();
    const ownerBIntent = await writeContactsDeviceSyncSettingIntent(false);
    expect(readContactsDeviceSyncSettingIntent()).toEqual(ownerBIntent);

    harness.ownerId = 'owner-a';
    expect(readContactsDeviceSyncSettingIntent()).toEqual(ownerAIntent);
  });

  it('rejects queued writes instead of applying them after an owner switch', async () => {
    const ownerADir = path.join(tmpDir, 'owner-a');
    fs.mkdirSync(ownerADir, { recursive: true });
    const lock = path.join(ownerADir, 'contacts-settings.json.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    const first = writeContactsEnabled(true);
    const second = writeContactsDeviceSyncEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.ownerId = 'owner-b';
    fs.unlinkSync(lock);

    await expect(first).rejects.toThrow(/scope changed/);
    await expect(second).rejects.toThrow(/scope changed/);
    expect(fs.existsSync(path.join(ownerADir, 'contacts-settings.json'))).toBe(false);
  });

  it('keeps intent verification and durable setting write in one critical section', async () => {
    await writeContactsDeviceSyncEnabled(true);
    const ownerADir = path.join(tmpDir, 'owner-a');
    const settingsLock = path.join(ownerADir, 'contacts-settings.json.lock');
    fs.writeFileSync(settingsLock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    const disableIntent = await writeContactsDeviceSyncSettingIntent(false);
    const disabling = commitContactsDeviceSyncSettingIntent(disableIntent);
    const intentLock = path.join(ownerADir, 'contacts-device-sync-setting-intent.v1.json.lock');
    await vi.waitFor(() => expect(fs.existsSync(intentLock)).toBe(true));

    let newerIntentPublished = false;
    const newerIntentPromise = writeContactsDeviceSyncSettingIntent(true).then((intent) => {
      newerIntentPublished = true;
      return intent;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(newerIntentPublished).toBe(false);

    fs.unlinkSync(settingsLock);
    await expect(disabling).resolves.toBe(true);
    const newerIntent = await newerIntentPromise;
    await expect(commitContactsDeviceSyncSettingIntent(newerIntent)).resolves.toBe(true);
    expect(readContactsSettings().deviceSyncEnabled).toBe(true);
  });

  it('commits durable false when the published disable intent becomes unreadable', async () => {
    await writeContactsDeviceSyncEnabled(true);
    const intent = await writeContactsDeviceSyncSettingIntent(false);
    fs.writeFileSync(
      path.join(tmpDir, 'owner-a', 'contacts-device-sync-setting-intent.v1.json'),
      'broken',
      'utf8',
    );

    await expect(commitContactsDeviceSyncSettingIntent(intent)).resolves.toBe(true);
    expect(readContactsSettings().deviceSyncEnabled).toBe(false);
  });
});
