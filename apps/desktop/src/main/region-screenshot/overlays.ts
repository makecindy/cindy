import { app, screen, type BrowserWindow, type Display, type WebContents } from 'electron';

import { createLogger } from '../logger';
import { createScreenshotPageWindow } from './pageWindow';

const log = createLogger('region-screenshot:overlays');

/** 隐藏预热的浮层迟迟没挂载时放弃这块屏, 不让按下快捷键后一直没反应。 */
const SHELL_TIMEOUT_MS = 4000;
/** 浮层 renderer 崩溃后的重建额度: 10 分钟内最多 3 次, 超出后本次运行不再截图。 */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;

/** Chromium Aura 的显示动画会缩放整个截图，DWM / thickFrame 开关无法禁用它。 */
export function showScreenshotOverlay(window: BrowserWindow): void {
  withoutScreenshotAnimation(() => window.showInactive());
}

export function hideScreenshotOverlay(window: BrowserWindow): void {
  withoutScreenshotAnimation(() => window.hide());
}

function withoutScreenshotAnimation(changeVisibility: () => void): void {
  const flag = 'wm-window-animations-disabled';
  if (process.platform !== 'win32' || app.commandLine.hasSwitch(flag)) {
    changeVisibility();
    return;
  }
  // show / hide 必须成对禁用：hide 动画会留下 opacity=0 和缩放变换，
  // 下次禁用 show 动画时不会恢复，导致复用窗口不可见。
  // Aura 同步读取此开关；立即恢复，不能改变其它窗口的动画策略。
  app.commandLine.appendSwitch(flag);
  try {
    changeVisibility();
  } finally {
    app.commandLine.removeSwitch(flag);
  }
}

export interface OverlayWindow {
  readonly window: BrowserWindow;
  readonly displayId: number;
  /** 页面已挂载 (SHELL_READY)。 */
  shellReady: boolean;
}

interface Entry extends OverlayWindow {
  waiters: Array<(ready: boolean) => void>;
}

/**
 * 每块显示器一个全屏框选浮层, 隐藏预热、截图时显示、结束后销毁并重新预热。
 *
 * 与 §3.1 独立辅助窗口基线的差异 (全局热键 + 置顶系统浮层的平台约束):
 * - 不随主窗口挂父子关系、不进任务栏 / Dock, 置顶在屏保层级; macOS 用不激活应用的面板;
 * - 「就绪」分两段: 预热时页面挂载, 每次截图再等定格画面绘制后才显示
 *   (见 RegionScreenshotSession); 隐藏前由页面清空画面与交互态;
 * - 显示器增减或分辨率变化时按显示器重建, 不尝试在原窗口上迁移。
 * - 透明浮层用后销毁, 避免下次截图继承原生窗口的合成状态; 未使用的预热壳仍可复用。
 * 其余安全配置、sender 校验、故障隔离与有界重建照基线执行。
 */
export class OverlayPool {
  private readonly byDisplay = new Map<number, Entry>();
  private readonly byContents = new Map<number, Entry>();
  private readonly retiring = new Map<Entry, ReturnType<typeof setTimeout>>();
  private crashes: number[] = [];
  private disabled = false;
  private onGone: ((overlay: OverlayWindow) => void) | null = null;

  /** 浮层窗口意外消失 (崩溃 / 被系统关闭) 时通知当前会话。 */
  setGoneHandler(handler: (overlay: OverlayWindow) => void): void {
    this.onGone = handler;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  forContents(contents: WebContents): OverlayWindow | null {
    const entry = this.byContents.get(contents.id);
    return entry && !entry.window.isDestroyed() ? entry : null;
  }

  /** 后台为所有显示器预热浮层; 已存在的只校正位置。 */
  prewarm(): void {
    if (this.disabled) return;
    const displays = screen.getAllDisplays();
    const ids = new Set(displays.map((d) => d.id));
    for (const [displayId, entry] of this.byDisplay) {
      if (!ids.has(displayId)) this.destroy(entry);
    }
    for (const display of displays) this.ensure(display);
  }

  /** 显示器配置变了: 全部销毁, 稍后按新配置预热。 */
  reset(): void {
    for (const entry of [...this.byDisplay.values()]) this.destroy(entry);
  }

  ensure(display: Display): OverlayWindow | null {
    if (this.disabled) return null;
    const existing = this.byDisplay.get(display.id);
    if (existing && !existing.window.isDestroyed()) return existing;
    if (existing) this.forget(existing);
    try {
      return this.create(display);
    } catch (error) {
      log.warn('overlay creation failed', { error });
      this.recordCrash();
      return null;
    }
  }

  /** 等页面挂载; 超时返回 false。 */
  waitForShell(overlay: OverlayWindow): Promise<boolean> {
    if (overlay.shellReady) return Promise.resolve(true);
    const entry = overlay as Entry;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter((w) => w !== done);
        if (!entry.window.isDestroyed()) this.discard(entry);
        resolve(false);
      }, SHELL_TIMEOUT_MS);
      const done = (ready: boolean) => {
        clearTimeout(timer);
        resolve(ready);
      };
      entry.waiters.push(done);
    });
  }

  markShellReady(contents: WebContents, frame: Electron.WebFrameMain | null): void {
    const entry = this.byContents.get(contents.id);
    if (!entry || !frame || frame !== contents.mainFrame) return;
    entry.shellReady = true;
    for (const waiter of entry.waiters.splice(0)) waiter(true);
  }

  destroyAll(): void {
    this.disabled = true;
    this.reset();
    for (const [entry, timer] of this.retiring) {
      clearTimeout(timer);
      this.destroy(entry);
    }
    this.retiring.clear();
  }

  /**
   * 截图结束后销毁用过的透明浮层, 避免下一次截图继承原生窗口的透明度与合成状态。
   * 先从池中移除, 即使下一次截图立即开始, 也只会取得新窗口。
   */
  retire(overlay: OverlayWindow): void {
    const entry = overlay as Entry;
    this.forget(entry);
    const { window } = entry;
    if (window.isDestroyed() || this.retiring.has(entry)) return;
    window.setOpacity(0);
    hideScreenshotOverlay(window);
    // 让当前 export IPC handler 先返回, 再销毁 sender; 退出时由 destroyAll 同步清理。
    this.retiring.set(entry, setTimeout(() => {
      this.retiring.delete(entry);
      if (!window.isDestroyed()) window.destroy();
    }, 0));
  }

  /** 页面状态已失效，关闭后丢弃，避免下次复用已崩溃的 React 树。 */
  discard(overlay: OverlayWindow): void {
    this.recordCrash();
    this.destroy(overlay as Entry);
  }

  private create(display: Display): OverlayWindow {
    const window = createScreenshotPageWindow({
      preload: 'regionScreenshotPreload.js',
      query: 'regionScreenshot',
      ...display.bounds,
      enableLargerThanScreen: true,
      acceptFirstMouse: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      // 定格画面绘制前的底色; 窗口在画面绘制完成前保持全透明, 用户看不到它。
      transparent: true,
      backgroundColor: '#00000000',
      // macOS: 不激活应用的面板。能拿键盘焦点, 但截图前的应用保持前台: 菜单栏、
      // Dock 不跳动, 结束时不必抢回焦点, 滚动截图时触控板滚动与惯性照常交给它。
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    });
    const entry: Entry = { window, displayId: display.id, shellReady: false, waiters: [] };
    this.byDisplay.set(display.id, entry);
    this.byContents.set(window.webContents.id, entry);
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.setAlwaysOnTop(true, 'screen-saver', 1);
    // 页面重新加载 (开发热更新、意外导航) 会丢掉会话状态: 视为这块浮层失效, 让当前会话结束,
    // 未使用的预热壳等页面重新挂载后继续使用, 已使用的浮层随会话结束销毁。
    window.webContents.on('did-start-loading', () => {
      entry.shellReady = false;
      this.onGone?.(entry);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (window.isDestroyed()) return;
      log.warn('overlay renderer gone', { reason: details.reason });
      this.recordCrash();
      this.destroy(entry);
    });
    window.on('unresponsive', () => {
      log.warn('overlay became unresponsive; closing screenshot');
      this.recordCrash();
      this.destroy(entry);
    });
    window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (!isMainFrame || window.isDestroyed()) return;
      this.recordCrash();
      this.destroy(entry);
    });
    window.on('closed', () => {
      this.forget(entry);
      this.onGone?.(entry);
    });
    return entry;
  }

  private recordCrash(): void {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashes.length > CRASH_LIMIT) {
      log.warn('overlay keeps crashing; screenshots disabled until restart');
      this.disabled = true;
    }
  }

  private forget(entry: Entry): void {
    if (this.byDisplay.get(entry.displayId) === entry) this.byDisplay.delete(entry.displayId);
    for (const [id, value] of this.byContents) {
      if (value === entry) this.byContents.delete(id);
    }
    for (const waiter of entry.waiters.splice(0)) waiter(false);
  }

  private destroy(entry: Entry): void {
    this.forget(entry);
    // destroy 会触发 'closed', 由那里通知当前会话。
    if (!entry.window.isDestroyed()) entry.window.destroy();
  }
}
