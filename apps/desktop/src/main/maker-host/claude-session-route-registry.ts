/**
 * claude-session-route-registry —— cc 请求路由观察表。
 *
 * proxy 的 routingTransform 是路由真值点:每个默认路由请求在那里被判定成
 * 走网关(gateway-spawn passthrough / oauth-spawn 换网关 key)还是直连
 * api.anthropic.com 走订阅。本模块在决策点旁路记录两份状态:
 *   - sessionId → 最近路由,让 renderer 的计费形态 chip 拿到实际计费形态;
 *   - reqId → 该请求的 sessionId + 精确路由,让响应观察器按请求归因错误。
 * 前者不能用于错误归因:后续请求可能在旧请求的终态事件到达前覆盖它。
 * 两份状态都来自实际路由决策,而不是用全局
 * 活性凭证状态(网关 key / OAuth 连接态)重算 —— 后者会与 spawn 时冻结的
 * 子进程凭证发散(典型:gateway-spawn 会话跑着时连上 OAuth 并清掉网关 key,
 * child 仍拿冻结的 x-api-key 走网关,活性重算却会误判成订阅)。
 *
 * 语义:
 *   - sessionId → 路由只记「未显式选供应商」的默认路由请求(显式供应商的会话由
 *     providerId 直接驱动 chip 形态, 不需要用这份 session 记录)。
 *   - reqId → 路由同时覆盖内置 XD / Anthropic 的显式请求,因为错误归因必须知道
 *     产生响应的那一笔请求究竟去了哪里。
 *   - session 记录的是**最近一个请求**的生效路由;凭证中途变化后, 下一个请求会在
 *     transform 里按新状态重判并自动纠正记录。
 *   - 会话尚未发过请求(新会话 / app 重启后未活动)→ 无记录, 消费方回落
 *     活性启发式 —— 此时下一次 spawn 恰按当前凭证决定, 启发式就是正确预测。
 *
 * 热路径纪律(规则 10):record 每请求调用, 只做 Map 读写 + 同值短路;
 * listener 仅在路由值变化时触发(每会话生命周期通常一次)。
 * 会话路由随 app 生命周期常驻;请求路由会在响应观察时消费,并有容量上限兜住
 * 连接失败等永远收不到响应的请求。
 */

export type ClaudeSessionBillingRoute = 'gateway' | 'subscription';

export interface ClaudeRequestRoute {
  sessionId: string;
  route: ClaudeSessionBillingRoute;
}

type RouteChangeListener = (sessionId: string, route: ClaudeSessionBillingRoute) => void;

const routes = new Map<string, ClaudeSessionBillingRoute>();
const listeners = new Set<RouteChangeListener>();
const requestRoutes = new Map<number, ClaudeRequestRoute>();
const latestRequestIds = new Map<string, number>();
const MAX_REQUEST_ROUTES = 256;

/** 每个带会话标头的请求一开始就调用；未知路由也会使旧错误证据失效。 */
export function noteClaudeSessionRequest(sessionId: string, reqId: number): void {
  const previousReqId = latestRequestIds.get(sessionId);
  if (previousReqId === undefined || reqId > previousReqId) {
    latestRequestIds.set(sessionId, reqId);
  }
}

/** 路由决策点记录该请求的精确上游类别，供响应观察器按 reqId 消费。 */
export function recordClaudeRequestRoute(
  reqId: number,
  sessionId: string,
  route: ClaudeSessionBillingRoute,
): void {
  noteClaudeSessionRequest(sessionId, reqId);
  requestRoutes.set(reqId, { sessionId, route });
  while (requestRoutes.size > MAX_REQUEST_ROUTES) {
    const oldestReqId = requestRoutes.keys().next().value as number | undefined;
    if (oldestReqId === undefined) break;
    requestRoutes.delete(oldestReqId);
  }
}

/** 响应观察器用；一次性消费，避免已完成请求常驻。 */
export function takeClaudeRequestRoute(reqId: number): ClaudeRequestRoute | null {
  const route = requestRoutes.get(reqId) ?? null;
  requestRoutes.delete(reqId);
  return route;
}

/** 终态归因只接受仍是本会话最新请求的证据。 */
export function readLatestClaudeSessionRequestId(sessionId: string): number | null {
  return latestRequestIds.get(sessionId) ?? null;
}

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
  requestRoutes.clear();
  latestRequestIds.clear();
}
