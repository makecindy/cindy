import { EventEmitter } from 'node:events';
import type { BrowserWindow, OpenDialogReturnValue } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { showPluginOpenDialog } from '../pluginOpenPanel';

const mocks = vi.hoisted(() => ({
  openOwnedPanel: vi.fn(),
  showOpenDialog: vi.fn<() => Promise<OpenDialogReturnValue>>(),
}));

vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => () => mocks.openOwnedPanel,
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fixture' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
}));

const cancelled = { canceled: true, filePaths: [] };
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  mocks.openOwnedPanel.mockReset();
  mocks.showOpenDialog.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function fixtureWindow() {
  const events = Object.assign(new EventEmitter(), {
    getNativeWindowHandle: () => Buffer.alloc(8),
    isDestroyed: () => false,
  });
  return { events, parent: events as unknown as BrowserWindow };
}

// #7748, unit. Exercise the Electron adapter with fake native and window
// boundaries, isolated from the slot tests that stub out the whole adapter.
// An existing sheet plus an aborted waiter must never open another dialog.
it('discards a cancelled waiter when the existing sheet ends', async () => {
  const { events, parent } = fixtureWindow();
  const caller = new AbortController();
  mocks.openOwnedPanel
    .mockReturnValueOnce(null)
    .mockImplementation((_handle, open: () => Promise<OpenDialogReturnValue>) => ({ promise: open() }));
  mocks.showOpenDialog.mockResolvedValue(cancelled);

  const result = showPluginOpenDialog(parent, { properties: ['openDirectory'] }, caller.signal);
  expect(mocks.openOwnedPanel).toHaveBeenCalledOnce();
  caller.abort();
  expect(events.listenerCount('sheet-end')).toBe(0);
  expect(events.listenerCount('closed')).toBe(0);
  events.emit('sheet-end');
  await expect(result).resolves.toEqual(cancelled);

  expect(mocks.showOpenDialog).not.toHaveBeenCalled();
});

// #7748, unit. One owned panel acknowledges a close request asynchronously.
// This adapter must ask it to close and continue awaiting Electron's result.
it('cancels the owned panel and waits for the native promise to settle', async () => {
  const { parent } = fixtureWindow();
  const caller = new AbortController();
  const removeAbortListener = vi.spyOn(caller.signal, 'removeEventListener');
  let finish!: (result: OpenDialogReturnValue) => void;
  mocks.showOpenDialog.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const cancel = vi.fn();
  mocks.openOwnedPanel.mockImplementation((_handle, open: () => Promise<OpenDialogReturnValue>) => ({
    promise: open(),
    cancel,
  }));

  const settled = vi.fn();
  const result = showPluginOpenDialog(parent, { properties: ['openFile'] }, caller.signal);
  void result.then(settled);
  caller.abort();
  await nextTurn();
  expect(cancel).toHaveBeenCalledOnce();
  expect(settled).not.toHaveBeenCalled();
  expect(removeAbortListener).not.toHaveBeenCalled();

  finish(cancelled);
  await expect(result).resolves.toEqual(cancelled);
  expect(removeAbortListener).toHaveBeenCalledWith('abort', cancel);
});
