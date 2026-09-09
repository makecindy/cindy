/**
 * 资源用量辅助窗口的预热、显示和回收状态机。
 *
 * 窗口在主界面稳定后提前创建。renderer 在隐藏阶段挂载；Windows 的首份采样延迟到用户
 * 主动打开，其他平台保留隐藏快照预热。普通关闭仅隐藏，主窗口真正销毁或退出时才销毁。
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
  isMinimized(): boolean;
  isVisible?(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  on?(event: 'hide' | 'minimize' | 'closed', listener: () => void): unknown;
}

export interface ResourceUsageWindowControllerDeps {
  createWindow: () => BrowserWindow;
  isOpenSender: (sender: WebContents) => boolean;
  /** 打开监视器的那扇应用窗；用于跟随显隐并在关闭监视器后恢复焦点。 */
  getOwnerWindow?: (sender: WebContents) => ResourceUsageOwnerWindow | null;
  /** 测试注入；默认 process.platform。Windows 用于延迟昂贵的进程扫描。 */
  platform?: NodeJS.Platform;
  /** 测试注入；默认走 main i18n 的当前 locale。 */
  resolveNativeTitle?: (locale: SupportedLocale | null) => string;
  openTimeoutMs?: number;
  prewarmTimeoutMs?: number;
  recoveryStabilityMs?: number;
  /** 测试注入；macOS 退出全屏若没有 leave-full-screen，到期后仍完成隐藏。 */
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
  private samplingActive = false;
  private automaticRecoveryAttempts = 0;
  private destroyingWindow = false;
  private disposed = false;
  private locale: SupportedLocale | null = null;
  private lastOwner: ResourceUsageOwnerWindow | null = null;
  private ownerHideUnsubscribers: Array<() => void> = [];
  /** macOS 原生全屏动画开始后，isFullScreen() 在 enter-full-screen 前仍可能返回 false。 */
  private enteringNativeFullscreen = false;
  /** 关闭全屏与重新打开可能交错；迟到的 leave-full-screen 只能完成原来的隐藏请求。 */
  private visibilityGeneration = 0;

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
    if (!this.samplingActive && !this.visible && !this.pendingOpen) this.clearPrewarmTimeout();
    return true;
  }

  /** 首份快照已提交；完成待显示内容，隐藏时停止后台采样但保留表格状态。 */
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

  /**
   * process-monitor 的 Main 侧二次门禁。资源窗口隐藏预热时即使 renderer 错误订阅，
   * Windows 也不能因此拉起 OS 进程扫描；主窗口里可见的旧兼容页签不受影响。
   */
  allowsProcessMonitorSampling(sender: WebContents): boolean {
    const win = this.winRef;
    if (!win || win.isDestroyed() || sender !== win.webContents) return true;
    return this.samplingActive;
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
    // Windows 预热只加载 BrowserWindow / renderer。昂贵且可能触发安全软件管道异常的
    // OS 扫描必须等用户显式 open；其他平台保留既有首份快照预热体验。
    this.samplingActive = this.pendingOpen || this.platform() !== 'win32';
    this.destroyingWindow = false;
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
    win.on('enter-full-screen', () => {
      if (win === this.winRef && !win.isDestroyed()) this.enteringNativeFullscreen = false;
    });
    win.on('leave-full-screen', () => {
      if (win === this.winRef && !win.isDestroyed()) this.enteringNativeFullscreen = false;
    });
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
    if (!win.isVisible()) this.enteringNativeFullscreen = false;
    this.visibilityGeneration += 1;
    this.setSamplingActive(win, true);
    if (win.isMinimized()) win.restore();
    // 打开时只负责显示和聚焦，不再按 owner 状态驱动 setFullScreen。
    // macOS 沿用本窗口的原生 Space / 全屏呈现；仅关闭时显式退出全屏再隐藏。
    win.show();
    win.focus();
    this.visible = true;
  }

  private hideWindow(win: BrowserWindow, options: { restoreOwner?: boolean } = {}): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.clearLeaveTimeout();
    this.pendingOpen = false;
    this.setSamplingActive(win, false);
    if (win.isDestroyed()) return;
    const generation = ++this.visibilityGeneration;
    const finishHide = (): void => {
      if (generation !== this.visibilityGeneration || win !== this.winRef || win.isDestroyed()) {
        return;
      }
      this.visibilityGeneration += 1;
      this.clearLeaveTimeout();
      if (win.isVisible()) win.hide();
      this.visible = false;
      if (options.restoreOwner !== false) this.focusOwnerWindow();
    };
    if (this.platform() === 'darwin' && (this.enteringNativeFullscreen || win.isFullScreen())) {
      win.once('leave-full-screen', finishHide);
      win.setFullScreen(false);
      this.leaveTimeout = setTimeout(
        finishHide,
        this.deps.leaveTimeoutMs ?? DEFAULT_LEAVE_TIMEOUT_MS,
      );
      this.leaveTimeout.unref?.();
      return;
    }
    finishHide();
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
    // macOS 切换独立窗口的原生全屏 Space 时，owner 可能短暂发出 hide；把它
    // 当成“主窗口主动隐藏”会立刻 hide 正在进入全屏的资源窗口。这里把它作为进入动画
    // 已开始的早期信号，确保 enter-full-screen 尚未到达时关闭也会先取消原生转换。
    if (this.platform() === 'darwin') {
      const trackFullscreenEntry = () => this.trackFullscreenEntryFromOwnerHide();
      owner.on('hide', trackFullscreenEntry);
      owner.on('minimize', hide);
      owner.on('closed', hide);
      this.ownerHideUnsubscribers = [
        () => this.safeOff(owner, 'hide', trackFullscreenEntry),
        () => this.safeOff(owner, 'minimize', hide),
        () => this.safeOff(owner, 'closed', hide),
      ];
      return;
    }
    const events: Array<'hide' | 'minimize' | 'closed'> = ['hide', 'minimize', 'closed'];
    for (const event of events) owner.on(event, hide);
    this.ownerHideUnsubscribers = events.map((event) => () => this.safeOff(owner, event, hide));
  }

  private trackFullscreenEntryFromOwnerHide(): void {
    const win = this.winRef;
    if (!win || win.isDestroyed() || !win.isVisible() || win.isFullScreen()) return;
    this.enteringNativeFullscreen = true;
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
    this.samplingActive = false;
    this.destroyingWindow = false;
    this.enteringNativeFullscreen = false;
    if (!options.preserveOwner) {
      this.unbindOwnerVisibility();
      this.lastOwner = null;
    }
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

  private clearLeaveTimeout(): void {
    if (!this.leaveTimeout) return;
    clearTimeout(this.leaveTimeout);
    this.leaveTimeout = null;
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

  private onRendererReloadStarted(win: BrowserWindow): void {
    if (win !== this.winRef || win.isDestroyed()) return;
    const shouldRestore = this.visible || this.pendingOpen;
    if (this.visible) win.hide();
    this.rendererReady = false;
    this.presentationReady = false;
    this.setSamplingActive(win, shouldRestore || this.platform() !== 'win32');
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
