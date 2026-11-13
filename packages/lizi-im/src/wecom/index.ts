import { randomUUID } from "node:crypto";

import {
  WSClient,
  type BaseMessage,
  type EventMessage,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type TextMessage,
  type VideoMessage,
  type VoiceMessage,
  type WSClientOptions,
  type WsFrame,
} from "@wecom/aibot-node-sdk";

import { classifyInboundAttachment } from "../inboundKind.js";
import { BaseIM } from "../BaseIM.js";
import type {
  ImFinalCommitOutcome,
  ImFinalDeliveryPlan,
  ImFinalDeliveryResult,
  ImFinalOutput,
  ImProgressHandle,
  TextChannelIM,
} from "../channelIM.js";
import type { Logger } from "../logger.js";
import type {
  IMAttachment,
  IMCardActionEvent,
  IMHost,
  IMMessageEvent,
  IMStatus,
  IMUnsupportedEntry,
  InteractiveCardSpec,
  SendFileResult,
} from "../types.js";
import {
  collectXdtFileLinks,
  collectXdtImageUrls,
  stripXdtFileLinks,
  stripXdtImageLinks,
} from "../xdtRefs.js";
import {
  buildWecomTemplateCard,
  parseTemplateCardEvent,
  type WecomLiveCard,
} from "./cards.js";
import {
  chunkWecomMarkdown,
  decodeWecomLane,
  encodeWecomGroupLane,
  escapeWecomMarkdown,
} from "./codec.js";
import { deliverWecomFinal, prepareWecomFinal } from "./finalDelivery.js";
import {
  MAX_MEDIA_BYTES,
  mimeTypeForFilename,
  stageWecomDownload,
  readWecomOutboundFile,
  resolveAllowedWecomOutboundFile,
  safeWecomFilename,
} from "./media.js";
import { createWecomProgress, WECOM_STREAM_PROGRESS_WINDOW_MS } from "./progress.js";

const BOT_ID_SECRET_KEY = "wecom-bot-id";
const BOT_SECRET_SECRET_KEY = "wecom-bot-secret";
const OWNER_USER_ID_SECRET_KEY = "wecom-owner-user-id";
const CALLBACK_TTL_MS = 4 * 60_000;
const CALLBACK_QUEUE_CAPACITY = 64;
const STREAM_SAFE_TIMEOUT_MS = WECOM_STREAM_PROGRESS_WINDOW_MS;
const DEDUPE_CAPACITY = 2_048;
const MAX_TERMINAL_ATTACHMENTS = 4;
const SECRET_WRITE_FAILED_REASON = "无法使用系统安全存储保存企业微信机器人凭证";
const NO_ACCOUNT_SCOPE = Symbol("no-account-scope");

type StagedImage = {
  attachment: IMAttachment;
  discard?: () => Promise<void>;
};

type MessageHandler = (event: IMMessageEvent) => void;
type StatusHandler = (status: IMStatus) => void;
type TextInterceptor = (event: IMMessageEvent) => boolean;
type WecomFrame = WsFrame<BaseMessage>;

interface PendingFrame {
  frame: WecomFrame;
  receivedAt: number;
}

interface PendingResponse {
  frame: WecomFrame | null;
  streamId: string;
  startedAt: number;
  passiveStarted: boolean;
  /** 终稿已交付(或本轮收口): 之后任何迟到的进度帧都必须丢弃。 */
  closed: boolean;
  /** 属于哪一轮: 终稿按它精确领取回调窗口, 不能按 FIFO 偷别人的。 */
  turnId?: string;
}

/** 确认卡的生命周期上限, 与文字交互的等待上限无关(卡片只等点击)。 */
const CARD_TTL_MS = 30 * 60_000;

export interface WecomIMOptions {
  clientFactory?: (options: WSClientOptions) => WSClient;
  now?: () => number;
  /**
   * 凭证在 host.secrets 里的键名前缀。缺省为空 = 设置页那份个人 bot 的历史键名;
   * 伙伴自有连接各给一个前缀, 同一进程里多份实例互不读写对方的凭证。
   */
  secretKeyPrefix?: string;
  /**
   * 是否注册 `wecomBot:*` 设置卡 IPC 并广播状态(缺省 true)。通道名固定, 同进程
   * 第二份实例必须关掉, 由宿主自己的 IPC 按实例分发。
   */
  ipc?: boolean;
}

export interface WecomConfigState {
  status: IMStatus;
  botId: string | null;
  ownerUserId: string | null;
  saveErrorStatus?: IMStatus;
}

/** Enterprise WeChat transport with durable chunked-text output. */
/** 原生图片/视频消息的 MIME: 共用判据认出同类就用它, 否则按消息类型的默认容器。 */
function nativeMediaMime(fileName: string, kind: "image" | "av", fallback: string): string {
  const classified = classifyInboundAttachment(mimeTypeForFilename(fileName), fileName);
  return classified.kind === kind ? classified.mimeType : fallback;
}

export class WecomIM extends BaseIM implements TextChannelIM {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly textInterceptors = new Set<TextInterceptor>();
  private readonly pendingFrames = new Map<string, PendingFrame[]>();
  private readonly pendingResponses = new Map<string, PendingResponse[]>();
  private readonly inboundTails = new Map<string, Promise<void>>();
  private readonly seenMessageIds = new Set<string>();
  /** 已发出的确认卡(token → 语义值 / 点击帧)。 */
  private readonly liveCards = new Map<string, WecomLiveCard>();
  private readonly cardActionHandlers = new Set<(event: IMCardActionEvent) => void>();
  private readonly now: () => number;
  private client: WSClient | null = null;
  private status: IMStatus = { kind: "idle" };
  private botId = "";
  private ownerUserId = "";
  private lastAuthFailureReason = "";
  private generation = 0;
  private accountToken: unknown = NO_ACCOUNT_SCOPE;

  constructor(
    host: IMHost,
    private readonly options: WecomIMOptions = {},
  ) {
    super("wecom", host);
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    this.botId = this.host.secrets.read(this.key(BOT_ID_SECRET_KEY))?.trim() ?? "";
    this.ownerUserId =
      this.host.secrets.read(this.key(OWNER_USER_ID_SECRET_KEY))?.trim() ?? "";
    const secret = this.host.secrets.read(this.key(BOT_SECRET_SECRET_KEY))?.trim() ?? "";
    if (!this.botId || !secret) {
      this.setStatus({ kind: "idle" });
      return;
    }
    this.connect(this.botId, secret);
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.pendingFrames.clear();
    this.pendingResponses.clear();
    this.liveCards.clear();
    this.inboundTails.clear();
    this.seenMessageIds.clear();
    this.client?.disconnect();
    this.client = null;
    this.setStatus({ kind: "idle" });
  }

  /** 本实例的 secret 键名(见 WecomIMOptions.secretKeyPrefix)。 */
  private key(base: string): string {
    return `${this.options.secretKeyPrefix ?? ""}${base}`;
  }

  getConfigState(saveErrorStatus?: IMStatus): WecomConfigState {
    return {
      status: this.status,
      botId: this.botId || null,
      ownerUserId: this.ownerUserId || null,
      ...(saveErrorStatus ? { saveErrorStatus } : {}),
    };
  }

  /** TOFU 认定的主人(首个私聊发言人); 还没人私聊过时为空串。 */
  getOwnerUserId(): string {
    return this.ownerUserId;
  }

  /**
   * 直接认定主人(不等首个私聊): 宿主把设置页那份个人 bot 移给伙伴时带上原主人,
   * 避免 TOFU 在迁移后换人。写不进安全存储时返回 false, 内存态不变。
   */
  presetOwnerUserId(ownerUserId: string): boolean {
    const next = ownerUserId.trim();
    if (!next) return false;
    if (!this.host.secrets.write(this.key(OWNER_USER_ID_SECRET_KEY), next)) return false;
    this.ownerUserId = next;
    return true;
  }

  /**
   * 保存凭证并建连(设置卡与伙伴连接共用)。凭证写不进安全存储时回滚并返回
   * saveErrorStatus; 建连是异步的, 返回时 status 通常还是 connecting, 调用方按
   * onStatusChange 等终态。
   */
  async setConfig(payload: unknown): Promise<WecomConfigState> {
    const record = isRecord(payload) ? payload : {};
    const botId = typeof record.botId === "string" ? record.botId.trim() : "";
    const secret = typeof record.secret === "string" ? record.secret.trim() : "";
    if (!botId || !secret) {
      const failed: IMStatus = {
        kind: "error",
        reason: "Bot ID 和 Secret 不能为空",
      };
      this.setStatus(failed);
      return this.getConfigState(failed);
    }
    if (!this.host.secrets.isAvailable()) {
      const failed: IMStatus = {
        kind: "error",
        reason: SECRET_WRITE_FAILED_REASON,
      };
      this.setStatus(failed);
      return this.getConfigState(failed);
    }

    const previousBotId = this.host.secrets.read(this.key(BOT_ID_SECRET_KEY));
    const previousSecret = this.host.secrets.read(this.key(BOT_SECRET_SECRET_KEY));
    const previousOwner = this.host.secrets.read(this.key(OWNER_USER_ID_SECRET_KEY));
    const botChanged = Boolean(
      previousBotId?.trim() && previousBotId.trim() !== botId,
    );
    const saved =
      this.host.secrets.write(this.key(BOT_ID_SECRET_KEY), botId) &&
      this.host.secrets.write(this.key(BOT_SECRET_SECRET_KEY), secret);
    if (!saved) {
      this.restoreSecret(this.key(BOT_ID_SECRET_KEY), previousBotId);
      this.restoreSecret(this.key(BOT_SECRET_SECRET_KEY), previousSecret);
      this.restoreSecret(this.key(OWNER_USER_ID_SECRET_KEY), previousOwner);
      const failed: IMStatus = {
        kind: "error",
        reason: SECRET_WRITE_FAILED_REASON,
      };
      this.setStatus(failed);
      return this.getConfigState(failed);
    }
    if (botChanged) {
      this.host.secrets.remove(this.key(OWNER_USER_ID_SECRET_KEY));
      this.ownerUserId = "";
    }
    this.botId = botId;
    this.connect(botId, secret);
    return this.getConfigState();
  }

  /** 断开并清掉本实例的全部凭证(含 TOFU 主人)。 */
  async clearCredentials(): Promise<WecomConfigState> {
    this.generation += 1;
    this.client?.disconnect();
    this.client = null;
    this.pendingFrames.clear();
    this.pendingResponses.clear();
    this.liveCards.clear();
    this.inboundTails.clear();
    this.seenMessageIds.clear();
    this.host.secrets.remove(this.key(BOT_ID_SECRET_KEY));
    this.host.secrets.remove(this.key(BOT_SECRET_SECRET_KEY));
    this.host.secrets.remove(this.key(OWNER_USER_ID_SECRET_KEY));
    this.botId = "";
    this.ownerUserId = "";
    this.setStatus({ kind: "idle" });
    return this.getConfigState();
  }

  registerIpc(): void {
    // 伙伴自有连接不注册设置卡 IPC: 通道名固定, 第二份实例会重复注册;
    // 它们由宿主的伙伴连接 IPC 按连接 id 分发到实例方法。
    if (this.options.ipc === false) return;
    const runAccountScoped = <T>(operation: () => Promise<T>): Promise<T> => {
      const accountScope = this.host.accountScope;
      if (!accountScope) return operation();
      const token = accountScope.capture();
      if (token === null) {
        return Promise.reject(
          new Error("[IM_NOT_READY] IM account is not active"),
        );
      }
      return accountScope.run(token, operation);
    };

    this.host.ipc.handle("wecomBot:get-status", () => this.getConfigState());
    this.host.ipc.handle("wecomBot:set-config", (payload) =>
      runAccountScoped(() => this.setConfig(payload)),
    );
    this.host.ipc.handle("wecomBot:reconnect", () =>
      runAccountScoped(async () => {
        const botId = this.host.secrets.read(this.key(BOT_ID_SECRET_KEY))?.trim() ?? "";
        const secret =
          this.host.secrets.read(this.key(BOT_SECRET_SECRET_KEY))?.trim() ?? "";
        if (botId && secret) this.connect(botId, secret);
        return this.getConfigState();
      }),
    );
    this.host.ipc.handle("wecomBot:disconnect", () =>
      runAccountScoped(() => this.clearCredentials()),
    );
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** 确认卡按钮点击(只认当前主人; 回调不需要等模型)。 */
  onCardAction(handler: (event: IMCardActionEvent) => void): () => void {
    this.cardActionHandlers.add(handler);
    return () => this.cardActionHandlers.delete(handler);
  }

  /** 企业微信智能机器人长连接支持模板卡片(无需额外模板配置)。 */
  get supportsTemplateCards(): boolean {
    return true;
  }

  /** 当前长连接是否可用(持久出箱据此区分“离线”与“投递失败”)。 */
  isConnected(): boolean {
    return Boolean(this.client?.isConnected);
  }

  onTextMessageIntercept(handler: TextInterceptor): () => void {
    this.textInterceptors.add(handler);
    return () => this.textInterceptors.delete(handler);
  }

  getStatus(): IMStatus {
    return this.status;
  }

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    const chunks = chunkWecomMarkdown(escapeWecomMarkdown(text));
    return this.sendChunks(userId, chunks);
  }

  async sendMarkdownText(
    userId: string,
    markdown: string,
    opts?: { threadTs?: string; fallbackOpenerId?: string; usePendingFrame?: boolean },
  ): Promise<{ messageId: string }> {
    return this.sendChunks(userId, chunkWecomMarkdown(markdown), opts?.usePendingFrame === false ? "none" : "newest");
  }

  async sendFile(
    userId: string,
    absPath: string,
    displayName?: string,
    opts?: { threadTs?: string; usePendingFrame?: boolean },
  ): Promise<SendFileResult> {
    let uploaded = false;
    try {
      const client = this.requireConnectedClient();
      const local = await readWecomOutboundFile(absPath, displayName);
      const result = await client.uploadMedia(local.buffer, {
        type: local.mediaType,
        filename: local.filename,
      });
      uploaded = true;
      const lane = decodeWecomLane(userId);
      const frame =
        opts?.usePendingFrame === false ? null : this.claimNewestFrame(userId);
      if (frame) {
        try {
          await client.replyMedia(frame, local.mediaType, result.media_id);
          return { ok: true, messageId: randomUUID() };
        } catch (error) {
          this.log.warn(
            "passive media reply failed; using active send",
            safeError(error),
          );
        }
      }
      await client.sendMediaMessage(
        lane.targetId,
        local.mediaType,
        result.media_id,
      );
      return { ok: true, messageId: randomUUID() };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "WECOM_FILE_NOT_FOUND") {
        return { ok: false, reason: "NOT_FOUND" };
      }
      if (code === "WECOM_FILE_EMPTY") return { ok: false, reason: "EMPTY" };
      if (code === "WECOM_FILE_TOO_LARGE")
        return { ok: false, reason: "TOO_LARGE" };
      if (error instanceof Error && error.message === "WECOM_NOT_CONNECTED") {
        // 一个字节也没发: 确定失败, 不是“结果不明”。
        return { ok: false, reason: "NOT_CONNECTED" };
      }
      this.log.warn("failed to send media", safeError(error));
      return { ok: false, reason: uploaded ? "SEND_FAIL" : "UPLOAD_FAIL" };
    }
  }

  /**
   * Preserve the callback reply window before the Agent starts. The final
   * response reuses this stream id; after the safe window it falls back to an
   * active markdown message.
   *
   * 返回这一轮的过程反馈面: 真正用同一个 streamId 原地刷新公开进度, 终稿
   * (`commitFinal`) 用 `finish=true` 收口同一消息。没有可用回调窗口时仍返回主动
   * 状态反馈面; 过期/失败不影响终稿走主动发送。
   */
  async beginReply(
    userId: string,
    opts?: { turnId?: string },
  ): Promise<ImProgressHandle | null> {
    const client = this.requireConnectedClient();
    const generation = this.generation;
    const response: PendingResponse = {
      frame: this.claimOldestFrame(userId),
      streamId: randomUUID(),
      startedAt: this.now(),
      passiveStarted: false,
      closed: false,
      ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    };
    this.enqueueResponse(userId, response);
    try {
      if (response.frame) {
        await client.replyStream(response.frame, response.streamId, " ", false);
        response.passiveStarted = true;
      }
    } catch (error) {
      this.log.warn(
        "failed to start passive stream; final reply will use active send",
        safeError(error),
      );
    }
    if (this.client !== client || this.generation !== generation) {
      response.closed = true;
      return null;
    }
    const frame = response.frame;
    const progressClient = client;
    return createWecomProgress({
      userId,
      ...(opts?.turnId ? { turnId: opts.turnId } : {}),
      streamId: response.streamId,
      now: this.now,
      // 排队太久导致回调过期、或占位发送失败时, 仍必须有主动状态反馈。
      streamStartedAt: response.passiveStarted ? response.startedAt : this.now() - WECOM_STREAM_PROGRESS_WINDOW_MS,
      finishStream: async (streamId, content) => {
        if (!frame || !response.passiveStarted) return;
        response.passiveStarted = false;
        await progressClient.replyStream(frame, streamId, content, true);
      },
      sendStatus: async (content) => {
        response.passiveStarted = false;
        await progressClient.sendMessage(decodeWecomLane(userId).targetId, {
          msgtype: "markdown", markdown: { content },
        });
      },
      shouldContinue: () =>
        !response.closed && this.isCurrent(progressClient, generation),
      replyStream: async (streamId, content) => {
        // 非阻塞版: 上一帧未 ack 时 SDK 直接跳过, 避免中间帧排队堆积。
        const sender =
          typeof progressClient.replyStreamNonBlocking === "function"
            ? progressClient.replyStreamNonBlocking.bind(progressClient)
            : progressClient.replyStream.bind(progressClient);
        if (!frame) throw new Error("WECOM_REPLY_WINDOW_UNAVAILABLE");
        await sender(frame, streamId, content, false);
      },
      log: this.log,
    });
  }

  /** cindy-media 地址 → 本机绝对路径(出箱补发时重新解析媒体)。 */
  resolveOutboundMediaUrl(url: string): string | null {
    return this.host.media?.resolveMediaUrl?.(url) ?? null;
  }

  /** 把终稿拆成「正文 + 逐项附件」的可重放计划(持久出箱用)。 */
  prepareFinal(output: ImFinalOutput): Promise<ImFinalDeliveryPlan> {
    return prepareWecomFinal(output, {
      resolveMediaUrl: (url) => this.resolveOutboundMediaUrl(url),
      log: this.log,
    });
  }

  /** 按计划逐项投递, 每一项返回独立结果。 */
  deliverFinal(
    output: ImFinalOutput,
    plan: ImFinalDeliveryPlan,
    opts?: { onlySteps?: string[] },
  ): Promise<ImFinalDeliveryResult> {
    return deliverWecomFinal(
      {
        userId: output.userId,
        isConnected: () => Boolean(this.client?.isConnected),
        sendTextChunk: (index, text) =>
          this.sendFinalChunk(output.userId, index, text, output.turnId),
        sendFile: (absPath, displayName) =>
          this.sendFile(output.userId, absPath, displayName, {
            usePendingFrame: false,
          }),
        log: this.log,
      },
      plan,
      opts,
    );
  }

  async commitFinal(output: ImFinalOutput): Promise<ImFinalCommitOutcome> {
    const plan = await this.prepareFinal(output);
    const result = await this.deliverFinal(output, plan);
    const unresolved = result.states.filter((state) => state !== "sent").length;
    const retrying = 0;
    const failed = plan.steps.filter(
      (step, index) => step.kind !== "text" && result.states[index] === "failed",
    ).length;
    if (failed > 0) {
      try {
        await this.sendChunks(
          output.userId,
          chunkWecomMarkdown(`⚠️ 有 ${failed} 个附件发送失败，请稍后重试。`),
          "none",
        );
      } catch {
        this.log.warn("failed to report terminal attachment delivery failure");
      }
    }
    // 这条路径没有持久出箱, 所以不能声称“稍后自动补发”。
    return { status: unresolved === 0 ? "sent" : "failed", unresolved, retrying };
  }

  // ── 确认卡 ────────────────────────────────────────────────────────────────

  /**
   * 发一张确认卡(模板卡片 button_interaction)。按钮点击只回流一个选择, 不唤醒
   * 模型; 无可用回调窗口时用主动发送把卡片推到会话里。
   */
  async sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
    options?: { onCardId?: (messageId: string) => void },
  ): Promise<{ messageId: string }> {
    const client = this.requireConnectedClient();
    if (!this.ownerUserId) throw new Error("WECOM_CARD_OWNER_REQUIRED");
    this.pruneCards();
    const lane = decodeWecomLane(userId);
    const taskId = `cindy-${randomUUID().replace(/-/g, "")}`.slice(0, 128);
    const cardId = randomUUID();
    const actions = new Map<string, { value: string; label: string }>();
    const buttons = spec.buttons.slice(0, 6).map((button) => {
      const token = randomUUID();
      actions.set(token, {
        value: typeof button.payload?.value === "string" ? button.payload.value : button.id,
        label: button.label,
      });
      return { token, label: button.label, ...(button.type ? { type: button.type } : {}) };
    });
    const card: WecomLiveCard = {
      id: cardId,
      lane: userId,
      taskId,
      title: spec.title ?? "Cindy",
      body: spec.body,
      actions,
      answered: false,
      createdAt: this.now(),
      expiresAt: this.now() + CARD_TTL_MS,
    };
    const templateCard = buildWecomTemplateCard({
      taskId,
      title: card.title,
      body: card.body,
      buttons,
    });
    // Register before IO: 点击事件可能比 HTTP 响应更早到。
    this.liveCards.set(cardId, card);
    // 在发 IO **之前**把确定身份交给调用方: 平台可能先把卡展示给主人, 点击帧先于
    // SDK 回执到达；业务据此在点击到达前绑定本请求。回调失败不阻断发卡。
    try {
      options?.onCardId?.(cardId);
    } catch {
      this.log.warn("wecom card id callback failed");
    }
    try {
      const frame = this.claimNewestFrame(userId);
      if (frame) {
        await client.replyTemplateCard(frame, templateCard);
      } else {
        await client.sendMessage(lane.targetId, {
          msgtype: "template_card",
          template_card: templateCard,
        });
      }
      return { messageId: cardId };
    } catch (error) {
      this.liveCards.delete(cardId);
      throw error;
    }
  }

  /**
   * 作废一张确认卡。
   *
   * **只做本地失效, 不调用平台更新**: 平台要求 `update_template_card` 带完整合法的
   * 卡片结构 —— 空按钮的 `button_interaction` 被拒(40016), 无跳转的 `text_notice`
   * 也被拒(42045 `card_action Missing or Invalid`, 官方社区确认该卡型更新只接受
   * 跳转 1/2)。我们不编造跳转、不伪造点击帧, 也不试其它卡型, 因此远端按钮可能短暂
   * 仍可见; 但卡片已移出活卡表, 迟到/重复点击不会再产成交互事件, 结果由调用方另发
   * 文字告知。
   *
   * 仍然接受 `spec.buttons` 非空的调用(用于将来拿到合规结构时更新); 当前没有调用方
   * 走这条路径, 因此也不会产生无效网络请求。
   */
  async updateInteractiveCard(
    messageId: string,
    spec: InteractiveCardSpec,
  ): Promise<void> {
    const card = this.liveCards.get(messageId);
    if (!card) return;
    if (!spec.buttons.length) {
      // 本地失效: 撤 token、标已答、移出活卡。此后点击一律忽略。
      card.actions.clear();
      card.answered = true;
      this.liveCards.delete(messageId);
      return;
    }
    // 有按钮的原地更新暂时没有生产用途, 也不猜平台结构: 保持卡片原样。
    void spec;
  }

  private pruneCards(): void {
    const now = this.now();
    for (const [id, card] of this.liveCards) {
      if (card.expiresAt <= now) this.liveCards.delete(id);
    }
  }

  /** 模板卡片点击: 只接受当前主人, 且必须命中未过期的活卡片 token。 */
  private acceptTemplateCardEvent(
    frame: WsFrame<EventMessage>,
    client: WSClient,
    generation: number,
  ): void {
    if (!this.isCurrent(client, generation)) return;
    const parsed = parseTemplateCardEvent(frame.body);
    if (!parsed) return;
    const sender = frame.body?.from?.userid?.trim() ?? "";
    if (!this.ownerUserId || sender !== this.ownerUserId) return;
    this.pruneCards();
    const card = [...this.liveCards.values()].find((item) => item.taskId === parsed.taskId);
    if (!card) return;
    const action = card.actions.get(parsed.eventKey);
    if (!action) return;
    if (card.answered) {
      // 重复点击: 卡片早已本地作废, 不再提交第二份选择。
      return;
    }
    card.answered = true;
    card.actions.clear();
    const lane = card.lane;
    const event: IMCardActionEvent = {
      channelName: this.name,
      senderId: lane,
      chatId: frame.body?.chatid || sender,
      messageId: card.id,
      buttonId: parsed.eventKey,
      payload: { value: action.value, label: action.label },
    };
    // 先把卡片本地作废再交给业务层: 回执不等待任何模型; 不调用平台更新。
    this.liveCards.delete(card.id);
    for (const handler of this.cardActionHandlers) {
      try {
        handler(event);
      } catch {
        this.log.warn("wecom card action handler failed");
      }
    }
  }

  private connect(botId: string, secret: string): void {
    const generation = (this.generation += 1);
    this.accountToken = this.host.accountScope
      ? this.host.accountScope.capture()
      : NO_ACCOUNT_SCOPE;
    this.client?.disconnect();
    this.pendingFrames.clear();
    this.pendingResponses.clear();
    this.lastAuthFailureReason = "";
    this.setStatus({ kind: "connecting" });

    const clientFactory =
      this.options.clientFactory ?? ((options) => new WSClient(options));
    const client = clientFactory({
      botId,
      secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
      logger: createSdkLogger(this.log, botId, secret),
    });
    this.client = client;
    let serverConflict = false;

    client.on("authenticated", () => {
      if (!this.isCurrent(client, generation)) return;
      serverConflict = false;
      this.lastAuthFailureReason = "";
      this.setStatus({ kind: "connected", appId: botId });
    });
    client.on("reconnecting", () => {
      if (!this.isCurrent(client, generation)) return;
      this.setStatus({ kind: "connecting" });
    });
    client.on("disconnected", (reason) => {
      if (!this.isCurrent(client, generation)) return;
      this.log.warn("connection disconnected", sanitizeReason(reason));
      if (serverConflict) return;
      this.setStatus({ kind: "connecting" });
    });
    client.on("error", (error) => {
      if (!this.isCurrent(client, generation)) return;
      this.log.warn("connection error", safeError(error));
      const code = errorCode(error);
      if (/^Authentication failed:/iu.test(error.message)) {
        this.lastAuthFailureReason = formatAuthFailureReason(error.message);
      }
      this.setStatus({
        kind: "error",
        reason:
          code === "WS_AUTH_FAILURE_EXHAUSTED"
            ? this.lastAuthFailureReason || "企业微信鉴权失败，请检查 Bot ID、Secret 和长连接模式"
            : this.lastAuthFailureReason || sanitizeReason(error.message),
      });
    });
    client.on("event.disconnected_event", () => {
      if (!this.isCurrent(client, generation)) return;
      serverConflict = true;
      this.setStatus({ kind: "conflict", appId: botId });
    });
    client.on("event.template_card_event", (frame) => {
      try {
        this.acceptTemplateCardEvent(frame, client, generation);
      } catch (error) {
        this.log.warn("wecom card callback handler failed", safeError(error));
      }
    });
    client.on("message.text", (frame) =>
      this.queueInbound(frame, () =>
        this.processText(frame, client, generation),
      ),
    );
    client.on("message.image", (frame) =>
      this.queueInbound(frame, () =>
        this.processImage(frame, client, generation),
      ),
    );
    client.on("message.mixed", (frame) =>
      this.queueInbound(frame, () =>
        this.processMixed(frame, client, generation),
      ),
    );
    client.on("message.voice", (frame) =>
      this.queueInbound(frame, () =>
        this.processVoice(frame, client, generation),
      ),
    );
    client.on("message.file", (frame) =>
      this.queueInbound(frame, () =>
        this.processFile(frame, client, generation),
      ),
    );
    client.on("message.video", (frame) =>
      this.queueInbound(frame, () =>
        this.processVideo(frame, client, generation),
      ),
    );
    try {
      client.connect();
    } catch (error) {
      if (!this.isCurrent(client, generation)) return;
      this.client = null;
      const reason = sanitizeReason(
        error instanceof Error ? error.message : String(error),
      );
      this.log.warn("connection start failed", safeError(error));
      this.setStatus({ kind: "error", reason });
    }
  }

  private async processText(
    frame: WsFrame<TextMessage>,
    client: WSClient,
    generation: number,
  ): Promise<void> {
    await this.emitInbound(frame, client, generation, async () => ({
      text: frame.body?.text.content ?? "",
      attachments: [],
      unsupported: [],
    }));
  }

  private async processImage(
    frame: WsFrame<ImageMessage>,
    client: WSClient,
    generation: number,
  ): Promise<void> {
    await this.emitInbound(frame, client, generation, async () => {
      const image = frame.body?.image;
      if (!image) return unsupportedPayload("image", "图片内容缺失");
      const staged = await this.downloadImage(
        client,
        generation,
        frame.body!.msgid,
        0,
        image,
      );
      return staged
        ? {
            text: "",
            attachments: [staged.attachment],
            unsupported: [],
            discard: staged.discard,
          }
        : unsupportedPayload("image:download-failed", "图片下载失败");
    });
  }

  private async processMixed(
    frame: WsFrame<MixedMessage>,
    client: WSClient,
    generation: number,
  ): Promise<void> {
    await this.emitInbound(frame, client, generation, async () => {
      const text: string[] = [];
      const attachments: IMAttachment[] = [];
      const unsupported: IMUnsupportedEntry[] = [];
      const discards: Array<() => Promise<void>> = [];
      for (const [index, item] of (
        frame.body?.mixed.msg_item ?? []
      ).entries()) {
        if (item.msgtype === "text") {
          if (item.text?.content) text.push(item.text.content);
          continue;
        }
        if (item.msgtype === "image" && item.image) {
          const staged = await this.downloadImage(
            client,
            generation,
            frame.body!.msgid,
            index,
            item.image,
          );
          if (staged) {
            attachments.push(staged.attachment);
            if (staged.discard) discards.push(staged.discard);
          }
          else
            unsupported.push({
              type: "image:download-failed",
              label: "图片下载失败",
            });
        }
      }
      return {
        text: text.join("\n"),
        attachments,
        unsupported,
        discard: combineDiscards(discards),
      };
    });
  }

  private async processVoice(
    frame: WsFrame<VoiceMessage>,
    client: WSClient,
    generation: number,
  ): Promise<void> {
    await this.emitInbound(frame, client, generation, async () => ({
      text: frame.body?.voice.content ?? "",
      attachments: [],
      unsupported: frame.body?.voice.content
        ? []
        : [{ type: "voice:empty", label: "语音未能识别为文字" }],
    }));
  }

  private async processFile(
    frame: WsFrame<FileMessage>,
    client: WSClient,
    generation: number,
  ): Promise<void> {
    await this.emitInbound(frame, client, generation, async () => {
      const file = frame.body?.file;
      if (!file) return unsupportedPayload("file", "文件内容缺失");
      // 文件名要下载后才知道, 三类去处都不可用时才免下载。
      if (!this.host.files && !this.host.media) {
        return unsupportedPayload("file:unsupported", "文件暂不支持");
      }
      try {
        const downloaded = await client.downloadFile(file.url, file.aeskey);
        if (!this.isCurrent(client, generation)) {
          return unsupportedPayload("file:stale", "文件下载已取消");
        }
        // 去处只由共用判据决定: 以文件消息发来的图片/音视频同样只进媒体总仓, 总仓
        // 不可用或拒收格式时标不支持, 不回落文件暂存(媒体统一由 cindy-media 记账与回收)。
        const originalName = safeWecomFilename(downloaded.filename);
        const classified = classifyInboundAttachment(mimeTypeForFilename(originalName), originalName);
        if (classified.kind !== "file") {
          // 与文件暂存同一入站上限(stageWecomDownload 的 MAX_MEDIA_BYTES), 媒体分支不得绕过。
          if (downloaded.buffer.length > MAX_MEDIA_BYTES) {
            return unsupportedPayload("file:oversize", `文件超过大小上限：${originalName}`);
          }
          const media = this.host.media;
          const store =
            classified.kind === "image"
              ? media && ((params: Parameters<typeof media.cacheImage>[0]) => media.cacheImage({ ...params, staging: true }))
              : media?.cacheMedia?.bind(media);
          if (!store) {
            return unsupportedPayload("file:unsupported-media", `媒体文件暂不支持：${originalName}`);
          }
          let stored: { absPath: string; url: string; mimeType?: string; discard?: () => Promise<void> };
          try {
            stored = await store({
              integration: "wecom",
              token: `${frame.body!.msgid}:file`,
              buffer: downloaded.buffer,
              mimeType: classified.mimeType,
            });
          } catch {
            return unsupportedPayload("file:unsupported-media", `媒体格式暂不支持：${originalName}`);
          }
          if (!this.isCurrent(client, generation)) {
            await this.discardStagedMedia(stored.discard);
            return unsupportedPayload("file:stale", "文件下载已取消");
          }
          return {
            text: "",
            attachments: [
              {
                kind: classified.kind === "image" ? "image" : "file",
                absPath: stored.absPath,
                originalName,
                mimeType: stored.mimeType ?? classified.mimeType,
                url: stored.url,
              },
            ],
            unsupported: [],
            discard: stored.discard,
          };
        }
        const files = this.host.files;
        if (!files) {
          return unsupportedPayload("file:unsupported", "文件暂不支持");
        }
        const { discard, ...staged } = await stageWecomDownload({
          files,
          buffer: downloaded.buffer,
          filename: downloaded.filename,
          shouldKeep: () => this.isCurrent(client, generation),
        });
        return {
          text: "",
          attachments: [{ kind: "file", ...staged }],
          unsupported: [],
          discard,
        };
      } catch (error) {
        this.log.warn("failed to stage inbound file", safeError(error));
        return unsupportedPayload("file:download-failed", "文件下载失败");
      }
    });
  }

  private async processVideo(
    frame: WsFrame<VideoMessage>,
    client: WSClient,
    generation: number,
  ): Promise<void> {
    await this.emitInbound(frame, client, generation, async () => {
      const video = frame.body?.video;
      if (!video) return unsupportedPayload("video", "视频内容缺失");
      const cacheMedia = this.host.media?.cacheMedia;
      if (!cacheMedia) {
        return unsupportedPayload("video:unsupported", "视频暂不支持");
      }
      try {
        const downloaded = await client.downloadFile(video.url, video.aeskey);
        if (!this.isCurrent(client, generation)) {
          return unsupportedPayload("video:stale", "视频下载已取消");
        }
        const originalName = safeWecomFilename(downloaded.filename, ".mp4");
        const stored = await cacheMedia({
          integration: "wecom",
          token: `${frame.body!.msgid}:video`,
          buffer: downloaded.buffer,
          // 原生视频消息: 文件名无可识别扩展名时按消息类型取默认 MIME, 不交出 octet-stream。
          mimeType: nativeMediaMime(originalName, "av", "video/mp4"),
        });
        if (!this.isCurrent(client, generation)) {
          await this.discardStagedMedia(stored.discard);
          return unsupportedPayload("video:stale", "视频下载已取消");
        }
        return {
          text: "",
          attachments: [
            {
              kind: "file",
              absPath: stored.absPath,
              originalName,
              mimeType: stored.mimeType,
              url: stored.url,
            },
          ],
          unsupported: [],
          discard: stored.discard,
        };
      } catch (error) {
        this.log.warn("failed to stage inbound video", safeError(error));
        return unsupportedPayload("video:download-failed", "视频下载失败");
      }
    });
  }

  private async emitInbound(
    frame: WecomFrame,
    client: WSClient,
    generation: number,
    normalize: () => Promise<{
      text: string;
      attachments: IMAttachment[];
      unsupported: IMUnsupportedEntry[];
      discard?: () => Promise<void>;
    }>,
  ): Promise<void> {
    if (!this.isCurrent(client, generation)) return;
    const body = frame.body;
    if (!body || !body.msgid || !body.from?.userid || this.hasSeen(body.msgid))
      return;

    const isOwner = await this.acceptOwner(body);
    if (!isOwner || !this.isCurrent(client, generation)) return;
    const lane =
      body.chattype === "group" && body.chatid
        ? encodeWecomGroupLane(body.chatid)
        : body.from.userid;
    this.enqueueFrame(lane, frame);

    let normalized: Awaited<ReturnType<typeof normalize>>;
    try {
      normalized = await normalize();
    } catch (error) {
      this.log.warn("failed to normalize inbound message", safeError(error));
      normalized = unsupportedPayload(body.msgtype, `${body.msgtype} 处理失败`);
    }
    if (!this.isCurrent(client, generation)) {
      await this.discardStagedMedia(normalized.discard);
      return;
    }

    const quoted = quoteContext(body);
    const event: IMMessageEvent = {
      channelName: this.name,
      senderId: lane,
      chatId: body.chatid || body.from.userid,
      contextId: body.aibotid || this.botId,
      messageId: body.msgid,
      text: normalized.text,
      invoked: body.chattype === "group",
      attachments: normalized.attachments,
      unsupported: normalized.unsupported,
      ...(body.chattype === "group"
        ? {
            speaker: {
              id: body.from.userid,
              name: body.from.userid,
              isOwner: true,
            },
          }
        : {}),
      ...(quoted ? { replyContext: quoted } : {}),
    };
    if (
      event.text.trim() &&
      event.attachments.length === 0 &&
      [...this.textInterceptors].some((handler) => handler(event))
    ) {
      return;
    }
    for (const handler of this.messageHandlers) handler(event);
  }

  private async discardStagedMedia(discard?: () => Promise<void>): Promise<void> {
    if (!discard) return;
    try {
      await discard();
    } catch (error) {
      this.log.warn("failed to discard stale inbound media", safeError(error));
    }
  }

  private async acceptOwner(body: BaseMessage): Promise<boolean> {
    const sender = body.from.userid.trim();
    if (!sender) return false;
    if (this.ownerUserId) return sender === this.ownerUserId;
    if (body.chattype !== "single") return false;
    if (!this.host.secrets.write(this.key(OWNER_USER_ID_SECRET_KEY), sender)) {
      this.log.warn("failed to persist first owner binding");
      return false;
    }
    this.ownerUserId = sender;
    if (this.options.ipc !== false) {
      this.host.ipc.broadcast("wecomBot:status-changed", {
        status: this.status,
        botId: this.botId,
        ownerUserId: sender,
      });
    }
    return true;
  }

  private async downloadImage(
    client: WSClient,
    generation: number,
    messageId: string,
    index: number,
    image: { url: string; aeskey?: string },
  ): Promise<StagedImage | null> {
    const token = `${messageId}:${index}`;
    const cached = await this.host.media?.getCachedImage("wecom", token, {
      shouldReuse: () => this.isCurrent(client, generation),
    });
    if (!this.isCurrent(client, generation)) return null;
    if (cached) {
      return {
        attachment: {
          kind: "image",
          absPath: cached.absPath,
          originalName: safeWecomFilename(
            undefined,
            extensionForMime(cached.mimeType),
          ),
          mimeType: cached.mimeType,
          url: cached.url,
        },
      };
    }
    // 图片只进 cindy-media 总仓; host 未提供时不下载, 不写 legacy 目录。
    if (!this.host.media) return null;
    try {
      const downloaded = await client.downloadFile(image.url, image.aeskey);
      if (!this.isCurrent(client, generation)) return null;
      const filename = safeWecomFilename(downloaded.filename, ".jpg");
      // 原生图片消息: 文件名无可识别扩展名(如 "image")时按消息类型取默认 MIME。
      const mimeType = nativeMediaMime(filename, "image", "image/jpeg");
      const stored = await this.host.media.cacheImage({
        integration: "wecom",
        token,
        buffer: downloaded.buffer,
        mimeType,
        staging: true,
      });
      if (!this.isCurrent(client, generation)) {
        await this.discardStagedMedia(stored.discard);
        return null;
      }
      return {
        attachment: {
          kind: "image",
          absPath: stored.absPath,
          originalName: filename,
          mimeType: stored.mimeType ?? mimeType,
          url: stored.url,
        },
        discard: stored.discard,
      };
    } catch (error) {
      this.log.warn("failed to stage inbound image", safeError(error));
      return null;
    }
  }

  private async sendChunks(
    userId: string,
    chunks: string[],
    framePreference: "newest" | "oldest" | "none" = "newest",
  ): Promise<{ messageId: string }> {
    const client = this.requireConnectedClient();
    const lane = decodeWecomLane(userId);
    const firstId = randomUUID();
    const frame =
      framePreference === "none"
        ? null
        : framePreference === "oldest"
          ? this.claimOldestFrame(userId)
          : this.claimNewestFrame(userId);

    let start = 0;
    if (frame) {
      try {
        await client.replyStream(frame, firstId, chunks[0]!, true);
        start = 1;
      } catch (error) {
        this.log.warn(
          "passive text reply failed; using active send",
          safeError(error),
        );
      }
    }
    for (let index = start; index < chunks.length; index += 1) {
      await client.sendMessage(lane.targetId, {
        msgtype: "markdown",
        markdown: { content: chunks[index]! },
      });
    }
    return { messageId: firstId };
  }

  /**
   * 发第 index 段终稿正文。index=0 可以复用本轮流式消息(并把它 finish 掉);
   * 之后的段是独立的 markdown 消息。空正文的第 0 段只负责把流式消息收敛掉。
   */
  private async sendFinalChunk(
    userId: string,
    index: number,
    text: string,
    turnId?: string,
  ): Promise<void> {
    if (index === 0) {
      await this.sendFinalChunks(userId, text ? [text] : [], turnId);
      return;
    }
    const client = this.requireConnectedClient();
    const lane = decodeWecomLane(userId);
    await client.sendMessage(lane.targetId, {
      msgtype: "markdown",
      markdown: { content: text },
    });
  }

  private async sendFinalChunks(
    userId: string,
    chunks: string[],
    turnId?: string,
  ): Promise<{ messageId: string }> {
    const client = this.requireConnectedClient();
    const lane = decodeWecomLane(userId);
    // 只领取**本轮**的回调窗口: 上一轮留下的窗口(断开、失败、迟到补发)不能挪用,
    // 否则两轮交错时正文会写进对方的 req。
    const response = this.claimResponse(userId, turnId);
    // 终稿一旦开始交付, 本轮的过程面就作废 —— 任何迟到进度不得覆盖终稿。
    if (response) response.closed = true;
    const messageId = response?.streamId ?? randomUUID();
    let start = 0;

    if (
      response?.frame &&
      response.passiveStarted &&
      this.now() - response.startedAt < STREAM_SAFE_TIMEOUT_MS
    ) {
      try {
        await client.replyStream(
          response.frame,
          response.streamId,
          chunks[0] ?? " ",
          true,
        );
        start = 1;
      } catch (error) {
        this.log.warn(
          "passive stream finalization failed; using active send",
          safeError(error),
        );
      }
    }

    for (let index = start; index < chunks.length; index += 1) {
      await client.sendMessage(lane.targetId, {
        msgtype: "markdown",
        markdown: { content: chunks[index]! },
      });
    }
    return { messageId };
  }

  private requireConnectedClient(): WSClient {
    if (!this.client || !this.client.isConnected)
      throw new Error("WECOM_NOT_CONNECTED");
    return this.client;
  }

  private queueInbound(
    frame: WecomFrame,
    operation: () => Promise<void>,
  ): void {
    const body = frame.body;
    const lane =
      body?.chattype === "group" && body.chatid
        ? `group:${body.chatid}`
        : `single:${body?.from?.userid ?? "unknown"}`;
    const previous = this.inboundTails.get(lane) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // One malformed message must not block later messages in the lane.
      })
      .then(operation)
      .catch((error) => {
        this.log.warn("inbound message processing failed", safeError(error));
      });
    this.inboundTails.set(lane, current);
    void current.finally(() => {
      if (this.inboundTails.get(lane) === current)
        this.inboundTails.delete(lane);
    });
  }

  private enqueueFrame(lane: string, frame: WecomFrame): void {
    const queue = this.pendingFrames.get(lane) ?? [];
    queue.push({ frame, receivedAt: this.now() });
    while (queue.length > CALLBACK_QUEUE_CAPACITY) queue.shift();
    this.pendingFrames.set(lane, queue);
  }

  private enqueueResponse(lane: string, response: PendingResponse): void {
    const queue = this.pendingResponses.get(lane) ?? [];
    queue.push(response);
    while (queue.length > CALLBACK_QUEUE_CAPACITY) queue.shift();
    this.pendingResponses.set(lane, queue);
  }

  /** 只取仍可用的响应窗口(超过安全期的窗口已经无法被动回复)。 */
  private liveResponses(lane: string): PendingResponse[] {
    const minimum = this.now() - STREAM_SAFE_TIMEOUT_MS;
    return (this.pendingResponses.get(lane) ?? []).filter(
      (item) => item.startedAt >= minimum,
    );
  }

  private updateResponseQueue(lane: string, queue: PendingResponse[]): void {
    if (queue.length) this.pendingResponses.set(lane, queue);
    else this.pendingResponses.delete(lane);
  }

  /**
   * 领取本轮的回调窗口。
   *
   * - 有 `turnId`(正常路径): 只认同一轮的窗口; 没有就返回 null → 走主动发送。
   * - 无 `turnId`(旧调用): 只取**同样没有身份**的最早窗口, 绝不挪用带身份的窗口。
   */
  private claimResponse(lane: string, turnId: string | undefined): PendingResponse | null {
    const queue = this.liveResponses(lane);
    const index = turnId
      ? queue.findIndex((item) => item.turnId === turnId)
      : queue.findIndex((item) => item.turnId === undefined);
    if (index < 0) {
      this.updateResponseQueue(lane, queue);
      return null;
    }
    const [found] = queue.splice(index, 1);
    this.updateResponseQueue(lane, queue);
    return found ?? null;
  }

  private claimNewestFrame(lane: string): WecomFrame | null {
    const queue = this.liveFrames(lane);
    const found = queue.pop()?.frame ?? null;
    this.updateFrameQueue(lane, queue);
    return found;
  }

  private claimOldestFrame(lane: string): WecomFrame | null {
    const queue = this.liveFrames(lane);
    const found = queue.shift()?.frame ?? null;
    this.updateFrameQueue(lane, queue);
    return found;
  }

  private liveFrames(lane: string): PendingFrame[] {
    const minimum = this.now() - CALLBACK_TTL_MS;
    return (this.pendingFrames.get(lane) ?? []).filter(
      (item) => item.receivedAt >= minimum,
    );
  }

  private updateFrameQueue(lane: string, queue: PendingFrame[]): void {
    if (queue.length) this.pendingFrames.set(lane, queue);
    else this.pendingFrames.delete(lane);
  }

  private hasSeen(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return true;
    this.seenMessageIds.add(messageId);
    while (this.seenMessageIds.size > DEDUPE_CAPACITY) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest === undefined) break;
      this.seenMessageIds.delete(oldest);
    }
    return false;
  }

  private isCurrent(client: WSClient, generation: number): boolean {
    if (this.client !== client || this.generation !== generation) return false;
    const accountScope = this.host.accountScope;
    if (!accountScope) return true;
    return (
      this.accountToken !== NO_ACCOUNT_SCOPE &&
      this.accountToken !== null &&
      accountScope.isCurrent(this.accountToken)
    );
  }

  private setStatus(status: IMStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
    if (this.options.ipc !== false) {
      this.host.ipc.broadcast("wecomBot:status-changed", {
        status,
        botId: this.botId || null,
        ownerUserId: this.ownerUserId || null,
      });
    }
  }

  private restoreSecret(key: string, previous: string | null): void {
    if (previous === null) this.host.secrets.remove(key);
    else this.host.secrets.write(key, previous);
  }
}

export function createWecomIM(host: IMHost, options?: WecomIMOptions): WecomIM {
  return new WecomIM(host, options);
}

function createSdkLogger(
  logger: Logger,
  botId: string,
  secret: string,
): NonNullable<WSClientOptions["logger"]> {
  const clean = (message: string) => redactSdkMessage(message, botId, secret);
  return {
    debug: (message) => logger.debug(clean(message)),
    info: (message) => logger.info(clean(message)),
    warn: (message) => logger.warn(clean(message)),
    error: (message) => logger.error(clean(message)),
  };
}

function redactSdkMessage(
  message: string,
  botId: string,
  secret: string,
): string {
  let redacted = String(message).replace(/https?:\/\/\S+/giu, "[url]");
  for (const value of [botId, secret]) {
    if (value) redacted = redacted.split(value).join("[redacted]");
  }
  return redacted.slice(0, 500);
}

function quoteContext(
  body: BaseMessage,
): IMMessageEvent["replyContext"] | null {
  const quote = body.quote;
  if (!quote) return null;
  const mixedText =
    quote.mixed?.msg_item
      .filter((item) => item.msgtype === "text")
      .map((item) => item.text?.content ?? "")
      .filter(Boolean)
      .join("\n") ?? "";
  const text = quote.text?.content ?? quote.voice?.content ?? mixedText;
  const attachmentCount =
    Number(Boolean(quote.image)) +
    Number(Boolean(quote.file)) +
    (quote.mixed?.msg_item.filter((item) => item.msgtype === "image").length ??
      0);
  return {
    author: "引用消息",
    text: text || (attachmentCount ? "[引用包含附件，本轮未提供文件内容]" : "[引用正文不可用]"),
    ...(attachmentCount ? { unavailableAttachments: [`引用消息的 ${attachmentCount} 个附件未提供文件内容`] } : {}),
  };
}

function unsupportedPayload(type: string, label: string) {
  return {
    text: "",
    attachments: [] as IMAttachment[],
    unsupported: [{ type, label }],
  };
}

function combineDiscards(
  discards: Array<() => Promise<void>>,
): (() => Promise<void>) | undefined {
  if (discards.length === 0) return undefined;
  return async () => {
    const results = await Promise.allSettled(discards.map((discard) => discard()));
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  };
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

function sanitizeReason(reason: string): string {
  return String(reason)
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 240);
}

function formatAuthFailureReason(message: string): string {
  const detail = sanitizeReason(message).replace(
    /^Authentication failed:\s*/iu,
    "",
  );
  return detail
    ? `企业微信鉴权失败：${detail}`
    : "企业微信鉴权失败，请检查 Bot ID、Secret 和长连接模式";
}

function safeError(error: unknown): { code: string; message: string } {
  return {
    code: errorCode(error),
    message: sanitizeReason(
      error instanceof Error ? error.message : String(error),
    ),
  };
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
