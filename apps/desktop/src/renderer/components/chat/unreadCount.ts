/**
 * unreadCount — 「N 条新消息」未读计数纯函数。
 * ---------------------------------------------------------------------------
 * MessageStream 的消息 diff 计数抽成纯函数（pattern 同 autoFollowIntent /
 * scrollAnchoringDetect），规则：
 *
 *  - 只累计**新出现**的 clientId；流式 token 追加（同 id 内容变化）不计数。
 *  - 视口在底部时不累计——auto-follow 已经把它送进视野。
 *  - assistant / ask_user / plan_review 始终计数。
 *  - user 消息默认不计数（本端发送会强制回底，用户必然看见）；但 #2194 之后
 *    外部入口（IM / 手机端 / 定时任务）注入的 user 消息不再抢视口，若不计数
 *    就会在屏幕外无声无息——调用方传入 isLocalUserSend 时，**非本端发送**的
 *    user 消息计入未读（Codex review P2）。isLocalUserSend 缺省保持既有行为。
 *  - 合成指令行（isSyntheticTrigger，如手动「继续」/ Mivo 触发指令）渲染 null，
 *    永远不可见，不计数——否则留下点对不掉的幻影未读（Codex review P1）。
 */

export interface UnreadCountMessage {
  clientId: string;
  role: string;
  /** 合成指令行（MessageStream 渲染 null）；缺省视为普通可见消息 */
  isSyntheticTrigger?: boolean;
}

export interface CountUnreadAddedArgs {
  /** 上一轮已见的 clientId 集合 */
  prevIds: ReadonlySet<string>;
  /** 本轮完整消息列表（按渲染顺序） */
  messages: readonly UnreadCountMessage[];
  /** 视口是否贴底（auto-follow 接管，不累计） */
  nearBottom: boolean;
  /** #2194: 判定 user 消息是否本端发送；缺省时 user 一律不计数（既有行为） */
  isLocalUserSend?: (clientId: string) => boolean;
}

export function countUnreadAdded({
  prevIds,
  messages,
  nearBottom,
  isLocalUserSend,
}: CountUnreadAddedArgs): number {
  if (nearBottom) return 0;
  let added = 0;
  for (const m of messages) {
    if (prevIds.has(m.clientId)) continue;
    if (m.isSyntheticTrigger) continue;
    if (m.role === 'assistant' || m.role === 'ask_user' || m.role === 'plan_review') {
      added += 1;
      continue;
    }
    if (m.role === 'user' && isLocalUserSend?.(m.clientId) === false) added += 1;
  }
  return added;
}
