/** Displayable context captured from the same filtered prefixes used for this turn.
 * Never includes persona/system instructions or binary history attachments.
 */
export interface ImContextSnapshot {
  groupContext?: string;
  replyContext?: string;
  /** Counts of attached messages, supplied by producers before text serialization. */
  groupMessageCount?: number;
  replyMessageCount?: number;
}

/** Additive message metadata shared by hook and local IM ingress. */
export interface ImMessageSource {
  im: string;
  channelName?: string | null;
  userText?: string;
  /** Clean stored content can retain ordinary edit/rewind/fork behavior. Legacy hooks store prompts. */
  contentFormat?: 'user-text';
  threadContext?: Array<{ author: string; text: string; isBot?: boolean }>;
  contextSnapshot?: ImContextSnapshot;
}

const IM_CHANNEL_DISPLAY_NAMES: Record<string, string> = {
  feishu: '飞书',
  lark: 'Lark',
  telegram: 'Telegram',
  wechat: '微信',
  wecom: '企业微信',
  dingtalk: '钉钉',
  discord: 'Discord',
  slack: 'Slack',
  x: 'X',
};

/** 发给模型的来源说明里使用的渠道名（`ImMessageSource.im` 的值域）；未知渠道返回 null。 */
export function imChannelDisplayName(im: unknown): string | null {
  return typeof im === 'string' ? IM_CHANNEL_DISPLAY_NAMES[im] ?? null : null;
}

export function createLocalImSource(
  im: string,
  userText: string,
  contextSnapshot: ImContextSnapshot = {},
): ImMessageSource {
  return { im, userText, contentFormat: 'user-text', contextSnapshot };
}

/** Only call on a host-generated prefix, never search arbitrary message bodies. */
export function captureImContext(prefixes: {
  groupPrefix?: string;
  replyPrefix?: string;
  groupMessageCount?: number;
  replyMessageCount?: number;
}): ImContextSnapshot {
  const group =
    /^<group_chat_context>\r?\n\[(?:自你上次请求后群里新增的消息|群里最近的消息|本话题里最近的消息)\]\r?\n([\s\S]*?)\r?\n<\/group_chat_context>(?:\r?\n|$)/.exec(
      prefixes.groupPrefix ?? '',
    );
  const reply = /^<reply_context>\r?\n([\s\S]*?)\r?\n<\/reply_context>(?:\r?\n|$)/.exec(
    prefixes.replyPrefix ?? '',
  );
  return {
    ...(group?.[1]?.trim()
      ? {
          groupContext: group[1],
          ...(isImMessageCount(prefixes.groupMessageCount)
            ? { groupMessageCount: prefixes.groupMessageCount }
            : {}),
        }
      : {}),
    ...(reply?.[1]?.trim()
      ? {
          replyContext: reply[1],
          ...(isImMessageCount(prefixes.replyMessageCount)
            ? { replyMessageCount: prefixes.replyMessageCount }
            : {}),
        }
      : {}),
  };
}

/** Non-empty context must represent at least one message; legacy unknown stays unknown. */
export function isImMessageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
