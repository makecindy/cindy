/**
 * feishu/messages.ts
 * ---------------------------------------------------------------------------
 * Centralised user-facing strings for transport-layer errors and lifecycle
 * announcements. Business-domain strings (agent errors, "API key required"
 * etc.) belong in the host orchestrator, not here.
 */

export const messages = {
  lifecycle: {
    online: '🟢 已上线，可以开聊啦~',
    offline: '🔴 Cindy 已离线，暂时无法通过当前 IM 继续聊天。',
    offlineNotice: '🔔 我之前离线过一段时间，期间的消息可能没有收到哦~',
  },
  ownerBinding: {
    welcome:
      '🎉 已绑定为本 bot 的 owner~\n之后只有你能跟我聊天。如需更换 owner，请到 desktop 的 Settings 页清除 bot 凭证后重新保存。',
  },
  group: {
    /** 非 owner 在群里 @bot 的礼貌回应(per-user 冷却防刷屏, 与 telegram 同语义)。 */
    strangerNotice:
      '👋 我是一位主人的个人 Cindy 助理，只响应主人本人的指令~\nI am a personal Cindy assistant and only respond to my owner.',
    /**
     * 群主流 @bot 时以触发消息为根开话题的开场白(reply_in_thread)。此后
     * 本会话所有回复都落在话题里, 群主流不被刷屏; 每个话题是独立 session。
     */
    threadOpener: '🧵 开个话题聊这条, 回复都在里面 ~',
  },
  // (inbound.skipped removed — orchestrator owns the wording for "pure
  // unsupported" / "mixed unsupported" replies; @cindy/im just emits the raw
  // entries via IMMessageEvent.unsupported.)
  /** Throttled streaming card placeholder texts. */
  streaming: {
    /**
     * Initial card placeholder shown before the first text-delta arrives.
     * Picks one variant at random per turn so back-to-back replies don't all
     * read identically — the IM card is the user's primary feedback channel
     * during the silent "agent is thinking" window, and a single static line
     * gets old fast in active sessions.
     *
     * Variants are kept short (≤ 14 visible chars including emoji) so they
     * fit on one line in the feishu card header without wrapping.
     */
    randomThinking(): string {
      return THINKING_VARIANTS[Math.floor(Math.random() * THINKING_VARIANTS.length)];
    },
    /** Intermediate frame: buffer contains only xdt-image refs (no real text). */
    preparingImage: '🎨 图片冲洗中,稍等一下 ~',
    /** Intermediate frame: buffer contains only xdt-file refs (no real text). */
    preparingFile: '📦 文件打包中,马上送达 ~',
    /** Finalize: card text empty after stripping xdt-file (model only sent files). */
    fileSentDone(count: number): string {
      return count === 1 ? '🎉 文件已送达,请查收!' : `🎉 ${count} 个文件已全部送达 ~`;
    },
    /** Finalize: card text empty AND no files (rare — agent emitted nothing useful). */
    emptyReply: '_(空回复)_',
    replyTruncated:
      '\n\n---\n⚠️ 回复过长，飞书仅展示前半部分；完整内容仍可在 Cindy 桌面端查看。',
    deliveryFailed:
      '⚠️ 这条回复过长或包含飞书暂不支持的内容，请在 Cindy 桌面端查看完整回复。',
  },
} as const;

const THINKING_VARIANTS: readonly string[] = [
  '🧠 脑子转转中...',
  '🤔 让我想想哦~',
  '✨ 灵感正在路上...',
  '🍵 泡杯茶,马上来~',
  '🐱 猫挠键盘思考中...',
  '🚀 引擎预热中...',
  '🌀 思绪整理中...',
  '🪄 念个咒语...',
  '📝 草稿打中...',
  '🧩 拼图组装中...',
  '☕ 续杯,马上回~',
  '🎯 瞄准答案中...',
];
