import { useEffect, useState } from 'react';

/**
 * useMacFullscreen
 * ---------------------------------------------------------------------------
 * macOS 全屏状态订阅（非 mac 平台恒为 false）。
 *
 * 用途：mac 上 `titleBarStyle: 'hidden'` 的红绿灯悬浮在窗口左上角，
 * Sidebar 顶行 / ContentHeader 需要据此决定是否保留 70px 让位 padding；
 * 进入系统全屏后红绿灯隐藏，padding 撤销。
 *
 * 实现要点（自原 TitleBar 抽出，逻辑不变）：
 *   - mount 时主动查询一次当前状态 —— `enter-full-screen` 可能在 renderer
 *     订阅前就触发过（如 window-state 启动即恢复全屏），不查询会卡在 false。
 *   - 后续变化走 IPC 推送。不要用 resize 推断 —— 与 macOS 全屏动画冲突会闪烁。
 */
export function useMacFullscreen(): { isMac: boolean; isFullscreen: boolean } {
  const isMac = window.electronAPI?.platform === 'darwin';
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isMac) return;
    let cancelled = false;
    const api = window.electronAPI;
    if (typeof api?.getFullscreenState === 'function') {
      void api.getFullscreenState().then((fs) => {
        if (!cancelled) setIsFullscreen(fs);
      });
    }
    // Older packaged preload scripts (or a renderer/preload mismatch during an
    // update) may expose a missing or incompatible fullscreen bridge. The layout
    // can safely fall back to the non-fullscreen spacing; it must not crash.
    const unsub =
      typeof api?.onFullscreenChange === 'function'
        ? api.onFullscreenChange((fs: boolean) => setIsFullscreen(fs))
        : undefined;
    return () => {
      cancelled = true;
      if (typeof unsub === 'function') unsub();
    };
  }, [isMac]);

  return { isMac, isFullscreen };
}
