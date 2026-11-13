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
  appearancePortableSettings,
  readAppearanceSettingsState,
  writeAppearanceSettingsPatch,
  resetAppearanceSettings,
  appearanceService,
  updateAppearanceSettingsAtomic,
  readSelectedThemeFont,
} from '../appearance-settings-store';
import { inspectCindyFile } from '../cindy-files/reader';
import { installThemePackage } from '../local-themes/packages';
import { getLocalThemesDir, loadLocalThemesSync } from '../local-themes/loader';
import { appearanceDefinitionToOverrides, appearanceResetPatch } from '../appearance/definition';
import { readClientWallpaperFile } from '../cindy-media/blobStore.desktop';
import { readReferencedClientWallpaperUrls } from '../custom-wallpaper-settings';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { AppearanceService } from '../appearance/service';
import { resolveThemeAppearance } from '../appearance/themes';

describe('terminal appearance overrides', () => {
  beforeEach(() => {
    fixture.userData = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-terminal-appearance-')));
  });
  afterEach(async () => {
    await appearanceService.select(null);
    fs.rmSync(fixture.userData, { recursive: true, force: true });
  });

  // Unit performance regression: the default startup path used to await media
  // cleanup and every cached read added an appearance-file stat and SHA snapshot.
  it('keeps builtin refresh synchronous and cached reads free of added file I/O', () => {
    const file = path.join(fixture.userData, 'cached.json');
    const store = createOverrideSettingsFile({ filePath: () => file,
      defaults: DEFAULT_APPEARANCE_SETTINGS, normalize: normalizeAppearanceSettings,
      log: { info() {}, warn() {} }, label: 'appearance-performance' });
    const resolveTheme = vi.fn(async () => ({})), cleanupMedia = vi.fn(async () => {});
    const service = new AppearanceService({ store, wallpaper: () => ({ url: '' }), resolveTheme, cleanupMedia });
    service.read();
    // Taking an immutable snapshot must not freeze the store's cached value.
    const initial = service.snapshot();
    expect(Object.isFrozen(initial.settings)).toBe(true);
    const stat = vi.spyOn(fs, 'statSync'), read = vi.spyOn(fs, 'readFileSync');
    const snapshot = vi.spyOn(service, 'snapshot');
    try {
      expect(service.refresh()).toBeUndefined();
      for (let i = 0; i < 100; i++) expect(service.read().uiSize).toBe(DEFAULT_APPEARANCE_SETTINGS.uiSize);
      expect(stat).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(resolveTheme).not.toHaveBeenCalled(); expect(cleanupMedia).not.toHaveBeenCalled();
    } finally { stat.mockRestore(); read.mockRestore(); snapshot.mockRestore(); }
  });

  it('reads old overrides with unchanged values and adds terminal defaults only in memory', () => {
    const oldOverrides = { uiFamily: 'Inter', codeFamily: 'JetBrains Mono', uiSize: 16, codeSize: 18, windowZoom: 1.2 };
    const file = path.join(fixture.userData, 'appearance-settings.json');
    fs.writeFileSync(file, JSON.stringify(oldOverrides));
    const state = readAppearanceSettingsState();
    expect(state.value).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...oldOverrides });
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
    expect(readAppearanceSettingsState().value).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...otherOverrides });
  });

  it('does not persist a defaults snapshot when restoring the only terminal override', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    await writeAppearanceSettingsPatch({ terminalSize: 20 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ terminalSize: 20 });
    await writeAppearanceSettingsPatch({ terminalSize: 13 });
    expect(fs.existsSync(file)).toBe(false);
    expect(readAppearanceSettingsState().isCustomized).toBe(false);
  });

  // Compatibility contract, unit through the real disk owner: an intermediate
  // build's saved projection is unknown data, never a source of appearance.
  it('ignores an old persisted selection without rewriting original settings on cold startup', () => {
    const old = { uiFamily: 'Inter', uiSize: 17, terminalSize: 18, wallpaperId: 'cindy-night-glance', wallpaperVisibility: 0.37 };
    const file = path.join(fixture.userData, 'appearance-settings.json');
    const saved = JSON.stringify({ ...old, themeSelection: { mode: 'dark', familyId: 'missing-local' } });
    fs.writeFileSync(file, saved);
    expect(readAppearanceSettingsState().value).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...old });
    expect(appearanceService.refresh()).toBeUndefined();
    expect(appearanceService.hasThemeDefaults()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(saved);
  });

  it('preserves unreadable settings without preparing a theme or writing a migration', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    fs.writeFileSync(file, '{broken');
    expect(appearanceService.refresh()).toBeUndefined();
    await expect(writeAppearanceSettingsPatch({ uiSize: 17 })).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(readAppearanceSettingsState().value).not.toHaveProperty('themeSelection');
  });

  // Reset recovery existed before the theme owner. Ordinary writes/migration
  // must preserve bad files, while an explicit reset must restore writability.
  // Unit, real public settings entry and disk; warm cache models external damage.
  it.each(['malformed', 'oversized'] as const)('recovers %s appearance settings through explicit reset', async kind => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    fs.writeFileSync(file, JSON.stringify({ themeSelection: { mode: 'dark', familyId: 'cindy' }, uiSize: 18 }));
    expect(readAppearanceSettingsState().value.uiSize).toBe(18);
    fs.writeFileSync(file, kind === 'malformed' ? '{broken' : ' '.repeat(16 * 1024 + 1));
    expect(await resetAppearanceSettings()).toMatchObject({ uiSize: 14, wallpaperId: 'none' });
    expect(fs.existsSync(file)).toBe(false);
    await writeAppearanceSettingsPatch({ uiSize: 17 });
    expect(readAppearanceSettingsState().value.uiSize).toBe(17);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ uiSize: 17 });
  });

  // End-to-end Host ownership, unit with real overrides/ZIP: themes supply
  // defaults, fixed writes supply only named overrides, reset follows the theme.
  it('composes theme defaults and fixed writes without freezing inherited values', async () => {
    const zip = new JSZip();
    zip.file('cindy.json', JSON.stringify({ formatVersion: 2, type: 'theme', themes: ['light.json', 'dark.json'],
      resources: [{ id: 'body', kind: 'font', path: 'body.ttf' }, { id: 'bg', kind: 'image', path: 'bg.png' }, { id: 'video', kind: 'video', path: 'bg.mp4' }] }));
    const font = fs.readFileSync(new URL('../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/assets/JetBrainsMono-Regular.ttf', import.meta.url));
    const background = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#808080' } }).png().toBuffer();
    const video = fs.readFileSync(new URL('../../renderer/assets/wallpapers/cindy-studio.mp4', import.meta.url));
    zip.file('body.ttf', font);
    zip.file('bg.png', background); zip.file('bg.mp4', video);
    for (const mode of ['light', 'dark'] as const) zip.file(`${mode}.json`, JSON.stringify({
      id: `paper-${mode}`, family: 'paper', name: 'Paper', type: mode, colors: {},
      appearance: { uiFont: { family: mode === 'light' ? 'Inter' : 'Helvetica', size: 20 },
        bodyFont: { resource: 'asset:body' }, codeFont: { resource: 'asset:body' },
        wallpaper: { resource: mode === 'light' ? 'asset:video' : 'asset:bg', fallbackResource: 'asset:bg', visibility: 0.4 },
        reading: { bodyLineHeight: mode === 'light' ? 1.8 : 1.6, maxWidth: 700 }, density: 0.9, motion: 0.5 },
    }));
    const source = path.join(fixture.userData, 'paper.cindy');
    fs.writeFileSync(source, await zip.generateAsync({ type: 'nodebuffer' }));
    const inspected = await inspectCindyFile(source);
    if (inspected.type !== 'theme') throw new Error('Expected theme');
    await installThemePackage(inspected, getLocalThemesDir());
    await writeAppearanceSettingsPatch({ uiSize: 17, terminalFamily: 'Menlo', wallpaperId: 'cindy-night-glance' });
    const read = vi.spyOn(fs.promises, 'open');
    await appearanceService.select({ mode: 'light', familyId: 'paper-local' });
    const packageDir = path.join(getLocalThemesDir(), '.packages', inspected.packageSha256);
    expect(read.mock.calls.filter(([file]) => file === fs.realpathSync.native(path.join(packageDir, 'body.ttf')))).toHaveLength(1);
    read.mockRestore();
    expect(appearanceService.read()).toMatchObject({ uiFamily: 'Inter', uiSize: 17, terminalFamily: 'Menlo', wallpaperId: 'cindy-night-glance', density: 0.9, motion: 0.5 });
    const file = path.join(fixture.userData, 'appearance-settings.json');
    const originalSettings = fs.readFileSync(file);
    await appearanceService.select(null);
    expect(appearanceService.read()).toMatchObject({ uiFamily: '', uiSize: 17,
      terminalFamily: 'Menlo', wallpaperId: 'cindy-night-glance', density: 1, motion: 1 });
    expect(fs.readFileSync(file)).toEqual(originalSettings);
    await appearanceService.select({ mode: 'light', familyId: 'paper-local' });
    expect(Buffer.from((await readSelectedThemeFont('bodyFont'))!.bytes)).toEqual(font);
    await updateAppearanceSettingsAtomic((_current, overrides) => appearanceDefinitionToOverrides(overrides, { reading: { maxWidth: 800 } }));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('themeSelection');
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
    // A corrupt unselected binary stays discoverable. Actual selection rejects
    // font/image/video corruption before writing settings or publishing defaults.
    const saved = fs.readFileSync(file);
    for (const [asset, bytes] of [['body.ttf', font], ['bg.png', background], ['bg.mp4', video]] as const) {
      try {
        fs.writeFileSync(path.join(packageDir, asset), Buffer.alloc(bytes.length));
        expect(loadLocalThemesSync().themes).toHaveLength(2);
        if (asset === 'body.ttf') {
          // Cold startup reads only user settings. Renderer selection rebuilds
          // the package layer later; corruption still rejects that request.
          const restartedStore = createOverrideSettingsFile({ filePath: () => file,
            defaults: DEFAULT_APPEARANCE_SETTINGS, normalize: normalizeAppearanceSettings,
            log: { info() {}, warn() {} }, label: 'appearance-restart' });
          const restarted = new AppearanceService({ store: restartedStore, resolveTheme: resolveThemeAppearance, wallpaper: () => ({ url: '' }) });
          expect(restarted.refresh()).toBeUndefined();
          expect(restarted.read()).toMatchObject({ uiFamily: '' });
          expect(restarted.read()).not.toHaveProperty('themeSelection');
          await expect(restarted.select({ mode: 'dark', familyId: 'paper-local' })).rejects.toThrow();
        }
        await expect(appearanceService.select({ mode: 'light', familyId: 'paper-local' })).rejects.toThrow();
        expect(appearanceService.snapshot()).toEqual(snapshot);
        expect(fs.readFileSync(file)).toEqual(saved);
      } finally { fs.writeFileSync(path.join(packageDir, asset), bytes); }
    }
    // Switching back removes only the derived defaults, preserving the user's
    // original choices and serialized overrides for old-version rollback.
    await appearanceService.select(null);
    expect(appearanceService.read()).toMatchObject({ uiFamily: '', uiSize: 14, terminalFamily: 'Menlo', wallpaperId: 'none', density: 1, motion: 1 });
    expect(appearanceService.read()).not.toHaveProperty('customizedKeys');
    expect(fs.readFileSync(file)).toEqual(saved);
    const restarted = new AppearanceService({
      store: createOverrideSettingsFile({ filePath: () => file, defaults: DEFAULT_APPEARANCE_SETTINGS,
        normalize: normalizeAppearanceSettings, log: { info() {}, warn() {} }, label: 'appearance-restart' }),
      wallpaper: () => ({ url: '' }), resolveTheme: resolveThemeAppearance,
    });
    expect(restarted.read().uiFamily).toBe('');
    await restarted.select({ mode: 'dark', familyId: 'paper-local' });
    expect(restarted.read()).toMatchObject({ uiFamily: 'Helvetica', uiSize: 20 });
    await appearanceService.reset();
    expect(fs.existsSync(file)).toBe(false);
    expect(appearanceService.read()).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(readAppearanceSettingsState().isCustomized).toBe(false);
  });

  // Resource preparation is asynchronous: a late old selection must not undo
  // a newer selection or package exit. No existing test exercises this ordering. Unit.
  it('keeps the newest choice when older theme resource preparation finishes later', async () => {
    const completions = new Map<string, (value: { uiFamily: string }) => void>();
    const store = createOverrideSettingsFile({ filePath: () => path.join(fixture.userData, 'race.json'),
      defaults: DEFAULT_APPEARANCE_SETTINGS, normalize: normalizeAppearanceSettings,
      log: { info() {}, warn() {} }, label: 'appearance-race' });
    const service = new AppearanceService({ store, wallpaper: () => ({ url: '' }),
      resolveTheme: selection => new Promise(resolve => { completions.set(selection.familyId, resolve); }) });
    const older = service.select({ mode: 'light', familyId: 'older-local' });
    const newer = service.select({ mode: 'dark', familyId: 'newer-local' });
    completions.get('newer-local')!({ uiFamily: 'Helvetica' }); await newer;
    completions.get('older-local')!({ uiFamily: 'Inter' }); await older;
    expect(service.read().uiFamily).toBe('Helvetica');
    const pending = service.select({ mode: 'light', familyId: 'older-local' });
    await service.select(null);
    completions.get('older-local')!({ uiFamily: 'Inter' }); await pending;
    expect(service.read()).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(fs.existsSync(path.join(fixture.userData, 'race.json'))).toBe(false);
  });

  // PR #9496 / discussion_r4537053002: exporting no resource pointer must not
  // leave its generated family on another computer. Existing terminal tests
  // do not cover portable export. Minimum: selected fonts in three roles; unit.
  it('exports font traits without device-local plugin resources or their matching families', async () => {
    const [ui, code, body] = ['a', 'b', 'c'].map(letter => ({
      source: { instanceId: 'example', key: 'd'.repeat(64) }, reference: `asset:font-${letter}`,
      hash: letter.repeat(64), family: `CindyPlugin_${letter.repeat(64)}`,
    }));
    await writeAppearanceSettingsPatch({ uiFamily: ui.family, codeFamily: code.family,
      uiSize: 17, codeSize: 19, uiFontResource: ui, codeFontResource: code, bodyFontResource: body,
      bodyFont: { family: body.family, size: 20, weight: 600, style: 'italic' } });
    expect(appearancePortableSettings.readCustomized()).toEqual({ uiSize: 17, codeSize: 19,
      bodyFont: { size: 20, weight: 600, style: 'italic' } });
    expect(readAppearanceSettingsState().value.uiFamily).toBe(ui.family);
    expect(readAppearanceSettingsState().value.bodyFont?.family).toBe(body.family);
  });

  it('keeps manually chosen families instead of filtering by a generated-name prefix', async () => {
    const hash = 'a'.repeat(64), family = `CindyPlugin_${hash}`;
    const resource = { source: { instanceId: 'example', key: 'b'.repeat(64) }, reference: 'asset:font', hash, family };
    await writeAppearanceSettingsPatch({ uiFamily: 'Inter', uiFontResource: resource,
      codeFamily: family, bodyFontResource: resource, bodyFont: { family: 'Local Body', size: 20 } });
    expect(appearancePortableSettings.readCustomized()).toEqual({
      uiFamily: 'Inter', codeFamily: family, bodyFont: { family: 'Local Body', size: 20 },
    });
  });

  it('does not export an empty body override when its only trait is a plugin family', async () => {
    const hash = 'a'.repeat(64), family = `CindyPlugin_${hash}`;
    await writeAppearanceSettingsPatch({ bodyFont: { family }, bodyFontResource: {
      source: { instanceId: 'example', key: 'b'.repeat(64) }, reference: 'asset:font', hash, family,
    } });
    expect(appearancePortableSettings.readCustomized()).toEqual({});
    expect(readAppearanceSettingsState().value.bodyFont?.family).toBe(family);
  });

  it('still reports a locally selected plugin font to the migration write conflict guard', async () => {
    const hash = 'a'.repeat(64), family = `CindyPlugin_${hash}`;
    await writeAppearanceSettingsPatch({ uiFamily: family, uiFontResource: {
      source: { instanceId: 'example', key: 'b'.repeat(64) }, reference: 'asset:font', hash, family,
    } });
    let localFamily: unknown;
    await appearancePortableSettings.applyPatch(customizedHere => {
      localFamily = customizedHere.uiFamily;
      return { uiSize: 20 };
    });
    expect(localFamily).toBe(family);
    expect(readAppearanceSettingsState().value.uiFamily).toBe(family);
  });
});
