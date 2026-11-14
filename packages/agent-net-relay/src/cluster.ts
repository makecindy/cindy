import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpRequest, STATUS_CODES, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { ID_PATTERN } from '@cindy/agent-net-protocol';

/**
 * Horizontal scaling for the official relay (self-hosted relays stay one process).
 *
 * Every live connection and authenticated request of one account network is served by a single
 * replica, its owner, chosen by rendezvous hashing over the live member list. A replica that receives
 * another network's request passes the unchanged bytes to the owner, so routing, presence, revocation,
 * replay windows and attachment serialization keep their single-process semantics. Durable state is
 * replicated through the backend with optimistic commits; when a replica leaves, only the networks it
 * owned move, and their devices reconnect to the new owner.
 */

/**
 * What every replica of one cluster must agree on: the shapes of the shared state documents, the hop
 * between replicas (headers, `/_agent-net-cluster/*`) and the ownership function. A backend admits a
 * replica only when the live members advertise the same value, so a build that changes any of these
 * is rolled out by stopping the old replicas first instead of a rolling update. Bump it in that change.
 */
export const RELAY_CLUSTER_COMPAT = 1;

/** A replica as the other replicas reach it. `url` is an internal base URL, never the public one. */
export interface RelayClusterMember { id: string; url: string; }
/** One shared document. Versions start at 1 and grow by one per commit; 0 means the key never existed.
 * An entry without `value` is a deletion. */
export interface RelayStateEntry { key: string; version: number; value?: unknown; }
export type RelayStateCommit = { ok: true; versions: Record<string, number> } | { ok: false; latest: RelayStateEntry[] };
/**
 * What the replicas share. `createMemoryRelayCluster` is the in-process reference implementation;
 * a deployment supplies the same contract over its own database.
 */
export interface RelayClusterBackend {
  /** Every key at its latest committed version, including deletion tombstones. */
  snapshot(): Promise<RelayStateEntry[]>;
  /** Atomic: only when every `expected` key is still at that version, apply all writes. Otherwise
   * return the latest entries of the keys that moved. Empty writes still check every expected
   * version, providing a targeted read barrier without changing state or emitting a notification. */
  commit(input: { origin: string; expected: Record<string, number>; writes: { key: string; value?: unknown }[] }): Promise<RelayStateCommit>;
  /** Every state-changing commit, in commit order, delivered to every replica including its author. */
  onChange(listener: (entries: RelayStateEntry[]) => void): () => void;
  /** Request-proof replay protection across replicas: false when the nonce is already claimed. */
  claimNonce(id: string, expiresAt: number): Promise<boolean>;
  /** Serialize one attachment's file I/O AND state commit across all replicas, including during
   * ownership changes. Supply the latest network entry after acquiring the lock (notifications may
   * lag). Keep exclusivity until work settles; never expire/reassign a lock while its file I/O can
   * still run. A backend using expiring leases must fence/quiesce the previous writer first. */
  withMediaLock<T>(networkKey: string, mediaId: string, work: (network: RelayStateEntry) => Promise<T>): Promise<T>;
  join(member: RelayClusterMember): Promise<void>;
  leave(id: string): Promise<void>;
  /** Live replicas. A replica that stops without leaving must drop out after a short liveness timeout; a replica
   * that can no longer renew its own liveness must leave itself out. Once joined, a replica serves no network
   * that has no owner in this list (an empty list means it serves nothing). */
  members(): readonly RelayClusterMember[];
  onMembers(listener: (members: readonly RelayClusterMember[]) => void): () => void;
}
export interface RelayClusterOptions {
  backend: RelayClusterBackend;
  /** Stable for the replica's lifetime, unique in the cluster. */
  replicaId: string;
  /** Internal base URL the other replicas use; defaults to the relay's own listening URL. */
  url?: string;
  /** Shared by every replica; marks hops between replicas. Never sent to clients. */
  secret: string;
  /** After leaving, keep passing late requests to the new owners for this long before closing. */
  drainMs?: number;
}

export const CLUSTER_PATH = '/_agent-net-cluster';
const HOP_HEADER = 'x-agent-net-cluster-hop';
const CLIENT_HEADER = 'x-agent-net-cluster-client';
const FORWARD_TIMEOUT_MS = 10_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;

export function checkClusterOptions(options: RelayClusterOptions): RelayClusterOptions {
  if (typeof options.replicaId !== 'string' || !ID_PATTERN.test(options.replicaId)) throw new Error('INVALID_CLUSTER_REPLICA_ID');
  if (typeof options.secret !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(options.secret)) throw new Error('INVALID_CLUSTER_SECRET');
  if (options.url !== undefined) checkMemberUrl(options.url);
  if (options.drainMs !== undefined && (!Number.isSafeInteger(options.drainMs) || options.drainMs < 0 || options.drainMs > 120_000)) throw new Error('INVALID_CLUSTER_DRAIN');
  return options;
}
export function checkMemberUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_CLUSTER_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('INVALID_CLUSTER_URL');
  }
  return url;
}

/** Rendezvous hashing: adding or removing one replica only moves the networks it gains or loses. */
export function clusterOwner(networkId: string, members: readonly RelayClusterMember[]): RelayClusterMember | undefined {
  let owner: RelayClusterMember | undefined;
  let best = -1n;
  for (const member of members) {
    const score = createHash('sha256').update(member.id).update('\0').update(networkId).digest().readBigUInt64BE(0);
    if (score > best || (score === best && owner !== undefined && member.id < owner.id)) { owner = member; best = score; }
  }
  return owner;
}

/**
 * The network an authenticated request claims, read without verification: it only picks the replica,
 * and that replica still authenticates. Requests without one (joins, enrollment, health) stay local.
 */
export function routingNetwork(req: IncomingMessage, header: unknown = req.headers.authorization): string | undefined {
  if (typeof header !== 'string' || header.length > 16_384) return undefined;
  const space = header.indexOf(' ');
  const scheme = header.slice(0, space);
  if (scheme !== 'AgentNet' && scheme !== 'AgentNetGuest' && scheme !== 'AgentNetIdentity') return undefined;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(header.slice(space + 1), 'base64url').toString('utf8')); } catch { return undefined; }
  const field = (input: unknown, name: string): unknown => input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : undefined;
  const id = scheme === 'AgentNet' ? field(field(value, 'certificate'), 'networkId')
    : scheme === 'AgentNetGuest' ? field(value, 'networkId') ?? field(field(value, 'delegation'), 'networkId')
      : field(value, 'networkId');
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : undefined;
}

/**
 * Passes requests and WebSocket upgrades to the owning replica byte for byte. `source` resolves the
 * client address of a request that did not come from another replica (e.g. a trusted local proxy).
 */
export function createClusterRouter(options: { secret: string; source?: (req: IncomingMessage) => string }) {
  const secret = Buffer.from(options.secret);
  const sockets = new Set<Duplex>();
  const requests = new Set<ClientRequest>();
  const trusted = (req: IncomingMessage): boolean => {
    const value = req.headers[HOP_HEADER];
    if (typeof value !== 'string') return false;
    const bytes = Buffer.from(value);
    return bytes.length === secret.length && timingSafeEqual(bytes, secret);
  };
  const clientAddress = (req: IncomingMessage): string => {
    const forwarded = req.headers[CLIENT_HEADER];
    return trusted(req) && typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : options.source?.(req) ?? req.socket.remoteAddress ?? 'unknown';
  };
  const send = (target: RelayClusterMember, path: string, method: string, headers: Record<string, string | string[] | undefined>, upgrade = false): ClientRequest => {
    const url = checkMemberUrl(target.url);
    const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)({ hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined, path, method, headers });
    requests.add(outgoing); outgoing.once('close', () => requests.delete(outgoing));
    const timeout = () => outgoing.destroy(new Error('CLUSTER_TIMEOUT'));
    // A WebSocket has one bounded handshake. HTTP uploads instead have a bounded connect,
    // progress-based stream timeout, then a response-header deadline after the body is sent.
    let deadline = setTimeout(timeout, FORWARD_TIMEOUT_MS);
    deadline.unref();
    let received = false;
    const answered = () => { received = true; clearTimeout(deadline); };
    if (!upgrade) {
      outgoing.once('socket', socket => {
        if (!socket.connecting) clearTimeout(deadline);
        else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(deadline));
      });
      outgoing.once('finish', () => {
        if (received) return;
        clearTimeout(deadline); deadline = setTimeout(timeout, FORWARD_TIMEOUT_MS); deadline.unref();
      });
    }
    outgoing.once('response', answered);
    outgoing.once('close', answered);
    outgoing.setTimeout(STREAM_IDLE_TIMEOUT_MS, timeout);
    outgoing.once('upgrade', () => { answered(); outgoing.setTimeout(0); });
    return outgoing;
  };
  const forward = (req: IncomingMessage, target: RelayClusterMember, upgrade = false) => send(target, req.url ?? '/', req.method ?? 'GET',
    { ...req.headers, [HOP_HEADER]: options.secret, [CLIENT_HEADER]: clientAddress(req) }, upgrade);
  return {
    trusted, clientAddress,
    http(req: IncomingMessage, res: ServerResponse, target: RelayClusterMember): void {
      const unavailable = () => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { code: 'REPLICA_UNAVAILABLE', message: 'Replica unavailable' } }));
      };
      let outgoing: ClientRequest;
      try { outgoing = forward(req, target); } catch { req.resume(); unavailable(); return; }
      outgoing.on('response', (response) => {
        response.on('error', () => res.destroy());
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      outgoing.on('error', unavailable);
      req.on('aborted', () => outgoing.destroy()); req.on('error', () => outgoing.destroy());
      res.on('close', () => { if (!res.writableFinished) outgoing.destroy(); });
      req.pipe(outgoing);
    },
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: RelayClusterMember): void {
      let outgoing: ClientRequest;
      try { outgoing = forward(req, target, true); } catch { socket.destroy(); return; }
      sockets.add(socket);
      socket.once('close', () => { sockets.delete(socket); outgoing.destroy(); });
      socket.on('error', () => outgoing.destroy());
      outgoing.on('error', () => socket.destroy());
      outgoing.on('response', (response) => {
        const status = response.statusCode ?? 502;
        socket.end('HTTP/1.1 ' + status + ' ' + (STATUS_CODES[status] ?? 'Upgrade Rejected') + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        response.resume();
      });
      outgoing.on('upgrade', (response, backend, buffered) => {
        sockets.add(backend); backend.once('close', () => sockets.delete(backend));
        if (socket.destroyed) { backend.destroy(); return; }
        // Datagrams are small and latency-bound; keepalive notices an owner host that vanished without closing.
        (backend as Socket).setNoDelay?.(true);
        (backend as Socket).setKeepAlive?.(true, 15_000);
        backend.on('error', () => socket.destroy());
        backend.once('close', () => socket.destroy());
        socket.once('close', () => backend.destroy());
        let handshake = 'HTTP/1.1 101 Switching Protocols\r\n';
        for (let i = 0; i < response.rawHeaders.length; i += 2) handshake += response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1] + '\r\n';
        socket.write(handshake + '\r\n');
        if (buffered.length) socket.write(buffered);
        if (head.length) backend.write(head);
        socket.pipe(backend); backend.pipe(socket);
      });
      outgoing.end();
    },
    /** Live presence of a device on its owning replica (provider-share host status). */
    hostStatus(target: RelayClusterMember, networkId: string, deviceId: string): Promise<{ online: boolean; capabilities: string[] }> {
      return new Promise((resolve, reject) => {
        const query = new URLSearchParams({ network: networkId, device: deviceId });
        let outgoing: ClientRequest;
        try { outgoing = send(target, CLUSTER_PATH + '/host-status?' + query.toString(), 'GET', { [HOP_HEADER]: options.secret }); } catch (error) { reject(error); return; }
        outgoing.setTimeout(3_000, () => outgoing.destroy(new Error('CLUSTER_TIMEOUT')));
        outgoing.on('error', reject);
        outgoing.on('response', (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16_384) { outgoing.destroy(new Error('CLUSTER_RESPONSE_INVALID')); return; } chunks.push(chunk); });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { online?: unknown; capabilities?: unknown };
              if (response.statusCode !== 200 || typeof value.online !== 'boolean' || !Array.isArray(value.capabilities)
                || !value.capabilities.every(item => typeof item === 'string')) throw new Error('CLUSTER_RESPONSE_INVALID');
              resolve({ online: value.online, capabilities: value.capabilities as string[] });
            } catch (error) { reject(error); }
          });
        });
        outgoing.end();
      });
    },
    close(): void {
      for (const pending of requests) pending.destroy();
      for (const socket of sockets) socket.destroy();
    },
  };
}
