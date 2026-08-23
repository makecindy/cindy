/**
 * unreadCount — 「N 条新消息」未读计数纯函数。
 * ---------------------------------------------------------------------------
 * MessageStream 的消息 diff 计数抽成纯函数（pattern 同 autoFollowIntent /
 * scrollAnchoringDetect），规则：
 *
 *  - 只累计**新出现**的 clientId；流式 token 追加（同 id 内容变化）不计数。
 *  - 视口在底部时不累计——auto-follow 已经把它送进视野。
 *  - 只数**尾部追加**：分页 loadOlderMessages prepend 的历史行同样不在
 *    prevIds 里，按纯 clientId 差分会把视口上方的旧消息误计成「新消息」
 *    （Codex review P2）。prevIds 非空时以「最后一条已见消息」为界，只数
 *    它之后的行；一条已见消息都找不到（窗口整体重置）则本轮不计。
 *    prevIds 为空（首渲染）保持既有行为：assistant 等角色全部按新内容计，
 *    但 user 行仍不计（见下一条的基线要求）。
 *  - assistant / ask_user / plan_review 在离底时计数。
 *  - user 消息默认不计数（本端发送会强制回底，用户必然看见）；但 #2194 之后
 *    外部入口（IM / 手机端 / 定时任务）注入的 user 消息不再抢视口，若不计数
 *    就会在屏幕外无声无息——调用方传入 isLocalUserSend 时，**非本端发送**的
 *    user 消息计入未读（Codex review P2）。isLocalUserSend 缺省保持既有行为。
 *    该规则只在 prevIds 非空（已有基线）时生效：会话重开 / 还原离底时首轮
 *    diff 的 prevIds 为空，内存态登记在重载后对该批历史 user 行一律返回
 *    false，若计入会把整批历史误报成「新消息」（Codex review P2，第五轮）。
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
  let candidates: readonly UnreadCountMessage[] = messages;
  if (prevIds.size > 0) {
    // 只数尾部追加：分页 prepend 的历史行不在 prevIds 里，纯差分会误计。
    let lastSeenIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (prevIds.has(messages[i].clientId)) {
        lastSeenIdx = i;
        break;
      }
    }
    // 一条已见消息都找不到 = 窗口整体重置（rewind / 重载），不做未读猜测。
    if (lastSeenIdx === -1) return 0;
    candidates = messages.slice(lastSeenIdx + 1);
  }
  let added = 0;
  for (const m of candidates) {
    if (prevIds.has(m.clientId)) continue;
    if (m.isSyntheticTrigger) continue;
    if (m.role === 'assistant' || m.role === 'ask_user' || m.role === 'plan_review') {
      added += 1;
      continue;
    }
    if (m.role === 'user' && prevIds.size > 0 && isLocalUserSend?.(m.clientId) === false) {
      added += 1;
    }
  }
  return added;
}
