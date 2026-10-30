import { MCP_APPS_INVOKE, isMcpAppLinkAuthorizationCurrent, type McpAppOpenResult, type McpAppHostEvent } from './mcpApps.js';

export type AppRpc = {
  jsonrpc: '2.0';
  method?: string;
  id?: string | number;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};
export type AppInvoker = (sessionId: string, input: Record<string, unknown>) => Promise<unknown>;
let nextOpenId = 0;

/** The UI is a transport only; official negotiation, schemas and permissions live on the Host. */
export class McpAppController {
  document?: McpAppOpenResult;
  private after = 0;
  private stopped = false;
  private closing = false;
  private teardownId?: string;
  private teardownDone?: Promise<void>;
  private finishTeardown?: () => void;
  private closePromise?: Promise<void>;
  private ready = false;
  private outbound: AppRpc[] = [];
  private initializeId?: string | number;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private readonly openId = `${Date.now()}:${++nextOpenId}`;
  constructor(
    private readonly invoke: AppInvoker,
    readonly sessionId: string,
    readonly clientId: string,
    private readonly post: (message: AppRpc) => void,
    private readonly onState: (message: AppRpc) => void,
    private readonly onError: (error: unknown) => void,
    private readonly openLink?: (url: string) => Promise<void>,
  ) {}

  async open(context: Record<string, unknown>): Promise<McpAppOpenResult | undefined> {
    const document = (await this.invoke(this.sessionId, {
      op: 'open',
      openId: this.openId,
      clientId: this.clientId,
      context,
    })) as McpAppOpenResult;
    this.document = document;
    if (this.closing) {
      await this.invoke(this.sessionId, { op: 'teardown', viewId: document.viewId });
      return;
    }
    // Resource loading has its own Host/remote budget. Give the App a complete
    // initialization window after the document reaches this controller.
    this.startupTimer = setTimeout(
      () => this.fail(new Error('MCP_APP_INITIALIZATION_TIMEOUT')),
      45_000,
    );
    if (document.transport !== 'sandbox') void this.poll();
    return document;
  }

  sandboxReady(resourceUrl?: string): void {
    if (!this.document || this.document.transport === 'sandbox' || this.ready || this.closing) return;
    this.ready = true;
    this.post({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: resourceUrl
        ? { html: this.document.html, resourceUrl }
        : { html: this.document.html },
    });
    this.outbound.splice(0).forEach((message) => this.post(message));
  }

  receive(message: AppRpc): void {
    if (this.stopped || !this.document || !message || message.jsonrpc !== '2.0') return;
    if (this.document.transport === 'sandbox') {
      if (message.method === 'ui/notifications/sandbox-failed')
        this.fail(new Error('MCP_APP_SANDBOX_FAILED'));
      if (this.closing) return;
      if (message.method === 'ui/notifications/sandbox-escape')
        void this.displayMode('inline').catch((error) => this.fail(error));
      if (message.method === 'ui/notifications/initialized') {
        clearTimeout(this.startupTimer);
        this.startupTimer = undefined;
      }
      if (['ui/notifications/initialized', 'ui/notifications/size-changed', 'ui/notifications/host-context-changed'].includes(message.method ?? ''))
        this.onState(message);
      return;
    }
    if (this.teardownId !== undefined && message.id === this.teardownId) {
      if (message.method === undefined && ('result' in message || 'error' in message))
        this.finishTeardown?.();
      return;
    }
    if (message.method === 'ui/notifications/sandbox-escape') {
      void this.displayMode('inline').catch((error) => this.fail(error));
      return;
    }
    if (message.method?.startsWith('ui/notifications/sandbox-')) return;
    if (this.closing && message.method) return;
    if (message.method === 'ui/initialize') this.initializeId = message.id;
    if (message.method === 'ui/notifications/initialized') {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.onState(message);
    void this.invoke(this.sessionId, {
      op: 'message',
      viewId: this.document.viewId,
      message,
    }).catch((error) => this.fail(error));
  }

  async context(context: Record<string, unknown>): Promise<void> {
    if (this.document && !this.closing)
      await this.invoke(this.sessionId, { op: 'context', viewId: this.document.viewId, context });
  }
  async displayMode(mode: 'inline' | 'fullscreen' | 'pip'): Promise<void> {
    if (this.document && !this.closing)
      await this.invoke(this.sessionId, { op: 'display-mode', viewId: this.document.viewId, mode });
  }
  private fail(error: unknown): void {
    if (this.closing) return;
    this.onError(error);
    this.prepareNativeClose();
    void this.close().catch(() => {});
  }

  private async poll(): Promise<void> {
    let failedAt = 0;
    let delay = 500;
    try {
      while (!this.stopped && this.document) {
        let events: Array<McpAppHostEvent<AppRpc>>;
        try {
          events = (await this.invoke(this.sessionId, {
            op: 'poll',
            viewId: this.document.viewId,
            after: this.after,
          })) as typeof events;
          if (!Array.isArray(events)) throw new Error('MCP_APP_INVALID_POLL');
          failedAt = 0;
          delay = 500;
        } catch (error) {
          if (this.closing) return;
          if (/MCP_APP_|CHANNEL_NOT_ALLOWED|NOT_FOUND/.test(String(error))) throw error;
          failedAt ||= Date.now();
          if (Date.now() - failedAt >= 30_000) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(5_000, delay * 2);
          continue;
        }
        if (this.stopped) return;
        for (const event of events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= this.after) continue;
          this.after = event.seq;
          if (event.openLink) {
            const viewId = this.document.viewId;
            void (async () => {
              let success = false;
              try {
                if (this.openLink && !this.closing) {
                  const requestedAt = performance.now();
                  const authorization = await this.invoke(this.sessionId, {
                    op: 'authorize-link',
                    viewId,
                    linkId: event.openLink.id,
                  });
                  if (
                    !isMcpAppLinkAuthorizationCurrent(authorization, performance.now() - requestedAt)
                  )
                    throw new Error('MCP_APP_LINK_NOT_AUTHORIZED');
                  // Closing can win while the execution Host checks the current card.
                  if (!this.closing && !this.stopped && this.document?.viewId === viewId) {
                    await this.openLink(event.openLink.url);
                    success = true;
                  }
                }
              } catch {
                /* Report the failed link action to the Host so its RPC can finish. */
              }
              if (!this.stopped && this.document?.viewId === viewId)
                await this.invoke(this.sessionId, {
                  op: 'link-result',
                  viewId,
                  linkId: event.openLink.id,
                  success,
                });
            })().catch((error) => this.fail(error));
            continue;
          }
          if (
            this.initializeId !== undefined &&
            event.message.id === this.initializeId &&
            event.message.error
          )
            throw new Error('MCP_APP_INITIALIZATION_FAILED');
          this.onState(event.message);
          if (this.ready) this.post(event.message);
          else this.outbound.push(event.message);
        }
        // Broken/legacy hosts must not cause a hot empty-poll loop.
        if (!events.length && !this.stopped)
          await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** Notify before native disposal; close() waits at most one second for the response. */
  prepareNativeClose(): void {
    if (!this.ready || this.document?.transport === 'sandbox' || this.closing || this.teardownId) return;
    this.teardownId = `cindy-teardown:${Date.now()}:${this.clientId}`;
    this.teardownDone = new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.finishTeardown?.(), 1_000);
      this.finishTeardown = () => {
        clearTimeout(timer);
        this.finishTeardown = undefined;
        resolve();
      };
    });
    this.post({ jsonrpc: '2.0', id: this.teardownId, method: 'ui/resource-teardown', params: {} });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeView();
    return this.closePromise;
  }

  private async closeView(): Promise<void> {
    this.closing = true;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    if (!this.document) {
      // Correlate cancellation even if transport timeout lost the View response.
      // Older v1 hosts may reject this additive operation; their idle lease still
      // reclaims the orphan, and a late successful response is closed by open().
      await this.invoke(this.sessionId, { op: 'cancel-open', openId: this.openId }).catch(() => {});
      return;
    }
    try {
      if (this.teardownDone) await this.teardownDone;
      await this.invoke(this.sessionId, {
        op: 'teardown',
        viewId: this.document.viewId,
        alreadyNotified: !!this.teardownId,
      });
    } finally {
      this.stopped = true;
      this.outbound = [];
    }
  }
}
export function mcpAppFailureKey(error: unknown): 'mcpApps.updateRequired' | 'mcpApps.loadFailed' {
  return /CHANNEL_NOT_ALLOWED|UNKNOWN_CHANNEL|CHANNEL_NOT_FOUND/.test(String(error))
    ? 'mcpApps.updateRequired'
    : 'mcpApps.loadFailed';
}
export { MCP_APPS_INVOKE };

export const MCP_APP_MAX_HEIGHT = 5_000;
/** Bound oscillating layouts; ordinary content growth uses only the height cap.
 * A width change starts a new layout; a lock otherwise lasts for this View. */
export class McpAppHeightGuard {
  private samples: Array<{ height: number; at: number }> = [];
  private locked?: number;
  private width?: number;
  constructor(private readonly onLock: () => void = () => {}) {}
  resize(width: number): void {
    if (this.width === width) return;
    this.width = width;
    this.samples = [];
    this.locked = undefined;
  }
  accept(value: number, now = Date.now()): number {
    if (this.locked !== undefined) return this.locked;
    const height = Math.max(80, Math.min(MCP_APP_MAX_HEIGHT, Math.ceil(value)));
    this.samples = this.samples.filter(sample => now - sample.at < 2_000);
    const previous = this.samples.at(-1);
    if (!previous || previous.height !== height) this.samples.push({ height, at: now });
    if (this.samples.length >= 8) {
      const recent = this.samples.slice(-8).map(sample => sample.height);
      const oscillating = recent.slice(2).every((h, i) =>
        (h - recent[i + 1]) * (recent[i + 1] - recent[i]) < 0);
      if (oscillating) {
        this.locked = recent[0];
        this.onLock();
        return this.locked;
      }
    }
    return height;
  }
}
