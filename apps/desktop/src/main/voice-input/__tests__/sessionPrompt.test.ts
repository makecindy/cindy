import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const mainFrame = { url: 'http://localhost:5173/' };
  const overlay = {
    id: 12,
    webContents: { id: 42, mainFrame, send: vi.fn(), once: vi.fn(), isDestroyed: () => false },
    isDestroyed: () => false,
    isVisible: vi.fn(() => false),
    setBounds: vi.fn(),
    setOpacity: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setHiddenInMissionControl: vi.fn(),
    setFocusable: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    loadURL: vi.fn(),
  };
  return {
    handlers,
    listeners,
    overlay,
    dispatch: vi.fn(),
    owner: 'owner-a:1',
    invalidate: () => {},
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn(), once: vi.fn(), getPath: () => '/tmp/cindy-test' },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
    constructor() {
      return harness.overlay;
    }
  },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      harness.handlers.set(name, handler),
    on: (name: string, handler: (...args: unknown[]) => unknown) =>
      harness.listeners.set(name, handler),
  },
  globalShortcut: { register: () => true, unregister: vi.fn() },
  screen: {
    getAllDisplays: () => [
      {
        id: 7,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 32, width: 1440, height: 868 },
      },
    ],
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({
      id: 7,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 32, width: 1440, height: 868 },
    }),
  },
  clipboard: {},
  shell: {},
  systemPreferences: {},
}));
vi.mock('../index.js', () => ({ prewarmVoiceInputProvider: vi.fn() }));
vi.mock('../MacModifierShortcutListener.js', () => ({ MacModifierShortcutListener: class {} }));
vi.mock('../WindowsFunctionKeyShortcutListener.js', () => ({
  WindowsFunctionKeyShortcutListener: class {},
}));
vi.mock('../VoiceInputDataStore.js', () => ({ voiceInputDataStore: {} }));
vi.mock('../overlayPositionStore.js', () => ({ voiceInputOverlayPositionStore: {} }));
vi.mock('../sessionPromptDispatch.js', () => ({ dispatchSessionVoicePrompt: harness.dispatch }));
vi.mock('../../appearance-settings-reader.js', () => ({
  markAppearanceSettingsReaderWindow: vi.fn(),
}));
vi.mock('../../appPresence.js', () => ({ scheduleMainAppPresenceRestore: vi.fn() }));
vi.mock('../../deepLink.js', () => ({ openMainWindowVoiceSettings: vi.fn() }));
vi.mock('../../windowHiddenBroadcast.js', () => ({ installWindowHiddenBroadcast: vi.fn() }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedCindyRendererWindow: () => true,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => harness.owner,
  isAppSessionBoundaryPending: () => false,
  onAppSessionInvalidated: (callback: () => void) => {
    harness.invalidate = callback;
  },
}));
vi.mock('../../lifecycle.js', () => ({ onQuit: vi.fn() }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import {
  registerGlobalVoiceInputIpc,
  showSessionVoicePromptOverlay,
  triggerGlobalVoiceInputFromHardware,
} from '../global.js';

afterEach(() => vi.unstubAllGlobals());

describe('island task voice prompt', () => {
  it('binds replies to one ready overlay, rejects stale or foreign input, and preserves failed text for retry', async () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');
    registerGlobalVoiceInputIpc({ getMainWindow: () => null, isSecondaryAppWindow: () => false });
    const event = {
      sender: harness.overlay.webContents,
      senderFrame: harness.overlay.webContents.mainFrame,
    };
    showSessionVoicePromptOverlay({
      sessionId: 'task',
      title: 'Task',
      sourceDeviceId: 'other-computer',
      displayId: 7,
    });
    triggerGlobalVoiceInputFromHardware('start');
    expect(harness.overlay.showInactive).not.toHaveBeenCalled();
    harness.listeners.get('voice-input:global-overlay-ready')!(event);
    expect(harness.overlay.showInactive).toHaveBeenCalledTimes(1);
    expect(harness.overlay.setFocusable).toHaveBeenLastCalledWith(false);
    const context = harness.overlay.webContents.send.mock.calls.find(
      ([name]) => name === 'voice-input:session-prompt:start',
    )![1];
    const submit = harness.handlers.get('voice-input:session-prompt:submit')!;
    expect(await submit({ ...event, senderFrame: {} }, context.requestId, 'secret')).toEqual({
      ok: false,
      errorCode: 'NO_TARGET',
    });
    expect(await submit(event, 'old-recording', 'secret')).toEqual({
      ok: false,
      errorCode: 'NO_TARGET',
    });
    expect(await submit(event, context.requestId, '  ')).toEqual({ ok: false, errorCode: 'EMPTY' });
    expect(harness.dispatch).not.toHaveBeenCalled();
    harness.dispatch.mockResolvedValueOnce({ ok: false, errorCode: 'REMOTE_UNAVAILABLE' });
    expect(await submit(event, context.requestId, '  Continue  ')).toEqual({
      ok: false,
      errorCode: 'REMOTE_UNAVAILABLE',
    });
    expect(harness.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'task',
        sourceDeviceId: 'other-computer',
        text: 'Continue',
      }),
    );
    harness.dispatch.mockResolvedValueOnce({ ok: true });
    expect(await submit(event, context.requestId, 'Continue')).toEqual({ ok: true });
    expect(await submit(event, context.requestId, 'Continue')).toEqual({ ok: true });
    expect(harness.dispatch).toHaveBeenCalledTimes(2);
    harness.owner = 'owner-b:2';
    expect(await submit(event, context.requestId, 'old-owner')).toEqual({
      ok: false,
      errorCode: 'NO_TARGET',
    });
    harness.invalidate();
    expect(harness.overlay.webContents.send).toHaveBeenLastCalledWith(
      'voice-input:global-overlay-command',
      { type: 'cancel' },
    );
    expect(await submit(event, context.requestId, 'after-cancel')).toEqual({
      ok: false,
      errorCode: 'NO_TARGET',
    });
  });
});
