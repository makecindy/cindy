import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi, type Mock } from 'vitest';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Options = Record<string, unknown> & { width: number; height: number };
interface FakeWindow extends EventEmitter {
  destroyed: boolean;
  options: Options;
  html: string;
  loadURL: Mock;
  webContents: EventEmitter & { executeJavaScript: Mock };
  setContentProtection: Mock;
  setAlwaysOnTop: Mock;
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
  isVisible(): boolean;
}

const state = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  displays: [] as Array<{ id: number; bounds: Bounds; workArea: Bounds }>,
  events: [] as string[],
  /** Optional per-load hook: return a promise to hold or fail a page load. */
  load: null as null | ((window: FakeWindow) => Promise<void> | void),
  confirm: vi.fn(),
  themeMode: 'system' as 'system' | 'light' | 'dark',
}));
vi.mock('../../i18n', () => ({
  t: (key: string) => (key.endsWith('ByDevice') ? `${key}:{{name}}` : key),
}));
vi.mock('../../window-theme-mode-store', () => ({
  readWindowThemeSnapshot: () => ({ mode: state.themeMode }),
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) }));
vi.mock('../privacyScreenHtml', () => ({
  escapeHtml: (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
    ),
}));
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  dialog: { showMessageBox: state.confirm },
  nativeTheme: { shouldUseDarkColors: false },
  BrowserWindow: class extends EventEmitter {
    id = state.windows.length + 1;
    destroyed = false;
    visible = false;
    html = '';
    options: Options;
    bounds: Bounds;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      // The page width follows the label that was actually loaded.
      executeJavaScript: vi.fn(async () =>
        this.html.includes('ByDevice') ? 240 : this.html.includes('beingControlled') ? 180 : 160,
      ),
    });
    constructor(options: Options) {
      super();
      this.options = options;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      state.windows.push(this as unknown as FakeWindow);
    }
    setMenuBarVisibility() {}
    loadURL = vi.fn(async (url: string) => {
      await state.load?.(this as unknown as FakeWindow);
      this.html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    });
    setContentProtection = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    getMediaSourceId() {
      return `window:${100 + this.id}:0`;
    }
    getBounds() {
      return this.bounds;
    }
    setBounds(bounds: Bounds) {
      this.bounds = bounds;
    }
    showInactive() {
      state.events.push(`show:${100 + this.id}`);
      this.visible = true;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  },
  screen: Object.assign(new EventEmitter(), {
    getAllDisplays: () => state.displays,
    getPrimaryDisplay: () => state.displays[0],
  }),
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      webRequest: { onBeforeRequest() {} },
    }),
  },
}));

import { screen } from 'electron';
import { ControlledOverlay } from '../controlledOverlay';

const primary = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
};
const secondary = {
  id: 2,
  bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1440, y: 0, width: 1920, height: 1040 },
};
const phone = { displayId: '1', controlling: true, peer: 'phone', name: 'iPhone' };
const laptop = { displayId: '1', controlling: true, peer: 'laptop', name: 'MacBook' };
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const excluded = vi.fn((ids: number[]) => state.events.push(`exclude:${ids.join(',')}`));
  const revoke = vi.fn<(peer: string) => Promise<void>>(async () => {});
  return { overlay: new ControlledOverlay(excluded, revoke), excluded, revoke };
}
const navigate = (window: FakeWindow, url: string) => {
  const event = { url, preventDefault: vi.fn() };
  window.webContents.emit('will-navigate', event);
  return event;
};
/** Clicks the revoke link of the page the window currently shows. */
const clickRevoke = (window: FakeWindow) => {
  const href = /<a href="([^"]+)"/.exec(window.html)?.[1].replaceAll('&amp;', '&');
  return navigate(window, href!);
};

beforeEach(() => {
  screen.removeAllListeners();
  state.windows.length = 0;
  state.events.length = 0;
  state.displays = [primary, secondary];
  state.load = null;
  state.confirm.mockReset().mockResolvedValue({ response: 1 });
  state.themeMode = 'system';
});

it('filters the overlay from capture before its first visible frame', async () => {
  const { overlay } = fixture();
  overlay.update({ displayId: '1', controlling: false, peer: 'phone' });
  await settle();
  const [window] = state.windows;
  expect(window.options).toMatchObject({
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: expect.objectContaining({ sandbox: true, contextIsolation: true }),
  });
  expect(window.options.closable).toBeUndefined();
  expect(window.setContentProtection).toHaveBeenCalledWith(true);
  expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  expect(state.events).toEqual(['exclude:101', 'show:101']);
  expect(window.html).toContain('remoteDesktop.beingViewed');
  // Measured pill width, centred under the top of the shared display's work area.
  expect(window.getBounds()).toEqual({ x: 640, y: 37, width: 160, height: 28 });
});

it('reloads the label in place when control is granted', async () => {
  const { overlay, excluded } = fixture();
  overlay.update({ displayId: '1', controlling: false, peer: 'phone' });
  await settle();
  overlay.update({ displayId: '1', controlling: true, peer: 'phone' });
  await settle();
  expect(state.windows).toHaveLength(1);
  expect(state.windows[0].html).toContain('remoteDesktop.beingControlled');
  expect(state.windows[0].getBounds()).toMatchObject({ x: 640, width: 180 });
  expect(excluded).toHaveBeenCalledTimes(1);
});

it('keeps a dragged overlay on the shared display and remembers it for the run', async () => {
  const { overlay } = fixture();
  const target = { displayId: '1', controlling: true, peer: 'phone' };
  overlay.update(target);
  await settle();
  const window = state.windows[0];
  window.setBounds({ x: 1400, y: 500, width: 180, height: 28 });
  window.emit('moved');
  expect(window.getBounds()).toEqual({ x: 1260, y: 500, width: 180, height: 28 });
  overlay.update(null);
  overlay.update(target);
  await settle();
  expect(state.windows[1].getBounds()).toEqual({ x: 1260, y: 500, width: 180, height: 28 });
  // A lease on another display starts from that display's default spot.
  overlay.update({ ...target, displayId: '2' });
  await settle();
  expect(state.windows[1].getBounds()).toEqual({ x: 2310, y: 12, width: 180, height: 28 });
});

it('removes the window and its capture filter when the lease or privacy ends it', async () => {
  const { overlay, excluded } = fixture();
  overlay.update(phone);
  await settle();
  overlay.update(null);
  expect(state.windows[0].destroyed).toBe(true);
  expect(excluded).toHaveBeenLastCalledWith([]);
  expect(screen.listenerCount('display-metrics-changed')).toBe(0);
  overlay.update(null);
  expect(excluded).toHaveBeenCalledTimes(2);
});

it('never shows or filters a window whose lease ended while it loaded', async () => {
  let finish!: () => void;
  state.load = () => new Promise<void>((resolve) => (finish = resolve));
  const { overlay, excluded } = fixture();
  overlay.update(phone);
  overlay.update(null);
  finish();
  await settle();
  expect(state.windows[0].destroyed).toBe(true);
  expect(state.windows[0].isVisible()).toBe(false);
  expect(excluded).not.toHaveBeenCalledWith([101]);
});

it('drops the filter if the renderer dies and recreates on the next sync', async () => {
  const { overlay, excluded } = fixture();
  overlay.update(phone);
  await settle();
  state.windows[0].webContents.emit('render-process-gone');
  expect(excluded).toHaveBeenLastCalledWith([]);
  overlay.update(phone);
  await settle();
  expect(state.events.at(-1)).toBe('show:102');
});

it('renders the viewing device name as escaped markup and skips unchanged targets', async () => {
  const { overlay, revoke } = fixture();
  const target = { displayId: '1', controlling: true, peer: 'p&1', name: 'x</span><b>y' };
  overlay.update(target);
  await settle();
  const window = state.windows[0];
  expect(window.html).toContain('remoteDesktop.controlledByDevice:x&lt;/span&gt;&lt;b&gt;y');
  expect(window.html).not.toContain('<b>');
  expect(window.html).toContain('remoteDevice.revokeAccess');
  expect(window.getBounds()).toMatchObject({ x: 600, width: 240 });
  // Only constant code is ever executed in the page.
  expect(new Set(window.webContents.executeJavaScript.mock.calls.map(([code]) => code)).size).toBe(
    1,
  );
  overlay.update({ ...target });
  await settle();
  expect(window.loadURL).toHaveBeenCalledTimes(1);
  clickRevoke(window);
  await settle();
  expect(revoke).toHaveBeenCalledExactlyOnceWith('p&1');
});

it('revokes the device named on the clicked page, only after confirmation', async () => {
  const { overlay, revoke } = fixture();
  overlay.update(phone);
  await settle();
  const window = state.windows[0];
  state.confirm.mockResolvedValueOnce({ response: 0 });
  expect(clickRevoke(window).preventDefault).toHaveBeenCalled();
  await settle();
  expect(revoke).not.toHaveBeenCalled();

  // The lease moves to another viewer, but its page is still loading.
  let finishLoad!: () => void;
  state.load = () => new Promise<void>((resolve) => (finishLoad = resolve));
  overlay.update(laptop);
  // The periodic sync repeats the same target while it loads.
  overlay.update(laptop);
  await settle();
  expect(window.loadURL).toHaveBeenCalledTimes(2);
  let answer!: (value: { response: number }) => void;
  state.confirm.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  clickRevoke(window);
  // A second click while the dialog is open does not stack another dialog.
  clickRevoke(window);
  answer({ response: 1 });
  await settle();
  expect(state.confirm).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledExactlyOnceWith('phone');

  finishLoad();
  await settle();
  clickRevoke(window);
  await settle();
  expect(revoke).toHaveBeenLastCalledWith('laptop');
});

it('cancels every other navigation without acting', async () => {
  const { overlay, revoke } = fixture();
  overlay.update(phone);
  await settle();
  expect(navigate(state.windows[0], 'https://example.com/').preventDefault).toHaveBeenCalled();
  expect(
    navigate(state.windows[0], 'https://cindy-overlay.invalid/revoke?peer=').preventDefault,
  ).toHaveBeenCalled();
  await settle();
  expect(state.confirm).not.toHaveBeenCalled();
  expect(revoke).not.toHaveBeenCalled();
});

it('stops recreating after repeated renderer crashes until the lease ends', async () => {
  const { overlay } = fixture();
  for (let i = 0; i < 3; i++) {
    overlay.update(phone);
    await settle();
    state.windows.at(-1)!.webContents.emit('render-process-gone');
  }
  overlay.update(phone);
  await settle();
  expect(state.windows).toHaveLength(3);
  overlay.update(null);
  overlay.update(phone);
  await settle();
  expect(state.windows).toHaveLength(4);
});

it('does not charge a lease for loads aborted by a newer page or an earlier lease', async () => {
  const { overlay } = fixture();
  // An earlier lease ends mid-load; its aborted load must not count later.
  let abortFirst!: (error: Error) => void;
  state.load = () => new Promise<void>((_, reject) => (abortFirst = reject));
  overlay.update(phone);
  overlay.update(null);
  state.load = null;
  overlay.update(laptop);
  abortFirst(new Error('ERR_ABORTED'));
  await settle();
  expect(state.events.at(-1)).toBe('show:102');
  // A newer label aborts the pending one; the overlay stays up.
  const window = state.windows[1];
  let abortPending!: (error: Error) => void;
  state.load = () => new Promise<void>((_, reject) => (abortPending = reject));
  overlay.update(phone);
  state.load = null;
  overlay.update({ ...phone, controlling: false });
  abortPending(new Error('ERR_ABORTED'));
  await settle();
  expect(window.destroyed).toBe(false);
  expect(window.html).toContain('remoteDesktop.viewedByDevice');
  for (let i = 0; i < 2; i++) {
    overlay.update(laptop);
    await settle();
    state.windows.at(-1)!.webContents.emit('render-process-gone');
  }
  // Two real crashes so far: one more recreation is still allowed.
  overlay.update(laptop);
  await settle();
  expect(state.windows.at(-1)!.isVisible()).toBe(true);
});

it('never shows a window whose first page could not be measured', async () => {
  const { overlay, excluded } = fixture();
  state.load = (window) => {
    window.webContents.executeJavaScript.mockRejectedValueOnce(new Error('x'));
  };
  overlay.update(phone);
  await settle();
  expect(state.windows[0].destroyed).toBe(true);
  expect(state.windows[0].isVisible()).toBe(false);
  expect(excluded).not.toHaveBeenCalledWith([101]);
});

it("follows Cindy's selected appearance rather than only the OS", async () => {
  const { overlay } = fixture();
  state.themeMode = 'dark';
  overlay.update(phone);
  await settle();
  const window = state.windows[0];
  expect(window.html).toContain('<html class="dark">');
  state.themeMode = 'light';
  overlay.update(phone);
  await settle();
  expect(window.html).toContain('<html>');
});

it('does not fail when a newer page interrupts the previous measurement', async () => {
  const { overlay } = fixture();
  overlay.update(phone);
  await settle();
  const window = state.windows[0];
  let interrupt!: (error: Error) => void;
  window.webContents.executeJavaScript.mockImplementationOnce(
    () => new Promise((_, reject) => (interrupt = reject)),
  );
  overlay.update(laptop);
  await settle();
  overlay.update({ ...laptop, controlling: false });
  interrupt(new Error('Execution context was destroyed'));
  await settle();
  expect(window.destroyed).toBe(false);
  expect(window.html).toContain('remoteDesktop.viewedByDevice:MacBook');
});
