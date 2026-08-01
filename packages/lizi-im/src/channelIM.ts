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
    opts?: { threadTs?: string },
  ): Promise<{ messageId: string }>;

  /** 渲染 markdown 的文本消息(粗体 / 行内 code / 链接等)。 */
  sendMarkdownText(
    userId: string,
    markdown: string,
    opts?: { threadTs?: string },
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
    opts?: { threadTs?: string },
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

  /**
   * 从出站消息的 messageId 提取 thread 维度键(= 该消息作为 thread root 时的
   * thread_ts)。thread 能力渠道(slack)实现;编排层用它把"刚发出的接管卡"
   * 变成 thread root 的 scopeKey, 而不泄漏渠道 messageId 编码格式。
   */
  threadKeyForMessage?(messageId: string): string;
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
