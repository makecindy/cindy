import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IMHost } from '@cindy/im';
import type { Logger } from '@cindy/maker-core';
import { fetchPublicImageBytes } from '@cindy/im-runtime/publicImageFetch';
import type { TerminalTaskHost } from '../tasks/host.js';

export class TerminalImTransportHost {
  readonly host: IMHost;
  private readonly handlers = new Map<string, (payload?: unknown) => unknown>();
  private readonly abort = new AbortController();
  private closed = false;
  private readonly cleanup = new AsyncLocalStorage<boolean>();
  constructor(private readonly options: {
    tasks: TerminalTaskHost;
    root: string;
    logger: Logger;
    secrets: { getSync(key: string): string | null; setSync(key: string, value: string): void; deleteSync(key: string): void; available(): boolean };
    assertCurrent(): void;
    emit(channel: string, payload: unknown): void;
  }) {
    const account = options.tasks.channelControl.account;
    const guard = () => this.guard();
    // Discord's shutdown receipt distinguishes a clean stop from an interrupted
    // offline announcement. Keep its original owner-bound marker writable while
    // admission is revoked; credentials never inherit this cleanup capability.
    const markerGuard = (key: string) => {
      if (!this.closed && this.cleanup.getStore() && key === 'discord-bot-runtime-active') return;
      guard();
    };
    this.host = {
      createLogger: scope => options.logger.child(scope),
      secrets: {
        read: key => { try { markerGuard(key); return options.secrets.getSync(key); } catch { return null; } },
        readResult: key => { try { markerGuard(key); const value = options.secrets.getSync(key); return value === null ? { kind: 'missing' } : { kind: 'value', value }; } catch { return { kind: 'error' }; } },
        write: (key, value) => { try { markerGuard(key); options.secrets.setSync(key, value); return true; } catch { options.logger.warn('IM_SECRET_WRITE_FAILED'); return false; } },
        remove: key => { markerGuard(key); options.secrets.deleteSync(key); },
        isAvailable: () => { try { if (!this.closed && this.cleanup.getStore()) return options.secrets.available(); guard(); return options.secrets.available(); } catch { return false; } },
      },
      accountScope: {
        capture: () => { try { guard(); return account.captureImAccountGeneration(); } catch { return null; } },
        isCurrent: token => { try { guard(); return typeof token === 'number' && account.isImAccountGenerationCurrent(token); } catch { return false; } },
        run: (token, operation) => {
          guard(); if (typeof token !== 'number') throw new Error('IM_ACCOUNT_SCOPE_CLOSED');
          return account.runInImAccountGeneration(token, async () => { guard(); const result = await operation(); guard(); return result; });
        },
      },
      paths: Object.fromEntries(['feishu', 'discord', 'telegram', 'wecom'].map(channel => [`${channel}MediaDir`, path.join(options.root, 'cc-agent', `${channel}-media`)])) as IMHost['paths'],
      files: { stage: async params => {
        guard(); const staged = await options.tasks.channelFiles.inboundFileStaging.stage(params);
        try { guard(); return staged; } catch (error) { await staged.discard(); throw error; }
      } },
      media: options.tasks.media.channelMedia(guard, message => options.logger.warn(message),
        async (url, maxBytes) => { guard(); const result = await fetchPublicImageBytes(url, maxBytes, undefined, { signal: this.abort.signal }); guard(); return result; }),
      ipc: {
        throwIpcError: (code, message): never => { throw Object.assign(new Error(message), { code }); },
        handle: (channel, handler) => {
          guard(); if (this.handlers.has(channel)) throw new Error(`DUPLICATE_IM_CHANNEL: ${channel}`);
          this.handlers.set(channel, handler);
        },
        broadcast: (channel, payload) => { if (!this.closed) { try { guard(); options.emit(channel, payload); } catch { /* Account already detached. */ } } },
      },
      httpPostForm: async (url, form) => {
        guard();
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) });
        const text = await response.text(); guard();
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = { error: text || `HTTP ${response.status}` }; }
        return { status: response.status, body };
      },
    };
  }
  private guard() {
    if (this.closed || this.options.tasks.channelControl.account.captureImAccountGeneration() === null) throw new Error('IM_ACCOUNT_SCOPE_CLOSED');
    this.options.assertCurrent();
  }
  channels() { return [...this.handlers.keys()]; }
  disposeConnection(operation: () => Promise<void>) { return this.cleanup.run(true, operation); }
  async invoke(channel: string, payload: unknown) {
    this.guard(); await this.options.tasks.ready; this.guard();
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error('CHANNEL_NOT_FOUND');
    const result = await handler(payload); this.guard(); return result;
  }
  close() { this.closed = true; this.abort.abort(); this.handlers.clear(); }
}
