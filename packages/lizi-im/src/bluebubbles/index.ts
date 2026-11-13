import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BaseIM } from '../BaseIM.js';
import type { TextChannelIM, ImFinalOutput } from '../channelIM.js';
import type { IMHost, IMMessageEvent, IMStatus, SendFileResult } from '../types.js';
import { classifyInboundAttachment, UnsupportedInboundMediaError } from '../inboundKind.js';
import { isPrivateListener, LocalWebhookReceiver } from '../localWebhook.js';
import { BlueBubblesApi, BlueBubblesApiError, blueBubblesOrigin, BLUEBUBBLES_MAX_BYTES, type BlueBubblesChat, type BlueBubblesMessage } from './api.js';
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
  /** Host-persisted route identity survives a server address edit. */
  contextId?(): string | null;
  storage: BlueBubblesStateStorage;
  receiver(host: string, port: number): LocalWebhookReceiver;
  api?(origin: string, password: string): BlueBubblesApi;
  resolvePeers?(hostname: string): Promise<string[]>;
  now?(): number;
}

type Handler = (event: IMMessageEvent) => void | Promise<void>;
class BlueBubblesReceiveError extends Error {
  constructor() { super('BLUEBUBBLES_RECEIVE_FAILED'); }
}
export const BLUEBUBBLES_SECRET_KEYS = ['bluebubbles-origin', 'bluebubbles-config', 'bluebubbles-password', 'bluebubbles-webhook-token'] as const;

export class BlueBubblesIM extends BaseIM implements TextChannelIM {
  private status: IMStatus = { kind: 'idle' };
  private readonly messages = new Set<Handler>();
  private readonly statuses = new Set<(status: IMStatus) => void>();
  private config: BlueBubblesConfig | null = null;
  private api: BlueBubblesApi | null = null;
  private receipts: BlueBubblesReceipts | null = null;
  private pendingEdit: object | null = null;
  private readonly chats = new Map<string, BlueBubblesChat>();
  private generation = 0;
  private account: unknown | null = null;
  private webhookUrl: string | null = null;
  private listener: { close(): Promise<void> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredDueAt: number | null = null;
  private pumping: Promise<void> | null = null;
  private pumpRequested = false;
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly lookups = new Map<string, Promise<void>>();
  private readonly metadata = new Map<string, BlueBubblesMessage | null>();
  private recovering = false;
  private recovery: Promise<void> | null = null;
  private receiveFailure: 'input' | 'other' | null = null;
  private readonly retryAt = new Map<string, number>();
  private partialCleanup = new Map<string, Array<() => Promise<void>>>();
  private lastCatchUpAt: number | null = null;
  private lastWebhookAt: number | null = null;
  private readonly activeDispatches = new Set<string>();
  private readonly activeSends = new Set<string>();
  // Prepared inputs retain chat order until actual acceptance, including the
  // asynchronous interval before a handler reports busy or persists the message.
  private readonly deferredEvents = new Map<string, IMMessageEvent>();
  // Verified inputs enter in queue order before downloading/staging. Failed
  // preparation remains cancellable even though it is not ready for dispatch.
  private readonly pendingInputs = new Map<string, IMMessageEvent>();
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
      this.pendingInputs.delete(guid);
      this.retryAt.delete(guid);
    }
  }
  get botContextId(): string { return this.options.contextId?.() || (this.config ? createHash('sha256').update(this.config.serverUrl).digest('hex').slice(0, 24) : ''); }
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
    // Registration succeeded; a retryable input fault must not make the host
    // delete this connection, its credentials and its already-durable inbox.
    if (this.status.kind !== 'connected'
      && !(this.listener && this.api && this.config && this.receiveFailure === 'input')) throw new Error('BLUEBUBBLES_CONNECT_FAILED');
  }

  /** Public settings omit secrets; edits never reset the durable receipt journal. */
  getEditableConfig(): BlueBubblesConfig {
    const raw = this.host.secrets.read(this.key('bluebubbles-config'));
    if (!raw) throw new Error('BLUEBUBBLES_CONFIG_MISSING');
    return parseBlueBubblesConfig(JSON.parse(raw));
  }

  async updateCredentials(input: BlueBubblesConfig & { password?: string }): Promise<void> {
    const config = parseBlueBubblesConfig(input);
    const previous = BLUEBUBBLES_SECRET_KEYS.map(key => {
      const result = this.host.secrets.readResult?.(this.key(key)) ?? { kind: 'error' as const };
      if (result.kind === 'error') throw new Error('BLUEBUBBLES_SECRET_UNAVAILABLE');
      return [key, result.kind === 'value' ? result.value : null] as const;
    });
    const password = input.password || previous.find(([key]) => key === 'bluebubbles-password')?.[1];
    if (!password || password.length > 4096 || !this.host.secrets.isAvailable()) throw new Error('BLUEBUBBLES_SECRET_UNAVAILABLE');
    const previousConfig = parseBlueBubblesConfig(JSON.parse(previous.find(([key]) => key === 'bluebubbles-config')?.[1] ?? 'null'));
    const addedChats = config.chatGuids.filter(chat => !previousConfig.chatGuids.includes(chat));
    const account = this.host.accountScope?.capture();
    let expectedGeneration = this.generation;
    const current = () => this.generation === expectedGeneration
      && (!this.host.accountScope || this.host.accountScope.isCurrent(account));
    const cleanup = async () => {
      const api = this.api, url = this.webhookUrl;
      const disposedGeneration = this.generation + 1;
      await this.dispose();
      if (api && url) await api.unregisterWebhook(url).catch(() => this.log.warn('iMessage callback cleanup failed; local receiver is stopped'));
      this.webhookUrl = null;
      return disposedGeneration;
    };
    expectedGeneration = await cleanup();
    if (!current()) throw new Error('BLUEBUBBLES_CONNECTION_CHANGED');
    const edit = {};
    this.pendingEdit = edit;
    try {
      new BlueBubblesReceipts(this.options.storage, this.now()).activateChats(addedChats, this.now());
      // init disposes the previous generation, then starts a new one.
      const beforeSave = this.generation;
      try { await this.saveCredentials({ ...config, password }); }
      finally {
        // A synchronous storage failure has not entered init yet.
        expectedGeneration = beforeSave + (this.generation === beforeSave ? 0 : 2);
      }
    } catch {
      if (!current()) throw new Error('BLUEBUBBLES_CONNECTION_CHANGED');
      this.pendingEdit = null;
      expectedGeneration = await cleanup();
      if (current()) {
        for (const [key, value] of previous) {
          if (value === null) this.host.secrets.remove(this.key(key));
          else if (!this.host.secrets.write(this.key(key), value)) throw new Error('BLUEBUBBLES_SECRET_UNAVAILABLE');
        }
        await this.init();
      }
      throw new Error('BLUEBUBBLES_UPDATE_FAILED');
    } finally {
      if (this.pendingEdit === edit) this.pendingEdit = null;
    }
    // Only a committed configuration may classify or dispatch pending inputs.
    // Later ingress faults do not roll back an already saved edit.
    if (current()) {
      const generation = this.generation;
      await this.pump(generation).catch(error => this.fail(generation, error));
    }
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
    this.recovering = true;
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
        void this.pump(generation).catch(error => this.fail(generation, error));
      });
      if (!this.live(generation)) { await listener.close(); return; }
      this.listener = listener;
      this.webhookUrl = listener.url;
      await api.registerWebhook(listener.url);
      this.assertLive(generation);
      this.setStatus({ kind: 'connected', appId: this.botContextId });
      await this.catchUp(generation, false);
      this.schedule(generation);
    } catch (error) {
      if (this.live(generation)) {
        // A registered listener is still healthy when only individual inputs
        // failed preparation. Their local retry must not disconnect other chats.
        if (error instanceof BlueBubblesReceiveError) {
          this.fail(generation, error);
          this.schedule(generation);
          return;
        }
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
    this.deferredDueAt = null;
    this.pumping = null;
    this.pumpRequested = false;
    this.preparations.clear();
    this.lookups.clear();
    this.metadata.clear();
    this.recovering = false;
    this.recovery = null;
    this.receiveFailure = null;
    this.retryAt.clear();
    const cleanup = this.partialCleanup;
    this.partialCleanup = new Map();
    await Promise.allSettled([...cleanup.keys()].map(guid => this.discardPartial(cleanup, guid)));
    this.activeDispatches.clear(); this.activeSends.clear();
    this.deferredEvents.clear();
    this.pendingInputs.clear();
    for (const pending of this.pendingReplies.values()) pending.cancel();
    this.pendingReplies.clear();
    const listener = this.listener;
    this.listener = null;
    await listener?.close();
    // Old async operations check generation before writing or dispatching.
    this.api = null; this.config = null; this.receipts = null; this.chats.clear();
    this.setStatus({ kind: 'idle' });
  }

  private fail(generation: number, error: unknown): void {
    if (!this.live(generation)) return;
    // A successful local retry cannot clear a history, persistence or handler fault.
    this.receiveFailure = error instanceof BlueBubblesReceiveError && this.receiveFailure !== 'other' ? 'input' : 'other';
    this.setStatus({ kind: 'error', reason: 'BLUEBUBBLES_RECEIVE_FAILED' });
  }
  private schedule(generation: number): void {
    if (!this.live(generation)) return;
    this.timer = setTimeout(() => {
      void this.catchUp(generation).catch(error => this.fail(generation, error)).finally(() => this.schedule(generation));
    }, 300_000);
    this.timer.unref?.();
  }
  private retryDeferred(generation: number, delay = 1000): void {
    if (!this.live(generation)) return;
    const dueAt = this.now() + delay;
    if (this.deferredTimer && this.deferredDueAt !== null && this.deferredDueAt <= dueAt) return;
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredDueAt = dueAt;
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      this.deferredDueAt = null;
      if (this.live(generation)) void this.pump(generation).catch(error => this.fail(generation, error));
    }, delay);
    this.deferredTimer.unref?.();
  }
  async reconcile(): Promise<void> { await this.catchUp(this.generation); }
  private catchUp(generation: number, resumeOnFailure = true): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovering = true;
    const operation = this.recover(generation).catch(error => {
      if (resumeOnFailure) this.fail(generation, error);
      throw error;
    }).finally(() => {
      if (this.recovery !== operation) return;
      const interrupted = this.recovering;
      this.recovery = null;
      this.recovering = false;
      // Keep the history error visible, but release already-durable live ingress.
      // Startup failures retain init's existing listener teardown/reconnect path.
      if (interrupted && resumeOnFailure && this.live(generation)) {
        void this.pump(generation).catch(error => this.fail(generation, error));
      }
    });
    this.recovery = operation;
    return operation;
  }
  private async recover(generation: number): Promise<void> {
    const api = this.api, config = this.config, receipts = this.receipts;
    if (!api || !config || !receipts) return;
    // Finish or park preparation already in progress before enumerating history.
    await this.pumping?.catch(error => { if (!(error instanceof BlueBubblesReceiveError)) throw error; });
    this.assertLive(generation);
    await api.info(); this.assertLive(generation);
    const before = this.now();
    for (const chat of config.chatGuids) {
      const after = Math.max(receipts.activatedAtFor(chat), receipts.cursor(chat) - 300_000);
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
          if (!message.isFromMe && message.dateCreated >= receipts.activatedAtFor(chat)) receipts.receive(message.guid, before);
        }
        if (messages.length < 100) break;
      }
      receipts.setCursor(chat, before);
    }
    const prefetched = new Map<string, BlueBubblesMessage | null>();
    // A fixed watermark includes history and live receipts observed so far.
    // Later webhooks remain durable but cannot extend this recovery gate forever.
    const watermark = new Set(receipts.pendingGuids());
    for (const guid of watermark) {
      if ((this.retryAt.get(guid) ?? 0) > this.now() || this.deferredEvents.has(guid)
        || this.lookups.has(guid) || this.metadata.has(guid)) continue;
      try {
        const message = await api.message(guid);
        this.assertLive(generation);
        prefetched.set(guid, message);
      } catch {
        this.assertLive(generation);
        prefetched.set(guid, null);
      }
    }
    const sentAt = (guid: string) => prefetched.get(guid)?.dateCreated ?? this.metadata.get(guid)?.dateCreated
      ?? this.eventSentAt.get(this.deferredEvents.get(guid)!) ?? Infinity;
    receipts.orderPending(receipts.pendingGuids().sort((a, b) => sentAt(a) - sentAt(b)));
    this.recovering = false;
    if (this.pendingEdit) {
      // Retain verified metadata for dispatch after the configuration commits.
      for (const [guid, message] of prefetched) this.metadata.set(guid, message);
      this.lastCatchUpAt = before;
      return;
    }
    // Reconciliation still waits for its inputs, while the ingress scanner stays
    // available to live controls and other chats during attachment I/O.
    for (;;) {
      await this.pump(generation, prefetched).catch(error => {
        if (!(error instanceof BlueBubblesReceiveError)) throw error;
      });
      const waiting = [...this.lookups, ...this.preparations].filter(([guid]) => watermark.has(guid));
      if (!waiting.length) break;
      await Promise.all(waiting.map(([, operation]) => operation));
      this.assertLive(generation);
    }
    if (this.retryAt.size) throw new BlueBubblesReceiveError();
    this.assertLive(generation);
    this.lastCatchUpAt = before;
    this.receiveFailure = null;
    this.setStatus({ kind: 'connected', appId: this.botContextId });
  }

  private pump(generation: number, prefetched?: ReadonlyMap<string, BlueBubblesMessage | null>): Promise<void> {
    if (this.recovering) return Promise.resolve();
    if (this.pumping) { this.pumpRequested = true; return this.pumping; }
    const operation = (async () => {
      let inputFailure: BlueBubblesReceiveError | undefined;
      do {
        this.pumpRequested = false;
        await this.drain(generation, prefetched).catch(error => {
          if (!(error instanceof BlueBubblesReceiveError)) throw error;
          inputFailure = error;
        });
      } while (this.pumpRequested && this.live(generation) && !this.recovering);
      if (inputFailure && this.retryAt.size) throw inputFailure;
    })().finally(() => { if (this.pumping === operation) this.pumping = null; });
    this.pumping = operation;
    return operation;
  }
  private async drain(generation: number, prefetched?: ReadonlyMap<string, BlueBubblesMessage | null>): Promise<void> {
    const api = this.api, config = this.config, receipts = this.receipts;
    if (!api || !config || !receipts || !this.messages.size || this.pendingEdit) return;
    const attempted = new Set<string>();
    for (const [guid, dueAt] of this.retryAt) if (dueAt > this.now()) attempted.add(guid);
    for (;;) {
      this.assertLive(generation);
      for (const id of this.retryAt.keys()) if (!receipts.isPending(id)) this.retryAt.delete(id);
      if (this.recovering) return;
      const guid = receipts.nextPending(attempted, new Set([...this.activeDispatches, ...this.preparations.keys(), ...this.lookups.keys()]));
      if (!guid) {
        if (this.retryAt.size) {
          let delay = Infinity;
          for (const [id, dueAt] of this.retryAt) {
            // In-flight or slot-waiting retries wake on completion; their old
            // deadline must not install a new 1 ms timer throughout slow I/O.
            if (this.lookups.has(id) || this.preparations.has(id) || this.activeDispatches.has(id)
              || this.metadata.has(id)) continue;
            delay = Math.min(delay, Math.max(1, dueAt - this.now()));
          }
          if (Number.isFinite(delay)) this.retryDeferred(generation, delay);
          throw new BlueBubblesReceiveError();
        }
        if (this.receiveFailure === 'input') {
          this.receiveFailure = null;
          this.setStatus({ kind: 'connected', appId: this.botContextId });
        }
        return;
      }
      attempted.add(guid);
      let preparing = true;
      try {
        // Give the preceding host persistence/deferral callbacks a turn before
        // consulting the same-chat barrier, without waiting for a model turn.
        await Promise.resolve();
        this.assertLive(generation);
        if (this.recovering) return;
        let event = this.deferredEvents.get(guid);
        if (!event) {
          const cached = prefetched?.get(guid) ?? this.metadata.get(guid);
          if (!prefetched?.has(guid) && !this.metadata.has(guid)) {
            // Bound requests to the configured local server, while one stalled
            // GUID leaves independent slots for incoming controls. Never trust
            // webhook text/chat identity in place of this API verification.
            if (this.lookups.size < 4) {
              const operation = this.lookupMessage(generation, guid, api, receipts).finally(() => {
                if (!this.live(generation) || this.lookups.get(guid) !== operation) return;
                this.lookups.delete(guid);
                void this.pump(generation).catch(error => this.fail(generation, error));
              });
              this.lookups.set(guid, operation);
            }
            continue;
          }
          this.metadata.delete(guid);
          if (!cached) throw new BlueBubblesReceiveError();
          const message = cached;
          this.assertLive(generation);
          preparing = false;
          const chat = message.chats?.find(item => config.chatGuids.includes(item.guid));
          const sender = message.handle?.address?.toLowerCase();
          if (message.guid !== guid || message.isFromMe || !chat || !sender || message.handle?.service !== 'iMessage'
            || !Number.isFinite(message.dateCreated) || message.dateCreated < receipts.activatedAtFor(chat.guid)
            || (message.associatedMessageType !== undefined && message.associatedMessageType >= 2000)) {
            receipts.mark(guid, 'ignored'); this.pendingInputs.delete(guid); this.retryAt.delete(guid); continue;
          }
          if (receipts.wasStopped(guid, chat.guid, message.dateCreated)) {
            receipts.mark(guid, 'ignored'); this.pendingInputs.delete(guid); this.retryAt.delete(guid); continue;
          }
          event = { channelName: 'imessage', senderId: chat.guid, chatId: chat.guid,
            contextId: this.botContextId, messageId: guid, text: message.text ?? '', attachments: [], unsupported: [],
            speaker: { id: sender, name: sender, isOwner: sender === config.ownerAddress },
            interactionSource: { chatName: chat.displayName, senderName: sender },
            ...(this.isGroup(chat.guid) ? { ambient: !this.isGroupInvocation(message.text ?? ''),
              invoked: this.isGroupInvocation(message.text ?? '') } : {}) };
          this.eventSentAt.set(event, message.dateCreated);
          this.pendingInputs.set(guid, event);
          preparing = true;
          if (message.attachments?.length || this.partialCleanup.has(guid)) {
            // One attachment preparation per chat; controls have no attachments
            // and never wait for this slot. Other chats use independent slots.
            if ([...this.preparations.keys()].some(id => this.pendingInputs.get(id)?.chatId === event!.chatId)) {
              // The verified response remains reusable until this chat's slot
              // completes and wakes ingress; queued peers must not refetch it.
              this.metadata.set(guid, message);
              continue;
            }
            const ready = event;
            const operation = this.prepareAttachments(generation, guid, ready, message, api, receipts, this.partialCleanup)
              .finally(() => {
                if (!this.live(generation) || this.preparations.get(guid) !== operation) return;
                this.preparations.delete(guid);
                void this.pump(generation).catch(error => this.fail(generation, error));
              });
            this.preparations.set(guid, operation);
            continue;
          }
        }
        preparing = false;
        this.retryAt.delete(guid);
        if (this.recovering) { this.deferredEvents.set(guid, event); return; }
        if (this.cancelledEvents.has(event)) continue;
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
            receipts.mark(guid, 'accepted'); this.pendingInputs.delete(guid); this.retryAt.delete(guid); continue;
          }
          receipts.mark(guid, 'pending');
        }
        // An unresolved earlier identity might belong to this chat. Keep
        // ordinary work ordered until it settles; controls above bypass it.
        let blocked = false;
        for (const id of this.lookups.keys()) {
          if (receipts.receivedBefore(id, guid)) { blocked = true; break; }
        }
        // A lookup may settle after recovery sorts its unknown time to the tail.
        // Include the ready metadata until it becomes a verified event barrier.
        for (const [id, message] of this.metadata) {
          if (id !== guid && message?.chats?.some(chat => chat.guid === event.chatId)
            && (message.dateCreated < this.eventSentAt.get(event)!
              || (message.dateCreated === this.eventSentAt.get(event)! && receipts.receivedBefore(id, guid)))) {
            blocked = true; break;
          }
        }
        const sentAt = this.eventSentAt.get(event)!;
        for (const [id, earlier] of this.pendingInputs) {
          if (id === guid) continue;
          if (!this.deferredEvents.has(id) && !this.preparations.has(id)) continue;
          const earlierSentAt = this.eventSentAt.get(earlier)!;
          if (earlier.chatId === event.chatId && (earlierSentAt < sentAt
            || (earlierSentAt === sentAt && receipts.receivedBefore(id, guid)))) { blocked = true; break; }
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
            if (stop && event!.speaker?.isOwner) receipts.rememberStop(guid, event!.chatId, this.eventSentAt.get(event!)!);
            let count = 0;
            for (const [id, queued] of this.pendingInputs) {
              if (id === guid || queued.chatId !== event!.chatId
                || !receipts.wasStopped(id, queued.chatId, this.eventSentAt.get(queued)!)) continue;
              receipts.mark(id, 'ignored');
              this.cancelledEvents.add(queued);
              this.deferredEvents.delete(id);
              this.pendingInputs.delete(id);
              this.retryAt.delete(id);
              this.metadata.delete(id);
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
              this.pendingInputs.delete(guid);
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
            this.pendingInputs.delete(guid);
          }
        }).catch(error => this.fail(generation, error)).finally(() => {
          if (this.live(generation)) {
            this.activeDispatches.delete(guid);
            if (!deferred) { this.deferredEvents.delete(guid); this.pendingInputs.delete(guid); }
            if (deferred) this.retryDeferred(generation);
            this.setStatus(this.status);
          }
        });
      } catch (error) {
        this.assertLive(generation);
        // Receipt persistence failures still require connection-level recovery;
        // only message lookup/download/staging failures use the local retry.
        if (!preparing) throw error;
        if (!receipts.isPending(guid)) { this.retryAt.delete(guid); continue; }
        // Keep the receipt pending for recovery, but let other chats/messages proceed.
        this.retryAt.set(guid, this.now() + 30_000);
      }
    }
  }

  private async lookupMessage(generation: number, guid: string, api: BlueBubblesApi,
    receipts: BlueBubblesReceipts): Promise<void> {
    let message: BlueBubblesMessage | null;
    try { message = await api.message(guid); }
    catch { message = null; }
    if (this.live(generation) && receipts.isPending(guid)) this.metadata.set(guid, message);
  }

  private async prepareAttachments(generation: number, guid: string, event: IMMessageEvent,
    message: BlueBubblesMessage, api: BlueBubblesApi, receipts: BlueBubblesReceipts,
    cleanup: Map<string, Array<() => Promise<void>>>): Promise<void> {
    const staged: Array<() => Promise<void>> = [];
    try {
      await this.discardPartial(cleanup, guid);
      this.assertLive(generation);
      for (const attachment of message.attachments ?? []) {
        const name = attachment.transferName || attachment.guid;
        if ((attachment.totalBytes ?? 0) > BLUEBUBBLES_MAX_BYTES) { event.unsupported.push({ type: 'oversize', label: name }); continue; }
        let bytes: Uint8Array;
        try { bytes = await api.download(attachment.guid); }
        catch (error) {
          this.assertLive(generation);
          if (!(error instanceof BlueBubblesApiError) || error.code !== 'BLUEBUBBLES_RESPONSE_TOO_LARGE') throw error;
          event.unsupported.push({ type: 'oversize', label: name });
          continue;
        }
        this.assertLive(generation);
        if (this.cancelledEvents.has(event)) return;
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
        if (stored?.discard) staged.push(() => stored!.discard!());
        if (!this.live(generation)) return;
        if (this.cancelledEvents.has(event)) return;
        if (!stored) { event.unsupported.push({ type: 'unsupported', label: name }); continue; }
        event.attachments.push({ kind: kind.kind === 'image' ? 'image' : 'file', absPath: stored.absPath,
          originalName: name, mimeType: 'mimeType' in stored && stored.mimeType ? stored.mimeType : kind.mimeType,
          ...(stored.url ? { url: stored.url } : {}) });
      }
      if (!this.live(generation) || this.cancelledEvents.has(event) || !receipts.isPending(guid)) return;
      // Transfer ownership only once preparation is complete. The scanner handles
      // ordering, confirmation matching and durable dispatch as before.
      this.deferredEvents.set(guid, event);
      this.retryAt.delete(guid);
      staged.length = 0;
    } catch {
      if (!this.live(generation)) return;
      if (receipts.isPending(guid)) {
        this.retryAt.set(guid, this.now() + 30_000);
        this.fail(generation, new BlueBubblesReceiveError());
      } else this.retryAt.delete(guid);
    } finally {
      if (staged.length) {
        cleanup.set(guid, [...(cleanup.get(guid) ?? []), ...staged]);
        // Retain failed cleanup for the next attempt instead of leaking a prefix.
        await this.discardPartial(cleanup, guid).catch(() => {});
      }
    }
  }

  private async discardPartial(cleanup: Map<string, Array<() => Promise<void>>>, guid: string): Promise<void> {
    const remaining = cleanup.get(guid);
    while (remaining?.length) { await remaining[0]!(); remaining.shift(); }
    cleanup.delete(guid);
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
