import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import WebSocket from 'ws';
import type { AgentNetClient } from '@cindy/agent-net-relay/client';
import { delegationVisibleTo, type DeviceCertificate, type DeviceView, type Delegation } from '@cindy/agent-net-protocol';
import { verifyDelegation } from '@cindy/agent-net-relay';
import { delegatedPeerTarget, type ScopedPeerTarget } from './scopedRoutes.js';
import { MAX_CONTROL_BYTES } from '@cindy/agent-net-protocol';
import type { AgentNetSocketOptions } from './socket.js';

export type AgentNetAppSocket = Pick<import('./socket.js').AgentNetSocket,
  'send' | 'close' | 'terminate' | 'bufferedAmount' | 'deviceId' |
  'replaceClient' | 'supports' | 'knowsPeer' | 'certificateFor' | 'scopedPeerTarget' | 'pathTo' | 'peerSnapshot'> & {
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    removeListener(event: string, listener: (...args: any[]) => void): void;
  };
export function workerClient(client: AgentNetClient) {
  return { base: client.base, identity: client.identity, certificate: client.certificate, rootPublicKey: client.rootPublicKey,
    delegation: client.delegation, ownerPinnedHttp: client.transport.ownerPinnedHttp };
}
/** The encrypted transport/parser runs off Main; privileged outbound sockets retain the host's proxy policy. */
export class AgentNetWorkerSocket extends EventEmitter implements AgentNetAppSocket {
  private worker!: Worker;
  private readonly network = new Map<number, WebSocket>();
  private readonly http = new Map<number, AbortController>();
  private readonly known = new Set<string>();
  private directory = new Map<string, DeviceCertificate>();
  private delegations: Delegation[] = [];
  private status = new Map<string, { available: boolean; path: 'direct' | 'relay' | null; rttMs: number | null }>();
  private queued = 0;
  private remoteQueued = 0;
  private closed = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private request = 0;
  private readonly renewals = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private readonly options: AgentNetSocketOptions, private client: AgentNetClient) { super(); }
  static async open(options: AgentNetSocketOptions & { workerFile: string | URL }): Promise<AgentNetWorkerSocket> {
    options.assertCurrent?.();
    const socket = new AgentNetWorkerSocket(options, options.client);
    socket.worker = new Worker(options.workerFile, { resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AGENT_NET_WORKER_START_TIMEOUT')), 15_000); timer.unref();
      const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      socket.worker.on('message', (message) => {
        try {
        options.assertCurrent?.();
        if (message.type === 'ready') { finish(); return; }
        if (message.type === 'failed') { finish(new Error(message.code)); socket.dispose(4410); return; }
        socket.receive(message);
        } catch { finish(new Error('AGENT_NET_OWNER_CHANGED')); socket.dispose(1006); }
      });
      socket.worker.once('error', () => { finish(new Error('AGENT_NET_WORKER_FAILED')); socket.dispose(1006); });
      socket.worker.once('exit', () => { finish(new Error('AGENT_NET_WORKER_EXITED')); socket.dispose(1006); });
    });
    const { onDirectory: _directory, onDelegationRequests: _requests, onDelegations: _grants, onPathChanged: _path, tap: _tap, client: _client, workerFile: _file, assertCurrent: _guard, ...portable } = options;
    socket.worker.postMessage({ type: 'init', options: portable, client: workerClient(options.client), tap: !!options.tap });
    try { await ready; setImmediate(() => { if (!socket.closed) socket.emit('open'); }); return socket; }
    catch (error) { socket.dispose(1006); throw error; }
  }
  get deviceId() { return this.client.identity.deviceId; }
  get bufferedAmount() { return this.queued + this.remoteQueued; }
  knowsPeer(id: string) { return this.known.has(id); }
  supports(id: string) { return !this.closed && this.status.get(id)?.available === true; }
  certificateFor(id: string) { return this.directory.get(id); }
  scopedPeerTarget(peer: string): ScopedPeerTarget | null {
    this.options.assertCurrent?.();
    if (this.closed || this.closeTimer) return null;
    const own = this.client.delegation && this.delegations.find(d => delegationVisibleTo(d, this.client.identity, this.client.delegation));
    if (this.client.delegation) return own && verifyDelegation(this.client.rootPublicKey, own) ? delegatedPeerTarget(own, peer, 'guest') : null;
    for (const delegation of this.delegations) {
      const target = verifyDelegation(this.client.rootPublicKey, delegation) && delegationVisibleTo(delegation, this.client.identity)
        && delegatedPeerTarget(delegation, peer, 'host');
      if (target) return target;
    }
    return null;
  }
  pathTo(id: string) { return this.status.get(id)?.path ?? null; }
  peerSnapshot(id: string) { const status = this.status.get(id); return status?.path ? { path: status.path, rttMs: status.rttMs } : null; }
  send(frame: string): void {
    this.options.assertCurrent?.();
    const bytes = Buffer.byteLength(frame);
    if (this.closed) throw new Error('AGENT_NET_SOCKET_CLOSED');
    if (bytes > 2 * 1024 * 1024 || this.queued + bytes > 8 * 1024 * 1024) throw new Error('BACKPRESSURE');
    this.queued += bytes; this.worker.postMessage({ type: 'frame', frame, bytes });
  }
  replaceClient(next: AgentNetClient): Promise<void> {
    this.options.assertCurrent?.();
    if (this.closed || this.renewals.size) return Promise.reject(new Error('AGENT_NET_SOCKET_CLOSED'));
    const id = ++this.request;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.renewals.delete(id); reject(new Error('AGENT_NET_RENEW_TIMEOUT')); }, 15_000); timer.unref();
      this.renewals.set(id, { resolve: () => { this.client = next; resolve(); }, reject, timer });
      this.worker.postMessage({ type: 'renew', id, client: workerClient(next) });
    });
  }
  private receive(message: any): void {
    if (this.closed) return;
    if (message.type === 'http-request') { void this.controlRequest(message); return; }
    if (message.type === 'http-cancel') { this.http.get(message.id)?.abort(); return; }
    if (message.type === 'ack') { this.queued = Math.max(0, this.queued - message.bytes); return; }
    if (message.type === 'renewed') {
      const pending = this.renewals.get(message.id); if (!pending) return;
      this.renewals.delete(message.id); clearTimeout(pending.timer);
      if (message.code) pending.reject(new Error(message.code)); else pending.resolve(); return;
    }
    if (message.type === 'closed') { this.dispose(message.code); return; }
    if (message.type === 'delegation-requests') { this.options.onDelegationRequests?.(message.requests); return; }
    if (message.type === 'delegations') {
      this.delegations = Array.isArray(message.delegations) ? message.delegations.filter((d: unknown): d is Delegation =>
        verifyDelegation(this.client.rootPublicKey, d) && d.networkId === this.client.certificate.networkId
        && delegationVisibleTo(d, this.client.identity, this.client.delegation)) : [];
      this.options.onDelegations?.(this.delegations); return;
    }
    if (message.type === 'directory') {
      const directory = message.directory as DeviceView[];
      this.directory = new Map(directory.map((view) => [view.certificate.deviceId, view.certificate]));
      for (const view of directory) this.known.add(view.certificate.deviceId);
      if (!message.cached) this.options.onDirectory?.(directory); return;
    }
    if (message.type === 'status') {
      this.remoteQueued = message.queued; this.status = new Map(message.peers);
      for (const id of message.known) this.known.add(id); return;
    }
    if (message.type === 'path') { this.options.onPathChanged?.(message.id, message.path); return; }
    if (message.type === 'frame-in') { this.emit('message', { toString: () => message.frame }); return; }
    if (message.type === 'tap') { this.options.tap?.(message.data, message.via); return; }
    if (message.type === 'ws-open') {
      const expected = this.client.base.replace(/^http/, 'ws') + this.client.path('/ws');
      if (message.url !== expected || this.network.size >= 4 || this.network.has(message.id)) { this.dispose(1006); return; }
      const factory = this.client.transport.createWebSocket ?? ((url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options));
      void Promise.resolve(factory(message.url, { headers: message.headers, maxPayload: MAX_CONTROL_BYTES })).then((ws) => {
        try { this.options.assertCurrent?.(); } catch { ws.terminate(); this.dispose(1006); return; }
        if (this.closed) { ws.terminate(); return; }
        this.network.set(message.id, ws);
        const relay = (event: string, value?: unknown, binary?: boolean) => { if (!this.closed) this.worker.postMessage({ type: 'ws-event', id: message.id, event, value, binary }); };
        ws.on('open', () => relay('open'));
        ws.on('message', (value, binary) => relay('message', new Uint8Array(Buffer.isBuffer(value) ? value : Buffer.from(value as ArrayBuffer)), binary));
        ws.on('error', () => relay('error'));
        ws.on('unexpected-response', (_req, response) => { response.resume(); relay('unexpected-response', response.statusCode); });
        ws.on('close', (code) => { this.network.delete(message.id); relay('close', code); });
      }).catch(() => { if (!this.closed) this.worker.postMessage({ type: 'ws-event', id: message.id, event: 'error' }); });
      return;
    }
    const ws = this.network.get(message.id);
    if (message.type === 'ws-close') { ws?.terminate(); this.network.delete(message.id); }
    else if (message.type === 'ws-send' && ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 1024 * 1024) {
      ws.send(typeof message.data === 'string' ? message.data : Buffer.from(message.data));
    }
  }
  private async controlRequest(message: any): Promise<void> {
    const controller = new AbortController();
    try {
      this.options.assertCurrent?.();
      // The worker can request only its fixed selected origin and these public
      // control operations. It cannot turn the Main proxy into arbitrary fetch.
      const expected = message.method === 'GET' ? this.client.path('/directory')
        : message.method === 'POST' ? this.client.path('/notify') : null;
      if (!expected || message.url !== this.client.base + expected || this.http.size >= 4 || this.http.has(message.id)
        || (message.body !== undefined && (typeof message.body !== 'string' || Buffer.byteLength(message.body) > 16_384))) {
        throw new Error('AGENT_NET_INVALID_CONTROL_REQUEST');
      }
      this.http.set(message.id, controller);
      const response = await (this.client.transport.fetch ?? fetch)(message.url, { method: message.method,
        headers: message.headers, ...(message.body ? { body: message.body } : {}), redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      const parts: Uint8Array[] = []; let size = 0;
      const reader = response.body?.getReader();
      try {
        if (reader) while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          if (size > MAX_CONTROL_BYTES) throw new Error('AGENT_NET_CONTROL_TOO_LARGE');
          parts.push(chunk.value);
        }
      } finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      this.options.assertCurrent?.();
      if (!this.closed && !controller.signal.aborted) this.worker.postMessage({ type: 'http-result', id: message.id,
        status: response.status, body: new Uint8Array(Buffer.concat(parts)) });
    } catch {
      if (!this.closed) this.worker.postMessage({ type: 'http-result', id: message.id, error: true });
    } finally { if (this.http.get(message.id) === controller) this.http.delete(message.id); }
  }
  private dispose(code: number) {
    if (this.closed) return; this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    for (const request of this.http.values()) request.abort(); this.http.clear();
    for (const ws of this.network.values()) ws.terminate(); this.network.clear();
    for (const request of this.renewals.values()) { clearTimeout(request.timer); request.reject(new Error('AGENT_NET_SOCKET_CLOSED')); }
    this.renewals.clear(); this.status.clear(); this.delegations = []; this.queued = 0; this.remoteQueued = 0;
    void this.worker.terminate(); setImmediate(() => this.emit('close', code, ''));
  }
  close(code = 1000) { if (!this.closed && !this.closeTimer) { this.worker.postMessage({ type: 'close', code }); this.closeTimer = setTimeout(() => this.dispose(code), 2000); this.closeTimer.unref(); } }
  terminate() { this.dispose(1006); }
}
