/**
 * unreadCount — 「N 条新消息」未读计数纯函数。
 * ---------------------------------------------------------------------------
 * MessageStream 的消息 diff 计数抽成纯函数（pattern 同 autoFollowIntent /
 * scrollAnchoringDetect）。返回本轮新增的**未读键**，调用方按键去重累加，
 * 未读数 = 键的数量。规则：
 *
 *  - 按用户看到的「一条消息」计数：同一回合（两条非 steer user 消息之间）的
 *    assistant 输出共用一个键——执行中的中间正文、空占位行最终都折进同一段
 *    工作过程，逐条计数会让一次回复报出几十条新消息。ask_user / plan_review
 *    卡片各自独立计数。
 *  - 只看**新出现**的 clientId；流式 token 追加（同 id 内容变化）不计数。
 *  - 视口在底部时不累计——auto-follow 已经把它送进视野。
 *  - 只数**尾部追加**：分页 loadOlderMessages prepend 的历史行同样不在
 *    prevIds 里，按纯 clientId 差分会把视口上方的旧消息误计成「新消息」
 *    （Codex review P2）。prevIds 非空时以「最后一条已见消息」为界，只数
 *    它之后的行；一条已见消息都找不到（窗口整体重置）则本轮不计。
 *    prevIds 为空（首渲染）保持既有行为：assistant 等角色全部按新内容计，
 *    但 user 行仍不计（见下一条的基线要求）。
 *  - user 消息默认不计数（本端发送会强制回底，用户必然看见）；但 #2194 之后
 *    外部入口（IM / 手机端 / 定时任务）注入的 user 消息不再抢视口，若不计数
 *    就会在屏幕外无声无息——调用方传入 isLocalUserSend 时，**非本端发送**的
 *    user 消息计入未读（Codex review P2）。isLocalUserSend 缺省保持既有行为。
 *    该规则只在 prevIds 非空（已有基线）时生效：会话重开 / 还原离底时首轮
 *    diff 的 prevIds 为空，内存态登记在重载后对该批历史 user 行一律返回
 *    false，若计入会把整批历史误报成「新消息」（Codex review P2，第五轮）。
 *  - 合成指令行（isSyntheticTrigger，如手动「继续」/ Mivo 触发指令）渲染 null，
 *    永远不可见，不计数——否则留下点对不掉的幻影未读（Codex review P1）。它仍是
 *    回合边界：定时唤醒后的结果是一条新回复。
 */

export interface UnreadCountMessage {
  clientId: string;
  role: string;
  /** 合成指令行（MessageStream 渲染 null）；缺省视为普通可见消息 */
  isSyntheticTrigger?: boolean;
  /** 'steer' 的 user 消息插进当前回合，不开启新回合 */
  delivery?: string;
  /** assistant 系统卡（Cindy Make / review 等）；与 MessageStream 同口径，开启新回合 */
  systemCardType?: string;
}

export interface CollectUnreadKeysArgs {
  /** 上一轮已见的 clientId 集合 */
  prevIds: ReadonlySet<string>;
  /** 本轮完整消息列表（按渲染顺序） */
  messages: readonly UnreadCountMessage[];
  /** 视口是否贴底（auto-follow 接管，不累计） */
  nearBottom: boolean;
  /** #2194: 判定 user 消息是否本端发送；缺省时 user 一律不计数（既有行为） */
  isLocalUserSend?: (clientId: string) => boolean;
}

function isTurnBoundary(m: UnreadCountMessage): boolean {
  if (m.role === 'user') return m.delivery !== 'steer';
  return (
    m.role === 'assistant' &&
    (m.systemCardType === 'cindy-make' ||
      m.systemCardType === 'cindy-make-doctor' ||
      m.systemCardType === 'review')
  );
}

const UNKNOWN_TURN_KEY = 'turn:';

export interface UnreadKeyUpdate {
  /** 本轮新增的未读键 */
  keys: string[];
  /**
   * 本轮新增行续接的是已见的回合，且回合起点现在已可见：此前在起点未加载时记下的
   * 「起点未知」键与它是同一次回复，调用方应移除，避免补载历史后重复计数。
   */
  supersedes: string[];
}

export function collectUnreadKeys({
  prevIds,
  messages,
  nearBottom,
  isLocalUserSend,
}: CollectUnreadKeysArgs): UnreadKeyUpdate {
  const none: UnreadKeyUpdate = { keys: [], supersedes: [] };
  if (nearBottom) return none;
  let start = 0;
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
    if (lastSeenIdx === -1) return none;
    start = lastSeenIdx + 1;
  }
  let turnKey = UNKNOWN_TURN_KEY;
  // 续接已见回合，且该回合起点是这一轮才补载出来的（不在 prevIds 里）：此前给这些
  // 行记的是「起点未知」键。起点早已见过的回合（如之后新到的 user）不属于此类。
  let boundaryBeforeStart = false;
  for (let i = start - 1; i >= 0; i--) {
    if (isTurnBoundary(messages[i])) {
      turnKey = `turn:${messages[i].clientId}`;
      boundaryBeforeStart = !prevIds.has(messages[i].clientId);
      break;
    }
  }
  const keys = new Set<string>();
  const supersedes: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (isTurnBoundary(m)) {
      turnKey = `turn:${m.clientId}`;
      boundaryBeforeStart = false;
    }
    if (prevIds.has(m.clientId)) continue;
    if (m.isSyntheticTrigger) continue;
    if (m.role === 'assistant') {
      keys.add(turnKey);
      if (boundaryBeforeStart && !supersedes.includes(UNKNOWN_TURN_KEY)) {
        supersedes.push(UNKNOWN_TURN_KEY);
      }
    } else if (m.role === 'ask_user' || m.role === 'plan_review') {
      keys.add(m.clientId);
    } else if (m.role === 'user' && prevIds.size > 0 && isLocalUserSend?.(m.clientId) === false) {
      keys.add(m.clientId);
    }
  }
  return { keys: [...keys], supersedes };
}
