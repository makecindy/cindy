import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpRequest, STATUS_CODES, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
   * return the latest entries of the keys that moved. */
  commit(input: { origin: string; expected: Record<string, number>; writes: { key: string; value?: unknown }[] }): Promise<RelayStateCommit>;
  /** Every commit, in commit order, delivered to every replica including its author. */
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
  /** Live replicas. A replica that stops without leaving must drop out after a short liveness timeout. */
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

export function checkClusterOptions(options: RelayClusterOptions): RelayClusterOptions {
  if (typeof options.replicaId !== 'string' || !ID_PATTERN.test(options.replicaId)) throw new Error('INVALID_CLUSTER_REPLICA_ID');
  if (typeof options.secret !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(options.secret)) throw new Error('INVALID_CLUSTER_SECRET');
  if (options.url !== undefined) checkMemberUrl(options.url);
  if (options.drainMs !== undefined && (!Number.isSafeInteger(options.drainMs) || options.drainMs < 0 || options.drainMs > 120_000)) throw new Error('INVALID_CLUSTER_DRAIN');
  return options;
}
function checkMemberUrl(value: string): URL {
  const url = new URL(value);
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
export function routingNetwork(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
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

/** Passes requests and WebSocket upgrades to the owning replica byte for byte. */
export function createClusterRouter(options: { secret: string }) {
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
    return trusted(req) && typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : req.socket.remoteAddress ?? 'unknown';
  };
  const send = (target: RelayClusterMember, path: string, method: string, headers: Record<string, string | string[] | undefined>): ClientRequest => {
    const url = checkMemberUrl(target.url);
    const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)({ hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined, path, method, headers });
    requests.add(outgoing); outgoing.once('close', () => requests.delete(outgoing));
    // Cover connection establishment as well as an owner that accepts but never answers. Once
    // upgraded, this is a long-lived device connection and must have no forwarding deadline.
    const deadline = setTimeout(() => outgoing.destroy(new Error('CLUSTER_TIMEOUT')), FORWARD_TIMEOUT_MS);
    deadline.unref();
    const answered = () => clearTimeout(deadline);
    outgoing.once('response', answered);
    outgoing.once('close', answered);
    outgoing.setTimeout(FORWARD_TIMEOUT_MS, () => outgoing.destroy(new Error('CLUSTER_TIMEOUT')));
    outgoing.once('upgrade', () => { answered(); outgoing.setTimeout(0); });
    return outgoing;
  };
  const forward = (req: IncomingMessage, target: RelayClusterMember) => send(target, req.url ?? '/', req.method ?? 'GET',
    { ...req.headers, [HOP_HEADER]: options.secret, [CLIENT_HEADER]: clientAddress(req) });
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
      try { outgoing = forward(req, target); } catch { socket.destroy(); return; }
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
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
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
