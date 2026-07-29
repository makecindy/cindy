import { useEffect, useState } from 'react';

export type ClaudeSessionBillingRoute = 'gateway' | 'subscription';

/**
 * useClaudeSessionRoute — cc 默认路由会话的「生效计费路由」(proxy 按请求观察的真值)。
 *
 * 返回 null = 未观察到(会话尚未发过请求 / app 重启后未活动 / enabled=false),此时
 * 消费方回落活性凭证启发式 —— 新会话的下一次 spawn 恰按当前凭证决定, 启发式即正确
 * 预测;而已发过请求的会话以观察值为准, 不受「spawn 后凭证变化」影响(child 凭证
 * 在 spawn 时冻结, 全局活性状态重算会与实际路由发散)。
 *
 * mount 时 GET 一次, 此后跟随 CLAUDE_SESSION_ROUTE_CHANGED push(按 sessionId 过滤)。
 *
 * 观察值与产生它的 sessionId 绑定,并在**渲染期**比对:组件保持挂载、仅切换
 * sessionId(典型:route-owner 会话视图切会话)的同一帧即返回 null,不存在
 * 「effect 重置前泄漏一帧上一个会话路由」的窗口(PR review P1)。
 */
export function useClaudeSessionRoute(
  sessionId: string | undefined,
  enabled: boolean,
): ClaudeSessionBillingRoute | null {
  const [observation, setObservation] = useState<{
    sessionId: string;
    route: ClaudeSessionBillingRoute;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let cancelled = false;
    void window.electronAPI.maker
      .claudeSessionRouteGet(sessionId)
      .then((value) => {
        if (!cancelled && value != null) setObservation({ sessionId, route: value });
      })
      .catch(() => {
        /* 读不到保持 null → 消费方回落启发式 */
      });
    const off = window.electronAPI.maker.onClaudeSessionRouteChanged((payload) => {
      if (payload.sessionId === sessionId) {
        setObservation({ sessionId, route: payload.route });
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, enabled]);

  return enabled && sessionId && observation?.sessionId === sessionId
    ? observation.route
    : null;
}
