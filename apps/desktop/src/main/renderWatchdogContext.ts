import type { BrowserWindow, WebContents } from 'electron';

/** 只读原生数值/状态,不采集窗口标题、URL 或任何业务内容。 */
export function getRenderWatchdogContext(
  contents: Pick<WebContents, 'id' | 'isDestroyed' | 'getOSProcessId' | 'getBackgroundThrottling'>,
  win: Pick<BrowserWindow, 'id' | 'isDestroyed' | 'isVisible' | 'isMinimized'> | null,
) {
  const identity = { webContentsId: contents.id, windowId: win?.id ?? null };
  try {
    if (contents.isDestroyed() || win?.isDestroyed()) {
      return { ...identity, nativeStateUnavailable: true };
    }
    return {
      ...identity,
      nativeObservedAt: Date.now(),
      rendererPid: contents.getOSProcessId(),
      backgroundThrottling: contents.getBackgroundThrottling(),
      nativeVisible: win?.isVisible() ?? null,
      nativeMinimized: win?.isMinimized() ?? null,
    };
  } catch {
    // 窗口在退出过程中销毁时,诊断不能反过来打断退出/原始日志。
    return { ...identity, nativeStateUnavailable: true };
  }
}
