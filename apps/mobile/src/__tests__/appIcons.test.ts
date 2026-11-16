// Unit: iOS app icon choice (Settings > Appearance), new with the shared icon list.
// Entry points: readAppIconState/applyAppIcon as the settings row calls them, and the
// config plugin's icon set writer as prebuild calls it.
// Gap: nothing else exercises the JavaScript/native version skew or the plugin output.
// Minimal failing inputs: a binary compiled without an icon the JavaScript list has;
// an icon name the binary no longer has; an icon set whose Contents.json names no file.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ICONS, appIconAlternateName } from '@cindy/maker-shared';

const native = vi.hoisted(() => ({
  module: null as null | { getState: () => Promise<unknown>; setIcon: (name: string | null) => Promise<void> },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native.module }));

import { applyAppIcon, readAppIconState } from '@/platform/appIcon';

const require = createRequire(import.meta.url);
const { readAlternateIcons, writeIconSets } = require('../../plugins/with-app-icons.js') as {
  readAlternateIcons: () => Array<{ name: string; light: string; dark: string | null }>;
  writeIconSets: (catalogDir: string, icons: ReturnType<typeof readAlternateIcons>) => void;
};

const alternates = APP_ICONS.map(appIconAlternateName).filter((name): name is string => name !== null);
const state = (overrides: Record<string, unknown>) => ({
  supported: true,
  current: null,
  available: alternates,
  darkArtwork: true,
  ...overrides,
});

afterEach(() => {
  native.module = null;
});

describe('app icon state', () => {
  it('hides the setting without the native module or on devices that cannot switch', async () => {
    expect(await readAppIconState()).toBeNull();
    native.module = { getState: async () => state({ supported: false }), setIcon: vi.fn() };
    expect(await readAppIconState()).toBeNull();
  });

  it('offers only the icons compiled into the installed build', async () => {
    const [kept] = alternates;
    native.module = { getState: async () => state({ available: [kept], current: kept }), setIcon: vi.fn() };
    const result = await readAppIconState();
    expect(result?.icons).toEqual([APP_ICONS[0], APP_ICONS.find((icon) => appIconAlternateName(icon) === kept)]);
    expect(appIconAlternateName(result!.current)).toBe(kept);
  });

  it('reads an icon this version no longer knows as the built-in one', async () => {
    native.module = { getState: async () => state({ current: 'AppIcon-retired' }), setIcon: vi.fn() };
    expect((await readAppIconState())?.current).toBe(APP_ICONS[0]);
  });

  it('restores the built-in icon with null and passes native failures on', async () => {
    const setIcon = vi.fn(async () => undefined);
    native.module = { getState: async () => state({}), setIcon };
    await applyAppIcon(APP_ICONS[0]);
    expect(setIcon).toHaveBeenLastCalledWith(null);
    setIcon.mockRejectedValueOnce(new Error('denied'));
    await expect(applyAppIcon(APP_ICONS[1])).rejects.toThrow('denied');
  });
});

describe('with-app-icons config plugin', () => {
  it('compiles one icon set per shared choice under the name JavaScript asks for', () => {
    const icons = readAlternateIcons();
    // The name is the contract between the shared list and the binary.
    expect(icons.map((icon) => icon.name)).toEqual(alternates);

    const catalog = mkdtempSync(join(tmpdir(), 'cindy-app-icons-'));
    try {
      writeIconSets(catalog, icons);
      expect(readdirSync(catalog).sort()).toEqual(alternates.map((name) => `${name}.appiconset`).sort());
      for (const icon of icons) {
        const setDir = join(catalog, `${icon.name}.appiconset`);
        const { images } = JSON.parse(readFileSync(join(setDir, 'Contents.json'), 'utf8')) as {
          images: Array<{ filename: string; appearances?: Array<{ value: string }> }>;
        };
        expect(images.every((image) => existsSync(join(setDir, image.filename)))).toBe(true);
        expect(images.some((image) => image.appearances?.[0]?.value === 'dark')).toBe(icon.dark !== null);
      }
    } finally {
      rmSync(catalog, { recursive: true, force: true });
    }
  });
});
