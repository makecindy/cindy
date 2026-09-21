import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  warn: vi.fn(),
  displays: vi.fn(),
  render: vi.fn((count: number, scale: number) => Buffer.from(`${count}@${scale}`)),
}));
const { screen } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return { screen: new EventEmitter() };
});
vi.mock('electron', () => ({ screen: Object.assign(screen, { getAllDisplays: mocks.displays }) }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock('../windowsTaskbarNative', () => ({ loadWindowsTaskbarNative: mocks.load }));
vi.mock('../windowsBadgeIcon', () => ({
  renderWindowsBadgePng: mocks.render,
  createWindowsBadgeIcon: (count: number) => (count > 0 ? `fallback:${count}` : null),
}));
import { setWindowsTaskbarBadge } from '../windowsTaskbarBadge';

/** In-memory window with the same event lifetime as a BrowserWindow. */
class Window extends EventEmitter {
  destroyed = false;
  setOverlayIcon = vi.fn();
  getNativeWindowHandle = () => Buffer.alloc(8, 1);
  isDestroyed = () => this.destroyed;
  hookWindowMessage = vi.fn();
  badge(count: number, description = `Attention: ${count}`) {
    setWindowsTaskbarBadge(this as unknown as BrowserWindow, count, count ? description : '');
  }
  close() {
    this.destroyed = true;
    this.emit('closed');
  }
}
const native = { setOverlayIcon: vi.fn(), taskbarButtonCreatedMessage: () => 0xc123 };
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const platform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  screen.removeAllListeners();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  mocks.displays.mockReturnValue([{ scaleFactor: 1.5 }]);
  mocks.load.mockResolvedValue(native);
  native.setOverlayIcon.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

describe('DPI-aware Windows taskbar badge', () => {
  it('delivers the densest monitor image directly to the Shell and keeps the exact count description', async () => {
    mocks.displays.mockReturnValue([{ scaleFactor: 1.25 }, { scaleFactor: 2.5 }]);
    const win = new Window();
    win.badge(123);
    await flush();
    expect(native.setOverlayIcon).toHaveBeenLastCalledWith(
      win.getNativeWindowHandle(),
      Buffer.from('123@2.5'),
      'Attention: 123',
    );
    win.setOverlayIcon.mockClear();
    win.badge(124);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
    expect(native.setOverlayIcon).toHaveBeenLastCalledWith(
      win.getNativeWindowHandle(),
      Buffer.from('124@2.5'),
      'Attention: 124',
    );
  });

  it('uses the latest count after loading, including clearing a badge while compilation is pending', async () => {
    let ready!: (value: typeof native) => void;
    mocks.load.mockReturnValue(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    const win = new Window();
    win.badge(3);
    win.badge(4);
    win.badge(0);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    ready(native);
    await flush();
    expect(native.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(native.setOverlayIcon).toHaveBeenLastCalledWith(win.getNativeWindowHandle(), null, '');
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('does not load native code for an empty badge or repaint a destroyed window', async () => {
    const empty = new Window();
    empty.badge(0);
    expect(mocks.load).not.toHaveBeenCalled();
    const win = new Window();
    win.badge(1);
    win.close();
    await flush();
    expect(native.setOverlayIcon).not.toHaveBeenCalled();
    expect(win.hookWindowMessage).not.toHaveBeenCalled();
    empty.close();
    expect(screen.eventNames()).toEqual([]);
  });

  it('redraws after display and Shell changes without changing or flashing the count', async () => {
    const win = new Window();
    win.badge(7);
    await flush();
    mocks.displays.mockReturnValue([{ scaleFactor: 1.75 }]);
    screen.emit('display-metrics-changed');
    expect(native.setOverlayIcon).toHaveBeenLastCalledWith(
      win.getNativeWindowHandle(),
      Buffer.from('7@1.75'),
      'Attention: 7',
    );
    native.setOverlayIcon.mockClear();
    win.hookWindowMessage.mock.calls[0][1]();
    await flush();
    expect(native.setOverlayIcon).toHaveBeenCalledTimes(1);
    win.close();
    expect(screen.eventNames()).toEqual([]);
  });

  it('falls back after load failure without repeated builds or warnings', async () => {
    mocks.load.mockRejectedValue(new Error('unavailable'));
    const win = new Window();
    win.badge(3);
    await flush();
    win.badge(4);
    win.badge(0);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
  });

  it('recovers from a transient native failure and can still clear the badge', async () => {
    const win = new Window();
    win.badge(2);
    await flush();
    native.setOverlayIcon.mockImplementationOnce(() => {
      throw new Error('Shell restarting');
    });
    win.badge(3);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith('fallback:3', 'Attention: 3');
    win.badge(0);
    expect(native.setOverlayIcon).toHaveBeenLastCalledWith(win.getNativeWindowHandle(), null, '');
  });

  it('leaves non-Windows platforms untouched', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const win = new Window();
    win.badge(2);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
    expect(screen.eventNames()).toEqual([]);
  });
});
