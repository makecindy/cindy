import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as any[], confirm: vi.fn() }));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug: vi.fn() }) }));
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
    setIgnoreMouseEvents() {}
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
    focus() {}
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

it.each([
  ['before-mouse-event', 'mouseDown'],
  ['before-input-event', 'keyDown'],
])('%s ends the connection once and consumes the local input', async (eventName, type) => {
  const stopped = vi.fn();
  const excluded = vi.fn();
  const masks = new PrivacyScreen(excluded, stopped);
  await masks.set(true, () => true);
  const window = state.windows[0];
  const event = { preventDefault: vi.fn() };
  window.webContents.emit(eventName, event, { type });
  window.webContents.emit(eventName, event, { type });
  expect(state.confirm).toHaveBeenCalledTimes(1);
  expect(stopped).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(window.destroyed).toBe(true);
  expect(excluded).toHaveBeenLastCalledWith([]);
});

it('keeps the mask and connection on cancel and ignores a stale confirmation', async () => {
  const stopped = vi.fn();
  const masks = new PrivacyScreen(vi.fn(), stopped);
  await masks.set(true, () => true);
  state.confirm.mockResolvedValueOnce({ response: 0 });
  const click = () =>
    state.windows[0].webContents.emit(
      'before-mouse-event',
      { preventDefault() {} },
      { type: 'mouseDown' },
    );
  click();
  await Promise.resolve();
  expect(state.windows[0].destroyed).toBe(false);
  expect(stopped).not.toHaveBeenCalled();
  let finish!: (result: { response: number }) => void;
  state.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click();
  masks.stop();
  await masks.set(true, () => true);
  finish({ response: 1 });
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  expect(state.windows[1].destroyed).toBe(false);
  masks.stop();
});

it('requests the entire display including the menu bar and accepts the first click', async () => {
  const masks = new PrivacyScreen(vi.fn(), vi.fn());
  await masks.set(true, () => true);
  expect(state.windows[0].options).toMatchObject({
    enableLargerThanScreen: true,
    acceptFirstMouse: true,
  });
  expect(state.windows[0].getBounds()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  masks.stop();
});
