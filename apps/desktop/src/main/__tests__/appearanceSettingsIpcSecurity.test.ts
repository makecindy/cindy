import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  ipcOn: vi.fn(),
  ipcHandle: vi.fn(),
  allWindows: [] as Array<unknown>,
  trustedRead: vi.fn(),
  trustedReadWindow: vi.fn(),
  assertTrustedAppRendererEvent: vi.fn(),
  readAppearanceSettings: vi.fn(),
  readAppearanceSettingsState: vi.fn(),
  writeAppearanceSettingsPatch: vi.fn(),
  resetAppearanceSettings: vi.fn(),
  updateAppearanceSettingsAtomic: vi.fn(),
  owner: 'owner-a:1',
  boundaryPending: false,
  importWallpaper: vi.fn(),
  removeWallpaper: vi.fn(),
  ensureVideo: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mocks.owner,
  isAppSessionBoundaryPending: () => mocks.boundaryPending,
}));
vi.mock('../custom-wallpaper.js', () => ({
  importCustomWallpaper: mocks.importWallpaper,
  removeCustomWallpaper: mocks.removeWallpaper,
}));
vi.mock('../wallpaper-video.js', () => ({
  ensureWallpaperVideo: mocks.ensureVideo,
  ensureWallpaperImage: mocks.ensureVideo,
}));

vi.mock('electron', () => ({
  app: { on: mocks.appOn },
  BrowserWindow: { getAllWindows: () => mocks.allWindows, fromWebContents: mocks.fromWebContents },
  ipcMain: { on: mocks.ipcOn, handle: mocks.ipcHandle },
}));

vi.mock('../appearance-settings-reader.js', () => ({
  isTrustedAppearanceSettingsReadEvent: mocks.trustedRead,
  isTrustedAppearanceSettingsReadWindow: mocks.trustedReadWindow,
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRendererEvent,
}));

vi.mock('../appearance-settings-store.js', () => ({
  readAppearanceSettings: mocks.readAppearanceSettings,
  readAppearanceSettingsState: mocks.readAppearanceSettingsState,
  writeAppearanceSettingsPatch: mocks.writeAppearanceSettingsPatch,
  resetAppearanceSettings: mocks.resetAppearanceSettings,
  updateAppearanceSettingsAtomic: mocks.updateAppearanceSettingsAtomic,
}));

import { registerAppearanceSettingsIpc, __testing } from '../appearance-settings-ipc.js';
import {
  normalizeAppearanceSettings,
  WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL,
} from '../../shared/appearanceSettings.js';
import { markAppContentWindow } from '../windowFocusClassifier.js';

const persisted = {
  uiFamily: 'Inter',
  codeFamily: 'JetBrains Mono',
  uiSize: 15,
  codeSize: 14,
  terminalFamily: 'Menlo',
  terminalSize: 17,
  windowZoom: 1.1,
};

describe('appearance settings IPC authorization', () => {
  it('validates literal visibility and accepts null only to reset its override', () => {
    for (const wallpaperBlur of [0, 8, 20, null]) {
      expect(__testing.parsePatch({ wallpaperBlur })).toEqual({ wallpaperBlur });
    }
    expect(__testing.parsePatch({ wallpaperBlur: 99 })).toEqual({ wallpaperBlur: 20 });
    expect(__testing.parsePatch({ wallpaperBlur: -1 })).toEqual({ wallpaperBlur: 0 });
    expect(__testing.parsePatch({ wallpaperBlur: 4.6 })).toEqual({ wallpaperBlur: 5 });
    for (const wallpaperBlur of ['8', true, NaN, Infinity, {}]) {
      expect(() => __testing.parsePatch({ wallpaperBlur })).toThrow('INVALID_PARAMS');
    }
    for (const wallpaperVisibility of [0, 0.37, 1, null]) {
      expect(__testing.parsePatch({ wallpaperVisibility })).toEqual({ wallpaperVisibility });
    }
    expect(__testing.parsePatch({ wallpaperVisibility: 2 })).toEqual({ wallpaperVisibility: 1 });
    expect(__testing.parsePatch({ wallpaperVisibility: -1 })).toEqual({ wallpaperVisibility: 0 });
    for (const wallpaperVisibility of ['0.5', true, NaN, Infinity, {}]) {
      expect(() => __testing.parsePatch({ wallpaperVisibility })).toThrow('INVALID_PARAMS');
    }
  });
  it.each(['video', 'image'])(
    'authorizes the CDN %s request and keeps it valid across account switches',
    async (kind) => {
      const handler = mocks.ipcHandle.mock.calls.find(
        ([name]) => name === `appearance-settings:ensure-wallpaper-${kind}`,
      )?.[1];
      mocks.ensureVideo.mockResolvedValueOnce(null);
      expect(await handler({}, 'cindy-window')).toBeNull();
      expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalled();
      mocks.ensureVideo.mockImplementationOnce(async () => {
        mocks.owner = 'owner-b:2';
        return 'client-video-url';
      });
      expect(await handler({}, 'cindy-window')).toBe('client-video-url');
    },
  );
  it.each(['video', 'image'])(
    'rejects an untrusted CDN %s request before starting a download',
    async (kind) => {
      mocks.assertTrustedAppRendererEvent.mockImplementation(() => {
        throw new Error('untrusted');
      });
      const handler = mocks.ipcHandle.mock.calls.find(
        ([name]) => name === `appearance-settings:ensure-wallpaper-${kind}`,
      )?.[1];
      await expect(handler({}, 'cindy-window')).rejects.toThrow('untrusted');
      expect(mocks.ensureVideo).not.toHaveBeenCalled();
    },
  );
  it.each(['video', 'image'])(
    'sends %s progress only to the authorized requesting frame',
    async (kind) => {
      const handler = mocks.ipcHandle.mock.calls.find(
        ([name]) => name === `appearance-settings:ensure-wallpaper-${kind}`,
      )?.[1];
      const send = vi.fn();
      const progress = { wallpaperId: 'cindy-window', kind, loaded: 2, total: 3 };
      mocks.ensureVideo.mockImplementationOnce(async (_id, onProgress) => {
        onProgress(progress);
        return 'cached-media-url';
      });
      await expect(handler({ senderFrame: { send } }, 'cindy-window')).resolves.toBe(
        'cached-media-url',
      );
      expect(send).toHaveBeenCalledExactlyOnceWith(WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL, progress);
      expect(mocks.trustedReadWindow).not.toHaveBeenCalled();
    },
  );
  it.each(['appearance-settings:import-wallpaper', 'appearance-settings:remove-wallpaper'])(
    'allows %s when the account changes during module loading',
    async (channel) => {
      const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === channel)?.[1];
      const pending = handler({ sender: {} });
      mocks.owner = 'owner-b:2';
      await expect(pending).resolves.not.toBeUndefined();
      expect(
        channel.endsWith('import-wallpaper') ? mocks.importWallpaper : mocks.removeWallpaper,
      ).toHaveBeenCalledOnce();
    },
  );
  it.each(['appearance-settings:import-wallpaper', 'appearance-settings:remove-wallpaper'])(
    'allows %s while account teardown is pending',
    async (channel) => {
      const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === channel)?.[1];
      const pending = handler({ sender: {} });
      mocks.boundaryPending = true;
      await expect(pending).resolves.not.toBeUndefined();
      expect(
        channel.endsWith('import-wallpaper') ? mocks.importWallpaper : mocks.removeWallpaper,
      ).toHaveBeenCalledOnce();
    },
  );
  it('does not let a renderer inject a path or media URL through the generic preference channel', () => {
    expect(__testing.parsePatch({ wallpaperId: 'custom' })).toEqual({ wallpaperId: 'custom' });
    expect(() =>
      __testing.parsePatch({
        customWallpaperUrl: `cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`,
      }),
    ).toThrow('unknown appearance field');
    expect(() => __testing.parsePatch({ wallpaperPath: '/private.png' })).toThrow(
      'unknown appearance field',
    );
  });
  it.each(['appearance-settings:import-wallpaper', 'appearance-settings:remove-wallpaper'])(
    'rejects untrusted callers before %s can access a picker or media',
    async (channel) => {
      mocks.assertTrustedAppRendererEvent.mockImplementation(() => {
        throw new Error('untrusted');
      });
      const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === channel)?.[1];
      await expect(handler({})).rejects.toThrow('untrusted');
    },
  );
  it('validates motion choices and preserves the static default for old settings', () => {
    expect(normalizeAppearanceSettings({ wallpaperId: 'cindy-window' }).wallpaperMotion).toBe(
      'static',
    );
    expect(__testing.parsePatch({ wallpaperMotion: 'dynamic' })).toEqual({
      wallpaperMotion: 'dynamic',
    });
    expect(__testing.parsePatch({ wallpaperMotion: 'static' })).toEqual({
      wallpaperMotion: 'static',
    });
    expect(() => __testing.parsePatch({ wallpaperMotion: 'auto' })).toThrow();
  });
  beforeAll(() => {
    registerAppearanceSettingsIpc();
  });

  beforeEach(() => {
    mocks.owner = 'owner-a:1';
    mocks.boundaryPending = false;
    mocks.importWallpaper.mockReset();
    mocks.removeWallpaper.mockReset();
    mocks.ensureVideo.mockReset();
    mocks.allWindows.length = 0;
    mocks.trustedRead.mockReset();
    mocks.trustedReadWindow.mockReset().mockReturnValue(false);
    mocks.assertTrustedAppRendererEvent.mockReset();
    mocks.readAppearanceSettings.mockReset().mockReturnValue(persisted);
    mocks.fromWebContents.mockReset().mockReturnValue({ isDestroyed: () => false });
    mocks.writeAppearanceSettingsPatch.mockReset().mockResolvedValue(persisted);
    mocks.updateAppearanceSettingsAtomic.mockReset();
  });

  // #7486: the file can retain 90% while an activated window displays 100%.
  // Existing IPC tests only covered preference writes, not native focus recovery.
  // Exercise the registered Electron event with a stateful window; unit tier.
  it('restores a drifted app window on focus without rewriting preferences or stable zoom', () => {
    const settings = { ...persisted, windowZoom: 0.9 };
    mocks.readAppearanceSettings.mockReturnValue(settings);
    let zoom = 1;
    const setZoomFactor = vi.fn((value: number) => { zoom = value; });
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, getZoomFactor: () => zoom, setZoomFactor },
    };
    markAppContentWindow(win as never);
    const focus = mocks.appOn.mock.calls.find(([name]) => name === 'browser-window-focus')?.[1];
    expect(focus).toBeTypeOf('function');
    focus({}, win);
    expect(zoom).toBe(0.9);
    focus({}, win);
    expect(setZoomFactor).toHaveBeenCalledOnce();
    expect(mocks.writeAppearanceSettingsPatch).not.toHaveBeenCalled();
    expect(mocks.updateAppearanceSettingsAtomic).not.toHaveBeenCalled();
  });

  it('does not apply the app zoom to unregistered or destroyed focus targets', () => {
    const focus = mocks.appOn.mock.calls.find(([name]) => name === 'browser-window-focus')?.[1];
    expect(focus).toBeTypeOf('function');
    const setZoomFactor = vi.fn();
    const win = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), getZoomFactor: () => 1, setZoomFactor },
    };
    focus({}, win);
    markAppContentWindow(win as never);
    win.webContents.isDestroyed.mockReturnValue(true);
    focus({}, win);
    win.isDestroyed.mockReturnValue(true);
    focus({}, win);
    expect(setZoomFactor).not.toHaveBeenCalled();
  });

  it('同步启动读取只向已授权的外观 reader 返回持久快照', () => {
    const handler = mocks.ipcOn.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:get-sync',
    )?.[1] as (event: { returnValue?: unknown }) => void;

    mocks.trustedRead.mockReturnValue(true);
    const trustedEvent: { returnValue?: unknown } = {};
    handler(trustedEvent);
    expect(trustedEvent.returnValue).toEqual(persisted);

    mocks.trustedRead.mockReturnValue(false);
    const untrustedEvent: { returnValue?: unknown } = {};
    handler(untrustedEvent);
    expect(untrustedEvent.returnValue).toBeNull();
  });

  it('异步读取和写通道继续使用 app-content 高权限断言', async () => {
    const getHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:get',
    )?.[1] as (event: unknown) => unknown;
    const setHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:set-patch',
    )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
    const resetHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:reset',
    )?.[1] as (event: unknown) => Promise<unknown>;

    mocks.readAppearanceSettingsState.mockReturnValue({ value: persisted, overrides: {} });
    mocks.writeAppearanceSettingsPatch.mockResolvedValue(persisted);
    mocks.resetAppearanceSettings.mockResolvedValue(persisted);

    const event = {};
    getHandler(event);
    await setHandler(event, { uiSize: 15 });
    await resetHandler(event);

    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalledTimes(3);
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(1, event);
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(2, event);
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(3, event);
  });

  it('withholds private media from utility bootstrap and broadcasts, while retaining it for app content', async () => {
    const settings = normalizeAppearanceSettings({
      wallpaperId: 'custom',
      customWallpaperUrl: `cindy-media://client-wallpaper/${'a'.repeat(64)}.webp`,
    });
    const utility = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn() },
    };
    const content = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn(), setZoomFactor: vi.fn() },
    };
    markAppContentWindow(content as never);
    mocks.trustedRead.mockReturnValue(true);
    mocks.readAppearanceSettings.mockReturnValue(settings);
    const sync = mocks.ipcOn.mock.calls.find(
      ([name]) => name === 'appearance-settings:get-sync',
    )![1];
    const event = { sender: {}, returnValue: undefined as unknown };
    mocks.fromWebContents.mockReturnValue(utility);
    sync(event);
    expect(event.returnValue).not.toHaveProperty('customWallpaperUrl');
    expect(event.returnValue).toMatchObject({ wallpaperId: 'none', uiSize: settings.uiSize });
    mocks.fromWebContents.mockReturnValue(content);
    sync(event);
    expect(event.returnValue).toEqual(settings);

    mocks.allWindows.push(utility, content);
    mocks.trustedReadWindow.mockReturnValue(true);
    mocks.writeAppearanceSettingsPatch.mockResolvedValue(settings);
    const set = mocks.ipcHandle.mock.calls.find(
      ([name]) => name === 'appearance-settings:set-patch',
    )![1];
    await set({}, { uiSize: 15 });
    expect(utility.webContents.send.mock.calls[0][1]).not.toHaveProperty('customWallpaperUrl');
    expect(content.webContents.send).toHaveBeenCalledWith('appearance-settings:changed', settings);
  });

  it('外观变更广播也覆盖显式授权的 utility 窗口', async () => {
    const setHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:set-patch',
    )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
    const allowedSend = vi.fn();
    const deniedSend = vi.fn();
    const allowed = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: allowedSend },
    };
    const denied = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: deniedSend },
    };
    mocks.allWindows.push(allowed, denied);
    mocks.trustedReadWindow.mockImplementation((win) => win === allowed);
    mocks.writeAppearanceSettingsPatch.mockResolvedValue(persisted);

    await setHandler({}, { uiSize: 15 });

    expect(allowedSend).toHaveBeenCalledWith('appearance-settings:changed', persisted);
    expect(deniedSend).not.toHaveBeenCalled();
  });

  it('accepts a validated wallpaper patch', async () => {
    const setHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:set-patch',
    )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
    mocks.writeAppearanceSettingsPatch.mockResolvedValue(persisted);

    await setHandler(
      {},
      {
        wallpaperId: 'cindy-window',
        wallpaperOverlay: 0.35,
      },
    );

    expect(mocks.writeAppearanceSettingsPatch).toHaveBeenCalledWith({
      wallpaperId: 'cindy-window',
      wallpaperOverlay: 0.35,
    });
  });
  it.each(['cindy', 'cindy-portrait', 'aurora', 'sunset', 'paper'])(
    'rejects retired wallpaper %s at the write boundary',
    async (wallpaperId) => {
      const setHandler = mocks.ipcHandle.mock.calls.find(
        ([channel]) => channel === 'appearance-settings:set-patch',
      )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
      await expect(setHandler({}, { wallpaperId })).rejects.toThrow('wallpaperId is not supported');
    },
  );
  const getSetHandler = () => mocks.ipcHandle.mock.calls.find(
    ([channel]) => channel === 'appearance-settings:set-patch',
  )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;

  it('accepts only terminal font fields while preserving the existing write authorization', async () => {
    const event = {};
    await getSetHandler()(event, { terminalFamily: '  Menlo  ', terminalSize: 30 });
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalledWith(event);
    expect(mocks.writeAppearanceSettingsPatch).toHaveBeenCalledExactlyOnceWith({
      terminalFamily: 'Menlo', terminalSize: 24,
    });
  });

  it.each([
    { terminalFamily: 1 }, { terminalFamily: 'x'.repeat(257) },
    { terminalSize: '13' }, { terminalSize: NaN }, { terminalSize: Infinity },
    { terminalTheme: 'dark' }, null, [],
  ])('rejects malformed or unapproved terminal appearance patch %j before writing', async (patch) => {
    await expect(getSetHandler()({}, patch)).rejects.toThrow('[INVALID_PARAMS]');
    expect(mocks.writeAppearanceSettingsPatch).not.toHaveBeenCalled();
  });

  it('does not grant read-only windows or untrusted senders terminal settings write access', async () => {
    mocks.assertTrustedAppRendererEvent.mockImplementation(() => {
      throw new Error('untrusted app renderer');
    });
    await expect(getSetHandler()({}, { terminalFamily: 'Menlo', terminalSize: 16 }))
      .rejects.toThrow('untrusted app renderer');
    expect(mocks.writeAppearanceSettingsPatch).not.toHaveBeenCalled();
  });
});
