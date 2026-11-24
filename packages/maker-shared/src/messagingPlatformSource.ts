/**
 * 任务来源 → 消息平台。
 *
 * 消息平台(飞书、Slack 等)来的任务没有项目时落在「对话」里；任务列表可以把它们按平台各收成一组
 * (docs/product-rules/sidebar-redesign-plan.md §3.1「按消息平台」)。Desktop 侧栏与手机任务列表共用
 * 这一份判定，避免两端各记一份平台清单。
 *
 * 只看任务的 `source`，不看标题、工作目录或聊天对象——与「自动化」「Cindy Make」分组同口径。
 * 伙伴经消息平台接的任务来源是 `bot`，归伙伴自己的入口与筛选，不在这里。
 */

/** 能各自成组的消息平台；顺序只用于让同时出现的多个组有稳定的初始次序。 */
export const MESSAGING_PLATFORM_SOURCES = [
  'feishu',
  'slack',
  'telegram',
  'x',
  'discord',
  'wechat',
  'wecom',
  'dingtalk',
  'imessage',
] as const;

export type MessagingPlatformSource = (typeof MESSAGING_PLATFORM_SOURCES)[number];

/**
 * 这条任务是从哪个消息平台进来的；不是消息平台来的返回 null。
 * 官方 Discord bot 派发的任务(`discord-hook`)与个人 Discord bot 的任务同属 Discord。
 */
export function messagingPlatformOfSource(source: unknown): MessagingPlatformSource | null {
  if (source === 'discord-hook') return 'discord';
  return typeof source === 'string' && (MESSAGING_PLATFORM_SOURCES as readonly string[]).includes(source)
    ? (source as MessagingPlatformSource)
    : null;
}
