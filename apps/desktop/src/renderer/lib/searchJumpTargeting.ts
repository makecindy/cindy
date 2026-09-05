/**
 * 搜索 / 引用跳转的落点判定 —— 生产调用方(CCAgentSessionView 的 searchJump effect)与
 * 单测共用同一份逻辑。
 *
 * 抽成纯函数的原因:这个判定原先内联在 effect 里,只有渲染整个会话视图才能覆盖,于是
 * store 侧的自愈回归"绕过了真正的生产入口" —— 调用方在 messages 里看到目标就直接 focus,
 * store 的孤岛感知补齐根本没机会跑(#676 review)。
 */

/**
 * 一座"孤岛":跳转补齐失败时 merge 的 around 窗口。它与主连续段(最新尾段)之间隔着
 * 没加载的历史,所以即使目标行在窗口里,也不能当"窗口已连续覆盖到它"直接 focus ——
 * 否则"中间缺失"永远修不回来。
 *
 * 这是对"已加载窗口"的显式建模:单个 boolean 无法回答"目标落在哪一段"这个问题,
 * 于是"孤岛 + 已翻到历史起点"的会话每次窗口内搜索都被迫多发一轮 around + list 探测
 * (searchJumpTargeting 旧版与 MessageStream 锚定窗口双向有界 TODO 同一条后续改动)。
 * 边界行 clientId 都保证在 messages 里(孤岛行全部来自 merge,不会被改名)。
 */
export type LoadedWindowIsland = {
  /** 孤岛最老一侧边界行的 clientId。 */
  oldestClientId: string;
  /** 孤岛最新一侧边界行的 clientId。 */
  newestClientId: string;
};

/** 判定所需的最小窗口状态,便于单测直接构造。 */
export type SearchJumpWindowState = {
  messages: readonly { clientId: string }[];
  /**
   * 窗口里掺进过的孤岛区间,按时间升序(最老在前)。
   * 缺省(undefined)等于"没有孤岛、整窗连续"。
   */
  historyWindowIslands?: readonly LoadedWindowIsland[];
};

/**
 * 主连续段(最新尾段)在 messages 里的起点下标。
 *
 * 窗口是 chronological 升序排列的;孤岛全部落在主段更老的一侧,所以主段就是
 * 最后一个孤岛最新边界行之后的所有行。没有孤岛时整窗都算主段。
 *
 * 边界行不在窗口里(理论上是模型被破坏,任何单点修复都不如保守)时返回
 * messages.length —— 主段为空,任何目标都走 store 补齐。
 */
export function mainContiguousRunStartIndex(
  messages: readonly { clientId: string }[],
  islands: readonly LoadedWindowIsland[],
): number {
  if (islands.length === 0) return 0;
  const newestIsland = islands[islands.length - 1];
  const seamIndex = messages.findIndex(
    (message) => message.clientId === newestIsland.newestClientId,
  );
  return seamIndex < 0 ? messages.length : seamIndex + 1;
}

/**
 * 目标是否落在主连续段里 —— 即"窗口最新行 → 目标"这段历史已确认连续、中间没有缺口。
 *
 * 这是 canFocusWithoutJumpLoad 与 store 侧补齐快速通道共用的同一把尺子,保证
 * 生产入口与自愈路径对"能否零成本 focus"的判定永远一致。
 */
export function isInsideMainContiguousRun(
  messages: readonly { clientId: string }[],
  islands: readonly LoadedWindowIsland[],
  targetClientId: string,
): boolean {
  const targetIndex = messages.findIndex((message) => message.clientId === targetClientId);
  if (targetIndex < 0) return false;
  return targetIndex >= mainContiguousRunStartIndex(messages, islands);
}

/**
 * 能否直接 focus 已在窗口里的目标、跳过 store 的跳转加载?
 *
 * 只有"目标落在主连续段里"才成立:那等于"最新 → 目标"整段已确认连续,聚焦它
 * 不需要任何网络。目标虽然在 messages 里、却在某座孤岛上时,它与已加载的尾部之间
 * 隔着没加载的历史,必须交给 store 重新补齐,否则中间缺失永远修不回来。
 *
 * 曾经加过一个例外:"有孤岛但 hasMoreMessages === false 时直接 focus",理由是分页只能往更老
 * 翻、那边已经空了,补齐不可能改善覆盖。**这个理由是错的**,已撤掉:跳转不只走分页,它还发
 * around-client-id;远程权威重建可以同时留下「孤岛 + hasMore=false」(翻到历史起点却保留了一
 * 条被有损推送落下的、脱离窗口的行),那时 around 恰好能把它周围缺的邻居捞回来。用 hasMore 去
 * 短路会把这条修复通道永久关掉(#676 review codex P1)。
 *
 * 代价是"孤岛 + 已翻到历史起点"的会话每次窗口内搜索都会多打一次 around + 一次 list。要真正
 * 判定"窗口已完整覆盖、无需再试",得把已加载区间显式建模(见 MessageStream 里锚定窗口双向
 * 有界的 TODO,同一条后续改动),不是一个 boolean 能承载的 —— 本文件与 makerChatStore 的
 * historyWindowIslands 就是这份显式建模:孤岛被向上翻页跨过(接回主段)后自动从模型里消失,
 * 主段内的目标不再需要任何探测。
 */
export function canFocusWithoutJumpLoad(
  state: SearchJumpWindowState,
  targetClientId: string,
): boolean {
  return isInsideMainContiguousRun(
    state.messages,
    state.historyWindowIslands ?? [],
    targetClientId,
  );
}
