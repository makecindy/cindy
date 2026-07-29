import { useEffect, useState } from 'react';

export type ClaudeSessionBillingRoute = 'gateway' | 'subscription';

export interface ClaudeSessionRouteState {
  /** 最近一个 ② 段默认路由请求的生效路由;null = 未观察到。 */
  route: ClaudeSessionBillingRoute | null;
  /** 最近一笔**失败**请求是否订阅直连 bridge(chatgpt/ / xai/ 覆写;响应侧落账)。 */
  lastFailedRequestBridge: boolean;
}

const EMPTY_STATE: ClaudeSessionRouteState = { route: null, lastFailedRequestBridge: false };

/**
 * useClaudeSessionRoute — cc 默认路由会话的「生效计费路由」观察状态(proxy 按请求
 * 观察的真值)。
 *
 * route = null 表示未观察到(会话尚未发过请求 / app 重启后未活动 / enabled=false),
 * 此时消费方回落活性凭证启发式 —— 新会话的下一次 spawn 恰按当前凭证决定, 启发式即
 * 正确预测;而已发过请求的会话以观察值为准, 不受「spawn 后凭证变化」影响(child
 * 凭证在 spawn 时冻结, 全局活性状态重算会与实际路由发散)。
 *
 * lastFailedRequestBridge 独立于 route:子代理按请求覆写 bridge 模型不改会话主
 * 路由(chip 形态不受影响),错误横幅靠它识别「最近一笔**失败**是 bridge 花的
 * 个人订阅额度」(proxy 响应侧落账,归因到失败那笔而非请求发起序),不把
 * bridge 配额错误贴成 Cindy 点数耗尽(PR review P1 ×3)。
 *
 * mount 时 GET 一次, 此后跟随 CLAUDE_SESSION_ROUTE_CHANGED push(按 sessionId 过滤)。
 *
 * 观察值与产生它的 sessionId 绑定,并在**渲染期**比对:组件保持挂载、仅切换
 * sessionId(典型:route-owner 会话视图切会话)的同一帧即返回空状态,不存在
 * 「effect 重置前泄漏一帧上一个会话路由」的窗口(PR review P1)。
 */
export function useClaudeSessionRoute(
  sessionId: string | undefined,
  enabled: boolean,
): ClaudeSessionRouteState {
  const [observation, setObservation] = useState<
    (ClaudeSessionRouteState & { sessionId: string }) | null
  >(null);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let cancelled = false;
    void window.electronAPI.maker
      .claudeSessionRouteGet(sessionId)
      .then((value) => {
        if (!cancelled && value != null) setObservation({ sessionId, ...value });
      })
      .catch(() => {
        /* 读不到保持空状态 → 消费方回落启发式 */
      });
    const off = window.electronAPI.maker.onClaudeSessionRouteChanged((payload) => {
      if (payload.sessionId === sessionId) {
        setObservation({
          sessionId,
          route: payload.route,
          lastFailedRequestBridge: payload.lastFailedRequestBridge,
        });
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, enabled]);

  return enabled && sessionId && observation?.sessionId === sessionId
    ? { route: observation.route, lastFailedRequestBridge: observation.lastFailedRequestBridge }
    : EMPTY_STATE;
}
