import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const osMock = vi.hoisted(() => ({ homedir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => osMock.homedir },
    homedir: () => osMock.homedir,
  };
});

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { BrowserWindow } from 'electron';

import { watchOmarchyTheme } from '../omarchy';
import { broadcastLocalThemes, startOmarchyThemeSync } from '../register';

// 换主题推送可信窗
const OMARCHY_DARK = JSON.stringify({
  name: 'Omarchy',
  type: 'dark',
  colors: { 'editor.background': '#142620', 'editor.foreground': '#dfede5' },
});
const cannotDenyAccess = process.platform === 'win32' || process.getuid?.() === 0;

describe('Omarchy 换主题实时推送', () => {
  const currentDir = () => path.join(osMock.homedir, '.local', 'state', 'omarchy', 'current');

  function switchOmarchyTheme(): void {
    fs.rmSync(path.join(currentDir(), 'theme'), { recursive: true, force: true });
    fs.mkdirSync(path.join(currentDir(), 'theme'), { recursive: true });
    fs.writeFileSync(path.join(currentDir(), 'theme', 'vscode-theme.json'), OMARCHY_DARK);
    fs.writeFileSync(path.join(currentDir(), 'theme.name'), 'jade-horse\n');
  }

  beforeEach(() => {
    osMock.homedir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-sync-home-')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(osMock.homedir, { recursive: true, force: true });
  });

  it('未装 Omarchy 不监听；主题目录整体替换后仍回调', async () => {
    expect(watchOmarchyTheme(() => {})).toBeNull();
    switchOmarchyTheme();
    const onSwitch = vi.fn();
    const watcher = watchOmarchyTheme(onSwitch);
    try {
      switchOmarchyTheme();
      await vi.waitFor(() => expect(onSwitch).toHaveBeenCalled());
    } finally {
      watcher?.close();
    }
  });

  it.skipIf(cannotDenyAccess)('监听启动失败只记日志，不中断注册', () => {
    fs.mkdirSync(path.dirname(currentDir()), { recursive: true });
    fs.chmodSync(path.dirname(currentDir()), 0o000);
    try {
      expect(() => startOmarchyThemeSync()).not.toThrow();
    } finally {
      fs.chmodSync(path.dirname(currentDir()), 0o755);
    }
  });

  it('推送只发给可信 Cindy 窗口，单窗失败不影响其余', async () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173');
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    const fakeWindow = (url: string, send = vi.fn()) => ({
      id: 1,
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: { url }, send },
    });
    const throwing = fakeWindow('http://127.0.0.1:5173/', vi.fn(() => {
      throw new Error('render frame disposed');
    }));
    const navigatedAway = fakeWindow('https://example.com/');
    const trusted = fakeWindow('http://127.0.0.1:5173/#/sidebar');
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue(
      [throwing, navigatedAway, trusted] as unknown as BrowserWindow[],
    );
    switchOmarchyTheme();
    await broadcastLocalThemes();
    expect(throwing.webContents.send).toHaveBeenCalled();
    expect(navigatedAway.webContents.send).not.toHaveBeenCalled();
    expect(trusted.webContents.send).toHaveBeenCalledWith(
      'local-themes:changed',
      expect.objectContaining({ themes: [expect.objectContaining({ id: 'omarchy' })] }),
    );
  });
});
