import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
const { nativeTheme } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return { nativeTheme: new EventEmitter() };
});
vi.mock('electron', () => ({ nativeTheme }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock('../windowsTaskbarNative', () => ({ loadWindowsTaskbarNative: vi.fn() }));
import { resetWindowsWindowDarkModeForTest, setWindowsWindowDarkMode } from '../windowsWindowDarkMode';

/** In-memory window with the same close lifetime as a BrowserWindow. */
class Window extends EventEmitter {
  destroyed = false;
  handle = Buffer.alloc(8, Math.floor(Math.random() * 255));
  getNativeWindowHandle = () => this.handle;
  isDestroyed = () => this.destroyed;
  close() {
    this.destroyed = true;
    this.emit('closed');
  }
}
const asWindow = (win: Window) => win as unknown as BrowserWindow;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const originalPlatform = process.platform;

// Unit: the Windows 11 backdrop tint follows the window's own mode, and Electron
// resets that mode from the Windows setting whenever the setting changes. These
// cases cover loading races, re-assertion after that reset and failure fallback.
describe('Windows window dark mode', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    resetWindowsWindowDarkModeForTest();
    mocks.warn.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    resetWindowsWindowDarkModeForTest();
  });

  it('applies the latest theme once the addon loads and re-asserts it after a Windows theme change', async () => {
    const setWindowDarkMode = vi.fn(() => true);
    const load = vi.fn(async () => ({ setWindowDarkMode }) as never);
    const main = new Window(), side = new Window();
    setWindowsWindowDarkMode(asWindow(main), false, load);
    setWindowsWindowDarkMode(asWindow(main), true, load);
    setWindowsWindowDarkMode(asWindow(side), true, load);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(setWindowDarkMode.mock.calls).toEqual(
      expect.arrayContaining([[main.handle, true], [side.handle, true]]),
    );
    expect(setWindowDarkMode).not.toHaveBeenCalledWith(main.handle, false);
    setWindowDarkMode.mockClear();
    side.close();
    nativeTheme.emit('updated');
    await flush();
    expect(setWindowDarkMode.mock.calls).toEqual([[main.handle, true]]);
    main.close();
    expect(nativeTheme.listenerCount('updated')).toBe(0);
  });

  it('keeps the Windows-derived mode, without reloading, when the addon is unavailable', async () => {
    const load = vi.fn(async () => { throw new Error('no cargo'); });
    const win = new Window();
    setWindowsWindowDarkMode(asWindow(win), true, load);
    await flush();
    setWindowsWindowDarkMode(asWindow(win), false, load);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside Windows or for destroyed windows', async () => {
    const load = vi.fn();
    const win = new Window();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    setWindowsWindowDarkMode(asWindow(win), true, load);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    win.destroyed = true;
    setWindowsWindowDarkMode(asWindow(win), true, load);
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(nativeTheme.listenerCount('updated')).toBe(0);
  });
});
