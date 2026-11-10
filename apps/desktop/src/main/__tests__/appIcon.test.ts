import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
const state = vi.hoisted(() => ({ dock: vi.fn(), empty: false, decode: vi.fn(), windows: [] as Array<{ setIcon: ReturnType<typeof vi.fn> }> }));
vi.mock('electron', () => ({ app: { isPackaged: true, dock: { setIcon: state.dock } }, nativeTheme: { shouldUseDarkColors: false },
  BrowserWindow: { getAllWindows: () => state.windows }, nativeImage: { createFromBuffer: (...args: unknown[]) => {
    state.decode(...args); return { isEmpty: () => state.empty };
  } } }));
vi.mock('../appearance-settings-store.js', () => ({ readAppearanceSettings: () => ({ appIcon: 'default' }) }));
vi.mock('../resolved-app-theme.js', () => ({ resolveAppThemeIsDark: () => false }));
vi.mock('../windowFocusClassifier.js', () => ({ isAppContentWindow: () => true }));
import { applyDockIcon, applyPluginAppIcon, applyPluginAppIconToWindow } from '../app-icon';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../shared/appearanceSettings';

// #8909/#9093：正式包默认启动不可覆盖 bundle 图标；有效自有图片才可换图，空 NativeImage 保留原图。
// 本文件隔离 Electron 原生副作用；真实资源解码由 pluginAppearanceService.test 覆盖。tier: unit。
// 模拟平台只选择原生 API 分支，不断言平台路径算法，路径继续由宿主 path.join 构造。
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: path.join(os.tmpdir(), 'cindy-icon-resources') });
  state.empty = false; state.dock.mockClear(); state.decode.mockClear(); state.windows = [{ setIcon: vi.fn() }];
});
afterEach(() => {
  applyPluginAppIcon(null); Object.defineProperty(process, 'platform', platform);
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath); else Reflect.deleteProperty(process, 'resourcesPath');
});

it('leaves the packaged default icon untouched without decoding or setting an image', () => {
  applyDockIcon(DEFAULT_APPEARANCE_SETTINGS);
  applyPluginAppIcon(null);
  expect(state.dock).not.toHaveBeenCalled(); expect(state.decode).not.toHaveBeenCalled();
});

it('sets an explicit custom image once and restores the packaged icon after reset', () => {
  const bytes = Buffer.from('approved image');
  applyPluginAppIcon(bytes); applyPluginAppIcon(bytes);
  expect(state.dock).toHaveBeenCalledTimes(1); expect(state.decode).toHaveBeenCalledTimes(1);
  applyPluginAppIcon(null);
  expect(state.dock).toHaveBeenCalledTimes(2);
  expect(state.dock.mock.calls.at(-1)![0]).toEqual(expect.stringContaining('icon-dock.png'));
});

it('preserves a valid image if native decoding returns an empty replacement', () => {
  applyPluginAppIcon(Buffer.from('valid image'));
  state.empty = true;
  expect(() => applyPluginAppIcon(Buffer.from('invalid replacement'))).toThrow('APP_ICON_INVALID_IMAGE');
  expect(state.dock).toHaveBeenCalledTimes(1);
});

it('applies Windows icons to existing and newly focused content windows without repeating the same write', () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  applyPluginAppIcon(Buffer.from('Windows image'));
  const first = state.windows[0];
  applyPluginAppIconToWindow(first as unknown as BrowserWindow);
  expect(first.setIcon).toHaveBeenCalledTimes(1);
  const second = { setIcon: vi.fn() }; state.windows.push(second);
  applyPluginAppIconToWindow(second as unknown as BrowserWindow);
  expect(second.setIcon).toHaveBeenCalledTimes(1);
  expect(state.dock).not.toHaveBeenCalled();
  applyPluginAppIcon(null);
  expect(first.setIcon).toHaveBeenCalledTimes(2); expect(second.setIcon).toHaveBeenCalledTimes(2);
});
