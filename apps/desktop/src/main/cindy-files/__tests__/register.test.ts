import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  home: '', generation: 1, pending: false,
  guard: vi.fn(),
  refresh: vi.fn(), send: vi.fn(), otherSend: vi.fn(),
  handlers: new Map<string, (event: unknown, file: unknown) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: never) => state.handlers.set(name, handler), on() {} },
  BrowserWindow: { getAllWindows: () => [
    { id: 1, webContents: { send: state.send } },
    { id: 2, webContents: { send: state.otherSend } },
  ] },
}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => state.home } };
});
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: state.guard, isTrustedCindyRendererWindow: () => true }));
vi.mock('../../appearance-settings-ipc', () => ({ refreshAppearanceTheme: state.refresh }));
vi.mock('../../app-settings/preferences', () => ({
  manageAppPreferences: async () => ({ value: { theme: 'system', themeFamily: 'cindy' } }),
}));
vi.mock('../../local-themes/omarchy', async (original) => ({
  ...await original<typeof import('../../local-themes/omarchy')>(),
  watchOmarchyTheme: () => null,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn() {}, info() {} }) }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => `local:owner:${state.generation}`,
  isAppSessionBoundaryPending: () => state.pending,
}));

import * as reader from '../reader';
import { registerCindyFileIpc } from '../register';
import { loadLocalThemesSync } from '../../local-themes/loader';
import { broadcastLocalThemes, registerLocalThemesIpc } from '../../local-themes/register';
import { importThemePackageFromTask } from '../../local-themes/agent';

let root: string;
const event = { sender: { id: 1 } };
const invoke = (file: unknown) => state.handlers.get('cindy-files:open')!(event, file);
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-file-ipc-')));
  state.home = path.join(root, 'home');
  state.generation = 1;
  state.pending = false;
  state.guard.mockReset();
  state.refresh.mockReset(); state.send.mockReset(); state.otherSend.mockReset();
  registerCindyFileIpc();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

async function file(contents: Record<string, unknown>) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(contents)) zip.file(name, JSON.stringify(value));
  const source = path.join(root, 'sample.cindy');
  fs.writeFileSync(source, await zip.generateAsync({ type: 'nodebuffer' }));
  return source;
}
const themePackage = {
  'cindy.json': { formatVersion: 1, type: 'theme', themes: ['light.json'] },
  'light.json': { id: 'mist', name: 'Mist', type: 'light', colors: { surface: '#ffffff' } },
};

/** Unit, real ZIP/disk: invoke the registered production handler. Reader tests
 * do not cover IPC authorization or stale-session publication. Minimal inputs:
 * a one-theme package and a session change while its inspection is pending. */
describe('Cindy file IPC', () => {
  // Unit, registered production IPC plus real installed ZIP metadata: a selected
  // resource failing restore must not hide newly installed valid themes.
  it.each(['list', 'broadcast'])('still returns installed theme metadata when selected appearance restore fails (%s)', async mode => {
    expect(await invoke(await file(themePackage))).toEqual({ type: 'theme', names: ['Mist'] });
    state.refresh.mockClear(); state.send.mockClear(); state.otherSend.mockClear();
    registerLocalThemesIpc();
    state.refresh.mockRejectedValueOnce(new Error('Selected theme font is damaged'));
    if (mode === 'list') {
      expect(await state.handlers.get('local-themes:list')!(event, undefined)).toMatchObject({
        success: true, themes: [expect.objectContaining({ id: 'mist-local' })],
      });
    } else {
      await broadcastLocalThemes();
      expect(state.send).toHaveBeenCalledWith('local-themes:changed', expect.objectContaining({
        success: true, themes: [expect.objectContaining({ id: 'mist-local' })],
      }));
    }
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  // Unit, both production import entries and real ZIP/disk: an already-open
  // second window must receive new definitions and same-ID palette updates.
  // Existing list/broadcast tests call broadcast themselves, hiding the missing
  // installation publication. One theme plus two live consumers reproduces it.
  it.each(['file', 'agent'])('publishes installed and updated palettes to all live windows (%s)', async mode => {
    const install = async (source: string) => mode === 'file' ? invoke(source)
      : importThemePackageFromTask({ filePath: source, workingDir: root }, {
        assertCurrent: async () => {}, assertCurrentSync() {},
        authorizePath: async () => ({ allowed: true }),
      });
    for (const surface of ['#ffffff', '#fefefe']) {
      const result = await install(await file({ ...themePackage,
        'light.json': { ...themePackage['light.json'], colors: { surface } },
      }));
      expect(result).toMatchObject(mode === 'file' ? { type: 'theme' } : { ok: true, status: 'installed' });
      for (const send of [state.send, state.otherSend]) {
        expect(send).toHaveBeenLastCalledWith('local-themes:changed', expect.objectContaining({
          success: true, themes: [expect.objectContaining({ id: 'mist-local', colors: expect.objectContaining({ surface }) })],
        }));
      }
    }
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.otherSend).toHaveBeenCalledTimes(2);
  });

  it('checks the trusted sender before reading paths and validates runtime payloads', async () => {
    state.guard.mockImplementationOnce(() => { throw new Error('Untrusted sender'); });
    await expect(invoke('/tmp/a.cindy')).rejects.toThrow('Untrusted sender');
    expect(state.guard).toHaveBeenCalledWith(event);
    for (const value of [null, {}, 'relative.cindy', '/tmp/not-a-package.txt', '/tmp/a\0.cindy']) {
      expect(await invoke(value)).toEqual({ type: 'invalid' });
    }
    expect(fs.existsSync(state.home)).toBe(false);
    expect(state.otherSend).not.toHaveBeenCalled();
  });

  it('installs a theme through the production file boundary', async () => {
    expect(await invoke(await file(themePackage))).toEqual({ type: 'theme', names: ['Mist'] });
    const packages = path.join(state.home, '.cindy', 'themes', '.packages');
    expect(fs.readdirSync(packages).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
    expect(loadLocalThemesSync().themes.map(theme => theme.id)).toEqual(['mist-local']);
  });

  it('delegates plugins and distinguishes unsupported from corrupted files without writes', async () => {
    expect(await invoke(await file({ 'ghost.json': { id: 'legacy' } }))).toEqual({ type: 'plugin' });
    expect(await invoke(await file({ 'cindy.json': { formatVersion: 1, type: 'future' } }))).toEqual({ type: 'unsupported' });
    expect(await invoke(await file({ 'cindy.json': null }))).toEqual({ type: 'invalid' });
    expect(fs.existsSync(state.home)).toBe(false);
    expect(state.otherSend).not.toHaveBeenCalled();
  });

  it('drops a pending import when its application session changes', async () => {
    const source = await file(themePackage);
    const inspected = await reader.inspectCindyFile(source);
    let finish!: (result: typeof inspected) => void;
    vi.spyOn(reader, 'inspectCindyFile').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = invoke(source);
    state.generation++;
    finish(inspected);
    expect(await pending).toEqual({ type: 'failed' });
    expect(fs.existsSync(state.home)).toBe(false);
    expect(state.otherSend).not.toHaveBeenCalled();
    state.pending = true;
    expect(await invoke(source)).toEqual({ type: 'failed' });
  });
});
