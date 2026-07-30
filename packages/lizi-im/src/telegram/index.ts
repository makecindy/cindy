/**
 * telegram/index.ts — 个人 Telegram bot 传输层(BYO token, 直连 Bot API)。
 * ---------------------------------------------------------------------------
 * 与官方 Cindy Telegram bot(hook-control, 经 relay server)完全平行的另一套
 * 通道: 用户在 BotFather 建自己的 bot, 桌面端拿 token 直连 getUpdates 长轮询,
 * 消息不经任何服务器中转 — 本地即可调试全链路体验。
 *
 * 会话路由约定(见 codec.ts):
 *   - 私聊: senderId = Telegram 数字 user id(仅 owner 放行, Discord 同款
 *     显式 owner 模型 — Telegram bot 全网可搜, TOFU 抢注风险不可接受);
 *   - 群/topic: senderId = 群 lane id `g/{chatId}[/{threadId}]`, 编排层按
 *     (bot, laneId) 得到「每群每话题一个会话」; 出站按 lane id 解码回群聊。
 *     触发条件 = owner 在群里 @bot 或回复 bot 消息; 其余群消息只进本地
 *     群上下文窗口(onGroupWindowMessage), 不起 turn。
 *
 * 群窗口数据面: transport 把收到的每条群消息(含非触发消息与其他 bot 消息,
 * 取决于 BotFather privacy mode)与自己发出的群回复(回流条目)推给
 * onGroupWindowMessage 订阅者; 窗口存储与上下文拼装在 desktop main
 * (im/telegram/groupWindow.ts), 包内不落盘。
 */

import fs from 'node:fs';
import path from 'node:path';

import { BaseIM } from '../BaseIM.js';
import type { ChannelIM } from '../channelIM.js';
import type {
  IMCardActionEvent,
  IMHost,
  IMMessageEvent,
  IMStatus,
  InteractiveCardSpec,
  SendFileResult,
  StreamingTextHandle,
} from '../types.js';
import {
  createTelegramApiClient,
  TelegramApiError,
  type TelegramApiClient,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from './api.js';
import { chunkTelegramSource } from './chunk.js';
import { decodeLaneUserId, decodeMessageId, encodeLaneUserId, encodeMessageId } from './codec.js';
import { buildCardPayload, parseCallbackQuery } from './components.js';
import {
  detectGroupTrigger,
  groupWindowEntryOf,
  laneThreadIdOf,
  normalizeMessage,
  type TelegramGroupWindowEntry,
} from './inbound.js';
import { markdownToTelegramHtml } from './markdown.js';
import { startTelegramStreaming } from './streamingText.js';

const TOKEN_SECRET_KEY = 'telegram-bot-token';
const OWNER_USER_ID_SECRET_KEY = 'telegram-owner-user-id';
const RUNTIME_ACTIVE_SECRET_KEY = 'telegram-bot-runtime-active';
/**
 * getUpdates 游标持久化(`${botId}:${offset}`)。offset 只有在下一次 getUpdates
 * 送达服务器时才被确认 — 强杀落在"批次处理完 → 下一次请求送达"窗口会导致
 * 重放, 而下游 turn 无 messageId 幂等; 落盘让重启从上次处理完的位置续读。
 */
const UPDATES_OFFSET_SECRET_KEY = 'telegram-updates-offset';

const POLL_TIMEOUT_SEC = 50;
/**
 * 相册(media_group)聚合窗: Telegram 把一次多图拆成多条消息, 同组消息通常在
 * 同一批 getUpdates 里到齐; 静默 1s 后合并成单个事件, 不各起一轮 turn。
 */
const ALBUM_SETTLE_MS = 1_000;
const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
/** 409 = 另一个进程在对同一 token 轮询 — 低频探测等它退出。 */
const POLL_CONFLICT_RETRY_MS = 30_000;
const MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024;
const OWNER_NOTICE_TIMEOUT_MS = 4_500;
const SECRET_WRITE_FAILED_REASON = '无法安全保存凭证(系统安全存储不可用)';
const DEFAULT_EXPIRED_CARD_NOTICE = '卡片已过期';

const DEFAULT_OWNER_NOTICES = {
  linked: '✅ All linked. Just send a message when you are ready.',
  disconnected: '🔌 Unlinked. Link again whenever you need me.',
  online: '🟢 I am online on this computer. Send a message whenever you are ready.',
  offline: '🔴 I am going offline because the desktop app is closing. Reopen it to chat again.',
  offlineNotice:
    '🔔 I was offline for a while, so messages sent during that time may have been missed.',
} as const;

type OwnerNoticePhase = keyof typeof DEFAULT_OWNER_NOTICES;
type MessageHandler = (e: IMMessageEvent) => void;
type CardActionHandler = (e: IMCardActionEvent) => void;
type StatusHandler = (s: IMStatus) => void;
type GroupWindowHandler = (entry: TelegramGroupWindowEntry) => void;

export interface TelegramIMOptions {
  /** cindy-media:// / xdt-image:// → 本地绝对路径(出站图片上传用)。 */
  resolveImageUrl?: (url: string) => string;
  expiredCardNotice?: string;
  ownerNoticeText?:
    | Partial<Record<OwnerNoticePhase, string>>
    | ((phase: OwnerNoticePhase) => string);
  /** 测试注入: 替换真实 Bot API 客户端。 */
  apiFactory?: (token: string) => TelegramApiClient;
}

export class TelegramIM extends BaseIM implements ChannelIM {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly cardActionHandlers = new Set<CardActionHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly groupWindowHandlers = new Set<GroupWindowHandler>();

  private status: IMStatus = { kind: 'idle' };
  private api: TelegramApiClient | null = null;
  private botId = 0;
  private botUsername = '';
  private botDisplayName = '';
  private ownerUserId = '';
  private configVersion = 0;
  private pollAbort: AbortController | null = null;
  private pollLoop: Promise<void> | null = null;
  private pendingOfflineNotice = false;
  private runtimeOnlineAnnounced = false;
  private disposing = false;
  private readonly mediaDir: string;
  /** 相册聚合缓冲 — key `${chatId}:${mediaGroupId}`。 */
  private readonly pendingAlbums = new Map<
    string,
    { messages: TgMessage[]; timer: ReturnType<typeof setTimeout> }
  >();
  /**
   * 群 lane 的待回挂触发消息(laneUserId → 原生 message_id): 该触发的**首条**
   * 出站消息以 reply 形式挂回触发消息下面 — 多人群里答案必须和提问对上号
   * (与官方 bot / OpenClaw / Hermes 的群内回复习惯一致)。用后即耗, 后续分段
   * /卡片不重复回挂; DM 不回挂。
   */
  private readonly laneReplyTargets = new Map<string, string>();

  constructor(
    host: IMHost,
    private readonly opts: TelegramIMOptions = {},
  ) {
    super('telegram', host);
    if (!host.paths.telegramMediaDir) {
      throw new Error('IMHost.paths.telegramMediaDir is required to wire the telegram channel');
    }
    this.mediaDir = host.paths.telegramMediaDir;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.disposing = false;
    this.runtimeOnlineAnnounced = false;
    const token = this.host.secrets.read(TOKEN_SECRET_KEY)?.trim() ?? '';
    this.ownerUserId = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY)?.trim() ?? '';
    if (!token) {
      this.setStatus({ kind: 'idle' });
      return;
    }
    this.pendingOfflineNotice = Boolean(
      this.ownerUserId && this.host.secrets.read(RUNTIME_ACTIVE_SECRET_KEY),
    );
    await this.connect(token);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.configVersion += 1;
    if (this.status.kind === 'connected' && this.ownerUserId) {
      const sent = await this.sendOwnerNoticeWithTimeout(
        this.ownerUserId,
        'offline',
        OWNER_NOTICE_TIMEOUT_MS,
      );
      // 离线通知已送达 → 清 runtime 标记, 下次启动走正常 online 通知;
      // 没送出去才保留标记, 让下次启动补一条"期间消息可能没收到"。
      if (sent && !this.pendingOfflineNotice) {
        this.host.secrets.remove(RUNTIME_ACTIVE_SECRET_KEY);
      }
    }
    await this.stopPolling();
    this.setStatus({ kind: 'idle' });
  }

  registerIpc(): void {
    const configResult = (saveErrorStatus?: IMStatus) => ({
      status: this.status,
      ownerUserId: this.ownerUserId || null,
      botUsername: this.botUsername || null,
      ...(saveErrorStatus ? { saveErrorStatus } : {}),
    });

    this.host.ipc.handle('telegramBot:set-config', async (payload) => {
      const config = isRecord(payload) ? payload : {};
      const token = typeof config.token === 'string' ? config.token.trim() : '';
      const ownerUserId =
        typeof config.ownerUserId === 'string' ? config.ownerUserId.trim() : '';
      if (!this.host.secrets.isAvailable()) {
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
        return configResult();
      }

      const previousToken = this.host.secrets.read(TOKEN_SECRET_KEY);
      const previousOwnerUserId = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY);
      const previousRuntimeOwnerUserId = this.ownerUserId;

      const tokenSaved = token ? this.host.secrets.write(TOKEN_SECRET_KEY, token) : true;
      const ownerSaved = ownerUserId
        ? this.host.secrets.write(OWNER_USER_ID_SECRET_KEY, ownerUserId)
        : true;
      if (!tokenSaved || !ownerSaved) {
        this.restoreSecret(TOKEN_SECRET_KEY, previousToken);
        this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
        this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
        return configResult();
      }

      const nextOwnerUserId = ownerUserId || this.ownerUserId;
      if (token) {
        this.configVersion += 1;
        await this.stopPolling();
        this.ownerUserId = nextOwnerUserId;
        const connected = await this.connect(token);
        if (!connected) {
          const failedStatus = this.status;
          this.restoreSecret(TOKEN_SECRET_KEY, previousToken);
          this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
          this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
          const previous = previousToken?.trim();
          if (previous) {
            this.configVersion += 1;
            await this.connect(previous);
          }
          return configResult(failedStatus);
        }
        this.markRuntimeActive();
        const noticeConfigVersion = this.configVersion;
        await this.sendOwnerNoticeWithTimeout(
          nextOwnerUserId,
          'linked',
          OWNER_NOTICE_TIMEOUT_MS,
          () => this.configVersion === noticeConfigVersion && this.ownerUserId === nextOwnerUserId,
        );
        this.runtimeOnlineAnnounced = true;
        this.pendingOfflineNotice = false;
      } else if (nextOwnerUserId !== this.ownerUserId) {
        this.configVersion += 1;
        this.ownerUserId = nextOwnerUserId;
      }
      return configResult();
    });

    this.host.ipc.handle('telegramBot:get-status', () => ({
      status: this.status,
      ownerUserId: this.ownerUserId || null,
      botUsername: this.botUsername || null,
    }));

    this.host.ipc.handle('telegramBot:disconnect', async () => {
      this.configVersion += 1;
      const disconnectedOwnerUserId = this.ownerUserId;
      this.ownerUserId = '';
      await this.sendOwnerNoticeWithTimeout(
        disconnectedOwnerUserId,
        'disconnected',
        OWNER_NOTICE_TIMEOUT_MS,
        () => !this.ownerUserId,
      );
      this.host.secrets.remove(TOKEN_SECRET_KEY);
      this.host.secrets.remove(OWNER_USER_ID_SECRET_KEY);
      this.host.secrets.remove(RUNTIME_ACTIVE_SECRET_KEY);
      this.host.secrets.remove(UPDATES_OFFSET_SECRET_KEY);
      this.pendingOfflineNotice = false;
      this.runtimeOnlineAnnounced = false;
      await this.stopPolling();
      this.setStatus({ kind: 'idle' });
      return { status: this.status };
    });
  }

  // ── inbound subscriptions ──────────────────────────────────────────────────

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onCardAction(handler: CardActionHandler): () => void {
    this.cardActionHandlers.add(handler);
    return () => this.cardActionHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** 群窗口数据面订阅(desktop main 的 groupWindow 存储挂这里)。 */
  onGroupWindowMessage(handler: GroupWindowHandler): () => void {
    this.groupWindowHandlers.add(handler);
    return () => this.groupWindowHandlers.delete(handler);
  }

  // ── outbound ───────────────────────────────────────────────────────────────

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    return this.sendPlainChunked(userId, text);
  }

  async sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    const chunks = chunkTelegramSource(markdown);
    let firstMessageId = '';
    const allImageUrls: string[] = [];
    for (const chunk of chunks) {
      const { messageId, imageUrls } = await this.sendRenderedChunk(userId, chunk);
      if (!firstMessageId) firstMessageId = messageId;
      allImageUrls.push(...imageUrls);
    }
    if (allImageUrls.length > 0 && firstMessageId) {
      await this.uploadImages(firstMessageId, allImageUrls);
    }
    return { messageId: firstMessageId };
  }

  async sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
  ): Promise<{ messageId: string }> {
    const target = this.targetOf(userId);
    const { html, replyMarkup } = buildCardPayload(spec);
    const sent = await this.callSend<TgMessage>('sendMessage', {
      ...target,
      ...this.consumeReplyParams(userId),
      text: html,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    this.recordOwnEcho(userId, spec.title ? `[${spec.title}]` : spec.body.slice(0, 100), sent);
    return { messageId: encodeMessageId(String(sent.chat.id), String(sent.message_id)) };
  }

  async updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void> {
    const { chatId, messageId: nativeId } = decodeMessageId(messageId);
    const { html, replyMarkup } = buildCardPayload(spec);
    await this.editHtml(chatId, nativeId, html, replyMarkup);
  }

  async patchMarkdownCard(messageId: string, markdown: string): Promise<void> {
    const { chatId, messageId: nativeId } = decodeMessageId(messageId);
    const { html } = markdownToTelegramHtml(markdown);
    await this.editHtml(chatId, nativeId, html, undefined);
  }

  async startStreamingText(userId: string, initial?: string): Promise<StreamingTextHandle> {
    return startTelegramStreaming(
      {
        send: async (markdown) => {
          const { messageId } = await this.sendRenderedChunk(userId, markdown);
          return messageId;
        },
        edit: async (messageId, markdown) => {
          const { chatId, messageId: nativeId } = decodeMessageId(messageId);
          const { html } = markdownToTelegramHtml(markdown);
          await this.editHtml(chatId, nativeId, html, undefined);
        },
        uploadImages: (messageId, imageUrls) => this.uploadImages(messageId, imageUrls),
        chunk: chunkTelegramSource,
        extractImageUrls: (markdown) => markdownToTelegramHtml(markdown).imageUrls,
      },
      initial,
    );
  }

  async sendFile(userId: string, absPath: string, displayName?: string): Promise<SendFileResult> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return { ok: false, reason: 'NOT_FOUND' };
    }
    if (stat.size === 0) return { ok: false, reason: 'EMPTY' };
    if (stat.size > MAX_OUTBOUND_FILE_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    const api = this.api;
    if (!api) return { ok: false, reason: 'SEND_FAIL' };

    try {
      const target = this.targetOf(userId);
      const form = new FormData();
      form.set('chat_id', target.chat_id);
      if (target.message_thread_id !== undefined) {
        form.set('message_thread_id', String(target.message_thread_id));
      }
      const name = displayName ?? path.basename(absPath);
      form.set('document', new Blob([fs.readFileSync(absPath)]), name);
      const sent = await api.callForm<TgMessage>('sendDocument', form);
      this.recordOwnEcho(userId, '', sent, [name]);
      return { ok: true, messageId: encodeMessageId(String(sent.chat.id), String(sent.message_id)) };
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 413) {
        return { ok: false, reason: 'TOO_LARGE' };
      }
      return { ok: false, reason: 'UPLOAD_FAIL' };
    }
  }

  async reactToMessage(messageId: string, emoji: string): Promise<string | null> {
    const api = this.api;
    if (!api) return null;
    try {
      const { chatId, messageId: nativeId } = decodeMessageId(messageId);
      await api.call('setMessageReaction', {
        chat_id: chatId,
        message_id: Number(nativeId),
        reaction: [{ type: 'emoji', emoji }],
      });
      return emoji;
    } catch {
      return null;
    }
  }

  async removeMessageReaction(messageId: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const { chatId, messageId: nativeId } = decodeMessageId(messageId);
      await api.call('setMessageReaction', {
        chat_id: chatId,
        message_id: Number(nativeId),
        reaction: [],
      });
    } catch {
      /* cleanup is best-effort */
    }
  }

  getStatus(): IMStatus {
    return this.status;
  }

  /** 当前 bot 的展示名(群窗口回流条目署名用)。 */
  get botName(): string {
    return this.botDisplayName || this.botUsername || 'bot';
  }

  // ── connect / polling ──────────────────────────────────────────────────────

  private async connect(token: string): Promise<boolean> {
    const api = (this.opts.apiFactory ?? createTelegramApiClient)(token);
    this.setStatus({ kind: 'connecting' });
    let me: TgUser;
    try {
      me = await api.call<TgUser>('getMe');
    } catch (err) {
      this.setStatus(mapConnectErrorToStatus(err));
      return false;
    }
    this.api = api;
    this.botId = me.id;
    this.botUsername = me.username ?? '';
    this.botDisplayName = me.first_name ?? '';
    this.setStatus({ kind: 'connected', appId: String(me.id) });
    this.startPolling(api);
    if (this.pendingOfflineNotice && this.ownerUserId) {
      const noticeConfigVersion = this.configVersion;
      void this.sendOwnerNoticeWithTimeout(
        this.ownerUserId,
        'offlineNotice',
        OWNER_NOTICE_TIMEOUT_MS,
        () => this.configVersion === noticeConfigVersion,
      ).then((sent) => {
        if (sent) this.pendingOfflineNotice = false;
      });
    } else if (!this.runtimeOnlineAnnounced && this.ownerUserId) {
      const noticeConfigVersion = this.configVersion;
      void this.sendOwnerNoticeWithTimeout(
        this.ownerUserId,
        'online',
        OWNER_NOTICE_TIMEOUT_MS,
        () => this.configVersion === noticeConfigVersion,
      ).then((sent) => {
        if (sent) this.runtimeOnlineAnnounced = true;
      });
    }
    this.markRuntimeActive();
    return true;
  }

  private startPolling(api: TelegramApiClient): void {
    const abort = new AbortController();
    this.pollAbort = abort;
    const generation = this.configVersion;
    this.pollLoop = this.runPollLoop(api, abort, generation).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`telegram poll loop exited unexpectedly: ${msg}`);
    });
  }

  private async runPollLoop(
    api: TelegramApiClient,
    abort: AbortController,
    generation: number,
  ): Promise<void> {
    let offset = this.readPersistedOffset();
    let retryDelay = POLL_RETRY_BASE_MS;
    while (!abort.signal.aborted && this.configVersion === generation) {
      try {
        const updates = await api.call<TgUpdate[]>(
          'getUpdates',
          {
            offset,
            timeout: POLL_TIMEOUT_SEC,
            allowed_updates: ['message', 'callback_query'],
          },
          abort.signal,
        );
        retryDelay = POLL_RETRY_BASE_MS;
        if (this.status.kind !== 'connected') {
          this.setStatus({ kind: 'connected', appId: String(this.botId) });
        }
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          if (abort.signal.aborted || this.configVersion !== generation) return;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(`telegram update handling failed: ${msg}`);
          }
        }
        if (updates.length > 0) this.persistOffset(offset);
      } catch (err) {
        if (abort.signal.aborted || this.configVersion !== generation) return;
        if (err instanceof TelegramApiError && err.errorCode === 409) {
          this.setStatus({ kind: 'conflict', appId: String(this.botId) });
          await sleep(POLL_CONFLICT_RETRY_MS, abort.signal);
          continue;
        }
        if (err instanceof TelegramApiError && (err.errorCode === 401 || err.errorCode === 404)) {
          this.setStatus({ kind: 'error', reason: 'invalid token' });
          return;
        }
        // 网络抖动/超时: connecting + 指数退避重试。
        if (this.status.kind === 'connected') this.setStatus({ kind: 'connecting' });
        await sleep(retryDelay, abort.signal);
        retryDelay = Math.min(retryDelay * 2, POLL_RETRY_MAX_MS);
      }
    }
  }

  private async stopPolling(): Promise<void> {
    this.clearPendingAlbums();
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.pollLoop) {
      try {
        await this.pollLoop;
      } catch {
        /* swallow */
      }
      this.pollLoop = null;
    }
    this.api = null;
  }

  // ── update handling ────────────────────────────────────────────────────────

  private async handleUpdate(update: TgUpdate): Promise<void> {
    if (this.disposing) return;
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    const m = update.message;
    if (!m || !m.from) return;
    if (m.from.id === this.botId) return; // 自身消息(某些客户端场景)不处理

    // 相册成员先入群窗口(逐条, 幂等), turn 触发交给聚合器合并处理。
    if (m.media_group_id) {
      if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
        this.emitGroupWindow(groupWindowEntryOf(m));
      }
      this.bufferAlbumMessage(m);
      return;
    }

    await this.processInboundMessage(m);
  }

  /** 相册成员缓冲 + 静默窗到期后合并处理。 */
  private bufferAlbumMessage(m: TgMessage): void {
    const key = `${m.chat.id}:${m.media_group_id}`;
    const generation = this.configVersion;
    const existing = this.pendingAlbums.get(key);
    if (existing) {
      existing.messages.push(m);
      clearTimeout(existing.timer);
    }
    const messages = existing?.messages ?? [m];
    const timer = setTimeout(() => {
      this.pendingAlbums.delete(key);
      if (this.disposing || this.configVersion !== generation) return;
      // 有正文/引用的成员当主消息(caption 通常只挂在其中一条上)。
      const primary =
        messages.find((x) => (x.text ?? x.caption ?? '') !== '' || x.reply_to_message) ??
        messages[0];
      const siblings = messages.filter((x) => x !== primary);
      void this.processInboundMessage(primary, siblings, { skipGroupWindow: true }).catch(
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`telegram album handling failed: ${msg}`);
        },
      );
    }, ALBUM_SETTLE_MS);
    this.pendingAlbums.set(key, { messages, timer });
  }

  private clearPendingAlbums(): void {
    for (const { timer } of this.pendingAlbums.values()) clearTimeout(timer);
    this.pendingAlbums.clear();
  }

  private async processInboundMessage(
    m: TgMessage,
    siblings: TgMessage[] = [],
    opts: { skipGroupWindow?: boolean } = {},
  ): Promise<void> {
    if (!m.from) return;
    if (m.chat.type === 'private') {
      if (String(m.from.id) !== this.ownerUserId) return; // 非 owner 私聊直接忽略
      // 附件下载可达数秒 — 快照受理时的配置, 完成后配置已换代就丢弃
      // (与 Discord 的 acceptedContext 模式同口径)。
      const acceptedConfigVersion = this.configVersion;
      const event = await normalizeMessage(m, {
        api: this.requireApi(),
        contextId: String(this.botId),
        mediaDir: this.mediaDir,
        ...(siblings.length > 0 ? { siblings } : {}),
        ...(this.host.media ? { media: this.host.media } : {}),
      });
      if (this.disposing || this.configVersion !== acceptedConfigVersion) return;
      this.emitMessage(event);
      return;
    }

    if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
      // 每条群消息(触发与否)都进本地窗口 — 群上下文的数据面。相册成员在
      // 缓冲入口已逐条入窗, 这里跳过避免重复(入窗本身幂等, 跳过纯省一次写)。
      if (!opts.skipGroupWindow) {
        this.emitGroupWindow(groupWindowEntryOf(m));
      }

      const trigger = detectGroupTrigger(m, this.botId, this.botUsername);
      if (!trigger) return;
      if (String(m.from.id) !== this.ownerUserId) return; // 仅 owner 可触发
      const laneUserId = laneUserIdOf(m);
      this.laneReplyTargets.set(laneUserId, String(m.message_id));
      const acceptedConfigVersion = this.configVersion;
      const event = await normalizeMessage(m, {
        api: this.requireApi(),
        contextId: String(this.botId),
        mediaDir: this.mediaDir,
        overrideText: trigger.text,
        laneUserId,
        ...(siblings.length > 0 ? { siblings } : {}),
        ...(this.host.media ? { media: this.host.media } : {}),
      });
      if (this.disposing || this.configVersion !== acceptedConfigVersion) return;
      this.emitMessage(event);
    }
    // channel 消息不支持(bot 作为频道管理员的广播场景不在个人助理语义内)。
  }

  private async handleCallbackQuery(q: import('./api.js').TgCallbackQuery): Promise<void> {
    const api = this.api;
    if (!api) return;
    // 无论结果如何都先应答, 消掉客户端 loading 态。
    void api.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
    if (String(q.from.id) !== this.ownerUserId) return;
    const event = parseCallbackQuery(q);
    if (!event) {
      const notice = this.opts.expiredCardNotice ?? DEFAULT_EXPIRED_CARD_NOTICE;
      void api
        .call('answerCallbackQuery', { callback_query_id: q.id, text: notice, show_alert: true })
        .catch(() => undefined);
      return;
    }
    for (const h of this.cardActionHandlers) {
      try {
        h(event);
      } catch {
        /* swallow */
      }
    }
  }

  private emitMessage(event: IMMessageEvent): void {
    for (const h of this.messageHandlers) {
      try {
        h(event);
      } catch {
        /* swallow */
      }
    }
  }

  private emitGroupWindow(entry: TelegramGroupWindowEntry): void {
    for (const h of this.groupWindowHandlers) {
      try {
        h(entry);
      } catch {
        /* swallow */
      }
    }
  }

  // ── outbound helpers ───────────────────────────────────────────────────────

  /** userId → sendMessage 目标参数(私聊 chat_id = user id; lane 解码回群)。 */
  private targetOf(userId: string): { chat_id: string; message_thread_id?: number } {
    const lane = decodeLaneUserId(userId);
    if (!lane) return { chat_id: userId };
    return {
      chat_id: lane.chatId,
      ...(lane.threadId ? { message_thread_id: Number(lane.threadId) } : {}),
    };
  }

  /**
   * 消费该 lane 的待回挂触发 → reply_parameters(首条出站专用)。
   * allow_sending_without_reply: 触发消息被删时降级为普通消息, 不让发送失败。
   */
  private consumeReplyParams(
    userId: string,
  ): { reply_parameters: { message_id: number; allow_sending_without_reply: true } } | Record<string, never> {
    const target = this.laneReplyTargets.get(userId);
    if (target === undefined) return {};
    this.laneReplyTargets.delete(userId);
    return {
      reply_parameters: { message_id: Number(target), allow_sending_without_reply: true },
    };
  }

  private requireApi(): TelegramApiClient {
    if (!this.api) throw new Error('telegram api is not connected');
    return this.api;
  }

  /** 429 退避一次重试; 'message is not modified' 静默。 */
  private async callSend<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const api = this.requireApi();
    try {
      return await api.call<T>(method, params);
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 429) {
        await sleep(Math.min((err.retryAfterSec ?? 3) * 1000, 10_000));
        return api.call<T>(method, params);
      }
      throw err;
    }
  }

  /** 单段 markdown → HTML 发送; parse 失败回退纯文本(agent 输出偶发怪标记)。 */
  private async sendRenderedChunk(
    userId: string,
    markdownChunk: string,
  ): Promise<{ messageId: string; imageUrls: string[] }> {
    const target = this.targetOf(userId);
    const replyParams = this.consumeReplyParams(userId);
    const { html, imageUrls } = markdownToTelegramHtml(markdownChunk);
    let sent: TgMessage;
    try {
      sent = await this.callSend<TgMessage>('sendMessage', {
        ...target,
        ...replyParams,
        text: html || '…',
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 400) {
        sent = await this.callSend<TgMessage>('sendMessage', {
          ...target,
          ...replyParams,
          text: markdownChunk || '…',
          link_preview_options: { is_disabled: true },
        });
      } else {
        throw err;
      }
    }
    this.recordOwnEcho(userId, markdownChunk, sent);
    return {
      messageId: encodeMessageId(String(sent.chat.id), String(sent.message_id)),
      imageUrls,
    };
  }

  private async sendPlainChunked(userId: string, text: string): Promise<{ messageId: string }> {
    const target = this.targetOf(userId);
    let firstMessageId = '';
    for (const chunk of chunkTelegramSource(text)) {
      const sent = await this.callSend<TgMessage>('sendMessage', {
        ...target,
        ...(firstMessageId === '' ? this.consumeReplyParams(userId) : {}),
        text: chunk || '…',
        link_preview_options: { is_disabled: true },
      });
      if (!firstMessageId) {
        firstMessageId = encodeMessageId(String(sent.chat.id), String(sent.message_id));
      }
      this.recordOwnEcho(userId, chunk, sent);
    }
    return { messageId: firstMessageId };
  }

  private async editHtml(
    chatId: string,
    nativeMessageId: string,
    html: string,
    replyMarkup: unknown,
  ): Promise<void> {
    try {
      await this.callSend('editMessageText', {
        chat_id: chatId,
        message_id: Number(nativeMessageId),
        text: html || '…',
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
      });
    } catch (err) {
      if (err instanceof TelegramApiError && /not modified/i.test(err.message)) return;
      if (err instanceof TelegramApiError && err.errorCode === 400) {
        // HTML parse 失败: 剥标签退回纯文本编辑(宁可丢格式不丢内容)。
        await this.callSend('editMessageText', {
          chat_id: chatId,
          message_id: Number(nativeMessageId),
          text: html.replace(/<[^>]+>/g, '') || '…',
          link_preview_options: { is_disabled: true },
        }).catch((fallbackErr) => {
          if (fallbackErr instanceof TelegramApiError && /not modified/i.test(fallbackErr.message)) {
            return;
          }
          throw fallbackErr;
        });
        return;
      }
      throw err;
    }
  }

  /** 受管图片(cindy-media/xdt-image url 或 `abs:` 前缀绝对路径)→ sendPhoto。 */
  private async uploadImages(messageId: string, imageRefs: string[]): Promise<void> {
    const api = this.api;
    if (!api || imageRefs.length === 0) return;
    const { chatId } = decodeMessageId(messageId);
    const seen = new Set<string>();
    for (const ref of imageRefs) {
      let absPath: string | null = null;
      if (ref.startsWith('abs:')) {
        absPath = ref.slice(4);
      } else if (this.opts.resolveImageUrl) {
        try {
          absPath = this.opts.resolveImageUrl(ref);
        } catch {
          absPath = null;
        }
      }
      if (!absPath || seen.has(absPath)) continue;
      seen.add(absPath);
      try {
        const form = new FormData();
        form.set('chat_id', chatId);
        form.set('photo', new Blob([fs.readFileSync(absPath)]), path.basename(absPath));
        await api.callForm('sendPhoto', form);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`telegram image upload failed: ${msg}`);
      }
    }
  }

  /**
   * 自己发进群 lane 的消息回流进群窗口(与官方通道 server 回流 isBot 条目
   * 同语义) — 让下一轮上下文里能看到 bot 自己说过什么。私聊不记录。
   */
  private recordOwnEcho(
    userId: string,
    text: string,
    sent: TgMessage,
    fileNames?: string[],
  ): void {
    const lane = decodeLaneUserId(userId);
    if (!lane) return;
    this.emitGroupWindow({
      chatId: lane.chatId,
      threadId: lane.threadId,
      messageId: String(sent.message_id),
      chatName: sent.chat.title ?? null,
      author: { name: this.botName, isBot: true },
      text,
      ...(fileNames && fileNames.length > 0 ? { fileNames } : {}),
      sentAt: sent.date * 1000,
    });
  }

  // ── owner notices / secrets ────────────────────────────────────────────────

  private restoreSecret(key: string, previousValue: string | null): void {
    if (previousValue === null) {
      this.host.secrets.remove(key);
      return;
    }
    this.host.secrets.write(key, previousValue);
  }

  /** 持久化游标按 botId 命名空间 — 换 bot(token)后旧 offset 无意义, 归零。 */
  private readPersistedOffset(): number {
    const raw = this.host.secrets.read(UPDATES_OFFSET_SECRET_KEY);
    if (!raw) return 0;
    const separator = raw.indexOf(':');
    if (separator <= 0) return 0;
    if (raw.slice(0, separator) !== String(this.botId)) return 0;
    const n = Number(raw.slice(separator + 1));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private persistOffset(offset: number): void {
    try {
      if (!this.host.secrets.isAvailable()) return;
      this.host.secrets.write(UPDATES_OFFSET_SECRET_KEY, `${this.botId}:${offset}`);
    } catch {
      /* best-effort — 丢失只是退化回 at-least-once 重放 */
    }
  }

  private markRuntimeActive(): void {
    try {
      if (!this.host.secrets.isAvailable()) return;
      this.host.secrets.write(RUNTIME_ACTIVE_SECRET_KEY, String(Date.now()));
    } catch {
      /* best-effort */
    }
  }

  private async sendOwnerNoticeWithTimeout(
    userId: string,
    phase: OwnerNoticePhase,
    timeoutMs: number,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    if (!userId || !this.api) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        (async () => {
          if (isCurrent && !isCurrent()) return false;
          const text = this.resolveOwnerNoticeText(phase);
          await this.callSend('sendMessage', { chat_id: userId, text });
          return true;
        })().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`telegram owner ${phase} notice failed: ${msg}`);
          return false;
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private resolveOwnerNoticeText(phase: OwnerNoticePhase): string {
    const configured = this.opts.ownerNoticeText;
    const text = typeof configured === 'function' ? configured(phase) : configured?.[phase];
    return text?.trim() || DEFAULT_OWNER_NOTICES[phase];
  }

  private setStatus(s: IMStatus): void {
    this.status = s;
    this.host.ipc.broadcast('telegramBot:status-change', {
      status: s,
      botUsername: this.botUsername || null,
    });
    for (const h of this.statusHandlers) {
      try {
        h(s);
      } catch {
        /* swallow */
      }
    }
  }
}

export function createTelegramIM(host: IMHost, opts?: TelegramIMOptions): TelegramIM {
  return new TelegramIM(host, opts);
}

export type { TelegramGroupWindowEntry } from './inbound.js';

function laneUserIdOf(m: TgMessage): string {
  return encodeLaneUserId(String(m.chat.id), laneThreadIdOf(m));
}

function mapConnectErrorToStatus(err: unknown): IMStatus {
  if (err instanceof TelegramApiError) {
    if (err.errorCode === 401 || err.errorCode === 404) {
      return { kind: 'error', reason: 'invalid token' };
    }
    return { kind: 'error', reason: `telegram api ${err.errorCode}` };
  }
  return { kind: 'error', reason: 'network unreachable' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
