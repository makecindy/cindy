import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainEvent } from 'electron';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  windows: new Map<unknown, unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: { on: mocks.on },
  BrowserWindow: { fromWebContents: (sender: unknown) => mocks.windows.get(sender) ?? null },
}));
import {
  markMicrophonePermissionReaderWindow,
  publishMicrophonePermissionSnapshot,
  registerMicrophonePermissionIpc,
} from '../microphonePermissionIpc.js';
import { isAppContentWindow, markAppContentWindow } from '../../windowFocusClassifier.js';

// Unit regression, PR #8493: shared preload bootstraps auxiliary voice windows.
// Existing preload tests replace IPC and cannot catch main's sender rejection.
// This new IPC module needs real window registration and URL/frame validation,
// unlike permissions.test.ts (OS status mapping) or the heavy global shortcut harness.
const snapshot = { ok: true as const, status: 'granted' };
const read = vi.fn(() => snapshot);
const disposers: Array<() => void> = [];
function windowFixture() {
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      mainFrame: { parent: null, url: 'http://localhost:5173/index.html' },
      isDestroyed: vi.fn(() => false), send: vi.fn(), once: vi.fn(),
    },
  };
  mocks.windows.set(window.webContents, window);
  disposers.push(() => {
    window.isDestroyed.mockReturnValue(true);
    for (const [event, callback] of window.webContents.once.mock.calls) if (event === 'destroyed') callback();
  });
  return window;
}
function query(window: ReturnType<typeof windowFixture>, child = false) {
  const frame = window.webContents.mainFrame;
  const replies: unknown[] = [];
  const event = {
    sender: window.webContents,
    senderFrame: child ? { ...frame, parent: frame } : frame,
    set returnValue(value: unknown) { replies.push(value); },
  } as unknown as IpcMainEvent;
  mocks.on.mock.calls[0]![1](event);
  expect(replies).toHaveLength(1);
  return replies[0];
}
beforeEach(() => {
  mocks.on.mockClear();
  read.mockClear();
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  registerMicrophonePermissionIpc(read);
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  mocks.windows.clear();
  vi.unstubAllGlobals();
});

describe('microphone snapshot IPC', () => {
  it('bootstraps registered voice auxiliaries without granting app-content permissions', () => {
    const auxiliary = windowFixture();
    markMicrophonePermissionReaderWindow(auxiliary as unknown as BrowserWindow);
    expect(query(auxiliary)).toEqual(snapshot);
    expect(query(auxiliary)).toEqual(snapshot);
    expect(isAppContentWindow(auxiliary as unknown as BrowserWindow)).toBe(false);
    expect(auxiliary.webContents.once).toHaveBeenCalledTimes(1);
    publishMicrophonePermissionSnapshot({ ok: false, status: 'denied', error: 'revoked' });
    expect(auxiliary.webContents.send).toHaveBeenCalledWith(
      'voice-input:microphone-permission-changed', { ok: false, status: 'denied', error: 'revoked' },
    );
  });
  it('preserves application-window bootstrap', () => {
    const main = windowFixture();
    markAppContentWindow(main as unknown as BrowserWindow);
    expect(query(main)).toEqual(snapshot);
  });
  it.each(['unregistered', 'child-frame', 'navigated'] as const)('finishes %s bootstrap with denial and no subscription', kind => {
    const window = windowFixture();
    if (kind !== 'unregistered') markMicrophonePermissionReaderWindow(window as unknown as BrowserWindow);
    if (kind === 'navigated') window.webContents.mainFrame.url = 'https://example.org';
    expect(query(window, kind === 'child-frame')).toMatchObject({ ok: false, error: 'PERMISSION_DENIED' });
    expect(read).not.toHaveBeenCalled();
    publishMicrophonePermissionSnapshot(snapshot);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
  it('stops updates after a registered window navigates away or is destroyed', () => {
    const window = windowFixture();
    markMicrophonePermissionReaderWindow(window as unknown as BrowserWindow);
    expect(query(window)).toEqual(snapshot);
    window.webContents.mainFrame.url = 'https://example.org';
    publishMicrophonePermissionSnapshot(snapshot);
    expect(window.webContents.send).not.toHaveBeenCalled();
    window.webContents.mainFrame.url = 'http://localhost:5173/index.html';
    expect(query(window)).toEqual(snapshot);
    window.isDestroyed.mockReturnValue(true);
    publishMicrophonePermissionSnapshot(snapshot);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
