import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => fixture.directory,
  ownerScopedUserDataPath: (name: string) => join(fixture.directory, name),
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
import { readViewerPreferences, writeViewerPreferences } from '../preferences';

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'cindy-idle-preferences-'));
});
afterEach(() => {
  rmSync(fixture.directory, { recursive: true, force: true });
});

// Unit: persisted per-device safety overrides must survive reread without changing legacy toggles.
it('loads legacy toggles, persists a per-computer duration, and removes the default override', async () => {
  const file = join(fixture.directory, 'remote-desktop-viewer.json');
  const key = createHash('sha256').update('computer').digest('hex');
  writeFileSync(file, JSON.stringify({ [key]: { lockOnExit: true, audio: false } }));
  expect(readViewerPreferences('computer')).toMatchObject({
    idleTimeoutMinutes: 5,
    lockOnExit: true,
    audio: false,
  });
  await writeViewerPreferences('computer', { idleTimeoutMinutes: 1 });
  expect(readViewerPreferences('computer').idleTimeoutMinutes).toBe(1);
  expect(readViewerPreferences('other').idleTimeoutMinutes).toBe(5);
  expect(JSON.parse(readFileSync(file, 'utf8'))[key].idleTimeoutMinutes).toBe(1);
  await writeViewerPreferences('computer', { idleTimeoutMinutes: 5 });
  expect(JSON.parse(readFileSync(file, 'utf8'))[key]).not.toHaveProperty('idleTimeoutMinutes');
  expect(readViewerPreferences('computer')).toMatchObject({
    idleTimeoutMinutes: 5,
    lockOnExit: true,
    audio: false,
  });
});
it('preserves never and rejects invalid durations before writing', async () => {
  await writeViewerPreferences('computer', { idleTimeoutMinutes: 0 });
  await expect(writeViewerPreferences('computer', { idleTimeoutMinutes: -1 })).rejects.toThrow(
    'INVALID_REQUEST',
  );
  expect(readViewerPreferences('computer').idleTimeoutMinutes).toBe(0);
});
// Unit: default-on protection must not become a frozen override when another field is saved,
// while an explicit toggle choice is kept even when it equals today's default. The old writer
// dropped values equal to the default, so a later default flip silently overrode them.
it.each([false, true])(
  'defaults protection on and persists explicit toggle choices, including %s',
  async (enabled) => {
    const file = join(fixture.directory, 'remote-desktop-viewer.json');
    expect(readViewerPreferences('computer')).toMatchObject({
      privacyScreen: true,
      lockOnExit: true,
    });
    await writeViewerPreferences('computer', { audio: false });
    expect(Object.values(JSON.parse(readFileSync(file, 'utf8')))).toEqual([{ audio: false }]);
    await writeViewerPreferences('computer', { privacyScreen: enabled, lockOnExit: enabled });
    await writeViewerPreferences('computer', { audio: true });
    expect(Object.values(JSON.parse(readFileSync(file, 'utf8')))).toEqual([
      { audio: true, privacyScreen: enabled, lockOnExit: enabled },
    ]);
    expect(readViewerPreferences('computer')).toMatchObject({
      privacyScreen: enabled,
      lockOnExit: enabled,
    });
    expect(readViewerPreferences('other')).toMatchObject({ privacyScreen: true, lockOnExit: true });
  },
);
