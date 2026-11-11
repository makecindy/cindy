// 测试价值：Cindy 自己的页面（远程设备画面页签）拿触控板真实双指的入口——只在 macOS、窗口在前台时
// 启动，只把形状合法的采样交给发起的那个页面，别的页面不能替它停止。既有用例只覆盖 webview 访客路径。
// 最小输入：一个假的原生模块与页面 sender；unit tier。
import { beforeEach, expect, it, vi } from 'vitest';
import { NATIVE_TRACKPAD_HOST } from '../../shared/nativeTrackpad';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }) => unknown>(),
  focused: true,
  native: {
    start: vi.fn<(handle: unknown, callback: (frame: string) => void) => number | null>(() => 7),
    stop: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: never) => fixture.handlers.set(name, fn) },
  BrowserWindow: {
    fromWebContents: () => ({
      isDestroyed: () => false,
      isFocused: () => fixture.focused,
      getNativeWindowHandle: () => Buffer.alloc(8),
    }),
  },
}));
vi.mock('../nativeTrackpad', () => ({ loadNativeTrackpad: () => fixture.native }));
vi.mock('../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: () => {} }));

import { registerNativeTrackpadHostIpc } from '../nativeTrackpadHost';

const page = () => ({ isDestroyed: () => false, send: vi.fn() });
beforeEach(() => {
  fixture.handlers.clear();
  fixture.focused = true;
  fixture.native.start.mockClear();
  fixture.native.stop.mockClear();
});

it('hands a front window its own two-finger samples and nothing malformed', async () => {
  registerNativeTrackpadHostIpc('darwin');
  const start = fixture.handlers.get(NATIVE_TRACKPAD_HOST.START)!;
  const stop = fixture.handlers.get(NATIVE_TRACKPAD_HOST.STOP)!;
  const sender = page();
  fixture.focused = false;
  expect(start({ sender })).toBe(false);
  fixture.focused = true;
  expect(start({ sender })).toBe(true);
  const deliver = fixture.native.start.mock.calls[0][1];
  const frame = {
    phase: 'begin',
    width: 160,
    height: 100,
    touches: [
      { id: 0, x: 0.4, y: 0.5 },
      { id: 1, x: 0.6, y: 0.5 },
    ],
  };
  deliver(JSON.stringify(frame));
  deliver('not json');
  deliver(JSON.stringify({ ...frame, touches: [{ id: 5, x: 2, y: 0 }] }));
  expect(sender.send.mock.calls).toEqual([[NATIVE_TRACKPAD_HOST.FRAME, frame]]);
  // Another page cannot end this page's capture; the page itself can.
  stop({ sender: page() });
  expect(fixture.native.stop).not.toHaveBeenCalled();
  stop({ sender });
  expect(fixture.native.stop).toHaveBeenCalledExactlyOnceWith(7);
});

it('does nothing on other platforms', () => {
  registerNativeTrackpadHostIpc('win32');
  expect(fixture.handlers.get(NATIVE_TRACKPAD_HOST.START)!({ sender: page() })).toBe(false);
  expect(fixture.native.start).not.toHaveBeenCalled();
});
