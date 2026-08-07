/**
 * telegram/reactionPool.ts — expressive 档 reaction 变体池(#1855 L1)。
 * ---------------------------------------------------------------------------
 * 生动档变体池的**单一客户端出处** — Telegram bot 可用标准 reaction 全集按语义
 * 分池(Chris: 能用的都随便用)。正/负分开是底线: 成功不能随机出 💩/🤡。选中
 * 表情在该群被限制时(available_reactions), setMessageReaction 会 400 — 调用方
 * 回落基础款(👍/👎)重试一次。
 *
 * emoji 档本身继续由各车道的 TelegramBehaviorConfig.emojiReactions 三字段直接
 * 供给, L1 不为其带默认(#1855 replyQuote 勘误同源纪律): 本模块只提供 expressive
 * 命中时的**变体池数据 + 选取原语**, 不做策略判定。
 */

/** expressive 终态(成功)变体池 — 35 款正向表情。 */
export const EXPRESSIVE_DONE_POOL = [
  '👍', '❤', '🔥', '🥰', '👏', '😁', '🎉', '🤩', '🙏', '👌',
  '😍', '❤‍🔥', '💯', '🤣', '⚡', '🏆', '🍾', '🤗', '🫡', '😇',
  '🤝', '💅', '🆒', '💘', '😎', '🦄', '🕊', '🐳', '🍓', '💋',
  '😘', '🎃', '👾', '🍌', '🌭',
] as const;

/** expressive 终态(失败)变体池 — 10 款负向表情。 */
export const EXPRESSIVE_ERROR_POOL = [
  '👎', '😱', '😢', '💔', '😨', '🤯', '🥴', '🙈', '😐', '🗿',
] as const;

/** 从池中等概率取一个变体。`random` 可注入以便测试确定化(缺省 Math.random)。 */
export function pickExpressiveReaction(
  pool: readonly string[],
  random: () => number = Math.random,
): string {
  return pool[Math.floor(random() * pool.length)];
}
