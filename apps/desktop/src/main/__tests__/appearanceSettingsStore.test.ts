import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.userData } }));
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.userData } };
});
vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { DEFAULT_APPEARANCE_SETTINGS, normalizeAppearanceSettings } from '../../shared/appearanceSettings';
import {
  readAppearanceSettingsState,
  writeAppearanceSettingsPatch,
  migrateAppearanceThemeSelection,
  appearanceService,
  updateAppearanceSettingsAtomic,
  readSelectedThemeFont,
} from '../appearance-settings-store';
import { inspectCindyFile } from '../cindy-files/reader';
import { installThemePackage } from '../local-themes/packages';
import { getLocalThemesDir } from '../local-themes/loader';
import { appearanceDefinitionToOverrides, appearanceResetPatch } from '../appearance/definition';
import { readClientWallpaperFile } from '../cindy-media/blobStore.desktop';
import { readReferencedClientWallpaperUrls } from '../custom-wallpaper-settings';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { AppearanceService } from '../appearance/service';

describe('terminal appearance overrides', () => {
  beforeEach(() => {
    fixture.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-terminal-appearance-'));
  });
  afterEach(() => fs.rmSync(fixture.userData, { recursive: true, force: true }));

  it('reads old overrides with unchanged values and adds terminal defaults only in memory', () => {
    const oldOverrides = { uiFamily: 'Inter', codeFamily: 'JetBrains Mono', uiSize: 16, codeSize: 18, windowZoom: 1.2 };
    const file = path.join(fixture.userData, 'appearance-settings.json');
    fs.writeFileSync(file, JSON.stringify(oldOverrides));
    const state = readAppearanceSettingsState();
    expect(state.value).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...oldOverrides, customizedKeys: Object.keys(oldOverrides) });
    expect(state.customizedKeys).not.toContain('terminalFamily');
    expect(state.customizedKeys).not.toContain('terminalSize');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(oldOverrides);
  });

  it('persists only terminal overrides and clears each one without changing other preferences', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    const otherOverrides = { uiFamily: 'Inter', codeFamily: 'JetBrains Mono', uiSize: 16, codeSize: 18, windowZoom: 1.2 };
    await writeAppearanceSettingsPatch(otherOverrides);
    await writeAppearanceSettingsPatch({ terminalFamily: '  Menlo  ', terminalSize: 19 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...otherOverrides, terminalFamily: 'Menlo', terminalSize: 19,
    });

    await writeAppearanceSettingsPatch({ terminalFamily: '' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...otherOverrides, terminalSize: 19 });
    expect(readAppearanceSettingsState().value.terminalFamily).toBe('');
    expect(readAppearanceSettingsState().customizedKeys).not.toContain('terminalFamily');

    await writeAppearanceSettingsPatch({ terminalSize: 13 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(otherOverrides);
    expect(readAppearanceSettingsState().value).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...otherOverrides, customizedKeys: Object.keys(otherOverrides) });
  });

  it('does not persist a defaults snapshot when restoring the only terminal override', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    await writeAppearanceSettingsPatch({ terminalSize: 20 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ terminalSize: 20 });
    await writeAppearanceSettingsPatch({ terminalSize: 13 });
    expect(fs.existsSync(file)).toBe(false);
    expect(readAppearanceSettingsState().isCustomized).toBe(false);
  });

  // Upgrade contract: once-only theme adoption must never rewrite old font or
  // wallpaper overrides. Existing tests exercise no renderer selection migration.
  it('adopts the old theme selection atomically and ignores subsequent legacy values', async () => {
    const old = { uiFamily: 'Inter', uiSize: 17, terminalSize: 18, wallpaperId: 'cindy-night-glance', wallpaperVisibility: 0.37 };
    const file = path.join(fixture.userData, 'appearance-settings.json');
    fs.writeFileSync(file, JSON.stringify(old));
    const selection = { mode: 'dark' as const, familyId: 'default' };
    expect((await migrateAppearanceThemeSelection(selection)).themeSelection).toEqual(selection);
    expect((await migrateAppearanceThemeSelection({ mode: 'light', familyId: 'cindy' })).themeSelection).toEqual(selection);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...old, themeSelection: selection });
    expect(readAppearanceSettingsState().value).toMatchObject({ ...old, themeSelection: selection });
  });

  it('preserves unreadable settings and leaves theme migration retryable after a write failure', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    fs.writeFileSync(file, '{broken');
    await expect(migrateAppearanceThemeSelection({ mode: 'dark', familyId: 'default' })).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(readAppearanceSettingsState().value.themeSelection).toBeUndefined();
  });

  // End-to-end Host ownership, unit with real overrides/ZIP: themes supply
  // defaults, fixed writes supply only named overrides, reset follows the theme.
  it('composes theme defaults and fixed writes without freezing inherited values', async () => {
    const zip = new JSZip();
    zip.file('cindy.json', JSON.stringify({ formatVersion: 2, type: 'theme', themes: ['light.json', 'dark.json'],
      resources: [{ id: 'body', kind: 'font', path: 'body.ttf' }, { id: 'bg', kind: 'image', path: 'bg.png' }] }));
    const font = fs.readFileSync(new URL('../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/assets/JetBrainsMono-Regular.ttf', import.meta.url));
    zip.file('body.ttf', font);
    zip.file('bg.png', await sharp({ create: { width: 1, height: 1, channels: 4, background: '#808080' } }).png().toBuffer());
    for (const mode of ['light', 'dark'] as const) zip.file(`${mode}.json`, JSON.stringify({
      id: `paper-${mode}`, family: 'paper', name: 'Paper', type: mode, colors: {},
      appearance: { uiFont: { family: mode === 'light' ? 'Inter' : 'Helvetica', size: 20 },
        bodyFont: { resource: 'asset:body' }, wallpaper: { resource: 'asset:bg', visibility: 0.4 },
        reading: { bodyLineHeight: mode === 'light' ? 1.8 : 1.6, maxWidth: 700 }, density: 0.9, motion: 0.5 },
    }));
    const source = path.join(fixture.userData, 'paper.cindy');
    fs.writeFileSync(source, await zip.generateAsync({ type: 'nodebuffer' }));
    const inspected = await inspectCindyFile(source);
    if (inspected.type !== 'theme') throw new Error('Expected theme');
    await installThemePackage(inspected, getLocalThemesDir());
    await writeAppearanceSettingsPatch({ uiSize: 17, terminalFamily: 'Menlo', wallpaperId: 'cindy-night-glance' });
    await migrateAppearanceThemeSelection({ mode: 'light', familyId: 'paper-local' });
    expect(appearanceService.read()).toMatchObject({ uiFamily: 'Inter', uiSize: 17, terminalFamily: 'Menlo', wallpaperId: 'cindy-night-glance', density: 0.9, motion: 0.5 });
    expect(Buffer.from(readSelectedThemeFont('bodyFont')!.bytes)).toEqual(font);
    await updateAppearanceSettingsAtomic((_current, overrides) => appearanceDefinitionToOverrides(overrides, { reading: { maxWidth: 800 } }));
    const file = path.join(fixture.userData, 'appearance-settings.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).reading).toEqual({ maxWidth: 800 });
    await appearanceService.select({ mode: 'dark', familyId: 'paper-local' });
    expect(appearanceService.read()).toMatchObject({ uiFamily: 'Helvetica', uiSize: 17, reading: { bodyLineHeight: 1.6, maxWidth: 800 } });
    await writeAppearanceSettingsPatch(appearanceResetPatch(['uiFont', 'reading', 'wallpaper']));
    expect(appearanceService.read()).toMatchObject({ uiSize: 20, terminalFamily: 'Menlo', reading: { bodyLineHeight: 1.6, maxWidth: 700 } });
    await writeAppearanceSettingsPatch({ uiFamily: '', uiSize: 14, wallpaperId: 'none' });
    expect(appearanceService.read().customizedKeys).toEqual(expect.arrayContaining(['uiFamily', 'uiSize', 'wallpaperId']));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).customizedKeys).toBeUndefined();
    await writeAppearanceSettingsPatch(appearanceResetPatch(['uiFamily', 'uiSize', 'wallpaperId']));
    expect(appearanceService.read()).toMatchObject({ uiFamily: 'Helvetica', uiSize: 20, wallpaperId: 'custom' });
    const snapshot = appearanceService.snapshot();
    expect(Object.isFrozen(snapshot.settings.reading)).toBe(true);
    const wallpaperUrl = snapshot.settings.customWallpaperUrl!;
    expect(snapshot.settings.wallpaperId).toBe('custom');
    expect(readReferencedClientWallpaperUrls()).toContain(wallpaperUrl);
    expect((await readClientWallpaperFile(wallpaperUrl)).mimeType).toBe('image/webp');
    await appearanceService.reset();
    expect((await migrateAppearanceThemeSelection({ mode: 'dark', familyId: 'paper-local' })).themeSelection).toEqual({ mode: 'system', familyId: 'cindy' });
    expect(readAppearanceSettingsState().isCustomized).toBe(false);
  });

  // Resource preparation is asynchronous: a late old selection must not undo
  // a newer selection or reset. No existing test exercises this ordering. Unit.
  it('keeps the newest choice when older theme resource preparation finishes later', async () => {
    const completions = new Map<string, (value: { uiFamily: string }) => void>();
    const store = createOverrideSettingsFile({ filePath: () => path.join(fixture.userData, 'race.json'),
      defaults: DEFAULT_APPEARANCE_SETTINGS, normalize: normalizeAppearanceSettings,
      log: { info() {}, warn() {} }, label: 'appearance-race' });
    const service = new AppearanceService({ store, wallpaper: () => ({ url: '' }),
      resolveTheme: selection => new Promise(resolve => { completions.set(selection.familyId, resolve); }) });
    const older = service.select({ mode: 'light', familyId: 'older' });
    const newer = service.select({ mode: 'dark', familyId: 'newer' });
    completions.get('newer')!({ uiFamily: 'Helvetica' }); await newer;
    completions.get('older')!({ uiFamily: 'Inter' }); await older;
    expect(service.read()).toMatchObject({ themeSelection: { mode: 'dark', familyId: 'newer' }, uiFamily: 'Helvetica' });
    const pending = service.select({ mode: 'light', familyId: 'older' });
    await service.reset();
    completions.get('older')!({ uiFamily: 'Inter' }); await pending;
    expect(service.read()).toMatchObject({ themeSelection: { mode: 'system', familyId: 'cindy' }, uiFamily: '' });
  });
});
