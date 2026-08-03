import type { AppShortcutCombo } from '../../shared/appShortcuts.js';
import { comboToElectronAccelerator } from '../../shared/appShortcuts.js';

export const GLOBAL_MAIN_WINDOW_SHORTCUT_ID = 'toggle-main-window' as const;

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowDisplay {
  workArea: WindowBounds;
}

export interface MainWindowShortcutTarget {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  restore(): void;
  show(): void;
  hide(): void;
  focus(): void;
  setFullScreen(flag: boolean): void;
  once(event: 'leave-full-screen', listener: () => void): unknown;
  getBounds(): WindowBounds;
  setBounds(bounds: WindowBounds): void;
}

interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface ScreenAdapter {
  getAllDisplays(): WindowDisplay[];
  getDisplayNearestPoint(point: { x: number; y: number }): WindowDisplay;
}

interface ShortcutLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface GlobalMainWindowShortcutControllerOptions {
  platform: string;
  globalShortcut: GlobalShortcutAdapter;
  screen: ScreenAdapter;
  getMainWindow: () => MainWindowShortcutTarget | null;
  focusApp: () => void;
  isRecording: () => boolean;
  onAvailabilityChanged: (unavailable: boolean) => void;
  logger: ShortcutLogger;
}

export type PreparedGlobalShortcutChange =
  | { ok: true; commit(): void; rollback(): void }
  | { ok: false; reason: 'inexpressible' | 'unavailable' };

/**
 * Electron globalShortcut 的事务式协调器。
 *
 * 改绑时先注册候选键，成功后才允许调用方写盘；写盘成功 commit 会释放旧键，
 * 写盘失败 rollback 会释放候选键。这样 OS 占用或磁盘错误都不会让设置与真实
 * 注册状态分叉。
 */
export class GlobalMainWindowShortcutController {
  private registeredAccelerator: string | null = null;
  private unavailable = false;
  private lastActivationAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: GlobalMainWindowShortcutControllerOptions) {}

  initialize(combo: AppShortcutCombo | null): void {
    const accelerator = this.toAccelerator(combo);
    if (!combo) {
      this.setUnavailable(false);
      return;
    }
    if (!accelerator || !this.tryRegister(accelerator)) {
      this.options.logger.warn('global main-window shortcut registration failed', {
        accelerator: accelerator ?? 'inexpressible',
      });
      this.setUnavailable(true);
      return;
    }
    this.registeredAccelerator = accelerator;
    this.setUnavailable(false);
    this.options.logger.info('global main-window shortcut registered', { accelerator });
  }

  prepare(combo: AppShortcutCombo | null): PreparedGlobalShortcutChange {
    const nextAccelerator = this.toAccelerator(combo);
    if (combo && !nextAccelerator) return { ok: false, reason: 'inexpressible' };

    const previousAccelerator = this.registeredAccelerator;
    if (nextAccelerator === previousAccelerator) {
      return {
        ok: true,
        commit: () => this.setUnavailable(false),
        rollback: () => undefined,
      };
    }

    if (nextAccelerator && !this.tryRegister(nextAccelerator)) {
      this.options.logger.warn('candidate global main-window shortcut is unavailable', {
        accelerator: nextAccelerator,
      });
      return { ok: false, reason: 'unavailable' };
    }

    let settled = false;
    return {
      ok: true,
      commit: () => {
        if (settled) return;
        settled = true;
        if (previousAccelerator) this.safeUnregister(previousAccelerator);
        this.registeredAccelerator = nextAccelerator;
        this.setUnavailable(false);
        this.options.logger.info('global main-window shortcut updated', {
          accelerator: nextAccelerator ?? 'disabled',
        });
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        if (nextAccelerator) this.safeUnregister(nextAccelerator);
      },
    };
  }

  dispose(): void {
    if (this.registeredAccelerator) this.safeUnregister(this.registeredAccelerator);
    this.registeredAccelerator = null;
  }

  private toAccelerator(combo: AppShortcutCombo | null): string | null {
    return combo ? comboToElectronAccelerator(combo, this.options.platform) : null;
  }

  private tryRegister(accelerator: string): boolean {
    try {
      return this.options.globalShortcut.register(accelerator, () => this.handleActivation());
    } catch (error) {
      this.options.logger.warn('global shortcut register threw', {
        accelerator,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private safeUnregister(accelerator: string): void {
    try {
      this.options.globalShortcut.unregister(accelerator);
    } catch (error) {
      this.options.logger.warn('global shortcut unregister threw', {
        accelerator,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleActivation(): void {
    if (this.options.isRecording()) {
      this.options.logger.debug('ignoring main-window shortcut while recording');
      return;
    }
    const now = Date.now();
    // globalShortcut 不暴露 keyup/repeat 标记。系统按键重复会连续回调；每次被
    // 抑制的重复都推进时间戳，直到松键后一段静默期结束，避免第一次“呼出”
    // 后下一条 repeat 立刻把已经聚焦的窗口反向隐藏。
    if (now - this.lastActivationAt < GLOBAL_SHORTCUT_REPEAT_GUARD_MS) {
      this.lastActivationAt = now;
      this.options.logger.debug('ignoring repeated main-window shortcut activation');
      return;
    }
    this.lastActivationAt = now;
    const window = this.options.getMainWindow();
    if (!window || window.isDestroyed()) return;
    toggleMainWindowVisibility(window, {
      screen: this.options.screen,
      focusApp: this.options.focusApp,
    });
  }

  private setUnavailable(next: boolean): void {
    if (this.unavailable === next) return;
    this.unavailable = next;
    this.options.onAvailabilityChanged(next);
  }
}

const GLOBAL_SHORTCUT_REPEAT_GUARD_MS = 1_200;

const pendingFullscreenHide = new WeakSet<object>();

/**
 * 只在主窗口已是前台窗口时隐藏；后台/最小化/隐藏状态一律呼出并聚焦。
 * 这避免用户从其它应用按快捷键时，因 Cindy 恰好可见在后方而被反向隐藏。
 */
export function toggleMainWindowVisibility(
  window: MainWindowShortcutTarget,
  deps: { screen: ScreenAdapter; focusApp: () => void },
): void {
  if (window.isDestroyed()) return;
  if (window.isFocused()) {
    hideFocusedWindow(window);
    return;
  }

  if (window.isMinimized()) window.restore();
  moveFullyOffscreenWindowIntoView(window, deps.screen);
  if (!window.isVisible()) window.show();
  window.focus();
  deps.focusApp();
}

function hideFocusedWindow(window: MainWindowShortcutTarget): void {
  if (!window.isFullScreen()) {
    window.hide();
    return;
  }
  if (pendingFullscreenHide.has(window)) return;
  pendingFullscreenHide.add(window);
  window.once('leave-full-screen', () => {
    pendingFullscreenHide.delete(window);
    if (!window.isDestroyed()) window.hide();
  });
  window.setFullScreen(false);
}

function moveFullyOffscreenWindowIntoView(
  window: MainWindowShortcutTarget,
  screen: ScreenAdapter,
): void {
  const bounds = window.getBounds();
  const displays = screen.getAllDisplays();
  if (displays.some((display) => rectanglesIntersect(bounds, display.workArea))) return;

  const center = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
  const workArea = screen.getDisplayNearestPoint(center).workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  window.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  });
}

function rectanglesIntersect(a: WindowBounds, b: WindowBounds): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
  );
}
