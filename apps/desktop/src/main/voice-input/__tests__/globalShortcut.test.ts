import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInputShortcut } from '../../../shared/voiceInputData.js';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registeredShortcuts = new Map<string, () => void>();
  const focusedWindow = {
    id: 10,
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    webContents: {
      id: 42,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
  const modifierSetShortcut = vi.fn();
  const modifierStop = vi.fn();
  const modifierIsRunning = vi.fn();
  const registerShortcut = vi.fn((accelerator: string) => {
    void accelerator;
    return true;
  });

  return {
    handlers,
    registeredShortcuts,
    focusedWindow,
    modifierSetShortcut,
    modifierStop,
    modifierIsRunning,
    registerShortcut,
  };
});

vi.mock('electron', () => ({
  app: {
    focus: vi.fn(),
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
    once: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mocks.focusedWindow]),
    getFocusedWindow: vi.fn(() => mocks.focusedWindow),
  },
  clipboard: {},
  globalShortcut: {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (!mocks.registerShortcut(accelerator)) return false;
      mocks.registeredShortcuts.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      mocks.registeredShortcuts.delete(accelerator);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
    getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
  },
  shell: {
    openExternal: vi.fn(),
  },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
  },
}));

vi.mock('../index.js', () => ({
  prewarmVoiceInputProvider: vi.fn(() => Promise.resolve()),
}));

vi.mock('../MacModifierShortcutListener.js', () => ({
  MacModifierShortcutListener: vi.fn().mockImplementation(() => ({
    setShortcut: mocks.modifierSetShortcut,
    isRunning: mocks.modifierIsRunning,
    stop: mocks.modifierStop,
    stopKeyCapture: vi.fn(),
    startKeyCapture: vi.fn(() => Promise.resolve({ ok: true })),
  })),
  getMacInputMonitoringPermissionSnapshot: vi.fn(() => Promise.resolve({ ok: true, status: 'granted' })),
  requestMacInputMonitoringPermission: vi.fn(() => Promise.resolve({ ok: true, status: 'granted' })),
}));

let setTimeoutSpy: { mockRestore: () => void } | null = null;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('voice input global shortcut registration', () => {
  beforeEach(() => {
    vi.resetModules();
    setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    mocks.handlers.clear();
    mocks.registeredShortcuts.clear();
    mocks.focusedWindow.webContents.send.mockClear();
    mocks.modifierSetShortcut.mockReset();
    mocks.modifierSetShortcut.mockResolvedValue({ ok: true });
    mocks.modifierIsRunning.mockReset();
    mocks.modifierIsRunning.mockReturnValue(true);
    mocks.modifierStop.mockClear();
    mocks.registerShortcut.mockReset();
    mocks.registerShortcut.mockReturnValue(true);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    setTimeoutSpy?.mockRestore();
    setTimeoutSpy = null;
  });

  it('registers F16 through Electron globalShortcut and routes the press to the focused renderer', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc();

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const f16Shortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    };

    await setShortcut?.({}, f16Shortcut);

    expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);

    mocks.registeredShortcuts.get('F16')?.();

    expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
      'voice-input:global-shortcut-trigger',
      expect.objectContaining({ id: expect.any(String) }),
    );
  });

  it('does not re-register an unchanged native macOS shortcut from multiple windows', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc();

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const fnShortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'KeyA',
      key: 'a',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: true,
      },
    };

    await setShortcut?.({}, fnShortcut);
    await setShortcut?.({}, fnShortcut);

    expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(1);
  });

  it('re-registers an unchanged native macOS shortcut when the listener is not running', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc();

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const fnShortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'KeyA',
      key: 'a',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: true,
      },
    };

    mocks.modifierIsRunning.mockReturnValueOnce(false).mockReturnValueOnce(false);

    await setShortcut?.({}, fnShortcut);
    await setShortcut?.({}, fnShortcut);

    expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous Electron shortcut registered when the replacement is rejected', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc();
    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');

    const first: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };
    const replacement: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F17',
      key: 'F17',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    await setShortcut?.({}, first);
    mocks.registerShortcut.mockReturnValueOnce(false);
    const result = await setShortcut?.({}, replacement);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);
    expect(mocks.registeredShortcuts.has('F17')).toBe(false);
  });

  it('rejects settings navigation from a non-overlay sender with a typed IPC error', async () => {
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc();
    const openSettings = mocks.handlers.get('voice-input:open-settings');

    await expect(openSettings?.({ sender: mocks.focusedWindow.webContents }, 'providers'))
      .rejects.toThrow('[PERMISSION_DENIED]');
  });

  it('suppresses paste-target focus restore for settings navigation', async () => {
    const { shouldRestoreOverlayPasteTarget } = await import('../global.js');

    expect(shouldRestoreOverlayPasteTarget({ restorePasteTarget: false }, 'darwin')).toBe(false);
    expect(shouldRestoreOverlayPasteTarget(undefined, 'darwin')).toBe(true);
    expect(shouldRestoreOverlayPasteTarget(undefined, 'win32')).toBe(false);
  });

  // helper 会在最终结果之前先流式吐出前台窗口 frame(浮窗选屏只等这一行),所以
  // 结果解析必须认最后一行,不能把第一行进度事件当成命令结果。
  describe('parseMacTextInsertionHelperResult', () => {
    it('多行输出时取最后一行作为结果', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      const stdout = [
        '{"event":"focused-window-frame","frame":{"x":0,"y":0,"width":800,"height":600},"frameSource":"ax"}',
        '{"ok":true,"target":{"processName":"Chrome","bundleId":"com.google.Chrome","pid":42}}',
        '',
      ].join('\n');

      const result = parseMacTextInsertionHelperResult(stdout);
      expect(result.ok).toBe(true);
      expect(result.event).toBeUndefined();
      expect(result.target?.processName).toBe('Chrome');
    });

    it('单行输出保持原行为', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      expect(parseMacTextInsertionHelperResult('{"ok":true,"outcome":"verified_success"}\n').ok)
        .toBe(true);
    });

    it('空输出与非法 JSON 抛错(由调用方转成 PasteCommandError)', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      expect(() => parseMacTextInsertionHelperResult('   \n\n')).toThrow();
      expect(() => parseMacTextInsertionHelperResult('not json')).toThrow();
    });
  });

  // 词典 toast 锚点按「请求到达顺序」绑定:renderer 收到证据会立刻发起 advisor 请求,
  // 所以请求到达顺序 == 证据发布顺序,并发只发生在响应上。取走必须是 FIFO 且一次性。
  describe('takeOverlayDictionaryToastAnchor', () => {
    it('没有待取锚点时返回 null', async () => {
      const { takeOverlayDictionaryToastAnchor } = await import('../global.js');
      expect(takeOverlayDictionaryToastAnchor()).toBeNull();
    });
  });
});
