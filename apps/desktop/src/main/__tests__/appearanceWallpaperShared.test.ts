import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: '', owner: 'a', pending: false }));
vi.mock('electron', () => ({ app: { getPath: () => h.dir } }));
vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: h.owner }),
  isAppSessionBoundaryPending: () => h.pending,
  ownerScopedUserDataPath: (name: string) => path.join(h.dir, h.owner, name),
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (_path: string, _options: unknown, action: Function) =>
    action({ held: true }),
}));
import { customWallpaperStore, readCustomWallpaperUrl } from '../custom-wallpaper-settings';
import {
  readAppearanceSettings,
  resetAppearanceSettings,
  writeAppearanceSettingsPatch,
} from '../appearance-settings-store';

const urlA = `cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`;
const urlB = `cindy-media://client-wallpaper/${'b'.repeat(64)}.webp`;
beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-shared-'));
  h.owner = 'a';
  h.pending = false;
});
afterEach(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('profile-wide wallpaper preference', () => {
  it('keeps old preferences untouched, persists zero visibility, and removes its override on reset', async () => {
    const file = path.join(h.dir, 'appearance-settings.json');
    const original = JSON.stringify({ wallpaperOverlay: 0.35, uiSize: 18 });
    fs.writeFileSync(file, original);
    expect(readAppearanceSettings()).toMatchObject({ wallpaperOverlay: 0.35, uiSize: 18 });
    expect(readAppearanceSettings()).not.toHaveProperty('wallpaperVisibility');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    await writeAppearanceSettingsPatch({ wallpaperVisibility: 0 });
    expect(readAppearanceSettings().wallpaperVisibility).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).wallpaperVisibility).toBe(0);
    await writeAppearanceSettingsPatch({ wallpaperVisibility: 1 });
    expect(readAppearanceSettings().wallpaperVisibility).toBe(1);
    await writeAppearanceSettingsPatch({ wallpaperVisibility: null, wallpaperOverlay: 0.2 });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).not.toHaveProperty('wallpaperVisibility');
    expect(saved).not.toHaveProperty('wallpaperOverlay');
    expect(saved.uiSize).toBe(18);
  });
  it('shares selection, replacement and reset across accounts, including sign-out', async () => {
    await customWallpaperStore.writePatchAtomic({ url: urlA });
    await writeAppearanceSettingsPatch({ wallpaperId: 'custom' });
    for (const owner of ['b', '']) {
      h.owner = owner;
      h.pending = true;
      expect(readAppearanceSettings()).toMatchObject({
        wallpaperId: 'custom',
        customWallpaperUrl: urlA,
      });
    }
    h.owner = 'b';
    h.pending = false;
    await customWallpaperStore.writePatchAtomic({ url: urlB });
    h.owner = 'a';
    expect(readAppearanceSettings()).toMatchObject({
      wallpaperId: 'custom',
      customWallpaperUrl: urlB,
    });
    await resetAppearanceSettings();
    h.owner = 'b';
    expect(readAppearanceSettings()).toMatchObject({
      wallpaperId: 'none',
      customWallpaperUrl: urlB,
    });
    await writeAppearanceSettingsPatch({ wallpaperId: 'cindy-dream' });
    h.owner = 'a';
    expect(readAppearanceSettings().wallpaperId).toBe('cindy-dream');
  });

  it('preserves unreadable shared settings until an explicit reset', async () => {
    const target = path.join(h.dir, 'custom-wallpaper.json');
    fs.writeFileSync(target, '{broken');
    expect(readCustomWallpaperUrl()).toBe('');
    await expect(customWallpaperStore.writePatchAtomic({ url: urlB })).rejects.toThrow(
      'unreadable',
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken');
  });
});
