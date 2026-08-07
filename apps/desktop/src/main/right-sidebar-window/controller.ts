/**
 * RsbWindowController —— 右侧栏独立子窗口的状态机(main 侧单例,依赖注入可测)。
 *
 * 三态模型(与偏好 detached / 运行时窗口开闭正交组合):
 *   A. detached=false            —— 现状:侧边栏内嵌在主窗
 *   B. detached=true, 窗口关闭   —— 偏好开着但用户收起了(关了子窗口)
 *   C. detached=true, 窗口打开   —— 侧边栏活在子窗口里
 *
 * 职责:
 *  - 窗口生命周期(单实例,重复 open = focus;closed 事件区分用户关窗 vs app 退出)
 *  - 偏好 / lastOpen 落盘(settings-store),状态变化广播所有窗口
 *  - 渲染上下文中转(主窗上报 → 缓存 → 转发子窗口)
 *  - RSB host webContents 解析(浏览器自动化 backend 的 tab-op / pin 通知路由):
 *    detached && 窗口开 → 子窗口,否则主窗
 *  - ensureOpenForAutomation:agent tab-op 在 B 态时先开窗、等 renderer ready 握手
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
import type { RsbWindowSettings } from './settings-store.js';

interface ControllerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface RsbWindowControllerDeps {
  settings: {
    read(): RsbWindowSettings;
    writePatch(patch: Partial<RsbWindowSettings>): void;
  };
  /**
   * 创建子窗口(不负责挂 closed 钩子,controller 自己挂)。
   * userInitiated=false 时实现方须用不抢焦点的方式显示(showInactive)。
   */
  createWindow: (opts: { userInitiated: boolean }) => BrowserWindow;
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
const MAX_DEFERRED_SESSIONS = 8;

/**
 * command 的宿主桶 session —— 裁决可见性与 deferred 排队都以它为准。
 * open-turn-review 可跨会话(协同面板审查 worker 轮次:sessionId 是取数目标
 * worker,tab 落在 lead 的桶),其余命令宿主即自身 sessionId。
 */
function commandHostSessionId(cmd: RsbWindowCommand): string {
  return cmd.type === 'open-turn-review' ? (cmd.hostSessionId ?? cmd.sessionId) : cmd.sessionId;
}

export class RsbWindowController {
  private winRef: BrowserWindow | null = null;
  /** BrowserWindow.close() 到 closed 事件之间仍未 destroyed，不能继续当活 host。 */
  private closing = false;
  /** 子窗口 renderer 根组件已挂载(READY 握手过)。窗口销毁时复位。 */
  private ready = false;
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];
  private lastContext: RsbWindowContext | null = null;
  /** allowOpen=false 时每个 session 只保留最终有效命令，避免 remote memory intent 丢失。 */
  private deferredCommands = new Map<string, RsbWindowCommand>();
  private closeWaiters: Array<() => void> = [];

  constructor(private readonly deps: RsbWindowControllerDeps) {}

  getState(): RsbWindowState {
    const s = this.deps.settings.read();
    return { detached: s.detached, lastOpen: s.lastOpen, open: this.isOpen() };
  }

  /**
   * 幂等打开:已开则 show + focus;未开则建窗 + lastOpen=true + 广播。
   *
   * userInitiated(缺省 true)= 这次开窗是用户当次手势要求的,保持既有
   * 「带出并聚焦子窗口」行为。程序自发的开窗(插件 preview 槽、agent
   * 浏览器自动化)必须传 false:
   *  - 窗口已经开着 → **什么都不做**。内容经命令通道照常送达,用户看得见;
   *    这里再 show/focus 只会把用户正在用的别的应用顶掉(Windows 上
   *    focus() 即抢前台),属于纯粹的干扰。
   *  - 窗口还没开 → 照常建窗,但由 createWindow 走 showInactive 不抢焦点。
   */
  open(opts: { userInitiated?: boolean } = {}): void {
    const userInitiated = opts.userInitiated !== false;
    if (this.winRef && !this.winRef.isDestroyed()) {
      if (this.closing) return;
      if (!userInitiated) return;
      if (this.winRef.isMinimized()) this.winRef.restore();
      this.winRef.show();
      this.winRef.focus();
      return;
    }
    const win = this.deps.createWindow({ userInitiated });
    this.winRef = win;
    this.closing = false;
    this.ready = false;
    win.on('close', (event) => {
      if (this.deps.isQuitting() || this.deps.canCloseWindow?.() !== false) return;
      event.preventDefault();
      this.closing = false;
      this.deps.log.warn('right-sidebar window close blocked by active browser popup');
    });
    win.on('closed', () => this.onClosed());
    this.deps.settings.writePatch({ lastOpen: true });
    this.broadcast();
    this.deps.log.info('right-sidebar window opened');
  }

  /** 关闭子窗口(toggle 收起 / 合并回主窗)。窗口不存在时也保证 lastOpen 落 false。 */
  close(): void {
    this.deps.settings.writePatch({ lastOpen: false });
    if (this.winRef && !this.winRef.isDestroyed()) {
      // onClosed 会广播 {open:false},这里不重复
      this.closing = true;
      this.winRef.close();
    } else {
      this.closing = false;
      this.broadcast();
    }
  }

  /** 写偏好;true 附带开窗,false 附带关窗。返回新 state 供 invoke handler 直接回。 */
  setDetached(next: boolean): RsbWindowState {
    this.deps.settings.writePatch({ detached: next });
    if (next) {
      // 唯一入口是用户点「在新窗口中打开」按钮 —— 明确的用户手势,该带出并聚焦。
      this.open({ userInitiated: true });
    } else {
      // queued 调用方早已返回；attach 时必须把 ownership 显式交回主 renderer。
      this.flushDeferredCommandsToAttachedHost();
      this.close();
    }
    // open()/close() 已各自广播,但两者都可能命中"窗口状态没变"的幂等分支
    // (如重复 setDetached(true)),兜底再广播一次保证 detached 变化必达。
    this.broadcast();
    return this.getState();
  }

  /** 子窗口 renderer 根组件挂载握手。 */
  markReady(): void {
    this.ready = true;
    const waiters = this.readyWaiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timeout);
      w.resolve();
    }
    this.flushDeferredCommandsToDetachedHost();
  }

  /**
   * agent tab-op(浏览器自动化)前置:detached 且窗口未就绪时先开窗并等 ready 握手,
   * 保证 dispatchTabOp 时子窗口 renderer 的 RSB store / webview 池已可用。
   * 非 detached 时 no-op(host 是主窗,常驻)。
   */
  ensureOpenForAutomation(opts: { userInitiated?: boolean } = {}): Promise<void> {
    if (!this.deps.settings.read().detached) return Promise.resolve();
    if (this.ready && this.winRef && !this.winRef.isDestroyed()) return Promise.resolve();
    // 缺省 false:本入口的名字就是 "for automation" —— 调用方没表态时按
    // 「程序自发」处理,不抢用户焦点。用户手势路径显式传 true。
    this.open({ userInitiated: opts.userInitiated === true });
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.readyWaiters.findIndex((w) => w.timeout === timeout);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        reject(new Error(`right-sidebar window ready timeout after ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      this.readyWaiters.push({ resolve, reject, timeout });
    });
  }

  /** 主窗上报渲染上下文:缓存 + 窗口开着就转发。 */
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
    if (this.winRef && !this.winRef.isDestroyed() && !this.closing) {
      this.deps.sendToWindow(this.winRef, this.deps.contextChannel, ctx);
    }
    this.flushDeferredCommandsToDetachedHost();
  }

  getContext(): RsbWindowContext | null {
    return this.lastContext;
  }

  private canDispatchCommand(cmd: RsbWindowCommand): boolean {
    return Boolean(
      this.lastContext?.available &&
        this.lastContext.sessionId &&
        this.lastContext.sessionId === commandHostSessionId(cmd),
    );
  }

  /** main 原子裁决 command ownership；renderer 只在 attached 结果下写本地 store。 */
  async routeCommand(
    request: RsbWindowCommandRouteRequest,
  ): Promise<RsbWindowCommandRouteResult> {
    const { command, allowOpen } = request;
    // 缺省 true:既有调用点绝大多数是用户手势(点链接 / 菜单 / 快捷键),行为不变。
    // 插件 preview 槽与 agent 自动化显式传 false,只送内容不抢焦点。
    const userInitiated = request.userInitiated !== false;
    if (!this.deps.settings.read().detached) return 'attached';
    if (!this.canDispatchCommand(command)) return 'stale-context';

    if (!allowOpen && (this.closing || !this.isOpen() || !this.ready)) {
      this.enqueueDeferredCommand(command);
      return 'queued';
    }

    if (this.closing) {
      // 终端快捷键由 renderer 做短时、可取消的专属重试。closing 阶段立即返回，
      // 避免旧调用等待 close 后再开窗并悬挂在 8s ready timeout，也避免晚到后重复派发。
      if (allowOpen && command.type === 'open-terminal') return 'stale-context';
      await this.waitUntilClosed();
      return this.routeCommand(request);
    }

    if (allowOpen && (!this.isOpen() || !this.ready)) {
      try {
        await this.ensureOpenForAutomation({ userInitiated });
      } catch (err) {
        if (!this.deps.settings.read().detached) return 'attached';
        if (!this.canDispatchCommand(command)) return 'stale-context';
        throw err;
      }
    }

    // ready 等待期间 detach 偏好或主窗 session 都可能变化，发送前必须二次裁决。
    if (!this.deps.settings.read().detached) return 'attached';
    if (!this.canDispatchCommand(command)) return 'stale-context';
    if (this.closing) {
      if (!allowOpen) {
        this.enqueueDeferredCommand(command);
        return 'queued';
      }
      await this.waitUntilClosed();
      return this.routeCommand(request);
    }
    if (!this.isOpen() || !this.ready || !this.winRef) {
      if (!allowOpen) {
        this.enqueueDeferredCommand(command);
        return 'queued';
      }
      return 'stale-context';
    }

    this.deps.sendToWindow(this.winRef, this.deps.commandChannel, command);
    return 'routed';
  }

  private enqueueDeferredCommand(command: RsbWindowCommand): void {
    // 按宿主桶排队:跨会话 open-turn-review 属于 lead 的桶,须由 lead 上下文
    // flush;按 worker sessionId 入队会在 context 保持 lead 时永远刷不出来。
    const hostSessionId = commandHostSessionId(command);
    const previous = this.deferredCommands.get(hostSessionId);
    if (
      command.type === 'ensure-orca-workers-tab' &&
      previous?.type === 'ensure-orca-workers-tab' &&
      command.focusWorkerSessionId === undefined &&
      command.searchJump === undefined
    ) {
      return;
    }
    if (
      !this.deferredCommands.has(hostSessionId) &&
      this.deferredCommands.size >= MAX_DEFERRED_SESSIONS
    ) {
      const oldest = this.deferredCommands.keys().next().value as string | undefined;
      if (oldest) this.deferredCommands.delete(oldest);
    }
    this.deferredCommands.set(hostSessionId, command);
  }

  private flushDeferredCommandsToDetachedHost(): void {
    if (
      !this.deps.settings.read().detached ||
      this.closing ||
      !this.ready ||
      !this.winRef ||
      this.winRef.isDestroyed()
    ) {
      return;
    }
    const sessionId = this.lastContext?.available ? this.lastContext.sessionId : null;
    if (!sessionId) return;
    const command = this.deferredCommands.get(sessionId);
    if (!command) return;
    this.deferredCommands.delete(sessionId);
    this.deps.sendToWindow(this.winRef, this.deps.commandChannel, command);
  }

  private flushDeferredCommandsToAttachedHost(): void {
    if (this.deps.settings.read().detached) return;
    const sessionId = this.lastContext?.available ? this.lastContext.sessionId : null;
    if (!sessionId) return;
    const command = this.deferredCommands.get(sessionId);
    if (!command) return;
    const main = this.deps.getMainWindow();
    if (!main || main.isDestroyed()) return;
    this.deferredCommands.delete(sessionId);
    this.deps.sendToWindow(main, this.deps.commandChannel, command);
  }

  private waitUntilClosed(): Promise<void> {
    if (!this.closing) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  /**
   * RSB host webContents —— rsb-browser-bridge 的 pin/unpin 通知与 tab-op dispatch
   * 目标窗口。detached 且子窗口活着 → 子窗口;否则回落主窗(内嵌形态)。
   */
  getHostWebContents(): WebContents | null {
    if (
      this.deps.settings.read().detached &&
      !this.closing &&
      this.winRef &&
      !this.winRef.isDestroyed()
    ) {
      return this.winRef.webContents;
    }
    const main = this.deps.getMainWindow();
    return main && !main.isDestroyed() ? main.webContents : null;
  }

  /** IPC 层校验 READY 握手 sender 用。 */
  getSidebarWebContents(): WebContents | null {
    return !this.closing && this.winRef && !this.winRef.isDestroyed()
      ? this.winRef.webContents
      : null;
  }

  private isOpen(): boolean {
    return this.winRef !== null && !this.closing && !this.winRef.isDestroyed();
  }

  private onClosed(): void {
    this.winRef = null;
    this.ready = false;
    this.closing = false;
    const closeWaiters = this.closeWaiters.splice(0);
    closeWaiters.forEach((resolve) => resolve());
    // 悬着的 ready 等待全部失败(窗口没等到挂载就没了)
    const waiters = this.readyWaiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timeout);
      w.reject(new Error('right-sidebar window closed before ready'));
    }
    // app 退出路径:保留 lastOpen=true 供下次启动恢复,也不必广播(所有窗口都在销毁)
    if (this.deps.isQuitting()) return;
    this.deps.settings.writePatch({ lastOpen: false });
    this.broadcast();
    this.deps.log.info('right-sidebar window closed');
  }

  private broadcast(): void {
    const s = this.deps.settings.read();
    this.deps.broadcastState({ detached: s.detached, open: this.isOpen() });
  }
}
