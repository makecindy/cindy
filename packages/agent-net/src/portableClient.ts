import {
  decodeDatagrams, encodeDatagrams, MAX_CONTROL_BYTES, MAX_FRAME_BYTES, MAX_MEDIA_BINARY_CHUNK_BYTES, requestPayload,
  delegationRequestPolicyValid, type Delegation, type DelegationRequest, type DeviceCertificate, type DeviceView,
  guestRequestPath, delegationVisibleTo, stripTrailingSlashes,
  MEDIA_TRANSFER_DIRECT, MEDIA_TRANSFER_HEADER, directMediaRequestValid, type DirectMediaRequest,
} from '@cindy/agent-net-protocol';
import { fromBase64Url, toBase64Url, utf8 } from './portableBytes.js';
import { SocketEvents } from './socketEvents.js';
import type { SocketClient, SocketUplink } from './socketPorts.js';

export interface AgentNetSigner {
  readonly identity: { deviceId: string; signingKey: string; transportKey: string };
  sign(text: string): Promise<string>;
  random(): Promise<string>;
}
export class PortableAgentNetClientError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface BinarySocket {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}
export interface PortableClientOptions {
  assertCurrent(): void;
  sha256(data: Uint8Array): string;
  /** MD5 digest bytes. With it the client offers direct media transfer (Content-MD5 binds each stored chunk). */
  md5?(data: Uint8Array): Uint8Array;
  verifyCertificate(root: string, certificate: unknown, now?: number): certificate is DeviceCertificate;
  verifyDelegation?(root: string, delegation: unknown): delegation is Delegation;
  createWebSocket(url: string, headers: Record<string, string>): BinarySocket;
  fetch?: typeof fetch;
  ownerPinnedHttp?: boolean;
  delegation?: Delegation;
}

/** Device-key authentication for trusted mobile/native hosts. No account token
 * is accepted by this API; official enrollment is a separate first-party flow. */
/** A storage request that never reached the storage (as opposed to one it answered). */
const STORAGE_UNREACHABLE = Symbol('storage unreachable');
/** How long a client whose network could not reach the attachment storage keeps using the relay for media. */
const DIRECT_STORAGE_RETRY_MS = 10 * 60_000;
export class PortableAgentNetClient implements SocketClient {
  readonly base: string;
  readonly identity: AgentNetSigner['identity'];
  get delegation(): Delegation | undefined { return this.options.delegation; }
  private activeCertificate: DeviceCertificate;
  /** Uploads the relay granted direct transfer for (until complete). */
  private readonly directUploads = new Set<string>();
  /** Presigned storage reads, reused until shortly before they expire. */
  private readonly directReads = new Map<string, { request: DirectMediaRequest; until: number }>();
  /** Until then this client's network could not reach the storage, so media goes through the relay. */
  private directUnreachableUntil = 0;
  get certificate(): DeviceCertificate { return this.activeCertificate; }
  constructor(base: string, private signer: AgentNetSigner, certificate: DeviceCertificate,
    readonly rootPublicKey: string, readonly options: PortableClientOptions) {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && (options.ownerPinnedHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))) {
      throw new Error('SECURE_AGENT_NET_URL_REQUIRED');
    }
    this.base = stripTrailingSlashes(base);
    this.identity = signer.identity;
    const d = options.delegation;
    if (!options.verifyCertificate(rootPublicKey, certificate) || (!d && (certificate.deviceId !== this.identity.deviceId
      || certificate.signingKey !== this.identity.signingKey || certificate.transportKey !== this.identity.transportKey))
      || (d && (!options.verifyDelegation?.(rootPublicKey, d) || d.guestDeviceId !== this.identity.deviceId
        || d.guestSigningKey !== this.identity.signingKey || d.guestTransportKey !== this.identity.transportKey
        || d.issuerCertificate.signature !== certificate.signature))) {
      throw new Error('IDENTITY_CERTIFICATE_MISMATCH');
    }
    this.activeCertificate = Object.freeze({ ...certificate });
  }
  /** Refresh only a certificate/signer for the very same principal. Existing
   * media requests retain this API object and continue with fresh credentials. */
  replaceCredentials(signer: AgentNetSigner, certificate: DeviceCertificate): void {
    this.options.assertCurrent();
    if (!this.options.verifyCertificate(this.rootPublicKey, certificate)
      || certificate.networkId !== this.certificate.networkId || certificate.subject !== this.certificate.subject
      || certificate.deviceId !== this.identity.deviceId || certificate.signingKey !== this.identity.signingKey
      || certificate.transportKey !== this.identity.transportKey || signer.identity.deviceId !== this.identity.deviceId
      || signer.identity.signingKey !== this.identity.signingKey || signer.identity.transportKey !== this.identity.transportKey) {
      throw new Error('AGENT_NET_IDENTITY_CHANGED');
    }
    this.signer = signer; this.activeCertificate = Object.freeze({ ...certificate });
  }
  path(resource: string): string { return '/api/agent-net' + (this.delegation ? '/guest' : '') + resource; }
  async header(method: string, path: string, body: string | Uint8Array = ''): Promise<string> {
    this.options.assertCurrent();
    const entropy = await this.signer.random();
    this.options.assertCurrent();
    if (fromBase64Url(entropy).length < 18) throw new Error('INVALID_NATIVE_RANDOM');
    const plain = { at: Date.now(), nonce: entropy.slice(0, 24) };
    const hash = this.options.sha256(typeof body === 'string' ? utf8(body) : body);
    const signature = await this.signer.sign(requestPayload(method, this.delegation ? guestRequestPath(path, this.delegation.networkId, this.delegation.id) : path, hash, plain));
    this.options.assertCurrent();
    return (this.delegation ? 'AgentNetGuest ' : 'AgentNet ') + toBase64Url(utf8(JSON.stringify({
      ...(this.delegation ? { networkId: this.delegation.networkId, delegationId: this.delegation.id } : { certificate: this.certificate }), proof: { ...plain, signature } })));
  }
  async request<T = Record<string, unknown>>(method: string, resource: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    const path = this.path(resource), body = input === undefined ? '' : JSON.stringify(input);
    const authorization = await this.header(method, path, body);
    this.options.assertCurrent();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    const abort = () => controller.abort();
    if (options?.signal?.aborted) controller.abort();
    else options?.signal?.addEventListener('abort', abort, { once: true });
    const readTransport = async <R>(read: () => Promise<R>, status?: number): Promise<R> => {
      try { return await read(); }
      catch (error) {
        this.options.assertCurrent();
        // Only Fetch/body transport errors are transient. Caller cancellation,
        // invalid JSON and authenticated server rejections keep their meaning.
        if (!options?.signal?.aborted) {
          if (status && status >= 400) throw new PortableAgentNetClientError(status, 'AGENT_NET_REQUEST_FAILED');
          if (controller.signal.aborted) throw new PortableAgentNetClientError(0, 'AGENT_NET_REQUEST_TIMEOUT');
          if (error instanceof TypeError || (error as { name?: unknown } | null)?.name === 'AbortError') {
            throw new PortableAgentNetClientError(0, 'AGENT_NET_NETWORK_ERROR');
          }
        }
        throw error;
      }
    };
    try {
      const response = await readTransport(() => (this.options.fetch ?? fetch)(this.base + path, {
        method, headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body } : {}), redirect: 'error', signal: controller.signal,
      }));
      this.options.assertCurrent();
      const result = await readTransport(() => response.json(), response.status) as { error?: { code?: unknown } };
      this.options.assertCurrent();
      if (!response.ok) throw new PortableAgentNetClientError(response.status,
        typeof result.error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.error.code)
          ? result.error.code : 'AGENT_NET_REQUEST_FAILED');
      return result as T;
    } finally {
      clearTimeout(timer); options?.signal?.removeEventListener('abort', abort);
    }
  }
  trustedDirectory(devices: DeviceView[], delegations: Delegation[], requests: DelegationRequest[] = []): boolean {
    return devices.every(view => {
      const c = view?.certificate;
      return c && this.options.verifyCertificate(this.rootPublicKey, c, c.issuedAt) && c.issuedAt <= Date.now() + 30_000
        && c.networkId === this.certificate.networkId && c.subject === this.certificate.subject;
    }) && delegations.every(delegation => this.options.verifyDelegation?.(this.rootPublicKey, delegation)
      && delegation.networkId === this.certificate.networkId && delegationVisibleTo(delegation, this.identity, this.delegation))
      && requests.length <= 128 && (!this.delegation || requests.length === 0)
      && requests.every(request => delegationRequestPolicyValid(request, this.certificate));
  }
  async directory(): Promise<DeviceView[]> {
    const result = await this.request<{ rootPublicKey: string; devices: DeviceView[] }>('GET', '/directory');
    if (result.rootPublicKey !== this.rootPublicKey || !Array.isArray(result.devices) || !this.trustedDirectory(result.devices, [])) {
      throw new Error('UNTRUSTED_DIRECTORY');
    }
    return result.devices;
  }
  private async mediaRequest<T>(method: string, resource: string, consume: (response: Response) => Promise<T>, body?: Uint8Array, range?: string, signal?: AbortSignal,
    extraHeaders: Record<string, string> = {}): Promise<T> {
    const path = this.path(resource), authorization = await this.header(method, path, body);
    this.options.assertCurrent();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await (this.options.fetch ?? fetch)(this.base + path, { method, headers: { authorization,
        ...(body ? { 'content-type': 'application/octet-stream', 'x-agent-net-content-sha256': this.options.sha256(body) } : {}),
        ...(range ? { range } : {}), ...extraHeaders }, ...(body ? { body: new Uint8Array(body) } : {}), redirect: 'error', signal: controller.signal });
      this.options.assertCurrent();
      if (!response.ok) throw new PortableAgentNetClientError(response.status, 'AGENT_NET_MEDIA_REQUEST_FAILED');
      const result = await consume(response); this.options.assertCurrent(); return result;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Release an unread/failed response as well as the request. Keep the
      // caller and deadline attached until the consumer has finished the body.
      controller.abort();
    }
  }
  /**
   * Starts an encrypted upload, offering direct transfer when an MD5 digest is available. A relay whose storage
   * clients can reach grants it and the chunks go to the storage itself; any other relay ignores the offer.
   */
  async createMedia(recipient: string, size: number, signal?: AbortSignal): Promise<{ id: string; chunkBytes: number }> {
    const created = await this.request<{ id: string; chunkBytes: number; transfer?: unknown }>('POST', '/media', {
      recipient, size, chunkFormat: 'binary-v1', ...(this.options.md5 && this.directReachable() ? { transfer: MEDIA_TRANSFER_DIRECT } : {}),
    }, { signal });
    if (created.transfer === MEDIA_TRANSFER_DIRECT && this.options.md5) {
      if (this.directUploads.size >= 64) this.directUploads.delete(this.directUploads.values().next().value!);
      this.directUploads.add(created.id);
    }
    return { id: created.id, chunkBytes: created.chunkBytes };
  }
  private directReachable(): boolean { return Date.now() >= this.directUnreachableUntil; }
  /** A network that reaches the relay but not the storage (a firewall that allows only the relay, say) keeps
   * working through the relay, which reads and writes the same storage. */
  private directUnreachable(): void { this.directUnreachableUntil = Date.now() + DIRECT_STORAGE_RETRY_MS; this.directReads.clear(); }
  /** A storage request from the relay; plain HTTP only when the relay itself is reached over plain HTTP. */
  private directRequest(value: unknown): DirectMediaRequest {
    if (!directMediaRequestValid(value)) throw new Error('INVALID_DIRECT_MEDIA_REQUEST');
    if (new URL(value.url).protocol !== 'https:' && new URL(this.base).protocol !== 'http:') throw new Error('INSECURE_DIRECT_MEDIA_REQUEST');
    return value;
  }
  /** One storage request under the same deadline/cancellation rules as relay media requests. */
  private async storageRequest<T>(target: DirectMediaRequest, consume: (response: Response) => Promise<T>, body?: Uint8Array, range?: string,
    signal?: AbortSignal): Promise<T | typeof STORAGE_UNREACHABLE> {
    this.options.assertCurrent();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(target.url, { method: target.method, headers: { ...target.headers, ...(range ? { range } : {}) },
          ...(body ? { body: new Uint8Array(body) } : {}), redirect: 'error', signal: controller.signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        this.options.assertCurrent(); return STORAGE_UNREACHABLE;
      }
      this.options.assertCurrent();
      const result = await consume(response); this.options.assertCurrent(); return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  private async putDirectMediaChunk(id: string, offset: number, body: Uint8Array, signal?: AbortSignal): Promise<{ received: number; complete: boolean }> {
    const resource = '/media/' + encodeURIComponent(id);
    const md5 = toBase64Url(this.options.md5!(body)).replace(/-/g, '+').replace(/_/g, '/') + '==';
    const target = this.directRequest((await this.request<{ request: unknown }>('POST', resource + '/upload', { offset, size: body.length, md5 }, { signal })).request);
    // A lost reply does not mean a lost write: the relay reads the stored length from the storage.
    let rejected: number | undefined, unreachable = false;
    try {
      const stored = await this.storageRequest(target, async response => { await response.body?.cancel().catch(() => undefined); return response.ok ? undefined : response.status; }, body, undefined, signal);
      if (stored === STORAGE_UNREACHABLE) unreachable = true; else rejected = stored;
    } catch (error) { if (signal?.aborted) throw error; this.options.assertCurrent(); }
    const result = await this.request<{ received: number; complete: boolean }>('POST', resource + '/commit', undefined, { signal });
    if (unreachable && result.received === offset) {
      // Nothing landed: the rest of this upload goes through the relay.
      this.directUploads.delete(id); this.directUnreachable();
      return this.putMediaChunk(id, offset, body, signal);
    }
    if (result.received !== offset + body.length) throw new PortableAgentNetClientError(rejected ?? 0, rejected ? 'MEDIA_STORAGE_REJECTED' : 'MEDIA_OFFSET_MISMATCH');
    if (result.complete) this.directUploads.delete(id);
    return result;
  }
  async putMediaChunk(id: string, offset: number, body: Uint8Array, signal?: AbortSignal): Promise<{ received: number; complete: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || body.length < 1 || body.length > MAX_MEDIA_BINARY_CHUNK_BYTES) throw new Error('INVALID_MEDIA_CHUNK');
    if (this.directUploads.has(id)) return this.putDirectMediaChunk(id, offset, body, signal);
    return this.mediaRequest('PUT', '/media/' + encodeURIComponent(id) + '?offset=' + offset,
      response => response.json(), body, undefined, signal);
  }
  /** Consume the body within this scope so abort/timeout outlive the headers. */
  async withMediaResponse<T>(id: string, range: string, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const refused = Symbol('refused');
    const fromStorage = (target: DirectMediaRequest) => this.storageRequest(target, async response => {
      if (response.status === 403) { await response.body?.cancel().catch(() => undefined); return refused; }
      if (!response.ok && response.status !== 206) { await response.body?.cancel().catch(() => undefined); throw new PortableAgentNetClientError(response.status, 'MEDIA_STORAGE_READ_FAILED'); }
      return consume(response);
    }, undefined, range, signal);
    const cached = this.directReachable() ? this.directReads.get(id) : undefined;
    if (cached && cached.until > Date.now()) {
      const result = await fromStorage(cached.request);
      if (result !== refused && result !== STORAGE_UNREACHABLE) return result;
      // Revoked or expired early: ask the relay again, which re-checks access.
      if (result === STORAGE_UNREACHABLE) this.directUnreachable(); else this.directReads.delete(id);
    }
    const direct = this.directReachable();
    const granted = await this.mediaRequest<{ relayed: T } | { target: DirectMediaRequest }>('GET', '/media/' + encodeURIComponent(id), async response => {
      if (response.headers.get(MEDIA_TRANSFER_HEADER) !== MEDIA_TRANSFER_DIRECT) return { relayed: await consume(response) as T };
      return { target: this.directRequest(((await response.json()) as { request?: unknown }).request) };
    }, undefined, range, signal, direct ? { [MEDIA_TRANSFER_HEADER]: MEDIA_TRANSFER_DIRECT } : {});
    if ('relayed' in granted) return granted.relayed;
    if (this.directReads.size >= 64) this.directReads.delete(this.directReads.keys().next().value!);
    this.directReads.set(id, { request: granted.target, until: Math.min(granted.target.expiresAt - 30_000, Date.now() + 10 * 60_000) });
    const result = await fromStorage(granted.target);
    if (result === STORAGE_UNREACHABLE) {
      // The relay serves this read (and the next ones for a while) itself.
      this.directUnreachable(); return this.withMediaResponse(id, range, consume, signal);
    }
    if (result === refused) throw new PortableAgentNetClientError(403, 'MEDIA_STORAGE_READ_FAILED');
    return result;
  }
  async connect(): Promise<SocketUplink> {
    const path = this.path('/ws'), header = await this.header('GET', path);
    this.options.assertCurrent();
    const ws = this.options.createWebSocket(this.base.replace(/^http/, 'ws') + path, { authorization: header });
    ws.binaryType = 'arraybuffer';
    return PortableUplink.open(ws, this);
  }
}

class PortableUplink extends SocketEvents implements SocketUplink {
  readonly kind = 'agent-net';
  devices: DeviceView[] = [];
  delegations: Delegation[] = [];
  delegationRequests: DelegationRequest[] = [];
  notifications = false;
  private receiver: ((deviceId: string, data: Uint8Array) => void) | null = null;
  private pending: [string, Uint8Array][] = [];
  private pendingBytes = 0;
  private queues = new Map<string, Uint8Array[]>();
  private queuedBytes = 0;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private constructor(private ws: BinarySocket) { super(); }
  static open(ws: BinarySocket, client: PortableAgentNetClient): Promise<PortableUplink> {
    const uplink = new PortableUplink(ws);
    return new Promise((resolve, reject) => {
      let established = false, receivedHello = false;
      const timer = setTimeout(() => fail(new Error('AGENT_NET_HANDSHAKE_TIMEOUT')), 10_000);
      const fail = (error: Error) => { clearTimeout(timer); if (!established) reject(error); uplink.close(); };
      let chain = Promise.resolve(), waiting = 0;
      ws.onerror = event => {
        const status = typeof event.message === 'string' ? /\b(401|403)\b/.exec(event.message)?.[1] : undefined;
        fail(new Error(status ? 'AGENT_NET_UPGRADE_' + status : 'AGENT_NET_SOCKET_ERROR'));
      };
      ws.onclose = event => {
        clearTimeout(timer); if (!established) reject(new Error('AGENT_NET_CLOSED_' + event.code));
        uplink.closed = true;
        uplink.emit('close', event.code);
      };
      ws.onmessage = event => {
        if (uplink.closed) return;
        if (++waiting > 512) { fail(new Error('AGENT_NET_RECEIVE_BACKPRESSURE')); return; }
        const receive = async () => {
          if (uplink.closed) return;
          client.options.assertCurrent();
          if (typeof event.data === 'string') {
            if (utf8(event.data).length > MAX_CONTROL_BYTES) throw new Error('INVALID_CONTROL');
            const message = JSON.parse(event.data) as { type: string; deviceId: string; protocolVersion?: number; notifications?: boolean; devices: DeviceView[]; delegations: Delegation[]; delegationRequests?: DelegationRequest[] };
            const requests = message.delegationRequests ?? [];
            if (!['hello', 'directory'].includes(message.type) || !Array.isArray(message.devices) || !Array.isArray(message.delegations)
              || !Array.isArray(requests) || !client.trustedDirectory(message.devices, message.delegations, requests)) throw new Error('UNTRUSTED_DIRECTORY');
            uplink.devices = message.devices;
            uplink.delegations = message.delegations;
            uplink.delegationRequests = requests;
            if (message.type === 'hello') {
              if (receivedHello || message.protocolVersion !== 2
                || message.deviceId !== (client.delegation ? 'guest:' + client.delegation.id : client.identity.deviceId)) throw new Error('INVALID_HELLO');
              uplink.notifications = message.notifications === true;
              receivedHello = true; established = true; clearTimeout(timer); resolve(uplink);
            } else {
              if (!receivedHello) throw new Error('INVALID_HELLO');
              uplink.emit('directory');
            }
            return;
          }
          if (!receivedHello) throw new Error('INVALID_HELLO');
          let bytes: Uint8Array;
          if (event.data instanceof ArrayBuffer) bytes = new Uint8Array(event.data);
          else if (ArrayBuffer.isView(event.data)) bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
          else throw new Error('INVALID_DATAGRAM_FRAME');
          const frame = decodeDatagrams(bytes);
          if (!frame) throw new Error('INVALID_DATAGRAM_FRAME');
          for (const packet of frame.datagrams) {
            if (uplink.receiver) uplink.receiver(frame.deviceId, packet);
            else {
              if (uplink.pending.length >= 512 || uplink.pendingBytes + packet.length > 1024 * 1024) throw new Error('AGENT_NET_RECEIVE_BACKPRESSURE');
              uplink.pending.push([frame.deviceId, packet.slice()]); uplink.pendingBytes += packet.length;
            }
          }
        };
        chain = chain.then(receive).catch(error => fail(error instanceof Error ? error : new Error('INVALID_CONTROL')))
          .finally(() => { waiting--; });
      };
    });
  }
  onDatagram(receiver: (deviceId: string, bytes: Uint8Array) => void): void {
    this.receiver = receiver;
    for (const [id, data] of this.pending) receiver(id, data);
    this.pending = []; this.pendingBytes = 0;
  }
  send(deviceId: string, data: Uint8Array): void {
    if (this.closed || this.ws.readyState !== 1 || !data.length || data.length > 65_000
      || this.queuedBytes + data.length > 1024 * 1024 || this.queues.size >= 256) return;
    const packets = this.queues.get(deviceId) ?? [];
    packets.push(data.slice()); this.queues.set(deviceId, packets); this.queuedBytes += data.length;
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      const queues = this.queues; this.queues = new Map(); this.queuedBytes = 0;
      for (const [id, packets] of queues) {
        let batch: Uint8Array[] = [], size = 2 + id.length;
        const flush = () => {
          if (batch.length && !this.closed && this.ws.readyState === 1 && this.ws.bufferedAmount <= 1024 * 1024) {
            try { this.ws.send(encodeDatagrams(id, batch)); } catch { /* Core retransmits dropped datagrams. */ }
          }
          batch = []; size = 2 + id.length;
        };
        for (const packet of packets) {
          if (size + 2 + packet.length > MAX_FRAME_BYTES) flush();
          batch.push(packet); size += packet.length + 2;
        }
        flush();
      }
    }, 0);
  }
  presence(remoteControlEnabled: boolean, capabilities: readonly string[], metadata: import('@cindy/agent-net-protocol').DeviceMetadata = {}): void {
    if (!this.closed && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'presence', remoteControlEnabled, capabilities,
      platform: metadata.platform, app: metadata.app, appVersion: metadata.appVersion, busy: metadata.busy, deviceName: metadata.deviceName }));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled); this.scheduled = null;
    this.pending = []; this.pendingBytes = 0; this.queues.clear(); this.queuedBytes = 0;
    this.ws.close();
  }
}
