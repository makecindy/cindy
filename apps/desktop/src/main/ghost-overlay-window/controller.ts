/**
 * GhostOverlayWindowsController —— 插件桌面浮窗(ghost overlay window)的生命周期
 * 状态机(main 侧单例,依赖注入可测)。
 *
 * 每 ghostId 一扇透明置顶浮窗,没有窗口级持久状态(位置不持久化,重启即重置)。
 * 生命周期基线对齐 ghost-panel-window/controller.ts:
 *   - 惰性预热:prewarm/show 时按需创建隐藏窗口并加载 renderer
 *   - 双阶段就绪握手(renderer-ready → presentation-ready),5s 超时展示壳
 *   - 隐藏复用:普通隐藏只 hide,不销毁;下次 show 复用同一 Renderer
 *   - 不抢焦点:展示一律走 showInactive(),浮窗永不 focus
 *   - 崩溃恢复有界(每 ghostId 独立计数,稳定 30s 后恢复额度)
 *   - 多 ghostId 实例间状态隔离
 *   - reconcile:插件卸载/停用/失去 overlay 声明时 dispose 对应浮窗
 *   - owner 切换收口:disposeAllForOwnerChange() 销毁全部浮窗
 */

import type { BrowserWindow, WebContents } from 'electron';

import type {
  GhostOverlayWindowEntryState,
  GhostOverlayWindowsState,
} from '../../shared/ghostOverlayWindow.js';
import { GHOST_OVERLAY_WINDOW_VISIBILITY_CHANGED_CHANNEL } from '../../shared/ghostOverlayWindow.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { Logger } from '../logger.js';
import { clearGhostOverlayWebContents } from './registry.js';
import type { GhostOverlayWindowHandle } from './window.js';

export interface GhostOverlayWindowsControllerDeps {
  createWindow: (
    ghostId: string,
    onWindowCreated?: (win: BrowserWindow) => void,
  ) => Promise<GhostOverlayWindowHandle>;
  isGhostOverlayDeclared: (ghostId: string) => boolean;
  isUserEnabled: (ghostId: string) => boolean;
  /**
   * 可选:解析插件当前安装身份(版本 + 安装 revision 等稳定安装事实;同一版本号
   * 但内容变化的本地重装会生成新的 revision)。slot 记录创建时身份;reconcile
   * 发现身份变化时 dispose 旧浮窗,下次 mount 重建。缺省返回 null 表示无身份
   * 信息,不做身份比对。
   */
  resolveInstalledVersion?: (ghostId: string) => string | null;
  broadcastState: (state: GhostOverlayWindowsState) => void;
  isQuitting: () => boolean;
  log: Logger;
  /**
   * 可选:浮窗可见性变化钩子(show/hide/unmount/dispose 等真实迁移时调用)。
   * Task 7 接线为 cursorStream.setVisible;controller 不直接依赖 cursor-stream。
   */
  onVisibilityChanged?: (ghostId: string, visible: boolean) => void;
  /**
   * 可选:全部浮窗被回收时同步调用(disposeAllForOwnerChange/dispose)。
   * Task 7 接线为 cursorStream.dispose();owner 切换后订阅表需一并清空重建。
   */
  onAllWindowsDestroyed?: () => void;
}

const DEFAULT_SHOW_TIMEOUT_MS = 5000;
const DEFAULT_RECOVERY_STABILITY_MS = 30_000;
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 1;

interface WindowSlot {
  win: BrowserWindow;
  /** 创建时捕获,销毁后仍可用于清理 registry 绑定。 */
  webContentsId: number;
  /** 创建时捕获的安装身份;reconcile 发现身份变化时据此 dispose 旧浮窗。 */
  installedVersion: string | null;
  /** 首次加载仍在进行(窗口尚无壳);抑制 5s 壳超时对它的误销毁。 */
  loading: boolean;
  rendererReady: boolean;
  presentationReady: boolean;
  visible: boolean;
  interactive: boolean;
  pendingShow: boolean;
  destroyingWindow: boolean;
  showTimeout: NodeJS.Timeout | null;
  recoveryStabilityTimeout: NodeJS.Timeout | null;
  automaticRecoveryAttempts: number;
}

export class GhostOverlayWindowsController {
  private readonly slots = new Map<string, WindowSlot>();
  /** 在途创建去重:同一 ghostId 只允许一个 createWindow 在飞。 */
  private readonly pendingCreates = new Map<string, Promise<WindowSlot | null>>();
  private disposed = false;
  /** 销毁代次:disposeAllForOwnerChange/dispose 后作废在途创建。 */
  private generation = 0;

  constructor(private readonly deps: GhostOverlayWindowsControllerDeps) {}

  // ══════════════════════════════════════════════════════════════════════
  // 公共接口
  // ══════════════════════════════════════════════════════════════════════

  getState(): GhostOverlayWindowsState {
    const out: GhostOverlayWindowsState = {};
    for (const [id, slot] of this.slots) {
      out[id] = this.entryState(slot);
    }
    return out;
  }

  /**
   * 后台预热指定 ghostId:创建隐藏窗口并加载 renderer,不展示、不改变焦点。
   * 幂等;用户禁用时拒绝(fail closed)。
   */
  prewarm(ghostId: string): void {
    if (this.disposed) return;
    if (!this.deps.isGhostOverlayDeclared(ghostId)) return;
    if (!this.deps.isUserEnabled(ghostId)) {
      this.deps.log.warn('ghost overlay prewarm refused (user disabled)', { ghostId });
      return;
    }
    void this.ensureSlot(ghostId);
  }

  /**
   * 幂等展示:双阶段就绪后 showInactive()(不抢焦点);冷窗口等待首份内容,
   * 5s 超时只展示已挂载壳,不展示空白。用户禁用时拒绝(fail closed)。
   */
  async show(ghostId: string): Promise<void> {
    if (this.disposed) return;
    if (!this.deps.isGhostOverlayDeclared(ghostId)) {
      this.deps.log.warn('ghost overlay not declared, pruning slot', { ghostId });
      const stale = this.slots.get(ghostId);
      if (stale && !stale.destroyingWindow) this.disposeSlot(ghostId, stale);
      this.broadcast();
      return;
    }
    if (!this.deps.isUserEnabled(ghostId)) {
      this.deps.log.warn('ghost overlay show refused (user disabled)', { ghostId });
      return;
    }

    const slot = await this.ensureSlot(ghostId);
    if (!slot || slot.win.isDestroyed()) return;

    // 已在展示:保持原样,绝不抢焦点。
    if (slot.visible && slot.win.isVisible() && !slot.win.isMinimized()) {
      return;
    }
    if (slot.presentationReady) {
      this.showInactive(ghostId, slot);
      return;
    }
    slot.pendingShow = true;
    this.scheduleShowFallback(ghostId, slot);
    this.broadcast();
  }

  /** 普通隐藏只 hide(保留 renderer,下次瞬时复用);向浮窗同步可见性。 */
  hide(ghostId: string): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return;
    this.hideWindow(ghostId, slot);
  }

  /** 坐标直通:把浮窗平移到指定屏幕位置。 */
  move(ghostId: string, x: number, y: number): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return;
    slot.win.setPosition(x, y);
  }

  /**
   * 交互态直通:true = 接收鼠标事件;false = 恢复穿透(forward 语义,点击
   * 透传到浮窗下层,窗口自身不抢焦点)。
   */
  setInteractive(ghostId: string, interactive: boolean): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return;
    // 隐藏期不得受理"变交互":setIgnoreMouseEvents(false) 会立即生效,随后 show
    // 会以整矩形捕鼠状态出现,触犯"透明区域绝不挡点击"。复位请求(false)仍可
    // 随时受理,保证再次 show 前窗口始终回到默认穿透。
    if (interactive && !slot.visible) return;
    slot.interactive = interactive;
    if (interactive) {
      slot.win.setIgnoreMouseEvents(false);
    } else {
      slot.win.setIgnoreMouseEvents(true, { forward: true });
    }
    this.broadcast();
  }

  /** 真正销毁指定浮窗并清理 registry。 */
  unmount(ghostId: string): void {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.destroyingWindow) return;
    this.disposeSlot(ghostId, slot);
    this.broadcast();
  }

  /** 插件卸载/停用/失去 overlay 声明/更新后版本变化时 dispose 对应浮窗。 */
  reconcile(ghosts: InstalledGhost[]): void {
    const byId = new Map(ghosts.map((g) => [installedGhostStoragePart(g), g]));
    let changed = false;
    for (const [id, slot] of [...this.slots]) {
      const ghost = byId.get(id);
      const eligible =
        ghost !== undefined &&
        ghost.enabled !== false &&
        ghost.manifest.overlay !== undefined;
      if (eligible) {
        // 更新后仍声明 overlay 的插件:旧窗口逻辑页是旧版本,复用会继续 mount
        // 旧页面/旧尺寸。安装身份(版本 + revision)不一致 → dispose,重建留给下次
        // mount 触发;身份解析与 slot 创建时同源,保证两边字符串可比。
        const identity = this.deps.resolveInstalledVersion?.(id) ?? null;
        if (slot.installedVersion !== null && slot.installedVersion !== identity) {
          if (!slot.destroyingWindow) {
            this.disposeSlot(id, slot);
            changed = true;
            this.deps.log.info('ghost overlay window reconciled away (identity changed)', {
              ghostId: id,
              from: slot.installedVersion,
              to: identity,
            });
          }
        }
        continue;
      }

      if (!slot.destroyingWindow) {
        this.disposeSlot(id, slot);
        changed = true;
        this.deps.log.info('ghost overlay window reconciled away', { ghostId: id });
      }
    }
    if (changed) this.broadcast();
  }

  /** data owner 切换时销毁全部浮窗(浮窗无持久状态,不落盘)。 */
  disposeAllForOwnerChange(): void {
    this.destroyAllWindows();
    this.broadcast();
  }

  // ── 双阶段就绪 ──────────────────────────────────────────────────────

  /** IPC 路径(未来有桥时):按 sender 反查 slot 后标记就绪。 */
  markRendererReady(sender: WebContents): void {
    const entry = this.slotForSender(sender);
    if (!entry) return;
    this.markRendererReadyForSlot(entry.slot);
  }

  markPresentationReady(sender: WebContents): void {
    const entry = this.slotForSender(sender);
    if (!entry) return;
    this.markPresentationReadyForSlot(entry.ghostId, entry.slot);
  }

  /**
   * 宿主事件路径(零桥浮窗无 preload,就绪由 webContents 事件驱动):
   * dom-ready → renderer-ready;did-finish-load 后再延一帧 → presentation-ready
   * (语义为“壳已挂载 + 首份内容已提交”)。
   */
  private markRendererReadyForSlot(slot: WindowSlot): void {
    slot.rendererReady = true;
  }

  private markPresentationReadyForSlot(ghostId: string, slot: WindowSlot): void {
    slot.presentationReady = true;
    this.scheduleRecoveryStabilityReset(slot);
    if (slot.pendingShow) {
      this.showInactive(ghostId, slot);
    }
  }

  /** 查找 sender 对应的 ghostId+slot;非本 controller 管理的窗口返回 null。 */
  slotForSender(sender: WebContents): { ghostId: string; slot: WindowSlot } | null {
    for (const [id, slot] of this.slots) {
      if (slot.win && !slot.win.isDestroyed() && slot.win.webContents === sender) {
        return { ghostId: id, slot };
      }
    }
    return null;
  }

  /** 应用退出/销毁:永久停止并同步销毁所有缓存浮窗。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyAllWindows();
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部:窗口创建与生命周期
  // ══════════════════════════════════════════════════════════════════════

  private ensureSlot(ghostId: string): Promise<WindowSlot | null> {
    // 在途创建去重必须先于 existing 快速返回:onWindowCreated 在 loadURL 前就把
    // "加载中"slot 提前塞进 this.slots,此时 existing 分支会误返回未就绪窗口,让
    // show() 在首帧加载完成前启动 5s 壳超时,慢加载(>5s 且 <10s)下误销毁。先命中
    // 在途 promise,调用方拿到的是创建结果(成功或失败),而非半成品 slot。
    const inflight = this.pendingCreates.get(ghostId);
    if (inflight) return inflight;

    const existing = this.slots.get(ghostId);
    if (existing && !existing.win.isDestroyed()) return Promise.resolve(existing);

    const generation = this.generation;
    const promise = this.createSlot(ghostId, generation);
    this.pendingCreates.set(ghostId, promise);
    const cleanup = () => {
      if (this.pendingCreates.get(ghostId) === promise) this.pendingCreates.delete(ghostId);
    };
    // fulfillment 与 rejection 都要清理映射:若只在 fulfilled 分支清理,一旦
    // createSlot 意外 reject,该 ghostId 会永久命中已拒绝的 inflight promise。
    // then(cleanup, cleanup) 不改变 promise 的透传语义,也不会新增未处理拒绝。
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private async createSlot(ghostId: string, generation: number): Promise<WindowSlot | null> {
    // 工厂在 loadURL 之前通过 onWindowCreated 回调登记"加载中"slot:窗口在 load
    // 期间即可被回收(5s 壳超时/崩溃恢复/owner 切换),首次加载另有工厂侧超时兜底。
    let earlySlot: WindowSlot | null = null;
    const registerEarly = (win: BrowserWindow): void => {
      // 回调发生在 await 期间:退场/换代/资格失效时 fail closed,不挂载僵尸窗口。
      if (
        this.disposed ||
        this.deps.isQuitting() ||
        generation !== this.generation ||
        !this.deps.isGhostOverlayDeclared(ghostId) ||
        !this.deps.isUserEnabled(ghostId)
      ) {
        this.disposeAbandonedWindow(win);
        return;
      }
      const existing = this.slots.get(ghostId);
      if (existing && !existing.win.isDestroyed()) {
        this.disposeAbandonedWindow(win);
        return;
      }
      earlySlot = this.buildAndRegisterSlot(ghostId, win);
    };

    let created: GhostOverlayWindowHandle;
    try {
      created = await this.deps.createWindow(ghostId, registerEarly);
    } catch (error) {
      // 失败路径事务清理:早期已登记的"加载中"slot 一并回收;未登记说明窗口
      // 已在回调里被 dispose 或从未创建,无需处理。
      if (earlySlot && this.slots.get(ghostId) === earlySlot) {
        this.disposeSlot(ghostId, earlySlot);
        this.broadcast();
      }
      this.deps.log.warn('ghost overlay window creation failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const win = created.win;

    // 创建期间退出/销毁换代/资格失效:fail closed,不挂载僵尸窗口。
    if (
      this.disposed ||
      this.deps.isQuitting() ||
      generation !== this.generation ||
      !this.deps.isGhostOverlayDeclared(ghostId) ||
      !this.deps.isUserEnabled(ghostId)
    ) {
      if (earlySlot && this.slots.get(ghostId) === earlySlot) {
        this.disposeSlot(ghostId, earlySlot);
        this.broadcast();
      } else {
        this.disposeAbandonedWindow(win);
      }
      return null;
    }

    const existing = this.slots.get(ghostId);
    if (existing && !existing.win.isDestroyed() && existing !== earlySlot) {
      this.disposeAbandonedWindow(win);
      return existing;
    }

    const slot = earlySlot ?? this.buildAndRegisterSlot(ghostId, win);
    // 走到这里说明工厂 createWindow 已返回:首次加载阶段(loadURL/超时)结束,
    // 窗口不再处于"尚无壳"的挂起加载态。
    slot.loading = false;
    // 工厂 createWindow 在返回前已 await loadURL(带超时):首次加载的 dom-ready/
    // did-finish-load 事件早已发生。onWindowCreated 回调在 loadURL 之前把"加载中"
    // slot 交给这里并挂好监听器,宿主事件路径通常已驱动就绪;loadCompleted 仅作
    // 兜底(防御未来工厂在挂监听器前完成加载的变体),确定性直推双阶段就绪。后续
    // reload 仍由监听器重新驱动。
    if (created.loadCompleted === true && !slot.win.isDestroyed()) {
      this.onDomReady(ghostId, slot);
      this.onDidFinishLoad(ghostId, slot);
    }
    return slot;
  }

  private buildAndRegisterSlot(ghostId: string, win: BrowserWindow): WindowSlot {
    const slot: WindowSlot = {
      win,
      webContentsId: win.webContents.id,
      installedVersion: this.deps.resolveInstalledVersion?.(ghostId) ?? null,
      loading: true,
      rendererReady: false,
      presentationReady: false,
      visible: false,
      interactive: false,
      pendingShow: false,
      destroyingWindow: false,
      showTimeout: null,
      recoveryStabilityTimeout: null,
      automaticRecoveryAttempts: 0,
    };
    this.slots.set(ghostId, slot);
    this.attachWindowListeners(ghostId, slot);
    return slot;
  }

  private attachWindowListeners(ghostId: string, slot: WindowSlot): void {
    const { win } = slot;
    win.on('show', () => this.onNativeVisibilityChanged(ghostId, slot, true));
    win.on('hide', () => this.onNativeVisibilityChanged(ghostId, slot, false));
    win.on('closed', () => this.onClosed(ghostId, slot));
    // 零桥浮窗没有 preload 发就绪 IPC:就绪握手由宿主 webContents 事件驱动。
    win.webContents.on('dom-ready', () => this.onDomReady(ghostId, slot));
    win.webContents.on('did-finish-load', () => this.onDidFinishLoad(ghostId, slot));
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.onRendererReloadStarted(ghostId, slot);
    });
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          this.invalidateSlot(ghostId, slot, `load failed (${errorCode}): ${errorDescription}`);
        }
      },
    );
    win.webContents.on('render-process-gone', (_event, details) => {
      this.invalidateSlot(ghostId, slot, `renderer process gone: ${details.reason}`);
    });
  }

  /** dom-ready:壳(root 组件)已挂载,可安全接收展示指令。 */
  private onDomReady(ghostId: string, slot: WindowSlot): void {
    if (this.slots.get(ghostId) !== slot || slot.win.isDestroyed()) return;
    this.markRendererReadyForSlot(slot);
  }

  /** did-finish-load:首份内容已提交;延一帧再落 presentation-ready,与 IPC 语义对齐。 */
  private onDidFinishLoad(ghostId: string, slot: WindowSlot): void {
    if (this.slots.get(ghostId) !== slot || slot.win.isDestroyed()) return;
    setImmediate(() => {
      if (this.slots.get(ghostId) !== slot || slot.win.isDestroyed() || this.disposed) return;
      this.markPresentationReadyForSlot(ghostId, slot);
    });
  }

  private showInactive(ghostId: string, slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    slot.pendingShow = false;
    // kill switch 复查:用户禁用后任何路径(双阶段就绪/5s 壳/reload 恢复)都不得
    // 把窗口显示出来——show()/createSlot 的入口检查与这里之间是异步窗口,
    // pendingShow 兜底统一在这里收口(fail closed)。
    if (!this.deps.isUserEnabled(ghostId)) {
      this.deps.log.warn('ghost overlay show suppressed (user disabled)', { ghostId });
      return;
    }
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.showInactive();
    this.applyVisibility(ghostId, slot, true);
    this.sendVisibility(slot, true);
    this.broadcast();
  }

  /**
   * 隐藏时复位鼠标穿透:交互态只在浮窗可见期间成立。再次显示时由插件页面重新
   * 判定命中前,窗口必须回到默认穿透(forward 语义),否则会继续拦截下层点击。
   */
  private resetInteractiveOnHide(slot: WindowSlot): void {
    if (slot.interactive !== true || slot.win.isDestroyed()) return;
    slot.interactive = false;
    slot.win.setIgnoreMouseEvents(true, { forward: true });
  }

  private hideWindow(ghostId: string, slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    slot.pendingShow = false;
    this.resetInteractiveOnHide(slot);
    if (slot.win.isVisible()) slot.win.hide();
    this.applyVisibility(ghostId, slot, false);
    this.sendVisibility(slot, false);
    this.broadcast();
    this.deps.log.info('ghost overlay window hidden', { ghostId });
  }

  private sendVisibility(slot: WindowSlot, visible: boolean): void {
    try {
      slot.win.webContents.send(GHOST_OVERLAY_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible });
    } catch {
      // window may be torn down
    }
  }

  /** 通知宿主(如 cursor stream)可见性变化;钩子可选,缺席时静默。 */
  private notifyVisibilityChanged(ghostId: string, visible: boolean): void {
    this.deps.onVisibilityChanged?.(ghostId, visible);
  }

  /**
   * 统一可见性迁移:仅真实变化时更新状态并通知宿主一次。
   * 这样无论原生 show/hide 事件是同步还是异步到达,都只发一次钩子。
   */
  private applyVisibility(ghostId: string, slot: WindowSlot, visible: boolean): void {
    if (slot.visible === visible) return;
    slot.visible = visible;
    this.notifyVisibilityChanged(ghostId, visible);
  }

  private onNativeVisibilityChanged(
    ghostId: string,
    slot: WindowSlot,
    visible: boolean,
  ): void {
    if (
      this.slots.get(ghostId) !== slot ||
      slot.win.isDestroyed() ||
      slot.destroyingWindow ||
      this.disposed
    ) {
      return;
    }
    if (slot.visible === visible && !slot.pendingShow) return;
    this.applyVisibility(ghostId, slot, visible);
    if (visible) slot.pendingShow = false;
    else this.resetInteractiveOnHide(slot);
    this.sendVisibility(slot, visible);
    this.broadcast();
  }

  private onClosed(ghostId: string, slot: WindowSlot): void {
    this.clearTimeouts(slot);
    clearGhostOverlayWebContents(slot.webContentsId);
    const current = this.slots.get(ghostId);
    // 兜底停推:仅当该窗口仍是当前 slot(如外部关闭),或该 ghostId 已无任何 slot。
    // 旧 slot 销毁后新 slot 已重建可见时,迟到的 closed 不得误停新 slot 的光标流。
    if (current === slot || current === undefined) {
      this.notifyVisibilityChanged(ghostId, false);
    }
    if (current !== slot) return;
    this.slots.delete(ghostId);
    if (slot.destroyingWindow) return;
    if (this.deps.isQuitting()) return;
    this.broadcast();
    this.deps.log.info('ghost overlay window closed (destroyed)', { ghostId });
  }

  // ── 超时 ────────────────────────────────────────────────────────────

  private scheduleShowFallback(ghostId: string, slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    slot.showTimeout = setTimeout(() => {
      slot.showTimeout = null;
      if (slot.win.isDestroyed() || !slot.pendingShow) return;
      // 仍在首次加载(窗口尚无壳):不得作废——挂起加载没有"已挂载壳"可展示,
      // 首次加载由工厂侧 10s 超时/失败路径负责清理与错误表面化。
      if (slot.loading) return;
      // 壳(rendererReady)未就绪时展示可能是空白窗口:作废缓存并走有界恢复,
      // 恢复额度耗尽才放弃;壳已就绪则展示已挂载的 Loading 壳。
      if (!slot.rendererReady) {
        this.invalidateSlot(ghostId, slot, 'renderer readiness timed out');
        return;
      }
      if (!slot.visible) this.showInactive(ghostId, slot);
    }, DEFAULT_SHOW_TIMEOUT_MS);
    slot.showTimeout.unref?.();
  }

  private clearShowTimeout(slot: WindowSlot): void {
    if (!slot.showTimeout) return;
    clearTimeout(slot.showTimeout);
    slot.showTimeout = null;
  }

  private scheduleRecoveryStabilityReset(slot: WindowSlot): void {
    if (slot.automaticRecoveryAttempts === 0) return;
    if (slot.recoveryStabilityTimeout) {
      clearTimeout(slot.recoveryStabilityTimeout);
    }
    slot.recoveryStabilityTimeout = setTimeout(() => {
      slot.recoveryStabilityTimeout = null;
      if (slot.win.isDestroyed() || !slot.presentationReady) return;
      slot.automaticRecoveryAttempts = 0;
    }, DEFAULT_RECOVERY_STABILITY_MS);
    slot.recoveryStabilityTimeout.unref?.();
  }

  // ── 崩溃恢复 ────────────────────────────────────────────────────────

  private onRendererReloadStarted(ghostId: string, slot: WindowSlot): void {
    if (slot.win.isDestroyed()) return;
    const shouldRestore = slot.visible || slot.pendingShow;
    if (shouldRestore) slot.pendingShow = true;
    if (slot.visible) {
      slot.win.hide();
      this.applyVisibility(ghostId, slot, false);
      this.resetInteractiveOnHide(slot);
    }
    slot.rendererReady = false;
    slot.presentationReady = false;
    if (shouldRestore) this.scheduleShowFallback(ghostId, slot);
  }

  private invalidateSlot(ghostId: string, slot: WindowSlot, reason: string): void {
    if (slot.win.isDestroyed()) return;
    const reopen = slot.pendingShow || slot.visible;
    const attempts = slot.automaticRecoveryAttempts;
    this.deps.log.warn('ghost overlay cached window invalidated', { ghostId, reason, reopen });
    this.disposeSlot(ghostId, slot);
    if (!reopen || this.disposed || this.deps.isQuitting()) return;
    if (attempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      this.deps.log.error('ghost overlay automatic recovery exhausted', { ghostId, reason });
      return;
    }
    // 重建并重新 show:恢复额度在 presentationReady 时进入稳定窗口后重置。
    void this.ensureSlot(ghostId).then((replacement) => {
      if (!replacement) {
        this.deps.log.error('ghost overlay automatic recovery failed to recreate', {
          ghostId,
          reason,
        });
        return;
      }
      replacement.automaticRecoveryAttempts = attempts + 1;
      replacement.pendingShow = true;
      this.scheduleShowFallback(ghostId, replacement);
      this.broadcast();
    });
  }

  // ── 销毁 ────────────────────────────────────────────────────────────

  /** 销毁一个「已创建但尚未挂载」的窗口并清理其 registry 绑定。 */
  private disposeAbandonedWindow(win: BrowserWindow): void {
    let webContentsId: number | null = null;
    try {
      webContentsId = win.webContents.id;
    } catch {
      // webContents 已不可访问,无可清理。
    }
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      // already gone
    }
    if (webContentsId !== null) clearGhostOverlayWebContents(webContentsId);
  }

  private disposeSlot(ghostId: string, slot: WindowSlot): void {
    this.clearTimeouts(slot);
    // 同步停推:unmount/reconcile/invalidate 不依赖 win.destroy() 的异步 closed 事件。
    this.notifyVisibilityChanged(ghostId, false);
    this.slots.delete(ghostId);
    slot.destroyingWindow = true;
    clearGhostOverlayWebContents(slot.webContentsId);
    try {
      if (!slot.win.isDestroyed()) slot.win.destroy();
    } catch {
      // already gone
    }
  }

  /** 主窗口销毁/owner 切换时回收所有隐藏窗口;controller 仍可继续预热。 */
  destroyAllWindows(): void {
    this.generation += 1;
    this.pendingCreates.clear();
    const entries = [...this.slots];
    this.slots.clear();
    for (const [ghostId, slot] of entries) {
      this.clearTimeouts(slot);
      // 同步停推:全量回收不依赖各窗口的异步 closed 事件。
      this.notifyVisibilityChanged(ghostId, false);
      slot.destroyingWindow = true;
      clearGhostOverlayWebContents(slot.webContentsId);
      try {
        if (!slot.win.isDestroyed()) slot.win.destroy();
      } catch {
        // already gone
      }
    }
    // 全部回收后通知宿主 dispose 光标流(owner 切换/退出时订阅表一并清空)。
    this.deps.onAllWindowsDestroyed?.();
  }

  private clearTimeouts(slot: WindowSlot): void {
    this.clearShowTimeout(slot);
    if (slot.recoveryStabilityTimeout) {
      clearTimeout(slot.recoveryStabilityTimeout);
      slot.recoveryStabilityTimeout = null;
    }
  }

  // ── 查询 ────────────────────────────────────────────────────────────

  private entryState(slot: WindowSlot): GhostOverlayWindowEntryState {
    return {
      mounted: !slot.win.isDestroyed(),
      visible: slot.visible && !slot.win.isDestroyed(),
      interactive: slot.interactive,
    };
  }

  private broadcast(): void {
    this.deps.broadcastState(this.getState());
  }
}
