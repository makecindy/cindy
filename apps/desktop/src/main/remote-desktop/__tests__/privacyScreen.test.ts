import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as any[], displays: [] as any[], confirm: vi.fn() }));
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
  screen: Object.assign(new EventEmitter(), {
    getAllDisplays: () => state.displays,
    getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
  }),
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
import { screen } from 'electron';
beforeEach(() => {
  screen.removeAllListeners();
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }];
  state.windows.length = 0;
  state.confirm.mockReset().mockResolvedValue({ response: 1 });
});

it('relayouts the non-captured display and releases its listeners on stop', async () => {
  state.displays.push({ id: 2, bounds: { x: 1440, y: 0, width: 900, height: 1200 } });
  const h = fixture();
  await h.masks.set(true, () => true);
  const second = state.windows[1];
  const bounds = { x: -2000, y: -100, width: 2000, height: 1400 };
  screen.emit('display-metrics-changed', {}, { id: 2, bounds }, [
    'bounds',
    'rotation',
    'scaleFactor',
  ]);
  expect(second.getBounds()).toEqual(bounds);
  expect(state.windows[0].getBounds()).toEqual(state.displays[0].bounds);
  expect(h.stopped).not.toHaveBeenCalled();
  h.stopped.mockReturnValue(new Promise(() => {}));
  h.failed();
  const lockingBounds = { ...bounds, x: 2000 };
  screen.emit('display-metrics-changed', {}, { id: 2, bounds: lockingBounds }, ['bounds']);
  expect(second.getBounds()).toEqual(lockingBounds);
  h.masks.stop();
  expect(screen.listenerCount('display-metrics-changed')).toBe(0);
});

function fixture() {
  const stopped = vi.fn();
  const excluded = vi.fn();
  const resume = vi.fn(async () => {});
  const suspend = vi.fn(async () => resume);
  const monitor = {
    confirm: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
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
  expect(f.masks.active).toBe(false);
  const preparing = f.masks.set(true, () => true);
  expect(f.masks.active).toBe(true);
  await preparing;
  expect(f.masks.active).toBe(true);
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
  expect(f.masks.active).toBe(false);
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
  await settle();
  expect(f.stopped).toHaveBeenCalledOnce();
  expect(state.windows[0].destroyed).toBe(true);
});

it.each(['confirmed', 'watcher', 'renderer'] as const)(
  'retains masks and capture exclusions while %s disconnect waits for locking',
  async (reason) => {
    const f = fixture();
    let finish!: () => void;
    f.stopped.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await f.masks.set(true, () => true);
    const window = state.windows[0];
    if (reason === 'confirmed') f.local();
    else if (reason === 'watcher') f.failed();
    else window.webContents.emit('render-process-gone');
    await settle();
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(false);
    expect(f.excluded).toHaveBeenLastCalledWith([window.id]);
    expect(f.resume).not.toHaveBeenCalled();
    f.failed();
    expect(f.stopped).toHaveBeenCalledOnce();
    finish();
    await settle();
    expect(window.destroyed).toBe(true);
    expect(f.excluded).toHaveBeenLastCalledWith([]);
    expect(f.resume).not.toHaveBeenCalled();
  },
);

it('does not clear replacement masks when an old disconnect rejects late', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.stopped.mockImplementation(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  await f.masks.set(true, () => true);
  f.local();
  await settle();
  f.masks.stop();
  await f.masks.set(true, () => true);
  const replacement = state.windows[1];
  reject(new Error('lock failed'));
  await settle();
  expect(replacement.destroyed).toBe(false);
  expect(f.excluded).toHaveBeenLastCalledWith([replacement.id]);
  f.masks.stop();
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

it.each(['confirmed', 'watcher', 'renderer'] as const)(
  'waits for hook exit before locking, with masks retained: %s',
  async (reason) => {
    const f = fixture();
    let unhook!: () => void;
    f.monitor.stop.mockReturnValue(
      new Promise<void>((resolve) => {
        unhook = resolve;
      }),
    );
    await f.masks.set(true, () => true);
    const window = state.windows[0];
    if (reason === 'confirmed') f.local();
    else if (reason === 'watcher') f.failed();
    else window.webContents.emit('render-process-gone');
    await settle();
    expect(f.monitor.stop).toHaveBeenCalledOnce();
    expect(f.stopped).not.toHaveBeenCalled();
    expect(window.destroyed).toBe(false);
    expect(f.excluded).toHaveBeenLastCalledWith([window.id]);
    unhook();
    await settle();
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
  },
);

it('does not lock a replacement lease after delayed old hook teardown', async () => {
  const f = fixture();
  let unhook!: () => void;
  f.monitor.stop.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      unhook = resolve;
    }),
  );
  await f.masks.set(true, () => true);
  f.failed();
  f.masks.stop();
  await f.masks.set(true, () => true);
  unhook();
  await settle();
  expect(f.stopped).not.toHaveBeenCalled();
  expect(state.windows[1].destroyed).toBe(false);
  f.masks.stop();
});
