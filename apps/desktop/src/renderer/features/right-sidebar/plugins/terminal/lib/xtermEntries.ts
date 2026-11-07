/**
 * xterm 实例池的存储与 PTY 归属标记 —— 刻意只引用 xterm 的类型，不引入运行时。
 *
 * MainLayout 在侧边栏「内嵌 ↔ 独立窗口」迁移时只需要复位 ptyAttached 标记。若它从
 * xtermPool 引入这些函数，@xterm/xterm 与其样式表会跟着进入主窗口首屏（约 290 KB），
 * 终端页签的懒加载就失效了。实例的创建与销毁仍在 xtermPool。
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export interface XtermEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** 上次 fit 的尺寸,供 mount 后立即用作 PTY 初始 cols/rows。 */
  lastSize: { cols: number; rows: number };
  /**
   * 本 renderer 是否已对该 tab 调过 terminal.create(PTY sink 绑到本窗口)。
   * per-renderer 标记:侧边栏在"内嵌 ↔ 独立子窗口"间迁移时,PTY 在 main 仍活着
   * (state.created 持久化为 true),但新窗口的 renderer 从未 attach 过 —— 此时
   * 必须再调一次 create 做幂等 re-attach(ptyManager.create 支持换 owner),
   * 否则 PTY 输出仍推给旧窗口。见 TerminalTabBody effect #2。
   */
  ptyAttached: boolean;
}

/** tabId → xterm 实例。只由 xtermPool 增删。 */
export const xtermEntries = new Map<string, XtermEntry>();

/**
 * 侧边栏宿主在"内嵌 ↔ 独立子窗口"间迁移时调用(MainLayout detach/attach 转换清理,
 * 两个方向都要):把所有 entry 的 ptyAttached 复位为 false,强制下次 mount 重新走
 * terminal.create 幂等 re-attach,把 PTY 输出 sink 切回本窗口。不复位的话,
 * "弹出 → 合并回主窗"往返后本 renderer 的 entry 残留 ptyAttached=true,
 * TerminalTabBody 的 guard 会跳过 re-attach,终端输入输出失活。
 * 只改标记不 dispose xterm 实例 —— scrollback 保留。
 */
export function markAllPtyDetached(): void {
  for (const entry of xtermEntries.values()) entry.ptyAttached = false;
}

/**
 * 单个页签在「侧边栏 ↔ 单页签独立窗口」间迁移时调用(弹出前 / 交回后各一次):
 * 只复位这一个 entry 的 ptyAttached,其余终端页签不受影响。语义同 markAllPtyDetached。
 */
export function markPtyDetached(tabId: string): void {
  const entry = xtermEntries.get(tabId);
  if (entry) entry.ptyAttached = false;
}
