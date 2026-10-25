import type { InteractiveCardSpec } from "@cindy/im";

/** Quick text-only check; treat anything starting with '/' (no spaces before) as a command. */
export function looksLikeSlashCommand(text: string): boolean {
  return text.startsWith("/");
}

export interface SlashCtx {
  botContextId: string;
  userId: string;
  /**
   * 群主流 @ 开话题的首条 slash 时由 messageHandler 注入: slash 的**首个**
   * 回复(文本或卡片)就地消费开场白卡(patch 文本 / 替换卡片)而不是另发 —
   * 「思考中」卡不会卡住, 也不会撤回后拿已删消息当回复锚点。消费过一次
   * 后返回 false, 后续回复正常发送。
   */
  consumePendingOpener?: {
    withMarkdown(userId: string, markdown: string): Promise<boolean>;
    withCard(userId: string, spec: InteractiveCardSpec): Promise<boolean>;
  };
}

export interface ImSlashHandlers {
  /**
   * Try to handle as a slash command. Returns true if handled.
   *
   * Unrecognised commands ALSO return true (we send "unknown command" reply
   * and skip the agent — we don't want every typo'd `/foo` to ping the model).
   */
  handleSlashCommand(text: string, ctx: SlashCtx): Promise<boolean>;
}
