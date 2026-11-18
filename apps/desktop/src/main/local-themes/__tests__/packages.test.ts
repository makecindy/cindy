import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { nativeImage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => ({ value: '' }));
const task = vi.hoisted(() => ({ owner: 'owner-a', pending: false, refresh: vi.fn() }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => home.value } };
});
vi.mock('../../logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => task.owner, isAppSessionBoundaryPending: () => task.pending }));
vi.mock('../../app-settings/preferences', () => ({ manageAppPreferences: task.refresh }));

import { inspectCindyFile } from '../../cindy-files/reader';
import { getLocalThemesDir, loadLocalThemes, loadLocalThemesSync, resetLocalThemesMigrationForTest } from '../loader';
import { installThemePackage, readThemePackageResource } from '../packages';
import { importThemePackageFromTask } from '../agent';
import * as atomicWrites from '../../utils/atomicWriteFile';

let root: string;
const light = { id: 'mist-light', name: 'Mist', type: 'light', family: 'mist', colors: { surface: '#fafafa' }, brand: { icon: 'assets/icon.png' } };
const dark = { ...light, id: 'mist-dark', type: 'dark', colors: { surface: '#181b20' } };
const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-theme-package-')));
  home.value = path.join(root, 'home');
  resetLocalThemesMigrationForTest();
  task.owner = 'owner-a';
  task.pending = false;
  task.refresh.mockReset().mockResolvedValue({ value: { theme: 'system', themeFamily: 'cindy' } });
});

/** Screenshot regression, unit with real ZIP/disk: Agent import must use the
 * existing installer and refresh the current renderer, not launch another app.
 * Archive tests above never exercise caller file grants or refresh receipts. */
describe('theme imports from a Cindy task', () => {
  const guards = () => ({ assertCurrent: async () => {}, assertCurrentSync: () => {}, authorizePath: vi.fn(async () => ({ allowed: true as const })) });

  it('imports relative task files, returns usable family IDs and confirms the current renderer refresh', async () => {
    await packageFile();
    const access = guards();
    const result = await importThemePackageFromTask({ filePath: 'mist.cindy', workingDir: root }, access);
    expect(result).toMatchObject({ ok: true, scope: 'local', status: 'installed', refreshed: true, names: ['Mist'],
      current: { theme: 'system', themeFamily: 'cindy' },
      themes: [expect.objectContaining({ id: 'mist-light-local', themeFamily: 'mist-local' }), expect.objectContaining({ id: 'mist-dark-local', themeFamily: 'mist-local' })] });
    expect(task.refresh).toHaveBeenCalledExactlyOnceWith('refresh-themes');
    expect(loadLocalThemesSync().themes).toHaveLength(2);
    expect(access.authorizePath).not.toHaveBeenCalled();
  });

  it('does not treat plugin packages as themes or refresh after rejected imports', async () => {
    const zip = new JSZip();
    zip.file('ghost.json', JSON.stringify({ id: 'plugin' }));
    const source = path.join(root, 'plugin.cindy');
    fs.writeFileSync(source, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(await importThemePackageFromTask({ filePath: source, workingDir: root }, guards()))
      .toMatchObject({ ok: false, errorCode: 'NOT_THEME_PACKAGE' });
    expect(fs.existsSync(getLocalThemesDir())).toBe(false);
    expect(task.refresh).not.toHaveBeenCalled();
  });

  it('reports an installed theme separately when the renderer cannot confirm refresh', async () => {
    await packageFile();
    task.refresh.mockRejectedValueOnce(new Error('Window unavailable'));
    expect(await importThemePackageFromTask({ filePath: 'mist.cindy', workingDir: root }, guards()))
      .toMatchObject({ ok: true, status: 'installed', refreshed: false });
    expect(loadLocalThemesSync().themes).toHaveLength(2);
  });

  it('uses the original outside-file grant and rejects a revoked task before publication', async () => {
    await packageFile();
    const workdir = path.join(root, 'work');
    fs.mkdirSync(workdir);
    const denied = guards();
    denied.authorizePath.mockResolvedValueOnce({ allowed: false, reason: 'denied' } as never);
    expect(await importThemePackageFromTask({ filePath: path.join(root, 'mist.cindy'), workingDir: workdir }, denied))
      .toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(fs.existsSync(getLocalThemesDir())).toBe(false);
    const access = guards();
    access.assertCurrentSync = () => {
      const packages = path.join(getLocalThemesDir(), '.packages');
      if (fs.existsSync(packages) && fs.readdirSync(packages).some(name => name.startsWith('.staging-')))
        throw new Error('Task revoked');
    };
    await expect(importThemePackageFromTask({ filePath: 'mist.cindy', workingDir: root }, access)).rejects.toThrow('Task revoked');
    expect(loadLocalThemesSync().themes).toEqual([]);
    expect(task.refresh).not.toHaveBeenCalled();
  });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

async function packageFile(themes: unknown[] = [light, dark], assets: Record<string, Buffer> = { 'assets/icon.png': icon }, options: { formatVersion?: number; resources?: unknown[] } = {}) {
  const zip = new JSZip();
  const names = themes.map((_, i) => `themes/${i}.json`);
  zip.file('wrapped/cindy.json', JSON.stringify({ formatVersion: 1, type: 'theme', themes: names, ...options }));
  themes.forEach((theme, i) => zip.file(`wrapped/${names[i]}`, JSON.stringify(theme)));
  for (const [name, bytes] of Object.entries(assets)) zip.file(`wrapped/${name}`, bytes);
  const file = path.join(root, 'mist.cindy');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const inspected = await inspectCindyFile(file);
  if (inspected.type !== 'theme') throw new Error('Expected theme package');
  return inspected;
}

/**
 * Unit, real disk: installThemePackage → both production loaders. The new
 * .cindy contract requires portable assets, restart loading and no legacy JSON
 * changes; existing loader invariants only exercise loose JSON, never archives.
 * Minimal failure: one declared theme plus one relative brand asset.
 */
describe('theme package installation and loading', () => {
  // Unit performance regression: list-sync runs before the first frame. A
  // declared but unused font must stay discoverable without reading its bytes.
  it('lists installed themes without opening binary appearance resources', async () => {
    const font = fs.readFileSync(new URL('../../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/assets/JetBrainsMono-Regular.ttf', import.meta.url));
    const inspected = await packageFile([{ ...light, appearance: { bodyFont: { resource: 'asset:body' } } }],
      { 'assets/icon.png': icon, 'assets/body.ttf': font },
      { formatVersion: 2, resources: [{ id: 'body', kind: 'font', path: 'assets/body.ttf' }] });
    await installThemePackage(inspected, getLocalThemesDir());
    const file = path.join(getLocalThemesDir(), '.packages', inspected.packageSha256, 'assets/body.ttf');
    fs.writeFileSync(file, Buffer.alloc(font.length));
    const open = vi.spyOn(fs, 'openSync');
    const result = loadLocalThemesSync();
    expect(result.themes.map(theme => theme.id)).toEqual(['mist-light-local']);
    expect(result.diagnostics).toEqual([]);
    expect(open.mock.calls.some(([opened]) => opened === file)).toBe(false);
  });

  // The old loose-theme scan already has readdir's answer; no package means no
  // extra realpath/lstat/read or package-index access on the default startup path.
  it('skips package file I/O when the existing directory scan has no packages', () => {
    fs.mkdirSync(getLocalThemesDir(), { recursive: true });
    const realpath = vi.spyOn(fs, 'realpathSync'), lstat = vi.spyOn(fs, 'lstatSync');
    expect(loadLocalThemesSync()).toMatchObject({ success: true, themes: [], diagnostics: [] });
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  // Unit, real package entry: byte/pixel budgets apply before alpha scanning;
  // metadata for a removed package must not survive its next discovery.
  it('bounds brand decoding and releases cached bounds for removed packages', async () => {
    const inspected = await packageFile();
    await installThemePackage(inspected, getLocalThemesDir());
    const decodePath = vi.spyOn(nativeImage, 'createFromPath'), decodeBytes = vi.spyOn(nativeImage, 'createFromBuffer');
    const decoded = () => decodePath.mock.calls.length + decodeBytes.mock.calls.length;
    const index = path.join(getLocalThemesDir(), '.packages', 'installed.json');
    const original = fs.readFileSync(index);
    loadLocalThemesSync(); expect(decoded()).toBe(1);
    loadLocalThemesSync(); expect(decoded()).toBe(1);
    fs.writeFileSync(index, JSON.stringify({ formatVersion: 1, themes: [] }));
    loadLocalThemesSync();
    fs.writeFileSync(index, original);
    loadLocalThemesSync(); expect(decoded()).toBe(2);
    fs.truncateSync(path.join(getLocalThemesDir(), '.packages', inspected.packageSha256, 'assets/icon.png'), 20 * 1024 * 1024 + 1);
    expect(loadLocalThemesSync().themes).toHaveLength(2);
    expect(decoded()).toBe(2);
  });
  // v2's observable contract: all appearance defaults and bundled resources
  // survive installation/restart; v1 tests never exercised these fields. Unit.
  it('loads complete v2 appearance without rewriting authored documents', async () => {
    const appearance = { uiFont: { family: 'Inter', size: 15 }, terminalFont: { family: 'Menlo', size: 14 },
      bodyFont: { resource: 'asset:body', size: 16 }, wallpaper: { resource: 'asset:bg', visibility: 0.4 },
      reading: { bodyLineHeight: 1.8 }, contentStyle: { messageGap: 12 }, density: 0.9, motion: 0.5 };
    const font = fs.readFileSync(new URL('../../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/assets/JetBrainsMono-Regular.ttf', import.meta.url));
    const background = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#808080' } }).png().toBuffer();
    const theme = { ...light, appearance };
    const inspected = await packageFile([theme], { 'assets/icon.png': icon, 'assets/bg.png': background, 'assets/body.ttf': font },
      { formatVersion: 2, resources: [{ id: 'body', kind: 'font', path: 'assets/body.ttf' }, { id: 'bg', kind: 'image', path: 'assets/bg.png' }] });
    await installThemePackage(inspected, getLocalThemesDir());
    expect(loadLocalThemesSync().themes[0]).toMatchObject({ appearance });
    expect((await loadLocalThemes()).themes).toEqual(loadLocalThemesSync().themes);
    const dir = path.join(getLocalThemesDir(), '.packages', inspected.packageSha256);
    expect(fs.readFileSync(path.join(dir, 'themes/0.json'), 'utf8')).toBe(JSON.stringify(theme));
    // Native byte equality retains the exact-content assertion without Vitest
    // recursively comparing every byte of the complete TTF several times.
    expect(fs.readFileSync(path.join(dir, 'assets/body.ttf')).equals(font)).toBe(true);
    // Windows JS realpath can preserve an outer alias while promises.realpath
    // uses native canonical spelling. Simulate only that filesystem boundary;
    // the installed package, safe reader and byte assertions remain real. Unit.
    const alias = path.join(root, 'theme-root-alias');
    fs.symlinkSync(getLocalThemesDir(), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const originalRealpath = fs.realpathSync;
    const legacyRealpath = vi.spyOn(fs, 'realpathSync').mockImplementation(((...args: Parameters<typeof fs.realpathSync>) => {
      const resolved = originalRealpath(...args);
      return typeof args[0] === 'string' && args[0].startsWith(alias) ? args[0] : resolved;
    }) as typeof fs.realpathSync);
    Object.assign(legacyRealpath, { native: originalRealpath.native });
    try {
      expect((await readThemePackageResource(alias, light.id, 'asset:body')).bytes.equals(font)).toBe(true);
    } finally { legacyRealpath.mockRestore(); }
    expect((await readThemePackageResource(getLocalThemesDir(), light.id, 'asset:body')).bytes.equals(font)).toBe(true);
    await expect(readThemePackageResource(getLocalThemesDir(), light.id, 'asset:undeclared')).rejects.toThrow();
    const open = vi.spyOn(fs, 'openSync');
    expect((await readThemePackageResource(getLocalThemesDir(), light.id, 'asset:body')).bytes.equals(font)).toBe(true);
    expect(open.mock.calls.some(([file]) => file === path.join(dir, 'assets/body.ttf'))).toBe(false);
  });

  it('rejects a brand image beyond the pixel budget before publishing its package', async () => {
    const image = await sharp({ create: { width: 3000, height: 3000, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const inspected = await packageFile([light], { 'assets/icon.png': image });
    await expect(installThemePackage(inspected, getLocalThemesDir())).rejects.toMatchObject({ code: 'invalid' });
    expect(fs.existsSync(path.join(getLocalThemesDir(), '.packages'))).toBe(false);
  });

  it.each([
    [{ bodyFont: { resource: 'asset:missing' } }, []],
    [{ bodyFont: { resource: 'asset:bg' } }, [{ id: 'bg', kind: 'image', path: 'assets/icon.png' }]],
    [{ wallpaper: { resource: 'library:private.png' } }, []],
    [{ density: 99 }, []],
    [{ motion: -1 }, []],
    [{ terminalFont: { weight: 600 } }, []],
    [{ terminalFont: { style: 'italic' } }, []],
    [{ arbitraryCss: 'body { display:none }' }, []],
    [{ bodyFont: { resource: 'asset:font' } }, [{ id: 'font', kind: 'font', path: 'assets/icon.png' }]],
  ])('rejects invalid v2 appearance or resource types before publication: %j', async (appearance, resources) => {
    const inspected = await packageFile([{ ...light, appearance }], { 'assets/icon.png': icon }, { formatVersion: 2, resources });
    await expect(installThemePackage(inspected, getLocalThemesDir())).rejects.toMatchObject({ code: 'invalid' });
    expect(fs.existsSync(path.join(getLocalThemesDir(), '.packages'))).toBe(false);
  });

  it('loads both variants and local assets, preserves old themes, and repeats without duplication', async () => {
    const dir = getLocalThemesDir();
    fs.mkdirSync(dir, { recursive: true });
    const legacy = JSON.stringify({ ...light, id: 'unrelated', family: 'unrelated', brand: undefined,
      appearance: { unknown: true, density: 99 } }, null, 4) + '\n';
    fs.writeFileSync(path.join(dir, 'old.json'), legacy);
    const inspected = await packageFile();
    expect(await installThemePackage(inspected, dir)).toEqual(['Mist']);
    expect(await installThemePackage(inspected, dir)).toEqual(['Mist']);
    const result = await loadLocalThemes();
    expect(result.diagnostics).toEqual([]);
    expect(result.themes).toHaveLength(3);
    expect(result.themes.find(theme => theme.id === 'unrelated-local')).toEqual({
      id: 'unrelated-local', name: 'Mist', type: 'light', family: 'unrelated', colors: light.colors,
    });
    const added = result.themes.filter(theme => theme.id !== 'unrelated-local');
    expect(new Set(added.map(theme => theme.family)).size).toBe(1);
    expect(added[0].family).toBe('mist');
    expect(added.map(theme => theme.type)).toEqual(['light', 'dark']);
    expect(fs.readFileSync(added[0].brand!.icon!)).toEqual(icon);
    expect(fs.readFileSync(path.join(dir, 'old.json'), 'utf8')).toBe(legacy);
    expect(fs.readdirSync(path.join(dir, '.packages')).filter(name => /^[a-f0-9]{64}$/.test(name))).toEqual([inspected.packageSha256]);
    const installed = path.dirname(path.dirname(added[0].brand!.icon!));
    expect(fs.readFileSync(path.join(installed, 'themes/0.json'), 'utf8')).toBe(JSON.stringify(light));
    expect(loadLocalThemesSync()).toEqual(result);

    // Rebuild from the same bytes at another host path, with no authored paths.
    const movedHome = path.join(root, 'other-home');
    fs.cpSync(home.value, movedHome, { recursive: true });
    home.value = movedHome;
    const moved = loadLocalThemesSync();
    expect(moved.themes.map(theme => theme.id)).toEqual(result.themes.map(theme => theme.id));
    const movedTheme = moved.themes.find(theme => theme.id === 'mist-light-local')!;
    expect(movedTheme.brand!.icon).toContain(movedHome);
    expect(fs.readFileSync(movedTheme.brand!.icon!)).toEqual(icon);
  });

  // User correction 2026-11-06: IDs identify updates, archive hashes only own
  // immutable bytes. Previous coverage proved byte deduplication, not updates.
  it('updates matching IDs and their assets without changing identity or unrelated themes', async () => {
    const dir = getLocalThemesDir();
    await installThemePackage(await packageFile(), dir);
    const before = loadLocalThemesSync().themes;
    const replacement = Buffer.concat([icon, Buffer.from('new-image')]);
    await installThemePackage(await packageFile([{ ...light, name: 'Mist Updated', colors: { surface: '#abcdef' } }], { 'assets/icon.png': replacement }), dir);
    const after = loadLocalThemesSync().themes;
    expect(after).toHaveLength(2);
    expect(after.map(theme => theme.id).sort()).toEqual(before.map(theme => theme.id).sort());
    const updated = after.find(theme => theme.id === 'mist-light-local')!;
    expect(updated.family).toBe('mist');
    expect(updated.name).toBe('Mist Updated');
    expect(updated.colors.surface).toBe('#abcdef');
    expect(fs.readFileSync(updated.brand!.icon!)).toEqual(replacement);
    expect(after.find(theme => theme.id === 'mist-dark-local')).toEqual(before.find(theme => theme.id === 'mist-dark-local'));
    expect((await loadLocalThemes()).themes).toEqual(after);

    await installThemePackage(await packageFile([{ ...light, id: 'different-id', family: 'another-family', name: 'Mist Updated' }]), dir);
    expect(loadLocalThemesSync().themes).toHaveLength(3);
  });

  it('overrides a matching loose theme without rewriting its source file', async () => {
    const dir = getLocalThemesDir();
    fs.mkdirSync(dir, { recursive: true });
    const loose = JSON.stringify({ ...light, brand: undefined }, null, 4) + '\n';
    fs.writeFileSync(path.join(dir, 'old.json'), loose);
    const selectedId = loadLocalThemesSync().themes[0].id;
    await installThemePackage(await packageFile([{ ...light, colors: { surface: '#abcdef' } }]), dir);
    const result = loadLocalThemesSync();
    expect(result.diagnostics).toEqual([]);
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].id).toBe(selectedId);
    expect(result.themes[0].colors.surface).toBe('#abcdef');
    expect(fs.readFileSync(path.join(dir, 'old.json'), 'utf8')).toBe(loose);
  });

  it('preserves the last installed version when an update is invalid or cancelled', async () => {
    const dir = getLocalThemesDir();
    await installThemePackage(await packageFile(), dir);
    const before = loadLocalThemesSync();
    await expect(installThemePackage(await packageFile([{ ...light, brand: { icon: 'missing.png' } }]), dir)).rejects.toThrow();
    const changed = await packageFile([{ ...light, colors: { surface: '#abcdef' } }]);
    await expect(installThemePackage(changed, dir, () => { throw new Error('Session changed'); })).rejects.toThrow('Session changed');
    expect(loadLocalThemesSync()).toEqual(before);
  });

  it('does not expose new colors or assets when committing an update fails', async () => {
    const dir = getLocalThemesDir();
    await installThemePackage(await packageFile(), dir);
    const before = loadLocalThemesSync();
    const index = path.join(dir, '.packages', 'installed.json');
    const beforeIndex = fs.readFileSync(index);
    // Inject at the installer's commit boundary: raw rename path spelling is
    // platform-dependent and must not decide whether the failure is exercised.
    vi.spyOn(atomicWrites, 'atomicWriteFileSync').mockImplementation(() => {
      throw Object.assign(new Error('Write failed'), { code: 'EIO' });
    });
    const update = await packageFile([{ ...light, colors: { surface: '#abcdef' } }], { 'assets/icon.png': Buffer.concat([icon, Buffer.from('replacement')]) });
    await expect(installThemePackage(update, dir)).rejects.toThrow('Write failed');
    expect(fs.readFileSync(index)).toEqual(beforeIndex);
    expect(loadLocalThemesSync()).toEqual(before);
    expect(fs.readFileSync(before.themes[0].brand!.icon!)).toEqual(icon);
  });

  it('serializes concurrent imports without dropping unrelated installed IDs', async () => {
    const dir = getLocalThemesDir();
    const first = await packageFile([light]);
    const second = await packageFile([{ ...light, id: 'other-light', family: 'other' }]);
    await Promise.all([installThemePackage(first, dir), installThemePackage(second, dir)]);
    expect(loadLocalThemesSync().themes.map(theme => theme.id).sort()).toEqual(['mist-light-local', 'other-light-local']);
  });

  it.each([
    [{ ...light, colors: { surface: 1 } }],
    [{ ...light, brand: { icon: '/author/icon.png' } }],
    [{ ...light, brand: { icon: '../outside.png' } }],
    [{ ...light, brand: { icon: 'missing.png' } }],
    [{ ...light, appearance: { density: 0.9 } }],
    [light, light],
    [light, { ...light, id: 'other' }],
  ])('rejects invalid or ambiguous themes before publishing: %j', async (...themes) => {
    const dir = getLocalThemesDir();
    await expect(installThemePackage(await packageFile(themes), dir)).rejects.toMatchObject({ code: 'invalid' });
    expect(fs.existsSync(path.join(dir, '.packages'))).toBe(false);
  });

  it('does not load staging directories or publish after the initiating session ends', async () => {
    const dir = getLocalThemesDir();
    const inspected = await packageFile();
    const assertCurrent = () => {
      if (fs.existsSync(path.join(dir, '.packages')) && fs.readdirSync(path.join(dir, '.packages')).some(name => name.startsWith('.staging-'))) {
        expect(loadLocalThemesSync().themes).toEqual([]);
        throw new Error('Session changed');
      }
    };
    await expect(installThemePackage(inspected, dir, assertCurrent)).rejects.toThrow('Session changed');
    expect(fs.readdirSync(path.join(dir, '.packages'))).toEqual([]);
    expect(loadLocalThemesSync().themes).toEqual([]);
  });

  it('rejects oversized theme output and cannot load assets replaced by out-of-package links', async () => {
    const dir = getLocalThemesDir();
    await expect(installThemePackage(await packageFile([{ ...light, name: 'x'.repeat(1024 * 1024) }]), dir)).rejects.toMatchObject({ code: 'invalid' });
    const inspected = await packageFile();
    await installThemePackage(inspected, dir);
    const asset = loadLocalThemesSync().themes[0].brand!.icon!;
    const outside = path.join(root, 'outside.png');
    fs.writeFileSync(outside, icon);
    fs.unlinkSync(asset);
    fs.symlinkSync(outside, asset);
    const result = loadLocalThemesSync();
    expect(result.themes).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    await expect(installThemePackage(inspected, dir)).rejects.toThrow();
    expect(fs.readFileSync(outside)).toEqual(icon);
  });
});
