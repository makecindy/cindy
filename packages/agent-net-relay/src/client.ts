import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import WebSocket from 'ws';
import {
  API, MAX_FRAME_BYTES, MAX_CONTROL_BYTES, MAX_MEDIA_BINARY_CHUNK_BYTES, decodeDatagrams, encodeDatagrams, enrollmentPayload, transportModePayload,
  guestRequestPath, delegationVisibleTo, delegationPrincipalMatches, delegationPayload, stripTrailingSlashes,
  MEDIA_TRANSFER_DIRECT, MEDIA_TRANSFER_HEADER, directMediaRequestValid, type DirectMediaRequest,
  type Delegation, type DeviceCertificate, type DeviceView, type JoinRequest, type EnrollmentRequest, type TransportModeProof,
} from '@cindy/agent-net-protocol';
import { createDelegation, createRequestProof, sha256, signature, verifySignature, verifyCertificate, verifyDelegation, type Identity, type TenantJoinRequest } from './identity.js';
import { delegationRequestPolicyValid, type DelegationRequest } from '@cindy/agent-net-protocol';
export { generateIdentity, publicBytes, issueCertificate, createJoinRequest, approveJoin, createDelegation,
  createTenantJoinRequest, verifyTenantJoinRequest, verifyTenantPairingProof, tenantVerifyCode } from './identity.js';
export type { Identity, TenantJoinRequest } from './identity.js';
export { createPrivateNetwork } from './bootstrap.js';
export { uploadEncryptedMedia, openEncryptedMedia } from './media.js';
export { sealNotification } from './notification.js';
export class AgentNetClientError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
// This Node client is also type-checked by React Native consumers of its types.
function unrefTimer(timer: number | { unref(): void }): void {
  if (typeof timer !== 'number') timer.unref();
}
export interface AgentNetClientTransport {
  /** Private relay selected by the owner: signed controls + pinned device certificates, encrypted business payloads. */
  ownerPinnedHttp?: boolean;
  fetch?: typeof globalThis.fetch;
  createWebSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket | Promise<WebSocket>;
}
/** The host supplies its existing account-authenticated HTTP client for enrollment/renewal. */
export function createEnrollmentRequest(identity: Identity, name: string): EnrollmentRequest {
  if (!name.trim() || name.length > 64) throw new Error('INVALID_DEVICE_NAME');
  const request = { deviceId: identity.deviceId, signingKey: identity.signingKey, transportKey: identity.transportKey, name };
  return { ...request, signature: signature(identity.signingPrivateKey, enrollmentPayload(request)) };
}
export function acceptEnrollment(identity: Identity, response: unknown, subject: string, pinnedRoot?: string): { rootPublicKey: string; certificate: DeviceCertificate } {
  const value = response as { rootPublicKey?: unknown; certificate?: unknown } | null;
  if (!value || typeof value.rootPublicKey !== 'string' || (pinnedRoot && value.rootPublicKey !== pinnedRoot)
    || !verifyCertificate(value.rootPublicKey, value.certificate)) throw new Error('UNTRUSTED_ENROLLMENT');
  const certificate = value.certificate;
  if (!certificate.networkId.startsWith('account:') || certificate.subject !== subject || certificate.deviceId !== identity.deviceId
    || certificate.signingKey !== identity.signingKey || certificate.transportKey !== identity.transportKey) throw new Error('ENROLLMENT_IDENTITY_MISMATCH');
  return { rootPublicKey: value.rootPublicKey, certificate };
}
export function createTransportModeProof(identity: Identity, to: string, requestId: string, enabled: boolean): TransportModeProof {
  const plain = { v: 2 as const, deviceId: identity.deviceId, to, requestId, enabled, at: Date.now() };
  return { ...plain, signature: signature(identity.signingPrivateKey, transportModePayload(plain)) };
}
export function verifyTransportModeProof(certificate: DeviceCertificate, to: string, requestId: string, value: unknown): value is TransportModeProof {
  if (!value || typeof value !== 'object') return false;
  const p = value as TransportModeProof;
  return Object.keys(p).length === 7 && p.v === 2 && p.deviceId === certificate.deviceId && p.to === to && p.requestId === requestId
    && typeof p.enabled === 'boolean' && Number.isSafeInteger(p.at) && Math.abs(p.at - Date.now()) <= 90_000
    && typeof p.signature === 'string' && verifySignature(certificate.signingKey, transportModePayload(p), p.signature);
}
function checkBase(base: string, transport: AgentNetClientTransport = {}): string {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (transport.ownerPinnedHttp || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))) throw new Error('SECURE_AGENT_NET_URL_REQUIRED');
  return stripTrailingSlashes(base);
}
export function authorization(identity: Identity, certificate: DeviceCertificate, method: string, path: string, body: string | Uint8Array = ''): string {
  return 'AgentNet ' + Buffer.from(JSON.stringify({ certificate, proof: createRequestProof(identity, method, path, body) })).toString('base64url');
}
export function guestAuthorization(identity: Identity, delegation: Delegation, method: string, path: string, body: string | Uint8Array = ''): string {
  return 'AgentNetGuest ' + Buffer.from(JSON.stringify({ networkId: delegation.networkId, delegationId: delegation.id,
    proof: createRequestProof(identity, method, guestRequestPath(path, delegation.networkId, delegation.id), body) })).toString('base64url');
}
async function responseBody(response: Response): Promise<unknown> {
  const result = await response.json() as { error?: { code?: string } };
  if (!response.ok) throw new AgentNetClientError(response.status, result.error?.code ?? 'AGENT_NET_REQUEST_FAILED');
  return result;
}
export async function submitJoin(base: string, request: JoinRequest, transport: AgentNetClientTransport = {}): Promise<{ requestId: string; pollToken: string }> {
  return responseBody(await (transport.fetch ?? fetch)(checkBase(base, transport) + API + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.timeout(10_000) })) as Promise<{ requestId: string; pollToken: string }>;
}
export async function pollJoin(base: string, rootPublicKey: string, networkId: string, requestId: string, pollToken: string, transport: AgentNetClientTransport = {}): Promise<{ status: string; certificate?: DeviceCertificate }> {
  const result = await responseBody(await (transport.fetch ?? fetch)(checkBase(base, transport) + API + '/join/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ networkId, requestId, pollToken }), redirect: 'error', signal: AbortSignal.timeout(10_000) })) as { status: string; certificate?: DeviceCertificate; rootPublicKey?: string };
  if (result.status === 'approved' && (result.rootPublicKey !== rootPublicKey || !verifyCertificate(rootPublicKey, result.certificate) || result.certificate.networkId !== networkId)) throw new Error('UNTRUSTED_NETWORK_CERTIFICATE');
  return result;
}
/** Another account asks a shared self-hosted relay for its own network (§5.5); no certificate is returned,
 * the guest already holds its own root and owner certificate. */
export async function submitTenantJoin(base: string, request: TenantJoinRequest, transport: AgentNetClientTransport = {}): Promise<{ requestId: string; pollToken: string }> {
  return responseBody(await (transport.fetch ?? fetch)(checkBase(base, transport) + API + '/tenant-join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.timeout(10_000) })) as Promise<{ requestId: string; pollToken: string }>;
}
export async function pollTenantJoin(base: string, requestId: string, pollToken: string, transport: AgentNetClientTransport = {}): Promise<{ status: string }> {
  const result = await responseBody(await (transport.fetch ?? fetch)(checkBase(base, transport) + API + '/tenant-join/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, pollToken }), redirect: 'error', signal: AbortSignal.timeout(10_000) })) as { status?: unknown };
  return { status: typeof result.status === 'string' ? result.status : 'pending' };
}
/** How long a client whose network could not reach the attachment storage keeps using the relay for media. */
const DIRECT_STORAGE_RETRY_MS = 10 * 60_000;
export class AgentNetClient {
  readonly base: string;
  /** Uploads the relay granted direct transfer for (until complete). */
  private readonly directUploads = new Set<string>();
  /** Presigned storage reads, reused until shortly before they expire. */
  private readonly directReads = new Map<string, { request: DirectMediaRequest; until: number }>();
  /** Until then this client's network could not reach the storage, so media goes through the relay. */
  private directUnreachableUntil = 0;
  constructor(base: string, readonly identity: Identity, readonly certificate: DeviceCertificate, readonly rootPublicKey: string, readonly delegation?: Delegation, readonly transport: AgentNetClientTransport = {}) {
    this.base = checkBase(base, transport);
    if (!delegation && (!verifyCertificate(rootPublicKey, certificate) || certificate.deviceId !== identity.deviceId || certificate.signingKey !== identity.signingKey || certificate.transportKey !== identity.transportKey)) throw new Error('IDENTITY_CERTIFICATE_MISMATCH');
    if (delegation && (!verifyDelegation(rootPublicKey, delegation) || delegation.guestDeviceId !== identity.deviceId
      || delegation.guestSigningKey !== identity.signingKey || delegation.guestTransportKey !== identity.transportKey
      || delegation.issuerCertificate.signature !== certificate.signature)) throw new Error('IDENTITY_DELEGATION_MISMATCH');
  }
  path(resource: string): string { return API + (this.delegation ? '/guest' : '') + resource; }
  header(method: string, path: string, body: string | Uint8Array = ''): string {
    return this.delegation ? guestAuthorization(this.identity, this.delegation, method, path, body) : authorization(this.identity, this.certificate, method, path, body);
  }
  async request<T = Record<string, unknown>>(method: string, resource: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    const path = this.path(resource);
    const body = input === undefined ? '' : JSON.stringify(input);
    const authorization = this.header(method, path, body);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    const abort = () => controller.abort();
    if (options?.signal?.aborted) controller.abort();
    else options?.signal?.addEventListener('abort', abort, { once: true });
    const readTransport = async <R>(read: () => Promise<R>, status?: number): Promise<R> => {
      try { return await read(); }
      catch (error) {
        if (!options?.signal?.aborted) {
          if (status && status >= 400) throw new AgentNetClientError(status, 'AGENT_NET_REQUEST_FAILED');
          if (controller.signal.aborted) throw new AgentNetClientError(0, 'AGENT_NET_REQUEST_TIMEOUT');
          if (error instanceof TypeError || (error as { name?: unknown } | null)?.name === 'AbortError') {
            throw new AgentNetClientError(0, 'AGENT_NET_NETWORK_ERROR');
          }
        }
        throw error;
      }
    };
    try {
      const response = await readTransport(() => (this.transport.fetch ?? fetch)(this.base + path, {
        method, headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body } : {}), redirect: 'error', signal: controller.signal,
      }));
      const result = await readTransport(() => response.json(), response.status) as { error?: { code?: string } };
      if (!response.ok) throw new AgentNetClientError(response.status, result.error?.code ?? 'AGENT_NET_REQUEST_FAILED');
      return result as T;
    } finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); }
  }
  async directory(): Promise<DeviceView[]> {
    const result = await this.request<{ rootPublicKey: string; devices: DeviceView[] }>('GET', '/directory');
    if (result.rootPublicKey !== this.rootPublicKey || !Array.isArray(result.devices)
      || result.devices.some((d) => !this.trustedDirectoryEntry(d))) throw new Error('UNTRUSTED_DIRECTORY');
    return result.devices;
  }
  private trustedDirectoryEntry(device: DeviceView): boolean {
    const c = device?.certificate;
    // An offline device remains visible after expiry. Its historical binding is verifiable,
    // but an expired certificate must never authenticate a session or admit a transport peer.
    return !!c && c.issuedAt <= Date.now() + 30_000 && verifyCertificate(this.rootPublicKey, c, c.issuedAt)
      && c.networkId === this.certificate.networkId && c.subject === this.certificate.subject;
  }
  async connect(): Promise<AgentNetUplink> {
    const path = this.path('/ws');
    return AgentNetUplink.open(this.base.replace(/^http/, 'ws') + path, this.header('GET', path), (devices, delegations, requests) => {
      if (devices.some((d) => !this.trustedDirectoryEntry(d))) throw new Error('UNTRUSTED_DIRECTORY');
      if (delegations.some((d) => !verifyDelegation(this.rootPublicKey, d) || d.networkId !== this.certificate.networkId
        || !delegationVisibleTo(d, this.identity, this.delegation))) throw new Error('UNTRUSTED_DELEGATION');
      if (requests.length > 128 || requests.some(r => this.delegation || !delegationRequestPolicyValid(r, this.certificate))) throw new Error('UNTRUSTED_DELEGATION_REQUEST');
    }, this.transport.createWebSocket);
  }
  /** Only call for requests received from this pinned network's authenticated
   * directory. The kernel rechecks the live business membership at commit. */
  async acceptDelegationRequest(request: DelegationRequest, assertCurrent: () => void,
    signal?: AbortSignal): Promise<Delegation> {
    assertCurrent();
    if (this.delegation || !delegationRequestPolicyValid(request, this.certificate)
      || request.guestTransportKey === this.identity.transportKey) throw new Error('UNTRUSTED_DELEGATION_REQUEST');
    const issuedAt = Math.max(Date.now(), request.requestedAt);
    const expiresAt = Math.min(request.expiresAt, this.certificate.expiresAt);
    if (expiresAt <= issuedAt) throw new Error('DELEGATION_REQUEST_EXPIRED');
    let delegation = createDelegation(this.identity, this.certificate, { id: request.id, kind: request.kind,
      resourceId: request.resourceId, scope: request.scope, now: issuedAt, lifetimeMs: expiresAt - issuedAt,
      guest: { deviceId: request.guestDeviceId, signingKey: request.guestSigningKey, transportKey: request.guestTransportKey } });
    let previous: Delegation | undefined;
    try { previous = (await this.request<{ delegation: Delegation }>('GET', '/grants/' + request.id, undefined, { signal })).delegation; }
    catch (error) { if (!(error instanceof AgentNetClientError) || error.status !== 404) throw error; }
    assertCurrent();
    if (previous && verifyDelegation(this.rootPublicKey, previous) && delegationPrincipalMatches(previous, delegation) && previous.executors) {
      const plain = { ...delegation, executors: previous.executors.filter(e => e.expiresAt > issuedAt && e.expiresAt <= delegation.expiresAt) };
      delegation = { ...plain, signature: signature(this.identity.signingPrivateKey, delegationPayload(plain)) };
    }
    assertCurrent(); await this.request('POST', '/grants', { delegation, ...(previous ? { previousSignature: previous.signature } : {}) }, { signal }); assertCurrent();
    return delegation;
  }
  async uploadMedia(recipient: string, ciphertext: Uint8Array): Promise<string> {
    const created = await this.request<{ id: string; chunkBytes: number }>('POST', '/media', { recipient, size: ciphertext.byteLength });
    for (let offset = 0; offset < ciphertext.byteLength; offset += created.chunkBytes) {
      await this.request('PUT', '/media/' + created.id, { offset, data: Buffer.from(ciphertext.subarray(offset, offset + created.chunkBytes)).toString('base64url') });
    }
    return created.id;
  }
  async downloadMedia(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.mediaResponse(id)).arrayBuffer());
  }
  /**
   * Starts an encrypted upload and offers direct transfer. A relay whose storage clients can reach grants it, and
   * the chunks then go to the storage itself; any other relay ignores the offer and receives them as before.
   */
  async createMedia(recipient: string, size: number, signal?: AbortSignal): Promise<{ id: string; chunkBytes: number }> {
    const created = await this.request<{ id: string; chunkBytes: number; transfer?: unknown }>('POST', '/media',
      { recipient, size, chunkFormat: 'binary-v1', ...(this.directReachable() ? { transfer: MEDIA_TRANSFER_DIRECT } : {}) }, { signal });
    if (created.transfer === MEDIA_TRANSFER_DIRECT) {
      if (this.directUploads.size >= 64) this.directUploads.delete(this.directUploads.values().next().value!);
      this.directUploads.add(created.id);
    }
    return { id: created.id, chunkBytes: created.chunkBytes };
  }
  private directReachable(): boolean { return Date.now() >= this.directUnreachableUntil; }
  /** A network that reaches the relay but not the storage (a firewall that allows only the relay, say) keeps
   * working through the relay, which reads and writes the same storage. */
  private directUnreachable(): void { this.directUnreachableUntil = Date.now() + DIRECT_STORAGE_RETRY_MS; this.directReads.clear(); }
  /** A storage request from the relay; plain HTTP only when the relay itself is reached over plain HTTP (local/test). */
  private directRequest(value: unknown): DirectMediaRequest {
    if (!directMediaRequestValid(value)) throw new Error('INVALID_DIRECT_MEDIA_REQUEST');
    if (new URL(value.url).protocol !== 'https:' && new URL(this.base).protocol !== 'http:') throw new Error('INSECURE_DIRECT_MEDIA_REQUEST');
    return value;
  }
  private async putDirectMediaChunk(id: string, offset: number, body: Uint8Array, signal?: AbortSignal): Promise<{ received: number; complete: boolean }> {
    const resource = '/media/' + encodeURIComponent(id);
    const md5 = createHash('md5').update(body).digest('base64');
    const target = this.directRequest((await this.request<{ request: unknown }>('POST', resource + '/upload', { offset, size: body.length, md5 }, { signal })).request);
    // A lost reply does not mean a lost write: whether the chunk landed is asked from the relay, which reads the
    // stored length from the storage.
    let rejected: number | undefined, unreachable = false;
    try {
      const response = await (this.transport.fetch ?? fetch)(target.url, { method: target.method, headers: target.headers, body: new Uint8Array(body),
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) rejected = response.status;
    } catch (error) { if (signal?.aborted) throw error; unreachable = true; }
    const result = await this.request<{ received: number; complete: boolean }>('POST', resource + '/commit', undefined, { signal });
    if (unreachable && result.received === offset) {
      // Nothing landed: the rest of this upload goes through the relay.
      this.directUploads.delete(id); this.directUnreachable();
      return this.putMediaChunk(id, offset, body, signal);
    }
    if (result.received !== offset + body.length) throw new AgentNetClientError(rejected ?? 0, rejected ? 'MEDIA_STORAGE_REJECTED' : 'MEDIA_OFFSET_MISMATCH');
    if (result.complete) this.directUploads.delete(id);
    return result;
  }
  async putMediaChunk(id: string, offset: number, body: Uint8Array, signal?: AbortSignal): Promise<{ received: number; complete: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || body.length === 0 || body.length > MAX_MEDIA_BINARY_CHUNK_BYTES) throw new Error('INVALID_MEDIA_CHUNK');
    if (this.directUploads.has(id)) return this.putDirectMediaChunk(id, offset, body, signal);
    const path = this.path('/media/' + encodeURIComponent(id) + '?offset=' + offset);
    return responseBody(await (this.transport.fetch ?? fetch)(this.base + path, {
      method: 'PUT', headers: { authorization: this.header('PUT', path, body), 'content-type': 'application/octet-stream', 'x-agent-net-content-sha256': sha256(body) },
      body: new Uint8Array(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
    })) as Promise<{ received: number; complete: boolean }>;
  }
  /** Stream encrypted bytes (or a byte range) without buffering a multi-gigabyte object. */
  async mediaResponse(id: string, range?: string, signal?: AbortSignal): Promise<Response> {
    const cached = this.directReachable() ? this.directReads.get(id) : undefined;
    if (cached && cached.until > Date.now()) {
      const response = await this.directRead(cached.request, range, signal);
      if (response && response.status !== 403) return response;
      // Revoked or expired early: ask the relay again, which re-checks access.
      await response?.body?.cancel().catch(() => undefined); this.directReads.delete(id);
    }
    const direct = this.directReachable();
    const path = this.path('/media/' + encodeURIComponent(id));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30_000); unrefTimer(timer);
    let response: Response;
    try {
      response = await (this.transport.fetch ?? fetch)(this.base + path, { headers: { authorization: this.header('GET', path),
        ...(direct ? { [MEDIA_TRANSFER_HEADER]: MEDIA_TRANSFER_DIRECT } : {}), ...(range ? { range } : {}) }, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal });
      if (response.ok && response.headers.get(MEDIA_TRANSFER_HEADER) === MEDIA_TRANSFER_DIRECT) {
        const target = this.directRequest(((await response.json()) as { request?: unknown }).request);
        if (this.directReads.size >= 64) this.directReads.delete(this.directReads.keys().next().value!);
        this.directReads.set(id, { request: target, until: Math.min(target.expiresAt - 30_000, Date.now() + 10 * 60_000) });
        clearTimeout(timer);
        const read = await this.directRead(target, range, signal);
        // Unreachable storage: the relay serves this read (and the next ones for a while) itself.
        if (!read) return await this.mediaResponse(id, range, signal);
        if (read.status === 403) {
          // Refused although just granted: an error, never media (only a cached grant is retried).
          await read.body?.cancel().catch(() => undefined); this.directReads.delete(id);
          throw new AgentNetClientError(403, 'MEDIA_STORAGE_READ_FAILED');
        }
        return read;
      }
    } finally { clearTimeout(timer); }
    if (!response.ok) await responseBody(response);
    return response;
  }
  private async directRead(target: DirectMediaRequest, range: string | undefined, signal?: AbortSignal): Promise<Response | undefined> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30_000); unrefTimer(timer);
    try {
      let response: Response;
      try {
        response = await (this.transport.fetch ?? fetch)(target.url, { method: target.method, headers: { ...target.headers, ...(range ? { range } : {}) },
          redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        this.directUnreachable(); return undefined;
      }
      if (!response.ok && response.status !== 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new AgentNetClientError(response.status, response.status === 416 ? 'INVALID_MEDIA_RANGE' : 'MEDIA_STORAGE_READ_FAILED');
      }
      return response;
    } finally { clearTimeout(timer); }
  }
  /** Native media reads are bounded ranges; retain their deadline until consumed. */
  async withMediaResponse<T>(id: string, range: string, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000); unrefTimer(timer);
    try {
      const response = await this.mediaResponse(id, range, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      return await consume(response);
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
/** Coalesced host-side grant issuance. Directory hints carry public CSRs only;
 * signatures stay on the host and never enter the relay or a worker broker. */
export function createDelegationApprover(client: AgentNetClient, assertCurrent: () => void,
  authorize: (request: DelegationRequest) => Promise<boolean>,
  onError: (code: string) => void = () => undefined) {
  let closed = false;
  const latest = new Map<string, DelegationRequest>(), pending = new Map<string, DelegationRequest>();
  const running = new Map<string, AbortController>(), attempted = new Set<string>(), retried = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const version = (r: DelegationRequest) => r.id + ':' + r.expiresAt;
  function drain() {
    while (!closed && running.size < 2 && pending.size) {
      const [key, request] = pending.entries().next().value!; pending.delete(key);
      if (latest.get(request.id) !== request || attempted.has(key)) continue;
      attempted.add(key); const controller = new AbortController(); running.set(key, controller);
      void Promise.resolve().then(async () => {
        if (!await authorize(request)) throw new Error('SHARING_AUTHORIZATION_DENIED');
        if (closed) throw new Error('AGENT_NET_OWNER_CHANGED'); assertCurrent();
        return client.acceptDelegationRequest(request, () => {
        if (closed) throw new Error('AGENT_NET_OWNER_CHANGED'); assertCurrent();
        }, controller.signal);
      }).catch(error => {
        if (closed || latest.get(request.id) !== request) return;
        if (!retried.has(key)) {
          retried.add(key);
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!closed && latest.get(request.id) === request) { attempted.delete(key); pending.set(key, request); drain(); }
          }, 1000); unrefTimer(timer); timers.add(timer);
        } else onError(error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'SHARING_AUTHORIZATION_FAILED');
      }).finally(() => { running.delete(key); drain(); });
    }
  }
  return {
    update(requests: DelegationRequest[]) {
      if (closed) return;
      assertCurrent();
      const previous = new Map(latest); latest.clear(); pending.clear();
      for (const request of requests.slice(0, 128)) {
        if (!delegationRequestPolicyValid(request, client.certificate)) continue;
        const key = version(request), old = previous.get(request.id);
        const current = old && version(old) === key ? old : request;
        latest.set(current.id, current);
        if (!attempted.has(key) && !running.has(key)) pending.set(key, current);
      }
      const live = new Set([...latest.values()].map(version));
      for (const key of attempted) if (!live.has(key) && !running.has(key)) { attempted.delete(key); retried.delete(key); }
      drain();
    },
    close() { closed = true; latest.clear(); pending.clear();
      for (const timer of timers) clearTimeout(timer); timers.clear();
      for (const controller of running.values()) controller.abort();
    },
  };
}
export class AgentNetUplink extends EventEmitter {
  readonly kind = 'agent-net' as const;
  sent = 0;
  deviceId = '';
  devices: DeviceView[] = [];
  notifications = false;
  delegations: Delegation[] = [];
  delegationRequests: DelegationRequest[] = [];
  private receiver: ((deviceId: string, packet: Uint8Array) => void) | null = null;
  private pending: Array<[string, Uint8Array]> = [];
  private pendingBytes = 0;
  private queues = new Map<string, Uint8Array[]>();
  private queuedBytes = 0;
  private scheduled = false;
  private constructor(private readonly ws: WebSocket) { super(); }
  static async open(url: string, header: string, verifyDirectory: (devices: DeviceView[], delegations: Delegation[], requests: DelegationRequest[]) => void, factory?: AgentNetClientTransport['createWebSocket']): Promise<AgentNetUplink> {
    const socketOptions = { headers: { authorization: header }, maxPayload: MAX_CONTROL_BYTES };
    const ws = factory ? await factory(url, socketOptions) : new WebSocket(url, socketOptions);
    const uplink = new AgentNetUplink(ws);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('AGENT_NET_HANDSHAKE_TIMEOUT')); }, 10_000);
      unrefTimer(timer);
      let established = false;
      const fail = (error: Error) => { clearTimeout(timer); if (!established) reject(error); ws.terminate(); };
      ws.on('error', fail);
      ws.once('unexpected-response', (_request, response) => { response.resume(); fail(new Error('AGENT_NET_UPGRADE_' + response.statusCode)); });
      ws.on('close', (code) => { clearTimeout(timer); if (!established) reject(new Error('AGENT_NET_CLOSED_' + code)); uplink.emit('close', code); });
      ws.on('message', (raw, binary) => {
        const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        if (binary) {
          const frame = decodeDatagrams(bytes);
          if (!frame) { fail(new Error('INVALID_DATAGRAM_FRAME')); return; }
          for (const packet of frame.datagrams) {
            if (uplink.receiver) uplink.receiver(frame.deviceId, packet);
            else if (uplink.pending.length < 512 && uplink.pendingBytes + packet.length <= 1024 * 1024) {
              uplink.pending.push([frame.deviceId, packet.slice()]); uplink.pendingBytes += packet.length;
            }
          }
          return;
        }
        try {
          const message = JSON.parse(bytes.toString('utf8')) as { type: string; deviceId: string; devices: DeviceView[]; delegations?: Delegation[]; delegationRequests?: DelegationRequest[]; protocolVersion?: number; notifications?: boolean };
          if (!['hello', 'directory'].includes(message.type) || !Array.isArray(message.devices)) throw new Error('INVALID_CONTROL');
          if (!Array.isArray(message.delegations)) throw new Error('INVALID_CONTROL');
          const requests = message.delegationRequests ?? [];
          if (!Array.isArray(requests)) throw new Error('INVALID_CONTROL');
          verifyDirectory(message.devices, message.delegations, requests);
          uplink.devices = message.devices;
          uplink.delegations = message.delegations;
          uplink.delegationRequests = requests;
          if (message.type === 'hello') {
            if (message.protocolVersion !== 2 || established) throw new Error('INVALID_HELLO');
            uplink.deviceId = message.deviceId;
            uplink.notifications = message.notifications === true;
            established = true; clearTimeout(timer); resolve(uplink);
          } else uplink.emit('directory', message.devices);
        } catch (error) { fail(error instanceof Error ? error : new Error('INVALID_CONTROL')); }
      });
    });
  }
  send(deviceId: string, datagram: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN || datagram.length === 0 || datagram.length > 65_000 || this.queuedBytes + datagram.length > 1024 * 1024 || this.queues.size >= 256) return;
    const existing = this.queues.get(deviceId) ?? [];
    existing.push(datagram.slice());
    this.queues.set(deviceId, existing);
    this.queuedBytes += datagram.length;
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const queues = this.queues; this.queues = new Map(); this.queuedBytes = 0;
      for (const [target, packets] of queues) {
        let batch: Uint8Array[] = []; let size = 2 + Buffer.byteLength(target);
        const flush = () => {
          if (batch.length && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount <= 1024 * 1024) {
            try { this.ws.send(encodeDatagrams(target, batch)); this.sent += batch.length; } catch { /* Datagram semantics: retransmission is owned by the encrypted core. */ }
          }
          batch = []; size = 2 + Buffer.byteLength(target);
        };
        for (const packet of packets) { if (size + 2 + packet.length > MAX_FRAME_BYTES) flush(); batch.push(packet); size += packet.length + 2; }
        flush();
      }
    });
  }
  onDatagram(receiver: (deviceId: string, packet: Uint8Array) => void): void {
    this.receiver = receiver;
    for (const [id, packet] of this.pending) receiver(id, packet);
    this.pending = [];
    this.pendingBytes = 0;
  }
  presence(remoteControlEnabled: boolean, capabilities: string[], metadata: import('@cindy/agent-net-protocol').DeviceMetadata = {}): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'presence', remoteControlEnabled, capabilities,
      platform: metadata.platform, app: metadata.app, appVersion: metadata.appVersion, busy: metadata.busy, deviceName: metadata.deviceName }));
  }
  close(): void { this.pending = []; this.queues.clear(); this.ws.terminate(); }
}
/** Media is encrypted before upload. A relay stores only an ephemeral X25519 key, nonce and ciphertext. */
export function encryptMedia(recipientTransportKey: string, plaintext: Uint8Array): Uint8Array {
  const ephemeral = generateKeyPairSync('x25519');
  const remote = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: recipientTransportKey }, format: 'jwk' });
  const publicKey = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: remote });
  const nonce = randomBytes(12);
  const key = Buffer.from(hkdfSync('sha256', shared, nonce, 'cindy-agent-net/media/2', 32));
  const header = Buffer.concat([Buffer.from([2]), publicKey, nonce]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  shared.fill(0); key.fill(0);
  return Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
}
export function decryptMedia(privateKey: KeyObject, packet: Uint8Array): Uint8Array {
  const bytes = Buffer.from(packet);
  if (bytes.length < 61 || bytes[0] !== 2) throw new Error('INVALID_MEDIA');
  const header = bytes.subarray(0, 45); const nonce = bytes.subarray(33, 45);
  const remote = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: bytes.subarray(1, 33).toString('base64url') }, format: 'jwk' });
  const shared = diffieHellman({ privateKey, publicKey: remote });
  const key = Buffer.from(hkdfSync('sha256', shared, nonce, 'cindy-agent-net/media/2', 32));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(header); decipher.setAuthTag(bytes.subarray(45, 61));
  try { return Buffer.concat([decipher.update(bytes.subarray(61)), decipher.final()]); } finally { shared.fill(0); key.fill(0); }
}
