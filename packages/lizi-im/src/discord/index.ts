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
  connectedStatusForBotTag,
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
const PENDING_TOKEN_SECRET_KEY = 'discord-bot-token-pending';
const PENDING_OWNER_USER_ID_SECRET_KEY = 'discord-owner-user-id-pending';
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

type MessageHandler = (e: IMMessageEvent) => void | Promise<void>;
type CardActionHandler = (e: IMCardActionEvent) => void | Promise<void>;
type StatusHandler = (s: IMStatus) => void;
type OwnerNoticePhase = keyof typeof DEFAULT_OWNER_NOTICES;
type OwnerNoticeGuard = () => boolean;

interface DiscordFilePayload {
  attachment: string;
  name: string;
}

interface DiscordOutboundLease {
  client: unknown;
  configVersion: number;
  identity: string;
}

export interface DiscordSchedulerHooks {
  /** Return whether this Desktop currently owns the Discord ingress lease. */
  isTransportAllowed(identity?: string | null): boolean;
  /** Re-run same-account election after a local credential/binding change. */
  onConfigurationChanged?: () => void;
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
  private inboundConfigVersion = 0;
  // Invalidates an in-flight init without revoking outbound leases that must
  // finish during an ordered scheduler handoff drain.
  private initializationGeneration = 0;
  private dmResolverClient: unknown = null;
  private dmResolver: ((userId: string) => Promise<DMChannelLike>) | null = null;
  private readonly dmMessageQueues = new Map<string, Promise<void>>();
  private readonly buttonInteractionQueues = new Set<Promise<void>>();
  private readonly acceptedTasks = new Set<Promise<unknown>>();
  private readonly mediaDir: string;
  private suppressNextOnlineNotice = false;
  private pendingOfflineNotice = false;
  private runtimeOnlineAnnounced = false;
  private runtimeOnlineNotice: Promise<void> | null = null;
  private lifecycleAnnouncementEnabled = true;
  private lifecycleNoticeVersion = 0;
  private disposing = false;
  private schedulerHandoffDraining = false;
  private schedulerHooks: DiscordSchedulerHooks | null = null;

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
      onButtonInteraction: (i, acknowledged) => {
        void this.handleButtonInteraction(
          i as unknown as ButtonInteractionLike,
          acknowledged,
        );
      },
    });
  }

  async init(): Promise<void> {
    this.disposing = false;
    const initializationGeneration = ++this.initializationGeneration;
    this.suppressNextOnlineNotice = false;
    this.runtimeOnlineNotice = null;
    this.runtimeOnlineAnnounced = false;
    this.lifecycleNoticeVersion += 1;
    this.lifecycleAnnouncementEnabled = this.readLifecycleAnnouncement();
    const pendingToken = this.readPendingToken();
    const previousToken = this.host.secrets.read(TOKEN_SECRET_KEY);
    const token = pendingToken || previousToken?.trim() || '';
    const previousOwnerUserId = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY);
    this.ownerUserId = this.readConfiguredOwnerUserId(Boolean(pendingToken));
    if (!this.lifecycleAnnouncementEnabled) {
      this.clearRuntimeActiveMarker();
    }
    if (!token) {
      this.setStatus({ kind: 'idle' });
      return;
    }
    const configuredIdentity = this.schedulerIdentityFromToken(token);
    if (configuredIdentity && !this.schedulerTransportAllowed(configuredIdentity)) {
      this.setStatus({ kind: 'standby', appId: configuredIdentity });
      return;
    }

    this.pendingOfflineNotice = this.lifecycleAnnouncementEnabled && Boolean(
      this.ownerUserId && this.host.secrets.read(RUNTIME_ACTIVE_SECRET_KEY),
    );

    try {
      await this.gateway.connect(token);
      if (!this.isCurrentInitialization(initializationGeneration)) return;
      if (configuredIdentity && !this.schedulerTransportAllowed(configuredIdentity)) {
        await this.enterSchedulerStandby();
        return;
      }
      if (pendingToken && !this.promotePendingCredentials(pendingToken, this.ownerUserId)) {
        await this.gateway.destroy();
        this.discardPendingCredentials(pendingToken);
        this.ownerUserId = previousOwnerUserId?.trim() ?? '';
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
        this.schedulerConfigurationChanged();
        await this.reconnectPreviousGateway(previousToken);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord gateway connect failed: ${msg}`);
      if (!this.isCurrentInitialization(initializationGeneration)) return;
      if (pendingToken) {
        this.discardPendingCredentials(pendingToken);
        this.ownerUserId = previousOwnerUserId?.trim() ?? '';
        this.schedulerConfigurationChanged();
        await this.reconnectPreviousGateway(previousToken);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.initializationGeneration += 1;
    this.inboundConfigVersion += 1;
    const noticeDeadline = Date.now() + RUNTIME_NOTICE_SHUTDOWN_BUDGET_MS;
    await this.waitForRuntimeOnlineNotice(noticeDeadline);
    this.configVersion += 1;
    await this.announceRuntimeOffline(noticeDeadline);
    await this.gateway.destroy();
    this.setStatus({ kind: 'idle' });
  }

  setSchedulerHooks(hooks: DiscordSchedulerHooks | null): void {
    this.schedulerHooks = hooks;
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
      const nextOwnerUserId = ownerUserId || this.ownerUserId;
      if (token) {
        const previousPendingToken = this.host.secrets.read(PENDING_TOKEN_SECRET_KEY);
        const previousPendingOwnerUserId = this.host.secrets.read(PENDING_OWNER_USER_ID_SECRET_KEY);
        const tokenSaved = this.host.secrets.write(PENDING_TOKEN_SECRET_KEY, token);
        const ownerUserIdSaved = nextOwnerUserId
          ? this.host.secrets.write(PENDING_OWNER_USER_ID_SECRET_KEY, nextOwnerUserId)
          : true;
        if (!tokenSaved || !ownerUserIdSaved) {
          this.restoreSecret(PENDING_TOKEN_SECRET_KEY, previousPendingToken);
          this.restoreSecret(PENDING_OWNER_USER_ID_SECRET_KEY, previousPendingOwnerUserId);
          this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
          this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
          return configResult();
        }
        if (!nextOwnerUserId) this.host.secrets.remove(PENDING_OWNER_USER_ID_SECRET_KEY);

        this.configVersion += 1;
        this.initializationGeneration += 1;
        this.inboundConfigVersion += 1;
        const wasConnectedBeforeReconnect = this.status.kind === 'connected';
        await this.gateway.destroy();
        this.ownerUserId = nextOwnerUserId;
        const configuredIdentity = this.schedulerIdentityFromToken(token);
        // Publish the new binding and enter the scheduler's discovery grace
        // before attempting a Gateway connection. Otherwise two Desktops
        // moving from empty configuration to the same Bot can both connect
        // while their old empty advertisements are still the only peer view.
        this.schedulerConfigurationChanged();
        if (configuredIdentity && !this.schedulerTransportAllowed(configuredIdentity)) {
          this.setStatus({ kind: 'standby', appId: configuredIdentity });
          return configResult();
        }
        this.suppressNextOnlineNotice = true;
        try {
          await this.gateway.connect(token);
          if (configuredIdentity && !this.schedulerTransportAllowed(configuredIdentity)) {
            await this.enterSchedulerStandby();
            return configResult();
          }
          if (!this.promotePendingCredentials(token, nextOwnerUserId)) {
            const failedStatus: IMStatus = { kind: 'error', reason: SECRET_WRITE_FAILED_REASON };
            await this.gateway.destroy();
            this.discardPendingCredentials(token);
            this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
            this.setStatus(failedStatus);
            this.schedulerConfigurationChanged();
            await this.reconnectPreviousGateway(previousToken);
            return configResult(failedStatus);
          }
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
          this.discardPendingCredentials(token);
          this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
          this.schedulerConfigurationChanged();
          await this.reconnectPreviousGateway(previousToken);
          return configResult(failedStatus);
        }
      } else if (nextOwnerUserId !== this.ownerUserId) {
        const ownerSecretKey = this.readPendingToken()
          ? PENDING_OWNER_USER_ID_SECRET_KEY
          : OWNER_USER_ID_SECRET_KEY;
        if (!this.host.secrets.write(ownerSecretKey, nextOwnerUserId)) {
          this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON });
          return configResult();
        }
        this.configVersion += 1;
        this.initializationGeneration += 1;
        this.inboundConfigVersion += 1;
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
      this.initializationGeneration += 1;
      this.inboundConfigVersion += 1;
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
      this.host.secrets.remove(PENDING_TOKEN_SECRET_KEY);
      this.host.secrets.remove(PENDING_OWNER_USER_ID_SECRET_KEY);
      this.clearRuntimeActiveMarker();
      this.pendingOfflineNotice = false;
      this.runtimeOnlineAnnounced = false;
      await this.gateway.destroy();
      this.setStatus({ kind: 'idle' });
      this.schedulerConfigurationChanged();
      return { status: this.status };
    });
  }

  getSchedulerIdentity(): string | null {
    const token = this.readPendingToken()
      || this.host.secrets.read(TOKEN_SECRET_KEY)?.trim()
      || '';
    return this.schedulerIdentityFromToken(token);
  }

  isSchedulerTransportActive(): boolean {
    return this.gateway.client !== null && this.gateway.ingressOpen;
  }

  /** A discord.js client may remain alive while its Gateway is reconnecting. */
  isSchedulerTransportConnecting(): boolean {
    return this.gateway.client !== null && !this.gateway.ingressOpen;
  }

  /** Stop new Discord ingress immediately; ordered handoff cleanup follows. */
  async closeSchedulerIngress(): Promise<void> {
    await this.gateway.closeIngress();
  }

  async enterSchedulerStandby(options: {
    clearRuntimeActiveMarker?: boolean;
    closeIngress?: boolean;
  } = {}): Promise<void> {
    // Invalidate pending init side effects before awaiting ingress close or
    // accepted-task drain. `configVersion` intentionally changes later so
    // already accepted outbound work can still finish on the old client.
    this.initializationGeneration += 1;
    const identity = this.getSchedulerIdentity() ?? 'discord';
    this.suppressNextOnlineNotice = false;
    this.runtimeOnlineNotice = null;
    this.schedulerHandoffDraining = true;
    try {
      if (options.closeIngress) {
        // A same-device Device Link ownership loss is invisible to the peer
        // snapshot because both processes share one deviceId. Close the old
        // Gateway ingress before the new owner can connect, while retaining
        // the REST client for already accepted work below.
        await this.gateway.closeIngress();
      }
      // A same-device ownership handoff closes the websocket before this
      // drain. A normal remote handoff keeps the only live Gateway receiving,
      // so DMs and buttons arriving while the next owner waits for our clean
      // runtime are accepted into this same drain queue.
      await this.drainSchedulerHandoffWork();
      // Presence can change while an accepted Agent turn is draining. If the
      // remote winner disappeared and this Desktop owns ingress again, the
      // original handoff decision is stale: keep the existing Gateway instead
      // of manufacturing a clean logout/relogin gap.
      if (
        !options.closeIngress
        && this.schedulerHooks
        && this.schedulerTransportAllowed(identity)
        && this.gateway.ingressForcedClosed !== true
      ) {
        // Keep the provider's real connection status. In particular, an
        // existing discord.js client can still be reconnecting; only a real
        // ShardReady/ShardResume event may promote it back to connected.
        if (this.gateway.ingressOpen) {
          // ShardReady/ShardResume may have arrived while this Desktop was
          // still denied and therefore been projected to standby. Once the
          // stale handoff is cancelled, republish the Gateway's real state so
          // the scheduler restores its connected identity and reconnect
          // supervision instead of retaining a synthetic standby forever.
          this.setStatus(connectedStatusForBotTag(this.gateway.botTag));
        }
        return;
      }
      this.configVersion += 1;
      await this.gateway.destroy();
      if (options.clearRuntimeActiveMarker && !this.pendingOfflineNotice) {
        this.clearRuntimeActiveMarker();
      }
      this.setStatus({ kind: 'standby', appId: identity });
    } finally {
      this.schedulerHandoffDraining = false;
    }
  }

  trackAcceptedTask(task: Promise<unknown>): void {
    const tracked = Promise.resolve(task);
    this.acceptedTasks.add(tracked);
    void tracked.then(
      () => this.acceptedTasks.delete(tracked),
      () => this.acceptedTasks.delete(tracked),
    );
  }

  /** Preserve a cross-device unclean runtime fact until the next active lease can compensate it. */
  markSchedulerOfflineGap(): void {
    if (!this.readLifecycleAnnouncement()) return;
    this.pendingOfflineNotice = true;
    this.markRuntimeActive();
  }

  hasPendingSchedulerOfflineNotice(): boolean {
    return this.pendingOfflineNotice;
  }

  private schedulerIdentityFromToken(token: string): string | null {
    const encodedId = token.split('.', 1)[0] ?? '';
    if (!encodedId) return null;
    try {
      const decoded = Buffer.from(encodedId, 'base64url').toString('utf8');
      return /^[1-9][0-9]{16,19}$/.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }

  private schedulerTransportAllowed(identity = this.getSchedulerIdentity()): boolean {
    // An undecodable token must still reach the provider so it can report a
    // normal authentication error. Scheduler arbitration only applies after
    // the non-secret Discord application id is known.
    return identity ? (this.schedulerHooks?.isTransportAllowed(identity) ?? true) : true;
  }

  private schedulerOutboundAllowed(identity: string): boolean {
    return (
      this.schedulerHandoffDraining
      && identity === this.getSchedulerIdentity()
    ) || this.schedulerTransportAllowed(identity);
  }

  private schedulerConfigurationChanged(): void {
    try {
      this.schedulerHooks?.onConfigurationChanged?.();
    } catch (error) {
      this.log.warn(`discord scheduler configuration notification failed: ${String(error)}`);
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
    return this.sendTextWithLease(userId, text);
  }

  async sendMarkdownText(
    userId: string,
    markdown: string,
  ): Promise<{ messageId: string }> {
    const lease = this.captureOutboundLease();
    const channel = await this.requireDmChannel(userId);
    this.assertOutboundLease(lease);
    const { text, imageUrls } = markdownToDiscord(markdown);
    const files = this.resolveImageFiles(imageUrls);

    if (files.length === 0) {
      const result = await sendChunked(channel, text, () => this.assertOutboundLease(lease));
      return { messageId: result.firstMessageId };
    }

    const chunks = chunkDiscordText(text);
    const fileBatches = batchDiscordUploadFiles(files);
    const firstBatch = fileBatches[0];
    if (!firstBatch) {
      const result = await sendChunked(channel, text, () => this.assertOutboundLease(lease));
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
    this.assertOutboundLease(lease);
    const firstSent = await channel.send(firstPayload);
    this.assertOutboundLease(lease);
    const firstMessageId = encodeMessageId(channel.id, firstSent.id);

    for (const chunk of chunks.slice(1)) {
      this.assertOutboundLease(lease);
      await channel.send(chunk);
      this.assertOutboundLease(lease);
    }
    for (const batch of remainingBatches) {
      this.assertOutboundLease(lease);
      await channel.send({ files: batch });
      this.assertOutboundLease(lease);
    }
    return { messageId: firstMessageId };
  }

  async sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
  ): Promise<{ messageId: string }> {
    const lease = this.captureOutboundLease();
    const channel = await this.requireDmChannel(userId);
    this.assertOutboundLease(lease);
    const sent = await channel.send(buildCardMessage(spec));
    this.assertOutboundLease(lease);
    const messageId = encodeMessageId(channel.id, sent.id);
    this.cardSpecs.set(messageId, cloneCardSpec(spec));
    return { messageId };
  }

  async updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void> {
    const lease = this.captureOutboundLease();
    const message = await this.fetchMessage(messageId);
    this.assertOutboundLease(lease);
    await message.edit({ content: '', ...buildCardMessage(spec) });
    this.assertOutboundLease(lease);
    this.cardSpecs.set(messageId, cloneCardSpec(spec));
  }

  async patchMarkdownCard(messageId: string, markdown: string): Promise<void> {
    const lease = this.captureOutboundLease();
    const message = await this.fetchMessage(messageId);
    this.assertOutboundLease(lease);
    const { text } = markdownToDiscord(markdown);
    await message.edit({
      content: text.slice(0, 2000),
      embeds: [],
      components: [],
    });
    this.assertOutboundLease(lease);
    this.cardSpecs.delete(messageId);
  }

  async startStreamingText(
    userId: string,
    initial?: string,
  ): Promise<StreamingTextHandle> {
    const lease = this.captureOutboundLease();
    const channel = await this.requireDmChannel(userId);
    this.assertOutboundLease(lease);
    return startStreaming(
      {
        send: async (text) => {
          this.assertOutboundLease(lease);
          const sent = await channel.send(text);
          this.assertOutboundLease(lease);
          return encodeMessageId(channel.id, sent.id);
        },
        edit: async (messageId, text) => {
          this.assertOutboundLease(lease);
          const message = await this.fetchMessage(messageId);
          this.assertOutboundLease(lease);
          await message.edit(text);
          this.assertOutboundLease(lease);
        },
        markdownToDiscord,
        chunk: chunkDiscordText,
        resolveImageUrl: this.opts.resolveImageUrl,
        uploadImages: (messageId, absPaths) =>
          this.uploadImages(messageId, absPaths, () => this.assertOutboundLease(lease)),
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
      const lease = this.captureOutboundLease();
      const channel = await this.requireDmChannel(userId);
      this.assertOutboundLease(lease);
      const sent = await channel.send({
        files: [{ attachment: absPath, name: displayName ?? path.basename(absPath) }],
      });
      this.assertOutboundLease(lease);
      return { ok: true, messageId: encodeMessageId(channel.id, sent.id) };
    } catch (err) {
      return { ok: false, reason: isPayloadTooLarge(err) ? 'TOO_LARGE' : 'UPLOAD_FAIL' };
    }
  }

  async reactToMessage(messageId: string, emoji: string): Promise<string | null> {
    try {
      const lease = this.captureOutboundLease();
      const { channelId, messageId: nativeMessageId } = decodeMessageId(messageId);
      const channel = await this.fetchChannel(channelId);
      this.assertOutboundLease(lease);
      const message = await channel.messages.fetch(nativeMessageId);
      this.assertOutboundLease(lease);
      await message.react(emoji);
      this.assertOutboundLease(lease);
      return emoji;
    } catch {
      return null;
    }
  }

  async removeMessageReaction(messageId: string, reactionToken: string): Promise<void> {
    try {
      const lease = this.captureOutboundLease();
      const { channelId, messageId: nativeMessageId } = decodeMessageId(messageId);
      const channel = await this.fetchChannel(channelId);
      this.assertOutboundLease(lease);
      const message = await channel.messages.fetch(nativeMessageId);
      this.assertOutboundLease(lease);
      await message.reactions.resolve(reactionToken)?.users.remove(this.gateway.client?.user?.id);
      this.assertOutboundLease(lease);
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

  private readPendingToken(): string {
    return this.host.secrets.read(PENDING_TOKEN_SECRET_KEY)?.trim() ?? '';
  }

  private readConfiguredOwnerUserId(hasPendingToken = Boolean(this.readPendingToken())): string {
    const ownerKey = hasPendingToken
      ? PENDING_OWNER_USER_ID_SECRET_KEY
      : OWNER_USER_ID_SECRET_KEY;
    return this.host.secrets.read(ownerKey)?.trim()
      || this.host.secrets.read(OWNER_USER_ID_SECRET_KEY)?.trim()
      || '';
  }

  private promotePendingCredentials(expectedToken: string, ownerUserId: string): boolean {
    if (this.readPendingToken() !== expectedToken) return false;
    const previousToken = this.host.secrets.read(TOKEN_SECRET_KEY);
    const previousOwnerUserId = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY);
    const tokenSaved = this.host.secrets.write(TOKEN_SECRET_KEY, expectedToken);
    const ownerUserIdSaved = ownerUserId
      ? this.host.secrets.write(OWNER_USER_ID_SECRET_KEY, ownerUserId)
      : true;
    if (!tokenSaved || !ownerUserIdSaved) {
      this.restoreSecret(TOKEN_SECRET_KEY, previousToken);
      this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
      return false;
    }
    if (!ownerUserId) this.host.secrets.remove(OWNER_USER_ID_SECRET_KEY);
    this.discardPendingCredentials(expectedToken);
    return true;
  }

  private discardPendingCredentials(expectedToken?: string): void {
    if (expectedToken && this.readPendingToken() !== expectedToken) return;
    this.host.secrets.remove(PENDING_TOKEN_SECRET_KEY);
    this.host.secrets.remove(PENDING_OWNER_USER_ID_SECRET_KEY);
  }

  private isCurrentInitialization(generation: number): boolean {
    return !this.disposing && this.initializationGeneration === generation;
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
    const identity = this.schedulerIdentityFromToken(token);
    if (this.disposing || !token || (identity && !this.schedulerTransportAllowed(identity))) return;

    try {
      await this.gateway.connect(token);
      if (this.disposing) {
        await this.gateway.destroy();
        return;
      }
      if (identity && !this.schedulerTransportAllowed(identity)) {
        await this.enterSchedulerStandby();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord gateway reconnect to previous config failed: ${msg}`);
    }
  }

  private setStatus(s: IMStatus): void {
    const schedulerIdentity = this.getSchedulerIdentity();
    if (s.kind === 'connected' && schedulerIdentity && !this.schedulerTransportAllowed(schedulerIdentity)) {
      const standby: IMStatus = { kind: 'standby', appId: schedulerIdentity };
      this.status = standby;
      this.host.ipc.broadcast('discordBot:status-change', { status: standby });
      for (const h of this.statusHandlers) {
        try {
          h(standby);
        } catch {
          /* swallow */
        }
      }
      if (!this.schedulerHandoffDraining) {
        void this.gateway.destroy().catch((error) => {
          this.log.warn(`discord scheduler standby destroy failed: ${String(error)}`);
        });
      }
      return;
    }
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
    if (this.disposing || (!this.schedulerTransportAllowed() && !this.schedulerHandoffDraining))
      return;
    const acceptedOwnerUserId = this.ownerUserId;
    if (m.author.id !== acceptedOwnerUserId) return;

    const acceptedContext = {
      appId: this.gateway.appId,
      inboundConfigVersion: this.inboundConfigVersion,
      ownerUserId: acceptedOwnerUserId,
    };
    const queueKey = `${acceptedContext.inboundConfigVersion}:${dmMessageQueueKey(m)}`;
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
    acceptedContext: { appId: string; inboundConfigVersion: number; ownerUserId: string },
  ): Promise<void> {
    try {
      const event = await normalizeDmMessage(m, {
        contextId: acceptedContext.appId,
        mediaDir: this.mediaDir,
        download: downloadUrl,
        media: this.host.media,
      });
      if (!event) return;
      if (
        this.disposing ||
        this.inboundConfigVersion !== acceptedContext.inboundConfigVersion ||
        this.ownerUserId !== acceptedContext.ownerUserId
      ) {
        return;
      }
      const handlers: Promise<void>[] = [];
      for (const h of this.messageHandlers) {
        try {
          handlers.push(Promise.resolve(h(event)));
        } catch {
          /* swallow */
        }
      }
      await Promise.allSettled(handlers);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`discord inbound message failed: ${msg}`);
    }
  }

  private handleButtonInteraction(
    i: ButtonInteractionLike,
    acknowledged: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    if (this.disposing || (!this.schedulerTransportAllowed() && !this.schedulerHandoffDraining)) {
      return Promise.resolve();
    }
    const acceptedContext = {
      inboundConfigVersion: this.inboundConfigVersion,
      ownerUserId: this.ownerUserId,
    };
    const current = this.processAcceptedButtonInteraction(i, acknowledged, acceptedContext);
    this.buttonInteractionQueues.add(current);
    void current.then(
      () => this.buttonInteractionQueues.delete(current),
      () => this.buttonInteractionQueues.delete(current),
    );
    return current;
  }

  private async processAcceptedButtonInteraction(
    i: ButtonInteractionLike,
    acknowledged: Promise<void>,
    acceptedContext: { inboundConfigVersion: number; ownerUserId: string },
  ): Promise<void> {
    await acknowledged.catch(() => undefined);
    if (
      this.disposing ||
      this.inboundConfigVersion !== acceptedContext.inboundConfigVersion ||
      this.ownerUserId !== acceptedContext.ownerUserId
    ) {
      return;
    }
    const event = parseInteraction(i);
    if (!event) {
      await this.notifyExpiredInteraction(i);
      return;
    }
    if (event.senderId !== acceptedContext.ownerUserId) return;
    if (event.buttonId === DISCORD_CARD_PAGE_BUTTON_ID) {
      await this.handleCardPageInteraction(event, i);
      return;
    }

    const handlers: Promise<void>[] = [];
    for (const h of this.cardActionHandlers) {
      try {
        handlers.push(Promise.resolve(h(event)));
      } catch {
        /* swallow */
      }
    }
    await Promise.allSettled(handlers);
  }

  private async drainSchedulerHandoffWork(): Promise<void> {
    while (
      this.dmMessageQueues.size > 0
      || this.buttonInteractionQueues.size > 0
      || this.acceptedTasks.size > 0
    ) {
      await Promise.allSettled([
        ...this.dmMessageQueues.values(),
        ...this.buttonInteractionQueues,
        ...this.acceptedTasks,
      ]);
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
      const lease = this.captureOutboundLease();
      const message = await this.fetchMessage(event.messageId);
      this.assertOutboundLease(lease);
      await message.edit({ content: '', ...buildCardMessage(spec, { page }) });
      this.assertOutboundLease(lease);
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

  private captureOutboundLease(): DiscordOutboundLease {
    const client = this.gateway.client;
    const identity = this.getSchedulerIdentity();
    if (!client || !identity) throw new Error('discord gateway is not connected');
    const lease = { client, configVersion: this.configVersion, identity };
    this.assertOutboundLease(lease);
    return lease;
  }

  private assertOutboundLease(lease: DiscordOutboundLease): void {
    if (
      this.disposing
      || this.configVersion !== lease.configVersion
      || this.gateway.client !== lease.client
      || this.getSchedulerIdentity() !== lease.identity
      || !this.schedulerOutboundAllowed(lease.identity)
    ) {
      throw new Error('DISCORD_SCHEDULER_STANDBY');
    }
  }

  private async sendTextWithLease(
    userId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const lease = this.captureOutboundLease();
    const channel = await this.requireDmChannel(userId);
    this.assertOutboundLease(lease);
    const result = await sendChunked(channel, text, () => this.assertOutboundLease(lease));
    return { messageId: result.firstMessageId };
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

  private async uploadImages(
    messageId: string,
    absPaths: string[],
    assertCurrent: () => void = () => {},
  ): Promise<void> {
    const { channelId } = decodeMessageId(messageId);
    assertCurrent();
    const client = this.gateway.client as unknown as {
      channels?: { fetch(channelId: string): Promise<unknown> };
    } | null;
    const channel = await client?.channels?.fetch(channelId);
    assertCurrent();
    const send = isRecord(channel) ? channel.send : null;
    if (typeof send !== 'function') return;
    const files = absPaths.map((absPath) => ({
      attachment: absPath,
      name: path.basename(absPath),
    }));
    for (const batch of batchDiscordUploadFiles(files)) {
      assertCurrent();
      await send.call(channel, { files: batch });
      assertCurrent();
    }
  }

  private async notifyExpiredInteraction(i: ButtonInteractionLike): Promise<void> {
    const interaction = i as ButtonInteractionLike & {
      followUp?: (payload: { content: string; ephemeral?: boolean }) => Promise<unknown>;
    };
    const notice = this.opts.expiredCardNotice ?? DEFAULT_EXPIRED_CARD_NOTICE;
    let lease: DiscordOutboundLease;
    try {
      lease = this.captureOutboundLease();
    } catch {
      return;
    }
    if (typeof interaction.followUp === 'function') {
      try {
        this.assertOutboundLease(lease);
        await interaction.followUp({ content: notice, ephemeral: true });
        this.assertOutboundLease(lease);
        return;
      } catch {
        /* fall back to DM below */
      }
    }

    try {
      const channel = await this.requireDmChannel(i.user.id);
      this.assertOutboundLease(lease);
      await sendChunked(channel, notice, () => this.assertOutboundLease(lease));
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
