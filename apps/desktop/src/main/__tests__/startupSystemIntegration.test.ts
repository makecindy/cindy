/** #8126: packaged smoke must preserve installed OS handlers and shortcuts.
 * Unit tier: call production startup entries with in-memory OS effects.
 * Existing module tests cover normal registration, not smoke/manual isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { get isPackaged() { return true; }, setAsDefaultProtocolClient: vi.fn(() => true) },
  BrowserWindow: {}, shell: {},
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn((_file, _args, _options, callback) => callback(null, '')), {
    [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(async () => ({ stdout: '', stderr: '' })),
  }),
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn(), unlinkSync: vi.fn() }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../deepLinkWindowsRegistration', () => ({ registerWindowsDeepLinkName: vi.fn() }));
vi.mock('../provider-import/providerImport', () => ({}));
vi.mock('../device-link/broadcast-tap', () => ({}));

import { registerDeepLinkProtocol } from '../deepLink';
import { registerFolderContextMenu } from '../folderContextMenu';
import { registerCindyFileAssociation } from '../cindy-brain/fileAssociation';
import { healWindowsShortcuts } from '../windowsShortcutSelfHeal';
import { cleanupLegacyDevShortcut } from '../legacyDevShortcut';

const legacyShortcut = path.win32.join('C:\\fake-appdata', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'XdtMakerDev.lnk');
const shortcuts = new Set<string>();

const reg = (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[
  Symbol.for('nodejs.util.promisify.custom')
];

async function startIntegrations() {
  const scanShortcut = vi.fn(async () => false);
  registerDeepLinkProtocol();
  registerCindyFileAssociation();
  await registerFolderContextMenu();
  await healWindowsShortcuts({
    platform: 'win32', isPackaged: true,
    desktopDir: () => '/fake-desktop', appDataDir: () => '/fake-appdata',
    exists: scanShortcut,
  });
  // Review #8305: the ready-path cleanup used to bypass the four registration
  // gates. Exercise the real cleanup entry with an existing legacy .lnk.
  await cleanupLegacyDevShortcut();
  return scanShortcut;
}

describe('startup OS integration isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['Cindy.exe']);
    vi.stubEnv('XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE', '');
    vi.stubEnv('APPDATA', 'C:\\fake-appdata');
    shortcuts.clear();
    shortcuts.add(legacyShortcut);
    vi.mocked(existsSync).mockImplementation(p => shortcuts.has(String(p)));
    vi.mocked(unlinkSync).mockImplementation(p => { shortcuts.delete(String(p)); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(['--smoke-test', '--no-system-integration'])(
    'leaves all OS entries untouched with %s, even with a separate profile', async flag => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['Cindy.exe', '--user-data-dir=/scratch', flag]);
      const scan = await startIntegrations();
      expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
      expect(reg).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(shortcuts.has(legacyShortcut)).toBe(true);
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it('also suppresses integrations for the development result-file smoke entry', async () => {
    vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(false);
    vi.stubEnv('XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE', '/fake-result.json');
    const scan = await startIntegrations();
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(reg).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(shortcuts.has(legacyShortcut)).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('keeps normal packaged startup registration with a separate profile', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['Cindy.exe', '--user-data-dir=/scratch']);
    const scan = await startIntegrations();
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalled();
    expect(reg.mock.calls.some(([, args]) => args[0] === 'add' && args[1].includes('Directory'))).toBe(true);
    expect(reg.mock.calls.some(([, args]) => args[0] === 'add' && args[1].endsWith('\\.cindy'))).toBe(true);
    expect(scan).toHaveBeenCalled();
    expect(shortcuts.has(legacyShortcut)).toBe(false);
    expect(execFile).toHaveBeenCalledWith('powershell.exe', expect.any(Array),
      expect.objectContaining({ windowsHide: true }), expect.any(Function));
  });
});
