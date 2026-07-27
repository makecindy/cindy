/**
 * GhostPanelWindowsController —— 插件停靠面板独立窗口的状态机(main 侧单例,
 * 依赖注入可测)。蓝本是 RsbWindowController,按 ghostId 多实例并做了减法:
 * 面板体只吃 manifest(广播全窗口可达),无需 ready 握手 / 上下文中继 / 命令队列。
 *
 * 每个 ghostId 的三态(与 RSB 同构):
 *   A. detached=false            —— 面板停靠在主窗布局树里
 *   C. detached=true, 窗口打开   —— 面板活在独立窗口
 *   (v1 关窗即回停靠,不保留"偏好开着但窗口收起"的 B 态;lastOpen 仅在
 *    app 退出路径保留,供重启恢复。)
 *
 * 职责:
 *  - 每 ghost 窗口生命周期(重复 open = focus;closed 区分用户关窗 vs app 退出)
 *  - 偏好 / lastOpen 落盘(settings-store),状态变化广播所有窗口
 *  - reconcile:插件卸载/停用/换形态时收窗(卸载删条目;停用清标志,
 *    避免"面板既不停靠也开不了窗"的死角)
 */

import type { BrowserWindow } from 'electron';

import type {
  GhostPanelWindowEntryState,
  GhostPanelWindowsState,
} from '../../shared/ghostPanelWindow.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import type { GhostPanelWindowsSettings } from './settings-store.js';

interface ControllerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface GhostPanelWindowsControllerDeps {
  settings: {
    read(): GhostPanelWindowsSettings;
    patchEntry(ghostId: string, patch: Partial<{ detached: boolean; lastOpen: boolean }>): void;
    removeEntry(ghostId: string): void;
  };
  /** 创建子窗口(不负责挂 closed 钩子,controller 自己挂)。 */
  createWindow: (ghostId: string) => BrowserWindow;
  /**
   * 该插件当前是否具备"可抽离的停靠面板"资格:已装、启用、声明了 panel 且
   * position 不是 'tab'。open/setDetached 前置校验与 reconcile 共用同一判据。
   */
  isGhostDetachable: (ghostId: string) => boolean;
  /** 状态变化广播(所有窗口)。bootstrap 注入 getAllWindows 遍历实现。 */
  broadcastState: (state: GhostPanelWindowsState) => void;
  isQuitting: () => boolean;
  log: ControllerLogger;
}

export class GhostPanelWindowsController {
  private readonly windows = new Map<string, BrowserWindow>();
  /** close() 到 closed 事件之间窗口仍未 destroyed,不能继续当活窗。 */
  private readonly closingIds = new Set<string>();

  constructor(private readonly deps: GhostPanelWindowsControllerDeps) {}

  getState(): GhostPanelWindowsState {
    const out: GhostPanelWindowsState = {};
    const { windows } = this.deps.settings.read();
    for (const [id, entry] of Object.entries(windows)) {
      out[id] = this.entryState(id, entry);
    }
    // 运行时开着但条目被清了的窗口(理论不存在,防御性合入)
    for (const id of this.windows.keys()) {
      if (!(id in out)) out[id] = this.entryState(id, { detached: false, lastOpen: false });
    }
    return out;
  }

  /** 幂等打开:已开则 show + focus;资格不符则清条目(防陈年状态复活废窗)。 */
  open(ghostId: string): void {
    const existing = this.windows.get(ghostId);
    if (existing && !existing.isDestroyed()) {
      if (this.closingIds.has(ghostId)) return;
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    if (!this.deps.isGhostDetachable(ghostId)) {
      this.deps.log.warn('ghost not detachable, pruning window entry', { ghostId });
      this.deps.settings.removeEntry(ghostId);
      this.broadcast();
      return;
    }
    const win = this.deps.createWindow(ghostId);
    this.windows.set(ghostId, win);
    this.closingIds.delete(ghostId);
    win.on('closed', () => this.onClosed(ghostId));
    this.deps.settings.patchEntry(ghostId, { detached: true, lastOpen: true });
    this.broadcast();
    this.deps.log.info('ghost panel window opened', { ghostId });
  }

  /** 写偏好;true 附带开窗,false 附带关窗(= 回停靠)。返回新 state 供 invoke 直接回。 */
  setDetached(ghostId: string, next: boolean): GhostPanelWindowsState {
    if (next) {
      this.open(ghostId); // open 内部落 detached/lastOpen 并广播
    } else {
      this.deps.settings.patchEntry(ghostId, { detached: false, lastOpen: false });
      const win = this.windows.get(ghostId);
      if (win && !win.isDestroyed()) {
        // onClosed 会广播,这里不重复
        this.closingIds.add(ghostId);
        win.close();
      } else {
        this.broadcast();
      }
    }
    // open/close 的幂等分支可能没广播(如重复 setDetached(true)),兜底广播必达。
    this.broadcast();
    return this.getState();
  }

  /**
   * 与"当前已装清单"对齐(broadcastGhostsChanged 观察者):
   * 失去抽离资格(卸载/停用/换 tab 形态)→ 收窗;卸载删条目,其余清标志
   * ——面板回停靠(或随卸载消失),不留"够不着"的死角。
   */
  reconcile(ghosts: InstalledGhost[]): void {
    const byId = new Map(ghosts.map((g) => [g.manifest.id, g]));
    const knownIds = new Set([
      ...Object.keys(this.deps.settings.read().windows),
      ...this.windows.keys(),
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
      const win = this.windows.get(id);
      if (win && !win.isDestroyed() && !this.closingIds.has(id)) {
        this.closingIds.add(id);
        win.close();
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

  private entryState(
    ghostId: string,
    entry: { detached: boolean; lastOpen: boolean },
  ): GhostPanelWindowEntryState {
    return { detached: entry.detached, lastOpen: entry.lastOpen, open: this.isOpen(ghostId) };
  }

  private isOpen(ghostId: string): boolean {
    const win = this.windows.get(ghostId);
    return win !== undefined && !this.closingIds.has(ghostId) && !win.isDestroyed();
  }

  private onClosed(ghostId: string): void {
    this.windows.delete(ghostId);
    this.closingIds.delete(ghostId);
    // app 退出路径:保留 detached/lastOpen 供下次启动恢复,也不广播(窗口都在销毁)
    if (this.deps.isQuitting()) return;
    // reconcile 的卸载路径可能已删条目(真实 close 是异步的,closed 晚到)——
    // 不要凭空再造一条陈年条目。
    if (ghostId in this.deps.settings.read().windows) {
      this.deps.settings.patchEntry(ghostId, { detached: false, lastOpen: false });
    }
    this.broadcast();
    this.deps.log.info('ghost panel window closed (re-docked)', { ghostId });
  }

  private broadcast(): void {
    this.deps.broadcastState(this.getState());
  }
}
