import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as any[], confirm: vi.fn() }));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) }));
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  dialog: { showMessageBox: state.confirm },
  BrowserWindow: class extends EventEmitter {
    id = state.windows.length + 1;
    destroyed = false;
    options: any;
    bounds = { x: 0, y: 25, width: 1440, height: 875 };
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      focus: vi.fn(),
    });
    constructor(options: any) {
      super();
      this.options = options;
      state.windows.push(this);
    }
    setMenuBarVisibility() {}
    async loadURL() {}
    setContentProtection() {}
    setIgnoreMouseEvents = vi.fn();
    setFocusable = vi.fn();
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop() {}
    getMediaSourceId() {
      return `window:${this.id}:0`;
    }
    getBounds() {
      return this.bounds;
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
    showInactive() {}
    focus = vi.fn();
    isVisible() {
      return true;
    }
    isFocused() {
      return true;
    }
    isAlwaysOnTop() {
      return true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  },
  screen: {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      webRequest: { onBeforeRequest() {} },
    }),
  },
}));

import { PrivacyScreen } from '../privacyScreen';
beforeEach(() => {
  state.windows.length = 0;
  state.confirm.mockReset().mockResolvedValue({ response: 1 });
});

function fixture() {
  const stopped = vi.fn();
  const excluded = vi.fn();
  const resume = vi.fn(async () => {});
  const suspend = vi.fn(async () => resume);
  const monitor = { confirm: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn() };
  let local!: () => void;
  let failed!: () => void;
  const masks = new PrivacyScreen(excluded, stopped, suspend, async (onLocal, onFailed) => {
    local = onLocal;
    failed = onFailed;
    return monitor;
  });
  return {
    masks,
    stopped,
    excluded,
    suspend,
    resume,
    monitor,
    local: () => local(),
    failed: () => failed(),
  };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it('keeps the full-display mask passive so injected input reaches underlying apps', async () => {
  const f = fixture();
  await f.masks.set(true, () => true);
  const window = state.windows[0];
  expect(window.options).toMatchObject({
    enableLargerThanScreen: true,
    roundedCorners: false,
    focusable: false,
  });
  expect(window.getBounds()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  expect(window.focus).not.toHaveBeenCalled();
  window.webContents.emit('before-mouse-event', {}, { type: 'mouseDown' });
  window.webContents.emit('before-input-event', {}, { type: 'keyDown' });
  expect(state.confirm).not.toHaveBeenCalled();
  f.masks.stop();
  expect(f.monitor.stop).toHaveBeenCalledOnce();
});

it('drains remote input and fences late injection before showing one local confirmation', async () => {
  const f = fixture();
  let drained!: () => void;
  f.suspend.mockImplementation(
    () =>
      new Promise((resolve) => {
        drained = () => resolve(f.resume);
      }),
  );
  await f.masks.set(true, () => true);
  f.local();
  f.local();
  expect(f.suspend).toHaveBeenCalledOnce();
  expect(state.confirm).not.toHaveBeenCalled();
  drained();
  await settle();
  expect(f.monitor.confirm.mock.invocationCallOrder[0]).toBeLessThan(
    state.confirm.mock.invocationCallOrder[0],
  );
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(f.stopped).toHaveBeenCalledOnce();
  expect(state.windows[0].destroyed).toBe(true);
  expect(f.excluded).toHaveBeenLastCalledWith([]);
});

it('restores passive masking and input on cancel, but ignores an old dialog after replacement', async () => {
  const f = fixture();
  await f.masks.set(true, () => true);
  state.confirm.mockResolvedValueOnce({ response: 0 });
  f.local();
  await settle();
  expect(f.stopped).not.toHaveBeenCalled();
  expect(state.windows[0].setFocusable).toHaveBeenLastCalledWith(false);
  expect(state.windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  expect(f.monitor.resume).toHaveBeenCalledOnce();
  expect(f.resume).toHaveBeenCalledOnce();
  let finish!: (result: { response: number }) => void;
  state.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.local();
  await settle();
  f.masks.stop();
  await f.masks.set(true, () => true);
  finish({ response: 1 });
  await settle();
  expect(f.stopped).not.toHaveBeenCalled();
  expect(state.windows[1].destroyed).toBe(false);
  expect(f.monitor.resume).toHaveBeenCalledOnce();
  f.masks.stop();
});

it('does not open a stale dialog if disconnected while input is draining', async () => {
  const f = fixture();
  let drained!: () => void;
  f.suspend.mockImplementation(
    () =>
      new Promise((resolve) => {
        drained = () => resolve(f.resume);
      }),
  );
  await f.masks.set(true, () => true);
  f.local();
  f.masks.stop();
  drained();
  await settle();
  expect(state.confirm).not.toHaveBeenCalled();
  expect(f.monitor.confirm).not.toHaveBeenCalled();
});

it('ends the lease instead of leaving an inescapable mask when its native watcher fails', async () => {
  const f = fixture();
  await f.masks.set(true, () => true);
  f.failed();
  expect(f.stopped).toHaveBeenCalledOnce();
  expect(state.windows[0].destroyed).toBe(true);
});

it('does not expose the confirmation if the native injection fence fails', async () => {
  const f = fixture();
  await f.masks.set(true, () => true);
  f.monitor.confirm.mockRejectedValueOnce(new Error('unavailable'));
  f.local();
  await settle();
  expect(state.confirm).not.toHaveBeenCalled();
  expect(f.stopped).toHaveBeenCalledOnce();
});
