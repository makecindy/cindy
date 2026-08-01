import { randomUUID } from "node:crypto";

import {
  WSClient,
  type BaseMessage,
  type FileMessage,
  type ImageMessage,
  type MixedMessage,
  type TextMessage,
  type VideoMessage,
  type VoiceMessage,
  type WSClientOptions,
  type WsFrame,
} from "@wecom/aibot-node-sdk";

import { BaseIM } from "../BaseIM.js";
import type { ImFinalOutput, TextChannelIM } from "../channelIM.js";
import type { Logger } from "../logger.js";
import type {
  IMAttachment,
  IMHost,
  IMMessageEvent,
  IMStatus,
  IMUnsupportedEntry,
  SendFileResult,
} from "../types.js";
import {
  collectXdtFileLinks,
  collectXdtImageUrls,
  stripXdtFileLinks,
  stripXdtImageLinks,
} from "../xdtRefs.js";
import {
  chunkWecomMarkdown,
  decodeWecomLane,
  encodeWecomGroupLane,
  escapeWecomMarkdown,
} from "./codec.js";
import {
  mimeTypeForFilename,
  persistWecomDownload,
  readWecomOutboundFile,
  resolveAllowedWecomOutboundFile,
  safeWecomFilename,
} from "./media.js";

const BOT_ID_SECRET_KEY = "wecom-bot-id";
const BOT_SECRET_SECRET_KEY = "wecom-bot-secret";
const OWNER_USER_ID_SECRET_KEY = "wecom-owner-user-id";
const CALLBACK_TTL_MS = 4 * 60_000;
const CALLBACK_QUEUE_CAPACITY = 64;
const STREAM_SAFE_TIMEOUT_MS = 2 * 60_000 + 45_000;
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
}

export interface WecomIMOptions {
  clientFactory?: (options: WSClientOptions) => WSClient;
  now?: () => number;
}

/** Enterprise WeChat transport with durable chunked-text output. */
export class WecomIM extends BaseIM implements TextChannelIM {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly textInterceptors = new Set<TextInterceptor>();
  private readonly pendingFrames = new Map<string, PendingFrame[]>();
  private readonly pendingResponses = new Map<string, PendingResponse[]>();
  private readonly inboundTails = new Map<string, Promise<void>>();
  private readonly seenMessageIds = new Set<string>();
  private readonly mediaDir: string;
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
    if (!host.paths.wecomMediaDir) {
      throw new Error(
        "IMHost.paths.wecomMediaDir is required to wire the WeCom channel",
      );
    }
    this.mediaDir = host.paths.wecomMediaDir;
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    this.botId = this.host.secrets.read(BOT_ID_SECRET_KEY)?.trim() ?? "";
    this.ownerUserId =
      this.host.secrets.read(OWNER_USER_ID_SECRET_KEY)?.trim() ?? "";
    const secret = this.host.secrets.read(BOT_SECRET_SECRET_KEY)?.trim() ?? "";
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
    this.inboundTails.clear();
    this.seenMessageIds.clear();
    this.client?.disconnect();
    this.client = null;
    this.setStatus({ kind: "idle" });
  }

  registerIpc(): void {
    const state = (saveErrorStatus?: IMStatus) => ({
      status: this.status,
      botId: this.botId || null,
      ownerUserId: this.ownerUserId || null,
      ...(saveErrorStatus ? { saveErrorStatus } : {}),
    });
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

    this.host.ipc.handle("wecomBot:get-status", () => state());
    this.host.ipc.handle("wecomBot:set-config", (payload) =>
      runAccountScoped(async () => {
        const record = isRecord(payload) ? payload : {};
        const botId =
          typeof record.botId === "string" ? record.botId.trim() : "";
        const secret =
          typeof record.secret === "string" ? record.secret.trim() : "";
        if (!botId || !secret) {
          const failed: IMStatus = {
            kind: "error",
            reason: "Bot ID 和 Secret 不能为空",
          };
          this.setStatus(failed);
          return state(failed);
        }
        if (!this.host.secrets.isAvailable()) {
          const failed: IMStatus = {
            kind: "error",
            reason: SECRET_WRITE_FAILED_REASON,
          };
          this.setStatus(failed);
          return state(failed);
        }

        const previousBotId = this.host.secrets.read(BOT_ID_SECRET_KEY);
        const previousSecret = this.host.secrets.read(BOT_SECRET_SECRET_KEY);
        const previousOwner = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY);
        const botChanged = Boolean(
          previousBotId?.trim() && previousBotId.trim() !== botId,
        );
        const saved =
          this.host.secrets.write(BOT_ID_SECRET_KEY, botId) &&
          this.host.secrets.write(BOT_SECRET_SECRET_KEY, secret);
        if (!saved) {
          this.restoreSecret(BOT_ID_SECRET_KEY, previousBotId);
          this.restoreSecret(BOT_SECRET_SECRET_KEY, previousSecret);
          this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwner);
          const failed: IMStatus = {
            kind: "error",
            reason: SECRET_WRITE_FAILED_REASON,
          };
          this.setStatus(failed);
          return state(failed);
        }
        if (botChanged) {
          this.host.secrets.remove(OWNER_USER_ID_SECRET_KEY);
          this.ownerUserId = "";
        }
        this.botId = botId;
        this.connect(botId, secret);
        return state();
      }),
    );
    this.host.ipc.handle("wecomBot:reconnect", () =>
      runAccountScoped(async () => {
        const botId = this.host.secrets.read(BOT_ID_SECRET_KEY)?.trim() ?? "";
        const secret =
          this.host.secrets.read(BOT_SECRET_SECRET_KEY)?.trim() ?? "";
        if (botId && secret) this.connect(botId, secret);
        return state();
      }),
    );
    this.host.ipc.handle("wecomBot:disconnect", () =>
      runAccountScoped(async () => {
        this.generation += 1;
        this.client?.disconnect();
        this.client = null;
        this.pendingFrames.clear();
        this.pendingResponses.clear();
        this.inboundTails.clear();
        this.seenMessageIds.clear();
        this.host.secrets.remove(BOT_ID_SECRET_KEY);
        this.host.secrets.remove(BOT_SECRET_SECRET_KEY);
        this.host.secrets.remove(OWNER_USER_ID_SECRET_KEY);
        this.botId = "";
        this.ownerUserId = "";
        this.setStatus({ kind: "idle" });
        return state();
      }),
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
  ): Promise<{ messageId: string }> {
    return this.sendChunks(userId, chunkWecomMarkdown(markdown));
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
        return { ok: false, reason: "SEND_FAIL" };
      }
      this.log.warn("failed to send media", safeError(error));
      return { ok: false, reason: uploaded ? "SEND_FAIL" : "UPLOAD_FAIL" };
    }
  }

  /**
   * Preserve the callback reply window before the Agent starts. The final
   * response reuses this stream id; after the safe window it falls back to an
   * active markdown message.
   */
  async beginReply(userId: string): Promise<void> {
    const client = this.requireConnectedClient();
    const response: PendingResponse = {
      frame: this.claimOldestFrame(userId),
      streamId: randomUUID(),
      startedAt: this.now(),
      passiveStarted: false,
    };
    this.enqueueResponse(userId, response);
    if (!response.frame) return;
    try {
      await client.replyStream(response.frame, response.streamId, " ", false);
      response.passiveStarted = true;
    } catch (error) {
      this.log.warn(
        "failed to start passive stream; final reply will use active send",
        safeError(error),
      );
    }
  }

  async commitFinal(output: ImFinalOutput): Promise<void> {
    const fileLinks = collectXdtFileLinks(output.text);
    const imageUrls = collectXdtImageUrls(output.text);
    const attachments: Array<{ absPath: string; displayName?: string }> = [];
    const seenPaths = new Set<string>();
    const addAttachment = (absPath: string, displayName?: string) => {
      if (seenPaths.has(absPath)) return;
      seenPaths.add(absPath);
      attachments.push({
        absPath,
        ...(displayName ? { displayName } : {}),
      });
    };
    let rejectedFileCount = 0;
    let unresolvedImageCount = 0;
    for (const link of fileLinks) {
      const resolved = await resolveAllowedWecomOutboundFile(
        link.absPath,
        output.allowedFileRoots ?? [],
      );
      if (!resolved) {
        rejectedFileCount += 1;
        this.log.warn("skipped terminal file attachment outside allowed roots");
        continue;
      }
      addAttachment(resolved, link.alt || undefined);
    }
    for (const url of imageUrls) {
      const absPath = this.host.media?.resolveMediaUrl(url) ?? null;
      if (absPath) {
        addAttachment(absPath);
      } else {
        unresolvedImageCount += 1;
        this.log.warn("failed to resolve terminal managed image", { url });
      }
    }
    for (const absPath of output.mediaAbsPaths ?? []) addAttachment(absPath);

    const omittedAttachmentCount = Math.max(
      0,
      attachments.length - MAX_TERMINAL_ATTACHMENTS,
    );
    const attachmentNotice = omittedAttachmentCount
      ? `⚠️ 另有 ${omittedAttachmentCount} 个附件未发送（企业微信单次最多发送 ${MAX_TERMINAL_ATTACHMENTS} 个）。`
      : "";
    const rejectedFileNotice = rejectedFileCount
      ? `⚠️ 有 ${rejectedFileCount} 个文件附件未发送（不在当前工作目录内或无法验证）。`
      : "";
    const unresolvedImageNotice = unresolvedImageCount
      ? `⚠️ 有 ${unresolvedImageCount} 张图片未发送（图片已不存在或无法读取）。`
      : "";
    const visibleText = [
      stripXdtFileLinks(stripXdtImageLinks(output.text)).trim(),
      attachmentNotice,
      rejectedFileNotice,
      unresolvedImageNotice,
    ]
      .filter(Boolean)
      .join("\n\n");
    const chunks = chunkWecomMarkdown(
      visibleText || (attachments.length > 0 ? "📎 附件如下" : "_(空回复)_"),
    );
    await this.sendFinalChunks(output.userId, chunks);
    let failedAttachmentCount = 0;
    for (const attachment of attachments.slice(0, MAX_TERMINAL_ATTACHMENTS)) {
      const result = await this.sendFile(
        output.userId,
        attachment.absPath,
        attachment.displayName,
        { usePendingFrame: false },
      );
      if (!result.ok) {
        failedAttachmentCount += 1;
        this.log.warn("failed to send terminal attachment", {
          reason: result.reason,
        });
      }
    }
    if (failedAttachmentCount > 0) {
      try {
        await this.sendChunks(
          output.userId,
          chunkWecomMarkdown(
            `⚠️ 有 ${failedAttachmentCount} 个附件发送失败，请稍后重试。`,
          ),
          "none",
        );
      } catch (error) {
        this.log.warn(
          "failed to report terminal attachment delivery failure",
          safeError(error),
        );
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
      try {
        const downloaded = await client.downloadFile(file.url, file.aeskey);
        if (!this.isCurrent(client, generation)) {
          return unsupportedPayload("file:stale", "文件下载已取消");
        }
        const persisted = await persistWecomDownload({
          mediaDir: this.mediaDir,
          buffer: downloaded.buffer,
          filename: downloaded.filename,
          shouldKeep: () => this.isCurrent(client, generation),
        });
        return {
          text: "",
          attachments: [{ kind: "file", ...persisted }],
          unsupported: [],
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
          mimeType: mimeTypeForFilename(originalName),
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
    if (!this.host.secrets.write(OWNER_USER_ID_SECRET_KEY, sender)) {
      this.log.warn("failed to persist first owner binding");
      return false;
    }
    this.ownerUserId = sender;
    this.host.ipc.broadcast("wecomBot:status-changed", {
      status: this.status,
      botId: this.botId,
      ownerUserId: sender,
    });
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
    try {
      const downloaded = await client.downloadFile(image.url, image.aeskey);
      if (!this.isCurrent(client, generation)) return null;
      const filename = safeWecomFilename(downloaded.filename, ".jpg");
      const mimeType = mimeTypeForFilename(filename);
      if (this.host.media) {
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
            mimeType,
            url: stored.url,
          },
          discard: stored.discard,
        };
      }
      const persisted = await persistWecomDownload({
        mediaDir: this.mediaDir,
        buffer: downloaded.buffer,
        filename,
        fallbackExtension: ".jpg",
        shouldKeep: () => this.isCurrent(client, generation),
      });
      return { attachment: { kind: "image", ...persisted } };
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

  private async sendFinalChunks(
    userId: string,
    chunks: string[],
  ): Promise<{ messageId: string }> {
    const client = this.requireConnectedClient();
    const lane = decodeWecomLane(userId);
    const response = this.claimOldestResponse(userId);
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

  private claimOldestResponse(lane: string): PendingResponse | null {
    const queue = this.pendingResponses.get(lane) ?? [];
    const found = queue.shift() ?? null;
    if (queue.length) this.pendingResponses.set(lane, queue);
    else this.pendingResponses.delete(lane);
    return found;
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
    this.host.ipc.broadcast("wecomBot:status-changed", {
      status,
      botId: this.botId || null,
      ownerUserId: this.ownerUserId || null,
    });
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
    text: text || "[附件]",
    ...(attachmentCount ? { attachmentCount } : {}),
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
