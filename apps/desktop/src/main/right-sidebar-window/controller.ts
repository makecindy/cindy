/**
 * RsbWindowController —— 右侧栏独立子窗口的状态机(main 侧单例,依赖注入可测)。
 *
 * 三态模型(与偏好 detached / 运行时窗口开闭正交组合):
 *   A. detached=false            —— 现状:侧边栏内嵌在主窗
 *   B. detached=true, 窗口关闭   —— 偏好开着但用户收起了(隐藏子窗口)
 *   C. detached=true, 窗口打开   —— 侧边栏活在子窗口里
 *
 * 生命周期基线对齐 PR #2434 的 ResourceUsageWindowController 与
 * docs/dev-rules/electron-security-and-process-boundaries.md §3.1:
 *   - 后台预热：创建隐藏窗口 + renderer 挂载 + 首份 context 就绪
 *   - 双阶段就绪握手（renderer-ready → presentation-ready），超时展示 Loading 壳
 *   - 隐藏复用：普通关窗只 hide，setDetached(false) 才真正 dispose
 *   - 崩溃恢复有界
 *   - 隐藏时暂停后台重活、重置瞬时交互态
 *
 * 不直接 import electron —— BrowserWindow 的创建 / 主窗引用 / 广播全部由
 * bootstrap-electron 注入,单测用 mock deps 直接驱动状态机。
 */

import type { BrowserWindow, WebContents } from 'electron';

import type {
  RsbWindowCommand,
  RsbWindowCommandRouteRequest,
  RsbWindowCommandRouteResult,
  RsbWindowContext,
  RsbWindowState,
} from '../../shared/rightSidebarWindow.js';
import {
  RSB_WINDOW_LOCALE_CHANGED_CHANNEL,
  RSB_WINDOW_PRESENTATION_READY_CHANNEL,
  RSB_WINDOW_RENDERER_READY_CHANNEL,
  RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../../shared/rightSidebarWindow.js';
import type { SupportedLocale } from '../../shared/locale.js';
import type { RsbWindowSettings } from './settings-store.js';

interface ControllerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface RsbWindowControllerDeps {
  settings: {
    read(): RsbWindowSettings;
    writePatch(patch: Partial<RsbWindowSettings>): void;
  };
  /**
   * 创建子窗口(不负责挂 closed 钩子,controller 自己挂)。
   * 窗口以 show:false 创建,由 controller 的 presentation-ready 握手决定展示时机。
   */
  createWindow: () => BrowserWindow;
  getMainWindow: () => BrowserWindow | null;
  /** 状态变化广播(所有窗口)。bootstrap 注入 getAllWindows 遍历实现。 */
  broadcastState: (state: { detached: boolean; open: boolean }) => void;
  /** 向裁决后的 renderer host 推送 context / command；窗口有效性由 controller 保证。 */
  sendToWindow: (win: BrowserWindow, channel: string, payload: unknown) => void;
  contextChannel: string;
  commandChannel: string;
  isQuitting: () => boolean;
  /** Popup WindowProxy depends on the ordinary webview opener staying alive. */
  canCloseWindow?: () => boolean;
  log: ControllerLogger;
}

/** ensureOpenForAutomation 等 renderer ready 握手的超时。 */
const READY_TIMEOUT_MS = 8000;
const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_PREWARM_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_STABILITY_MS = 30_000;
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 1;
const MAX_DEFERRED_SESSIONS = 8;
/**
 * 单会话 deferred 队列上限。正常路径远达不到(passive 命令种类有限且有合并
 * 规则);达到时丢最旧一条并记 warn —— 不能静默,登记类命令被丢意味着这次
 * 登记在窗口打开前不再有落点(#2409 的溢出策略要求)。
 */
const MAX_DEFERRED_COMMANDS_PER_SESSION = 32;

/**
 * command 的宿主桶 session —— 裁决可见性与 deferred 排队都以它为准。
 * open-turn-review 可跨会话(协同面板审查 worker 轮次:sessionId 是取数目标
 * worker,tab 落在 lead 的桶),其余命令宿主即自身 sessionId。
 */
function commandHostSessionId(cmd: RsbWindowCommand): string {
  return cmd.type === 'open-turn-review' ? (cmd.hostSessionId ?? cmd.sessionId) : cmd.sessionId;
}

/**
 * 队列里最近一条 close-orca-workers-tab **之后**的段。ensure 合并判定只能在
 * 这个段里做:close 是语义屏障,[显式 ensure, close, generic ensure] 里最后的
 * generic ensure 是「close 之后重新打开」的最新意图,匹配屏障前的历史 ensure
 * 会让 flush 终态停在 close、丢掉重开。
 */
function segmentAfterLastOrcaClose(queue: readonly RsbWindowCommand[]): readonly RsbWindowCommand[] {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].type === 'close-orca-workers-tab') return queue.slice(i + 1);
  }
  return queue;
}

export class RsbWindowController {
  private winRef: BrowserWindow | null = null;
  private destroyingWindow = false;
  private rendererReady = false;
  private presentationReady = false;
  private visible = false;
  private pendingOpen = false;
  private pendingOpenShouldFocus = true;
  private disposed = false;
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];
  private openTimeout: NodeJS.Timeout | null = null;
  private prewarmTimeout: NodeJS.Timeout | null = null;
  private recoveryStabilityTimeout: NodeJS.Timeout | null = null;
  private automaticRecoveryAttempts = 0;
  private lastContext: RsbWindowContext | null = null;
  /**
   * allowOpen=false 时按宿主 session 保序排队的 deferred 命令。
   *
   * 每会话保留**一组有序 intent** 而不是一条(#2409):此前同会话后到的
   * passive 命令直接覆盖先到的,登记类命令(如历史挂载的 subagent 页签静默
   * 登记)会被随后的 Orca ensure/close intent 顶掉,窗口再打开时这次登记
   * 没有落点——renderer 侧按设计只在 attached 结果下写本地 store,队列是
   * queued 命令唯一的交付路径。语义不同的命令保序全量下发;完全等价的重复
   * 帧与「generic ensure 不得顶掉更具体的 Orca intent」在 enqueue 时合并。
   */
  private deferredCommands = new Map<string, RsbWindowCommand[]>();
  private locale: SupportedLocale | null = null;

  constructor(private readonly deps: RsbWindowControllerDeps) {}

  // ══════════════════════════════════════════════════════════════════════
  // 公共接口
  // ══════════════════════════════════════════════════════════════════════

  getState(): RsbWindowState {
    const s = this.deps.settings.read();
    // pendingOpen:窗口已创建但等待 presentation-ready,外部视为 open。
    return { detached: s.detached, lastOpen: s.lastOpen, open: this.isOpen() || this.pendingOpen };
  }

  /** 后台预热：主窗口首帧后创建隐藏窗口并挂载 renderer。不改变用户焦点。 */
  prewarm(): void {
    if (this.disposed) return;
    this.ensureWindow();
  }

  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    if (!this.winRef || this.winRef.isDestroyed()) return;
    try {
      this.winRef.webContents.send(RSB_WINDOW_LOCALE_CHANGED_CHANNEL, locale);
    } catch {
      // Window may be tearing down.
    }
  }

  /**
   * 幂等打开:热窗口(presentationReady)立即显示；冷窗口等待首份业务内容，
   * 超时按 Loading 壳兜底。
   */
  open(opts: { userInitiated?: boolean } = {}): void {
    if (this.disposed) return;
    const userInitiated = opts.userInitiated !== false;

    this.automaticRecoveryAttempts = 0;
    this.clearRecoveryStabilityTimeout();
    this.deps.settings.writePatch({ lastOpen: true });

    if (this.winRef && !this.winRef.isDestroyed()) {
      if (this.visible && this.winRef.isVisible()) {
        if (userInitiated) {
          this.pendingOpenShouldFocus = true;
          this.winRef.focus();
        }
        return;
      }
      if (this.presentationReady) {
        this.showWindow(this.winRef, userInitiated);
        return;
      }
      // 窗口存在但渲染尚未完成，等待 presentation-ready 或超时
      this.winRef.webContents.setBackgroundThrottling(false);
      this.pendingOpenShouldFocus = this.pendingOpen
        ? this.pendingOpenShouldFocus || userInitiated
        : userInitiated;
      this.pendingOpen = true;
      this.scheduleOpenFallback(this.winRef);
      this.broadcast();
      return;
    }

    this.pendingOpen = true;
    this.pendingOpenShouldFocus = userInitiated;
    const win = this.ensureWindow();
    if (!win) {
      this.pendingOpen = false;
      this.pendingOpenShouldFocus = true;
      return;
    }
    if (this.presentationReady) {
      this.showWindow(win, userInitiated);
      return;
    }
    this.scheduleOpenFallback(win);
    this.broadcast();
  }

  /** 普通关窗只隐藏(保留 renderer + context，供下次瞬时恢复)。 */
  close(): void {
    if (this.winRef && !this.winRef.isDestroyed()) {
      this.hideWindow(this.winRef);
    } else {
      this.deps.settings.writePatch({ lastOpen: false });
      this.pendingOpen = false;
      this.pendingOpenShouldFocus = true;
      this.broadcast();
    }
  }

  /** 写偏好;true 附带开窗,false 附带真正销毁窗口 + 恢复主窗内嵌侧栏。 */
  setDetached(next: boolean): RsbWindowState {
    this.deps.settings.writePatch({ detached: next });
    if (next) {
      this.open({ userInitiated: true });
    } else {
      this.flushDeferredCommandsToAttachedHost();
      this.disposeCachedWindow();
    }
    return this.getState();
  }

  // ── 双阶段就绪握手 ─────────────────────────────────────────────────

  /** renderer 根组件已挂载；用于确认超时兜底至少有 React 壳可展示。 */
  markRendererReady(sender: WebContents): boolean {
    const win = this.winRef;
    if (!win || win.isDestroyed() || sender !== win.webContents) return false;
    this.rendererReady = true;
    if (this.locale) {
      try {
        sender.send(RSB_WINDOW_LOCALE_CHANGED_CHANNEL, this.locale);
      } catch {
        // Renderer may be tearing down.
      }
    }
    return true;
  }

  /** 首份业务内容已提交；隐藏预热到此结束。 */
  markPresentationReady(sender: WebContents): boolean {
    const win = this.winRef;
    if (!win || win.isDestroyed() || sender !== win.webContents) return false;
    this.presentationReady = true;
    // 预热期间临时保持 renderer 可调度，避免 show:false 窗口的 React effect / IPC
    // 被后台节流拖到点击路径。壳首帧提交后立即恢复 Electron 默认节流策略。
    sender.setBackgroundThrottling(true);
    this.scheduleRecoveryStabilityReset();
    this.clearPrewarmTimeout();
    const waiters = this.readyWaiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timeout);
      w.resolve();
    }
    if (this.pendingOpen) {
      this.showWindow(win, this.pendingOpenShouldFocus);
    }
    // 无论是纯预热还是用户点击打开，presentation-ready 都是 deferred
    // command 可以安全交付的统一边界。不能在 showWindow 后提前返回，否则
    // 点击路径会永久留下此前排队的 passive intent。
    this.flushDeferredCommandsToDetachedHost();
    return true;
  }

  /** 子窗口请求刷新 context（从 main 缓存拉最新值推回）。 */
  refreshContext(sender: WebContents): void {
    const win = this.winRef;
    if (!win || win.isDestroyed() || sender !== win.webContents) return;
    // 隐藏预热/复用窗口只保留已挂载的标签主体，不接收新的会话上下文。
    // 显示时 renderer 会重新请求最新快照，再恢复交互。
    if (!this.visible) return;
    if (!this.lastContext) return;
    this.deps.sendToWindow(win, this.deps.contextChannel, this.lastContext);
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /** 主窗口真实销毁时回收其子窗口；controller 仍可随下一扇主窗口重新预热。 */
  destroyWindow(): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.pendingOpen = false;
    if (!this.winRef || this.winRef.isDestroyed()) {
      this.resetWindowState();
      return;
    }
    this.destroyCachedWindow();
  }

  /** 应用退出时永久停止该 controller，并同步销毁缓存窗口。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyWindow();
  }

  // ── ensureOpen / context / routeCommand ─────────────────────────────

  /**
   * agent tab-op(浏览器自动化)前置:detached 且窗口未就绪时先开窗并等 ready 握手。
   */
  ensureOpenForAutomation(opts: { userInitiated?: boolean } = {}): Promise<void> {
    if (!this.deps.settings.read().detached) return Promise.resolve();
    this.open({ userInitiated: opts.userInitiated === true });
    if (this.presentationReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.readyWaiters.findIndex((w) => w.timeout === timeout);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        reject(new Error(`right-sidebar window ready timeout after ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      this.readyWaiters.push({ resolve, reject, timeout });
    });
  }

  /** 主窗上报渲染上下文:缓存 + 窗口活跃就转发。 */
  setContext(ctx: RsbWindowContext): void {
    const previousSessionId = this.lastContext?.sessionId ?? null;
    this.lastContext = ctx;
    if (!ctx.available || !ctx.sessionId) {
      this.deferredCommands.clear();
    } else if (previousSessionId !== ctx.sessionId) {
      for (const sessionId of this.deferredCommands.keys()) {
        if (sessionId !== ctx.sessionId) this.deferredCommands.delete(sessionId);
      }
    }
    if (this.visible && this.winRef && !this.winRef.isDestroyed()) {
      this.deps.sendToWindow(this.winRef, this.deps.contextChannel, ctx);
    }
    this.flushDeferredCommandsToDetachedHost();
  }

  getContext(): RsbWindowContext | null {
    // 隐藏预热只准备 renderer 壳，不注入当前任务上下文。真实显示后由
    // visibility-changed → refreshContext 交付最新缓存，避免后台 hydrate 会话面板。
    return this.visible ? this.lastContext : null;
  }

  /** main 原子裁决 command ownership；renderer 只在 attached 结果下写本地 store。 */
  async routeCommand(
    request: RsbWindowCommandRouteRequest,
  ): Promise<RsbWindowCommandRouteResult> {
    const { command, allowOpen } = request;
    const userInitiated = request.userInitiated !== false;
    if (!this.deps.settings.read().detached) return 'attached';
    if (!this.canDispatchCommand(command)) return 'stale-context';

    const windowAlive = this.winRef && !this.winRef.isDestroyed();
    if (!allowOpen && (!windowAlive || !this.presentationReady || !this.visible)) {
      this.enqueueDeferredCommand(command);
      return 'queued';
    }

    if (allowOpen && (!this.isOpen() || !this.presentationReady)) {
      try {
        await this.ensureOpenForAutomation({ userInitiated });
      } catch (err) {
        if (!this.deps.settings.read().detached) return 'attached';
        if (!this.canDispatchCommand(command)) return 'stale-context';
        throw err;
      }
    }

    if (!this.deps.settings.read().detached) return 'attached';
    if (!this.canDispatchCommand(command)) return 'stale-context';
    const windowReady = this.winRef && !this.winRef.isDestroyed() && this.presentationReady;
    if (!windowReady) {
      if (!allowOpen) {
        this.enqueueDeferredCommand(command);
        return 'queued';
      }
      return 'stale-context';
    }

    const win = this.winRef;
    if (!win || win.isDestroyed()) return 'stale-context';
    this.deps.sendToWindow(win, this.deps.commandChannel, command);
    return 'routed';
  }

  // ══════════════════════════════════════════════════════════════════════
  // 窗口生命周期
  // ══════════════════════════════════════════════════════════════════════

  getHostWebContents(): WebContents | null {
    if (
      this.deps.settings.read().detached &&
      this.visible &&
      this.winRef &&
      !this.winRef.isDestroyed()
    ) {
      return this.winRef.webContents;
    }
    const main = this.deps.getMainWindow();
    return main && !main.isDestroyed() ? main.webContents : null;
  }

  /** IPC 层校验 sender 用。 */
  getSidebarWebContents(): WebContents | null {
    return this.winRef && !this.winRef.isDestroyed()
      ? this.winRef.webContents
      : null;
  }

  /**
   * Return the detached sidebar renderer only while it is visible.
   *
   * The cached hidden renderer remains a valid IPC sender (for lifecycle
   * handshakes and preload event guards), but it must not stay in capability
   * target lists while the user cannot see or interact with it.
   */
  getVisibleSidebarWebContents(): WebContents | null {
    return this.visible && this.winRef && !this.winRef.isDestroyed()
      ? this.winRef.webContents
      : null;
  }

  /** 窗口存在 + 可见(隐藏复用模型中隐藏不算 open)。 */
  isOpen(): boolean {
    return (
      this.winRef !== null &&
      !this.winRef.isDestroyed() &&
      this.visible
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部实现
  // ══════════════════════════════════════════════════════════════════════

  private ensureWindow(): BrowserWindow | null {
    if (this.winRef && !this.winRef.isDestroyed()) return this.winRef;
    let win: BrowserWindow;
    try {
      win = this.deps.createWindow();
    } catch (error) {
      this.resetWindowState();
      this.deps.log.warn('right-sidebar window creation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    this.winRef = win;
    this.rendererReady = false;
    this.presentationReady = false;
    this.visible = false;
    this.destroyingWindow = false;
    // 只覆盖隐藏预热的短暂初始化阶段。presentation-ready 后会恢复为 true，
    // 因此长期隐藏复用仍按 Electron 默认策略节流，不增加持续后台开销。
    win.webContents.setBackgroundThrottling(false);

    win.on('close', (event) => {
      if (this.destroyingWindow || this.disposed) return;
      event.preventDefault();
      if (this.deps.canCloseWindow?.() === false) {
        this.deps.log.warn('right-sidebar window close blocked by active browser popup');
        return;
      }
      this.hideWindow(win);
    });
    win.on('closed', () => this.onClosed(win));
    // 原生最小化不会触发 controller.close()，但对主窗口来说同样需要一个
    // 可恢复入口。把 minimized 映射为 open:false，同时保留 lastOpen 和
    // renderer；用户点击入口时 open() 会 restore + focus 同一个热窗口。
    win.on('show', () => this.onNativeVisibilityChanged(win, true));
    win.on('restore', () => this.onNativeVisibilityChanged(win, true));
    win.on('hide', () => this.onNativeVisibilityChanged(win, false));
    win.on('minimize', () => this.onNativeVisibilityChanged(win, false));
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.onRendererReloadStarted(win);
    });
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

  private showWindow(win: BrowserWindow, shouldFocus: boolean): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.pendingOpen = false;
    this.pendingOpenShouldFocus = shouldFocus;
    if (win.isMinimized()) win.restore();
    win.webContents.setBackgroundThrottling(true);
    if (shouldFocus) {
      win.show();
      win.focus();
    } else {
      win.showInactive();
    }
    this.visible = true;
    // lastOpen 由 open() 在外层写，这里只负责展示
    this.deps.sendToWindow(win, RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible: true });
    // 隐藏复用期间的 passive 命令不能在用户看不见时改动子窗口 store；
    // 窗口重新显示后按原顺序统一交付。
    this.flushDeferredCommandsToDetachedHost();
    this.broadcast();
  }

  private hideWindow(win: BrowserWindow): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    this.pendingOpen = false;
    this.pendingOpenShouldFocus = true;
    if (win.isVisible()) win.hide();
    this.visible = false;
    try {
      this.deps.sendToWindow(win, RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible: false });
    } catch {
      // 窗口可能在 isVisible 检查与 send 之间被系统销毁
    }
    this.deps.settings.writePatch({ lastOpen: false });
    this.broadcast();
    this.deps.log.info('right-sidebar window hidden');
  }

  private onNativeVisibilityChanged(win: BrowserWindow, visible: boolean): void {
    if (win !== this.winRef || win.isDestroyed() || this.destroyingWindow || this.disposed) return;
    if (this.visible === visible && !this.pendingOpen) return;
    this.visible = visible;
    if (visible) this.pendingOpen = false;
    try {
      this.deps.sendToWindow(win, RSB_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible });
    } catch {
      // Native visibility can change while the renderer is tearing down.
    }
    this.broadcast();
  }

  private onClosed(win: BrowserWindow): void {
    if (win !== this.winRef) return;
    this.resetWindowState();
  }

  private resetWindowState(): void {
    this.clearOpenTimeout();
    this.clearPrewarmTimeout();
    // 注意:不清理 recoveryStabilityTimeout — 它跟踪的是 controller 级别的
    // 自动恢复额度,不跟随单个窗口实例的销毁而去。
    this.winRef = null;
    this.rendererReady = false;
    this.presentationReady = false;
    this.visible = false;
    this.pendingOpen = false;
    this.pendingOpenShouldFocus = true;
    this.destroyingWindow = false;

    const waiters = this.readyWaiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timeout);
      w.reject(new Error('right-sidebar window closed before ready'));
    }

    if (this.deps.isQuitting()) return;
    this.deps.settings.writePatch({ lastOpen: false });
    this.broadcast();
    this.deps.log.info('right-sidebar window closed');
  }

  // ── 超时与恢复 ────────────────────────────────────────────────────

  private scheduleOpenFallback(win: BrowserWindow): void {
    this.clearOpenTimeout();
    this.openTimeout = setTimeout(() => {
      this.openTimeout = null;
      if (win !== this.winRef || win.isDestroyed() || !this.pendingOpen) return;
      // renderer shell 未就绪时仍展示(loadURL 在 BrowserWindow 创建时就开始了,
      // 5s 足够 Electron 完成 HTML 加载和 React 根挂载);即使只有 Loading 壳也是
      // 可辨识的反馈,比永久不给用户任何反应好。
      if (!this.rendererReady && !this.visible) {
        this.deps.log.warn('right-sidebar open timed out before renderer-ready');
      }
      if (!this.visible) this.showWindow(win, this.pendingOpenShouldFocus);
    }, DEFAULT_OPEN_TIMEOUT_MS);
    this.openTimeout.unref?.();
  }

  private schedulePrewarmFallback(win: BrowserWindow): void {
    this.clearPrewarmTimeout();
    if (this.visible || this.pendingOpen) return;
    this.prewarmTimeout = setTimeout(() => {
      this.prewarmTimeout = null;
      if (win !== this.winRef || win.isDestroyed() || this.visible || this.pendingOpen) return;
      win.webContents.setBackgroundThrottling(true);
      this.deps.log.warn('right-sidebar prewarm timed out; keeping cached window');
    }, DEFAULT_PREWARM_TIMEOUT_MS);
    this.prewarmTimeout.unref?.();
  }

  private scheduleRecoveryStabilityReset(): void {
    this.clearRecoveryStabilityTimeout();
    if (this.automaticRecoveryAttempts === 0) return;
    this.recoveryStabilityTimeout = setTimeout(() => {
      this.recoveryStabilityTimeout = null;
      this.automaticRecoveryAttempts = 0;
    }, DEFAULT_RECOVERY_STABILITY_MS);
    this.recoveryStabilityTimeout.unref?.();
  }

  private clearOpenTimeout(): void {
    if (!this.openTimeout) return;
    clearTimeout(this.openTimeout);
    this.openTimeout = null;
  }

  private clearPrewarmTimeout(): void {
    if (!this.prewarmTimeout) return;
    clearTimeout(this.prewarmTimeout);
    this.prewarmTimeout = null;
  }

  private clearRecoveryStabilityTimeout(): void {
    if (!this.recoveryStabilityTimeout) return;
    clearTimeout(this.recoveryStabilityTimeout);
    this.recoveryStabilityTimeout = null;
  }

  // ── 崩溃恢复 ─────────────────────────────────────────────────────

  private onRendererReloadStarted(win: BrowserWindow): void {
    if (win !== this.winRef || win.isDestroyed()) return;
    const shouldRestore = this.visible || this.pendingOpen;
    if (shouldRestore) {
      this.pendingOpen = true;
    }
    if (this.visible) win.hide();
    win.webContents.setBackgroundThrottling(false);
    this.rendererReady = false;
    this.presentationReady = false;
    if (shouldRestore) {
      this.scheduleOpenFallback(win);
      return;
    }
    this.schedulePrewarmFallback(win);
  }

  private invalidateWindow(win: BrowserWindow, reason: string): void {
    if (win !== this.winRef || win.isDestroyed()) return;
    const reopen = this.pendingOpen || this.visible;
    const reopenShouldFocus = this.pendingOpenShouldFocus;
    this.deps.log.warn('right-sidebar cached window invalidated', { reason, reopen });
    this.destroyCachedWindow();
    if (!reopen || this.disposed) return;
    if (this.automaticRecoveryAttempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      this.deps.log.error('right-sidebar automatic recovery exhausted', { reason });
      return;
    }
    this.automaticRecoveryAttempts += 1;
    this.pendingOpen = true;
    this.pendingOpenShouldFocus = reopenShouldFocus;
    const replacement = this.ensureWindow();
    if (!replacement) {
      this.pendingOpen = false;
      this.pendingOpenShouldFocus = true;
      return;
    }
    this.scheduleOpenFallback(replacement);
  }

  // ── 销毁 ─────────────────────────────────────────────────────────

  private destroyCachedWindow(): void {
    const win = this.winRef;
    if (!win || win.isDestroyed()) {
      this.resetWindowState();
      return;
    }
    this.resetWindowState();
    this.destroyingWindow = true;
    try {
      if (!win.isDestroyed()) win.destroy();
    } finally {
      this.destroyingWindow = false;
    }
  }

  private disposeCachedWindow(): void {
    this.destroyCachedWindow();
    this.broadcast();
    this.deps.log.info('right-sidebar window disposed (merged back to main)');
  }

  // ── 命令路由辅助 ─────────────────────────────────────────────────

  private canDispatchCommand(cmd: RsbWindowCommand): boolean {
    return Boolean(
      this.lastContext?.available &&
        this.lastContext.sessionId &&
        this.lastContext.sessionId === commandHostSessionId(cmd),
    );
  }

  private enqueueDeferredCommand(command: RsbWindowCommand): void {
    const hostSessionId = commandHostSessionId(command);
    const queue = this.deferredCommands.get(hostSessionId);
    // Orca 既有优先规则:队列里已有 ensure-orca intent(带定位与否都算)时,
    // 后到的**无定位** generic ensure 忽略 —— 它既是重复帧去重,也保护更具体
    // 的旧 intent(focusWorkerSessionId / searchJump)不被稀释。判定止于最近的
    // close 屏障(segmentAfterLastOrcaClose),不匹配屏障前的历史 ensure。
    if (
      command.type === 'ensure-orca-workers-tab' &&
      command.focusWorkerSessionId === undefined &&
      command.searchJump === undefined &&
      queue &&
      segmentAfterLastOrcaClose(queue).some(
        (queued) => queued.type === 'ensure-orca-workers-tab',
      )
    ) {
      return;
    }
    // 完全等价的重复登记只做**相邻**合并(幂等帧,如同一挂载路径的重复静默
    // 登记必然连续到达)。隔着其他命令的等价帧不合并 —— 中间命令(如 close)
    // 可能已改变重放语义。
    const serialized = JSON.stringify(command);
    if (queue && queue.length > 0 && JSON.stringify(queue[queue.length - 1]) === serialized) {
      return;
    }
    if (!queue && this.deferredCommands.size >= MAX_DEFERRED_SESSIONS) {
      const oldest = this.deferredCommands.keys().next().value as string | undefined;
      if (oldest) this.deferredCommands.delete(oldest);
    }
    let next = queue ?? [];
    // open-turn-review 是同目标 last-write-wins 的载荷帧(同 session 的 review
    // tab 是单例):同目标旧帧被新帧**取代**而不是并存 —— flush 后 renderer 对
    // 命令是并发处理的,两帧同时在途时完成顺序不保证,旧载荷可能覆盖新载荷;
    // 队列里同目标只留最新一帧,竞态源头即消失。
    if (command.type === 'open-turn-review') {
      next = next.filter(
        (queued) =>
          !(queued.type === 'open-turn-review' && queued.sessionId === command.sessionId),
      );
    }
    if (next.length >= MAX_DEFERRED_COMMANDS_PER_SESSION) {
      const dropped = next.shift();
      this.deps.log.warn(
        `right-sidebar deferred queue overflow, dropping oldest command type=${dropped?.type ?? 'unknown'}`,
      );
    }
    next.push(command);
    this.deferredCommands.set(hostSessionId, next);
  }

  /**
   * 按入队顺序全量下发当前 context 会话的 deferred 队列。`isHostAlive` 逐条
   * 复查目标存活:批量下发中途窗口可能被销毁,剩余命令放回队列头等待下一个
   * host ready,不发往死窗口也不静默丢弃。
   */
  private flushDeferredCommands(
    isHostAlive: () => boolean,
    send: (command: RsbWindowCommand) => void,
  ): void {
    const sessionId = this.lastContext?.available ? this.lastContext.sessionId : null;
    if (!sessionId) return;
    const queue = this.deferredCommands.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.deferredCommands.delete(sessionId);
    for (let i = 0; i < queue.length; i += 1) {
      if (!isHostAlive()) {
        const remainder = queue.slice(i);
        const requeued = this.deferredCommands.get(sessionId);
        this.deferredCommands.set(
          sessionId,
          requeued ? [...remainder, ...requeued] : remainder,
        );
        return;
      }
      send(queue[i]);
    }
  }

  private flushDeferredCommandsToDetachedHost(): void {
    if (
      !this.deps.settings.read().detached ||
      !this.presentationReady ||
      !this.visible ||
      !this.winRef ||
      this.winRef.isDestroyed()
    ) {
      return;
    }
    this.flushDeferredCommands(
      () => Boolean(
        this.winRef &&
          !this.winRef.isDestroyed() &&
          this.visible &&
          !this.destroyingWindow &&
          !this.disposed,
      ),
      (command) => this.deps.sendToWindow(this.winRef!, this.deps.commandChannel, command),
    );
  }

  private flushDeferredCommandsToAttachedHost(): void {
    if (this.deps.settings.read().detached) return;
    const main = this.deps.getMainWindow();
    if (!main || main.isDestroyed()) return;
    this.flushDeferredCommands(
      () => !main.isDestroyed(),
      (command) => this.deps.sendToWindow(main, this.deps.commandChannel, command),
    );
  }

  private broadcast(): void {
    const s = this.deps.settings.read();
    // pendingOpen:窗口已创建但等待 presentation-ready,从调用方视角视为 open。
    this.deps.broadcastState({ detached: s.detached, open: this.isOpen() || this.pendingOpen });
  }
}
