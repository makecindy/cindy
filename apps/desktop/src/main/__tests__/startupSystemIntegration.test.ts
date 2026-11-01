/** #8126: packaged smoke must preserve installed OS handlers and shortcuts.
 * Unit tier: call all four production startup entries with in-memory OS effects.
 * Existing module tests cover normal registration, not smoke/manual isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';
import { execFile } from 'node:child_process';

vi.mock('electron', () => ({
  app: { get isPackaged() { return true; }, setAsDefaultProtocolClient: vi.fn(() => true) },
  BrowserWindow: {}, shell: {},
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(async () => ({ stdout: '', stderr: '' })),
  }),
}));
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
  return scanShortcut;
}

describe('startup OS integration isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['Cindy.exe']);
    vi.stubEnv('XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE', '');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(['--smoke-test', '--no-system-integration'])(
    'leaves all OS entries untouched with %s, even with a separate profile', async flag => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['Cindy.exe', '--user-data-dir=/scratch', flag]);
      const scan = await startIntegrations();
      expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
      expect(reg).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
    },
  );

  it('also suppresses integrations for the development result-file smoke entry', async () => {
    vi.spyOn(app, 'isPackaged', 'get').mockReturnValue(false);
    vi.stubEnv('XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE', '/fake-result.json');
    const scan = await startIntegrations();
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(reg).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('keeps normal packaged startup registration with a separate profile', async () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['Cindy.exe', '--user-data-dir=/scratch']);
    const scan = await startIntegrations();
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalled();
    expect(reg.mock.calls.some(([, args]) => args[0] === 'add' && args[1].includes('Directory'))).toBe(true);
    expect(reg.mock.calls.some(([, args]) => args[0] === 'add' && args[1].endsWith('\\.cindy'))).toBe(true);
    expect(scan).toHaveBeenCalled();
  });
});
