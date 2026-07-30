/**
 * 搜索 / 引用跳转的落点判定 —— 生产调用方(CCAgentSessionView 的 searchJump effect)与
 * 单测共用同一份逻辑。
 *
 * 抽成纯函数的原因:这个判定原先内联在 effect 里,只有渲染整个会话视图才能覆盖,于是
 * store 侧的自愈回归"绕过了真正的生产入口" —— 调用方在 messages 里看到目标就直接 focus,
 * store 的孤岛感知补齐根本没机会跑(#676 review)。
 */

/** 判定所需的最小窗口状态,便于单测直接构造。 */
export type SearchJumpWindowState = {
  messages: readonly { clientId: string }[];
  /** 窗口里是否掺进过跳转孤岛(补齐失败时 merge 的 around 窗口)。 */
  historyWindowHasIsland?: boolean;
};

/**
 * 能否直接 focus 已在窗口里的目标、跳过 store 的跳转加载?
 *
 * 只有两个条件同时成立才可以:
 *   1. 目标确实在当前窗口里;
 *   2. 窗口没有孤岛 —— 否则"在窗口里"可能只是先前失败的深跳留下的孤立片段,它与已加载的
 *      尾部之间隔着没加载的历史。这时必须交给 store 重新补齐,否则中间缺失永远修不回来。
 *
 * 曾经加过一个例外:"有孤岛但 hasMoreMessages === false 时直接 focus",理由是分页只能往更老
 * 翻、那边已经空了,补齐不可能改善覆盖。**这个理由是错的**,已撤掉:跳转不只走分页,它还发
 * around-client-id;远程权威重建可以同时留下「孤岛 + hasMore=false」(翻到历史起点却保留了一
 * 条被有损推送落下的、脱离窗口的行),那时 around 恰好能把它周围缺的邻居捞回来。用 hasMore 去
 * 短路会把这条修复通道永久关掉(#676 review codex P1)。
 *
 * 代价是"孤岛 + 已翻到历史起点"的会话每次窗口内搜索都会多打一次 around + 一次 list。要真正
 * 判定"窗口已完整覆盖、无需再试",得把已加载区间显式建模(见 MessageStream 里锚定窗口双向
 * 有界的 TODO,同一条后续改动),不是一个 boolean 能承载的。
 */
export function canFocusWithoutJumpLoad(
  state: SearchJumpWindowState,
  targetClientId: string,
): boolean {
  if (state.historyWindowHasIsland === true) return false;
  return state.messages.some((message) => message.clientId === targetClientId);
}
