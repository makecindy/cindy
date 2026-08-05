import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.allWindows },
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

import { registerAppearanceSettingsIpc } from '../appearance-settings-ipc.js';

const persisted = {
  uiFamily: 'Inter',
  codeFamily: 'JetBrains Mono',
  uiSize: 15,
  codeSize: 14,
  windowZoom: 1.1,
};

describe('appearance settings IPC authorization', () => {
  beforeAll(() => {
    registerAppearanceSettingsIpc();
  });

  beforeEach(() => {
    mocks.allWindows.length = 0;
    mocks.trustedRead.mockReset();
    mocks.trustedReadWindow.mockReset().mockReturnValue(false);
    mocks.assertTrustedAppRendererEvent.mockReset();
    mocks.readAppearanceSettings.mockReset().mockReturnValue(persisted);
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

    mocks.readAppearanceSettingsState.mockReturnValue({ settings: persisted, overrides: {} });
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
});
