import { MAX_CONTROL_BYTES, requestPayload, sharingIdentityPayload, stripTrailingSlashes } from '@cindy/agent-net-protocol';
import { concatBytes, decodeUtf8, toBase64Url, utf8 } from './portableBytes.js';
import type { AgentNetSigner } from './portableClient.js';

export interface SharingRequestOptions { method: string; body?: unknown; isCurrent?(): boolean; signal?: AbortSignal; applicant?: AgentNetSigner;
  /** Outgoing create receipt bookkeeping, before the final account fence. */
  observeResponse?(value: unknown): void; }
export interface SharingClientOptions {
  base: string;
  networkId: string;
  rootPublicKey: string;
  signer: AgentNetSigner;
  assertCurrent(): void;
  hash(bytes: Uint8Array): Uint8Array;
  getIdentityCard(nonce: string): Promise<{ card: string; expiresAt: string }>;
  memberAuthorization?(method: string, path: string, bytes: string): string | Promise<string>;
  fetch?: typeof fetch;
  ownerPinnedHttp?: boolean;
}
export class AgentNetSharingError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** Portable, key-bound account API. Only short-lived identity cards cross the
 * private relay boundary; the host obtains those from its own account service. */
export class AgentNetSharingClient {
  readonly base: string;
  private closed = false;
  private cached: { card: string; expiresAt: number } | null = null;
  private cardRequest: Promise<string> | null = null;
  private requests = new Set<AbortController>();
  private receipts = new Set<AbortController>();
  constructor(readonly options: SharingClientOptions) {
    const url = new URL(options.base);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && (options.ownerPinnedHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))) throw new Error('SECURE_AGENT_NET_URL_REQUIRED');
    this.base = stripTrailingSlashes(options.base);
  }
  private current(check?: () => boolean) {
    if (this.closed || check?.() === false) throw new Error('AGENT_NET_OWNER_CHANGED');
    this.options.assertCurrent();
  }
  private card(): Promise<string> {
    this.current();
    if (this.cached && this.cached.expiresAt - Date.now() > 30_000) return Promise.resolve(this.cached.card);
    if (this.cardRequest) return this.cardRequest;
    const { networkId, rootPublicKey, signer } = this.options;
    const bytes = this.options.hash(utf8(sharingIdentityPayload(networkId, rootPublicKey, signer.identity.deviceId, signer.identity.signingKey)));
    const nonce = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    this.cardRequest = this.options.getIdentityCard(nonce).then(value => {
      this.current(); const expiresAt = Date.parse(value.expiresAt);
      if (!value.card || value.card.length > 8192 || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
        || expiresAt > Date.now() + 305_000) throw new Error('INVALID_AGENT_NET_IDENTITY_CARD');
      this.cached = { card: value.card, expiresAt }; return value.card;
    }).finally(() => { this.cardRequest = null; });
    return this.cardRequest;
  }
  async request<T = unknown>(resource: string, options: SharingRequestOptions): Promise<T> {
    this.current(options.isCurrent);
    // Existing business adapters keep their public contract; only this scoped
    // transport maps it to the selected V2 service. No arbitrary URL is accepted.
    const path = /^\/api\/device-link\/(shared-tasks|provider-shares)(\/|$)/.test(resource)
      ? resource.replace('/api/device-link/', '/api/agent-net/sharing/')
      : /^\/api\/agent-net\/sharing\/transport(?:\/status)?$/.test(resource) ? resource : '';
    if (!path || path.includes('?') || path.includes('#') || new URL(this.base + path).pathname !== path
      || !['GET', 'POST'].includes(options.method)) throw new Error('INVALID_AGENT_NET_SHARING_RESOURCE');
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    if (utf8(body).length > 16_384) throw new Error('SHARING_REQUEST_TOO_LARGE');
    const card = await this.card(); this.current(options.isCurrent);
    const { signer } = this.options;
    const entropy = await signer.random(); this.current(options.isCurrent);
    const proof = { at: Date.now(), nonce: entropy.slice(0, 24) };
    if (!/^[A-Za-z0-9_-]{24}$/.test(proof.nonce)) throw new Error('INVALID_NATIVE_RANDOM');
    const signature = await signer.sign(requestPayload(options.method, path, toBase64Url(this.options.hash(utf8(body))), proof));
    this.current(options.isCurrent);
    const authorization = 'AgentNetIdentity ' + toBase64Url(utf8(JSON.stringify({ networkId: this.options.networkId,
      deviceId: signer.identity.deviceId, signingKey: signer.identity.signingKey, card, proof: { ...proof, signature } })));
    const member = await this.options.memberAuthorization?.(options.method, path, body); this.current(options.isCurrent);
    let applicant: string | undefined;
    if (options.applicant) {
      const signer = options.applicant;
      if (signer.identity.deviceId !== this.options.signer.identity.deviceId) throw new Error('APPLICANT_DEVICE_MISMATCH');
      const entropy = await signer.random(); this.current(options.isCurrent);
      const proof = { at: Date.now(), nonce: entropy.slice(0, 24) };
      if (!/^[A-Za-z0-9_-]{24}$/.test(proof.nonce)) throw new Error('INVALID_NATIVE_RANDOM');
      const signature = await signer.sign(requestPayload(options.method, path, toBase64Url(this.options.hash(utf8(body))), proof));
      this.current(options.isCurrent); applicant = toBase64Url(utf8(JSON.stringify({ ...proof, signature })));
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    this.requests.add(controller);
    if (options.observeResponse) this.receipts.add(controller);
    try {
      const response = await (this.options.fetch ?? fetch)(this.base + path, { method: options.method,
        headers: { authorization, ...(member ? { 'x-agent-net-authorization': member } : {}),
          ...(applicant ? { 'x-agent-net-applicant': applicant } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body } : {}), redirect: 'error', signal: controller.signal });
      if (!options.observeResponse) this.current(options.isCurrent);
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > MAX_CONTROL_BYTES) throw new Error('SHARING_RESPONSE_TOO_LARGE');
      let text: string;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const next = await reader.read(); if (!options.observeResponse) this.current(options.isCurrent);
            if (next.done) break;
            size += next.value.length;
            if (size > MAX_CONTROL_BYTES) { await reader.cancel(); throw new Error('SHARING_RESPONSE_TOO_LARGE'); }
            parts.push(next.value);
          }
          text = decodeUtf8(concatBytes(parts));
        } finally { reader.releaseLock(); }
      } else text = await response.text();
      if (utf8(text).length > MAX_CONTROL_BYTES) throw new Error('SHARING_RESPONSE_TOO_LARGE');
      let value: any;
      try { value = JSON.parse(text); } catch { throw new Error('INVALID_SHARING_RESPONSE'); }
      if (!response.ok) {
        this.current(options.isCurrent);
        if (response.status === 401) this.cached = null;
        throw new AgentNetSharingError(response.status, typeof value?.error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.error.code)
          ? value.error.code : 'AGENT_NET_SHARING_FAILED');
      }
      options.observeResponse?.(value);
      this.current(options.isCurrent);
      return value as T;
    } finally { clearTimeout(timer); controller.abort(); options.signal?.removeEventListener('abort', abort); this.requests.delete(controller); this.receipts.delete(controller); }
  }
  close() { this.closed = true; this.cached = null;
    // Already-issued creates retain only their bounded response read so the
    // outgoing Host can close a committed resource; no new request is allowed.
    for (const request of this.requests) if (!this.receipts.has(request)) request.abort();
  }
}
