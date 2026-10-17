/**
 * 渠道工具的逐 turn 作用域租约。
 *
 * `cindy_telegram_bot` / `cindy_feishu_bot` MCP 让 Agent 在渠道轮次里直接驱动平台 API。它和群历史
 * 检索一样不信任模型参数或持久 session 配置来判断"当前在哪个 chat、谁触发的":渠道
 * 只在 provider 真正开始当前 turn 前登记作用域,终态 / 重排 / 失败时同步释放。
 * `sessionInstanceId` 阻断同一业务 session 重建后,旧 MCP 请求借用新实例权限。
 *
 * Telegram / 飞书的作用域带 transport(`TelegramToolTransport` / `FeishuToolTransport`),就是这条
 * 连接自己的 TelegramIM / FeishuIM:工具永远经触发本轮的那个 bot 出站,不会串到别的连接(个人
 * 设置页 bot 与伙伴自有连接各走各的)。企业微信 / 钉钉 / Discord 没有渠道直通工具,伙伴专线轮次
 * 只登记不带 transport 的 `LaneTurnScope`,供伙伴技能等按「这一轮是不是主人触发」授权。
 */

import type { FeishuIM, TelegramIM } from '@cindy/im';

/** MCP 侧用到的 TelegramIM 子集(结构类型, 测试可用假对象)。 */
export type TelegramToolTransport = Pick<
  TelegramIM,
  | 'getBotApi'
  | 'getBotId'
  | 'getBotUsername'
  | 'resolveSendTarget'
  | 'recordOutboundEcho'
  | 'sendMedia'
  | 'downloadFile'
>;

export interface TelegramToolScope {
  channel: 'telegram';
  im: TelegramToolTransport;
  /** 连接 id(个人 bot 为 bot 数字 id; 伙伴连接为连接 id)。 */
  botId: string;
  /** lane userId(私聊数字 id 或 `g/{chatId}[/{threadId}]`), 出站目标由 transport 解码。 */
  laneUserId: string;
  /** Telegram 原生 chat id(私聊 = 对方 user id)。 */
  chatId: string;
  /** forum topic id; 非话题为空串。 */
  threadId: string;
  chatKind: 'direct' | 'group';
  /** 触发本轮的是不是主人(Main 校验过的身份, 不来自模型参数)。 */
  requesterIsOwner: boolean;
  /** 触发消息的原生 message_id(回复 / 表情的默认目标)。 */
  triggerMessageId: string;
  /** 伙伴自有连接(true)还是设置页个人 bot(false)。 */
  companion: boolean;
}

/** MCP 侧用到的 FeishuIM 子集(结构类型, 测试可用假对象); 与 @cindy/mcps 的 FeishuBotLaneTransport 对齐。 */
export type FeishuToolTransport = Pick<
  FeishuIM,
  | 'getService'
  | 'getBotAppId'
  | 'getOwnerOpenId'
  | 'sendText'
  | 'sendMarkdownText'
  | 'replyText'
  | 'replyMarkdownText'
  | 'sendFile'
  | 'reactToMessage'
  | 'removeMessageReaction'
  | 'getChatInfo'
  | 'listChatMembers'
  | 'getMessage'
  | 'pinMessage'
  | 'unpinMessage'
  | 'recallMessage'
  | 'callApi'
>;

export interface FeishuToolScope {
  channel: 'feishu';
  im: FeishuToolTransport;
  /** 连接 id(个人 bot 为 app_id; 伙伴连接为连接 id)。 */
  botId: string;
  /** lane userId(私聊 open_id 或 `g/{chatId}[/{threadId}]`), 出站目标由 transport 解码。 */
  laneUserId: string;
  /** 飞书原生 chat_id(私聊是 p2p chat)。 */
  chatId: string;
  /** 话题 id; 非话题为空串。 */
  threadId: string;
  chatKind: 'direct' | 'group';
  requesterIsOwner: boolean;
  /** 触发消息的 message_id(om_ 开头; 回复 / 表情 / 置顶的默认目标)。 */
  triggerMessageId: string;
  companion: boolean;
}

/**
 * 企业微信 / 钉钉 / Discord 伙伴专线轮次的作用域:没有渠道直通工具,不带 transport,只回答
 * 「当前在哪个对话、这一轮是不是主人触发」(伙伴技能读写按它授权)。
 */
export interface LaneTurnScope {
  channel: 'wecom' | 'dingtalk' | 'discord';
  /** 连接的 botContextId。 */
  botId: string;
  laneUserId: string;
  chatId: string;
  chatKind: 'direct' | 'group';
  /** 触发本轮的是不是主人(与本轮权限策略同一判定, 不来自模型参数)。 */
  requesterIsOwner: boolean;
  companion: true;
}

export type LaneTurnScopeChannel = LaneTurnScope['channel'];

export function isLaneTurnScopeChannel(channel: string): channel is LaneTurnScopeChannel {
  return channel === 'wecom' || channel === 'dingtalk' || channel === 'discord';
}

export type ChannelToolScope = TelegramToolScope | FeishuToolScope | LaneTurnScope;

interface ActiveScope {
  sessionInstanceId: string;
  token: symbol;
  scope: ChannelToolScope;
}

const activeBySession = new Map<string, ActiveScope>();

export function beginChannelToolScope(args: {
  sessionId: string;
  sessionInstanceId: string;
  scope: ChannelToolScope;
}): () => void {
  if (!args.sessionId) throw new Error('channel tool scope sessionId is required');
  if (!args.sessionInstanceId) throw new Error('channel tool scope sessionInstanceId is required');
  if (!args.scope.chatId.trim()) throw new Error('channel tool scope chatId is required');
  const token = Symbol('channel-tool-scope');
  activeBySession.set(args.sessionId, {
    sessionInstanceId: args.sessionInstanceId,
    token,
    scope: args.scope,
  });
  return () => {
    const active = activeBySession.get(args.sessionId);
    if (active?.token === token) activeBySession.delete(args.sessionId);
  };
}

export function readChannelToolScope(args: {
  sessionId?: string;
  sessionInstanceId?: string;
}): ChannelToolScope | null {
  if (!args.sessionId || !args.sessionInstanceId) return null;
  const active = activeBySession.get(args.sessionId);
  if (!active || active.sessionInstanceId !== args.sessionInstanceId) return null;
  return active.scope;
}

/** 测试/进程级 teardown;生产授权仍必须通过租约 release 收口。 */
export function resetChannelToolScopeForTests(): void {
  activeBySession.clear();
}
