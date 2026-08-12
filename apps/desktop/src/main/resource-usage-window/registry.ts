/**
 * 资源用量窗口是可独立恢复的辅助 renderer；它崩溃时不应触发主应用的致命退出链。
 * WebContents id 在一次 Electron 进程内不会复用，因此只增不删可覆盖 gone/closed 事件竞态。
 */

const resourceUsageWebContentsIds = new Set<number>();

export function markResourceUsageWebContentsId(id: number): void {
  resourceUsageWebContentsIds.add(id);
}

export function isResourceUsageWebContentsId(id: number): boolean {
  return resourceUsageWebContentsIds.has(id);
}
