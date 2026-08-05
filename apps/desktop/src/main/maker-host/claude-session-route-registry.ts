/**
 * claude-session-route-registry —— cc 默认路由会话的「生效计费路由」观察表。
 *
 * proxy 的 routingTransform 是路由真值点:每个默认路由请求在那里被判定成
 * 走网关(gateway-spawn passthrough / oauth-spawn 换网关 key)还是直连
 * api.anthropic.com 走订阅。本模块在决策点旁路记录 sessionId → 路由,
 * 让 renderer 的计费形态 chip 拿到**会话实际流量的路由**,而不是用全局
 * 活性凭证状态(网关 key / OAuth 连接态)重算 —— 后者会与 spawn 时冻结的
 * 子进程凭证发散(典型:gateway-spawn 会话跑着时连上 OAuth 并清掉网关 key,
 * child 仍拿冻结的 x-api-key 走网关,活性重算却会误判成订阅)。
 *
 * 语义:
 *   - 只记「未显式选供应商」的默认路由请求(显式选供应商的会话由 providerId
 *     直接驱动 chip 形态, 不需要观察)。
 *   - 记录的是**最近一个请求**的生效路由;凭证中途变化后, 下一个请求会在
 *     transform 里按新状态重判并自动纠正记录。
 *   - 会话尚未发过请求(新会话 / app 重启后未活动)→ 无记录, 消费方回落
 *     活性启发式 —— 此时下一次 spawn 恰按当前凭证决定, 启发式就是正确预测。
 *
 * 热路径纪律(规则 10):record 每请求调用, 只做 Map 读写 + 同值短路;
 * listener 仅在路由值变化时触发(每会话生命周期通常一次)。
 * 条目随 app 生命周期常驻不逐出 —— 每条 ≈ 两个短字符串, 数千会话也可忽略。
 */

export type ClaudeSessionBillingRoute = 'gateway' | 'subscription';

type RouteChangeListener = (sessionId: string, route: ClaudeSessionBillingRoute) => void;

const routes = new Map<string, ClaudeSessionBillingRoute>();
const listeners = new Set<RouteChangeListener>();

/** proxy transform 决策点旁路调用;同值幂等(不重复通知)。 */
export function recordClaudeSessionRoute(
  sessionId: string,
  route: ClaudeSessionBillingRoute,
): void {
  if (routes.get(sessionId) === route) return;
  routes.set(sessionId, route);
  for (const listener of listeners) {
    try {
      listener(sessionId, route);
    } catch {
      /* listener 异常不影响路由热路径与其它订阅者 */
    }
  }
}

/** IPC GET 用:该会话最近一个默认路由请求的生效路由;未观察到 → null。 */
export function readClaudeSessionRoute(sessionId: string): ClaudeSessionBillingRoute | null {
  return routes.get(sessionId) ?? null;
}

/** 路由值变化订阅(bootstrap 接 renderer 广播)。返回取消函数。 */
export function onClaudeSessionRouteChange(listener: RouteChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试隔离用。 */
export function resetClaudeSessionRouteRegistryForTest(): void {
  routes.clear();
  listeners.clear();
}
