import type { WebContents } from 'electron';

interface NetworkLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface ElectronDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

interface RequestRecord {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
}

interface ResponseRecord {
  requestId: string;
  url: string;
  status?: number;
  headers?: Record<string, string>;
  finished: boolean;
}

interface MonitorState {
  debugger: ElectronDebugger;
  ownedAttachment: boolean;
  enabled: boolean;
  requests: RequestRecord[];
  byRequestId: Map<string, RequestRecord>;
  responses: Map<string, ResponseRecord>;
  inFlight: Set<string>;
  lastActivityAt: number;
  messageHandler: (...args: unknown[]) => void;
  detachHandler: (...args: unknown[]) => void;
  destroyedHandler: (...args: unknown[]) => void;
}

const MAX_REQUESTS = 500;
const DEFAULT_BODY_CHARS = 200_000;
const MAX_BODY_CHARS = 1_000_000;
const DEFAULT_BODY_WAIT_MS = 20_000;
const MAX_BODY_WAIT_MS = 60_000;
const DEFAULT_IDLE_WINDOW_MS = 500;
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
]);

function boundedPositive(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(1, Math.floor(value)))
    : fallback;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[name] = String(raw);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return value;
  }
}

function urlMatches(pattern: string, url: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(url);
}

function debuggerFor(wc: WebContents): ElectronDebugger {
  const candidate = (wc as unknown as { debugger?: ElectronDebugger }).debugger;
  if (!candidate) throw new Error('webContents debugger is unavailable');
  return candidate;
}

/**
 * Keeps a bounded request history for each live RSB guest. The monitor owns a
 * debugger attachment only when it created one and releases that attachment
 * when the guest or backend is disposed.
 */
export class RsbWebviewNetwork {
  private readonly states = new Map<WebContents, MonitorState>();

  constructor(private readonly logger: NetworkLogger) {}

  async observe(wc: WebContents): Promise<void> {
    let state = this.states.get(wc);
    if (!state) {
      state = this.createState(wc);
      this.states.set(wc, state);
    }
    if (state.enabled && state.debugger.isAttached()) return;
    if (!state.debugger.isAttached()) {
      state.debugger.attach('1.3');
      state.ownedAttachment = true;
    }
    await state.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 16 * 1024 * 1024,
      maxResourceBufferSize: 4 * 1024 * 1024,
      maxPostDataSize: 256 * 1024,
    });
    state.enabled = true;
  }

  readRequests(
    wc: WebContents,
    options: { filter?: string; clear?: boolean } = {},
  ): RequestRecord[] {
    const state = this.states.get(wc);
    if (!state) return [];
    const filter = options.filter?.trim();
    const result = state.requests
      .filter((entry) => !filter || entry.url.includes(filter))
      .map((entry) => ({ ...entry }));
    if (options.clear === true) {
      state.requests = [];
      state.byRequestId.clear();
      state.responses.clear();
    }
    return result;
  }

  async readResponseBody(
    wc: WebContents,
    options: { url: string; maxChars?: number; timeoutMs?: number },
  ): Promise<{
    url: string;
    status?: number;
    headers?: Record<string, string>;
    body: string;
    truncated?: boolean;
  }> {
    const pattern = options.url.trim();
    if (!pattern) throw new Error('responseBody.url required');
    await this.observe(wc);
    const state = this.states.get(wc);
    if (!state) throw new Error('network monitor unavailable');
    const timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_BODY_WAIT_MS, MAX_BODY_WAIT_MS);
    const maxChars = boundedPositive(options.maxChars, DEFAULT_BODY_CHARS, MAX_BODY_CHARS);
    const deadline = Date.now() + timeoutMs;
    const existingResponseIds = new Set(state.responses.keys());

    for (;;) {
      const response = [...state.responses.values()]
        .reverse()
        .find((entry) => (
          !existingResponseIds.has(entry.requestId)
          && entry.finished
          && urlMatches(pattern, entry.url)
        ));
      if (response) {
        const raw = await state.debugger.sendCommand('Network.getResponseBody', {
          requestId: response.requestId,
        }) as { body?: unknown; base64Encoded?: unknown };
        const encoded = text(raw.body);
        const body = raw.base64Encoded === true
          ? Buffer.from(encoded, 'base64').toString('utf8')
          : encoded;
        return {
          url: response.url,
          ...(response.status !== undefined ? { status: response.status } : {}),
          ...(response.headers ? { headers: response.headers } : {}),
          body: body.length > maxChars ? body.slice(0, maxChars) : body,
          ...(body.length > maxChars ? { truncated: true } : {}),
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(`response not found for URL pattern: ${pattern}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async waitForIdle(
    wc: WebContents,
    options: { timeoutMs?: number; idleMs?: number } = {},
  ): Promise<void> {
    await this.observe(wc);
    const state = this.states.get(wc);
    if (!state) throw new Error('network monitor unavailable');
    const timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_BODY_WAIT_MS, MAX_BODY_WAIT_MS);
    const idleMs = boundedPositive(options.idleMs, DEFAULT_IDLE_WINDOW_MS, MAX_BODY_WAIT_MS);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = Date.now();
      if (state.inFlight.size === 0 && now - state.lastActivityAt >= idleMs) return;
      if (now >= deadline) throw new Error('network did not become idle before timeout');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  diagnostics(): { observedTabs: number; bufferedRequests: number } {
    let bufferedRequests = 0;
    for (const state of this.states.values()) bufferedRequests += state.requests.length;
    return { observedTabs: this.states.size, bufferedRequests };
  }

  dispose(): void {
    for (const wc of [...this.states.keys()]) this.release(wc);
  }

  private createState(wc: WebContents): MonitorState {
    const electronDebugger = debuggerFor(wc);
    const state: MonitorState = {
      debugger: electronDebugger,
      ownedAttachment: false,
      enabled: false,
      requests: [],
      byRequestId: new Map(),
      responses: new Map(),
      inFlight: new Set(),
      lastActivityAt: Date.now(),
      messageHandler: () => {},
      detachHandler: () => {},
      destroyedHandler: () => {},
    };
    state.messageHandler = (...args: unknown[]) => {
      try {
        const method = text(args[1]);
        const params = args[2] && typeof args[2] === 'object'
          ? args[2] as Record<string, unknown>
          : {};
        this.consumeMessage(state, method, params);
      } catch (err) {
        this.logger.warn('RSB network event handler failed', err);
      }
    };
    state.detachHandler = () => {
      state.enabled = false;
      state.ownedAttachment = false;
    };
    state.destroyedHandler = () => this.release(wc);
    electronDebugger.on('message', state.messageHandler);
    electronDebugger.on('detach', state.detachHandler);
    (wc as unknown as {
      once?: (event: string, listener: (...args: unknown[]) => void) => void;
    }).once?.('destroyed', state.destroyedHandler);
    return state;
  }

  private consumeMessage(
    state: MonitorState,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const requestId = text(params.requestId);
    if (!requestId) return;
    if (method === 'Network.requestWillBeSent') {
      const request = params.request && typeof params.request === 'object'
        ? params.request as Record<string, unknown>
        : {};
      const record: RequestRecord = {
        id: requestId,
        timestamp: new Date().toISOString(),
        method: text(request.method) || 'GET',
        url: safeUrl(text(request.url)),
        resourceType: text(params.type).toLowerCase() || 'other',
      };
      state.requests.push(record);
      state.byRequestId.set(requestId, record);
      state.inFlight.add(requestId);
      state.lastActivityAt = Date.now();
      if (state.requests.length > MAX_REQUESTS) {
        const removed = state.requests.splice(0, state.requests.length - MAX_REQUESTS);
        for (const item of removed) {
          state.byRequestId.delete(item.id);
          state.responses.delete(item.id);
        }
      }
      return;
    }
    if (method === 'Network.responseReceived') {
      const response = params.response && typeof params.response === 'object'
        ? params.response as Record<string, unknown>
        : {};
      const status = number(response.status);
      const request = state.byRequestId.get(requestId);
      if (request) {
        request.status = status;
        request.ok = status !== undefined ? status >= 200 && status < 400 : undefined;
      }
      state.responses.set(requestId, {
        requestId,
        url: safeUrl(text(response.url) || request?.url || ''),
        status,
        headers: safeHeaders(response.headers),
        finished: false,
      });
      state.lastActivityAt = Date.now();
      return;
    }
    if (method === 'Network.loadingFinished') {
      const response = state.responses.get(requestId);
      if (response) response.finished = true;
      state.inFlight.delete(requestId);
      state.lastActivityAt = Date.now();
      return;
    }
    if (method === 'Network.loadingFailed') {
      const request = state.byRequestId.get(requestId);
      if (request) {
        request.ok = false;
        request.failureText = text(params.errorText) || 'request failed';
      }
      state.inFlight.delete(requestId);
      state.lastActivityAt = Date.now();
    }
  }

  private release(wc: WebContents): void {
    const state = this.states.get(wc);
    if (!state) return;
    this.states.delete(wc);
    try {
      state.debugger.removeListener('message', state.messageHandler);
      state.debugger.removeListener('detach', state.detachHandler);
      (wc as unknown as {
        removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
      }).removeListener?.('destroyed', state.destroyedHandler);
    } catch {
      // The guest may already be destroyed.
    }
    if (state.ownedAttachment) {
      try {
        if (state.debugger.isAttached()) state.debugger.detach();
      } catch {
        // Detach is best effort during teardown.
      }
    }
  }
}
