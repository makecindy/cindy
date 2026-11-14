import { createServer as createHttpServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP, type AddressInfo } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  API, AGENT_NET_VERSION, MAX_FRAME_BYTES, MAX_MEDIA_OBJECT_BYTES, MAX_MEDIA_BINARY_CHUNK_BYTES, MAX_GRANT_LIFETIME_MS, MEDIA_NETWORK_QUOTA_BYTES, ID_PATTERN, KEY_PATTERN, notificationKeyPayload, decodeDatagrams, encodeDatagrams,
  type Delegation, type DeviceCertificate, type DeviceView, type JoinRequest, type PushRegistration, type DeviceMetadata,
  sharingOriginsPayload, sharingOriginsPolicyValid, type SharingOrigins, MAX_CONTROL_BYTES,
  guestRequestPath, delegationPrincipalMatches, delegationEndpointCertificate, isAgentNetStunHost,
} from '@cindy/agent-net-protocol';
import { sha256, verifySignature, verifyCertificate, verifyDelegation, verifyJoinRequest, verifyRequestProof, verifyRequestDigestProof, verifyTenantJoinRequest } from './identity.js';
import { Store, type NetworkRecord, type RelayStore } from './store.js';
import { ClusterStore, RelayStateUnavailableError, type RelayStoreChange } from './clusterStore.js';
import { CLUSTER_PATH, checkClusterOptions, clusterOwner, createClusterRouter, routingNetwork, type RelayClusterMember, type RelayClusterOptions } from './cluster.js';
import type { SharingState } from '@cindy/device-link-sharing/repositories';
import type { DelegationRequest } from '@cindy/agent-net-protocol';
import { AppError as SharingError } from '@cindy/device-link-sharing/errors';
import { createAgentNetSharing, type AgentNetSharingOptions } from './sharing.js';
import { DatagramSendQueue } from './datagramQueue.js';
import { MEDIA_TRANSFER_DIRECT, MEDIA_TRANSFER_HEADER, type DirectMediaRequest } from '@cindy/agent-net-protocol';
import { createLocalMediaStorage, DIRECT_GRANT_MAX_MS, guardMediaStorage, RelayMediaStorageError, RelayMediaStorageUnavailableError, type RelayMediaStorage } from './mediaStorage.js';
import { agentNetInvitationAsset } from '@cindy/device-link-sharing/pages';

export class AgentNetError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}
const fail = (status: number, code: string): never => { throw new AgentNetError(status, code); };
// React Native checks the public package's types with numeric timer handles.
function unrefTimer(timer: number | { unref(): void }): void {
  if (typeof timer !== 'number') timer.unref();
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(400, 'BAD_REQUEST');
const own = <T>(values: Record<string, T>, key: string): T | undefined => Object.hasOwn(values, key) ? values[key] : undefined;
const string = (value: unknown, limit = 128): string => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : fail(400, 'BAD_REQUEST');
const identifier = (value: unknown): string => { const result = string(value); return ID_PATTERN.test(result) ? result : fail(400, 'BAD_REQUEST'); };
const name = (value: unknown): string => string(value, 64).trim() || fail(400, 'BAD_REQUEST');

export interface Bootstrap { networkId: string; name: string; rootPublicKey: string; ownerCertificate: DeviceCertificate; }
export interface Enrollment { networkId: string; name: string; rootPublicKey: string; certificate: DeviceCertificate; deviceName: string; }
export interface RelayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
export interface RelayOptions {
  dataDir: string; host?: string; port?: number; udpHost?: string; udpPort?: number;
  /** Public host for `udpPort` when UDP is published apart from the HTTPS host; clients otherwise use the API host. */
  stunHost?: string;
  mode?: 'official' | 'self-hosted'; publicUrl?: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  bootstrap?: Bootstrap;
  /** Official enrollment is a separate endpoint and verifier; member routes never accept account tokens. */
  enroll?: (req: IncomingMessage, body: Record<string, unknown>) => Promise<Enrollment>;
  /** Host-supplied push delivery; embedded/self-hosted hosts can supply their own provider. */
  notify?: (input: { networkId: string; from: string; to: string; registration: PushRegistration; ciphertext: string }) => Promise<void | { invalidToken?: boolean; apnsEnv?: 'prod' | 'sandbox' }>;
  logger?: RelayLogger; now?: () => number;
  sharing?: AgentNetSharingOptions;
  /** See MAX_DATAGRAM_QUEUE_DELAY_MS; only tests shorten it. */
  datagramQueueDelayMs?: number;
  /** Run as one replica of a horizontally scaled official relay (cluster.ts). */
  cluster?: RelayClusterOptions;
  /** Attachment bytes; defaults to `<dataDir>/media`. Replicas of one cluster must share it. */
  mediaDir?: string;
  /** Attachment storage in place of mediaDir; one with `direct` lets clients move the ciphertext themselves. */
  mediaStorage?: RelayMediaStorage;
}
export interface RelayHandle {
  url: string; udpAddress: AddressInfo | null;
  close(): Promise<void>;
}
interface Principal { networkId: string; deviceId: string; certificate?: DeviceCertificate; delegation?: Delegation; }
interface Session { principal: Principal; ws: WebSocket; lastPong: number; remoteControlEnabled: boolean; capabilities: string[];
  metadata?: DeviceMetadata; metadataWritten?: boolean;
  /** Datagrams forwarded to this device; a queue that stops moving drops new ones (see datagramQueue.ts). */
  datagrams: DatagramSendQueue; }
const silent: RelayLogger = { info() {}, warn() {}, error() {} };

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) fail(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function jsonBody(bytes: Buffer): Record<string, unknown> {
  try { return record(JSON.parse(bytes.toString('utf8'))); } catch (error) {
    if (error instanceof AgentNetError) throw error;
    return fail(400, 'BAD_REQUEST');
  }
}
function blankNetwork(id: string, displayName: string, root: string, subject: string): NetworkRecord {
  return { id, name: displayName, rootPublicKey: root, subject, devices: {}, joinCodes: {}, joins: {}, grants: {}, pushTokens: {}, media: {} };
}
/** A network created from a verified owner bootstrap: the relay owner's at startup, or an approved tenant's. */
function ownerNetwork(bootstrap: Bootstrap, ownerName = 'Owner'): NetworkRecord {
  const c = bootstrap.ownerCertificate;
  const network = blankNetwork(c.networkId, name(bootstrap.name), bootstrap.rootPublicKey, c.subject);
  network.devices[c.deviceId] = { certificate: c, name: ownerName, customName: null, revokedAt: null };
  return network;
}
const TENANT_REQUEST_TTL_MS = 10 * 60_000;
/**
 * Host networks whose guest admission or pending requests may differ after another replica changed
 * shared sharing state: networks bound to a changed task or share, and networks of changed requests.
 */
function sharingNetworks(change: RelayStoreChange, sharing: SharingState, requests: DelegationRequest[]): Set<string> {
  const affected = new Set<string>();
  if (change.global.has('delegationRequests')) {
    const before = new Map(((change.before.get('delegationRequests') as DelegationRequest[] | undefined) ?? []).map(r => [r.id + '\0' + r.networkId, r]));
    for (const r of requests) {
      const previous = before.get(r.id + '\0' + r.networkId);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(r)) affected.add(r.networkId);
      before.delete(r.id + '\0' + r.networkId);
    }
    for (const r of before.values()) affected.add(r.networkId);
  }
  if (change.global.has('sharing')) {
    const before = change.before.get('sharing') as SharingState | undefined;
    const rows = (state: SharingState | undefined) => new Map<string, string>([
      ...(state?.tasks ?? []).map(t => ['task\0' + t.sharedTaskId, JSON.stringify(t)] as const),
      ...(state?.shares ?? []).map(s => ['share\0' + s.shareId, JSON.stringify(s)] as const)]);
    const old = rows(before), next = rows(sharing);
    const changed = new Set([...old.keys(), ...next.keys()].filter(id => old.get(id) !== next.get(id)).map(id => id.slice(id.indexOf('\0') + 1)));
    const oldBindings = new Set((before?.bindings ?? []).map(b => JSON.stringify(b)));
    const nextBindings = new Set(sharing.bindings.map(b => JSON.stringify(b)));
    for (const b of [...(before?.bindings ?? []), ...sharing.bindings]) {
      const encoded = JSON.stringify(b);
      if (changed.has(b.resourceId) || !oldBindings.has(encoded) || !nextBindings.has(encoded)) affected.add(b.networkId);
    }
  }
  return affected;
}
/** No official URL or fetch is used here. The same engine is embeddable and independently deployable. */
export async function startAgentNetRelay(options: RelayOptions): Promise<RelayHandle> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? silent;
  const mode = options.mode ?? 'self-hosted';
  if (mode === 'official' && !options.enroll) throw new Error('OFFICIAL_ENROLLMENT_REQUIRED');
  if (mode === 'official' && options.bootstrap) throw new Error('OFFICIAL_CANNOT_BOOTSTRAP_OWNER_NETWORK');
  if (mode === 'self-hosted' && options.enroll) throw new Error('SELF_HOSTED_CANNOT_USE_OFFICIAL_ENROLLMENT');
  if (options.stunHost !== undefined && !isAgentNetStunHost(options.stunHost)) throw new Error('INVALID_STUN_HOST');
  // Self-hosted relays stay one process: tenants and the owner bootstrap assume a single writer.
  if (options.cluster && mode !== 'official') throw new Error('CLUSTER_REQUIRES_OFFICIAL_MODE');
  const cluster = options.cluster ? checkClusterOptions(options.cluster) : undefined;
  // Replicas share the attachment storage; a per-replica default directory would lose files on handover.
  if (cluster && options.mediaDir === undefined && options.mediaStorage === undefined) throw new Error('CLUSTER_MEDIA_DIR_REQUIRED');
  const store: RelayStore = cluster ? await ClusterStore.open(cluster.backend, cluster.replicaId) : await Store.open(options.dataDir);
  if (options.bootstrap) {
    const bootstrap = options.bootstrap;
    const c = bootstrap.ownerCertificate;
    if (!verifyCertificate(bootstrap.rootPublicKey, c, c.issuedAt) || c.role !== 'owner' || c.networkId !== bootstrap.networkId || c.issuedAt > now() + 30_000) throw new Error('INVALID_BOOTSTRAP');
    await store.transaction((state) => {
      // The bootstrap names the relay owner's network; only its owners administer tenants.
      if (mode === 'self-hosted') state.primaryNetworkId = bootstrap.networkId;
      const existing = own(state.networks, bootstrap.networkId);
      if (existing) {
        if (existing.rootPublicKey !== bootstrap.rootPublicKey || existing.subject !== c.subject || existing.tenant) throw new Error('BOOTSTRAP_IDENTITY_MISMATCH');
        return;
      }
      state.networks[c.networkId] = ownerNetwork(bootstrap);
    });
  }
  if (mode === 'self-hosted' && store.primaryNetworkId() === undefined) {
    // State written before tenants existed holds exactly the owner's network.
    const owners = store.networks().filter(n => !n.tenant);
    if (owners.length === 1) await store.transaction((state) => { state.primaryNetworkId = owners[0].id; });
  }
  if (mode === 'self-hosted' && store.networks().length === 0) throw new Error('SELF_HOSTED_BOOTSTRAP_REQUIRED');
  const sessions = new Map<string, Session>();
  let advertisedUdpPort: number | null = null;
  let closing = false;
  let binaryBodies = 0;
  const pendingRequests = new Set<Promise<void>>();
  const pendingUpgrades = new Set<Duplex>();
  const nonces = new Map<string, number>();
  const rate = new Map<string, { at: number; count: number }>();
  const mediaQueues = new Map<string, Promise<unknown>>();
  async function mediaOperation<T>(networkId: string, id: string, action: () => Promise<T>): Promise<T> {
    const operation = (mediaQueues.get(id) ?? Promise.resolve()).catch(() => undefined)
      .then(() => store instanceof ClusterStore ? store.mediaOperation(networkId, id, action) : action());
    mediaQueues.set(id, operation);
    try { return await operation; } finally { if (mediaQueues.get(id) === operation) mediaQueues.delete(id); }
  }
  const storage = guardMediaStorage(options.mediaStorage ?? await createLocalMediaStorage(options.mediaDir ?? path.join(options.dataDir, 'media')));
  const key = (network: string, device: string) => network + '\0' + device;
  const network = (id: string) => store.network(id) ?? fail(401, 'NETWORK_UNKNOWN');
  const synchronized = new WeakMap<IncomingMessage, Set<string>>();
  async function synchronize(req: IncomingMessage, networkIds: readonly string[]): Promise<void> {
    if (!(store instanceof ClusterStore)) return;
    const done = synchronized.get(req) ?? new Set<string>();
    const keys = [...new Set([...networkIds.map(id => 'network:' + id), ...(options.sharing ? ['sharing', 'delegationRequests'] : [])])]
      .filter(key => !done.has(key));
    try { await store.synchronize(keys); } catch { return fail(503, 'CLUSTER_STATE_UNAVAILABLE'); }
    for (const key of keys) done.add(key);
    synchronized.set(req, done);
  }
  const memberRecord = (n: NetworkRecord, id: string) => own(n.devices, id) ?? fail(401, 'DEVICE_UNKNOWN');
  // Cluster: one owner replica per network. A draining replica no longer owns anything.
  const router = cluster ? createClusterRouter(cluster) : undefined;
  let members: readonly RelayClusterMember[] = cluster ? cluster.backend.members() : [];
  let draining = false;
  // Set once this replica is in the member list; from then on a list without an owner means "own nothing".
  let joined = false;
  const owners = new Map<string, RelayClusterMember | undefined>();
  function ownerOf(networkId: string): RelayClusterMember | undefined {
    if (!cluster) return undefined;
    if (!owners.has(networkId)) {
      if (owners.size >= 100_000) owners.clear();
      owners.set(networkId, clusterOwner(networkId, draining ? members.filter(m => m.id !== cluster.replicaId) : members));
    }
    return owners.get(networkId);
  }
  /**
   * Before joining (startup) a replica serves what reaches it. Once joined, a member list with no owner for
   * the network (this replica fenced itself after losing its lease, or every member dropped out) means it
   * owns nothing: falling back to single-process behaviour would let it keep sessions a new owner also serves.
   */
  const owns = (networkId: string) => {
    if (!cluster) return true;
    const owner = ownerOf(networkId);
    return owner ? owner.id === cluster.replicaId : !joined;
  };
  /** A request for a network that currently has no owner anywhere (see owns); hops are judged by their target. */
  const ownerless = (req: IncomingMessage) => {
    if (!cluster || !joined || router?.trusted(req)) return false;
    const networkId = routingNetwork(req);
    return networkId !== undefined && ownerOf(networkId) === undefined;
  };
  const clientAddress = (req: IncomingMessage) => router?.clientAddress(req) ?? req.socket.remoteAddress ?? 'unknown';
  function allow(source: string, maximum = 60): boolean {
    const at = now();
    const previous = rate.get(source);
    if (previous && at - previous.at < 60_000) return ++previous.count <= maximum;
    if (rate.size >= 5_000) return false;
    rate.set(source, { at, count: 1 });
    return true;
  }
  async function remember(networkId: string, device: string, nonce: string): Promise<void> {
    const id = key(networkId, device) + '\0' + nonce;
    if (nonces.has(id)) fail(401, 'REQUEST_REPLAYED');
    if (nonces.size >= 50_000) fail(429, 'TOO_MANY_REQUESTS');
    // Keep for the full acceptance window, including timestamps up to 90 seconds ahead.
    const until = now() + 180_000;
    // A network can move to another replica within the window; the claim is cluster-wide.
    if (cluster) {
      let accepted: boolean;
      try { accepted = await cluster.backend.claimNonce(id, until); } catch { return fail(503, 'CLUSTER_STATE_UNAVAILABLE'); }
      if (!accepted) fail(401, 'REQUEST_REPLAYED');
    }
    nonces.set(id, until);
  }
  async function authenticate(req: IncomingMessage, bytes: Buffer, guest = false, digest?: string, suppliedHeader?: string): Promise<Principal> {
    const expected = guest ? 'AgentNetGuest ' : 'AgentNet ';
    const header = suppliedHeader ?? req.headers.authorization;
    if (!header?.startsWith(expected) || header.length > 12_000) return fail(401, 'AUTH_REQUIRED');
    let envelope: Record<string, unknown>;
    try { envelope = record(JSON.parse(Buffer.from(header.slice(expected.length), 'base64url').toString('utf8'))); } catch { return fail(401, 'AUTH_INVALID'); }
    const method = req.method ?? 'GET';
    const requestPath = req.url ?? '/';
    const validProof = (signingKey: string, proof: unknown, path = requestPath): proof is import('@cindy/agent-net-protocol').RequestProof => digest === undefined
      ? verifyRequestProof(signingKey, proof, method, path, bytes, now()) : verifyRequestDigestProof(signingKey, proof, method, path, digest, now());
    if (guest) {
      const compact = envelope.delegation === undefined;
      const networkId = identifier(compact ? envelope.networkId : (envelope.delegation as Delegation)?.networkId);
      await synchronize(req, [networkId]);
      const n = network(networkId);
      const delegation = (compact ? own(n.grants, identifier(envelope.delegationId))?.delegation : envelope.delegation) as Delegation;
      if (!delegation) return fail(401, 'GRANT_INVALID');
      const grant = own(n.grants, delegation.id);
      if (!verifyDelegation(n.rootPublicKey, delegation, now()) || !grant || grant.revokedAt !== null
        || !delegationPrincipalMatches(grant.delegation, delegation) || !usableDelegation(n, grant.delegation)
        || (sharing && !sharing.authorized(delegation))) return fail(401, 'GRANT_INVALID');
      const host = memberRecord(n, delegation.hostDeviceId);
      if (host.revokedAt !== null || host.certificate.signingKey !== delegation.issuerCertificate.signingKey) return fail(401, 'GRANT_INVALID');
      if (!validProof(delegation.guestSigningKey, envelope.proof, compact ? guestRequestPath(requestPath, n.id, delegation.id) : requestPath)) return fail(401, 'PROOF_INVALID');
      await remember(n.id, 'guest:' + delegation.id, envelope.proof.nonce);
      return { networkId: n.id, deviceId: 'guest:' + delegation.id, delegation };
    }
    const c = envelope.certificate as DeviceCertificate;
    const networkId = identifier(c?.networkId);
    await synchronize(req, [networkId]);
    const n = network(networkId);
    if (!verifyCertificate(n.rootPublicKey, c, now()) || c.subject !== n.subject) return fail(401, 'CERTIFICATE_INVALID');
    const existing = memberRecord(n, c.deviceId);
    if (existing.revokedAt !== null || c.issuedAt < (existing.notBefore ?? 0) || existing.certificate.signingKey !== c.signingKey
      || existing.certificate.transportKey !== c.transportKey || existing.certificate.role !== c.role) return fail(401, 'DEVICE_REVOKED');
    if (!validProof(c.signingKey, envelope.proof)) return fail(401, 'PROOF_INVALID');
    await remember(n.id, c.deviceId, envelope.proof.nonce);
    if (c.issuedAt > existing.certificate.issuedAt) await store.transaction((state) => {
      const currentNetwork = own(state.networks, n.id);
      const current = currentNetwork && own(currentNetwork.devices, c.deviceId);
      if (!current || current.revokedAt !== null || current.certificate.signingKey !== c.signingKey) return fail(401, 'DEVICE_REVOKED');
      current.certificate = c;
    });
    return { networkId: n.id, deviceId: c.deviceId, certificate: c };
  }
  function usableDelegation(n: NetworkRecord, d: Delegation): boolean {
    const issuer = own(n.devices, d.hostDeviceId);
    return d.expiresAt > now() && !!issuer && issuer.revokedAt === null && d.issuerCertificate.issuedAt >= (issuer.notBefore ?? 0)
      && issuer.certificate.signingKey === d.issuerCertificate.signingKey && (!sharing || sharing.authorized(d));
  }
  function endpointUsable(n: NetworkRecord, d: Delegation, deviceId: string): boolean {
    const c = delegationEndpointCertificate(d, deviceId, now()), member = own(n.devices, deviceId);
    return !!c && !!member && member.revokedAt === null && c.issuedAt >= (member.notBefore ?? 0)
      && c.signingKey === member.certificate.signingKey && c.transportKey === member.certificate.transportKey;
  }
  function active(principal: Principal): boolean {
    try {
      const n = network(principal.networkId);
      if (principal.delegation) {
        const d = principal.delegation;
        const host = memberRecord(n, d.hostDeviceId);
        const saved = own(n.grants, d.id);
        return d.expiresAt > now() && host.revokedAt === null && host.certificate.signingKey === d.issuerCertificate.signingKey
          && !!saved && saved.revokedAt === null && usableDelegation(n, saved.delegation) && delegationPrincipalMatches(saved.delegation, d)
          && (!sharing || sharing.authorized(d));
      }
      const c = principal.certificate!;
      const current = memberRecord(n, principal.deviceId);
      return c.expiresAt > now() && c.issuedAt >= (current.notBefore ?? 0) && current.revokedAt === null && current.certificate.signingKey === c.signingKey && current.certificate.transportKey === c.transportKey;
    } catch { return false; }
  }
  const requireOwner = (p: Principal) => p.certificate?.role === 'owner' ? undefined : fail(403, 'OWNER_REQUIRED');
  // A tenant's own owner manages only its network; relay-wide tenant administration is the relay owner's.
  const requireRelayOwner = (p: Principal) => !p.delegation && p.certificate?.role === 'owner' && store.primaryNetworkId() !== undefined
    && p.networkId === store.primaryNetworkId() ? undefined : fail(403, 'FORBIDDEN');
  const expiredCredential = (p: Principal) => (p.certificate?.expiresAt ?? p.delegation?.expiresAt ?? Infinity) <= now();
  function roster(p: Principal): DeviceView[] {
    const n = network(p.networkId);
    const delegated = p.delegation && own(n.grants, p.delegation.id)?.delegation;
    const entries = delegated ? [delegated.hostDeviceId, ...(delegated.executors ?? []).filter(e => e.expiresAt > now()).map(e => e.certificate.deviceId)]
      .flatMap(id => { const value = own(n.devices, id), expected = delegationEndpointCertificate(delegated, id, now());
        return value && expected && endpointUsable(n, delegated, id) && value.certificate.signingKey === expected.signingKey
          && value.certificate.transportKey === expected.transportKey ? [value] : []; }) : Object.values(n.devices).filter((d) => d.revokedAt === null);
    return entries.map((d) => {
      const session = sessions.get(key(n.id, d.certificate.deviceId));
      const reported = session?.metadata?.deviceName ?? d.reportedName ?? d.name;
      return { certificate: d.certificate, name: d.customName === undefined ? d.name : d.customName ?? reported, selfName: reported,
        online: !!session && active(session.principal),
        ...d.metadata, ...session?.metadata, lastSeenAt: session ? now() : d.lastSeenAt,
        busy: !!session && !!session.metadata?.busy,
        notificationKey: n.pushTokens[d.certificate.deviceId]?.notificationKey,
        remoteControlEnabled: session?.remoteControlEnabled ?? false, capabilities: session?.capabilities ?? [] };
    });
  }
  function announce(networkId: string): void {
    for (const session of sessions.values()) if (session.principal.networkId === networkId && active(session.principal) && session.ws.readyState === WebSocket.OPEN) {
      if (session.ws.bufferedAmount > 1024 * 1024) { session.ws.close(1013, 'slow peer'); continue; }
      session.ws.send(JSON.stringify({ type: 'directory', devices: roster(session.principal), delegations: delegatedPeers(session.principal),
        delegationRequests: session.principal.delegation ? [] : sharing?.requestsFor(networkId, session.principal.deviceId) ?? [] }));
    }
  }
  function disconnect(networkId: string, deviceId: string, code = 4410): void {
    for (const [id, session] of sessions) {
      if (session.principal.networkId === networkId && (session.principal.deviceId === deviceId || session.principal.delegation?.hostDeviceId === deviceId)) {
        sessions.delete(id); session.ws.close(code, 'access revoked');
      }
    }
    announce(networkId);
  }
  function localHostStatus(deviceId: string, networkId: string): { online: boolean; capabilities: string[] } {
    const session = sessions.get(key(networkId, deviceId));
    return { online: !!session && active(session.principal), capabilities: session?.capabilities ?? [] };
  }
  /** Another replica changed this network: close the sessions it no longer admits, then republish. */
  function refresh(networkId: string): void {
    let present = false;
    for (const [id, session] of sessions) if (session.principal.networkId === networkId) {
      if (active(session.principal)) { present = true; continue; }
      sessions.delete(id); session.ws.close(expiredCredential(session.principal) ? 4408 : 4410, 'access unavailable');
    }
    if (present) announce(networkId);
  }
  function permitted(sender: Principal, targetId: string): boolean {
    const n = network(sender.networkId);
    const member = own(n.devices, targetId);
    if (member) {
      const d = sender.delegation && own(n.grants, sender.delegation.id)?.delegation;
      const endpoint = d && delegationEndpointCertificate(d, targetId, now());
      return member.revokedAt === null && (!sender.delegation || !!endpoint && endpointUsable(n, d!, targetId) && endpoint.signingKey === member.certificate.signingKey
        && endpoint.transportKey === member.certificate.transportKey);
    }
    if (sender.delegation || !targetId.startsWith('guest:')) return false;
    const grant = own(n.grants, targetId.slice(6));
    return !!grant && grant.revokedAt === null && usableDelegation(n, grant.delegation)
      && endpointUsable(n, grant.delegation, sender.deviceId);
  }
  function delegatedPeers(p: Principal): Delegation[] {
    const n = network(p.networkId);
    if (p.delegation) { const saved = own(n.grants, p.delegation.id);
      return saved && saved.revokedAt === null && saved.delegation.scope && usableDelegation(n, saved.delegation) ? [saved.delegation] : []; }
    return Object.values(n.grants).filter(g => g.revokedAt === null && usableDelegation(n, g.delegation)
      && endpointUsable(n, g.delegation, p.deviceId)).map(g => g.delegation);
  }
  const sharing = options.sharing ? createAgentNetSharing(options.sharing, {
    storage: store.sharingStorage(), now,
    requests: () => store.delegationRequests(),
    async saveRequest(request) {
      await store.transaction(state => {
        const requests = (state.delegationRequests ?? []).filter(r => r.expiresAt > now()
          && !(r.networkId === request.networkId && r.kind === request.kind && r.resourceId === request.resourceId && r.guestDeviceId === request.guestDeviceId));
        if (requests.filter(r => r.networkId === request.networkId).length >= 4096) return fail(429, 'DELEGATION_REQUEST_LIMIT');
        if (requests.some(r => r.networkId === request.networkId && r.hostDeviceId === request.hostDeviceId
          && r.guestTransportKey === request.guestTransportKey)) return fail(409, 'RESOURCE_TRANSPORT_KEY_REUSED');
        if (Object.values(state.networks[request.networkId].devices).some(d => d.revokedAt === null
          && d.certificate.transportKey === request.guestTransportKey)) return fail(409, 'MEMBER_TRANSPORT_KEY_REUSED');
        requests.push(request); state.delegationRequests = requests;
      });
    },
    grant(request) {
      const n = network(request.networkId), certificate = memberRecord(n, request.hostDeviceId).certificate;
      const grant = own(n.grants, request.id), d = grant?.delegation;
      return { rootPublicKey: n.rootPublicKey, certificate, revoked: grant?.revokedAt != null,
        ...(d && grant?.revokedAt === null && d.expiresAt > now() && d.guestSigningKey === request.guestSigningKey
          && d.guestTransportKey === request.guestTransportKey && d.scope?.memberId === request.scope.memberId
          && d.scope?.memberVersion === request.scope.memberVersion && d.scope?.guestSubject === request.scope.guestSubject ? { delegation: d } : {}) };
    },
    async remember(account, device, nonce) {
      try { await remember('sharing:' + account, device, nonce); } catch (error) {
        // The scoped identity verifier preserves SharingError statuses; backend outages must
        // not be converted by it into an invalid-account 401.
        if (error instanceof AgentNetError) throw new SharingError(error.code, error.status, error.message);
        throw error;
      }
    },
    rootPublicKey: networkId => network(networkId).rootPublicKey,
    synchronize: (req, networkId) => synchronize(req, [networkId]),
    grants: networkId => { const n = network(networkId); return Object.values(n.grants).filter(g => g.revokedAt === null && usableDelegation(n, g.delegation)).map(g => g.delegation); },
    memberCertificate: (networkId, deviceId) => { const member = own(network(networkId).devices, deviceId);
      return member?.revokedAt === null && verifyCertificate(network(networkId).rootPublicKey, member.certificate, now()) ? member.certificate : undefined; },
    async member(req, bytes) {
      const header = req.headers['x-agent-net-authorization'];
      if (typeof header !== 'string' || !header.startsWith('AgentNet ')) return fail(401, 'MEMBER_PROOF_REQUIRED');
      const p = await authenticate(req, bytes, false, undefined, header);
      return { networkId: p.networkId, deviceId: p.deviceId, subject: p.certificate!.subject, tenant: !!store.network(p.networkId)?.tenant };
    },
    async hostStatus(deviceId, networkId) {
      const owner = ownerOf(networkId);
      if (!router || !owner || owner.id === cluster?.replicaId) return localHostStatus(deviceId, networkId);
      // The host's live session is on its network's owner.
      return router.hostStatus(owner, networkId, deviceId).catch(() => ({ online: false, capabilities: [] }));
    },
    changed(networkIds) {
      for (const [id, session] of sessions) if (!active(session.principal)) {
        sessions.delete(id); session.ws.close(4410, 'access unavailable');
      }
      for (const networkId of networkIds) announce(networkId);
    },
  }) : undefined;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const invitationPage = /^\/api\/agent-net\/(shared-task|provider-share)\/(join(?:\.(?:js|css))?|mark\.png)$/.exec(url.pathname);
    if (invitationPage && method === 'GET') {
      if (url.search) return fail(400, 'BAD_REQUEST');
      const asset = agentNetInvitationAsset(invitationPage[1] as 'shared-task' | 'provider-share', invitationPage[2]);
      if (!asset) return fail(404, 'NOT_FOUND');
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      res.end(asset.body); return;
    }
    if (url.pathname === '/health' && method === 'GET') return writeJson(res, 200, { status: 'ok', protocolVersion: AGENT_NET_VERSION, udp: options.udpPort === undefined ? 'disabled' : 'ok' });
    // Readiness for load balancers: a leaving replica stops receiving new connections; liveness stays /health.
    if (url.pathname === '/ready' && method === 'GET') return draining ? writeJson(res, 503, { status: 'draining' }) : writeJson(res, 200, { status: 'ready' });
    if (url.pathname.startsWith(CLUSTER_PATH + '/')) {
      // Between replicas only; the hop secret never reaches clients.
      if (!router?.trusted(req)) return fail(404, 'NOT_FOUND');
      if (url.pathname === CLUSTER_PATH + '/host-status' && method === 'GET') {
        return writeJson(res, 200, localHostStatus(identifier(url.searchParams.get('device')), identifier(url.searchParams.get('network'))));
      }
      return fail(404, 'NOT_FOUND');
    }
    if (url.pathname === API + '/info' && method === 'GET') return writeJson(res, 200, {
      protocolVersion: AGENT_NET_VERSION, mode, udpPort: advertisedUdpPort,
      ...(options.stunHost !== undefined && advertisedUdpPort !== null ? { stunHost: options.stunHost } : {}), features: ['encrypted-datagrams-v2', 'owner-pairing-v2', 'directory-v2', 'delegation-v2', 'scoped-device-link-v2', 'media-v2', ...(storage.direct ? ['media-direct-v1'] : []), 'notification-keys-v2', ...(options.sharing ? ['sharing-authority-v2'] : []), ...(options.notify ? ['notify-v2'] : []),
        ...(mode === 'self-hosted' && store.primaryNetworkId() !== undefined ? ['tenants-v1'] : [])],
    });
    if (url.pathname.startsWith(API + '/sharing/')) {
      if (!sharing) return fail(404, 'SHARING_UNAVAILABLE');
      if (!allow('sharing:' + clientAddress(req), 180)) return fail(429, 'TOO_MANY_REQUESTS');
      await synchronize(req, [routingNetwork(req), routingNetwork(req, req.headers['x-agent-net-authorization'])]
        .filter((id): id is string => id !== undefined));
      return writeJson(res, 200, await sharing.handle(req, await readBody(req, 16_384)));
    }
    if (url.pathname === API + '/enroll' && method === 'POST') {
      if (!options.enroll || mode !== 'official') return fail(404, 'NOT_FOUND');
      const bytes = await readBody(req, 16_384);
      const enrollment = await options.enroll(req, jsonBody(bytes));
      const c = enrollment.certificate;
      if (!verifyCertificate(enrollment.rootPublicKey, c, now()) || c.networkId !== enrollment.networkId) return fail(500, 'ENROLLMENT_INVALID');
      await synchronize(req, [c.networkId]);
      await store.transaction((state) => {
        const n = own(state.networks, c.networkId) ?? blankNetwork(c.networkId, enrollment.name, enrollment.rootPublicKey, c.subject);
        if (n.rootPublicKey !== enrollment.rootPublicKey || n.subject !== c.subject) return fail(403, 'NETWORK_MISMATCH');
        const existing = own(n.devices, c.deviceId);
        if (existing && (existing.revokedAt !== null || existing.certificate.signingKey !== c.signingKey || existing.certificate.transportKey !== c.transportKey)) return fail(403, 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL');
        if (!existing && Object.keys(n.devices).length >= 256) return fail(409, 'DEVICE_LIMIT');
        n.devices[c.deviceId] = { ...existing, certificate: c, name: existing?.name ?? name(enrollment.deviceName),
          reportedName: name(enrollment.deviceName), ...(!existing ? { customName: null } : {}), revokedAt: null };
        state.networks[n.id] = n;
      });
      announce(c.networkId);
      return writeJson(res, 200, { rootPublicKey: enrollment.rootPublicKey, certificate: c });
    }
    if (url.pathname === API + '/join' && method === 'POST') {
      if (!allow(clientAddress(req))) return fail(429, 'TOO_MANY_REQUESTS');
      const request = jsonBody(await readBody(req, 16_384)) as unknown as JoinRequest;
      if (!verifyJoinRequest(request)) return fail(400, 'JOIN_PROOF_INVALID');
      await synchronize(req, [request.networkId]);
      const pollToken = randomBytes(32).toString('base64url');
      await store.transaction((state) => {
        const n = own(state.networks, request.networkId) ?? fail(404, 'NOT_FOUND');
        const code = own(n.joinCodes, request.joinCode);
        if (!code || code.used || code.expiresAt <= now()) return fail(403, 'JOIN_CODE_INVALID');
        if (own(n.devices, request.deviceId)?.certificate.role === 'owner' || own(n.joins, request.requestId)) return fail(409, 'DEVICE_EXISTS');
        if (Object.values(n.joins).filter((j) => j.expiresAt > now()).length >= 128) return fail(429, 'JOIN_LIMIT');
        code.used = true;
        n.joins[request.requestId] = { request, pollHash: sha256(pollToken), expiresAt: now() + 300_000, status: 'pending' };
      });
      return writeJson(res, 202, { requestId: request.requestId, pollToken });
    }
    if (url.pathname === API + '/join/status' && method === 'POST') {
      const body = jsonBody(await readBody(req, 4_096));
      const networkId = identifier(body.networkId);
      await synchronize(req, [networkId]);
      const n = network(networkId);
      const join = own(n.joins, identifier(body.requestId));
      if (!join || join.expiresAt <= now() || join.pollHash !== sha256(string(body.pollToken))) return fail(403, 'POLL_TOKEN_INVALID');
      return writeJson(res, 200, { status: join.status, ...(join.status === 'approved' ? { certificate: join.certificate, rootPublicKey: n.rootPublicKey } : {}) });
    }
    // Another account asks for its own network on this relay. The invite code came from the
    // relay owner's share link; the owner still approves after comparing the short code.
    if (url.pathname === API + '/tenant-join' && method === 'POST') {
      if (mode !== 'self-hosted' || store.primaryNetworkId() === undefined) return fail(404, 'NOT_FOUND');
      if (!allow('tenant:' + clientAddress(req), 20)) return fail(429, 'TOO_MANY_REQUESTS');
      const request = jsonBody(await readBody(req, 16_384));
      if (!verifyTenantJoinRequest(request, now())) return fail(400, 'TENANT_JOIN_INVALID');
      const pollToken = randomBytes(32).toString('base64url');
      await store.transaction((state) => {
        const invites = state.tenantInvites ??= {}, requests = state.tenantRequests ??= {};
        const invite = own(invites, sha256(request.inviteCode));
        if (!invite || invite.used || invite.expiresAt <= now()) return fail(403, 'TENANT_INVITE_INVALID');
        const networkId = request.bootstrap.networkId;
        if (own(state.networks, networkId) || own(requests, request.requestId)
          || Object.values(requests).some(r => r.request.bootstrap.networkId === networkId)) return fail(409, 'TENANT_EXISTS');
        if (Object.values(requests).filter(r => r.status === 'pending' && r.expiresAt > now()).length >= 32) return fail(429, 'TENANT_REQUEST_LIMIT');
        invite.used = true;
        requests[request.requestId] = { request, pollHash: sha256(pollToken), createdAt: now(), expiresAt: now() + TENANT_REQUEST_TTL_MS, status: 'pending' };
      });
      return writeJson(res, 202, { requestId: request.requestId, pollToken });
    }
    if (url.pathname === API + '/tenant-join/status' && method === 'POST') {
      const body = jsonBody(await readBody(req, 4_096));
      const requestId = string(body.requestId, 64), pollToken = string(body.pollToken);
      const entry = store.tenantRequests().find(r => r.request.requestId === requestId);
      if (!entry || entry.expiresAt <= now() || entry.pollHash !== sha256(pollToken)) return fail(403, 'POLL_TOKEN_INVALID');
      return writeJson(res, 200, { status: entry.status, ...(entry.status === 'approved' ? { networkId: entry.request.bootstrap.networkId } : {}) });
    }
    if (!url.pathname.startsWith(API + '/')) return fail(404, 'NOT_FOUND');
    // Binary media chunks and JSON controls are both signed over their exact bytes.
    const binaryUpload = method === 'PUT' && /^\/api\/agent-net\/(?:guest\/)?media\/[A-Za-z0-9-]+$/.test(url.pathname)
      && req.headers['content-type'] === 'application/octet-stream';
    if (binaryUpload && binaryBodies >= 8) { req.resume(); return fail(429, 'MEDIA_UPLOAD_BUSY'); }
    const digest = binaryUpload ? string(req.headers['x-agent-net-content-sha256'], 43) : undefined;
    const preauthenticated = binaryUpload ? await authenticate(req, Buffer.alloc(0), url.pathname.startsWith(API + '/guest/'), digest) : null;
    if (binaryUpload) {
      if (binaryBodies >= 8) { req.resume(); return fail(429, 'MEDIA_UPLOAD_BUSY'); }
      binaryBodies++; let released = false;
      const release = () => { if (!released) { released = true; binaryBodies--; } };
      res.once('finish', release); res.once('close', release);
      req.setTimeout(30_000, () => { req.destroy(); res.destroy(); });
    }
    const bytes = await readBody(req, binaryUpload ? MAX_MEDIA_BINARY_CHUNK_BYTES : 64 * 1024);
    if (binaryUpload && sha256(bytes) !== digest) return fail(401, 'MEDIA_DIGEST_MISMATCH');
    const principal = preauthenticated ?? await authenticate(req, bytes, url.pathname.startsWith(API + '/guest/'));
    if (!active(principal)) return fail(401, 'DEVICE_REVOKED');
    if (principal.delegation) {
      const resource = url.pathname.slice((API + '/guest').length);
      if (!/^\/(directory|notify|push-token|media(?:\/[A-Za-z0-9-]+(?:\/(?:upload|commit))?)?)$/.test(resource)) return fail(403, 'FORBIDDEN');
      url.pathname = API + resource;
    }
    const body: Record<string, unknown> = binaryUpload ? { offset: /^\d+$/.test(url.searchParams.get('offset') ?? '') ? Number(url.searchParams.get('offset')) : NaN } : bytes.length ? jsonBody(bytes) : {};
    const n = network(principal.networkId);
    if (url.pathname === API + '/sharing-origins') {
      if (principal.delegation || principal.certificate?.subject !== n.subject) return fail(403, 'FORBIDDEN');
      if (method === 'GET') return writeJson(res, 200, { origins: Object.values(n.sharingOrigins ?? {}).filter(doc =>
        sharingOriginsPolicyValid(doc, now()) && own(n.devices, doc.certificate.deviceId)?.revokedAt === null
        && own(n.devices, doc.certificate.deviceId)?.certificate.signingKey === doc.certificate.signingKey) });
      if (method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED');
      const doc = body as unknown as SharingOrigins;
      if (!sharingOriginsPolicyValid(doc, now()) || doc.networkId !== n.id || doc.certificate.deviceId !== principal.deviceId
        || doc.certificate.subject !== principal.certificate.subject || Math.abs(now() - doc.issuedAt) > 30_000
        || !verifyCertificate(n.rootPublicKey, doc.certificate, doc.issuedAt)
        || own(n.devices, principal.deviceId)?.certificate.signingKey !== doc.certificate.signingKey
        || !verifySignature(doc.certificate.signingKey, sharingOriginsPayload(doc), doc.signature)) return fail(400, 'INVALID_SHARING_ORIGINS');
      await store.transaction(state => {
        const current = state.networks[n.id], old = current.sharingOrigins?.[principal.deviceId];
        if (old && old.issuedAt > doc.issuedAt) return fail(409, 'STALE_SHARING_ORIGINS');
        current.sharingOrigins ??= {}; current.sharingOrigins[principal.deviceId] = doc;
      });
      return writeJson(res, 200, { ok: true });
    }
    if (method === 'GET' && url.pathname === API + '/directory') return writeJson(res, 200, { networkId: n.id, rootPublicKey: n.rootPublicKey, devices: roster(principal), delegations: delegatedPeers(principal),
      delegationRequests: principal.delegation ? [] : sharing?.requestsFor(n.id, principal.deviceId) ?? [] });
    if (url.pathname === API + '/join-codes' && method === 'POST') {
      requireOwner(principal);
      const code = randomBytes(24).toString('base64url');
      await store.transaction((state) => {
        const current = state.networks[n.id];
        for (const [id, old] of Object.entries(current.joinCodes)) if (old.expiresAt <= now() || old.used) delete current.joinCodes[id];
        if (Object.keys(current.joinCodes).length >= 32) return fail(429, 'JOIN_CODE_LIMIT');
        current.joinCodes[code] = { expiresAt: now() + 300_000, used: false };
      });
      return writeJson(res, 201, { networkId: n.id, joinCode: code, expiresAt: now() + 300_000 });
    }
    if (url.pathname === API + '/join-requests' && method === 'GET') {
      requireOwner(principal);
      return writeJson(res, 200, { requests: Object.values(n.joins).filter((j) => j.status === 'pending' && j.expiresAt > now()).map((j) => j.request) });
    }
    const decision = url.pathname.match(/^\/api\/agent-net\/join-requests\/([A-Za-z0-9-]+)\/(approve|reject)$/);
    if (decision && method === 'POST') {
      requireOwner(principal);
      await store.transaction((state) => {
        const current = state.networks[n.id];
        const join = own(current.joins, decision[1]) ?? fail(404, 'NOT_FOUND');
        if (join.status !== 'pending' || join.expiresAt <= now()) return fail(409, 'JOIN_EXPIRED');
        if (decision[2] === 'reject') { join.status = 'rejected'; return; }
        const c = body.certificate;
        if (!verifyCertificate(current.rootPublicKey, c, now()) || c.networkId !== n.id || c.subject !== n.subject || c.role !== 'member'
          || c.deviceId !== join.request.deviceId || c.signingKey !== join.request.signingKey || c.transportKey !== join.request.transportKey) return fail(400, 'CERTIFICATE_INVALID');
        const previous = own(current.devices, c.deviceId);
        if (previous?.certificate.role === 'owner' || (!previous && Object.keys(current.devices).length >= 256)) return fail(409, 'DEVICE_EXISTS');
        if (previous && c.issuedAt <= previous.certificate.issuedAt) return fail(400, 'CERTIFICATE_NOT_NEWER');
        current.devices[c.deviceId] = { certificate: c, name: join.request.name, customName: null,
          reportedName: join.request.name, revokedAt: null, notBefore: c.issuedAt };
        for (const grant of Object.values(current.grants)) if (grant.delegation.hostDeviceId === c.deviceId) grant.revokedAt = now();
        join.certificate = c; join.status = 'approved';
      });
      disconnect(n.id, body.certificate && typeof body.certificate === 'object' ? (body.certificate as DeviceCertificate).deviceId : '');
      return writeJson(res, 200, { status: decision[2] === 'approve' ? 'approved' : 'rejected' });
    }
    if (url.pathname === API + '/tenant-invites' && method === 'POST') {
      requireRelayOwner(principal);
      const code = randomBytes(24).toString('base64url'), expiresAt = now() + 300_000;
      await store.transaction((state) => {
        const invites = state.tenantInvites ??= {};
        for (const [id, old] of Object.entries(invites)) if (old.expiresAt <= now() || old.used) delete invites[id];
        if (Object.keys(invites).length >= 32) return fail(429, 'TENANT_INVITE_LIMIT');
        invites[sha256(code)] = { expiresAt, used: false };
      });
      return writeJson(res, 201, { inviteCode: code, expiresAt });
    }
    if (url.pathname === API + '/tenant-requests' && method === 'GET') {
      requireRelayOwner(principal);
      return writeJson(res, 200, { requests: store.tenantRequests().filter(r => r.status === 'pending' && r.expiresAt > now())
        .map(r => ({ request: r.request, requestedAt: r.createdAt })) });
    }
    const tenantDecision = url.pathname.match(/^\/api\/agent-net\/tenant-requests\/([0-9a-f-]{36})\/(approve|reject)$/);
    if (tenantDecision && method === 'POST') {
      requireRelayOwner(principal);
      const approve = tenantDecision[2] === 'approve';
      await store.transaction((state) => {
        const entry = own(state.tenantRequests ?? {}, tenantDecision[1]) ?? fail(404, 'NOT_FOUND');
        if (entry.status !== 'pending' || entry.expiresAt <= now()) return fail(409, 'TENANT_REQUEST_EXPIRED');
        if (!approve) { entry.status = 'rejected'; return; }
        const { bootstrap, accountName, deviceName } = entry.request;
        if (own(state.networks, bootstrap.networkId)) return fail(409, 'TENANT_EXISTS');
        if (Object.values(state.networks).filter(t => t.tenant).length >= 64) return fail(409, 'TENANT_LIMIT');
        const tenantNetwork = ownerNetwork(bootstrap, name(deviceName));
        tenantNetwork.tenant = { accountName: name(accountName), createdAt: now() };
        state.networks[bootstrap.networkId] = tenantNetwork;
        entry.status = 'approved';
      });
      return writeJson(res, 200, { status: approve ? 'approved' : 'rejected' });
    }
    if (url.pathname === API + '/tenants' && method === 'GET') {
      requireRelayOwner(principal);
      return writeJson(res, 200, { tenants: store.networks().filter(t => t.tenant).map(t => ({
        networkId: t.id, accountName: t.tenant!.accountName, createdAt: t.tenant!.createdAt,
        devices: Object.values(t.devices).filter(d => d.revokedAt === null).length,
        online: [...sessions.values()].some(s => s.principal.networkId === t.id && active(s.principal)) })) });
    }
    const tenant = url.pathname.match(/^\/api\/agent-net\/tenants\/([^/]+)$/);
    if (tenant && method === 'DELETE') {
      const target = decodeURIComponent(tenant[1]);
      // The relay owner revokes a tenant; the tenant's own owner may also leave.
      if (principal.delegation || principal.certificate?.role !== 'owner' || principal.networkId !== target) requireRelayOwner(principal);
      const media = await store.transaction((state) => {
        const removed = own(state.networks, target);
        if (!removed?.tenant) return fail(404, 'NOT_FOUND');
        delete state.networks[target];
        if (state.delegationRequests) state.delegationRequests = state.delegationRequests.filter(r => r.networkId !== target);
        for (const [id, r] of Object.entries(state.tenantRequests ?? {})) if (r.request.bootstrap.networkId === target) delete state.tenantRequests![id];
        return Object.keys(removed.media);
      });
      for (const [id, session] of sessions) if (session.principal.networkId === target) { sessions.delete(id); session.ws.close(4410, 'access revoked'); }
      for (const id of media) void mediaOperation(target, id, () => storage.remove(id))
        .catch(() => logger.error({}, 'agent-net tenant media cleanup failed'));
      return writeJson(res, 200, { ok: true });
    }
    const device = url.pathname.match(/^\/api\/agent-net\/devices\/([^/]+)$/);
    if (device && ['PATCH', 'DELETE'].includes(method)) {
      const target = decodeURIComponent(device[1]);
      // V1 parity: a paired member can edit a display alias. Removing another
      // member remains an owner operation; a member can only leave itself.
      if (method === 'DELETE' && principal.deviceId !== target) requireOwner(principal);
      await store.transaction((state) => {
        const current = memberRecord(state.networks[n.id], target);
        if (method === 'PATCH') current.customName = body.name === null ? null : name(body.name);
        else {
          if (current.certificate.role === 'owner' && (mode === 'self-hosted' || Object.values(state.networks[n.id].devices).filter((d) => d.revokedAt === null && d.certificate.role === 'owner').length <= 1)) return fail(403, 'OWNER_CANNOT_BE_REMOVED');
          current.revokedAt = now();
          delete state.networks[n.id].pushTokens[target];
          for (const grant of Object.values(state.networks[n.id].grants)) if (grant.delegation.hostDeviceId === target) grant.revokedAt = now();
        }
      });
      if (method === 'DELETE') disconnect(n.id, target);
      else announce(n.id);
      const renamed = method === 'PATCH' ? roster(principal).find(view => view.certificate.deviceId === target)?.name : undefined;
      return writeJson(res, 200, { deviceId: target, deleted: method === 'DELETE', ...(renamed ? { name: renamed } : {}) });
    }
    if (url.pathname === API + '/grants' && method === 'POST') {
      const d = body.delegation;
      if (!verifyDelegation(n.rootPublicKey, d, now()) || d.hostDeviceId !== principal.deviceId || d.networkId !== n.id
        || d.issuerCertificate.signingKey !== principal.certificate?.signingKey
        || d.executors?.some(e => !endpointUsable(n, d, e.certificate.deviceId))
        || (sharing && !sharing.authorized(d))) return fail(403, 'GRANT_INVALID');
      await store.transaction((state) => {
        const current = state.networks[n.id];
        for (const [id, grant] of Object.entries(current.grants)) if (grant.delegation.expiresAt <= now()
          && (grant.revokedAt === null || grant.revokedAt + MAX_GRANT_LIFETIME_MS <= now())) delete current.grants[id];
        const previous = own(current.grants, d.id);
        if (body.previousSignature !== undefined && (typeof body.previousSignature !== 'string' || previous?.delegation.signature !== body.previousSignature)) return fail(409, 'GRANT_CHANGED');
        // Exact executor certificates make grants variable-sized. Reserve half
        // of the control envelope for the member roster and pending requests;
        // rejecting this write keeps existing peers' directories decodable.
        const affected = new Set([d.hostDeviceId, ...(d.executors ?? []).map(e => e.certificate.deviceId)]);
        const sizes = new Map([...affected].map(id => [id, Buffer.byteLength(JSON.stringify(d)) + 1]));
        for (const saved of Object.values(current.grants)) {
          if (saved.delegation.id === d.id || saved.revokedAt !== null || saved.delegation.expiresAt <= now()) continue;
          const bytes = Buffer.byteLength(JSON.stringify(saved.delegation)) + 1;
          for (const id of affected) if (delegationEndpointCertificate(saved.delegation, id, now())) sizes.set(id, sizes.get(id)! + bytes);
        }
        if ([...sizes.values()].some(bytes => bytes > MAX_CONTROL_BYTES / 2)) return fail(429, 'GRANT_DIRECTORY_LIMIT');
        if (previous) {
          const old = previous.delegation;
          // A lease can extend only the very same authorization. Revocation or
          // re-admission must use a new ID; late renewal cannot resurrect it.
          if (previous.revokedAt !== null || old.hostDeviceId !== d.hostDeviceId || old.kind !== d.kind
            || old.resourceId !== d.resourceId || old.guestDeviceId !== d.guestDeviceId
            || old.guestSigningKey !== d.guestSigningKey || old.guestTransportKey !== d.guestTransportKey
            || old.scope?.memberId !== d.scope?.memberId || old.scope?.guestSubject !== d.scope?.guestSubject
            || old.scope?.memberVersion !== d.scope?.memberVersion || d.issuedAt < old.issuedAt || d.expiresAt < old.expiresAt) {
            return fail(409, 'GRANT_EXISTS');
          }
          previous.delegation = d; return;
        }
        if (Object.keys(current.grants).length >= 4096) return fail(429, 'GRANT_LIMIT');
        if (Object.values(current.grants).filter((g) => g.revokedAt === null && g.delegation.hostDeviceId === principal.deviceId).length >= 128) return fail(429, 'GRANT_LIMIT');
        current.grants[d.id] = { delegation: d, revokedAt: null };
      });
      announce(n.id);
      return writeJson(res, 201, { delegation: d, guestRelayId: 'guest:' + d.id });
    }
    if (url.pathname === API + '/grants' && method === 'GET') return writeJson(res, 200, {
      grants: Object.values(n.grants).filter((g) => g.revokedAt === null && g.delegation.expiresAt > now() && g.delegation.hostDeviceId === principal.deviceId).map((g) => g.delegation),
    });
    const grant = url.pathname.match(/^\/api\/agent-net\/grants\/([A-Za-z0-9-]+)$/);
    if (grant && method === 'GET') {
      const saved = own(n.grants, grant[1]);
      if (!saved || saved.revokedAt !== null || !usableDelegation(n, saved.delegation)) return fail(404, 'NOT_FOUND');
      if (saved.delegation.hostDeviceId !== principal.deviceId) return fail(403, 'FORBIDDEN');
      return writeJson(res, 200, { delegation: saved.delegation });
    }
    if (grant && method === 'DELETE') {
      await store.transaction((state) => {
        const current = own(state.networks[n.id].grants, grant[1]) ?? fail(404, 'NOT_FOUND');
        if (current.delegation.hostDeviceId !== principal.deviceId) return fail(403, 'FORBIDDEN');
        current.revokedAt = now();
        delete state.networks[n.id].pushTokens['guest:' + grant[1]];
      });
      disconnect(n.id, 'guest:' + grant[1]);
      return writeJson(res, 200, { deleted: true });
    }
    if (url.pathname === API + '/push-token' && ['PUT', 'DELETE'].includes(method)) {
      let registration: PushRegistration | undefined;
      if (method === 'PUT') {
        const provider = string(body.provider);
        const appVariant = string(body.appVariant);
        if (!['apns', 'fcm', 'bridge'].includes(provider) || !['cn', 'global'].includes(appVariant)
          || (body.apnsEnv !== null && !['prod', 'sandbox'].includes(String(body.apnsEnv)))) return fail(400, 'PUSH_REGISTRATION_INVALID');
        const token = string(body.token, 4_096);
        if (!/^[A-Za-z0-9_:.\/-]+$/.test(token) || (provider === 'apns' && !/^[a-fA-F0-9]{64}$/.test(token))) return fail(400, 'PUSH_REGISTRATION_INVALID');
        registration = { token, provider: provider as PushRegistration['provider'], appVariant: appVariant as PushRegistration['appVariant'], apnsEnv: body.apnsEnv as PushRegistration['apnsEnv'] };
        if (body.notificationKey !== undefined) {
          const binding = body.notificationKey as NonNullable<PushRegistration['notificationKey']>;
          if (principal.delegation || !binding || Object.keys(binding).length !== 5 || binding.v !== 2
            || binding.networkId !== n.id || binding.deviceId !== principal.deviceId
            || typeof binding.encryptionKey !== 'string' || !KEY_PATTERN.test(binding.encryptionKey)
            || !verifySignature(principal.certificate!.signingKey, notificationKeyPayload(binding), binding.signature)) {
            return fail(400, 'PUSH_REGISTRATION_INVALID');
          }
          registration.notificationKey = binding;
        }
      }
      await store.transaction((state) => {
        if (registration) state.networks[n.id].pushTokens[principal.deviceId] = registration;
        else delete state.networks[n.id].pushTokens[principal.deviceId];
      });
      announce(n.id);
      return writeJson(res, 200, { registered: method === 'PUT', deliveryConfigured: !!options.notify, notificationKeys: true });
    }
    if (url.pathname === API + '/notify' && method === 'POST') {
      if (!options.notify) return fail(503, 'NOTIFICATION_PROVIDER_NOT_CONFIGURED');
      const to = identifier(body.to);
      if (!permitted(principal, to)) return fail(403, 'FORBIDDEN');
      if (!allow(key(n.id, principal.deviceId) + ':notify', 60)) return fail(429, 'TOO_MANY_REQUESTS');
      const registration = own(n.pushTokens, to);
      if (!registration) return fail(409, 'PUSH_TOKEN_UNAVAILABLE');
      const ciphertext = string(body.ciphertext, 3_000);
      try {
        const result = await options.notify({ networkId: n.id, from: principal.deviceId, to, registration, ciphertext });
        if (result?.invalidToken || result?.apnsEnv) await store.transaction((state) => {
          const current = own(state.networks[n.id].pushTokens, to);
          if (!current || current.token !== registration.token) return;
          if (result.invalidToken) delete state.networks[n.id].pushTokens[to];
          else if (result.apnsEnv) current.apnsEnv = result.apnsEnv;
        });
      }
      catch { return fail(502, 'NOTIFICATION_DELIVERY_FAILED'); }
      return writeJson(res, 202, { accepted: true });
    }
    if (url.pathname === API + '/media' && method === 'POST') {
      const recipient = identifier(body.recipient);
      if (!permitted(principal, recipient)) return fail(403, 'FORBIDDEN');
      const size = Number(body.size);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MEDIA_OBJECT_BYTES) return fail(400, 'INVALID_MEDIA_SIZE');
      const id = randomUUID();
      await store.transaction((state) => {
        const current = state.networks[n.id];
        const uploads = Object.values(current.media).filter((u) => u.expiresAt > now());
        if (uploads.length >= 1024 || uploads.reduce((s, u) => s + u.size, 0) + size > MEDIA_NETWORK_QUOTA_BYTES) return fail(429, 'MEDIA_QUOTA');
        current.media[id] = { owner: principal.deviceId, recipient, size, received: 0, expiresAt: now() + 24 * 60 * 60 * 1000 };
      });
      return writeJson(res, 201, { id, chunkBytes: body.chunkFormat === 'binary-v1' ? MAX_MEDIA_BINARY_CHUNK_BYTES : 32_768,
        ...(body.transfer === MEDIA_TRANSFER_DIRECT && storage.direct ? { transfer: MEDIA_TRANSFER_DIRECT } : {}) });
    }
    const media = url.pathname.match(/^\/api\/agent-net\/media\/([A-Za-z0-9-]+)(?:\/(upload|commit))?$/);
    if (media) {
      return mediaOperation(n.id, media[1], async () => {
        const item = own(network(n.id).media, media[1]);
        if (!item || item.expiresAt <= now()) return fail(404, 'NOT_FOUND');
        if (principal.deviceId !== item.owner && principal.deviceId !== item.recipient) return fail(403, 'FORBIDDEN');
        const other = principal.deviceId === item.owner ? item.recipient : item.owner;
        if (!active(principal) || (principal.delegation || method === 'PUT' || media[2]) && !permitted(principal, other)) return fail(403, 'FORBIDDEN');
        if (media[2]) {
          // Direct transfer: the owner writes the chunks to the storage itself. The relay authorizes each one and
          // takes the stored length from the storage, never from the client.
          if (!storage.direct) return fail(404, 'NOT_FOUND');
          if (method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED');
          if (principal.deviceId !== item.owner) return fail(403, 'FORBIDDEN');
          const stored = await storage.length(media[1]);
          if (stored < item.received) return fail(409, 'MEDIA_DATA_MISSING');
          if (stored > item.size) {
            await storage.remove(media[1]);
            await store.transaction((state) => { retireMedia(state.networks[n.id], media[1]); });
            return fail(409, 'MEDIA_SIZE_MISMATCH');
          }
          if (stored !== item.received) await store.transaction((state) => { state.networks[n.id].media[media[1]].received = stored; });
          if (media[2] === 'commit') return writeJson(res, 200, { received: stored, complete: stored === item.size });
          if (stored === item.size) return fail(403, 'FORBIDDEN');
          const offset = Number(body.offset), size = Number(body.size), md5 = body.md5;
          if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MEDIA_BINARY_CHUNK_BYTES
            || typeof md5 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(md5)) return fail(400, 'MEDIA_CHUNK_INVALID');
          if (!Number.isSafeInteger(offset) || offset !== stored || stored + size > item.size) return fail(409, 'MEDIA_OFFSET_MISMATCH');
          return writeJson(res, 200, { request: boundedGrant(await storage.direct.append(media[1], offset, size, md5)) });
        }
        if (method === 'GET') {
          if (item.received !== item.size) return fail(409, 'MEDIA_INCOMPLETE');
          // A client that can reach the storage reads the ciphertext there; the relay only authorizes the read.
          if (storage.direct && req.headers[MEDIA_TRANSFER_HEADER] === MEDIA_TRANSFER_DIRECT) {
            const request = boundedGrant(await storage.direct.read(media[1]));
            res.setHeader(MEDIA_TRANSFER_HEADER, MEDIA_TRANSFER_DIRECT);
            return writeJson(res, 200, { transfer: MEDIA_TRANSFER_DIRECT, size: item.size, request });
          }
          let start = 0, end = item.size - 1;
          const range = req.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2])) return fail(416, 'INVALID_MEDIA_RANGE');
            if (!match[1]) start = Math.max(0, item.size - Number(match[2]));
            else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= item.size) return fail(416, 'INVALID_MEDIA_RANGE');
          }
          // Open the stream first: a storage failure must still be answered with a 503, impossible once headers are out.
          const stream = await storage.read(media[1], start, end);
          res.writeHead(range ? 206 : 200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
            'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range ? { 'content-range': 'bytes ' + start + '-' + end + '/' + item.size } : {}) });
          await pipeline(stream, res); return;
        }
        if (method === 'DELETE') {
          await storage.remove(media[1]);
          await store.transaction((state) => { retireMedia(state.networks[n.id], media[1]); });
          return writeJson(res, 200, { deleted: true });
        }
        if (method !== 'PUT') return fail(405, 'METHOD_NOT_ALLOWED');
        if (principal.deviceId !== item.owner || item.received === item.size) return fail(403, 'FORBIDDEN');
        const encoded = binaryUpload ? '' : string(body.data, 43_691);
        const data = binaryUpload ? bytes : Buffer.from(encoded, 'base64url');
        const offset = Number(body.offset);
        if ((!binaryUpload && (data.toString('base64url') !== encoded || data.length > 32_768)) || data.length === 0) return fail(400, 'MEDIA_CHUNK_INVALID');
        if (!Number.isSafeInteger(offset) || offset !== item.received || item.received + data.length > item.size) return fail(409, 'MEDIA_OFFSET_MISMATCH');
        let received: number;
        try { received = await storage.append(media[1], item.received, data); }
        catch (error) { if (error instanceof RelayMediaStorageError) return fail(409, error.code); throw error; }
        if (received !== item.received + data.length) return fail(409, 'MEDIA_OFFSET_MISMATCH');
        await store.transaction((state) => { state.networks[n.id].media[media[1]].received = received; });
        return writeJson(res, 200, { received, complete: received === item.size });
      });
    }
    return fail(404, 'NOT_FOUND');
  }
  /** The replica that owns the request's network, when that is not this one. A hop from another
   * replica is always served here, so differing member lists cannot bounce a request around. */
  function forwardTarget(req: IncomingMessage): RelayClusterMember | undefined {
    if (!cluster || !router || router.trusted(req)) return undefined;
    const networkId = routingNetwork(req);
    const owner = networkId === undefined ? undefined : ownerOf(networkId);
    return owner && owner.id !== cluster.replicaId ? owner : undefined;
  }
  /**
   * A direct write granted before a removal can still land and recreate the object. With direct storage a removed
   * upload therefore stays as an expired record (it reads as gone and counts against no quota) until every grant
   * has lapsed, and the expiry sweep, which waits as long, removes the object again.
   */
  const retainExpiredMs = storage.direct ? DIRECT_GRANT_MAX_MS : 0;
  function retireMedia(network: NetworkRecord, id: string): void {
    const item = network.media[id];
    if (!item) return;
    if (retainExpiredMs) item.expiresAt = Math.min(item.expiresAt, now()); else delete network.media[id];
  }
  function boundedGrant(request: DirectMediaRequest): DirectMediaRequest {
    if (!(request.expiresAt <= now() + DIRECT_GRANT_MAX_MS)) throw new RelayMediaStorageUnavailableError('DIRECT_GRANT_TOO_LONG');
    return request;
  }
  let stateWarnedAt = -Infinity, storageWarnedAt = -Infinity;
  function storageUnavailable(): void {
    if (now() - storageWarnedAt < 10_000) return;
    storageWarnedAt = now();
    logger.warn({}, 'agent-net media storage unavailable');
  }
  function stateUnavailable(error: RelayStateUnavailableError): void {
    // An outage fails every write; one line per interval is enough to alert on.
    if (now() - stateWarnedAt < 10_000) return;
    stateWarnedAt = now();
    logger.warn({ code: error.code }, 'agent-net shared state unavailable');
  }
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (closing) { writeJson(res, 503, { error: { code: 'SERVER_CLOSING', message: 'Server closing' } }); return; }
    const target = forwardTarget(req);
    if (target) { router!.http(req, res, target); return; }
    if (ownerless(req)) { writeJson(res, 503, { error: { code: 'REPLICA_UNAVAILABLE', message: 'Replica unavailable' } }); return; }
    const operation = handle(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (error instanceof AgentNetError) writeJson(res, error.status, { error: { code: error.code, message: error.message } });
      else if (error instanceof SharingError) writeJson(res, error.statusCode, { error: { code: error.code, message: error.message } });
      // Shared state unreachable or contended: retryable, never an authorization result.
      else if (error instanceof RelayStateUnavailableError) { stateUnavailable(error); writeJson(res, 503, { error: { code: 'CLUSTER_STATE_UNAVAILABLE', message: 'Shared state unavailable' } }); }
      // Attachment storage down: retryable, like the shared state.
      else if (error instanceof RelayMediaStorageUnavailableError) { storageUnavailable(); writeJson(res, 503, { error: { code: 'MEDIA_STORAGE_UNAVAILABLE', message: 'Attachment storage unavailable' } }); }
      else { logger.error({ name: error instanceof Error ? error.name : 'Unknown' }, 'agent-net request failed'); writeJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } }); }
    });
    pendingRequests.add(operation);
    void operation.then(() => pendingRequests.delete(operation), () => pendingRequests.delete(operation));
  };
  const server = options.tls ? createHttpsServer(options.tls, onRequest) : createHttpServer(onRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on('upgrade', (req, socket, head) => {
    if (closing) { socket.destroy(); return; }
    const target = forwardTarget(req);
    if (target) { router!.upgrade(req, socket, head, target); return; }
    if (ownerless(req)) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    // A leaving replica accepts no new sessions; the client retries and reaches a remaining one.
    if (draining) { socket.destroy(); return; }
    pendingUpgrades.add(socket);
    socket.once('close', () => pendingUpgrades.delete(socket));
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const guest = pathname === API + '/guest/ws';
    if (pathname !== API + '/ws' && !guest) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    void authenticate(req, Buffer.alloc(0), guest).then((principal) => {
      if (closing || draining || socket.destroyed || !owns(principal.networkId) || !active(principal)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (closing || draining || !owns(principal.networkId) || !active(principal)) { ws.close(1012, 'network moved'); return; }
        const id = key(principal.networkId, principal.deviceId);
        sessions.get(id)?.ws.close(4409, 'replaced');
        const session: Session = { principal, ws, lastPong: now(), remoteControlEnabled: false, capabilities: [],
          datagrams: new DatagramSendQueue(ws, {
            stalled: (waitedMs, bufferedBytes) => logger.warn({ waitedMs: Math.round(waitedMs), bufferedBytes },
              'agent-net session send queue has not moved; dropping datagrams to it until it does'),
            moving: (dropped, droppedBytes, bufferedBytes) => logger.info({ dropped, droppedBytes, bufferedBytes },
              'agent-net session send queue moving again'),
          }, options.datagramQueueDelayMs) };
        sessions.set(id, session);
        ws.on('error', () => undefined);
        ws.on('pong', () => { session.lastPong = now(); });
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, notifications: !!options.notify, networkId: principal.networkId, deviceId: principal.deviceId, devices: roster(principal), delegations: delegatedPeers(principal),
          delegationRequests: principal.delegation ? [] : sharing?.requestsFor(principal.networkId, principal.deviceId) ?? [] }));
        ws.on('message', (raw: RawData, binary: boolean) => {
          if (sessions.get(id) !== session || !active(principal)) { ws.close(expiredCredential(principal) ? 4408 : 4410, 'access unavailable'); return; }
          const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
          if (!binary) {
            if (principal.delegation || bytes.length > 4_096) { ws.close(1008, 'invalid control'); return; }
            try {
              const control = record(JSON.parse(bytes.toString('utf8')));
              if (control.type !== 'presence' || typeof control.remoteControlEnabled !== 'boolean' || !Array.isArray(control.capabilities)
                || control.capabilities.length > 64 || !control.capabilities.every((v) => typeof v === 'string' && ID_PATTERN.test(v))) throw new Error('invalid');
              session.remoteControlEnabled = control.remoteControlEnabled;
              session.capabilities = control.capabilities as string[];
              if ((control.platform !== undefined && (typeof control.platform !== 'string' || control.platform.length > 64))
                || (control.app !== undefined && (typeof control.app !== 'string' || control.app.length > 64 || !ID_PATTERN.test(control.app)))
                || (control.appVersion !== undefined && (typeof control.appVersion !== 'string' || control.appVersion.length > 64))
                || (control.deviceName !== undefined && (typeof control.deviceName !== 'string' || !control.deviceName.trim() || control.deviceName.length > 64))
                || (control.busy !== undefined && typeof control.busy !== 'boolean')) throw new Error('invalid');
              // Additive V2 metadata preserves offline device management. An old
              // client can omit it without erasing the last known platform.
              const metadata = { ...(typeof control.platform === 'string' ? { platform: control.platform } : {}),
                ...(typeof control.app === 'string' ? { app: control.app } : {}),
                ...(typeof control.deviceName === 'string' ? { deviceName: control.deviceName.trim() } : {}),
                ...(typeof control.appVersion === 'string' ? { appVersion: control.appVersion } : {}),
                ...(typeof control.busy === 'boolean' ? { busy: control.busy } : {}) };
              session.metadata = { ...session.metadata, ...metadata };
              // Metadata is stable for a socket lifetime. Presence/busy changes
              // must not enqueue an unbounded sequence of disk transactions.
              if (!session.metadataWritten) { session.metadataWritten = true; void store.transaction(state => {
                const device = state.networks[principal.networkId]?.devices[principal.deviceId];
                if (device && device.revokedAt === null) { device.metadata = { ...device.metadata,
                  platform: metadata.platform ?? device.metadata?.platform, app: metadata.app ?? device.metadata?.app,
                  appVersion: metadata.appVersion ?? device.metadata?.appVersion };
                  if (metadata.deviceName) device.reportedName = metadata.deviceName;
                  device.lastSeenAt = now(); }
              }).catch(() => ws.close(1011, 'storage unavailable')); }
              announce(principal.networkId);
            } catch { ws.close(1008, 'invalid control'); }
            return;
          }
          const frame = decodeDatagrams(bytes);
          if (!frame) { ws.close(1008, 'invalid datagram frame'); return; }
          if (!permitted(principal, frame.deviceId)) {
            // A member can still have in-flight packets for a just-revoked peer. Drop that destination,
            // not its shared session and the unrelated healthy connections carried by it.
            if (principal.delegation) ws.close(1008, 'scope violation');
            return;
          }
          const target = sessions.get(key(principal.networkId, frame.deviceId));
          if (!target || !active(target.principal) || target.ws.readyState !== WebSocket.OPEN || target.ws.bufferedAmount > 1024 * 1024) return;
          try {
            const encoded = encodeDatagrams(principal.deviceId, frame.datagrams);
            target.datagrams.sendDatagram(encoded);
          } catch { /* The rewritten source may be longer: drop oversized batches like UDP. */ }
        });
        ws.on('close', () => {
          if (sessions.get(id) === session) {
            sessions.delete(id); announce(principal.networkId);
            if (!principal.delegation) void store.transaction(state => {
              const device = state.networks[principal.networkId]?.devices[principal.deviceId];
              if (device && device.revokedAt === null) device.lastSeenAt = now();
            }).catch(() => undefined);
          }
        });
        announce(principal.networkId);
      });
    }).catch((error: unknown) => {
      const status = error instanceof AgentNetError ? error.status : 503;
      socket.end('HTTP/1.1 ' + status + ' ' + (STATUS_CODES[status] ?? 'Upgrade Rejected') + '\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const udpHost = options.udpHost ?? options.host ?? '127.0.0.1';
  const udp = options.udpPort === undefined ? null : createSocket(isIP(udpHost) === 6 ? 'udp6' : 'udp4');
  if (udp) {
    udp.on('message', (packet, remote: RemoteInfo) => {
      if (packet.length < 20 || packet.length > 512 || packet.readUInt16BE(0) !== 1 || packet.readUInt16BE(2) !== packet.length - 20
        || packet.readUInt32BE(4) !== 0x2112a442 || !allow('udp:' + remote.address, 600)) return;
      const addressBytes = remote.family === 'IPv6' ? ipv6Bytes(remote.address) : Buffer.from(remote.address.split('.').map(Number));
      if (!addressBytes) return;
      const response = Buffer.alloc(28 + addressBytes.length);
      response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(response.length - 20, 2);
      packet.copy(response, 4, 4, 20);
      response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(4 + addressBytes.length, 22);
      response[25] = remote.family === 'IPv6' ? 2 : 1;
      response.writeUInt16BE(remote.port ^ 0x2112, 26);
      const mask = Buffer.concat([packet.subarray(4, 8), packet.subarray(8, 20)]);
      for (let i = 0; i < addressBytes.length; i++) response[28 + i] = addressBytes[i] ^ mask[i];
      udp.send(response, remote.port, remote.address);
    });
    try {
      await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(options.udpPort, udpHost, () => { udp.off('error', reject); resolve(); }); });
    } catch (error) { server.closeAllConnections(); server.close(); udp.close(); throw error; }
    udp.on('error', (error) => logger.warn({ name: error.name }, 'agent-net UDP error'));
    advertisedUdpPort = (udp.address() as AddressInfo).port;
  }
  let sweeping = false;
  const expiredEntries = (n: NetworkRecord, at: number) => {
    for (const [id, join] of Object.entries(n.joins)) if (join.expiresAt <= at) delete n.joins[id];
    for (const [id, code] of Object.entries(n.joinCodes)) if (code.expiresAt <= at) delete n.joinCodes[id];
    for (const [id, grant] of Object.entries(n.grants)) if (grant.delegation.expiresAt <= at
      && (grant.revokedAt === null || grant.revokedAt + MAX_GRANT_LIFETIME_MS <= at)) delete n.grants[id];
  };
  const hasExpiredEntries = (n: NetworkRecord, at: number) => Object.values(n.joins).some(join => join.expiresAt <= at)
    || Object.values(n.joinCodes).some(code => code.expiresAt <= at)
    || Object.values(n.grants).some(grant => grant.delegation.expiresAt <= at && (grant.revokedAt === null || grant.revokedAt + MAX_GRANT_LIFETIME_MS <= at));
  const sweep = setInterval(() => {
    const at = now();
    for (const [nonce, until] of nonces) if (until <= at) nonces.delete(nonce);
    for (const [id, item] of rate) if (at - item.at >= 60_000) rate.delete(id);
    for (const [id, session] of sessions) {
      if (!active(session.principal)) { sessions.delete(id); session.ws.close(expiredCredential(session.principal) ? 4408 : 4410, 'access unavailable'); }
      else if (at - session.lastPong > 90_000) { sessions.delete(id); session.ws.close(1001, 'heartbeat timeout'); }
      else if (!owns(session.principal.networkId)) { sessions.delete(id); session.ws.close(1012, 'network moved'); }
      else session.ws.ping();
    }
    // Replicas share state; each cleans only the networks it owns.
    const ownedIds = store instanceof ClusterStore ? store.networkIds().filter(owns) : undefined;
    const swept = ownedIds ? ownedIds.flatMap(id => store.network(id) ?? []) : store.networks();
    for (const n of swept) for (const [id, upload] of Object.entries(n.media)) if (upload.expiresAt + retainExpiredMs <= at) {
      void mediaOperation(n.id, id, async () => {
        const current = store.network(n.id)?.media[id];
        if (!current || current.expiresAt + retainExpiredMs > now()) return;
        await storage.remove(id);
        await store.transaction((state) => { if (state.networks[n.id]) delete state.networks[n.id].media[id]; });
      }).catch(() => logger.error({}, 'agent-net media cleanup failed'));
    }
    if (!sweeping) {
      sweeping = true;
      const cleanup = ownedIds
        // One small commit per owned network with expired entries: a transaction over every owned
        // network would conflict with each write any other replica makes to any of them.
        ? (async () => {
          for (const n of swept) if (hasExpiredEntries(n, at)) await store.transaction((state) => {
            const current = state.networks[n.id];
            if (current) expiredEntries(current, at);
          });
        })()
        : store.transaction((state) => {
          for (const n of Object.values(state.networks)) expiredEntries(n, at);
          for (const [id, invite] of Object.entries(state.tenantInvites ?? {})) if (invite.expiresAt <= at) delete state.tenantInvites![id];
          for (const [id, r] of Object.entries(state.tenantRequests ?? {})) if (r.expiresAt <= at) delete state.tenantRequests![id];
        });
      void cleanup.catch(() => logger.error({}, 'agent-net state cleanup failed')).finally(() => { sweeping = false; });
    }
  }, 30_000);
  unrefTimer(sweep);
  const address = server.address() as AddressInfo;
  const publicHost = address.address === '::' ? '[::1]' : address.address === '0.0.0.0' ? '127.0.0.1' : isIP(address.address) === 6 ? '[' + address.address + ']' : address.address;
  const listeningUrl = (options.tls ? 'https://' : 'http://') + publicHost + ':' + address.port;
  const unsubscribe: Array<() => void> = [];
  if (cluster && store instanceof ClusterStore) {
    // Membership changes move only the networks this replica gains or loses; their devices reconnect.
    unsubscribe.push(cluster.backend.onMembers((next) => {
      members = next; owners.clear();
      if (draining) return; // leaveCluster closes every session and waits for the close frames.
      for (const [id, session] of sessions) if (!owns(session.principal.networkId)) { sessions.delete(id); session.ws.close(1012, 'network moved'); }
    }));
    unsubscribe.push(store.onRemoteChange((change) => {
      const affected = new Set([...change.networks].filter(owns));
      if (change.global.has('sharing') || change.global.has('delegationRequests')) {
        for (const networkId of sharingNetworks(change, store.sharingStorage().read(), store.delegationRequests())) if (owns(networkId)) affected.add(networkId);
      }
      for (const networkId of affected) refresh(networkId);
    }));
    try {
      await cluster.backend.join({ id: cluster.replicaId, url: cluster.url ?? listeningUrl });
    } catch (error) {
      for (const stop of unsubscribe) stop();
      store.close(); clearInterval(sweep); server.closeAllConnections(); server.close(); udp?.close();
      throw error;
    }
    members = cluster.backend.members(); owners.clear(); joined = true;
  }
  /** Leave first so the others take this replica's networks, then send its devices there. */
  async function leaveCluster(): Promise<void> {
    if (!cluster) return;
    draining = true; owners.clear();
    // An unreachable backend must not block shutdown; liveness then drops this replica.
    await Promise.race([cluster.backend.leave(cluster.replicaId).catch(() => logger.warn({}, 'agent-net cluster leave failed')),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5_000); unrefTimer(timer); })]);
    const closed = [...sessions.values()].map(session => new Promise<void>((resolve) => {
      if (session.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      session.ws.once('close', () => resolve());
      session.ws.close(1012, 'replica leaving');
    }));
    sessions.clear();
    // Let the close frames reach the devices; the forced teardown below would discard them.
    await Promise.race([Promise.all(closed), new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); unrefTimer(timer); })]);
    // Late requests that still reach this replica are passed to the new owners meanwhile.
    if (cluster.drainMs) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, cluster.drainMs); unrefTimer(timer); });
  }
  let closeOperation: Promise<void> | undefined;
  return {
    url: options.publicUrl ?? listeningUrl,
    udpAddress: udp ? udp.address() as AddressInfo : null,
    close() {
      if (closeOperation) return closeOperation;
      if (!cluster) closing = true;
      closeOperation = (async () => {
      await leaveCluster();
      closing = true;
      for (const stop of unsubscribe) stop();
      router?.close();
      clearInterval(sweep);
      for (const socket of pendingUpgrades) socket.destroy();
      for (const ws of wss.clients) ws.terminate();
      sessions.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (udp) await new Promise<void>((resolve) => udp.close(() => resolve()));
      // Sockets may have closed while a bridge delivery or an atomic state commit is still running.
      await Promise.allSettled(pendingRequests);
      await Promise.allSettled(mediaQueues.values());
      await store.settled();
      if (store instanceof ClusterStore) store.close();
      })();
      return closeOperation;
    },
  };
}
function ipv6Bytes(address: string): Buffer | null {
  if (isIP(address) !== 6) return null;
  if (address.includes('.')) {
    const split = address.lastIndexOf(':');
    const v4 = address.slice(split + 1).split('.').map(Number);
    address = address.slice(0, split + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [left, right] = address.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const groups = address.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) out.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  return out;
}
