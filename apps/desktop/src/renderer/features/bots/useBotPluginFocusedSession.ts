import { useEffect } from 'react';

/**
 * 伙伴会话通过归属校验后，报给插件系统作台前任务（插件的「当前任务」，如在任务页
 * 打开模拟器）。MainLayout 只按 /cc-agent 路由上报，对伙伴会话路由让位给这里。
 * Called by the route's ownership gate, never by URL-only navigation.
 */
export function useBotPluginFocusedSession(sessionId: string | null) {
  useEffect(() => {
    window.electronAPI?.ghosts?.noteSessionFocused?.(sessionId);
    return () => window.electronAPI?.ghosts?.noteSessionFocused?.(null);
  }, [sessionId]);
}
