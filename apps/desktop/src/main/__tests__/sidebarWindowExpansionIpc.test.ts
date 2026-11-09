/** Unit IPC boundary: the new native window operation must reject untrusted senders and
 * invalid geometry before touching a window. Existing window-control tests do not register
 * this channel; minimal failures are an untrusted frame or a non-finite width.
 */
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handle: vi.fn(), guard: vi.fn(), from: vi.fn(), update: vi.fn(), adopt: vi.fn(), appOn: vi.fn(), trusted: vi.fn(), windows: vi.fn(() => []) }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle },
  BrowserWindow: { fromWebContents: mocks.from, getAllWindows: mocks.windows },
  app: { on: mocks.appOn },
  screen: { getDisplayMatching: () => ({ workArea: {} }) },
}));
vi.mock('../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: mocks.guard, isTrustedAppRendererWindow: mocks.trusted }));
vi.mock('../sidebarWindowExpansion', () => ({ SidebarWindowExpansion: class { update = mocks.update; adopt = mocks.adopt; } }));
import { registerSidebarWindowExpansionIpc } from '../sidebarWindowExpansionIpc';
beforeEach(() => { vi.resetAllMocks(); mocks.windows.mockReturnValue([]); registerSidebarWindowExpansionIpc(); });
it('rejects untrusted frames before touching a window', () => {
  mocks.guard.mockImplementation(() => { throw new Error('untrusted'); });
  expect(() => mocks.handle.mock.calls[0][1]({}, 400)).toThrow('untrusted');
  expect(mocks.from).not.toHaveBeenCalled();
});
it.each([NaN, Infinity, -1, 16001, '400', null])('rejects invalid width %s', (width) => {
  expect(() => mocks.handle.mock.calls[0][1]({}, width)).toThrow();
  expect(mocks.from).not.toHaveBeenCalled();
});
it('uses only the sending window', () => {
  const sender = {};
  const win = { isDestroyed: () => false, getBounds: () => ({}), webContents: { getZoomFactor: () => 1 } };
  mocks.from.mockReturnValue(win);
  mocks.handle.mock.calls[0][1]({ sender }, 400);
  expect(mocks.from).toHaveBeenCalledWith(sender);
  expect(mocks.update).toHaveBeenCalledWith(win, 400, {}, undefined);
});
it('validates restoration and shrink inputs before accessing native windows', () => {
  const handle = mocks.handle.mock.calls[0][1];
  for (const invalid of [NaN, Infinity, -1, 16001, '300', null]) {
    expect(() => handle({}, 0, invalid)).toThrow();
  }
  expect(() => handle({}, 0, 300, 'true')).toThrow();
  expect(mocks.from).not.toHaveBeenCalled();
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1 } };
  mocks.from.mockReturnValue(win);
  handle({}, 0, 301, true);
  expect(mocks.adopt).toHaveBeenCalledWith(win, 301);
  expect(mocks.update).not.toHaveBeenCalled();
});

it('converts CSS pixels to native pixels at the IPC boundary under page zoom', () => {
  const win = { isDestroyed: () => false, getBounds: () => ({}), webContents: { getZoomFactor: () => 2 } };
  mocks.from.mockReturnValue(win);
  mocks.update.mockReturnValue(400);
  expect(mocks.handle.mock.calls[0][1]({}, 200, 100)).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith(win, 400, {}, 200);
});

it('only reports explicit horizontal resizing, not programmatic/fullscreen changes', () => {
  const events = new Map<string, (...args: any[]) => void>();
  const send = vi.fn();
  const win = { on: (event: string, callback: (...args: any[]) => void) => events.set(event, callback),
    getBounds: () => ({ width: 1000 }), isDestroyed: () => false,
    isMaximized: vi.fn(() => false), isFullScreen: () => false, isSimpleFullScreen: () => false,
    webContents: { send },
  };
  mocks.trusted.mockReturnValue(true);
  mocks.appOn.mock.calls[0][1]({}, win);
  events.get('resized')!();
  expect(send).not.toHaveBeenCalled();
  events.get('will-resize')!({}, { width: 1200 });
  events.get('resized')!();
  expect(send).toHaveBeenCalledOnce();
  events.get('will-resize')!({}, { width: 1400 });
  win.isMaximized.mockReturnValue(true);
  events.get('resized')!();
  expect(send).toHaveBeenCalledOnce();
});
