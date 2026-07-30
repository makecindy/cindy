/**
 * 排队条目「落定中」判定的纯函数。
 * ---------------------------------------------------------------------------
 * 被控端 drain 会先把条目从 pendingQueue 摘除、之后消息才落库回流,device-link 下两者
 * 相隔可感知。这段窗口要继续渲染半透明气泡(转圈徽标),否则气泡凭空消失、只剩「正在
 * 同步」骨架 —— 新建会话必然命中(进入会话页时首条消息就在队列里)。
 *
 * 判据(与原会话页内联实现一致):只把「像被派发」的消失算落定中——
 *  - drain 恒从队首连续消费 → 消失的队首连续前缀算;
 *  - steer(插队发送)按 steeringQueueClientIds 标记 → 沾上的算;
 *  - 两者都不沾的中段消失是远端删除(桌面端 / 其它控制端取消),放行不渲染幽灵;
 *  - 已回流(hiddenClientIds)与本地主动删除(locallyRemovedClientIds)一律排除。
 *
 * 抽成纯函数是为了让 render 阶段与 layout effect 共用同一份判定:effect 里的 setState
 * 要多走一次 render 才落地(RN 下不保证绘制前 flush),render 阶段现算才能让气泡在队列
 * 减少的**同一帧**就补上,不漏空窗。
 */

export interface QueueSettlingInput<T extends { clientId: string }> {
  /** 上一帧的 pendingQueue 快照。 */
  previous: readonly T[];
  /** 当前 pendingQueue。 */
  current: readonly T[];
  /** 上一帧的插队发送标记集合。 */
  previousSteeringClientIds: ReadonlySet<string>;
  /** 当前插队发送标记集合。 */
  currentSteeringClientIds: ReadonlySet<string>;
  /** 已回流进消息流的 clientId(正式消息已在,不再需要落定气泡)。 */
  hiddenClientIds: ReadonlySet<string>;
  /** 用户本地主动删除的 clientId(不产生幽灵气泡)。 */
  locallyRemovedClientIds: ReadonlySet<string>;
}

/** 本帧从队列消失、且应当渲染成「落定中」的条目(保持原队列顺序)。 */
export function computeVanishedQueueItems<T extends { clientId: string }>(
  input: QueueSettlingInput<T>,
): T[] {
  const currentIds = new Set(input.current.map((item) => item.clientId));
  let vanishedPrefixEnd = 0;
  while (
    vanishedPrefixEnd < input.previous.length
    && !currentIds.has(input.previous[vanishedPrefixEnd].clientId)
  ) {
    vanishedPrefixEnd++;
  }
  return input.previous.filter((item, index) => !currentIds.has(item.clientId)
    && (
      index < vanishedPrefixEnd
      || input.previousSteeringClientIds.has(item.clientId)
      || input.currentSteeringClientIds.has(item.clientId)
    )
    && !input.hiddenClientIds.has(item.clientId)
    && !input.locallyRemovedClientIds.has(item.clientId));
}

/**
 * 合并 render 阶段现算的落定项与已落库的 settling state,按 clientId 去重
 * (state 优先——它带着 settling 起始时间,用于超时兜底)。
 */
export function mergeSettlingItems<T extends { clientId: string }>(
  settled: readonly T[],
  derived: readonly T[],
): readonly T[] {
  if (derived.length === 0) return settled;
  const known = new Set(settled.map((item) => item.clientId));
  const extra = derived.filter((item) => !known.has(item.clientId));
  return extra.length === 0 ? settled : [...settled, ...extra];
}
