import fs from 'node:fs';
import path from 'node:path';

import { BaseIM } from '../BaseIM.js';
import { ConnectionRetry } from '../connectionRetry.js';
import { processingReaction } from '../processingReactions.js';
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
  createDiscordGateway,
  mapDiscordLoginErrorToStatus,
  type DiscordGateway,
  type DiscordGatewayEvents,
} from './gateway.js';
import { isBotMentioned, normalizeInboundMessage, stripBotMention } from './inbound.js';
import type { GuildMessageLike, MessageLike } from './inbound.js';
import {
  decodeDiscordLaneUserId,
  discordLaneOfChannel,
  discordLaneTargetChannelId,
  encodeDiscordLaneUserId,
  EMPTY_DISCORD_CHANNEL_ACCESS,
  isDiscordLaneEnabled,
  isDiscordLaneAdmitted,
  normalizeDiscordChannelAccess,
} from './lane.js';
import type { DiscordChannelAccessConfig, DiscordChannelAccessStore, DiscordLane } from './lane.js';
import { listBotGuilds } from './guildDirectory.js';
import type { DirectoryClientLike, DiscordGuildInfo } from './guildDirectory.js';
import { chunkDiscordText } from './chunk.js';
import { decodeMessageId, encodeMessageId } from './codec.js';
import { markdownToDiscord } from './markdown.js';
import { createDmResolver, sendChunked } from './outbound.js';
import type { ClientLike, DMChannelLike, SentMessageLike } from './outbound.js';
import {
  DISCORD_CARD_PAGE_BUTTON_ID,
  buildCardMessage,
  parseInteraction,
} from './components.js';
import type { ButtonInteractionLike } from './components.js';
import { startStreaming } from './streamingText.js';

const TOKEN_SECRET_KEY = 'discord-bot-token';
const OWNER_USER_ID_SECRET_KEY = 'discord-owner-user-id';
const RUNTIME_ACTIVE_SECRET_KEY = 'discord-bot-runtime-active';
const LIFECYCLE_ANNOUNCEMENT_SECRET_KEY = 'discord-bot-lifecycle-announcement';
const MAX_OUTBOUND_FILE_BYTES = 8 * 1024 * 1024;
const DISCORD_CREATE_MESSAGE_MAX_BYTES = 25 * 1024 * 1024;
// Leave room for multipart framing/content; Discord also caps bot message uploads by file count.
const DISCORD_UPLOAD_BATCH_BYTES = DISCORD_CREATE_MESSAGE_MAX_BYTES - 1024 * 1024;
const DISCORD_MAX_FILES_PER_MESSAGE = 10;
const DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const RUNTIME_OFFLINE_NOTICE_TIMEOUT_MS = 4_500;
const RUNTIME_ONLINE_NOTICE_WAIT_TIMEOUT_MS = 1_000;
const RUNTIME_NOTICE_SHUTDOWN_BUDGET_MS = 5_500;
const OWNER_NOTICE_TIMEOUT_MS = 4_500;
const DEFAULT_EXPIRED_CARD_NOTICE = '卡片已过期';
const SECRET_WRITE_FAILED_REASON = '无法安全保存凭证(系统安全存储不可用)';
const DEFAULT_OWNER_NOTICES = {
  linked: '✅ All linked. Just send a message when you are ready.',
  disconnected: '🔌 Unlinked. Link again whenever you need me.',
  online: '🟢 I am online on this computer. Send a message whenever you are ready.',
  offline: '🔴 I am going offline because the desktop app is closing. Reopen it to chat again.',
  offlineNotice: '🔔 I was offline for a while, so messages sent during that time may have been missed.',
} as const;

type MessageHandler = (e: IMMessageEvent) => void;
type CardActionHandler = (e: IMCardActionEvent) => void;
type StatusHandler = (s: IMStatus) => void;
type OwnerNoticePhase = keyof typeof DEFAULT_OWNER_NOTICES;
type OwnerNoticeGuard = () => boolean;
interface AcceptedContext {
  appId: string;
  configVersion: number;
  ownerUserId: string;
}

interface DiscordFilePayload {
  attachment: string;
  name: string;
}

/** 调用方必须丢弃原轮次的出站内容，不能改用新身份重发。 */
class DiscordOutputInvalidatedError extends Error {
  readonly code = 'IM_OUTPUT_INVALIDATED';
}

export interface DiscordIMOptions {
  /** 凭证键名前缀(伙伴自有连接各一个, 缺省空 = 设置页那份)。 */
  secretKeyPrefix?: string;
  /** 是否注册 `discordBot:*` 设置卡 IPC 并广播状态(缺省 true; 伙伴连接关掉)。 */
  ipc?: boolean;
  resolveImageUrl?: (url: string) => string;
  gatewayFactory?: (ev: DiscordGatewayEvents) => DiscordGateway;
  expiredCardNotice?: string;
  ownerNoticeText?: Partial<Record<OwnerNoticePhase, string>> | ((phase: OwnerNoticePhase) => string);
  /**
   * 服务器频道白名单的存取（宿主持久化）。缺省 = 不开放任何服务器频道，只有主人私聊。
   * 读是实时的：白名单一改，下一条消息 / 下一次出站 / 下一次点击就按新配置判定。
   */
  channelAccess?: DiscordChannelAccessStore;
  /** 非主人点审批 / 提问卡片时的私密提示。 */
  ownerOnlyCardNotice?: string | (() => string);
}

interface FetchedMessage {
  react(emoji: string): Promise<unknown>;
  edit(payload: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
  reactions: {
    resolve(token: string): { users: { remove(userId: string | undefined): Promise<unknown> } } | null;
  };
}

const MESSAGE_CACHE_CAPACITY = 256;
const DEFAULT_OWNER_ONLY_CARD_NOTICE = 'Only the owner of this bot can use this button.';

export interface DiscordConfigState {
  status: IMStatus;
  ownerUserId: string | null;
  saveErrorStatus?: IMStatus;
}

export class DiscordIM extends BaseIM implements ChannelIM {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly cardActionHandlers = new Set<CardActionHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly gateway: DiscordGateway;
  private readonly cardSpecs = new Map<string, InteractiveCardSpec>();

  private status: IMStatus = { kind: 'idle' };
  private ownerUserId = '';
  private configVersion = 0;
  private dmResolverClient: unknown = null;
  private dmResolver: ((userId: string) => Promise<DMChannelLike>) | null = null;
  private readonly dmMessageQueues = new Map<string, Promise<void>>();
  /** 缓存近期发送的 Message，避免编辑依赖读取历史权限；按插入顺序淘汰，换连接时清空。 */
  private readonly messageCache = new Map<string, { message: FetchedMessage; assertCurrent: () => void }>();
  private suppressNextOnlineNotice = false;
  private pendingOfflineNotice = false;
  private runtimeOnlineAnnounced = false;
  private runtimeOnlineNotice: Promise<void> | null = null;
  private lifecycleAnnouncementEnabled = true;
  private lifecycleNoticeVersion = 0;
  private disposing = false;
  private readonly connectionRetry = new ConnectionRetry();

  constructor(host: IMHost, private readonly opts: DiscordIMOptions = {}) {
    super('discord', host);
    this.gateway = (opts.gatewayFactory ?? createDiscordGateway)({
      onStatus: (s) => this.setStatus(s),
      onDmMessage: (m) => {
        void this.handleDmMessage(m as unknown as MessageLike);
      },
      onGuildMessage: (m) => {
        void this.handleGuildMessage(m as unknown as GuildMessageLike);
      },
      onButtonInteraction: (i) => {
        void this.handleButtonInteraction(i as unknown as ButtonInteractionLike);
      },
    });
  }

  async init(): Promise<void> {
    this.disposing = false;
    this.suppressNextOnlineNotice = false;
    this.runtimeOnlineNotice = null;
    this.runtimeOnlineAnnounced = false;
    this.lifecycleNoticeVersion += 1;
    this.lifecycleAnnouncementEnabled = this.readLifecycleAnnouncement();
    const token = this.host.secrets.read(this.key(TOKEN_SECRET_KEY))?.trim() ?? '';
    this.ownerUserId = this.host.secrets.read(this.key(OWNER_USER_ID_SECRET_KEY))?.trim() ?? '';
    if (!this.lifecycleAnnouncementEnabled) {
      this.clearRuntimeActiveMarker();
    }
    if (!token) {
      this.setStatus({ kind: 'idle' });
      return;
    }

    this.pendingOfflineNotice = this.lifecycleAnnouncementEnabled && Boolean(
      this.ownerUserId && this.host.secrets.read(this.key(RUNTIME_ACTIVE_SECRET_KEY)),
    );

    await this.reconnectPreviousGateway(token);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.connectionRetry.reset();
    const noticeDeadline = Date.now() + RUNTIME_NOTICE_SHUTDOWN_BUDGET_MS;
    await this.waitForRuntimeOnlineNotice(noticeDeadline);
    this.configVersion += 1;
    await this.announceRuntimeOffline(noticeDeadline);
    await this.destroyGateway();
    this.setStatus({ kind: 'idle' });
  }

  /** 断开网关并丢弃绑在旧连接上的 Message 对象（换号 / 换 bot 后不得继续使用）。 */
  private async destroyGateway(): Promise<void> {
    this.messageCache.clear();
    await this.gateway.destroy();
  }

  /** 本实例的 secret 键名(见 DiscordIMOptions.secretKeyPrefix)。 */
  private key(base: string): string {
    return `${this.opts.secretKeyPrefix ?? ''}${base}`;
  }

  getConfigState(saveErrorStatus?: IMStatus): DiscordConfigState {
    return {
      status: this.status,
      ownerUserId: this.ownerUserId || null,
      ...(saveErrorStatus ? { saveErrorStatus } : {}),
    };
  }

  /** 设置里填的主人用户 id; 未填为空串。 */
  getOwnerUserId(): string {
    return this.ownerUserId;
  }

  /**
   * 保存 token / 主人 id 并重连(设置卡与伙伴连接共用)。失败时回滚到之前的凭证并在
   * 返回值里带 saveErrorStatus。
   */
  async setConfig(payload: unknown): Promise<DiscordConfigState> {
    const configResult = (saveErrorStatus?: IMStatus) => this.getConfigState(saveErrorStatus);
    // IPC handlers are registered before init(). Sync the persisted preference
    // before any gateway status can queue a lifecycle notice or write its marker.
    this.applyLifecycleAnnouncement(this.readLifecycleAnnouncement());
    const config = isRecord(payload) ? payload : {};
    const token = typeof config.token === 'string' ? config.token.trim() : '';
    const ownerUserId =
      typeof config.ownerUserId === 'string' ? config.ownerUserId.trim() : '';
    if (!this.host.secrets.isAvailable()) {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
      return configResult();
    }

    const previousToken = this.host.secrets.read(this.key(TOKEN_SECRET_KEY));
    const previousOwnerUserId = this.host.secrets.read(this.key(OWNER_USER_ID_SECRET_KEY));
    const previousRuntimeOwnerUserId = this.ownerUserId;

    const tokenSaved = token ? this.host.secrets.write(this.key(TOKEN_SECRET_KEY), token) : true;
    const ownerUserIdSaved = ownerUserId
      ? this.host.secrets.write(this.key(OWNER_USER_ID_SECRET_KEY), ownerUserId)
      : true;
    if (!tokenSaved || !ownerUserIdSaved) {
      this.restoreSecret(this.key(TOKEN_SECRET_KEY), previousToken);
      this.restoreSecret(this.key(OWNER_USER_ID_SECRET_KEY), previousOwnerUserId);
      this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
      return configResult();
    }

    const nextOwnerUserId = ownerUserId || this.ownerUserId;
    if (token) {
      this.connectionRetry.reset();
      this.configVersion += 1;
      const wasConnectedBeforeReconnect = this.status.kind === 'connected';
      await this.destroyGateway();
      this.ownerUserId = nextOwnerUserId;
      this.suppressNextOnlineNotice = true;
      try {
        await this.gateway.connect(token);
        this.markRuntimeActive();
        const linkedNoticeConfigVersion = this.configVersion;
        await this.sendOwnerNoticeWithTimeout(
          nextOwnerUserId,
          'linked',
          OWNER_NOTICE_TIMEOUT_MS,
          () => this.isOwnerNoticeCurrent(linkedNoticeConfigVersion, nextOwnerUserId),
        );
        if (wasConnectedBeforeReconnect && this.status.kind === 'connected') {
          this.suppressNextOnlineNotice = false;
        }
      } catch (err) {
        this.suppressNextOnlineNotice = false;
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`discord gateway connect failed from set-config: ${msg}`);
        const failedStatus = mapDiscordLoginErrorToStatus(err);
        this.setStatus(failedStatus);
        this.restoreSecret(this.key(TOKEN_SECRET_KEY), previousToken);
        this.restoreSecret(this.key(OWNER_USER_ID_SECRET_KEY), previousOwnerUserId);
        this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
        await this.reconnectPreviousGateway(previousToken);
        return configResult(failedStatus);
      }
    } else if (nextOwnerUserId !== this.ownerUserId) {
      this.configVersion += 1;
      this.ownerUserId = nextOwnerUserId;
    }
    return configResult();
  }

  /** Reconnect using stored credentials without changing the binding. */
  async reconnect(): Promise<DiscordConfigState> {
    this.connectionRetry.reset();
    const version = ++this.configVersion;
    await this.destroyGateway();
    if (this.disposing || version !== this.configVersion) return this.getConfigState();
    const token = this.host.secrets.read(this.key(TOKEN_SECRET_KEY));
    if (token) await this.reconnectPreviousGateway(token);
    else this.setStatus({ kind: 'idle' });
    return this.getConfigState();
  }

  /** 通知主人、断开并清掉本实例的全部凭证。 */
  async disconnect(): Promise<{ status: IMStatus }> {
    this.connectionRetry.reset();
    this.configVersion += 1;
    const disconnectedNoticeConfigVersion = this.configVersion;
    const disconnectedOwnerUserId = this.ownerUserId;
    this.ownerUserId = '';
    const noticeDeadline = Date.now() + OWNER_NOTICE_TIMEOUT_MS;
    await this.waitForRuntimeOnlineNotice(noticeDeadline, OWNER_NOTICE_TIMEOUT_MS);
    await this.sendOwnerNoticeWithTimeout(
      disconnectedOwnerUserId,
      'disconnected',
      Math.max(0, noticeDeadline - Date.now()),
      () => this.configVersion === disconnectedNoticeConfigVersion && !this.ownerUserId,
    );
    this.host.secrets.remove(this.key(TOKEN_SECRET_KEY));
    this.host.secrets.remove(this.key(OWNER_USER_ID_SECRET_KEY));
    this.clearRuntimeActiveMarker();
    this.pendingOfflineNotice = false;
    this.runtimeOnlineAnnounced = false;
    await this.destroyGateway();
    this.setStatus({ kind: 'idle' });
    return { status: this.status };
  }

  registerIpc(): void {
    // 伙伴自有连接不注册设置卡 IPC(通道名固定, 第二份实例会重复注册)。
    if (this.opts.ipc === false) return;

    this.host.ipc.handle('discordBot:set-config', (payload) => this.setConfig(payload));
    this.host.ipc.handle('discordBot:reconnect', () => this.reconnect());

    // Renderer IPC can run after handler registration but before init(). Read the
    // persisted preference here instead of exposing the constructor default.
    this.host.ipc.handle('discordBot:get-status', () => ({
      status: this.status,
      ownerUserId: this.ownerUserId || null,
      lifecycleAnnouncement: this.readLifecycleAnnouncement(),
    }));

    this.host.ipc.handle('discordBot:set-lifecycle-announcement', (payload) => {
      if (!isRecord(payload) || typeof payload.enabled !== 'boolean') {
        return this.host.ipc.throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
      }
      const enabled = payload.enabled;
      if (!this.writeLifecycleAnnouncement(enabled)) {
        return {
          ok: false,
          // Roll back to the persisted source of truth, which may differ from
          // the runtime cache before init or after an external account change.
          lifecycleAnnouncement: this.readLifecycleAnnouncement(),
        };
      }
      this.applyLifecycleAnnouncement(enabled);
      return { ok: true, lifecycleAnnouncement: enabled };
    });

    this.host.ipc.handle('discordBot:disconnect', () => this.disconnect());

    // 服务器频道白名单（设置卡「频道」区）。清单只读连接缓存；保存只收规整后的配置。
    this.host.ipc.handle('discordBot:list-channels', () => ({
      status: this.status,
      guilds: this.listGuilds(),
    }));
    this.host.ipc.handle('discordBot:get-channel-access', () => this.readChannelAccess());
    this.host.ipc.handle('discordBot:set-channel-access', (payload) => {
      const write = this.opts.channelAccess?.write;
      if (!write) {
        return this.host.ipc.throwIpcError('INVALID_PARAMS', 'channel access is not available');
      }
      return write.call(this.opts.channelAccess, normalizeDiscordChannelAccess(payload));
    });
  }

  /** 机器人当前连接缓存里的服务器与文字频道（含机器人在各频道的权限）；没连上返回空。 */
  listGuilds(): DiscordGuildInfo[] {
    return listBotGuilds(this.gateway.client as unknown as DirectoryClientLike | null);
  }

  /** 当前服务器频道白名单；未配置 / 读失败按「全部不开放」处理（fail-closed）。 */
  private readChannelAccess(): DiscordChannelAccessConfig {
    try {
      return normalizeDiscordChannelAccess(this.opts.channelAccess?.read() ?? EMPTY_DISCORD_CHANNEL_ACCESS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord channel access read failed (treated as closed): ${msg}`);
      return EMPTY_DISCORD_CHANNEL_ACCESS;
    }
  }

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

  sendText(
    userId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    return this.requireTargetChannel(userId).then(async (channel) => {
      const result = await sendChunked(channel, text);
      return { messageId: result.firstMessageId };
    });
  }

  async sendMarkdownText(
    userId: string,
    markdown: string,
  ): Promise<{ messageId: string }> {
    const channel = await this.requireTargetChannel(userId);
    const { text, imageUrls } = markdownToDiscord(markdown);
    const files = this.resolveImageFiles(imageUrls);

    if (files.length === 0) {
      const result = await sendChunked(channel, text);
      return { messageId: result.firstMessageId };
    }

    const chunks = chunkDiscordText(text);
    const fileBatches = batchDiscordUploadFiles(files);
    const firstBatch = fileBatches[0];
    if (!firstBatch) {
      const result = await sendChunked(channel, text);
      return { messageId: result.firstMessageId };
    }
    const remainingBatches = fileBatches.slice(1);
    const firstPayload: { content?: string; files: DiscordFilePayload[] } = {
      files: firstBatch,
    };
    const firstChunk = chunks[0] ?? '';
    if (firstChunk.length > 0) {
      firstPayload.content = firstChunk;
    }
    const firstSent = await channel.send(firstPayload);
    const firstMessageId = encodeMessageId(channel.id, firstSent.id);

    for (const chunk of chunks.slice(1)) {
      await channel.send(chunk);
    }
    for (const batch of remainingBatches) {
      await channel.send({ files: batch });
    }
    return { messageId: firstMessageId };
  }

  async sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
  ): Promise<{ messageId: string }> {
    const channel = await this.requireTargetChannel(userId);
    const sent = await channel.send(buildCardMessage(spec));
    const messageId = encodeMessageId(channel.id, sent.id);
    this.cardSpecs.set(messageId, cloneCardSpec(spec));
    return { messageId };
  }

  async updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void> {
    const message = await this.fetchMessage(messageId);
    await message.edit({ content: '', ...buildCardMessage(spec) });
    this.cardSpecs.set(messageId, cloneCardSpec(spec));
  }

  async patchMarkdownCard(messageId: string, markdown: string): Promise<void> {
    const message = await this.fetchMessage(messageId, { cleanup: !markdown.trim() });
    if (!markdown.trim()) {
      await message.delete();
      this.cardSpecs.delete(messageId);
      return;
    }
    const { text } = markdownToDiscord(markdown);
    await message.edit({
      content: text.slice(0, 2000),
      embeds: [],
      components: [],
    });
    this.cardSpecs.delete(messageId);
  }

  async startStreamingText(
    userId: string,
    initial?: string,
  ): Promise<StreamingTextHandle> {
    const channel = await this.requireTargetChannel(userId);
    // 服务器频道的流式回复：编辑 / 补传图片同样受发起时的连接代次与白名单约束。
    const assertCurrent = channel.assertCurrent ?? (() => undefined);
    return startStreaming(
      {
        send: async (text) => {
          const sent = await channel.send(text);
          return encodeMessageId(channel.id, sent.id);
        },
        edit: async (messageId, text) => {
          assertCurrent();
          const message = await this.fetchMessage(messageId);
          assertCurrent();
          await message.edit(text);
        },
        markdownToDiscord,
        remove: async (messageId) => {
          const message = await this.fetchMessage(messageId, { cleanup: true });
          await message.delete();
        },
        chunk: chunkDiscordText,
        resolveImageUrl: this.opts.resolveImageUrl,
        uploadImages: async (messageId, absPaths) => {
          await this.uploadImages(messageId, absPaths, assertCurrent);
        },
      },
      initial,
    );
  }

  async sendFile(
    userId: string,
    absPath: string,
    displayName?: string,
  ): Promise<SendFileResult> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return { ok: false, reason: 'NOT_FOUND' };
    }
    if (stat.size === 0) return { ok: false, reason: 'EMPTY' };
    if (stat.size > MAX_OUTBOUND_FILE_BYTES) return { ok: false, reason: 'TOO_LARGE' };

    try {
      const channel = await this.requireTargetChannel(userId);
      const sent = await channel.send({
        files: [{ attachment: absPath, name: displayName ?? path.basename(absPath) }],
      });
      return { ok: true, messageId: encodeMessageId(channel.id, sent.id) };
    } catch (err) {
      return { ok: false, reason: isPayloadTooLarge(err) ? 'TOO_LARGE' : 'UPLOAD_FAIL' };
    }
  }

  async reactToMessage(messageId: string, emoji: string): Promise<string | null> {
    try {
      const { channelId, messageId: nativeMessageId } = decodeMessageId(messageId);
      const channel = await this.fetchChannel(channelId);
      const message = await channel.messages.fetch(nativeMessageId);
      const reaction = processingReaction(emoji);
      await message.react(reaction);
      return reaction;
    } catch {
      return null;
    }
  }

  async removeMessageReaction(messageId: string, reactionToken: string): Promise<void> {
    const { channelId, messageId: nativeMessageId } = decodeMessageId(messageId);
    const channel = await this.fetchChannel(channelId);
    const message = await channel.messages.fetch(nativeMessageId);
    await message.reactions.resolve(reactionToken)?.users.remove(this.gateway.client?.user?.id);
  }

  getStatus(): IMStatus {
    return this.status;
  }

  /** Routing identity used by inbound contextId; status.appId is a display tag. */
  get botContextId(): string {
    return this.gateway.appId;
  }

  private restoreSecret(key: string, previousValue: string | null): void {
    if (previousValue === null) {
      this.host.secrets.remove(key);
      return;
    }
    this.host.secrets.write(key, previousValue);
  }

  private readLifecycleAnnouncement(): boolean {
    return this.host.secrets.read(this.key(LIFECYCLE_ANNOUNCEMENT_SECRET_KEY)) !== 'false';
  }

  private writeLifecycleAnnouncement(enabled: boolean): boolean {
    try {
      if (!this.host.secrets.isAvailable()) return false;
      return this.host.secrets.write(this.key(LIFECYCLE_ANNOUNCEMENT_SECRET_KEY), String(enabled));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord lifecycle announcement preference write threw: ${msg}`);
      return false;
    }
  }

  private applyLifecycleAnnouncement(enabled: boolean): void {
    if (this.lifecycleAnnouncementEnabled === enabled) {
      if (!enabled) {
        this.pendingOfflineNotice = false;
        this.clearRuntimeActiveMarker();
      } else if (
        !this.disposing &&
        this.status.kind === 'connected' &&
        this.ownerUserId &&
        this.gateway.client
      ) {
        this.markRuntimeActive();
      }
      return;
    }

    this.lifecycleAnnouncementEnabled = enabled;
    this.lifecycleNoticeVersion += 1;
    this.runtimeOnlineNotice = null;
    this.runtimeOnlineAnnounced = false;
    this.pendingOfflineNotice = false;
    this.suppressNextOnlineNotice = false;

    if (!enabled) {
      this.clearRuntimeActiveMarker();
      return;
    }
    if (
      !this.disposing &&
      this.status.kind === 'connected' &&
      this.ownerUserId &&
      this.gateway.client
    ) {
      this.markRuntimeActive();
    }
  }

  private async reconnectPreviousGateway(previousToken: string | null): Promise<void> {
    const token = previousToken?.trim() ?? '';
    if (!token) return;
    const version = this.configVersion;
    try {
      await this.gateway.connect(token);
      if (version === this.configVersion) this.connectionRetry.reset();
    } catch (err) {
      if (this.disposing || version !== this.configVersion) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord gateway reconnect to previous config failed: ${msg}`);
      this.setStatus(mapDiscordLoginErrorToStatus(err));
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
      if (['TokenInvalid', 'DisallowedIntents', 'InvalidIntents', 4004, 4010, 4011, 4012, 4013, 4014].includes(code as string | number)) return;
      this.connectionRetry.schedule(() => {
        if (this.disposing || version !== this.configVersion) return;
        void this.reconnectPreviousGateway(token);
      });
    }
  }

  private setStatus(s: IMStatus): void {
    const previous = this.status;
    this.status = s;
    if (this.opts.ipc !== false) {
      this.host.ipc.broadcast('discordBot:status-change', { status: s });
    }
    for (const h of this.statusHandlers) {
      try {
        h(s);
      } catch {
        /* swallow */
      }
    }
    if (
      s.kind === 'connected' &&
      previous.kind !== 'connected' &&
      !this.disposing &&
      this.shouldQueueRuntimeOnlineNotice()
    ) {
      this.queueRuntimeOnlineNotice();
    }
  }

  private shouldQueueRuntimeOnlineNotice(): boolean {
    if (!this.lifecycleAnnouncementEnabled) return false;
    if (this.runtimeOnlineNotice) return false;
    return this.suppressNextOnlineNotice || this.pendingOfflineNotice || !this.runtimeOnlineAnnounced;
  }

  private queueRuntimeOnlineNotice(): void {
    const expectedConfigVersion = this.configVersion;
    const expectedOwnerUserId = this.ownerUserId;
    const expectedLifecycleNoticeVersion = this.lifecycleNoticeVersion;
    const notice = this.announceRuntimeOnline(
      expectedConfigVersion,
      expectedOwnerUserId,
      expectedLifecycleNoticeVersion,
    ).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord runtime online notice failed: ${msg}`);
    });
    this.runtimeOnlineNotice = notice;
    void notice.finally(() => {
      if (this.runtimeOnlineNotice === notice) {
        this.runtimeOnlineNotice = null;
      }
    });
  }

  private async waitForRuntimeOnlineNotice(
    deadlineMs: number,
    maxWaitMs = RUNTIME_ONLINE_NOTICE_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const notice = this.runtimeOnlineNotice;
    if (!notice) return;
    const remainingBudgetMs = Math.max(0, deadlineMs - Date.now());
    const timeoutMs = Math.min(maxWaitMs, remainingBudgetMs);
    if (timeoutMs <= 0) {
      this.log.warn('discord runtime online notice wait skipped because shutdown budget expired');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    try {
      await Promise.race([
        notice,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        this.log.warn(`discord runtime online notice wait timed out after ${timeoutMs}ms`);
      }
    }
  }

  private async announceRuntimeOnline(
    expectedConfigVersion: number,
    expectedOwnerUserId: string,
    expectedLifecycleNoticeVersion: number,
  ): Promise<void> {
    if (!this.isLifecycleNoticeCurrent(
      expectedConfigVersion,
      expectedOwnerUserId,
      expectedLifecycleNoticeVersion,
    )) {
      return;
    }

    this.markRuntimeActive();

    const suppressOnline = this.suppressNextOnlineNotice;
    this.suppressNextOnlineNotice = false;

    if (this.pendingOfflineNotice) {
      const sent = await this.sendOwnerNotice(
        expectedOwnerUserId,
        'offlineNotice',
        () => this.isLifecycleNoticeCurrent(
          expectedConfigVersion,
          expectedOwnerUserId,
          expectedLifecycleNoticeVersion,
        ),
      );
      if (!this.isLifecycleNoticeCurrent(
        expectedConfigVersion,
        expectedOwnerUserId,
        expectedLifecycleNoticeVersion,
      )) {
        return;
      }
      if (sent) {
        this.pendingOfflineNotice = false;
      }
    }

    if (!this.isLifecycleNoticeCurrent(
      expectedConfigVersion,
      expectedOwnerUserId,
      expectedLifecycleNoticeVersion,
    )) {
      return;
    }
    if (this.disposing) return;
    if (suppressOnline) {
      this.runtimeOnlineAnnounced = true;
      return;
    }

    if (!this.runtimeOnlineAnnounced) {
      const sent = await this.sendOwnerNotice(
        expectedOwnerUserId,
        'online',
        () => this.isLifecycleNoticeCurrent(
          expectedConfigVersion,
          expectedOwnerUserId,
          expectedLifecycleNoticeVersion,
        ),
      );
      if (!this.isLifecycleNoticeCurrent(
        expectedConfigVersion,
        expectedOwnerUserId,
        expectedLifecycleNoticeVersion,
      )) {
        return;
      }
      if (sent) {
        this.runtimeOnlineAnnounced = true;
      }
    }
  }

  private isOwnerNoticeCurrent(
    expectedConfigVersion: number,
    expectedOwnerUserId: string,
  ): boolean {
    return Boolean(
      expectedOwnerUserId &&
      this.configVersion === expectedConfigVersion &&
      this.ownerUserId === expectedOwnerUserId,
    );
  }

  private isLifecycleNoticeCurrent(
    expectedConfigVersion: number,
    expectedOwnerUserId: string,
    expectedLifecycleNoticeVersion: number,
  ): boolean {
    return Boolean(
      this.lifecycleAnnouncementEnabled &&
      this.lifecycleNoticeVersion === expectedLifecycleNoticeVersion &&
      this.isOwnerNoticeCurrent(expectedConfigVersion, expectedOwnerUserId),
    );
  }

  private async announceRuntimeOffline(deadlineMs?: number): Promise<void> {
    if (!this.lifecycleAnnouncementEnabled) {
      this.pendingOfflineNotice = false;
      this.clearRuntimeActiveMarker();
      return;
    }
    if (!this.ownerUserId) return;
    if (!this.gateway.client) return;
    if (!this.host.secrets.read(this.key(RUNTIME_ACTIVE_SECRET_KEY)) && this.status.kind !== 'connected') return;

    const expectedConfigVersion = this.configVersion;
    const expectedOwnerUserId = this.ownerUserId;
    const expectedLifecycleNoticeVersion = this.lifecycleNoticeVersion;
    const timeoutMs = deadlineMs !== undefined
      ? Math.min(RUNTIME_OFFLINE_NOTICE_TIMEOUT_MS, Math.max(0, deadlineMs - Date.now()))
      : RUNTIME_OFFLINE_NOTICE_TIMEOUT_MS;
    const sent = await this.sendOwnerNoticeWithTimeout(
      expectedOwnerUserId,
      'offline',
      timeoutMs,
      () => this.isLifecycleNoticeCurrent(
        expectedConfigVersion,
        expectedOwnerUserId,
        expectedLifecycleNoticeVersion,
      ),
    );
    if (!this.isLifecycleNoticeCurrent(
      expectedConfigVersion,
      expectedOwnerUserId,
      expectedLifecycleNoticeVersion,
    )) {
      return;
    }
    if (sent && !this.pendingOfflineNotice) {
      this.clearRuntimeActiveMarker();
    } else {
      this.markRuntimeActive();
    }
  }

  private markRuntimeActive(): void {
    try {
      if (!this.lifecycleAnnouncementEnabled) return;
      if (!this.host.secrets.isAvailable()) return;
      const ok = this.host.secrets.write(this.key(RUNTIME_ACTIVE_SECRET_KEY), String(Date.now()));
      if (!ok) this.log.warn('discord runtime active marker write failed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord runtime active marker write threw: ${msg}`);
    }
  }

  private clearRuntimeActiveMarker(): void {
    try {
      this.host.secrets.remove(this.key(RUNTIME_ACTIVE_SECRET_KEY));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord runtime active marker remove threw: ${msg}`);
    }
  }

  private async sendOwnerNoticeWithTimeout(
    userId: string,
    phase: OwnerNoticePhase,
    timeoutMs: number,
    isCurrent?: OwnerNoticeGuard,
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      this.log.warn(`discord owner ${phase} notice skipped because timeout budget expired`);
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let active = true;
    const guardedIsCurrent = () => active && (!isCurrent || isCurrent());
    try {
      return await Promise.race([
        this.sendOwnerNotice(userId, phase, guardedIsCurrent),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            active = false;
            resolve(false);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        this.log.warn(`discord owner ${phase} notice timed out after ${timeoutMs}ms`);
      }
    }
  }

  private async sendOwnerNotice(
    userId: string,
    phase: OwnerNoticePhase,
    isCurrent?: OwnerNoticeGuard,
  ): Promise<boolean> {
    if (!userId) return false;
    if (!this.gateway.client) return false;

    try {
      if (isCurrent && !isCurrent()) return false;
      const text = this.resolveOwnerNoticeText(phase);
      const channel = await this.requireDmChannel(userId);
      if (isCurrent && !isCurrent()) return false;
      await sendChunked(channel, text);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord owner ${phase} notice failed: ${msg}`);
      return false;
    }
  }

  private resolveOwnerNoticeText(phase: OwnerNoticePhase): string {
    const configured = this.opts.ownerNoticeText;
    const text =
      typeof configured === 'function' ? configured(phase) : configured?.[phase];
    return text?.trim() || DEFAULT_OWNER_NOTICES[phase];
  }

  private async handleDmMessage(m: MessageLike): Promise<void> {
    if (this.disposing) return;
    const acceptedOwnerUserId = this.ownerUserId;
    if (m.author.id !== acceptedOwnerUserId) return;

    const acceptedContext = this.acceptedContext(acceptedOwnerUserId);
    return this.enqueueInbound(
      acceptedContext,
      dmMessageQueueKey(m),
      () => this.normalizeAndEmitDmMessage(m, acceptedContext),
    );
  }

  /**
   * 服务器频道 / thread 里的消息。召唤条件全部满足才进业务层：
   * 在白名单内 → 直接 @ 了机器人 → 发言人是主人，或该频道显式允许成员。
   * 任何一步不满足都静默丢弃：不回提示（频道里不可被探测）、不落库、不入窗口。
   */
  private async handleGuildMessage(m: GuildMessageLike): Promise<void> {
    if (this.disposing) return;
    const ownerUserId = this.ownerUserId;
    const botUserId = this.gateway.client?.user?.id ?? '';
    if (!ownerUserId || !botUserId) return;
    const lane = discordLaneOfChannel(m.guildId, m.channelId ?? m.channel?.id ?? '', m.channel);
    if (!lane) return;
    const isOwner = m.author.id === ownerUserId;
    if (!isDiscordLaneAdmitted(this.readChannelAccess(), lane, isOwner)) return;
    if (!isBotMentioned(m, botUserId)) return;

    const acceptedContext = this.acceptedContext(ownerUserId);
    const laneUserId = encodeDiscordLaneUserId(lane);
    return this.enqueueInbound(
      acceptedContext,
      laneUserId,
      () => this.normalizeAndEmitGuildMessage(m, lane, laneUserId, botUserId, acceptedContext),
    );
  }

  private acceptedContext(ownerUserId: string): AcceptedContext {
    return { appId: this.gateway.appId, configVersion: this.configVersion, ownerUserId };
  }

  /** 同一队列键（私聊：发言人+私聊频道；服务器：整条 lane）串行处理，下载慢的附件不乱序。 */
  private enqueueInbound(
    acceptedContext: AcceptedContext,
    key: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const queueKey = `${acceptedContext.configVersion}:${key}`;
    const previous = this.dmMessageQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);

    this.dmMessageQueues.set(queueKey, current);
    void current.finally(() => {
      if (this.dmMessageQueues.get(queueKey) === current) {
        this.dmMessageQueues.delete(queueKey);
      }
    });
    return current;
  }

  private isAcceptedContextCurrent(acceptedContext: AcceptedContext): boolean {
    return (
      !this.disposing &&
      this.configVersion === acceptedContext.configVersion &&
      this.ownerUserId === acceptedContext.ownerUserId &&
      this.gateway.appId === acceptedContext.appId
    );
  }

  private emitInbound(event: IMMessageEvent): void {
    for (const h of this.messageHandlers) {
      try {
        h(event);
      } catch {
        /* swallow */
      }
    }
  }

  private async normalizeAndEmitDmMessage(
    m: MessageLike,
    acceptedContext: AcceptedContext,
  ): Promise<void> {
    const stagedDiscards: Array<() => Promise<void>> = [];
    try {
      const event = await normalizeInboundMessage(m, {
        contextId: acceptedContext.appId,
        download: downloadUrl,
        stagedDiscards,
        ...(this.host.media ? { media: this.host.media } : {}),
        ...(this.host.files ? { files: this.host.files } : {}),
      });
      if (!event) return;
      if (!this.isAcceptedContextCurrent(acceptedContext)) {
        // 下载期间换代(登出/换号/换 bot): 回滚本次暂存, 不把旧账号的附件留给新账号。
        for (const discard of stagedDiscards) await discard().catch(() => undefined);
        return;
      }
      this.emitInbound(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord inbound message failed: ${msg}`);
    }
  }

  private async normalizeAndEmitGuildMessage(
    m: GuildMessageLike,
    lane: DiscordLane,
    laneUserId: string,
    botUserId: string,
    acceptedContext: AcceptedContext,
  ): Promise<void> {
    const stagedDiscards: Array<() => Promise<void>> = [];
    try {
      const isOwner = m.author.id === acceptedContext.ownerUserId;
      const channelName = lane.threadId ? m.channel?.parent?.name ?? m.channel?.name : m.channel?.name;
      const speakerName = m.member?.displayName ?? m.author.globalName ?? m.author.username ?? m.author.id;
      const event = await normalizeInboundMessage(
        m,
        {
          contextId: acceptedContext.appId,
          download: downloadUrl,
          stagedDiscards,
          ...(this.host.media ? { media: this.host.media } : {}),
          ...(this.host.files ? { files: this.host.files } : {}),
        },
        {
          senderId: laneUserId,
          text: stripBotMention(m.content ?? '', botUserId),
          interactionSource: {
            chatName: [m.guild?.name, channelName ? `#${channelName}` : undefined].filter(Boolean).join(' ') || undefined,
            ...(lane.threadId && m.channel?.name ? { threadName: m.channel.name } : {}),
            senderName: speakerName,
            messageUrl: `https://discord.com/channels/${lane.guildId}/${m.channelId ?? m.channel?.id}/${m.id}`,
          },
          speaker: {
            id: m.author.id,
            name: speakerName,
            ...(m.author.username ? { username: m.author.username } : {}),
            isOwner,
          },
        },
      );
      if (!event) return;
      // 附件下载可达数秒：配置换代、白名单被撤销或成员准入被收回，都丢弃这条并回滚暂存。
      if (
        !this.isAcceptedContextCurrent(acceptedContext) ||
        !isDiscordLaneAdmitted(this.readChannelAccess(), lane, isOwner)
      ) {
        for (const discard of stagedDiscards) await discard().catch(() => undefined);
        return;
      }
      this.emitInbound(event);
    } catch (err) {
      for (const discard of stagedDiscards) await discard().catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord guild inbound message failed: ${msg}`);
    }
  }

  private async handleButtonInteraction(i: ButtonInteractionLike): Promise<void> {
    if (this.disposing) return;
    const event = parseInteraction(i);
    if (!event) {
      await this.notifyExpiredInteraction(i);
      return;
    }
    // 点击人必须是主人：频道里谁都看得到卡片，但审批 / 控制只认主人身份（不是频道管理员）。
    if (i.user.id !== this.ownerUserId) {
      if (i.guildId) await this.notifyOwnerOnlyInteraction(i);
      return;
    }
    if (i.guildId) {
      // 频道已被移出白名单：旧卡不再生效，不能借历史卡片继续驱动该频道的任务。
      const lane = decodeDiscordLaneUserId(event.senderId);
      if (!lane || !isDiscordLaneEnabled(this.readChannelAccess(), lane)) {
        await this.notifyExpiredInteraction(i);
        return;
      }
    }
    if (event.buttonId === DISCORD_CARD_PAGE_BUTTON_ID) {
      await this.handleCardPageInteraction(event, i);
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

  private resolveOwnerOnlyCardNotice(): string {
    const configured = this.opts.ownerOnlyCardNotice;
    const text = typeof configured === 'function' ? configured() : configured;
    return text?.trim() || DEFAULT_OWNER_ONLY_CARD_NOTICE;
  }

  private async notifyOwnerOnlyInteraction(i: ButtonInteractionLike): Promise<void> {
    const interaction = i as ButtonInteractionLike & {
      followUp?: (payload: { content: string; ephemeral?: boolean }) => Promise<unknown>;
    };
    try {
      await interaction.followUp?.({
        content: this.resolveOwnerOnlyCardNotice(),
        ephemeral: true,
      });
    } catch {
      /* best-effort: 不能在频道里公开回复 */
    }
  }

  private async handleCardPageInteraction(
    event: IMCardActionEvent,
    interaction: ButtonInteractionLike,
  ): Promise<void> {
    const page = event.payload.page;
    const spec = this.cardSpecs.get(event.messageId);
    if (!spec || typeof page !== 'number') {
      await this.notifyExpiredInteraction(interaction);
      return;
    }

    try {
      const message = await this.fetchMessage(event.messageId);
      await message.edit({ content: '', ...buildCardMessage(spec, { page }) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord card pagination failed: ${msg}`);
    }
  }

  private async requireDmChannel(userId: string): Promise<DMChannelLike> {
    const client = this.gateway.client as unknown as ClientLike | null;
    if (!client) throw new Error('discord gateway is not connected');
    if (client !== this.dmResolverClient || !this.dmResolver) {
      this.dmResolverClient = client;
      this.dmResolver = createDmResolver(client);
    }
    return this.dmResolver(userId);
  }

  /**
   * 出站目标：lane id 解到对应服务器频道 / thread，其余按私聊 user id。
   * lane 每次发送都复核白名单（被撤销后进行中的轮次也发不出去），并确认取回的 channel
   * 确实属于 lane 里的服务器，绝不凭一个 id 就往别处发。
   */
  private async requireTargetChannel(userId: string): Promise<DMChannelLike & { assertCurrent?: () => void }> {
    const lane = decodeDiscordLaneUserId(userId);
    if (!lane) return this.requireDmChannel(userId);
    const assertCurrent = this.captureLaneGuard(lane);
    assertCurrent();
    const first = await this.fetchLaneChannel(lane).finally(assertCurrent);
    return {
      id: first.id,
      assertCurrent,
      // 每次真正发送都重新复核「连接代次 + 白名单」并用当前连接取频道：
      // 持有这个对象的流式回复 / 分段发送，在白名单被撤销或换了 bot 后不会继续发出内容。
      send: async (payload) => {
        assertCurrent();
        const channel = await this.fetchLaneChannel(lane);
        assertCurrent();
        const sent = await channel.send(payload);
        this.rememberMessage(encodeMessageId(channel.id, sent.id), sent, assertCurrent);
        return sent;
      },
    };
  }

  /**
   * 记下发起时的 bot 身份（gateway appId）与 lane，返回复核函数：连接已释放 / 换了 bot / 该频道已不在
   * 白名单就抛错。同一个 bot 重连不算换代（出站每次都用当前连接取频道，不依赖旧对象）。
   */
  private captureLaneGuard(lane: DiscordLane): () => void {
    const identity = this.captureIdentityGuard();
    return () => {
      identity();
      if (!isDiscordLaneEnabled(this.readChannelAccess(), lane)) {
        throw new Error('discord channel is not enabled');
      }
    };
  }

  /**
   * 记下此刻的 bot 身份（gateway appId）与主人，返回复核函数：实例已释放、换了 bot 或换了主人就抛错。
   * 同一个 bot、同一个主人的普通重连不算换代。所有会产生副作用的 I/O（发送 / 编辑 / 上传）之前都要过它。
   */
  private captureIdentityGuard(): () => void {
    const appId = this.gateway.appId;
    const owner = this.ownerUserId;
    return () => {
      if (this.disposing || !appId || this.gateway.appId !== appId) {
        throw new DiscordOutputInvalidatedError('discord connection changed');
      }
      if (this.ownerUserId !== owner) throw new DiscordOutputInvalidatedError('discord owner changed');
    };
  }

  /** 用当前连接取 lane 对应的频道 / thread，并确认它确实属于 lane 里的服务器。 */
  private async fetchLaneChannel(
    lane: DiscordLane,
  ): Promise<{ id: string; send(payload: unknown): Promise<SentMessageLike & FetchedMessage> }> {
    const client = this.gateway.client as unknown as {
      channels?: { fetch(channelId: string): Promise<unknown> };
    } | null;
    if (!client?.channels) throw new Error('discord gateway is not connected');
    const channel = await client.channels.fetch(discordLaneTargetChannelId(lane));
    if (
      !isRecord(channel) ||
      typeof channel.send !== 'function' ||
      typeof channel.id !== 'string' ||
      channel.guildId !== lane.guildId
    ) {
      throw new Error('discord channel is unavailable');
    }
    const send = channel.send as (payload: unknown) => Promise<SentMessageLike & FetchedMessage>;
    return { id: channel.id, send: (payload) => send.call(channel, payload) };
  }

  /**
   * 按 id 取到的服务器频道（缓存没命中时）也要过白名单：lane 由频道自身的 guild / 类型 / 父频道推出。
   * 私聊频道没有 guildId，不受影响。
   */
  private assertFetchedChannelAdmitted(channel: unknown): void {
    if (!isRecord(channel) || !channel.guildId) return;
    const lane = discordLaneOfChannel(
      String(channel.guildId),
      String(channel.id ?? ''),
      channel as { type?: number; parentId?: string | null },
    );
    if (!lane || !isDiscordLaneEnabled(this.readChannelAccess(), lane)) {
      throw new Error('discord channel is not enabled');
    }
  }

  /**
   * lane 的可读名（`服务器 #频道 › thread`），只读连接缓存；缓存里没有就返回 null，
   * 由调用方保留默认标题（不为取名发请求）。
   */
  describeLane(userId: string): string | null {
    const lane = decodeDiscordLaneUserId(userId);
    if (!lane) return null;
    const client = this.gateway.client as unknown as {
      guilds?: { cache?: { get(id: string): { name?: string } | undefined } };
      channels?: { cache?: { get(id: string): { name?: string } | undefined } };
    } | null;
    const guild = client?.guilds?.cache?.get(lane.guildId)?.name;
    const channel = client?.channels?.cache?.get(lane.channelId)?.name;
    if (!guild || !channel) return null;
    const thread = lane.threadId ? client?.channels?.cache?.get(lane.threadId)?.name : undefined;
    return `${guild} #${channel}${thread ? ` › ${thread}` : ''}`;
  }

  private rememberMessage(encodedMessageId: string, message: FetchedMessage, assertCurrent: () => void): void {
    if (typeof message?.edit !== 'function') return;
    this.messageCache.delete(encodedMessageId);
    this.messageCache.set(encodedMessageId, { message, assertCurrent });
    while (this.messageCache.size > MESSAGE_CACHE_CAPACITY) {
      const oldest = this.messageCache.keys().next().value;
      if (oldest === undefined) break;
      this.messageCache.delete(oldest);
    }
  }

  private async fetchChannel(channelId: string): Promise<{
    messages: { fetch(messageId: string): Promise<FetchedMessage> };
  }> {
    const client = this.gateway.client as unknown as {
      channels?: { fetch(channelId: string): Promise<unknown> };
    } | null;
    const channel = await client?.channels?.fetch(channelId);
    if (!isRecord(channel) || !isRecord(channel.messages)) {
      throw new Error('discord channel does not support messages');
    }
    return channel as { messages: { fetch(messageId: string): Promise<FetchedMessage> } };
  }

  /**
   * 先用手里的 Message 对象（不需要读历史权限），没有再按 id 去频道里取。服务器频道里的编辑 / 更新每次
   * 都复核白名单与连接代次（缓存命中走发消息时记下的复核函数，未命中按取到的频道自身判定，await 之后再复核）。
   * `cleanup` 只用于撤掉机器人自己发出的占位 / 过期卡片：撤销白名单后也允许删除，但不允许改内容。
   */
  private async fetchMessage(messageId: string, opts: { cleanup?: boolean } = {}): Promise<Pick<FetchedMessage, 'edit' | 'delete'>> {
    const cached = this.messageCache.get(messageId);
    let message: FetchedMessage;
    let assertCurrent: () => void;
    if (cached) {
      message = cached.message;
      assertCurrent = cached.assertCurrent;
    } else {
      const identity = this.captureIdentityGuard();
      const { channelId, messageId: nativeMessageId } = decodeMessageId(messageId);
      const channel = await this.fetchChannel(channelId);
      assertCurrent = () => {
        identity();
        this.assertFetchedChannelAdmitted(channel);
      };
      if (!opts.cleanup) assertCurrent();
      message = await channel.messages.fetch(nativeMessageId);
    }
    if (opts.cleanup) return message;
    assertCurrent();
    return {
      // 调用方 await 返回后仍可能撤权或换身份，复核必须紧邻真正的编辑 I/O。
      edit: (payload) => { assertCurrent(); return message.edit(payload); },
      delete: () => message.delete(),
    };
  }

  private async uploadImages(messageId: string, absPaths: string[], assertCurrent?: () => void): Promise<void> {
    const { channelId } = decodeMessageId(messageId);
    // 流式回复带着发起时的复核函数；单独调用时以本次调用开始时的身份为准。
    const guard = assertCurrent ?? this.captureIdentityGuard();
    const client = this.gateway.client as unknown as {
      channels?: { fetch(channelId: string): Promise<unknown> };
    } | null;
    guard();
    const channel = await client?.channels?.fetch(channelId);
    const send = isRecord(channel) ? channel.send : null;
    if (typeof send !== 'function') return;
    guard();
    this.assertFetchedChannelAdmitted(channel);
    const files = absPaths.map((absPath) => ({
      attachment: absPath,
      name: path.basename(absPath),
    }));
    for (const batch of batchDiscordUploadFiles(files)) {
      // 每一批上传前都复核身份与白名单：长图集中途撤销白名单或换了 bot，后面的批次不再发。
      guard();
      this.assertFetchedChannelAdmitted(channel);
      await send.call(channel, { files: batch });
    }
  }

  private async notifyExpiredInteraction(i: ButtonInteractionLike): Promise<void> {
    const interaction = i as ButtonInteractionLike & {
      followUp?: (payload: { content: string; ephemeral?: boolean }) => Promise<unknown>;
    };
    const notice = this.opts.expiredCardNotice ?? DEFAULT_EXPIRED_CARD_NOTICE;
    if (typeof interaction.followUp === 'function') {
      try {
        await interaction.followUp({ content: notice, ephemeral: true });
        return;
      } catch {
        /* fall back to DM below */
      }
    }

    try {
      const channel = await this.requireDmChannel(i.user.id);
      await channel.send(notice);
    } catch {
      /* best-effort */
    }
  }

  private resolveImageFiles(imageUrls: string[]): DiscordFilePayload[] {
    if (!this.opts.resolveImageUrl) return [];

    const files: DiscordFilePayload[] = [];
    for (const url of imageUrls) {
      try {
        const absPath = this.opts.resolveImageUrl(url);
        files.push({ attachment: absPath, name: path.basename(absPath) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`discord markdown image resolve failed: ${msg}`);
      }
    }
    return files;
  }
}

export function createDiscordIM(host: IMHost, opts?: DiscordIMOptions): DiscordIM {
  return new DiscordIM(host, opts);
}

async function downloadUrl(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`download timed out after ${DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneCardSpec(spec: InteractiveCardSpec): InteractiveCardSpec {
  return {
    ...spec,
    buttons: spec.buttons.map((button) => ({
      ...button,
      ...(button.payload ? { payload: { ...button.payload } } : {}),
    })),
  };
}

function dmMessageQueueKey(m: MessageLike): string {
  return `${m.author.id}:${m.channelId ?? m.channel?.id ?? ''}`;
}

function batchDiscordUploadFiles(files: DiscordFilePayload[]): DiscordFilePayload[][] {
  const batches: DiscordFilePayload[][] = [];
  let current: DiscordFilePayload[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const fileBytes = getUploadFileSize(file);
    if (fileBytes > DISCORD_UPLOAD_BATCH_BYTES) {
      throw new Error(`discord upload file too large for a single request: ${file.name}`);
    }

    if (
      current.length > 0 &&
      (current.length >= DISCORD_MAX_FILES_PER_MESSAGE ||
        currentBytes + fileBytes > DISCORD_UPLOAD_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(file);
    currentBytes += fileBytes;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function getUploadFileSize(file: DiscordFilePayload): number {
  try {
    return fs.statSync(file.attachment).size;
  } catch {
    throw new Error(`discord upload file unavailable: ${file.name}`);
  }
}

function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown; code?: unknown }).status;
    const code = (error as { status?: unknown; code?: unknown }).code;
    if (status === 413 || code === 413 || code === 'RequestEntityTooLarge') return true;
  }
  return error instanceof Error && /413|payload too large/i.test(error.message);
}
