import type { IMAttachment, IMMessageEvent } from "@cindy/im";
import type { TurnPermissionPolicy } from "@cindy/maker-core";
import type {
  ImContextSnapshot,
  ImMessageOrigin,
} from "@cindy/companion-core/imMessageSource";
import type { ImChannelNoteSource } from "./channelNote";
import type { GroupHistoryAccessScope } from "./groupHistoryAccess";
import type { ChannelToolScope } from "./channelToolScope";

export interface ImRunAgentTurnArgs {
  sourceDescription?: string;
  /**
   * 本条消息的渠道来源事实。turnRunner 按 adapter 的展示渠道（飞书 / Lark …）
   * 拼成 `[渠道说明]` 一行, 只进模型正文；落库、rawChannelText、imSource 不变。
   */
  channelNoteSource?: ImChannelNoteSource;
  contextSnapshot?: ImContextSnapshot;
  /** 谁、在哪说的 —— 与 channelNoteSource 同源, 存进落库消息的 imSource 供界面区分发言人。 */
  messageOrigin?: ImMessageOrigin;
  /** Main-owned, resolved from an authenticated provider notification receipt. */
  notificationSessionId?: string;
  revalidateNotificationReply?: () => Promise<void>;
  botContextId: string;
  userId: string;
  /** 渠道 message id of the user's incoming message — used for emoji ack. */
  userMessageId: string;
  text: string;
  attachments: IMAttachment[];
  /**
   * 渠道 adapter 给出的被回复消息(IMMessageEvent.replyContext)。只用于 Auto 审阅的
   * 引用证据(见 imAutoReviewReferences), 不改模型正文与落库。
   */
  replyContext?: IMMessageEvent["replyContext"];
  /** thread = session 模型的会话维度键(slack);feishu 不传。 */
  scopeKey?: string;
  /**
   * 发给 agent 的正文覆盖(群上下文前缀拼装, 见 adapter.prepareAgentTurnText)。
   * 缺省 = text。落库(persistUserMessage)与标题生成恒用 text(渠道原文)。
   */
  agentText?: string;
  /**
   * 上下文附件(群历史里的图片/文件) —— 只拼进模型消息的 image/file
   * block, **不随用户消息落库、不进 transcript**。与 attachments(触发
   * 用户自己发的, 照常落库)是两条语义边界, 不可合并传参。
   */
  contextAttachments?: IMAttachment[];
  outputCardMessageId?: string;
  outputCardPrefix?: string;
  onTurnComplete?: () => void;
  /** Reports the concrete session only after the provider accepts this message. */
  onRouteResolved?: (sessionId: string) => void | Promise<void>;
  /** Keep fire-and-forget work inside the ingress account's drain boundary. */
  trackBackgroundTask?: (operation: () => Promise<void>) => void;
  /** Optional per-turn host policy (personal WeChat routes confirmations to Desktop). */
  turnPermissionPolicy?: TurnPermissionPolicy;
  /** Opt in to native permissions only for a resolved companion route and verified owner. */
  inheritCompanionOwnerPermissions?: boolean;
  /**
   * The triggering message passed the channel's owner check (DM owner gate or
   * group speaker.isOwner). Only this unlocks owner-only Host actions; omitted = not owner.
   */
  requesterIsOwner?: boolean;
  /**
   * 这一轮的触发消息来自「禁止保存内容」的群。
   *
   * turn 照常跑 —— 用户 @ 机器人说的话是他此刻要说给 bot 的。但正文与附件
   * **不写进会话存档**: 群历史池已在渠道侧拦下, 存档不能成为绕过保护边界的
   * 第二条路径。缺省 = 未受保护(只有 Telegram 群会置它)。
   */
  protectedContent?: boolean;
  groupHistoryAccess?: GroupHistoryAccessScope;
  channelToolScope?: ChannelToolScope;
  /**
   * 调用方已经打好的「已收到」表情句柄 —— 传了就由本 turn 接管(不再重复打),
   * turn 收口时照常撤掉/换成结果表情。
   *
   * 给 messageHandler 用: 群上下文拼装(回翻群历史, 可能翻页并调轻量模型)排在
   * runAgentTurn **之前**, 慢的时候用户几十秒看不到任何反应, 会以为 bot 挂了。
   * 由调用方在拼装前先打表情、把句柄交进来, 反馈就不再被拼装时间挡住。
   * 缺省(undefined)= turn 自己打, 与老行为一致。
   */
  ackReactionIdPromise?: Promise<string | null> | null;
  /**
   * 调用方已经**提前落库**的用户消息(见 persistInboundUserMessageEarly)。
   *
   * 带上它, dispatch 时就不再重复写一条 user 行, 只把 turn 的 changeset 锚到
   * 这条已有记录上。sessionId 必须一起带 —— 提前落库与真正 dispatch 之间隔着
   * 群上下文拼装(实测 15~60s), 期间路由可能已经改到另一个 session(如 /new
   * 重置), 那时这份预落库对不上号, dispatch 必须照常自己落一条。
   */
  prePersistedUserMessage?: { sessionId: string; clientId: string };
  /**
   * 早期拒绝终态(missing_auth / credential_mode_switch 等正常 resolve 的
   * reject/busy)回调 — turnRunner 把本要另发的终态文案交给调用方: 返回
   * true 表示已消费(如群主流 @ 开话题时 patch 开场白卡), turnRunner 跳过
   * 自己的发送; false/缺省则照常发送。
   */
  onEarlyReject?(reason: string, text: string): Promise<boolean> | boolean;
}
export interface ImMessageTurnRunner {
  runAgentTurn(args: ImRunAgentTurnArgs): Promise<void>;

  /**
   * 把渠道用户消息**提前**写进本地 messages 表 —— 只给「dispatch 之前还有重活」
   * 的渠道用(群上下文拼装: 回翻群历史 + 轻量模型扫描, 实测 15~60s)。
   *
   * 用户消息平时是在 provider 受理那一刻才落库(见 dispatchQueuedSend 的
   * onAccepted 注释), 于是这段重活期间桌面端根本看不到"消息已经收到";
   * 用户会以为消息丢了。这里在重活开始前先落一条, 并把 clientId 交回调用方,
   * 由它透传给 runAgentTurn(prePersistedUserMessage), dispatch 就不再重复写。
   *
   * **只在这条会话此刻完全空闲时才落**(没有 turn 在跑、没有排队消息) ——
   * 忙的时候提前落会把新提问排在上一轮回答之前, 正是 onAccepted 注释里要
   * 避免的顺序错乱。忙 / 新会话(行还没建)/ 受保护内容 ⇒ 返回 null,
   * 完全退回原行为。
   */
  persistInboundUserMessageEarly?: (args: {
    botContextId: string;
    userId: string;
    scopeKey?: string;
    text: string;
    attachments?: readonly IMAttachment[];
    protectedContent?: boolean;
    messageOrigin?: ImMessageOrigin;
  }) => Promise<{ sessionId: string; clientId: string } | null>;

  /**
   * 连接已交给的伙伴 id(本渠道支持交给伙伴且有归属记录时); 否则 null。
   * 只读归属记录, 不解析伙伴是否可用。
   */
  companionBotIdFor?(botContextId: string): string | null;

  /**
   * `!stop` 控制指令入口: 中止该路由 (bot, user[, scopeKey]) 对应 session 上
   * 正在跑的 turn, 并丢弃 sendQueue 里尚未派发的排队消息 — 不清队的话, abort
   * 触发的 done/error 会立刻把下一条排队消息派发出去, 违背"停下来等新指令"
   * 的语义。session 本身保持 active, 用户可继续发新消息。
   * 返回 stopped=false 表示该路由当前没有任何在跑/排队的任务(轻提示场景);
   * 该路径绝不新建 session 行。
   */
  stopActiveTurn(args: {
    notificationSessionId?: string;
    botContextId: string;
    userId: string;
    scopeKey?: string;
  }): Promise<{ stopped: boolean; droppedQueued: number }>;
}
