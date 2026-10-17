/**
 * Ghost overlay windows 的 webContentsId ↔ ghostId 绑定表。
 *
 * 浮窗是独立 BrowserWindow(透明置顶、默认穿透),其 webContents 需要与承载
 * 应用的其它窗口区分:渲染进程崩溃 / 失联时按 webContentsId 反查归属意识,
 * 只影响该意识的浮窗,而不是把整个应用关机。每段意识至多一扇浮窗,表极小,
 * 线性反查即可。
 */

const overlayWebContentsToGhost = new Map<number, string>();

/** 记录某个 webContents 属于哪个意识的浮窗。 */
export function markGhostOverlayWebContentsId(id: number, ghostId: string): void {
  overlayWebContentsToGhost.set(id, ghostId);
}

/** 该 webContents 是否登记为浮窗。 */
export function isGhostOverlayWebContents(id: number): boolean {
  return overlayWebContentsToGhost.has(id);
}

/** 反查浮窗 webContents 归属的意识 id;未登记返回 null。 */
export function ghostIdForOverlayWebContents(id: number): string | null {
  return overlayWebContentsToGhost.get(id) ?? null;
}

/** 浮窗关闭 / 销毁后清理绑定。 */
export function clearGhostOverlayWebContents(id: number): void {
  overlayWebContentsToGhost.delete(id);
}
