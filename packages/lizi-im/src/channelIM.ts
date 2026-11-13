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
  // opts.threadTs identifies the reply root: Slack timestamp or Feishu private-topic root message id.
  // Unsupported channels may omit it; Feishu group lanes retain their existing lane anchors.

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

  /** 撤销回应；失败抛出供状态切换保留 token，终态调用方负责尽力清理。 */
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
  /**
   * 宿主已解析并校验过的本机普通文件（绝对路径，realpath 落在 allowedFileRoots 内）。
   *
   * 回答里的**相对路径/绝对路径链接**由 runner 在工作目录下解析后放这里；渠道把它
   * 当成文件附件投递，不要求模型改用 `xdt-file://`。PDF/docx 等非媒体走文件通道，
   * 不进媒体总仓。
   */
  fileAbsPaths?: string[];
  /** Host-approved roots for model-authored local file attachment links. */
  allowedFileRoots?: string[];
  /**
   * 稳定的一轮标识(由共享 runner 生成)。用于两件事:
   *  - 过程反馈面只认自己那一轮, 旧轮迟到的进度不能写进新一轮;
   *  - 持久出箱以它为幂等键 —— 同一轮重复 finalize / 重试不会生成第二条出箱记录。
   * 可选: 未提供的渠道保持原有行为(不产生逐轮身份)。
   */
  turnId?: string;
}

/**
 * 公开过程反馈视图。**只允许公开信息** —— 阶段摘要不得包含思考内容、工具名或
 * 工具参数(这些都是任务内部实现, 不是用户可公开的进度)。body 是这一轮已经
 * 产出的回答正文快照。
 */
export interface ImProgressView {
  /** 一行公开阶段摘要; 空串表示本轮还没有值得展示的进展。 */
  stage: string;
  /** 公开回答正文的当前快照(可为空)。 */
  body: string;
}

/**
 * chunked-text 渠道的可选过程反馈面，目前由企业微信接入。
 *
 * 生命周期由共享 runner 持有, 一轮一个:
 *  - `replace` 只在轮次进行中调用, 实现自己节流(事件密集时不能每条事件发一次);
 *  - `close` 表示终稿马上交付, 之后任何迟到的 `replace` 都必须被丢弃, 不允许
 *    覆盖终稿;
 *  - `settle`(可选)让过程面收敛到终态, 实现可以据此撤掉"处理中"的显示。
 */
export interface ImProgressHandle {
  /** 这一轮的身份; 与 ImFinalOutput.turnId 同值。 */
  readonly turnId?: string;
  replace(view: ImProgressView): void;
  close(): Promise<void>;
  settle?(result: { delivered: boolean; terminal: ImFinalOutput['terminal'] }): Promise<void>;
}

/** 一次投递尝试的结果。uncertain = 已发起但拿不到平台接受证据, 不得盲目重发。 */
export type ImDeliveryState = 'sent' | 'uncertain' | 'failed';

/** 终稿里需要单独投递、单独记录结果的一个出站副作用。 */
export interface ImFinalStepBase {
  /** 稳定步骤 id(计划内唯一), 持久出箱靠它记录“哪些已确认成功”。 */
  id: string;
  /** 受控文件通道的普通文件 / 媒体总仓的图片音视频 / 外部图片链接 / 正文。 */
  kind: 'media' | 'file' | 'text' | 'remote';
}

export interface ImFinalTextStep extends ImFinalStepBase {
  kind: 'text';
  /** 一段正文(已按渠道上限切好); 一步就是一条消息。 */
  text: string;
}

export interface ImFinalAttachmentStep extends ImFinalStepBase {
  /** media = 媒体总仓里的图片/音视频; file = 受控文件通道里的普通文件。 */
  kind: 'media' | 'file';
  absPath: string;
  displayName: string;
  /** host 媒体总仓地址(cindy-media://), 有则在重放时优先按它重新解析。 */
  url?: string;
}

/**
 * 正文里的外部图片链接(模型自己写的 markdown 图)。它也要有独立账目 ——
 * 否则正文重试会把同一张图再发一次。
 */
export interface ImFinalRemoteStep extends ImFinalStepBase {
  kind: 'remote';
  url: string;
  displayName: string;
}

export type ImFinalStep =
  | ImFinalTextStep
  | ImFinalAttachmentStep
  | ImFinalRemoteStep;

/** 终稿的可重放投递计划: 每一个出站副作用一个步骤, 顺序即发送顺序。 */
export interface ImFinalDeliveryPlan {
  steps: ImFinalStep[];
}

export interface ImFinalDeliveryResult {
  /** 与 plan.steps 一一对应; undefined = 本轮没有尝试该项。 */
  states: Array<ImDeliveryState | undefined>;
}

/**
 * 一次终稿交付的**真实边界**。渠道必须如实回答这三件事, 因为它决定了用户看到的是
   * “已送达”、“已受理但未全部确认” 还是 “未完整送达且无持久保障”。
 */
export interface ImFinalCommitOutcome {
  /**
   * sent = 本轮已确认全部送达; durable = 已被持久出箱受理但仍有未确认步骤;
   * failed = 未完整送达且无持久补发保障(部分步骤可能已经送达)。
   */
  status: 'sent' | 'durable' | 'failed';
  /** 仍未确认送达的步骤数。 */
  unresolved: number;
  /** 其中会自动重试的数量(其余为结果不明, 不会重发)。 */
  retrying: number;
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
       *
       * 返回过程反馈面(可选): 支持进度反馈的渠道(例如企业微信流式消息)
       * 在这里拿到属于本轮的过程面; 返回 null 表示本轮没有过程面。
       */
      beginReply?(
        userId: string,
        opts?: { turnId?: string },
      ): Promise<ImProgressHandle | null | void>;
      commitFinal(output: ImFinalOutput): Promise<ImFinalCommitOutcome | void>;
      /**
       * 可选: 把终稿拆成「正文 + 逐项附件」的可重放计划。宿主据此建立持久出箱,
       * 逐项记录发送结果、只补失败项。缺省 = 该渠道不支持分项, 宿主持久化正文。
       */
      prepareFinal?(output: ImFinalOutput): Promise<ImFinalDeliveryPlan>;
      /**
       * 可选: 按计划逐步投递。`onlySteps` 只重试这些步骤 id(已确认成功的项
       * 不重发); 缺省 = 全部还没确认成功的步骤。
       */
      deliverFinal?(
        output: ImFinalOutput,
        plan: ImFinalDeliveryPlan,
        opts?: { onlySteps?: string[] },
      ): Promise<ImFinalDeliveryResult>;
    };
