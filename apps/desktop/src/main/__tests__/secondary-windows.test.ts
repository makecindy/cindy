import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadURL: vi.fn(), loadFile: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { on: vi.fn(), once: vi.fn(), setWindowOpenHandler: vi.fn() };
    once = vi.fn();
    loadURL = mocks.loadURL;
    loadFile = mocks.loadFile;
  },
  app: { isPackaged: false },
  nativeTheme: { shouldUseDarkColors: false },
  screen: {},
  shell: {},
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock('../app-shortcuts/new-maker-window-shortcut.js', () => ({
  installNewMakerWindowShortcut: vi.fn(),
}));
vi.mock('../windowFocusClassifier.js', () => ({
  markAppContentWindow: vi.fn(),
  isAppContentWindow: vi.fn(),
}));
vi.mock('../window-behavior-settings-store.js', () => ({
  readWindowBehaviorSettings: () => ({ swallowActivationClick: false }),
}));
vi.mock('../vibrancyConfig.js', () => ({ resolveVibrancyConfig: () => ({}) }));
vi.mock('../selection-context-menu.js', () => ({ installSelectionContextMenu: vi.fn() }));
vi.mock('../appearance-settings-ipc.js', () => ({ applyAppearanceToWindow: vi.fn() }));
vi.mock('../mainWindowFullscreenStartup.js', () => ({
  installWindowFullscreenStateBroadcast: vi.fn(),
}));
vi.mock('../window-theme-mode-store.js', () => ({ readWindowThemeSnapshot: () => null }));

import { openSessionInNewWindow } from '../secondary-windows';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
});
afterEach(() => vi.unstubAllGlobals());

describe('session window link targets', () => {
  it('encodes remote device and message anchors into the development window URL', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');
    openSessionInNewWindow('task/1', null, 'remote-device', undefined, 'message/1?x=2&y=3');
    const url = new URL(mocks.loadURL.mock.calls[0]![0]);
    expect(url.hash).toBe('#/cc-agent/boot');
    expect(url.searchParams.get('bootSession')).toBe('task/1');
    expect(url.searchParams.get('bootDevice')).toBe('remote-device');
    expect(url.searchParams.get('bootMessage')).toBe('message/1?x=2&y=3');
    expect(url.searchParams.get('y')).toBeNull();
  });

  it('passes the same target to packaged windows and keeps existing callers compatible', () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    openSessionInNewWindow('task', null, 'remote-device', undefined, 'message');
    expect(mocks.loadFile.mock.calls[0]![1]).toEqual({
      query: {
        secondaryWindow: '1',
        bootSession: 'task',
        bootDevice: 'remote-device',
        bootMessage: 'message',
      },
      hash: '/cc-agent/boot',
    });
    openSessionInNewWindow('local-task', null);
    expect(mocks.loadFile.mock.calls[1]![1].query).toEqual({
      secondaryWindow: '1',
      bootSession: 'local-task',
    });
  });
});
