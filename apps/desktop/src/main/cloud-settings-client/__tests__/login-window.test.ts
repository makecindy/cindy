import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudLoginWindow } from '../login-window';
import { CLOUD_LOGIN_WINDOW } from '../../../shared/cloudLoginWindow';

// Unit: login is its own window, never a route covering the entire workspace. Exercise the
// real auxiliary controller composition, including close vs minimize, identity
// fencing and recovery; neither local login nor resource-monitor tests do this.
function createWindow(id: number) {
  let destroyed = false,
    visible = false;
  const wc = Object.assign(new EventEmitter(), { id, send: vi.fn(), isDestroyed: () => destroyed });
  const win = Object.assign(new EventEmitter(), {
    webContents: wc,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => false,
    isFullScreen: () => false,
    show: vi.fn(() => {
      visible = true;
      win.emit('show');
    }),
    focus: vi.fn(),
    restore: vi.fn(),
    setTitle: vi.fn(),
    hide: vi.fn(() => {
      visible = false;
      win.emit('hide');
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      wc.emit('destroyed');
      win.emit('closed');
    }),
  });
  return win;
}

function harness() {
  let owner: string | undefined = 'account-a';
  const windows: ReturnType<typeof createWindow>[] = [];
  const opener = Object.assign(new EventEmitter(), {
    id: 10,
    send: vi.fn(),
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const invalidate = vi.fn();
  const authorize = vi.fn(async (_sender: WebContents, deviceId: string) => ({
    deviceId,
    name: null,
    ordinal: null,
  }));
  const manager = new CloudLoginWindow({
    createWindow: () => {
      const win = createWindow(windows.length + 100);
      windows.push(win);
      return win as unknown as BrowserWindow;
    },
    isOpenSender: (sender) => sender === opener,
    ownerKey: () => owner,
    authorize,
    invalidate,
    title: () => 'Cloud login',
  });
  const sender = () => windows.at(-1)!.webContents as unknown as WebContents;
  const ready = () => {
    manager.controller.markRendererReady(sender());
    manager.controller.markPresentationReady(sender());
  };
  return {
    manager,
    windows,
    opener,
    sender,
    ready,
    invalidate,
    authorize,
    setOwner(v?: string) {
      owner = v;
    },
  };
}
let f: ReturnType<typeof harness>;
beforeEach(() => {
  vi.useFakeTimers();
  f = harness();
});
afterEach(() => {
  f.manager.destroy();
  vi.useRealTimers();
});

it('shows the login window only after shell and presentation readiness', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  expect(f.windows[0].show).not.toHaveBeenCalled();
  f.manager.controller.markRendererReady(f.sender());
  expect(f.windows[0].show).not.toHaveBeenCalled();
  f.manager.controller.markPresentationReady(f.sender());
  expect(f.windows[0].show).toHaveBeenCalledOnce();
});
it('keeps login while minimized or covered; close resets and reuses the same window', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  f.ready();
  const generation = f.manager.state().generation;
  f.invalidate.mockClear();
  f.windows[0].emit('minimize');
  f.windows[0].hide();
  expect(f.invalidate).not.toHaveBeenCalled();
  expect(f.manager.assertCurrent(f.sender(), generation).deviceId).toBe('cloud-a');
  f.windows[0].emit('close', { preventDefault: vi.fn() });
  expect(f.manager.state().target).toBeNull();
  expect(f.invalidate).toHaveBeenCalledWith(f.sender().id);
  await f.manager.open(f.opener, 'cloud-a');
  expect(f.windows).toHaveLength(1);
  expect(f.manager.state().generation).toBeGreaterThan(generation);
  f.manager.close(f.sender(), generation); // stale React cleanup cannot close a new login
  expect(f.manager.state().target?.deviceId).toBe('cloud-a');
});
it('completes without focusing/navigating the workspace and retires the login capability', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  f.ready();
  const generation = f.manager.state().generation;
  f.manager.complete(f.sender(), generation);
  expect(f.manager.state().target).toBeNull();
  expect(f.opener.send).toHaveBeenCalledExactlyOnceWith(CLOUD_LOGIN_WINDOW.completed);
  expect(() => f.manager.assertCurrent(f.sender(), generation)).toThrow('SCOPE_CHANGED');
});
it('rejects a foreign opener/sender and an owner change during authorization', async () => {
  await expect(f.manager.open({} as WebContents, 'cloud-a')).rejects.toThrow('SCOPE_CHANGED');
  expect(f.authorize).not.toHaveBeenCalled();
  f.authorize.mockImplementationOnce(async () => {
    f.setOwner('account-b');
    return { deviceId: 'cloud-a', name: null, ordinal: null };
  });
  await expect(f.manager.open(f.opener, 'cloud-a')).rejects.toThrow('SCOPE_CHANGED');
  expect(f.windows).toHaveLength(0);
  await f.manager.open(f.opener, 'cloud-a');
  expect(() => f.manager.assertCurrent(f.opener, f.manager.state().generation)).toThrow(
    'SCOPE_CHANGED',
  );
  f.setOwner('account-c');
  expect(() => f.manager.assertCurrent(f.sender(), f.manager.state().generation)).toThrow(
    'SCOPE_CHANGED',
  );
});
it('invalidates the window’s logins on every reset, so a superseded end is a no-op', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  f.ready();
  const generation = f.manager.state().generation;
  expect(f.manager.isSuperseded(f.sender(), generation)).toBe(false);
  f.invalidate.mockClear();
  f.manager.reset(); // owner switch or close: React cleanup sends end() afterwards
  expect(f.invalidate).toHaveBeenCalledWith(f.sender().id);
  expect(f.manager.isSuperseded(f.sender(), generation)).toBe(true);
  expect(() => f.manager.isSuperseded(f.opener, generation)).toThrow('SCOPE_CHANGED');
  expect(() => f.manager.assertCurrent(f.sender(), generation + 99)).toThrow('SCOPE_CHANGED');
  expect(f.manager.isSuperseded(f.sender(), generation + 99)).toBe(false);
});
it('preserves the target but cancels the old handle on crash, with bounded recovery', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  f.ready();
  const old = f.sender(),
    generation = f.manager.state().generation;
  f.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  expect(f.windows).toHaveLength(2);
  expect(f.manager.state().target?.deviceId).toBe('cloud-a');
  expect(() => f.manager.assertCurrent(old, generation)).toThrow('SCOPE_CHANGED');
  expect(f.invalidate).toHaveBeenCalledWith(old.id);
  f.ready();
  f.windows[1].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  expect(f.windows).toHaveLength(2);
});

it('keeps the same pending login on reopen, but invalidates it when choosing another instance', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  f.ready();
  const generation = f.manager.state().generation;
  f.invalidate.mockClear();
  await f.manager.open(f.opener, 'cloud-a');
  expect(f.manager.state().generation).toBe(generation);
  expect(f.invalidate).not.toHaveBeenCalled();
  await f.manager.open(f.opener, 'cloud-b');
  expect(f.manager.state().target?.deviceId).toBe('cloud-b');
  expect(() => f.manager.assertCurrent(f.sender(), generation)).toThrow('SCOPE_CHANGED');
  expect(f.invalidate).toHaveBeenCalledWith(f.sender().id);
});

// Main native close can hide the client without destroying it. This is distinct
// from ordinary minimize: retire the capability, including a late open response.
it('resets a minimized login on main close and rejects a late completion/open', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  f.ready();
  const sender = f.sender(),
    generation = f.manager.state().generation;
  f.windows[0].emit('minimize');
  f.manager.reset();
  expect(f.manager.state().target).toBeNull();
  expect(f.windows[0].isVisible()).toBe(false);
  expect(f.invalidate).toHaveBeenCalledWith(sender.id);
  expect(() => f.manager.complete(sender, generation)).toThrow('SCOPE_CHANGED');
  expect(f.opener.send).not.toHaveBeenCalled();
  let authorize!: (target: { deviceId: string; name: null; ordinal: null }) => void;
  f.authorize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
  );
  const opening = f.manager.open(f.opener, 'cloud-b');
  f.manager.reset();
  authorize({ deviceId: 'cloud-b', name: null, ordinal: null });
  await expect(opening).rejects.toThrow('SCOPE_CHANGED');
  expect(f.manager.state().target).toBeNull();
  expect(f.windows[0].isVisible()).toBe(false);
});

it('destroys a minimized login on main destruction or quit without recovery leftovers', async () => {
  await f.manager.open(f.opener, 'cloud-a');
  f.ready();
  const old = f.sender();
  f.windows[0].emit('minimize');
  f.manager.destroy();
  f.manager.destroy();
  vi.runAllTimers();
  expect(f.manager.state().target).toBeNull();
  expect(f.windows[0].isDestroyed()).toBe(true);
  expect(f.windows).toHaveLength(1);
  expect(f.invalidate).toHaveBeenCalledWith(old.id);
  expect(f.manager.controller.isOpen()).toBe(false);
});

// Unit / instance-switch race: existing tests switch already-open targets.
// A delayed admission response must not replace the newer, already-visible B.
it('keeps B selected when A’s earlier admission response arrives last', async () => {
  let resolveA!: (target: { deviceId: string; name: null; ordinal: null }) => void;
  f.authorize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveA = resolve;
      }),
  );
  const openingA = f.manager.open(f.opener, 'cloud-a');
  const rejected = expect(openingA).rejects.toThrow('SCOPE_CHANGED');
  await f.manager.open(f.opener, 'cloud-b');
  f.ready();
  const selected = f.manager.state();
  resolveA({ deviceId: 'cloud-a', name: null, ordinal: null });
  await rejected;
  expect(f.manager.state()).toEqual(selected);
  expect(selected.target?.deviceId).toBe('cloud-b');
  expect(f.windows).toHaveLength(1);
  expect(f.windows[0].isVisible()).toBe(true);
});
