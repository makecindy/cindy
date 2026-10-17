/**
 * 伙伴自有 IM 机器人连接的 IPC 线上类型(main / preload / renderer 共用)。
 *
 * 一位伙伴可以挂多个平台的机器人(Telegram、飞书 / Lark、企业微信、钉钉、Discord), 凭证由用户自己在平台申请,
 * 在伙伴设置「消息平台」页直接填; 与 设置 → IM 机器人 里那份个人 bot 各用各的凭证, 也可以把个人 bot
 * 一次性移过来(个人 bot 随之清空, 不共用)。
 * 主人私聊进伙伴主任务, 群 / 话题 / 外部用户私聊各一条隐藏专线。
 * 正本与语义见 main/im/shared/botImConnectionStore.ts 与 botImConnectionRuntime.ts。
 */

export const BOT_IM_CHANNELS = ['telegram', 'feishu', 'wecom', 'dingtalk', 'discord'] as const;
export type BotImChannel = (typeof BOT_IM_CHANNELS)[number];

export type BotImFeishuService = 'feishu' | 'lark';

/**
 * 伙伴主任务(主人私聊落点)的 vendorOptions 标记: 这个伙伴绑定了哪些平台的机器人。
 *
 * 群 / 话题 / 外部用户专线带 `telegramChatId` / `feishuChatId`, 渠道原生 API 工具
 * (`cindy_telegram_bot` / `cindy_feishu_bot`)据此挂载; 主任务与桌面共用, 不能带专线那套
 * 字段(会让桌面上的交互变成无头), 所以只带「绑了哪些渠道」。目标 chat 与触发者身份仍只来自
 * 逐轮作用域租约(main/im/shared/channelToolScope.ts), 这个标记只决定工具挂不挂。
 */
export const BOT_IM_CHANNELS_VENDOR_KEY = 'cindyBotImChannels';

export function readBotImChannelsFromVendorOptions(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
): BotImChannel[] {
  const raw = vendorOptions?.[BOT_IM_CHANNELS_VENDOR_KEY];
  if (!Array.isArray(raw)) return [];
  return (BOT_IM_CHANNELS as readonly string[]).filter((channel) => raw.includes(channel)) as BotImChannel[];
}

/** 各渠道专线在 vendorOptions 里记目标 chat 的字段名(与各 adapter 的 buildVendorOptions 同源)。 */
export const BOT_IM_CHANNEL_CHAT_VENDOR_KEY: Record<BotImChannel, string> = {
  telegram: 'telegramChatId',
  feishu: 'feishuChatId',
  wecom: 'wecomConversationId',
  dingtalk: 'dingtalkChatId',
  discord: 'discordChatId',
};

/** 这个会话的轮次能用某个渠道的原生 API 工具: 专线带该渠道 chat, 或主任务标记绑了该渠道。 */
export function hasImChannelVendorOptions(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
  channel: BotImChannel,
): boolean {
  if (typeof vendorOptions?.[BOT_IM_CHANNEL_CHAT_VENDOR_KEY[channel]] === 'string') return true;
  return readBotImChannelsFromVendorOptions(vendorOptions).includes(channel);
}

/** 与 @cindy/im 的 IMStatus 同形, 这里单独声明避免 renderer 依赖传输包类型。 */
export type BotImConnectionStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  | { kind: 'offline'; appId: string }
  | { kind: 'error'; reason: string; code?: string };

/** 落盘记录: 不含凭证, 凭证按连接 id 前缀存在本机安全存储里。 */
export interface BotImConnectionRecord {
  id: string;
  botId: string;
  channel: BotImChannel;
  createdAt: number;
  /** 飞书 / Lark 二选一(只有 feishu 渠道有)。 */
  service?: BotImFeishuService;
  /** 平台身份(Telegram bot id / 飞书 app id / 企业微信 bot id / 钉钉 AppKey / Discord 应用 id), 首次连上后记下, 用于专线 route key。 */
  botContextId: string | null;
  /**
   * 群参与模式覆写(Telegram 连接): chatId → 'always' = 全响应·自主判断(每条群消息都进
   * 专线, 伙伴用 NO_REPLY 决定插不插话)。缺省 = 仅 @ / 回复触发。与 设置 → IM 机器人 那份
   * 个人 bot 的同名配置互不相干 —— 每条连接自己一份。
   */
  groupActivation?: Record<string, 'always'>;
}

export type BotImGroupActivationMode = 'mention' | 'always';

/** 伙伴机器人进过的群(群窗口表里出现过的 chat)及其参与模式。 */
export interface BotImConnectionGroup {
  chatId: string;
  chatName: string | null;
  activation: BotImGroupActivationMode;
}

export interface BotImConnectionGroupsPayload {
  connectionId: string;
  groups: BotImConnectionGroup[];
}

export interface BotImConnectionView extends BotImConnectionRecord {
  status: BotImConnectionStatus;
  identity: {
    /** Telegram bot 用户名 / Discord bot 标签(连上后才有); 其它渠道为 null。 */
    username: string | null;
    /** 主人用户 id: Telegram / Discord 是填进去的, 企业微信 / 钉钉是首个私聊者(TOFU), 还没人私聊时为 null。 */
    ownerUserId: string | null;
  };
}

export interface BotImConnectionListPayload {
  connections: BotImConnectionView[];
}

export type BotImConnectionAddInput =
  | { botId: string; channel: 'telegram'; token: string; ownerUserId: string }
  | {
      botId: string;
      channel: 'feishu';
      appId: string;
      appSecret: string;
      service: BotImFeishuService;
    }
  /** 企业微信智能机器人: 平台上的 Bot ID + Secret(与伙伴 id `botId` 不是一回事)。 */
  | { botId: string; channel: 'wecom'; wecomBotId: string; secret: string }
  | { botId: string; channel: 'dingtalk'; appKey: string; appSecret: string }
  | { botId: string; channel: 'discord'; token: string; ownerUserId: string };

export interface BotImConnectionAddResult extends BotImConnectionListPayload {
  connection: BotImConnectionView;
}

/**
 * 设置 → IM 机器人 里已经配好、可以整个移给伙伴的个人 bot(只给身份, 不给凭证)。
 * 移过去后个人 bot 清空; Telegram 的群参与模式与各渠道已认定的主人一并带上。
 */
export interface BotImAdoptablePersonalBot {
  channel: BotImChannel;
  /** 给人看的身份: Telegram @用户名 / 飞书 App ID / 企业微信 Bot ID / 钉钉 Client ID / Discord bot 标签; 读不到为 null。 */
  identity: string | null;
  /** 飞书 / Lark(只有 feishu 渠道有)。 */
  service?: BotImFeishuService;
}

export interface BotImAdoptablePersonalBotsPayload {
  bots: BotImAdoptablePersonalBot[];
}

export interface BotImAdoptPersonalBotInput {
  botId: string;
  channel: BotImChannel;
}

export interface BotImConnectionRemoveResult extends BotImConnectionListPayload {
  /** 随连接一起归档的隐藏专线任务。 */
  archivedSessionIds: string[];
}

/**
 * 一条连接下有任务的落点(「消息平台」页的隐藏任务小节): 主人私聊落在伙伴主任务,
 * 群 / 话题 / 其他人的私聊各一条隐藏专线。只读投影, 状态取自已有任务状态, 不另存。
 */
export type BotImLaneKind = 'owner-dm' | 'group' | 'topic' | 'guest-dm';

/** idle = 空闲; running = 正在回复; failed = 上一轮以错误收尾(最近一条消息是错误行)。 */
export type BotImLaneState = 'idle' | 'running' | 'failed';

export interface BotImConnectionLane {
  sessionId: string;
  kind: BotImLaneKind;
  /** 群 / 话题的群 id, 其他人私聊的用户 id; 主人私聊为 null。 */
  chatId: string | null;
  /** 话题 id(只有 kind = topic 有)。 */
  threadId: string | null;
  /** 存储里已有的名字(群名 / 发言人名); 没有为 null, 界面回落到 id。 */
  name: string | null;
  state: BotImLaneState;
  /** 最近一条消息的时间(unix ms); 还没有消息为 null。 */
  lastActivityAt: number | null;
  /** 当前上下文(上次重新开始 / 自动整理之后)里收到的消息数。 */
  contextMessageCount: number;
}

export interface BotImConnectionLanesPayload {
  connectionId: string;
  lanes: BotImConnectionLane[];
}

export const BOT_IM_CONNECTION_CHANGED_EVENT = 'botImConnection:changed';
