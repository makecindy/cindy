/**
 * 测试价值
 * - 生产入口与可观察结果：startAwayGuard 在遮罩期间挂系统 Touch ID 验证框（`--owner-prompt`）；
 *   观察常亮被放开时遮罩层级是否立刻回到 `screen-saver`、启动中的验证框是否被取消并撤下。
 * - 规则依据：docs/product-rules/privacy-screen.md「有人碰电脑」——验证框只在 Cindy 让屏幕保持常亮
 *   期间挂着，一放开常亮就撤下；此时遮罩必须继续挡住 Dock 与菜单栏。
 * - 现有覆盖缺口：ownerPrompt.test.ts 覆盖助手协议本身，privacyScreen.test.ts 的 away-guard 用例
 *   只覆盖锁屏失败，没有覆盖「启动中的验证框被收回」。
 * - 最小失败输入：遮罩盖着、助手还在启动（没收到 `ready`）时任务结束，常亮被放开。
 * - tier：unit，假 Electron/助手，无原生进程。
 *
 * 单独成文件的原因：awayGuardService 是模块级单例（`if (controller || hostPolicy) return`），
 * 一个模块注册表只有一次守卫生命周期；不能在同一文件里再起一个，也不在 beforeEach 里 resetModules。
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

interface MaskLike {
  level: string;
  [key: string]: unknown;
}
const state = vi.hoisted(() => ({
  windows: [] as unknown[],
  displays: [] as Array<{ id: number; bounds: Record<string, number> }>,
}));
const prompt = vi.hoisted(() => ({
  watch: vi.fn(),
  stop: vi.fn(async () => {}),
  signals: [] as AbortSignal[],
  resolve: (() => {}) as (value: unknown) => void,
}));

vi.mock('../../i18n.desktop', () => ({ t: (key: string) => key }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../lifecycle', () => ({ onQuit: () => {} }));
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    done: (error: null, stdout: string, stderr: string) => void,
  ) => done(null, '', ''),
}));
vi.mock('../inputHost', () => ({
  lockDesktopScreen: vi.fn(async () => {}),
  verifyDesktopOwner: () => new Promise(() => {}),
  readDesktopLockState: async () => 'unlocked',
  readDesktopInputPermission: async () => 'granted',
  requestDesktopInputPermission: async () => 'granted',
  resolveDesktopInputBinary: async () => '/helper',
  readDesktopBiometry: async () => 'touchid',
}));
vi.mock('../privacyInput', () => ({
  watchPrivacyInput: vi.fn(),
  watchAwayGuardInput: async () => ({
    stop: async () => {},
    lock: async () => true,
    lockOnExit: () => {},
  }),
}));
// The system prompt never comes up on its own: each start stays pending until the test
// resolves it, exactly like a helper that has not printed `ready` yet.
vi.mock('../ownerPrompt', () => ({
  watchOwnerPrompt: (onAnswer: (answer: string) => void, reason: string, ...rest: unknown[]) => {
    prompt.signals.push(
      rest[0] instanceof AbortSignal ? rest[0] : (rest[1] as AbortSignal),
    );
    prompt.watch(onAnswer, reason);
    return new Promise((resolve) => {
      prompt.resolve = resolve;
    });
  },
}));
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  powerMonitor: new EventEmitter(),
  powerSaveBlocker: { start: () => 1, stop: vi.fn() },
  ipcMain: { handle: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  BrowserWindow: class extends EventEmitter {
    static getFocusedWindow() {
      return null;
    }
    id = state.windows.length + 1;
    destroyed = false;
    level = '';
    bounds = { x: 0, y: 0, width: 1440, height: 900 };
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      focus: vi.fn(),
    });
    constructor(public options: Record<string, unknown>) {
      super();
      state.windows.push(this);
    }
    setMenuBarVisibility() {}
    async loadURL() {}
    setContentProtection() {}
    setIgnoreMouseEvents() {}
    setFocusable() {}
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop(_flag: boolean, level: string) {
      this.level = level;
    }
    getMediaSourceId() {
      return `window:${this.id}:0`;
    }
    getNativeWindowHandle() {
      return Buffer.alloc(8);
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
      return false;
    }
    isFocused() {
      return false;
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
  globalShortcut: { register: () => true, unregister: vi.fn() },
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      webRequest: { onBeforeRequest() {} },
    }),
  },
}));

import { powerMonitor } from 'electron';
import { startAwayGuard } from '../awayGuardService';

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  state.windows.length = 0;
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }];
  prompt.watch.mockReset();
  prompt.stop.mockClear();
  prompt.signals.length = 0;
  // Keep process methods: vitest reports errors through process.listeners.
  vi.stubGlobal(
    'process',
    Object.create(process, {
      platform: { value: 'darwin' },
      getSystemVersion: { value: () => '15.0' },
    }),
  );
});
afterEach(() => {
  powerMonitor.removeAllListeners();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('raises the cover again and cancels a still-starting Touch ID prompt when the display is released', async () => {
  let needsDisplay = true;
  // Computer Use: the Agent reads the whole display and clicks desktop coordinates.
  let computerInUse = false;
  const sessionChanges: Array<() => void> = [];
  startAwayGuard({
    excludedWindows: () => {},
    needsDisplay: () => needsDisplay,
    enabled: () => true,
    delaySeconds: () => 30,
    screenLocked: () => false,
    computerInUse: () => computerInUse,
    onComputerInUseChange: (listener) => {
      sessionChanges.push(listener);
      return () => {};
    },
    seedScreenLocked: () => {},
    msSinceOwnerInput: () => Infinity,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  const mask = state.windows.at(-1) as MaskLike;
  expect(mask).toBeDefined();
  // The covered tick arms the prompt: the cover holds the display and input is shielded.
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
  // The prompt sits above the cover; the lowered level still blocks the Dock and menu bar.
  expect(prompt.watch).toHaveBeenCalledOnce();
  expect(mask.level).toBe('pop-up-menu');
  const [signal] = prompt.signals;
  expect(signal.aborted).toBe(false);

  // The task ends while the helper is still coming up: the display is released.
  needsDisplay = false;
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
  // Back to the level that hides everything at once, not waiting for the helper's ready.
  expect(mask.level).toBe('screen-saver');
  expect(signal.aborted).toBe(true);

  // The cancelled start still settles later; it must not install a prompt on the cover.
  prompt.resolve({ stop: prompt.stop });
  await settle();
  expect(prompt.stop).toHaveBeenCalledOnce();

  // 2026-11-18 user decision: no system prompt while Computer Use drives this desktop.
  needsDisplay = true;
  computerInUse = true;
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
  expect(prompt.watch).toHaveBeenCalledOnce();

  // The Agent is done looking: the prompt comes back at once, not on the next tick.
  computerInUse = false;
  for (const listener of sessionChanges) listener();
  await settle();
  expect(prompt.watch).toHaveBeenCalledTimes(2);
  expect(mask.level).toBe('pop-up-menu');
  prompt.resolve({ stop: prompt.stop });
  await settle();

  // ...and it goes the moment the Agent takes the desktop again.
  computerInUse = true;
  for (const listener of sessionChanges) listener();
  await settle();
  expect(prompt.stop).toHaveBeenCalledTimes(2);
  expect(mask.level).toBe('screen-saver');
});
