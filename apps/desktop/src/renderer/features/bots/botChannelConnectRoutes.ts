/**
 * 「这个渠道要去哪里连账号」的单一映射表。
 *
 * 背景(裁决 2026-08-19):能力墙上没有账号的渠道行原来是置灰的,附一句
 * 「先在设置里连接 X 账号」—— 用户点不动任何东西,还得自己去猜是哪一页。
 * 现在这些行可点,点下去**原地拉起该渠道真实的连接流程**。
 *
 * 每一条都指向客户端里**已经存在**的连接 UI,不新造假入口:
 *
 * | 渠道     | 归属           | 真实入口 |
 * | -------- | -------------- | -------- |
 * | feishu   | local-adapter  | 设置 › IM 机器人 › 个人 › 飞书机器人(FeishuBotSection) |
 * | telegram | local-adapter  | 设置 › IM 机器人 › 个人 › Telegram(TelegramBotSection) |
 * | slack    | server-relay   | 设置 › IM 机器人 › Cindy › Slack 卡(HookConnectionsSection) |
 * | wechat   | local-adapter  | 设置 › IM 机器人 › 个人 › 微信(WechatBotSection) |
 * | discord  | local-adapter  | 设置 › IM 机器人 › 个人 › Discord(DiscordBotSection) |
 * | dingtalk | local-adapter  | 设置 › IM 机器人 › 个人 › 钉钉(DingTalkBotSection) |
 * | wecom    | local-adapter  | 设置 › IM 机器人 › 个人 › 企业微信(WecomBotSection) |
 *
 * Slack 只有官方中转一条路(`hookViewToBotChannelConnections` 只从 Cindy 侧
 * 产出 slack 连接),所以它落 `cindy` 分区;其余都在「个人」分区,`imChannel`
 * 参数负责把对应那张手风琴卡展开并滚到可见。
 *
 * 这里刻意**不**判断区域/账号可见性(`imBotVisibility`)—— 那是设置页自己的
 * 权威判据,在这里再抄一份就会漂移。渠道在当前身份下不可见时,用户落到分区后
 * 看到的就是真实结果,而不是我们编的一句话。
 */
import type { BotChannel } from './botStore';
import type { MountableBotChannelKind } from './botChannelChips';

/** 「IM 机器人」页的两个纵向分区。 */
type ImBotGroup = 'cindy' | 'personal';

/** 「个人」分区里每张手风琴卡的 id(与 ImBotSection 的 expandedChannel 同一套)。 */
export type ImBotPersonalChannelId =
  | 'wechat'
  | 'wecom'
  | 'feishu'
  | 'discord'
  | 'telegram'
  | 'dingtalk';

interface BotChannelConnectRoute {
  group: ImBotGroup;
  /** 「个人」分区里要展开的那张卡;Cindy 分区没有这个概念。 */
  personalChannel?: ImBotPersonalChannelId;
}

const CONNECT_ROUTES: Record<MountableBotChannelKind, BotChannelConnectRoute> = {
  feishu: { group: 'personal', personalChannel: 'feishu' },
  telegram: { group: 'personal', personalChannel: 'telegram' },
  slack: { group: 'cindy' },
  wechat: { group: 'personal', personalChannel: 'wechat' },
  discord: { group: 'personal', personalChannel: 'discord' },
  dingtalk: { group: 'personal', personalChannel: 'dingtalk' },
  wecom: { group: 'personal', personalChannel: 'wecom' },
};

/**
 * 该渠道在设置里的连接入口路径;没有界面入口的渠道返回 `null`
 * (调用方据此如实显示「暂不支持在界面里连接」,而不是把人支走)。
 */
export function botChannelConnectPath(kind: BotChannel): string | null {
  const route = (CONNECT_ROUTES as Record<string, BotChannelConnectRoute | undefined>)[kind];
  if (!route) return null;
  const params = new URLSearchParams({ tab: 'im-bot', imGroup: route.group });
  if (route.personalChannel) params.set('imChannel', route.personalChannel);
  return `/settings?${params.toString()}`;
}

/** 该渠道是否真的能在界面里连上。 */
export function botChannelHasConnectUi(kind: BotChannel): boolean {
  return botChannelConnectPath(kind) !== null;
}

/** `?imChannel=` 的解析(设置页消费)。未知值一律 `null`,不抛。 */
export function parseImBotPersonalChannel(
  value: string | null | undefined,
): ImBotPersonalChannelId | null {
  return value === 'wechat' ||
    value === 'wecom' ||
    value === 'feishu' ||
    value === 'discord' ||
    value === 'telegram' ||
    value === 'dingtalk'
    ? value
    : null;
}
