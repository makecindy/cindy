import { useEffect, useRef } from 'react';

/**
 * 页面进入时请求 Main 后台同步 Git 自定义来源。Main 负责五分钟节流与跨窗口
 * 进行中去重；Renderer 只在本轮确有来源同步成功时重读一次市场快照。
 */
export function usePluginMarketSourceAutoRefresh(
  sessionKey: string,
  refreshMarket: () => void | Promise<void>,
): void {
  const refreshMarketRef = useRef(refreshMarket);
  refreshMarketRef.current = refreshMarket;

  useEffect(() => {
    let active = true;
    void window.electronAPI.pluginMarket
      .refreshGitSourcesIfStale()
      .then((result) => {
        if (!active || !result.refreshed) return;
        return refreshMarketRef.current();
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [sessionKey]);
}
