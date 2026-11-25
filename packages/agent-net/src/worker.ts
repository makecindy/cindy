import { parentPort } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import { AgentNetSocket, type AgentNetSocketOptions } from './socket.js';
import { serveWorkerSessions } from './session/workerSessions.js';

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
let sessionMessage: ((message: unknown) => boolean) | undefined;
let receivedDirectory = false;
const ids = new Set<string>();
const code = (error: unknown) => error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'AGENT_NET_WORKER_FAILED';
class NetworkSocket extends EventEmitter {
  readonly id = ++sequence;
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  constructor(url: string, headers: unknown) { super(); network.set(this.id, this); send({ type: 'ws-open', id: this.id, url, headers }); }
  send(data: unknown) { if (this.readyState === WebSocket.OPEN) send({ type: 'ws-send', id: this.id, data }); }
  /**
   * Like `ws`, ends in 'close' (1006) on the next turn. This socket is forgotten here right away, so the close Main reports for
   * it afterwards is dropped: without this event the uplink that ended its own relay connection (a frame it refused) never
   * heard that it was gone, and the socket kept it as its relay connection and never reconnected (2026-11-25: 4.5 hours
   * until the app was restarted).
   */
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED; network.delete(this.id); send({ type: 'ws-close', id: this.id });
    setImmediate(() => this.emit('close', 1006));
  }
}
function client(value: any): AgentNetClient {
  return new AgentNetClient(value.base, value.identity, value.certificate, value.rootPublicKey, value.delegation, {
    ownerPinnedHttp: value.ownerPinnedHttp,
    fetch: hostFetch,
    createWebSocket: async (url, options) => new NetworkSocket(url, options.headers) as unknown as WebSocket,
  });
}
/**
 * The core took queued bytes: tell Main the new backlog in one message per event-loop turn, so Device Link there can
 * send its next large frame now instead of after the next status snapshot (1 s) and its own retry timer.
 */
let bufferedScheduled = false;
function reportBuffered() {
  if (bufferedScheduled) return;
  bufferedScheduled = true;
  setImmediate(() => { bufferedScheduled = false; if (socket) send({ type: 'buffered', queued: socket.bufferedAmount }); });
}
function snapshot() {
  const current = socket;
  if (!current) return;
  // The socket leaves a device out of the directory it reports when a later certificate has its transport key; it still
  // counts as a device seen on Agent-Net, and this is the only way its id gets here.
  for (const id of current.knownPeers()) ids.add(id);
  const known = [...ids];
  const peers = known.map((id) => {
    const route = current.peerSnapshot(id);
    return [id, {
      available: current.supports(id),
      path: route?.path ?? null,
      rttMs: route?.rttMs ?? null,
      directRttMs: route?.directRttMs ?? null,
      relayRttMs: route?.relayRttMs ?? null,
      pathPreference: route?.pathPreference ?? 'auto',
      dialing: current.isDialing(id),
    }];
  });
  // 经中转的数据报现在走中转的 UDP 还是 WebSocket（快照每秒一次，远程连接页最多晚一秒看到切换）。
  send({ type: 'status', queued: current.bufferedAmount, known, peers, relayRoute: current.relayRoute() });
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
      onRelayReplaced() { if (message.reportRelayReplacements) send({ type: 'relay-replaced' }); },
      onRelayClosed(closeCode, reason) { send({ type: 'relay-closed', code: closeCode, reason }); },
      ...(message.tap ? { tap: (data, via) => send({ type: 'tap', data, via }) } : {}),
    }).then((value) => {
      socket = value;
      sessionMessage = serveWorkerSessions(value, send);
      if (!receivedDirectory) send({ type: 'directory', cached: true, directory: (options.cachedDirectory ?? []).filter((view) =>
        socket!.certificateFor(view.certificate.deviceId)?.signature === view.certificate.signature) });
      socket.on('message', (raw) => { send({ type: 'frame-in', frame: raw.toString() }); snapshot(); });
      socket.onDrain(reportBuffered);
      socket.once('close', (status) => { if (timer) clearInterval(timer); send({ type: 'closed', code: status }); });
      snapshot(); timer = setInterval(snapshot, 1000); timer.unref(); send({ type: 'ready' });
    }).catch((error) => send({ type: 'failed', code: code(error) }));
    return;
  }
  if (!socket) return;
  if (sessionMessage?.(message)) return;
  if (message.type === 'frame') {
    try { socket.send(message.frame); } catch (error) { send({ type: 'failed', code: code(error) }); }
    finally { send({ type: 'ack', bytes: message.bytes }); snapshot(); }
  }
  if (message.type === 'renew') void socket.replaceClient(client(message.client)).then(() => send({ type: 'renewed', id: message.id }),
    (error) => send({ type: 'renewed', id: message.id, code: code(error) }));
  if (message.type === 'restrict' && message.rule && typeof message.rule === 'object') { socket.restrictPeers(message.rule); snapshot(); }
  if (message.type === 'set-peer-path-preference' && typeof message.deviceId === 'string'
    && (message.preference === 'auto' || message.preference === 'direct' || message.preference === 'relay')) {
    socket.setPeerPathPreference(message.deviceId, message.preference);
    snapshot();
  }
  if (message.type === 'network-changed') socket.networkChanged();
  if (message.type === 'duplicate-identity-cooldown') socket.setDuplicateIdentityCooldown(message.active === true);
  if (message.type === 'relay-stalled') socket.relayStalled();
  if (message.type === 'relay-restart') socket.restartRelay();
  if (message.type === 'close') socket.close(message.code);
});
