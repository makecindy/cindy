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
  createDiscordGateway,
  mapDiscordLoginErrorToStatus,
  type DiscordGateway,
  type DiscordGatewayEvents,
} from './gateway.js';
import { normalizeDmMessage } from './inbound.js';
import type { MessageLike } from './inbound.js';
import { chunkDiscordText } from './chunk.js';
import { decodeMessageId, encodeMessageId } from './codec.js';
import { markdownToDiscord } from './markdown.js';
import { createDmResolver, sendChunked } from './outbound.js';
import type { ClientLike, DMChannelLike } from './outbound.js';
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

interface DiscordFilePayload {
  attachment: string;
  name: string;
}

export interface DiscordIMOptions {
  resolveImageUrl?: (url: string) => string;
  gatewayFactory?: (ev: DiscordGatewayEvents) => DiscordGateway;
  expiredCardNotice?: string;
  ownerNoticeText?: Partial<Record<OwnerNoticePhase, string>> | ((phase: OwnerNoticePhase) => string);
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
  private readonly mediaDir: string;
  private suppressNextOnlineNotice = false;
  private pendingOfflineNotice = false;
  private runtimeOnlineAnnounced = false;
  private runtimeOnlineNotice: Promise<void> | null = null;
  private lifecycleAnnouncementEnabled = true;
  private lifecycleNoticeVersion = 0;
  private disposing = false;

  constructor(host: IMHost, private readonly opts: DiscordIMOptions = {}) {
    super('discord', host);
    if (!host.paths.discordMediaDir) {
      throw new Error('IMHost.paths.discordMediaDir is required to wire the discord channel');
    }
    this.mediaDir = host.paths.discordMediaDir;
    this.gateway = (opts.gatewayFactory ?? createDiscordGateway)({
      onStatus: (s) => this.setStatus(s),
      onDmMessage: (m) => {
        void this.handleDmMessage(m as unknown as MessageLike);
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
    const token = this.host.secrets.read(TOKEN_SECRET_KEY)?.trim() ?? '';
    this.ownerUserId = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY)?.trim() ?? '';
    if (!this.lifecycleAnnouncementEnabled) {
      this.clearRuntimeActiveMarker();
    }
    if (!token) {
      this.setStatus({ kind: 'idle' });
      return;
    }

    this.pendingOfflineNotice = this.lifecycleAnnouncementEnabled && Boolean(
      this.ownerUserId && this.host.secrets.read(RUNTIME_ACTIVE_SECRET_KEY),
    );

    try {
      await this.gateway.connect(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord gateway connect failed: ${msg}`);
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    const noticeDeadline = Date.now() + RUNTIME_NOTICE_SHUTDOWN_BUDGET_MS;
    await this.waitForRuntimeOnlineNotice(noticeDeadline);
    this.configVersion += 1;
    await this.announceRuntimeOffline(noticeDeadline);
    await this.gateway.destroy();
    this.setStatus({ kind: 'idle' });
  }

  registerIpc(): void {
    const configResult = (saveErrorStatus?: IMStatus) => ({
      status: this.status,
      ownerUserId: this.ownerUserId || null,
      ...(saveErrorStatus ? { saveErrorStatus } : {}),
    });

    this.host.ipc.handle('discordBot:set-config', async (payload) => {
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

      const previousToken = this.host.secrets.read(TOKEN_SECRET_KEY);
      const previousOwnerUserId = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY);
      const previousRuntimeOwnerUserId = this.ownerUserId;

      const tokenSaved = token ? this.host.secrets.write(TOKEN_SECRET_KEY, token) : true;
      const ownerUserIdSaved = ownerUserId
        ? this.host.secrets.write(OWNER_USER_ID_SECRET_KEY, ownerUserId)
        : true;
      if (!tokenSaved || !ownerUserIdSaved) {
        this.restoreSecret(TOKEN_SECRET_KEY, previousToken);
        this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
        this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
        return configResult();
      }

      const nextOwnerUserId = ownerUserId || this.ownerUserId;
      if (token) {
        this.configVersion += 1;
        const wasConnectedBeforeReconnect = this.status.kind === 'connected';
        await this.gateway.destroy();
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
          this.restoreSecret(TOKEN_SECRET_KEY, previousToken);
          this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
          this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
          await this.reconnectPreviousGateway(previousToken);
          return configResult(failedStatus);
        }
      } else if (nextOwnerUserId !== this.ownerUserId) {
        this.configVersion += 1;
        this.ownerUserId = nextOwnerUserId;
      }
      return configResult();
    });

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

    this.host.ipc.handle('discordBot:disconnect', async () => {
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
      this.host.secrets.remove(TOKEN_SECRET_KEY);
      this.host.secrets.remove(OWNER_USER_ID_SECRET_KEY);
      this.clearRuntimeActiveMarker();
      this.pendingOfflineNotice = false;
      this.runtimeOnlineAnnounced = false;
      await this.gateway.destroy();
      this.setStatus({ kind: 'idle' });
      return { status: this.status };
    });
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
    return this.requireDmChannel(userId).then(async (channel) => {
      const result = await sendChunked(channel, text);
      return { messageId: result.firstMessageId };
    });
  }

  async sendMarkdownText(
    userId: string,
    markdown: string,
  ): Promise<{ messageId: string }> {
    const channel = await this.requireDmChannel(userId);
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
    const channel = await this.requireDmChannel(userId);
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
    const message = await this.fetchMessage(messageId);
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
    const channel = await this.requireDmChannel(userId);
    return startStreaming(
      {
        send: async (text) => {
          const sent = await channel.send(text);
          return encodeMessageId(channel.id, sent.id);
        },
        edit: async (messageId, text) => {
          const message = await this.fetchMessage(messageId);
          await message.edit(text);
        },
        markdownToDiscord,
        chunk: chunkDiscordText,
        resolveImageUrl: this.opts.resolveImageUrl,
        uploadImages: (messageId, absPaths) => this.uploadImages(messageId, absPaths),
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
      const channel = await this.requireDmChannel(userId);
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
      await message.react(emoji);
      return emoji;
    } catch {
      return null;
    }
  }

  async removeMessageReaction(messageId: string, reactionToken: string): Promise<void> {
    try {
      const { channelId, messageId: nativeMessageId } = decodeMessageId(messageId);
      const channel = await this.fetchChannel(channelId);
      const message = await channel.messages.fetch(nativeMessageId);
      await message.reactions.resolve(reactionToken)?.users.remove(this.gateway.client?.user?.id);
    } catch {
      /* cleanup is best-effort */
    }
  }

  getStatus(): IMStatus {
    return this.status;
  }

  private restoreSecret(key: string, previousValue: string | null): void {
    if (previousValue === null) {
      this.host.secrets.remove(key);
      return;
    }
    this.host.secrets.write(key, previousValue);
  }

  private readLifecycleAnnouncement(): boolean {
    return this.host.secrets.read(LIFECYCLE_ANNOUNCEMENT_SECRET_KEY) !== 'false';
  }

  private writeLifecycleAnnouncement(enabled: boolean): boolean {
    try {
      if (!this.host.secrets.isAvailable()) return false;
      return this.host.secrets.write(LIFECYCLE_ANNOUNCEMENT_SECRET_KEY, String(enabled));
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

    try {
      await this.gateway.connect(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord gateway reconnect to previous config failed: ${msg}`);
    }
  }

  private setStatus(s: IMStatus): void {
    const previous = this.status;
    this.status = s;
    this.host.ipc.broadcast('discordBot:status-change', { status: s });
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
    if (!this.host.secrets.read(RUNTIME_ACTIVE_SECRET_KEY) && this.status.kind !== 'connected') return;

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
      const ok = this.host.secrets.write(RUNTIME_ACTIVE_SECRET_KEY, String(Date.now()));
      if (!ok) this.log.warn('discord runtime active marker write failed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord runtime active marker write threw: ${msg}`);
    }
  }

  private clearRuntimeActiveMarker(): void {
    try {
      this.host.secrets.remove(RUNTIME_ACTIVE_SECRET_KEY);
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

    const acceptedContext = {
      appId: this.gateway.appId,
      configVersion: this.configVersion,
      ownerUserId: acceptedOwnerUserId,
    };
    const queueKey = `${acceptedContext.configVersion}:${dmMessageQueueKey(m)}`;
    const previous = this.dmMessageQueues.get(queueKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.normalizeAndEmitDmMessage(m, acceptedContext));

    this.dmMessageQueues.set(queueKey, current);
    void current.finally(() => {
      if (this.dmMessageQueues.get(queueKey) === current) {
        this.dmMessageQueues.delete(queueKey);
      }
    });
    return current;
  }

  private async normalizeAndEmitDmMessage(
    m: MessageLike,
    acceptedContext: { appId: string; configVersion: number; ownerUserId: string },
  ): Promise<void> {
    try {
      const event = await normalizeDmMessage(m, {
        contextId: acceptedContext.appId,
        mediaDir: this.mediaDir,
        download: downloadUrl,
        media: this.host.media,
      });
      if (
        this.disposing ||
        this.configVersion !== acceptedContext.configVersion ||
        this.ownerUserId !== acceptedContext.ownerUserId ||
        this.gateway.appId !== acceptedContext.appId
      ) {
        return;
      }
      for (const h of this.messageHandlers) {
        try {
          h(event);
        } catch {
          /* swallow */
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord inbound message failed: ${msg}`);
    }
  }

  private async handleButtonInteraction(i: ButtonInteractionLike): Promise<void> {
    if (this.disposing) return;
    const event = parseInteraction(i);
    if (!event) {
      await this.notifyExpiredInteraction(i);
      return;
    }
    if (event.senderId !== this.ownerUserId) return;
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

  private async fetchChannel(channelId: string): Promise<{
    messages: {
      fetch(messageId: string): Promise<{
        react(emoji: string): Promise<unknown>;
        edit(payload: unknown): Promise<unknown>;
        reactions: {
          resolve(token: string): { users: { remove(userId: string | undefined): Promise<unknown> } } | null;
        };
      }>;
    };
  }> {
    const client = this.gateway.client as unknown as {
      channels?: { fetch(channelId: string): Promise<unknown> };
    } | null;
    const channel = await client?.channels?.fetch(channelId);
    if (!isRecord(channel) || !isRecord(channel.messages)) {
      throw new Error('discord channel does not support messages');
    }
    return channel as {
      messages: {
        fetch(messageId: string): Promise<{
          react(emoji: string): Promise<unknown>;
          edit(payload: unknown): Promise<unknown>;
          reactions: {
            resolve(token: string): { users: { remove(userId: string | undefined): Promise<unknown> } } | null;
          };
        }>;
      };
    };
  }

  private async fetchMessage(messageId: string): Promise<{ edit(payload: unknown): Promise<unknown> }> {
    const { channelId, messageId: nativeMessageId } = decodeMessageId(messageId);
    const channel = await this.fetchChannel(channelId);
    return channel.messages.fetch(nativeMessageId);
  }

  private async uploadImages(messageId: string, absPaths: string[]): Promise<void> {
    const { channelId } = decodeMessageId(messageId);
    const client = this.gateway.client as unknown as {
      channels?: { fetch(channelId: string): Promise<unknown> };
    } | null;
    const channel = await client?.channels?.fetch(channelId);
    const send = isRecord(channel) ? channel.send : null;
    if (typeof send !== 'function') return;
    const files = absPaths.map((absPath) => ({
      attachment: absPath,
      name: path.basename(absPath),
    }));
    for (const batch of batchDiscordUploadFiles(files)) {
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

async function downloadUrl(url: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download failed: ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(dest, bytes);
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
