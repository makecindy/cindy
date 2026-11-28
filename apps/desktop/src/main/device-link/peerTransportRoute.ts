/**
 * 对端实际走哪条线路的**分类**(纯函数,不碰连接对象)。
 *
 * 出站路径诊断(#9537)要回答「这个对端的真实 socket 是哪一个」,而承载它的连接有四条:
 * 主连接、跨账号的官方连接、旧同账号对端专用的 legacy 连接、以及按资源安装的 scoped
 * 连接。前三条的 WebSocket URL 都是静态已知的(当前中转 / 官方中转),第四条由 route
 * server 决定、静态不可知 —— 不可知就不给判定,宁可不报也不谎称走了代理。
 *
 * 分类单独拎出来是为了让「哪条连接对应哪个 URL」这张表可被单测钉住:早先 legacy 连接
 * 被当成「不可知的 scoped 连接」一律返回 null,那种配置下所有 degraded 的中继路径
 * 会话都变成「没有判定」(Codex review P2)。
 */

/** 这个对端承载流量的线路。 */
export type PeerTransportRoute =
  /** 主连接(同账号、当前中转)。 */
  | 'primary'
  /** 跨账号 / 共享任务的官方连接。 */
  | 'cross-account'
  /** 旧同账号对端专用的 legacy 连接(Agent-Net 开着 legacy 兜底时)。 */
  | 'legacy'
  /** 按资源安装的 scoped 连接:URL 由 route server 决定,静态不可知。 */
  | 'scoped-unknown';

export function classifyPeerTransportRoute(args: {
  /** 承载该对端的连接就是主连接。 */
  isPrimary: boolean;
  /** 承载该对端的连接是 legacy 连接。 */
  isLegacy: boolean;
  /** 承载该对端的连接是跨账号的官方连接。 */
  isCrossAccount: boolean;
  /** 这个对端是 scoped 对端(共享任务 / 供应商分享 / 跨账号 peer)。 */
  isScopedPeer: boolean;
}): PeerTransportRoute {
  // 顺序有意义:legacy 与跨账号连接可能是同一条(crossAccountUsesLegacy 时跨账号帧
  // 也走 legacy),那条连接用的是当前中转,不是官方中转 —— 先判 legacy。
  if (args.isPrimary) return 'primary';
  if (args.isLegacy) return 'legacy';
  if (args.isCrossAccount) return 'cross-account';
  // 非 scoped 对端只可能被路由到 legacy 连接;剩下的就是 scoped 连接。
  return args.isScopedPeer ? 'scoped-unknown' : 'legacy';
}
