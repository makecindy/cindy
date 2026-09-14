/**
 * GhostPanelWindowsController —— 插件停靠面板独立窗口的状态机(main 侧单例,
 * 依赖注入可测)。
 *
 * 每 ghostId 三态(与 RSB 同构):
 *   A. detached=false            —— 面板停靠在主窗布局树里
 *   C. detached=true, 窗口打开   —— 面板活在独立窗口(隐藏复用,紧接开/关只隐藏)
 *
 * 生命周期基线对齐 PR #2434 ResourceUsageWindowController 与右侧栏窗口改造:
 *   - 惰性预热：首次 open/setDetached(true) 创建隐藏窗口，presentation-ready 后展示
 *   - 本次运行期按需创建：首次分离后隐藏复用，客户端重启后回到主窗口
 *   - 双阶段就绪握手（renderer-ready → presentation-ready），5s 超时展示壳
 *   - 隐藏复用：普通关窗只 hide(setDetached(false) 才真正 destroy)
 *   - 崩溃恢复有界（每 ghostId 独立计数）
 *   - 多 ghostId 实例间状态隔离
 *   - reconcile:插件卸载/停用/换形态时 dispose 对应窗口
 */

import type { BrowserWindow, WebContents } from 'electron';

import type {
  GhostPanelWindowEntryState,
  GhostPanelWindowsState,
} from '../../shared/ghostPanelWindow.js';
import {
  GHOST_PANEL_WINDOW_CLOSE_REQUESTED_CHANNEL,
  GHOST_PANEL_WINDOW_LOCALE_CHANGED_CHANNEL,
  GHOST_PANEL_WINDOW_MINIMIZE_REQUESTED_CHANNEL,
  GHOST_PANEL_WINDOW_PRESENTATION_READY_CHANNEL,
  GHOST_PANEL_WINDOW_RENDERER_READY_CHANNEL,
  GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../../shared/ghostPanelWindow.js';
import type { SupportedLocale } from '../../shared/locale.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import type { GhostPanelWindowsSettings } from './settings-store.js';

interface ControllerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface GhostPanelWindowsControllerDeps {
  settings: {
    read(): GhostPanelWindowsSettings;
    patchEntry(ghostId: string, patch: Partial<{ detached: boolean; lastOpen: boolean }>): void;
    removeEntry(ghostId: string): void;
  };
  createWindow: (ghostId: string) => BrowserWindow;
  isGhostDetachable: (ghostId: string) => boolean;
  broadcastState: (state: GhostPanelWindowsState) => void;
  /** main → renderer push(仅子窗口)。 */
  sendToWindow: (win: BrowserWindow, channel: string, payload: unknown) => void;
  isQuitting: () => boolean;
  log: ControllerLogger;
}

const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_RECOVERY_STABILITY_MS = 30_000;
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 1;

interface WindowSlot {
  win: BrowserWindow;
  rendererReady: boolean;
  presentationReady: boolean;
  visible: boolean;
  pendingOpen: boolean;
  destroyingWindow: boolean;
  openTimeout: NodeJS.Timeout | null;
  recoveryStabilityTimeout: NodeJS.Timeout | null;
  automaticRecoveryAttempts: number;
}

export class GhostPanelWindowsController {
  private readonly slots = new Map<string, WindowSlot>();
  private disposed = false;
  private locale: SupportedLocale | null = null;

  constructor(private readonly deps: GhostPanelWindowsControllerDeps) {}

  // ══════════════════════════════════════════════════════════════════════
  // 公共接口
  // ══════════════════════════════════════════════════════════════════════

  getState(): GhostPanelWindowsState {
    const out: GhostPanelWindowsState = {};
    const { windows } = this.deps.settings.read();
    for (const [id, entry] of Object.entries(windows)) {
      out[id] = this.entryState(id, entry);
    }
    for (const id of this.slots.keys()) {
      if (!(id in out)) out[id] = this.entryState(id, { detached: false, lastOpen: false });
    }
    return out;
  }

  /**
   * 后台预热指定 ghostId：创建隐藏窗口并加载 renderer，不改变用户焦点。
   * 可在当前运行期提前为即将打开的插件面板准备 renderer。
   */
  prewarm(ghostId: string): void {
    if (this.disposed) return;
    if (!this.deps.isGhostDetachable(ghostId)) return;
    this.ensureSlot(ghostId);
  }

  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    for (const slot of this.slots.values()) {
      if (slot.win.isDestroyed()) continue;
      try {
        slot.win.webContents.send(GHOST_PANEL_WINDOW_LOCALE_CHANGED_CHANNEL, locale);
      } catch {
        // Window may be tearing down.
      }
    }
  }

  /**
   * 幂等打开:热窗口(presentationReady)立即显示;冷窗口等待首份内容。
   * 资格不符则清条目防陈年状态复活。
   */
  open(ghostId: string): void {
    if (this.disposed) return;
    if (!this.deps.isGhostDetachable(ghostId)) {
      this.deps.log.warn('ghost not detachable, pruning entry', { ghostId });
      const staleSlot = this.slots.get(ghostId);
      if (staleSlot && !staleSlot.destroyingWindow) this.disposeSlot(ghostId, staleSlot);
      this.deps.settings.removeEntry(ghostId);
      this.broadcast();
      return;
    }

    const existing = this.slots.get(ghostId);
    if (existing) {
      if (
        existing.visible &&
        existing.win.isVisible() &&
        !existing.win.isMinimized()
      ) {
        existing.win.focus();
        return;
      }
      if (existing.presentationReady) {
        this.showAndFocus(ghostId, existing);
        return;
      }
      existing.pendingOpen = true;
      this.scheduleOpenFallback(ghostId, existing);
      this.deps.settings.patchEntry(ghostId, { detached: true, lastOpen: true });
      this.broadcast();
      return;
    }

    const slot = this.ensureSlot(ghostId);
    if (!slot) return;
    slot.pendingOpen = true;
    if (slot.presentationReady) {
      this.showAndFocus(ghostId, slot);
    } else {
      this.scheduleOpenFallback(ghostId, slot);
    }
    this.deps.settings.patchEntry(ghostId, { detached: true, lastOpen: true });
    this.broadcast();
  }

  /** 普通关窗只隐藏(保留 renderer,供下次瞬时恢复)。偏好保持 detached:true。 */
  close(ghostId: string): void {
    const slot = this.slots.get(ghostId);
    if (!slot) {
      // 窗口不存在,但仍需落盘 lastOpen=false
      this.deps.settings.patchEntry(ghostId, { lastOpen: false });
      this.broadcast();
      return;
    }
    this.hideWindow(ghostId, slot);
  }

  /** 写偏好;true 开窗,false 真正销毁窗口(= 回停靠)。 */
  setDetached(ghostId: string, next: boolean): GhostPanelWindowsState {
    if (next) {
      this.open(ghostId);
    } else {
      this.deps.settings.patchEntry(ghostId, { detached: false, lastOpen: false });
      const slot = this.slots.get(ghostId);
      if (slot && !slot.destroyingWindow) {
        this.disposeSlot(ghostId, slot);
      }
      this.broadcast();
    }
    return this.getState();
  }

  // ── 双阶段就绪 ──────────────────────────────────────────────────────

  markRendererReady(sender: WebContents): void {
    const entry = this.slotForSender(sender);
    if (!entry) return;
    entry.slot.rendererReady = true;
    if (this.locale) {
      try {
        sender.send(GHOST_PANEL_WINDOW_LOCALE_CHANGED_CHANNEL, this.locale);
      } catch {
        // Renderer may be tearing down.
      }
    }
  }

  markPresentationReady(sender: WebContents): void {
    const entry = this.slotForSender(sender);
    if (!entry) return;
    entry.slot.presentationReady = true;
    this.scheduleRecoveryStabilityReset(entry.slot);
    if (entry.slot.pendingOpen) {
      this.showAndFocus(entry.ghostId, entry.slot);
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

  getSidebarWebContents(ghostId: string): WebContents | null {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return null;
    return slot.win.webContents;
  }

  requestClose(sender: WebContents): void {
    const entry = this.slotForSender(sender);
    if (!entry) return;
    this.deps.sendToWindow(entry.slot.win, GHOST_PANEL_WINDOW_CLOSE_REQUESTED_CHANNEL, undefined);
  }

  resolveCloseRequest(sender: WebContents, approved: boolean): void {
    const entry = this.slotForSender(sender);
    // The renderer owns the confirmation and performs setEnabled(false) after
    // approval. Keep the window visible until that operation succeeds so an IPC
    // failure does not silently hide an enabled plugin.
    if (!entry || !approved) return;
  }

  // ── reconcile ──────────────────────────────────────────────────────

  reconcile(ghosts: InstalledGhost[]): void {
    const byId = new Map(ghosts.map((g) => [g.manifest.id, g]));
    const knownIds = new Set([
      ...Object.keys(this.deps.settings.read().windows),
      ...this.slots.keys(),
    ]);
    let changed = false;
    for (const id of knownIds) {
      const ghost = byId.get(id);
      const detachable =
        ghost !== undefined &&
        ghost.enabled !== false &&
        ghost.manifest.panel !== undefined &&
        ghost.manifest.panel.position !== 'tab';
      if (detachable) continue;

      const slot = this.slots.get(id);
      if (slot && !slot.destroyingWindow) {
        this.disposeSlot(id, slot);
      }
      if (ghost === undefined) {
        this.deps.settings.removeEntry(id);
      } else {
        this.deps.settings.patchEntry(id, { detached: false, lastOpen: false });
      }
      changed = true;
      this.deps.log.info('ghost panel window reconciled away', { ghostId: id });
    }
    if (changed) this.broadcast();
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /**
   * data owner 真变化时同步销毁旧 owner 的所有独立窗口。
   * 把既有面板收口回 docked/closed，避免新 owner 失去正常 UI 入口。
   */
  closeForOwnerChange(): void {
    const { windows } = this.deps.settings.read();
    this.destroyAllWindows();
    for (const ghostId of Object.keys(windows)) {
      this.deps.settings.patchEntry(ghostId, { detached: false, lastOpen: false });
    }
    this.broadcast();
  }

  /** 主窗口销毁时回收所有隐藏窗口;controller 仍可随下一扇主窗重新预热。 */
  destroyAllWindows(): void {
    for (const [id, slot] of this.slots) {
      this.clearTimeouts(slot);
      if (!slot.win.isDestroyed()) {
        slot.destroyingWindow = true;
        try { slot.win.destroy(); } catch { /* already gone */ }
      }
    }
    this.slots.clear();
  }

  /** 应用退出时永久停止并同步销毁所有缓存窗口。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyAllWindows();
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部:窗口创建与生命周期
  // ══════════════════════════════════════════════════════════════════════

  private ensureSlot(ghostId: string): WindowSlot | null {
    const existing = this.slots.get(ghostId);
    if (existing && !existing.win.isDestroyed()) return existing;

    let win: BrowserWindow;
    try {
      win = this.deps.createWindow(ghostId);
    } catch (error) {
      this.deps.log.warn('ghost panel window creation failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const slot: WindowSlot = {
      win,
      rendererReady: false,
      presentationReady: false,
      visible: false,
      pendingOpen: false,
      destroyingWindow: false,
      openTimeout: null,
      recoveryStabilityTimeout: null,
      automaticRecoveryAttempts: 0,
    };
    this.slots.set(ghostId, slot);

    win.on('close', (event) => {
      if (slot.destroyingWindow || this.disposed) return;
      event.preventDefault();
      this.requestClose(win.webContents);
    });
    win.on('minimize', () => {
      if (slot.destroyingWindow || this.disposed) return;
      // 原生标题栏（macOS 黄灯）与系统级最小化入口也必须复用插件面板最小化语义。
      // 先恢复，避免在 renderer 完成 setDetached(false) 前短暂留在 Dock/任务栏。
      if (win.isMinimized()) win.restore();
      this.deps.sendToWindow(win, GHOST_PANEL_WINDOW_MINIMIZE_REQUESTED_CHANNEL, undefined);
    });
    win.on('show', () => this.onNativeVisibilityChanged(ghostId, slot, true));
    win.on('hide', () => this.onNativeVisibilityChanged(ghostId, slot, false));
    win.on('closed', () => this.onClosed(ghostId, slot));
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

    return slot;
  }

  private showAndFocus(ghostId: string, slot: WindowSlot): void {
    this.clearOpenTimeout(slot);
    slot.pendingOpen = false;
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.show();
    slot.win.focus();
    slot.visible = true;
    this.deps.sendToWindow(slot.win, GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible: true });
    this.broadcast();
  }

  private hideWindow(ghostId: string, slot: WindowSlot): void {
    this.clearOpenTimeout(slot);
    slot.pendingOpen = false;
    if (slot.win.isVisible()) slot.win.hide();
    slot.visible = false;
    try {
      this.deps.sendToWindow(slot.win, GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible: false });
    } catch { /* window may be torn down */ }
    this.deps.settings.patchEntry(ghostId, { lastOpen: false });
    this.broadcast();
    this.deps.log.info('ghost panel window hidden', { ghostId });
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
    if (slot.visible === visible && !slot.pendingOpen) return;
    slot.visible = visible;
    if (visible) slot.pendingOpen = false;
    try {
      this.deps.sendToWindow(slot.win, GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL, { visible });
    } catch {
      // Native visibility can change while the renderer is tearing down.
    }
    this.broadcast();
  }

  private onClosed(ghostId: string, slot: WindowSlot): void {
    this.clearTimeouts(slot);
    if (this.slots.get(ghostId) !== slot) return;
    this.slots.delete(ghostId);
    if (slot.destroyingWindow) return;
    if (this.deps.isQuitting()) return;
    if (ghostId in this.deps.settings.read().windows) {
      this.deps.settings.patchEntry(ghostId, { detached: false, lastOpen: false });
    }
    this.broadcast();
    this.deps.log.info('ghost panel window closed (destroyed)', { ghostId });
  }

  // ── 超时 ────────────────────────────────────────────────────────────

  private scheduleOpenFallback(ghostId: string, slot: WindowSlot): void {
    this.clearOpenTimeout(slot);
    slot.openTimeout = setTimeout(() => {
      slot.openTimeout = null;
      if (slot.win.isDestroyed() || !slot.pendingOpen) return;
      if (!slot.visible) this.showAndFocus(ghostId, slot);
    }, DEFAULT_OPEN_TIMEOUT_MS);
    slot.openTimeout.unref?.();
  }

  private clearOpenTimeout(slot: WindowSlot): void {
    if (!slot.openTimeout) return;
    clearTimeout(slot.openTimeout);
    slot.openTimeout = null;
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

  private onRendererReloadStarted(_ghostId: string, slot: WindowSlot): void {
    if (slot.win.isDestroyed()) return;
    const shouldRestore = slot.visible || slot.pendingOpen;
    if (shouldRestore) slot.pendingOpen = true;
    if (slot.visible) slot.win.hide();
    slot.rendererReady = false;
    slot.presentationReady = false;
    if (shouldRestore) {
      this.scheduleOpenFallback(_ghostId, slot);
    }
  }

  private invalidateSlot(ghostId: string, slot: WindowSlot, reason: string): void {
    if (slot.win.isDestroyed()) return;
    const reopen = slot.pendingOpen || slot.visible;
    this.deps.log.warn('ghost panel cached window invalidated', { ghostId, reason, reopen });
    this.disposeSlot(ghostId, slot);
    if (!reopen || this.disposed) return;
    if (slot.automaticRecoveryAttempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      this.deps.log.error('ghost panel automatic recovery exhausted', { ghostId, reason });
      return;
    }
    // 重建并重新 open:恢复额度在 presentationReady 时重置
    const replacement = this.ensureSlot(ghostId);
    if (!replacement) return;
    replacement.automaticRecoveryAttempts = slot.automaticRecoveryAttempts + 1;
    replacement.pendingOpen = true;
    this.scheduleOpenFallback(ghostId, replacement);
    this.deps.settings.patchEntry(ghostId, { detached: true, lastOpen: true });
    this.broadcast();
  }

  // ── 销毁 ────────────────────────────────────────────────────────────

  private disposeSlot(ghostId: string, slot: WindowSlot): void {
    this.clearTimeouts(slot);
    this.slots.delete(ghostId);
    slot.destroyingWindow = true;
    try {
      if (!slot.win.isDestroyed()) slot.win.destroy();
    } catch { /* already gone */ }
  }

  private clearTimeouts(slot: WindowSlot): void {
    if (slot.openTimeout) { clearTimeout(slot.openTimeout); slot.openTimeout = null; }
    if (slot.recoveryStabilityTimeout) { clearTimeout(slot.recoveryStabilityTimeout); slot.recoveryStabilityTimeout = null; }
  }

  // ── 查询 ────────────────────────────────────────────────────────────

  private entryState(
    ghostId: string,
    entry: { detached: boolean; lastOpen: boolean },
  ): GhostPanelWindowEntryState {
    return { detached: entry.detached, lastOpen: entry.lastOpen, open: this.isOpen(ghostId) };
  }

  private isOpen(ghostId: string): boolean {
    const slot = this.slots.get(ghostId);
    if (!slot || slot.win.isDestroyed()) return false;
    return slot.visible || slot.pendingOpen;
  }

  private broadcast(): void {
    this.deps.broadcastState(this.getState());
  }
}
