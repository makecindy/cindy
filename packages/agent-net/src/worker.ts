import { parentPort } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import { AgentNetSocket, type AgentNetSocketOptions } from './socket.js';

if (!parentPort) throw new Error('AGENT_NET_WORKER_PORT_REQUIRED');
const port = parentPort, send = (value: unknown) => port.postMessage(value);
const network = new Map<number, NetworkSocket>(); let sequence = 0;
const http = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
const hostFetch: typeof fetch = (input, init) => new Promise((resolve, reject) => {
  if (typeof input !== 'string' || (init?.body !== undefined && typeof init.body !== 'string')) {
    reject(new Error('AGENT_NET_INVALID_CONTROL_REQUEST')); return;
  }
  const id = ++sequence, signal = init?.signal;
  const cleanup = () => { clearTimeout(deadline); signal?.removeEventListener('abort', abort); http.delete(id); };
  const abort = () => { cleanup(); send({ type: 'http-cancel', id }); reject(new Error('AGENT_NET_REQUEST_CANCELLED')); };
  const deadline = setTimeout(abort, 10_000); deadline.unref();
  if (signal?.aborted) { abort(); return; }
  signal?.addEventListener('abort', abort, { once: true });
  http.set(id, { resolve(value) { cleanup(); resolve(value); }, reject(error) { cleanup(); reject(error); } });
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
  send({ type: 'http-request', id, url: input, method: init?.method ?? 'GET',
    headers, body: init?.body });
});
let socket: AgentNetSocket | undefined, timer: ReturnType<typeof setInterval> | undefined;
let receivedDirectory = false;
const ids = new Set<string>();
const code = (error: unknown) => error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'AGENT_NET_WORKER_FAILED';
class NetworkSocket extends EventEmitter {
  readonly id = ++sequence;
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  constructor(url: string, headers: unknown) { super(); network.set(this.id, this); send({ type: 'ws-open', id: this.id, url, headers }); }
  send(data: unknown) { if (this.readyState === WebSocket.OPEN) send({ type: 'ws-send', id: this.id, data }); }
  terminate() { this.readyState = WebSocket.CLOSED; network.delete(this.id); send({ type: 'ws-close', id: this.id }); }
}
function client(value: any): AgentNetClient {
  return new AgentNetClient(value.base, value.identity, value.certificate, value.rootPublicKey, value.delegation, {
    ownerPinnedHttp: value.ownerPinnedHttp,
    fetch: hostFetch,
    createWebSocket: async (url, options) => new NetworkSocket(url, options.headers) as unknown as WebSocket,
  });
}
function snapshot() {
  if (!socket) return;
  send({ type: 'status', queued: socket.bufferedAmount, known: [...ids], peers: [...ids].map((id) => [id, {
    available: socket!.supports(id), path: socket!.pathTo(id), rttMs: socket!.peerSnapshot(id)?.rttMs ?? null,
  }]) });
}
port.on('message', (message) => {
  if (message.type === 'http-result') {
    const pending = http.get(message.id); if (!pending) return;
    if (message.error) pending.reject(new Error('AGENT_NET_CONTROL_NETWORK_ERROR'));
    else pending.resolve(new Response(message.status === 204 ? null : message.body,
      { status: message.status, headers: { 'content-type': 'application/json' } }));
    return;
  }
  if (message.type === 'ws-event') {
    const ws = network.get(message.id); if (!ws) return;
    if (message.event === 'open') { ws.readyState = WebSocket.OPEN; ws.emit('open'); }
    if (message.event === 'message') ws.emit('message', Buffer.from(message.value), message.binary);
    if (message.event === 'error') ws.emit('error', new Error('AGENT_NET_NETWORK_ERROR'));
    if (message.event === 'unexpected-response') ws.emit('unexpected-response', {}, { statusCode: message.value, resume() {} });
    if (message.event === 'close') { ws.readyState = WebSocket.CLOSED; network.delete(ws.id); ws.emit('close', message.value); }
    return;
  }
  if (message.type === 'init' && !socket) {
    const options = message.options as AgentNetSocketOptions;
    for (const view of options.cachedDirectory ?? []) ids.add(view.certificate.deviceId);
    void AgentNetSocket.open({ ...options, client: client(message.client),
      onDirectory(directory) { receivedDirectory = true; for (const view of directory) ids.add(view.certificate.deviceId); send({ type: 'directory', directory }); snapshot(); },
      onDelegationRequests(requests) { send({ type: 'delegation-requests', requests }); },
      onDelegations(delegations) { send({ type: 'delegations', delegations }); },
      onPathChanged(id, path) { ids.add(id); send({ type: 'path', id, path }); snapshot(); },
      ...(message.tap ? { tap: (data, via) => send({ type: 'tap', data, via }) } : {}),
    }).then((value) => {
      socket = value;
      if (!receivedDirectory) send({ type: 'directory', cached: true, directory: (options.cachedDirectory ?? []).filter((view) =>
        socket!.certificateFor(view.certificate.deviceId)?.signature === view.certificate.signature) });
      socket.on('message', (raw) => { send({ type: 'frame-in', frame: raw.toString() }); snapshot(); });
      socket.once('close', (status) => { if (timer) clearInterval(timer); send({ type: 'closed', code: status }); });
      snapshot(); timer = setInterval(snapshot, 1000); timer.unref(); send({ type: 'ready' });
    }).catch((error) => send({ type: 'failed', code: code(error) }));
    return;
  }
  if (!socket) return;
  if (message.type === 'frame') {
    try { socket.send(message.frame); } catch (error) { send({ type: 'failed', code: code(error) }); }
    finally { send({ type: 'ack', bytes: message.bytes }); snapshot(); }
  }
  if (message.type === 'renew') void socket.replaceClient(client(message.client)).then(() => send({ type: 'renewed', id: message.id }),
    (error) => send({ type: 'renewed', id: message.id, code: code(error) }));
  if (message.type === 'close') socket.close(message.code);
});
