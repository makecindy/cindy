import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BaseIM } from '../BaseIM.js';
import type { TextChannelIM, ImFinalOutput } from '../channelIM.js';
import type { IMHost, IMMessageEvent, IMStatus, SendFileResult } from '../types.js';
import { classifyInboundAttachment, UnsupportedInboundMediaError } from '../inboundKind.js';
import { isPrivateListener, LocalWebhookReceiver } from '../localWebhook.js';
import { BlueBubblesApi, blueBubblesOrigin, BLUEBUBBLES_MAX_BYTES, type BlueBubblesChat } from './api.js';
import { BlueBubblesReceipts, type BlueBubblesStateStorage } from './state.js';

export interface BlueBubblesConfig {
  serverUrl: string;
  ownerAddress: string;
  chatGuids: string[];
  listenHost: string;
  listenPort: number;
  groupAliases?: string[];
}

export function parseBlueBubblesConfig(raw: unknown): BlueBubblesConfig {
  if (!raw || typeof raw !== 'object') throw new Error('BLUEBUBBLES_INVALID_CONFIG');
  const r = raw as Record<string, unknown>;
  if (typeof r.serverUrl !== 'string' || typeof r.ownerAddress !== 'string' || !r.ownerAddress.trim()
    || r.ownerAddress.length > 320 || typeof r.listenHost !== 'string' || !isPrivateListener(r.listenHost)
    || !Number.isInteger(r.listenPort) || (r.listenPort as number) < 1024 || (r.listenPort as number) > 65535
    || (r.groupAliases !== undefined && (!Array.isArray(r.groupAliases) || r.groupAliases.length > 20
      || r.groupAliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 100)))
    || !Array.isArray(r.chatGuids) || !r.chatGuids.length || r.chatGuids.length > 100
    || r.chatGuids.some(guid => typeof guid !== 'string' || !/^(?:iMessage|any);[-+];[^\r\n]{1,480}$/.test(guid))) {
    throw new Error('BLUEBUBBLES_INVALID_CONFIG');
  }
  return { serverUrl: blueBubblesOrigin(r.serverUrl), ownerAddress: r.ownerAddress.trim().toLowerCase(),
    groupAliases: (r.groupAliases as string[] | undefined) ?? ['Cindy'],
    chatGuids: [...new Set(r.chatGuids as string[])], listenHost: r.listenHost, listenPort: r.listenPort as number };
}

export interface BlueBubblesOptions {
  secretPrefix: string;
  storage: BlueBubblesStateStorage;
  receiver(host: string, port: number): LocalWebhookReceiver;
  api?(origin: string, password: string): BlueBubblesApi;
  resolvePeers?(hostname: string): Promise<string[]>;
  now?(): number;
}

type Handler = (event: IMMessageEvent) => void | Promise<void>;
export const BLUEBUBBLES_SECRET_KEYS = ['bluebubbles-origin', 'bluebubbles-config', 'bluebubbles-password', 'bluebubbles-webhook-token'] as const;

export class BlueBubblesIM extends BaseIM implements TextChannelIM {
  private status: IMStatus = { kind: 'idle' };
  private readonly messages = new Set<Handler>();
  private readonly statuses = new Set<(status: IMStatus) => void>();
  private config: BlueBubblesConfig | null = null;
  private api: BlueBubblesApi | null = null;
  private receipts: BlueBubblesReceipts | null = null;
  private readonly chats = new Map<string, BlueBubblesChat>();
  private generation = 0;
  private account: unknown | null = null;
  private webhookUrl: string | null = null;
  private listener: { close(): Promise<void> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping: Promise<void> | null = null;
  private lastCatchUpAt: number | null = null;
  private lastWebhookAt: number | null = null;
  private readonly activeDispatches = new Set<string>();
  private readonly activeSends = new Set<string>();
  // Prepared inputs retain chat order until actual acceptance, including the
  // asynchronous interval before a handler reports busy or persists the message.
  private readonly deferredEvents = new Map<string, IMMessageEvent>();
  private readonly cancelledEvents = new WeakSet<IMMessageEvent>();
  private readonly eventSentAt = new WeakMap<IMMessageEvent, number>();
  private readonly pendingReplies = new Map<string, { requestId?: string; createdAt: number; accept(text: string): boolean; cancel(): void }>();

  constructor(host: IMHost, private readonly options: BlueBubblesOptions) { super('imessage', host); }
  registerIpc(): void { /* Partner connection IPC is owned by the host. */ }
  private key(key: string): string { return this.options.secretPrefix + key; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private live(generation: number): boolean {
    return this.generation === generation && (!this.host.accountScope || (this.account !== null && this.host.accountScope.isCurrent(this.account)));
  }
  private assertLive(generation: number): void { if (!this.live(generation)) throw new Error('BLUEBUBBLES_CONNECTION_CHANGED'); }
  private setStatus(status: IMStatus): void { this.status = status; for (const callback of this.statuses) callback(status); }
  getStatus(): IMStatus { return this.status; }
  onStatusChange(callback: (status: IMStatus) => void): () => void { this.statuses.add(callback); return () => this.statuses.delete(callback); }
  onMessage(callback: Handler): () => void { this.messages.add(callback); return () => this.messages.delete(callback); }
  acknowledgeIncoming(guid: string): void {
    // Called only by the host's persisted-user-message hook during this dispatch.
    if (this.activeDispatches.has(guid)) {
      this.receipts?.mark(guid, 'accepted');
      this.deferredEvents.delete(guid);
    }
  }
  get botContextId(): string { return this.config ? createHash('sha256').update(this.config.serverUrl).digest('hex').slice(0, 24) : ''; }
  getOwnerUserId(): string | null {
    return [...this.chats.values()].find(chat => /^(?:iMessage|any);-;/.test(chat.guid) && (chat.participants?.length ?? 0) === 1
      && chat.participants![0]!.address.toLowerCase() === this.config?.ownerAddress)?.guid ?? null;
  }
  isGroup(chatGuid: string): boolean { return /^(?:iMessage|any);\+;/.test(chatGuid) || (this.chats.get(chatGuid)?.participants?.length ?? 0) > 1; }
  isGroupInvocation(text: string): boolean {
    const current = text.split('\n').filter(line => !line.trimStart().startsWith('>')).join('\n')
      .replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|`[^`\n]*`/g, '');
    return (this.config?.groupAliases ?? []).some(alias => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(current);
    });
  }
  getChat(chatGuid: string): BlueBubblesChat | undefined { return this.chats.get(chatGuid); }
  health(): { lastCatchUpAt: number | null; lastWebhookAt: number | null; uncertainInputs: number; uncertainSends: number } {
    return { lastCatchUpAt: this.lastCatchUpAt, lastWebhookAt: this.lastWebhookAt,
      ...(this.receipts?.uncertainCounts(this.activeDispatches, this.activeSends)
        ?? { uncertainInputs: 0, uncertainSends: 0 }) };
  }

  async saveCredentials(input: BlueBubblesConfig & { password: string }): Promise<void> {
    const config = parseBlueBubblesConfig(input);
    if (!input.password || input.password.length > 4096 || !this.host.secrets.isAvailable()) throw new Error('BLUEBUBBLES_SECRET_UNAVAILABLE');
    // The host creates a fresh connection and rolls it back on failure.
    for (const [key, value] of [['bluebubbles-origin', config.serverUrl], ['bluebubbles-config', JSON.stringify(config)],
      ['bluebubbles-password', input.password], ['bluebubbles-webhook-token', randomBytes(32).toString('base64url')]]) {
      if (!this.host.secrets.write(this.key(key!), value!)) throw new Error('BLUEBUBBLES_SECRET_UNAVAILABLE');
    }
    new BlueBubblesReceipts(this.options.storage, this.now());
    await this.init();
    if (this.status.kind !== 'connected') throw new Error('BLUEBUBBLES_CONNECT_FAILED');
  }

  async clearCredentials(): Promise<void> {
    const api = this.api, url = this.webhookUrl, account = this.account;
    await this.dispose();
    if (api && url) await api.unregisterWebhook(url).catch(() => this.log.warn('iMessage callback cleanup failed; local receiver is stopped'));
    if (this.host.accountScope && (account === null || !this.host.accountScope.isCurrent(account))) return;
    this.webhookUrl = null;
    for (const key of BLUEBUBBLES_SECRET_KEYS) this.host.secrets.remove(this.key(key));
  }

  async init(): Promise<void> {
    await this.dispose();
    const generation = ++this.generation;
    this.account = this.host.accountScope?.capture() ?? null;
    this.setStatus({ kind: 'connecting' });
    try {
      const raw = this.host.secrets.read(this.key('bluebubbles-config'));
      const password = this.host.secrets.read(this.key('bluebubbles-password'));
      const token = this.host.secrets.read(this.key('bluebubbles-webhook-token'));
      if (!raw || !password || !token) throw new Error('BLUEBUBBLES_CONFIG_MISSING');
      const config = parseBlueBubblesConfig(JSON.parse(raw));
      const api = this.options.api?.(config.serverUrl, password) ?? new BlueBubblesApi(config.serverUrl, password);
      await api.info();
      this.assertLive(generation);
      for (const guid of config.chatGuids) {
        const chat = await api.chat(guid);
        this.assertLive(generation);
        if (chat.guid !== guid || !Array.isArray(chat.participants) || !chat.participants.length) throw new Error('BLUEBUBBLES_INVALID_CHAT');
        this.chats.set(guid, chat);
      }
      this.config = config;
      this.api = api;
      this.receipts = new BlueBubblesReceipts(this.options.storage, this.now());
      const hostname = new URL(config.serverUrl).hostname.replace(/^\[|\]$/g, '');
      const peers = this.options.resolvePeers ? await this.options.resolvePeers(hostname)
        : (await lookup(hostname, { all: true })).map(row => row.address);
      this.assertLive(generation);
      const listener = await this.options.receiver(config.listenHost, config.listenPort).add(token, peers, async body => {
        this.assertLive(generation);
        if (!body || typeof body !== 'object') return;
        const event = body as { type?: unknown; data?: { guid?: unknown } };
        if (event.type !== 'new-message' || typeof event.data?.guid !== 'string'
          || !/^[A-Za-z0-9_-]{1,256}$/.test(event.data.guid)) return;
        this.receipts!.receive(event.data.guid, this.now());
        this.lastWebhookAt = this.now();
        void this.pump(generation).catch(() => this.fail(generation));
      });
      if (!this.live(generation)) { await listener.close(); return; }
      this.listener = listener;
      this.webhookUrl = listener.url;
      await api.registerWebhook(listener.url);
      this.assertLive(generation);
      this.setStatus({ kind: 'connected', appId: this.botContextId });
      await this.catchUp(generation);
      this.schedule(generation);
    } catch {
      if (this.live(generation)) {
        await this.listener?.close(); this.listener = null;
        this.setStatus({ kind: 'error', reason: 'BLUEBUBBLES_CONNECT_FAILED' });
        this.timer = setTimeout(() => { if (this.live(generation)) void this.init(); }, 30_000);
        this.timer.unref?.();
      }
    }
  }

  async dispose(): Promise<void> {
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.timer = null;
    this.deferredTimer = null;
    this.pumping = null;
    this.activeDispatches.clear(); this.activeSends.clear();
    this.deferredEvents.clear();
    for (const pending of this.pendingReplies.values()) pending.cancel();
    this.pendingReplies.clear();
    const listener = this.listener;
    this.listener = null;
    await listener?.close();
    // Old async operations check generation before writing or dispatching.
    this.api = null; this.config = null; this.receipts = null; this.chats.clear();
    this.setStatus({ kind: 'idle' });
  }

  private fail(generation: number): void {
    if (this.live(generation)) this.setStatus({ kind: 'error', reason: 'BLUEBUBBLES_RECEIVE_FAILED' });
  }
  private schedule(generation: number): void {
    if (!this.live(generation)) return;
    this.timer = setTimeout(() => {
      void this.catchUp(generation).catch(() => this.fail(generation)).finally(() => this.schedule(generation));
    }, 300_000);
    this.timer.unref?.();
  }
  private retryDeferred(generation: number): void {
    if (!this.live(generation) || this.deferredTimer) return;
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      if (this.live(generation)) void this.pump(generation).catch(() => this.fail(generation));
    }, 1000);
    this.deferredTimer.unref?.();
  }
  async reconcile(): Promise<void> { await this.catchUp(this.generation); }
  private async catchUp(generation: number): Promise<void> {
    const api = this.api, config = this.config, receipts = this.receipts;
    if (!api || !config || !receipts) return;
    await api.info(); this.assertLive(generation);
    const before = this.now();
    for (const chat of config.chatGuids) {
      const after = Math.max(receipts.activatedAt, receipts.cursor(chat) - 300_000);
      let previousPage = '';
      for (let offset = 0; ; offset += 100) {
        const messages = await api.history(chat, after, before, offset);
        this.assertLive(generation);
        if (!Array.isArray(messages) || messages.length > 100 || offset >= 100_000) throw new Error('BLUEBUBBLES_INVALID_HISTORY');
        const fingerprint = messages.map(message => message.guid).join(',');
        if (messages.length && fingerprint === previousPage) throw new Error('BLUEBUBBLES_HISTORY_NOT_ADVANCING');
        previousPage = fingerprint;
        for (const message of messages) {
          if (typeof message.guid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(message.guid)) throw new Error('BLUEBUBBLES_INVALID_MESSAGE');
          if (!message.isFromMe && message.dateCreated >= receipts.activatedAt) receipts.receive(message.guid, before);
        }
        if (messages.length < 100) break;
      }
      receipts.setCursor(chat, before);
    }
    await this.pump(generation);
    this.assertLive(generation);
    this.lastCatchUpAt = before;
    this.setStatus({ kind: 'connected', appId: this.botContextId });
  }

  private pump(generation: number): Promise<void> {
    if (this.pumping) return this.pumping;
    const operation = this.drain(generation).finally(() => { if (this.pumping === operation) this.pumping = null; });
    this.pumping = operation;
    return operation;
  }
  private async drain(generation: number): Promise<void> {
    const api = this.api, config = this.config, receipts = this.receipts;
    if (!api || !config || !receipts || !this.messages.size) return;
    const attempted = new Set<string>();
    let hadFailure = false;
    for (;;) {
      this.assertLive(generation);
      const guid = receipts.nextPending(attempted, this.activeDispatches);
      if (!guid) {
        if (hadFailure) throw new Error('BLUEBUBBLES_RECEIVE_FAILED');
        return;
      }
      attempted.add(guid);
      try {
        let event = this.deferredEvents.get(guid);
        if (!event) {
          const message = await api.message(guid);
          this.assertLive(generation);
          const chat = message.chats?.find(item => config.chatGuids.includes(item.guid));
          const sender = message.handle?.address?.toLowerCase();
          if (message.guid !== guid || message.isFromMe || !chat || !sender || message.handle?.service !== 'iMessage'
            || !Number.isFinite(message.dateCreated) || message.dateCreated < receipts.activatedAt
            || (message.associatedMessageType !== undefined && message.associatedMessageType >= 2000)) {
            receipts.mark(guid, 'ignored'); continue;
          }
          event = { channelName: 'imessage', senderId: chat.guid, chatId: chat.guid,
            contextId: this.botContextId, messageId: guid, text: message.text ?? '', attachments: [], unsupported: [],
            speaker: { id: sender, name: sender, isOwner: sender === config.ownerAddress },
            interactionSource: { chatName: chat.displayName, senderName: sender },
            ...(this.isGroup(chat.guid) ? { ambient: !this.isGroupInvocation(message.text ?? ''),
              invoked: this.isGroupInvocation(message.text ?? '') } : {}) };
          this.eventSentAt.set(event, message.dateCreated);
          for (const attachment of message.attachments ?? []) {
            const name = attachment.transferName || attachment.guid;
            if ((attachment.totalBytes ?? 0) > BLUEBUBBLES_MAX_BYTES) { event.unsupported.push({ type: 'oversize', label: name }); continue; }
            const bytes = await api.download(attachment.guid); this.assertLive(generation);
            const kind = classifyInboundAttachment(attachment.mimeType, name);
            let stored: { absPath: string; url?: string; mimeType?: string; discard?: () => Promise<void> } | null | undefined;
            try {
              stored = kind.kind === 'file'
              ? await this.host.files?.stage({ integration: 'imessage', buffer: bytes, fileName: name })
              : kind.kind === 'image'
                ? await this.host.media?.cacheImage({ integration: 'imessage', token: `${this.botContextId}:${attachment.guid}`, buffer: bytes, mimeType: kind.mimeType, staging: true })
                : await this.host.media?.cacheMedia?.({ integration: 'imessage', token: `${this.botContextId}:${attachment.guid}`, buffer: bytes, mimeType: kind.mimeType });
            } catch (error) {
              if (!(error instanceof UnsupportedInboundMediaError)) throw error;
              event.unsupported.push({ type: 'unsupported', label: name });
              continue;
            }
            if (!this.live(generation)) { await stored?.discard?.(); return; }
            if (!stored) { event.unsupported.push({ type: 'unsupported', label: name }); continue; }
            event.attachments.push({ kind: kind.kind === 'image' ? 'image' : 'file', absPath: stored.absPath,
              originalName: name, mimeType: 'mimeType' in stored && stored.mimeType ? stored.mimeType : kind.mimeType,
              ...(stored.url ? { url: stored.url } : {}) });
          }
        }
        const pending = this.pendingReplies.get(event.chatId);
        const command = event.text.trim().toLowerCase();
        const stop = event.attachments.length === 0 && event.unsupported.length === 0
          && ['/stop', '!stop', '！stop'].includes(command);
        if (pending && stop && event.speaker?.isOwner) {
          this.pendingReplies.delete(event.chatId);
          pending.cancel();
        }
        // Both the first observation and the verified send time must follow this request.
        // Deferred retries and delayed historical delivery are never confirmation answers.
        if (!stop && pending && receipts.receivedAfter(guid, pending.createdAt)
          && (this.eventSentAt.get(event) ?? 0) > pending.createdAt) {
          receipts.mark(guid, 'dispatching');
          if (pending.accept(event.text)) {
            receipts.mark(guid, 'accepted'); continue;
          }
          receipts.mark(guid, 'pending');
        }
        let blocked = false;
        for (const [id, earlier] of this.deferredEvents) {
          if (id === guid) break;
          if (earlier.chatId === event.chatId) { blocked = true; break; }
        }
        this.deferredEvents.set(guid, event);
        if (!stop && blocked) {
          // Replies above and stop commands bypass ordinary work; another chat
          // can still progress while this chat waits for its oldest input.
          this.retryDeferred(generation);
          continue;
        }
        // An interrupted dispatch is visible as uncertain; never blindly repeat model side effects.
        receipts.mark(guid, 'dispatching');
        this.activeDispatches.add(guid);
        let awaitPersistence = false, deferred = false;
        event.delivery = {
          isCancelled: () => this.cancelledEvents.has(event!),
          cancelPending: () => {
            this.assertLive(generation);
            let count = 0;
            for (const [id, queued] of this.deferredEvents) {
              // Only withdraw inputs preceding this command. Preparation may
              // hold the chat lock while later work is already being received.
              if (id === guid) break;
              if (queued.chatId !== event!.chatId) continue;
              receipts.mark(id, 'ignored');
              this.cancelledEvents.add(queued);
              this.deferredEvents.delete(id);
              count++;
            }
            return count;
          },
          awaitPersistence: () => { this.assertLive(generation); awaitPersistence = true; },
          defer: () => {
            this.assertLive(generation);
            if (this.cancelledEvents.has(event!)) return;
            receipts.mark(guid, 'pending');
            this.deferredEvents.set(guid, event!);
            deferred = true;
          },
          accept: () => {
            this.assertLive(generation);
            if (!this.cancelledEvents.has(event!)) {
              receipts.mark(guid, 'accepted');
              this.deferredEvents.delete(guid);
            }
          },
        };
        // Do not block ingress on a model turn: its confirmation reply arrives on this same receiver.
        void Promise.all([...this.messages].map(callback => Promise.resolve().then(() => {
          this.assertLive(generation);
          return callback(event!);
        }))).then(() => {
          if (this.live(generation) && !awaitPersistence && !deferred && !this.cancelledEvents.has(event!)) {
            receipts.mark(guid, 'accepted');
            this.deferredEvents.delete(guid);
          }
        }).catch(() => this.fail(generation)).finally(() => {
          if (this.live(generation)) {
            this.activeDispatches.delete(guid);
            if (!deferred) this.deferredEvents.delete(guid);
            if (deferred) this.retryDeferred(generation);
            this.setStatus(this.status);
          }
        });
      } catch {
        this.assertLive(generation);
        // Keep the receipt pending for recovery, but let other chats/messages proceed.
        hadFailure = true;
      }
    }
  }

  private target(chatId: string): { api: BlueBubblesApi; receipts: BlueBubblesReceipts; generation: number } {
    const generation = this.generation;
    this.assertLive(generation);
    if (!this.api || !this.receipts || !this.config?.chatGuids.includes(chatId)) throw new Error('BLUEBUBBLES_CHAT_NOT_CONNECTED');
    return { api: this.api, receipts: this.receipts, generation };
  }
  private async send(chatId: string, operation: (api: BlueBubblesApi, id: string) => Promise<{ guid: string }>): Promise<{ messageId: string }> {
    const { api, receipts, generation } = this.target(chatId);
    const id = randomUUID();
    receipts.outgoing(id, { chatId, state: 'sending' });
    let sent = false;
    this.activeSends.add(id);
    try {
      const result = await operation(api, id);
      if (!result || typeof result.guid !== 'string' || !result.guid) throw new Error('BLUEBUBBLES_SEND_UNKNOWN');
      // This captured ledger belongs to the original account even after disconnect.
      receipts.outgoing(id, { chatId, state: 'sent', messageId: result.guid });
      sent = true;
      this.assertLive(generation);
      return { messageId: result.guid };
    } catch {
      if (!sent) receipts.outgoing(id, { chatId, state: 'unknown' });
      throw new Error('BLUEBUBBLES_SEND_UNKNOWN');
    } finally {
      if (this.live(generation)) { this.activeSends.delete(id); this.setStatus(this.status); }
    }
  }
  async readHistory(chatId: string, after: number, before: number, offset = 0) {
    const { api, generation } = this.target(chatId);
    const rows = await api.history(chatId, after, before, offset);
    this.assertLive(generation);
    return rows.filter(row => row.chats?.some(chat => chat.guid === chatId));
  }
  listChats(): BlueBubblesChat[] { return [...this.chats.values()].map(chat => structuredClone(chat)); }
  sendText(chatId: string, text: string): Promise<{ messageId: string }> { return this.send(chatId, (api, id) => api.sendText(chatId, text, id)); }
  sendMarkdownText(chatId: string, text: string): Promise<{ messageId: string }> { return this.sendText(chatId, text); }
  async sendFile(chatId: string, absPath: string, displayName?: string): Promise<SendFileResult> {
    const { generation } = this.target(chatId);
    let bytes: Buffer;
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return { ok: false, reason: 'NOT_FOUND' };
      if (!stat.size) return { ok: false, reason: 'EMPTY' };
      if (stat.size > BLUEBUBBLES_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE' };
      bytes = await fs.readFile(absPath);
    } catch { return { ok: false, reason: 'NOT_FOUND' }; }
    this.assertLive(generation);
    if (bytes.length > BLUEBUBBLES_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    const name = path.basename(displayName ?? absPath);
    try { return { ok: true, ...await this.send(chatId, (api, id) => api.sendFile(chatId, bytes, name, id)) }; }
    catch { return { ok: false, reason: 'SEND_FAIL' }; }
  }
  async commitFinal(output: ImFinalOutput): Promise<void> {
    if (output.text.trim() && output.text.trim() !== 'NO_REPLY') await this.sendText(output.userId, output.text);
    for (const file of new Set(output.mediaAbsPaths ?? [])) {
      const result = await this.sendFile(output.userId, file);
      if (!result.ok) throw new Error('BLUEBUBBLES_FILE_SEND_FAILED');
    }
  }
  cancelTextReply(requestId: string): boolean {
    for (const [chatId, pending] of this.pendingReplies) {
      if (pending.requestId !== requestId) continue;
      this.pendingReplies.delete(chatId);
      pending.cancel();
      return true;
    }
    return false;
  }
  async requestTextReply<T>(chatId: string, prompt: string, parse: (text: string) => T | null, timeoutMs = 30 * 60_000,
    shared?: { result: Promise<T>; decide(value: T): boolean }, requestId?: string): Promise<T> {
    if (this.pendingReplies.has(chatId)) {
      if (shared) return shared.result;
      throw new Error('BLUEBUBBLES_INTERACTION_PENDING');
    }
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    let answered = false;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    // Attach a rejection consumer before sending (disconnect may race the send).
    void result.catch(() => {});
    const retire = () => {
      clearTimeout(timer);
      if (this.pendingReplies.get(chatId) === pending) this.pendingReplies.delete(chatId);
    };
    const pending = { requestId, createdAt: this.now(), accept: (text: string) => {
      const value = parse(text); if (value === null) return false;
      if (shared) shared.decide(value);
      else { answered = true; retire(); resolve(value); }
      return true;
    }, cancel: () => { retire(); reject(new Error('BLUEBUBBLES_INTERACTION_CANCELLED')); } };
    const timer = setTimeout(pending.cancel, timeoutMs);
    this.pendingReplies.set(chatId, pending);
    if (shared) void shared.result.then(value => { retire(); resolve(value); }, error => { retire(); reject(error); });
    try {
      try { await this.sendText(chatId, prompt); }
      catch (error) {
        if (!shared && !answered) throw error;
        // A reply can arrive after prompt delivery but before its HTTP response.
        // Keep that accepted answer even if the presentation request fails late.
        // Shared Desktop/Mobile permissions also keep their own lifecycle;
        // a failed presentation is not a denial. Remove only this waiter.
        retire();
      }
      return await result;
    }
    finally {
      retire();
    }
  }
}
