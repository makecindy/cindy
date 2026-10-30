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

/**
 * 这条 IM 消息是谁、在哪说的。伙伴自有 bot 的隐藏专线里主人与群成员 / 外部用户的消息
 * 落在同一条任务, 界面靠它区分「你说的」和「别人说的」(与发给模型的 `[渠道说明]` /
 * `[发言人]` 同源事实, 只多存给界面)。名字是平台可改的展示文本, 渲染时按不可信处理。
 */
export interface ImMessageOrigin {
  chat?: { kind: 'direct' | 'group'; name?: string };
  sender?: { id?: string; name?: string; isOwner: boolean };
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
  /** 可选; 旧记录与官方 hook 没有, 界面按「主人 / 未知」渲染。 */
  origin?: ImMessageOrigin;
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
  origin?: ImMessageOrigin,
): ImMessageSource {
  return { im, userText, contentFormat: 'user-text', contextSnapshot, ...(origin ? { origin } : {}) };
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
