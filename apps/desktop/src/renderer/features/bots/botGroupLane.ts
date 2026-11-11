/**
 * 伙伴群专线 Session 的识别。
 *
 * 每位成员在每个群里有一条隐藏的群专线（`bot_session_links.role = 'group'`），main
 * 把它和主任务、子任务一起投影进伙伴 Profile 的 `sessions[]`（`kind` 同为 `'group'`）。
 * 它只服务群聊编排：不进任务列表、伙伴主时间线、历史、未读、运行中标记和系统通知
 * （docs/product-rules/bot-group-chat.md §3）。所有按伙伴 `sessions[]` 统计「这位伙伴
 * 在忙什么」的地方都要先用这里把它排除掉。
 *
 * 刻意不放进 botStore：侧栏等测试会按需 mock botStore 的导出，纯函数单独成模块，
 * 调用方不必跟着改 mock。
 */

export interface BotSessionRoleLike {
  role?: unknown;
  kind?: unknown;
}

export function isBotGroupLaneSession(session: BotSessionRoleLike | null | undefined): boolean {
  return !!session && (session.role === 'group' || session.kind === 'group');
}

/** The Bot's own task projections, without hidden group lanes. */
export function withoutBotGroupLanes<T extends BotSessionRoleLike>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isBotGroupLaneSession(session));
}

/**
 * 伙伴接管的个人 IM 群 / 话题专线（`bot_session_links.role = 'channel'`）。与群专线
 * 一样隐藏：不进任务列表、伙伴主时间线、历史、未读、运行中标记和系统通知；它的
 * 记录在 IM 里。刻意与 isBotGroupLaneSession 分开 —— 那个判据驱动伙伴群聊行。
 */
export function isBotChannelLaneSession(session: BotSessionRoleLike | null | undefined): boolean {
  return !!session && (session.role === 'channel' || session.kind === 'channel');
}

/** 群专线或 IM 专线：都不是这位伙伴自己的任务。 */
export function isBotHiddenLaneSession(session: BotSessionRoleLike | null | undefined): boolean {
  return isBotGroupLaneSession(session) || isBotChannelLaneSession(session);
}

/** The Bot's own task projections, without hidden group or IM channel lanes. */
export function withoutBotHiddenLanes<T extends BotSessionRoleLike>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isBotHiddenLaneSession(session));
}
