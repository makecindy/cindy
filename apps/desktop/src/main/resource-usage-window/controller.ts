/**
 * 资源用量独立窗口的预热、显示和回收状态机。
 *
 * 窗口在主界面稳定后提前创建。renderer 挂载与首份采样都发生在隐藏阶段；用户打开时
 * 只恢复采样并显示已有内容。普通关闭仅隐藏，主窗口真正销毁或应用退出时才销毁窗口。
 */

import type { BrowserWindow, WebContents } from 'electron';
import type { SupportedLocale } from '../../shared/locale.js';
import {
  RESOURCE_USAGE_WINDOW_LOCALE_CHANGED_CHANNEL,
  RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL,
} from '../../shared/resourceUsageWindow.js';

import { t } from '../i18n.js';
import { createLogger } from '../logger.js';

const log = createLogger('resource-usage-window-controller');
const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_PREWARM_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_STABILITY_MS = 30_000;
const DEFAULT_LEAVE_TIMEOUT_MS = 2000;
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 1;

export interface ResourceUsageOwnerWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  isMinimized(): boolean;
  isVisible?(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  on?(event: 'hide' | 'minimize' | 'closed', listener: () => void): unknown;
}

type FullscreenTransition = 'idle' | 'entering' | 'entered' | 'leaving';

export interface ResourceUsageWindowControllerDeps {
  createWindow: () => BrowserWindow;
  isOpenSender: (sender: WebContents) => boolean;
  /** 打开监视器的那扇应用窗；macOS 全屏时监视器自己进新的 Space，这扇窗留在原 Space。 */
  getOwnerWindow?: (sender: WebContents) => ResourceUsageOwnerWindow | null;
  /** 测试注入；默认 process.platform。仅 darwin 会把监视器送进独立全屏 Space。 */
  platform?: NodeJS.Platform;
  /** 测试注入；默认走 main i18n 的当前 locale。 */
  resolveNativeTitle?: (locale: SupportedLocale | null) => string;
  openTimeoutMs?: number;
  prewarmTimeoutMs?: number;
  recoveryStabilityMs?: number;
  /** 测试注入；macOS 退出全屏若迟迟没有 leave-full-screen，到期后强制隐藏。 */
  leaveTimeoutMs?: number;
}

export class ResourceUsageWindowController {
  private winRef: BrowserWindow | null = null;
  private rendererReady = false;
  private presentationReady = false;
  private visible = false;
  private pendingOpen = false;
  private openTimeout: NodeJS.Timeout | null = null;
  private prewarmTimeout: NodeJS.Timeout | null = null;
  private recoveryStabilityTimeout: NodeJS.Timeout | null = null;
  private leaveTimeout: NodeJS.Timeout | null = null;
  private samplingActive = true;
  private automaticRecoveryAttempts = 0;
  private destroyingWindow = false;
  private disposed = false;
  private locale: SupportedLocale | null = null;
  private lastOwner: ResourceUsageOwnerWindow | null = null;
  private ownerHideUnsubscribers: Array<() => void> = [];
  /** 递增代次：关闭全屏时记下当前值，leave-full-screen 迟到时对照，避免把刚重新打开的窗口藏掉。 */
  private fullscreenGeneration = 0;
  private pendingLeaveGeneration: number | null = null;
  private pendingLeaveRestoresOwner = true;
  private fullscreenTransition: FullscreenTransition = 'idle';

  constructor(private readonly deps: ResourceUsageWindowControllerDeps) {}

  /** 主窗口首帧之后调用；只准备隐藏窗口，不改变用户焦点。 */
  prewarm(): void {
    if (this.disposed) return;
    this.ensureWindow();
  }

  /** 幂等打开：热窗口立即显示；冷窗口等待首份可展示快照，异常时才显示已挂载的 Loading 壳。 */
  open(sender: WebContents): boolean {
    if (this.disposed) return false;
    if (!this.deps.isOpenSender(sender)) {
      log.warn('resource-usage open from non-main window ignored');
      return false;
    }
    this.automaticRecoveryAttempts = 0;
    this.clearRecoveryStabilityTimeout();
    this.pendingOpen = true;
    this.rememberOwner(sender);
    const win = this.ensureWindow();
    if (!win) {
      this.pendingOpen = false;
      return false;
    }
    this.setSamplingActive(win, true);

    if (this.visible || win.isVisible()) {
      this.showAndFocus(win);
      return true;
    }
    if (this.presentationReady) {
      this.showAndFocus(win);
      return true;
    }
    this.scheduleOpenFallback(win);
    return true;
  }

  /** renderer 根组件已挂载；用于确认超时兜底至少有 React 壳可展示。 */
  markRendererReady(sender: WebContents): boolean {
    const win = this.windowForSender(sender);
    if (!win) return false;
    this.rendererReady = true;
    if (this.locale) this.sendLocale(win, this.locale);
    this.setSamplingActive(win, this.samplingActive);
    return true;
  }

  /** 首份快照已提交；隐藏预热到此结束，停止后台采样但保留表格状态。 */
  markPresentationReady(sender: WebContents): boolean {
    const win = this.windowForSender(sender);
    if (!win) return false;
    this.presentationReady = true;
    this.scheduleRecoveryStabilityReset(win);
    this.clearPrewarmTimeout();
    if (this.pendingOpen) {
      this.showAndFocus(win);
      return true;
    }
    if (!this.visible && !this.pendingOpen) this.setSamplingActive(win, false);
    return true;
  }

  /** 用户关闭只隐藏，保留 renderer 和最后一份快照供下一次瞬时恢复。 */
  close(sender: WebContents): boolean {
    const win = this.windowForSender(sender);
    if (!win) return false;
    this.hideWindow(win);
    return true;
  }

  /** 主窗口隐藏到 Dock / 托盘时一并收起监视器，且不再把焦点交回已隐藏的 owner。 */
  hideWithOwner(): boolean {
    const win = this.winRef;
    if (!win || win.isDestroyed()) return false;
    this.hideWindow(win, { restoreOwner: false });
    return true;
  }

  /** 主窗口语言偏好变化时同步隐藏或可见的资源窗口。 */
  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    const win = this.winRef;
    if (!win || win.isDestroyed()) return;
    this.applyNativeTitle(win);
    this.sendLocale(win, locale);
  }

  private applyNativeTitle(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    win.setTitle(this.nativeTitle());
  }

  private nativeTitle(): string {
    return this.deps.resolveNativeTitle?.(this.locale) ?? t('titleBar.menuItems.resourceUsage');
  }

  private sendLocale(win: BrowserWindow, locale: SupportedLocale): void {
    if (win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(RESOURCE_USAGE_WINDOW_LOCALE_CHANGED_CHANNEL, locale);
    } catch {
      // 窗口可能在 isDestroyed 检查与 send 之间被系统销毁。
    }
  }

  /** 主窗口真实销毁时回收其子窗口；controller 仍可随下一扇主窗口重新预热。 */
  destroyWindow(): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.clearLeaveTimeout();
    this.pendingOpen = false;
    const win = this.winRef;
    if (!win || win.isDestroyed()) {
      this.resetWindowState();
      return;
    }
    this.destroyCachedWindow(win);
  }

  /** 应用退出时永久停止该 controller，并同步销毁缓存窗口。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyWindow();
  }

  isOpen(): boolean {
    return this.winRef !== null && !this.winRef.isDestroyed();
  }

  private ensureWindow(): BrowserWindow | null {
    if (this.winRef && !this.winRef.isDestroyed()) return this.winRef;
    let win: BrowserWindow;
    try {
      win = this.deps.createWindow();
    } catch (error) {
      this.resetWindowState();
      log.error('resource-usage window creation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    this.winRef = win;
    this.rendererReady = false;
    this.presentationReady = false;
    this.visible = false;
    this.samplingActive = true;
    this.destroyingWindow = false;
    this.fullscreenTransition = 'idle';
    this.applyNativeTitle(win);
    if (this.locale) this.sendLocale(win, this.locale);
    win.on('close', (event) => {
      if (this.destroyingWindow || this.disposed) return;
      event.preventDefault();
      this.hideWindow(win);
    });
    win.on('closed', () => this.onClosed(win));
    win.on('show', () => this.onNativeVisibilityChanged(win, true));
    win.on('restore', () => this.onNativeVisibilityChanged(win, true));
    win.on('hide', () => this.onNativeVisibilityChanged(win, false));
    win.on('minimize', () => this.onNativeVisibilityChanged(win, false));
    win.on('enter-full-screen', () => this.reconcileFullscreenEvent(win, 'entered'));
    win.on('leave-full-screen', () => this.reconcileFullscreenEvent(win, 'left'));
    // index.html 的 <title>Cindy</title> 会在每次导航发出 page-title-updated，
    // 不拦截的话 Mission Control / 任务栏会把本地化标题盖回 Cindy。
    win.webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      this.applyNativeTitle(win);
    });
    win.webContents.on('did-start-loading', () => this.onRendererReloadStarted(win));
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          this.invalidateWindow(win, `load failed (${errorCode}): ${errorDescription}`);
        }
      },
    );
    win.webContents.on('render-process-gone', (_event, details) => {
      this.invalidateWindow(win, `renderer process gone: ${details.reason}`);
    });
    this.schedulePrewarmFallback(win);
    return win;
  }

  private windowForSender(sender: WebContents): BrowserWindow | null {
    const win = this.winRef;
    if (!win || win.isDestroyed() || sender !== win.webContents) {
      log.warn('resource-usage window signal from non-resource window ignored');
      return null;
    }
    return win;
  }

  private scheduleOpenFallback(win: BrowserWindow): void {
    this.clearOpenTimeout();
    this.openTimeout = setTimeout(() => {
      this.openTimeout = null;
      if (win !== this.winRef || win.isDestroyed() || !this.pendingOpen) return;
      if (!this.rendererReady) {
        this.invalidateWindow(win, 'renderer readiness timed out');
        return;
      }
      if (!this.presentationReady) {
        this.showAndFocus(win);
        log.warn('resource-usage presentation timed out; showing fallback state');
      }
    }, this.deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    this.openTimeout.unref?.();
  }

  private showAndFocus(win: BrowserWindow): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.clearLeaveTimeout();
    this.pendingOpen = false;
    this.pendingLeaveGeneration = null;
    this.fullscreenGeneration += 1;
    this.setSamplingActive(win, true);
    if (win.isMinimized()) win.restore();
    // 必须先 show，再 setFullScreen。构造时 fullscreen: true 在已有全屏窗的
    // 同一块屏幕上会被 Electron 忽略（electron#34367）；show 之后再进全屏，
    // 才能在 macOS 上单独占一个 Space，Cindy 那扇全屏窗继续留在原 Space。
    win.show();
    win.focus();
    this.visible = true;
    this.syncFullscreenWithOwner(win);
  }

  private hideWindow(win: BrowserWindow, options: { restoreOwner?: boolean } = {}): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.pendingOpen = false;
    this.setSamplingActive(win, false);
    if (this.pendingLeaveGeneration !== null) {
      if (options.restoreOwner === false) this.pendingLeaveRestoresOwner = false;
      return;
    }
    const generation = this.fullscreenGeneration;
    this.pendingLeaveRestoresOwner = options.restoreOwner !== false;
    if (this.platform() === 'darwin' && this.needsFullscreenExit(win)) {
      this.pendingLeaveGeneration = generation;
      this.fullscreenTransition = 'leaving';
      win.setFullScreen(false);
      this.scheduleLeaveFallback(win, generation);
      return;
    }
    this.pendingLeaveGeneration = generation;
    this.finishHide(win, generation);
  }

  private needsFullscreenExit(win: BrowserWindow): boolean {
    return (
      win.isFullScreen() ||
      this.fullscreenTransition === 'entering' ||
      this.fullscreenTransition === 'entered' ||
      this.fullscreenTransition === 'leaving'
    );
  }

  private finishHide(win: BrowserWindow, generation: number): void {
    if (this.pendingLeaveGeneration !== generation) {
      if (
        this.pendingLeaveGeneration === null &&
        !win.isDestroyed() &&
        (this.visible || this.pendingOpen)
      ) {
        this.syncFullscreenWithOwner(win);
      }
      return;
    }
    this.clearLeaveTimeout();
    this.pendingLeaveGeneration = null;
    const restoreOwner = this.pendingLeaveRestoresOwner;
    this.pendingLeaveRestoresOwner = true;
    this.fullscreenTransition = 'idle';
    if (win.isDestroyed()) return;
    if (win.isVisible()) win.hide();
    this.visible = false;
    if (restoreOwner) this.focusOwnerWindow();
  }

  /**
   * 全屏事件只描述当前原生状态，不携带请求代次。
   * 正在关窗时等 leave 或超时；仍可见时按 owner 对账；已隐藏时忽略迟到事件。
   */
  private reconcileFullscreenEvent(win: BrowserWindow, event: 'entered' | 'left'): void {
    if (win !== this.winRef || win.isDestroyed()) return;
    if (this.pendingLeaveGeneration !== null) {
      if (event === 'left') {
        this.finishHide(win, this.pendingLeaveGeneration);
        return;
      }
      this.fullscreenTransition = 'leaving';
      win.setFullScreen(false);
      this.scheduleLeaveFallback(win, this.pendingLeaveGeneration);
      return;
    }
    if (!this.visible && !this.pendingOpen) return;
    if (event === 'entered') this.fullscreenTransition = 'entered';
    else if (this.fullscreenTransition !== 'entering') this.fullscreenTransition = 'idle';
    this.syncFullscreenWithOwner(win);
  }

  private rememberOwner(sender: WebContents): void {
    const owner = this.deps.getOwnerWindow?.(sender) ?? null;
    this.unbindOwnerVisibility();
    this.lastOwner = owner && !owner.isDestroyed() ? owner : null;
    this.bindOwnerVisibility(this.lastOwner);
  }

  private bindOwnerVisibility(owner: ResourceUsageOwnerWindow | null): void {
    if (!owner?.on) return;
    const hide = () => this.hideWithOwner();
    owner.on('hide', hide);
    owner.on('minimize', hide);
    owner.on('closed', hide);
    this.ownerHideUnsubscribers = [
      () => this.safeOff(owner, 'hide', hide),
      () => this.safeOff(owner, 'minimize', hide),
      () => this.safeOff(owner, 'closed', hide),
    ];
  }

  private unbindOwnerVisibility(): void {
    for (const unsubscribe of this.ownerHideUnsubscribers) unsubscribe();
    this.ownerHideUnsubscribers = [];
  }

  private safeOff(
    owner: ResourceUsageOwnerWindow,
    event: 'hide' | 'minimize' | 'closed',
    listener: () => void,
  ): void {
    const removable = owner as ResourceUsageOwnerWindow & {
      off?(event: 'hide' | 'minimize' | 'closed', listener: () => void): unknown;
      removeListener?(event: 'hide' | 'minimize' | 'closed', listener: () => void): unknown;
    };
    removable.off?.(event, listener);
    removable.removeListener?.(event, listener);
  }

  private ownerWindow(): ResourceUsageOwnerWindow | null {
    const owner = this.lastOwner;
    if (!owner || owner.isDestroyed()) {
      this.lastOwner = null;
      return null;
    }
    return owner;
  }

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  /**
   * macOS 原生全屏是「每扇窗一个 Space」。从全屏 Cindy 打开监视器时，
   * 监视器自己进全屏（新 Space），Cindy 保持全屏留在原 Space。
   * 非全屏或非 darwin 只显示普通独立窗口。
   */
  private syncFullscreenWithOwner(win: BrowserWindow): void {
    if (this.platform() !== 'darwin') return;
    const owner = this.ownerWindow();
    const shouldBeFullScreen = Boolean(owner?.isFullScreen());
    if (shouldBeFullScreen) {
      if (win.isFullScreen() || this.fullscreenTransition === 'entering') return;
      this.fullscreenTransition = 'entering';
      win.setFullScreen(true);
      return;
    }
    if (!win.isFullScreen() && this.fullscreenTransition === 'idle') return;
    this.fullscreenTransition = 'leaving';
    win.setFullScreen(false);
  }

  private focusOwnerWindow(): void {
    const owner = this.ownerWindow();
    if (!owner) return;
    if (owner.isMinimized()) return;
    if (owner.isVisible && !owner.isVisible()) return;
    owner.show();
    owner.focus();
  }

  private setSamplingActive(win: BrowserWindow, active: boolean): void {
    this.samplingActive = active;
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(RESOURCE_USAGE_WINDOW_SAMPLING_ACTIVE_CHANNEL, active);
    } catch {
      // 窗口可能在 isDestroyed 检查与 send 之间被系统销毁。
    }
  }

  private onClosed(win: BrowserWindow): void {
    if (win !== this.winRef) return;
    this.resetWindowState();
  }

  private onNativeVisibilityChanged(win: BrowserWindow, visible: boolean): void {
    if (win !== this.winRef || win.isDestroyed()) return;
    this.visible = visible;
    this.setSamplingActive(win, visible);
    if (!visible && this.pendingOpen) {
      this.pendingOpen = false;
      this.clearOpenTimeout();
    }
  }

  private resetWindowState(options: { preserveOwner?: boolean } = {}): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.clearRecoveryStabilityTimeout();
    this.clearLeaveTimeout();
    this.winRef = null;
    this.rendererReady = false;
    this.presentationReady = false;
    this.visible = false;
    this.pendingOpen = false;
    this.samplingActive = true;
    this.destroyingWindow = false;
    if (!options.preserveOwner) {
      this.unbindOwnerVisibility();
      this.lastOwner = null;
    }
    this.pendingLeaveGeneration = null;
    this.pendingLeaveRestoresOwner = true;
    this.fullscreenTransition = 'idle';
  }

  private clearOpenTimeout(): void {
    if (!this.openTimeout) return;
    clearTimeout(this.openTimeout);
    this.openTimeout = null;
  }

  private schedulePrewarmFallback(win: BrowserWindow): void {
    this.clearPrewarmTimeout();
    if (this.visible || this.pendingOpen) return;
    this.prewarmTimeout = setTimeout(() => {
      this.prewarmTimeout = null;
      if (win !== this.winRef || win.isDestroyed() || this.visible || this.pendingOpen) return;
      this.setSamplingActive(win, false);
      log.warn('resource-usage prewarm timed out; background sampling paused');
    }, this.deps.prewarmTimeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS);
    this.prewarmTimeout.unref?.();
  }

  private clearPrewarmTimeout(): void {
    if (!this.prewarmTimeout) return;
    clearTimeout(this.prewarmTimeout);
    this.prewarmTimeout = null;
  }

  private scheduleRecoveryStabilityReset(win: BrowserWindow): void {
    this.clearRecoveryStabilityTimeout();
    if (this.automaticRecoveryAttempts === 0) return;
    this.recoveryStabilityTimeout = setTimeout(() => {
      this.recoveryStabilityTimeout = null;
      if (win !== this.winRef || win.isDestroyed() || !this.presentationReady) return;
      this.automaticRecoveryAttempts = 0;
    }, this.deps.recoveryStabilityMs ?? DEFAULT_RECOVERY_STABILITY_MS);
    this.recoveryStabilityTimeout.unref?.();
  }

  private clearRecoveryStabilityTimeout(): void {
    if (!this.recoveryStabilityTimeout) return;
    clearTimeout(this.recoveryStabilityTimeout);
    this.recoveryStabilityTimeout = null;
  }

  private scheduleLeaveFallback(win: BrowserWindow, generation: number): void {
    this.clearLeaveTimeout();
    this.leaveTimeout = setTimeout(() => {
      this.leaveTimeout = null;
      if (win !== this.winRef || win.isDestroyed()) return;
      if (this.pendingLeaveGeneration !== generation) return;
      log.warn('resource-usage fullscreen leave timed out; hiding without leave-full-screen');
      this.finishHide(win, generation);
    }, this.deps.leaveTimeoutMs ?? DEFAULT_LEAVE_TIMEOUT_MS);
    this.leaveTimeout.unref?.();
  }

  private clearLeaveTimeout(): void {
    if (!this.leaveTimeout) return;
    clearTimeout(this.leaveTimeout);
    this.leaveTimeout = null;
  }

  private onRendererReloadStarted(win: BrowserWindow): void {
    if (win !== this.winRef || win.isDestroyed()) return;
    const shouldRestore = this.visible || this.pendingOpen;
    if (this.visible) win.hide();
    this.rendererReady = false;
    this.presentationReady = false;
    this.setSamplingActive(win, true);
    if (shouldRestore) {
      this.pendingOpen = true;
      this.scheduleOpenFallback(win);
      return;
    }
    this.schedulePrewarmFallback(win);
  }

  private invalidateWindow(win: BrowserWindow, reason: string): void {
    if (win !== this.winRef || win.isDestroyed()) return;
    const reopen = this.pendingOpen || this.visible;
    const owner = this.lastOwner;
    log.warn('resource-usage cached window invalidated', { reason, reopen });
    this.destroyCachedWindow(win, { preserveOwner: reopen });
    if (!reopen || this.disposed) return;
    if (this.automaticRecoveryAttempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      log.error('resource-usage automatic recovery exhausted', { reason });
      return;
    }
    this.automaticRecoveryAttempts += 1;
    this.pendingOpen = true;
    this.unbindOwnerVisibility();
    this.lastOwner = owner && !owner.isDestroyed() ? owner : null;
    this.bindOwnerVisibility(this.lastOwner);
    const replacement = this.ensureWindow();
    if (!replacement) {
      this.pendingOpen = false;
      return;
    }
    this.setSamplingActive(replacement, true);
    this.scheduleOpenFallback(replacement);
  }

  private destroyCachedWindow(win: BrowserWindow, options: { preserveOwner?: boolean } = {}): void {
    if (win !== this.winRef) return;
    this.setSamplingActive(win, false);
    this.resetWindowState({ preserveOwner: options.preserveOwner });
    this.destroyingWindow = true;
    try {
      if (!win.isDestroyed()) win.destroy();
    } finally {
      this.destroyingWindow = false;
    }
  }
}
