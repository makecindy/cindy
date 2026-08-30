/**
 * ChannelIM — 渠道无关的 IM 能力契约。
 * ---------------------------------------------------------------------------
 * host 侧业务编排层(消息路由 / slash 命令 / agent turn / 卡片交互)只依赖这
 * 个接口, 不依赖任何具体渠道类 — 同一套编排逻辑可挂 FeishuIM / SlackIM。
 *
 * 与 BaseIM 的关系: BaseIM 管 lifecycle(init / dispose / registerIpc),
 * ChannelIM 管收发能力。具体渠道类同时满足两者:
 *   class FeishuIM extends BaseIM implements ChannelIM
 *
 * 标识语义(per channel):
 *   - userId: feishu = open_id; slack = user id (Uxxxx)
 *   - messageId: feishu = message_id; slack = "{channelId}|{ts}" 编码
 *
 * 可选能力(渠道不支持就不实现, 编排层用 `im.reactToMessage?.()` 探测):
 *   - reactToMessage / removeMessageReaction: emoji 回应 ack
 */

import type {
  IMCardActionEvent,
  IMFinalReplyMirror,
  IMMessageEvent,
  IMStatus,
  InteractiveCardSpec,
  SendFileResult,
  StreamingTextHandle,
} from './types.js';

export interface TextChannelIM {
  /** 渠道名 ('feishu' / 'slack') — 与 IdentityKey.channel 同值域。 */
  readonly name: string;

  // ── inbound subscriptions ──────────────────────────────────────────────────

  onMessage(handler: (e: IMMessageEvent) => void): () => void;
  onStatusChange(handler: (s: IMStatus) => void): () => void;

  // ── outbound ───────────────────────────────────────────────────────────────
  // 末位 opts.threadTs: thread 能力渠道(slack)把消息发进指定 thread;
  // 无 thread 概念的渠道(feishu)的实现可省略该参数(结构类型兼容), 调用方
  // 传了也只是被忽略。

  /** 纯文本消息(不渲染 markdown 标记)。 */
  sendText(
    userId: string,
    text: string,
    opts?: { threadTs?: string; fallbackOpenerId?: string },
  ): Promise<{ messageId: string }>;

  /** 渲染 markdown 的文本消息(粗体 / 行内 code / 链接等)。 */
  sendMarkdownText(
    userId: string,
    markdown: string,
    opts?: { threadTs?: string; fallbackOpenerId?: string },
  ): Promise<{ messageId: string }>;

  /** 发送本地文件;失败原因见 SendFileResult.reason。 */
  sendFile(
    userId: string,
    absPath: string,
    displayName?: string,
    opts?: { threadTs?: string },
  ): Promise<SendFileResult>;

  // ── optional capabilities ──────────────────────────────────────────────────

  /**
   * 给某条消息加 emoji 回应("已收到" ack)。返回撤销用的 token
   * (feishu: reaction_id; slack: emoji 名), 失败返回 null。
   */
  reactToMessage?(messageId: string, emoji: string): Promise<string | null>;

  /** 撤销 reactToMessage 加的回应;失败吞掉(清理是尽力而为)。 */
  removeMessageReaction?(messageId: string, reactionToken: string): Promise<void>;

  // ── status ─────────────────────────────────────────────────────────────────

  getStatus(): IMStatus;
}

/** Channels that can render and mutate interactive/streaming cards. */
export interface RichChannelIM extends TextChannelIM {
  onCardAction(handler: (e: IMCardActionEvent) => void): () => void;

  /** 带按钮的交互卡片;按钮按压经 onCardAction 回流。 */
  sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
    opts?: {
      threadTs?: string;
      /** 原兜底发送认领本轮暂存 opener, 后续发送不要传。 */
      fallbackOpenerId?: string;
      /**
       * **只有授权类(permission)卡片**可以传 true: 群 lane 里把卡片改投宿主私聊 ——
       * 群里的授权卡消不掉, 而且只有宿主本人能回答它。
       *
       * 命令卡 / 会话选择卡(`/ctr` 等)**绝不能传**: 它们的回调要落在原群 lane
       * (exitControl 释放的是那把群锁), 投到私聊会让锁与卡片对不上。
       * 渠道不支持该语义时忽略即可(按原 lane 投递), 不要吞掉卡片。
       */
      deliverToOwnerDm?: boolean;
      /**
       * `deliverToOwnerDm` 生效时加在卡片正文顶部的说明。**用户可见文案由调用方给**,
       * 传输层不造文案(它没有 locale, 也不该持有产品措辞)。
       */
      ownerDmNote?: string;
      /**
       * 触发本轮的那条渠道消息 id(本接口的 messageId 形态)。`deliverToOwnerDm` 生效时
       * 用来拼「来源」深链 —— 宿主在私聊里收到的卡片否则看不出是哪个群、哪个问题。
       *
       * **必须由调用方给**: 只有它知道这张卡属于哪一轮业务 turn。传输层能看到的只有
       * 回挂状态与流式 handle 生命周期, 两者都不等于业务轮次 —— 回挂目标在
       * `replyQuoteGroup:'first'` 下发出首条回复就被消耗, 而发卡前调用方会主动收口
       * 流式 handle。不传则不渲染深链(不猜)。
       */
      ownerDmSourceMessageId?: string;
    },
  ): Promise<{ messageId: string }>;

  /** 原地替换一张已发出的交互卡片(spec 全量覆盖)。 */
  updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void>;

  /** 把已有卡片一次性 patch 成纯 markdown 内容(清掉按钮)。 */
  patchMarkdownCard(messageId: string, markdown: string): Promise<void>;

  /** 开启一条流式文本消息, 返回节流的增量更新 handle。 */
  startStreamingText(
    userId: string,
    initial?: string,
    opts?: { threadTs?: string },
  ): Promise<StreamingTextHandle>;

  /** Keep mirror confirmation alive while a turn is active or queued; returns its release hook. */
  retainFinalReplyMirror?(mirror: IMFinalReplyMirror): (() => void) | void;

  /** Best-effort terminal mirror when the primary rich surface could not be created. */
  mirrorFinalReply?(
    mirror: IMFinalReplyMirror,
    text: string,
    opts?: { mediaAbsPaths?: string[] },
  ): Promise<void>;

  /**
   * 从出站消息的 messageId 提取 thread 维度键(= 该消息作为 thread root 时的
   * thread_ts)。thread 能力渠道(slack)实现;编排层用它把"刚发出的接管卡"
   * 变成 thread root 的 scopeKey, 而不泄漏渠道 messageId 编码格式。
   */
  threadKeyForMessage?(messageId: string): string;

  /**
   * 群主流 @ 开话题的「思考中」开场白卡被非流式终态(!stop / 纯 unsupported
   * 等)截流时, 编排层用本方法消费: 认领该 lane 的 pending opener 并把 markdown
   * patch 上去(开场白卡就地变成回复, 替代另发一条), 返回 true; 无 pending
   * opener 返回 false, 调用方走正常发送。仅 feishu 实现。
   */
  consumePendingOpenerCard?(userId: string, markdown: string): Promise<boolean>;

  /**
   * 同上场景但终态内容是一张卡片(slash 的 /ctr picker、/model 选择卡等):
   * 认领 pending opener 并把卡片 spec 原地替换上去(开场白卡就地变成该卡),
   * 返回 true; 无 pending opener 返回 false, 调用方走正常发卡。仅 feishu
   * 实现。
   */
  consumePendingOpenerAsCard?(userId: string, spec: InteractiveCardSpec): Promise<boolean>;

  /**
   * 返回该 lane 上 pending opener 的触发消息 id(没有则返回 undefined)。
   * 调用方用它判断「这张思考卡是不是本轮消息创建的」— 空文本终态等场景下
   * 不应消费上一轮遗留的 opener。
   */
  getPendingOpenerTrigger?(userId: string): string | undefined;

  /**
   * consume 在空窗暂存后, 原兜底发送领取本轮 openerId, 再经 send* 的
   * fallbackOpenerId 认领排空结果。后续发送不要调用, 否则会领走别人的轮次。
   */
  takeNotedFallbackOpenerId?(userId: string, kind: 'markdown' | 'spec'): string | undefined;
}

/** Backward-compatible name for the existing rich-card channel contract. */
export type ChannelIM = RichChannelIM;

export interface ImFinalOutput {
  userId: string;
  text: string;
  terminal: 'done' | 'aborted' | 'error';
  threadTs?: string;
  errorCode?: string;
  /** Managed local media discovered in the terminal assistant output. */
  mediaAbsPaths?: string[];
  /** Host-approved roots for model-authored local file attachment links. */
  allowedFileRoots?: string[];
}

/**
 * Output is deliberately discriminated: rich channels may stream/patch,
 * while durable text channels atomically commit the complete terminal output.
 */
export type ImOutputDriver =
  | {
      kind: 'rich-card';
      im: RichChannelIM;
    }
  | {
      kind: 'chunked-text';
      im: TextChannelIM;
      /**
       * Reserve an inbound reply context before a potentially long turn.
       * Transports with callback deadlines may emit a non-terminal placeholder.
       */
      beginReply?(userId: string): Promise<void>;
      commitFinal(output: ImFinalOutput): Promise<void>;
    };
