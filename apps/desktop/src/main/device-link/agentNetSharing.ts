import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import WebSocket from 'ws';
import { DeviceLinkClient, parseSharedTaskPeer, parseProviderSharePeer, type DeviceLinkClientOptions, type RoutedDeviceLinkClient, type SharedTaskApi } from '@cindy/device-link';
import { AgentNetSharingClient, AgentNetSharingTransport, buildAgentNetSharingInvitation,
  parseAgentNetSharingInvitation,
  encodeAgentNetSharingInvitation, syncAgentNetSharingOrigins,
  grantAgentNetSharingExecutor, revokeAgentNetSharingExecutor, checkAgentNetSharingExecutor, type SharingExecutorInput,
  type AgentNetSharingInvitation, type SharingRequestOptions } from '@cindy/agent-net';
import { identityFromSeed, signature, verifyCertificate, verifyDelegation, verifySignature, type Identity } from '@cindy/agent-net-relay';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentUserId, getDeviceId, getAuthState, getActiveAuthRealm } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createOutboundHttpAgent, outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import { agentNetClientForRelay, currentAgentNetClient, currentAgentNetScopedTarget, isAgentNetActive, openScopedAgentNetAppSocket,
  outgoingAgentNetClient, outgoingAgentNetClientForRelay } from './agentNetRuntime.js';
import { currentOfficialAgentNetClient, outgoingOfficialAgentNetClient } from './agentNetOfficial.js';
import { relayDataPath, secureStorageAvailable, readRelayConfig } from './selfHostedRelayConfig.js';
import { activeSelfHostedRelay } from './selfHostedRelayRouting.js';
import { hostJoinBaseUrl } from './selfHostedRelayAddress.js';
import { agentNetAllowsLegacy } from './agentNetRuntime.js';
import { agentNetSelectionKey } from './agentNetRuntime.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { createSharedTaskJournal } from '../localDb/sharedTasks.js';
import { agentNetMediaBinding, agentNetSharingSubject } from '@cindy/agent-net-protocol';
import { readDeviceLinkSettings } from './settings-store.desktop.js';

type Kind = AgentNetSharingInvitation['kind'];
export interface AgentNetSharingRoute extends Omit<AgentNetSharingInvitation, 'invitation'> {
  server: string;
  memberId?: string;
  seed?: string;
  retired?: boolean;
  guest?: true;
  aliases?: { members?: string[]; requests?: string[]; invitations?: string[] };
}
interface Vault { version: 2; seed: string; routes: AgentNetSharingRoute[]; services?: AgentNetSharingRoute[]; }
interface Session {
  key: string;
  file: string;
  vault: Vault;
  clients: Map<string, AgentNetSharingClient>;
  connections: Map<string, DeviceLinkClient>;
  leases: Set<AgentNetSharingTransport>;
  committed: Map<string, { route: AgentNetSharingRoute; member: AgentNetClient }>;
  sockets: Map<string, { api: AgentNetClient; socket: import('@cindy/agent-net').AgentNetAppSocket }>;
  lists: Map<string, unknown[]>;
  originSync?: Promise<void>;
  originDigest?: string;
  originSyncedAt?: number;
  guard(): void;
}
let session: Session | null = null;
type ScopedConnectionOptions = Omit<DeviceLinkClientOptions, 'getWsUrl' | 'getToken'>;
let binding: { client: RoutedDeviceLinkClient; options: ScopedConnectionOptions; session: Session;
  selection: string; pins: Map<string, () => void>; stop(): void } | null = null;
const keyOf = (kind: Kind, id: string) => kind + ':' + id;
/** A listing origin may be any pinned route or a discovery placeholder on that
 * authority: carry only the authority, never another resource's host, member or aliases. */
const resourceRoute = (origin: AgentNetSharingRoute, kind: Kind, resourceId: string, hostDeviceId: string): AgentNetSharingRoute =>
  ({ v: origin.v, kind, resourceId, server: origin.server, networkId: origin.networkId, rootPublicKey: origin.rootPublicKey, region: origin.region, hostDeviceId });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const seedValid = (seed: unknown): seed is string => typeof seed === 'string' && /^[A-Za-z0-9_-]{43}$/.test(seed)
  && Buffer.from(seed, 'base64url').toString('base64url') === seed;
function publicReceipt(route: AgentNetSharingRoute, invitation: string): AgentNetSharingInvitation {
  return { v: route.v, kind: route.kind, resourceId: route.resourceId, networkId: route.networkId,
    rootPublicKey: route.rootPublicKey, hostDeviceId: route.hostDeviceId, region: route.region, invitation };
}
function routeValid(route: AgentNetSharingRoute, outgoing = false): boolean {
  try {
    const { server, memberId, seed, aliases } = route;
    encodeAgentNetSharingInvitation(publicReceipt(route, 'A'.repeat(43)));
    const url = new URL(server);
    const secure = url.protocol === 'https:' || url.protocol === 'http:' &&
      (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !memberId && !!hostClient(route, outgoing));
    return secure && !url.username && !url.password && !url.hash && !url.search
      && server === server.replace(/\/+$/, '') && (memberId === undefined || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(memberId))
      && (seed === undefined || seedValid(seed)) && (memberId === undefined) === (seed === undefined)
      && (route.retired === undefined || typeof route.retired === 'boolean')
      && (route.guest === undefined || route.guest === true)
      && (aliases === undefined || Object.entries(aliases).every(([name, ids]) => ['members', 'requests', 'invitations'].includes(name)
        && Array.isArray(ids) && ids.length <= 10_000 && ids.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))));
  } catch { return false; }
}
function retire(state: Session): void {
  for (const client of state.clients.values()) client.close();
  for (const lease of state.leases) lease.close();
  for (const connection of state.connections.values()) connection.stop();
  state.clients.clear(); state.leases.clear(); state.connections.clear(); state.sockets.clear();
}
function owner(): Session {
  const account = getCurrentUserId(), key = activeOwnerScopeKey(), auth = getClientEndpoint('authApiBaseUrl');
  if (!account || !getAuthState().isAuthenticated || isAppSessionBoundaryPending()) throw new Error('AGENT_NET_OWNER_CHANGED');
  if (session?.key === key) { session.guard(); return session; }
  if (session) retire(session);
  const guard = () => {
    if (!getAuthState().isAuthenticated || getCurrentUserId() !== account || activeOwnerScopeKey() !== key
      || isAppSessionBoundaryPending() || getClientEndpoint('authApiBaseUrl') !== auth) throw new Error('AGENT_NET_OWNER_CHANGED');
  };
  const { file, vault } = readVault();
  session = { key, file, vault, guard, clients: new Map(), connections: new Map(), leases: new Set(), committed: new Map(), sockets: new Map(), lists: new Map() };
  return session;
}
/** Reads the current owner's sharing vault; never writes or publishes a session.
 * `outgoing` validates LAN host routes with the handover-close authority. */
function readVault(outgoing = false): { file: string; vault: Vault } {
  const file = relayDataPath('agent-net', 'sharing-v2.enc');
  let vault: Vault;
  if (fs.existsSync(file)) {
    if (!secureStorageAvailable() || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('AGENT_NET_SHARING_VAULT_UNAVAILABLE');
    try { vault = JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64'))); }
    catch { throw new Error('AGENT_NET_SHARING_VAULT_UNREADABLE'); }
    if (vault.version !== 2 || !seedValid(vault.seed) || !Array.isArray(vault.routes) || vault.routes.length > 1024
      || vault.routes.some(route => !routeValid(route, outgoing)) || new Set(vault.routes.map(r => keyOf(r.kind, r.resourceId))).size !== vault.routes.length
      || vault.services !== undefined && (!Array.isArray(vault.services) || vault.services.length > 1024 || vault.services.some(route => !routeValid(route, outgoing))))
      throw new Error('AGENT_NET_SHARING_VAULT_UNREADABLE');
  } else vault = { version: 2, seed: randomBytes(32).toString('base64url'), routes: [] };
  return { file, vault };
}
function save(state: Session, vault: Vault): void {
  state.guard();
  if (!secureStorageAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
  const encrypted = safeStorage.encryptString(JSON.stringify(vault)).toString('base64'); state.guard();
  fs.mkdirSync(path.dirname(state.file), { recursive: true, mode: 0o700 });
  const temporary = state.file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, state.file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  state.vault = vault;
}
function remember(state: Session, route: AgentNetSharingRoute, newAdmission = false): AgentNetSharingRoute {
  state.guard();
  if (!routeValid(route)) throw new Error('INVALID_AGENT_NET_SHARING_ROUTE');
  const key = keyOf(route.kind, route.resourceId), old = state.vault.routes.find(r => keyOf(r.kind, r.resourceId) === key);
  if (old && (old.server !== route.server || old.rootPublicKey !== route.rootPublicKey || old.networkId !== route.networkId
    || old.hostDeviceId !== route.hostDeviceId || old.region !== route.region || !newAdmission && old.memberId !== route.memberId))
    throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
  if (old) {
    const next = { ...old, ...route, aliases: { ...old.aliases, ...route.aliases } };
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      save(state, { ...state.vault, routes: state.vault.routes.map(r => r === old ? next : r) });
      if (old.memberId !== next.memberId || old.seed !== next.seed || old.retired !== next.retired) dropConnection(state, key);
    }
    installRoute(state, next); return next;
  }
  if (state.vault.routes.length >= 1024) throw new Error('AGENT_NET_SHARING_ROUTE_LIMIT');
  save(state, { ...state.vault, routes: [...state.vault.routes, route] }); installRoute(state, route); return route;
}
const leaseOf = new WeakMap<DeviceLinkClient, AgentNetSharingTransport>();
function dropConnection(state: Session, key: string): void {
  const scoped = state.connections.get(key), lease = scoped && leaseOf.get(scoped);
  scoped?.stop(); if (lease) { lease.close(); state.leases.delete(lease); }
  binding?.pins.get(key)?.(); binding?.pins.delete(key); state.connections.delete(key); state.sockets.delete(key);
}
/** The relay closes a member socket (4410) whenever the admission version moves: a pause, the
 * member's next device or a rotated credential. That client never restarts by itself, so once
 * the owner's list shows the share active again, rebuild it with a fresh lease. */
function reviveMemberConnection(state: Session, route: AgentNetSharingRoute): void {
  const key = keyOf(route.kind, route.resourceId);
  if (!route.memberId || route.retired || state.connections.get(key)?.getConnectionIssue()?.kind !== 'device-removed') return;
  dropConnection(state, key); installRoute(state, route);
}
function signer(identity: Identity) {
  return { identity, sign: async (value: string) => signature(identity.signingPrivateKey, value),
    random: async () => randomBytes(18).toString('base64url') };
}
/** `outgoing` is only for the account-handover close: the boundary is already
 * pending, so the ordinary accessors refuse; the caller has verified that the
 * outgoing owner scope is still current and captures the result synchronously. */
function hostClient(route: AgentNetSharingRoute, outgoing = false): AgentNetClient | null {
  if (route.memberId || route.guest) return null;
  let active: AgentNetClient | null = null;
  try { active = outgoing ? outgoingAgentNetClient() : currentAgentNetClient(); } catch { /* A different selected route is not this resource's authority. */ }
  if (active?.rootPublicKey === route.rootPublicKey && active.certificate.networkId === route.networkId) return active;
  if (route.networkId.startsWith('account:')) {
    const official = outgoing ? outgoingOfficialAgentNetClient() : currentOfficialAgentNetClient();
    return official?.base === route.server && official.rootPublicKey === route.rootPublicKey && official.certificate.networkId === route.networkId ? official : null;
  }
  if (!route.networkId.startsWith('private:')) return null;
  try {
    const relayId = route.networkId.slice('private:'.length);
    const api = outgoing ? outgoingAgentNetClientForRelay(relayId, route.server) : agentNetClientForRelay(relayId, route.server);
    return api.rootPublicKey === route.rootPublicKey ? api : null;
  } catch { return null; }
}
function business(state: Session, route: AgentNetSharingRoute): AgentNetSharingClient {
  state.guard();
  const member = hostClient(route), key = JSON.stringify([route.server, route.networkId, route.rootPublicKey, member?.certificate.signature ?? null]);
  const existing = state.clients.get(key); if (existing) return existing;
  // A guest's account proof is separate from every resource's transport key.
  // No official Agent-Net enrollment is needed to join a private invitation.
  const identity = identityFromSeed('cindy-agent-net/sharing-business/2', state.vault.seed, getDeviceId());
  // Persist the identity before its first external use, including an empty book.
  if (!fs.existsSync(state.file)) save(state, state.vault);
  const api = new AgentNetSharingClient({ base: member?.base ?? route.server, networkId: route.networkId, rootPublicKey: route.rootPublicKey,
    signer: signer(identity), hash, assertCurrent: state.guard, fetch: outboundFetch, ownerPinnedHttp: !!member,
    memberAuthorization: member ? (method, path, body) => { state.guard(); return member.header(method, path, body); } : undefined,
    async getIdentityCard(nonce) {
      return serverApiFetch<{ card: string; expiresAt: string }>('/api/me/identity-card', { method: 'POST',
        body: { audience: 'cindy-agent-net-sharing', purpose: 'network-session', nonce },
        baseUrl: () => { state.guard(); return getClientEndpoint('authApiBaseUrl'); }, timeoutMs: 12_000,
        cache: 'no-store', logLabel: '/api/me/identity-card', redactErrorDetails: true });
    } });
  state.clients.set(key, api); return api;
}
export function agentNetSharingRoute(kind: Kind, resourceId: string): AgentNetSharingRoute | null {
  return owner().vault.routes.find(r => r.kind === kind && r.resourceId === resourceId) ?? null;
}
function connectionKey(route: AgentNetSharingRoute): string {
  return route.memberId ? keyOf(route.kind, route.resourceId) : JSON.stringify([route.server, route.networkId, route.rootPublicKey]);
}
function mediaSlot(route: AgentNetSharingRoute, memberId = route.memberId): string {
  const bytes = createHash('sha256').update(JSON.stringify(['cindy-agent-net/sharing-media-slot/2',
    route.rootPublicKey, route.networkId, route.kind, route.resourceId,
    route.kind === 'provider-share' ? memberId ?? null : null])).digest('hex').slice(0, 32);
  return [bytes.slice(0, 8), bytes.slice(8, 12), bytes.slice(12, 16), bytes.slice(16, 20), bytes.slice(20)].join('-');
}
/** Media keys only select a locally pinned origin, never a URL supplied by a
 * remote attachment. Guest lease IDs are included in the encrypted reference. */
export function agentNetSharingMediaTarget(peer: string) {
  const task = parseSharedTaskPeer(peer), provider = parseProviderSharePeer(peer);
  if (!task && !provider) return null;
  const route = agentNetSharingRoute(task ? 'shared-task' : 'provider-share', task?.sharedTaskId ?? provider!.shareId);
  if (!route) return null;
  if (route.retired) throw new Error('AGENT_NET_SHARING_RETIRED');
  const state = owner(), live = state.sockets.get(connectionKey(route));
  const api = live?.api ?? hostClient(route), target = live?.socket.scopedPeerTarget(peer) ?? (!route.memberId ? currentAgentNetScopedTarget(peer) : null);
  if (!api || !target || target.delegation.resourceId !== route.resourceId || target.delegation.networkId !== route.networkId
    || !verifyDelegation(route.rootPublicKey, target.delegation)) throw new Error('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
  const slot = mediaSlot(route, target.delegation.scope!.memberId);
  return { api, recipient: target.relayId, transportKey: target.transportKey, slot, grantId: target.delegation.id, binding: agentNetMediaBinding(slot) };
}
export function agentNetSharingMediaClient(slot: string, networkId: string, caller?: string, sharedTaskId?: string): AgentNetClient | null {
  const task = parseSharedTaskPeer(caller), provider = parseProviderSharePeer(caller);
  const state = owner(), route = state.vault.routes.find(r => mediaSlot(r, provider?.role === 'guest' ? provider.memberId : r.memberId) === slot && r.networkId === networkId);
  if (!route) return null;
  if (route.retired) throw new Error('AGENT_NET_SHARING_RETIRED');
  if (sharedTaskId && (route.kind !== 'shared-task' || route.resourceId !== sharedTaskId)) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  if (task && (route.kind !== 'shared-task' || route.resourceId !== task.sharedTaskId)
    || provider && (route.kind !== 'provider-share' || route.resourceId !== provider.shareId)) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  return state.sockets.get(connectionKey(route))?.api ?? hostClient(route);
}
export function selectedAgentNetSharingRoute(kind: Kind): AgentNetSharingRoute | null {
  if (!isAgentNetActive()) return null;
  const api = currentAgentNetClient(); if (!api) return null;
  let server = api.base;
  const relay = activeSelfHostedRelay();
  if (relay?.relayId && api.certificate.networkId === 'private:' + relay.relayId) {
    const config = readRelayConfig();
    if (config.active?.origin === 'host') {
      const address = hostJoinBaseUrl(config); if (!address) throw new Error('AGENT_NET_PUBLIC_SHARING_URL_REQUIRED');
      server = address.replace(/\/+$/, '');
      // The owner may upgrade its own published origin from an old loopback
      // receipt. The full pinned member credential still uses the local API.
      const state = owner(), ownRoot = (r: AgentNetSharingRoute) => !r.memberId && r.networkId === api.certificate.networkId && r.rootPublicKey === api.rootPublicKey;
      if (state.vault.routes.some(r => ownRoot(r) && r.server !== server) || state.vault.services?.some(r => ownRoot(r) && r.server !== server)) {
        save(state, { ...state.vault, routes: state.vault.routes.map(r => ownRoot(r) ? { ...r, server } : r),
          services: state.vault.services?.map(r => ownRoot(r) ? { ...r, server } : r) });
      }
    }
  }
  return { v: 2, kind, resourceId: 'pending-resource', server, networkId: api.certificate.networkId,
    rootPublicKey: api.rootPublicKey, hostDeviceId: api.identity.deviceId,
    region: getActiveAuthRealm() };
}
export function rememberAgentNetSharingHost(kind: Kind, resourceId: string, selected: AgentNetSharingRoute): void {
  remember(owner(), { ...selected, kind, resourceId, guest: undefined });
}
export function rememberAgentNetSharingAliases(route: AgentNetSharingRoute, aliases: NonNullable<AgentNetSharingRoute['aliases']>): void {
  remember(owner(), { ...route, aliases: { ...route.aliases, ...aliases } });
}
export function agentNetSharingAlias(kind: Kind, category: 'members' | 'requests' | 'invitations', id: string): AgentNetSharingRoute | null {
  return owner().vault.routes.find(route => route.kind === kind && route.aliases?.[category]?.includes(id)) ?? null;
}
export function rememberAgentNetSharingGuest(route: AgentNetSharingRoute, memberId?: string): AgentNetSharingRoute {
  const state = owner(), old = state.vault.routes.find(r => r.kind === route.kind && r.resourceId === route.resourceId);
  return remember(state, { ...old, ...route, guest: true, retired: memberId ? false : old?.retired,
    ...(memberId ? { memberId, seed: old?.memberId === memberId && !old.retired ? old.seed : randomBytes(32).toString('base64url') }
      : old?.memberId ? { memberId: old.memberId, seed: old.seed } : {}) }, !!memberId);
}
/** Keep a closed pin so old task records cannot fall back to the official route. */
export function retireAgentNetSharingGuest(kind: Kind, resourceId: string): void {
  const route = agentNetSharingRoute(kind, resourceId);
  if (route?.memberId && !route.retired) remember(owner(), { ...route, retired: true });
}
/** Save the origin before a mutation: an uncertain create still needs cleanup
 * there after a relay switch or a cold restart, even without its committed ID. */
export function rememberAgentNetSharingService(selected: AgentNetSharingRoute): void {
  const state = owner();
  if (!routeValid(selected) || selected.memberId) throw new Error('INVALID_AGENT_NET_SHARING_SERVICE');
  const services = state.vault.services ?? [];
  if (services.some(r => r.server === selected.server && r.networkId === selected.networkId && r.rootPublicKey === selected.rootPublicKey)) return;
  if (services.length >= 1024) throw new Error('AGENT_NET_SHARING_SERVICE_LIMIT');
  save(state, { ...state.vault, services: [...services, selected] });
}
async function syncOrigins(state: Session): Promise<void> {
  state.guard(); if (state.originSync) return state.originSync;
  const api = currentAgentNetClient(); if (!api || api.delegation) return;
  const origins = new Map<string, { server: string; networkId: string; rootPublicKey: string; region: 'cn' | 'global' }>();
  for (const route of [...state.vault.routes, ...(state.vault.services ?? [])]) {
    const origin = { server: route.server, networkId: route.networkId, rootPublicKey: route.rootPublicKey, region: route.region };
    origins.set(JSON.stringify(origin), origin);
  }
  const digest = JSON.stringify([api.base, api.certificate.signature, [...origins.values()]]);
  if (state.originDigest === digest && Date.now() - (state.originSyncedAt ?? 0) < 5 * 60_000) return;
  const work = (async () => {
    const found = await syncAgentNetSharingOrigins({ client: api, signer: signer(api.identity), origins: [...origins.values()],
      assertCurrent: state.guard, verifyCertificate, verifySignature }); state.guard();
    let services = state.vault.services ?? [];
    for (const origin of found) if (!services.some(r => r.server === origin.server && r.networkId === origin.networkId && r.rootPublicKey === origin.rootPublicKey))
      services = [...services, { ...origin, v: 2, kind: 'shared-task', resourceId: 'origin-discovery', hostDeviceId: 'origin-discovery' }];
    if (services.length > 1024) throw new Error('AGENT_NET_SHARING_SERVICE_LIMIT');
    if (services !== state.vault.services && services.length) save(state, { ...state.vault, services });
    state.originDigest = digest; state.originSyncedAt = Date.now();
  })().catch(() => { /* Previously pinned resources remain usable during own-relay outages. */ });
  state.originSync = work; try { await work; } finally { if (state.originSync === work) state.originSync = undefined; }
}
export function requestAgentNetSharing(route: AgentNetSharingRoute, path: string, options: SharingRequestOptions): Promise<unknown> {
  const state = owner(), api = business(state, route);
  if (options.observeResponse && options.method === 'POST' && path === '/api/device-link/shared-tasks') {
    const member = hostClient(route), observe = options.observeResponse;
    return api.request(path, { ...options, observeResponse(value) {
      const id = (value as { sharedTaskId?: unknown })?.sharedTaskId;
      if (member && typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
        state.committed.set(id, { route: { ...route, resourceId: id }, member });
      observe(value);
    } });
  }
  return api.request(path, options);
}
export async function grantAgentNetProviderExecutor(input: SharingExecutorInput) {
  const route = agentNetSharingRoute('provider-share', input.shareId); if (!route) return null;
  const state = owner(), client = hostClient(route);
  if (!client || route.hostDeviceId !== getDeviceId() || !readDeviceLinkSettings().agentNetEnabled) throw new Error('AGENT_NET_SHARING_HOST_UNAVAILABLE');
  return grantAgentNetSharingExecutor({ client, sharing: business(state, route), assertCurrent: state.guard }, input);
}
export async function revokeAgentNetProviderExecutor(input: SharingExecutorInput & { generation: string }): Promise<boolean> {
  const route = agentNetSharingRoute('provider-share', input.shareId); if (!route) return false;
  const state = owner(), client = hostClient(route);
  if (!client || route.hostDeviceId !== getDeviceId()) throw new Error('AGENT_NET_SHARING_HOST_UNAVAILABLE');
  await revokeAgentNetSharingExecutor({ client, sharing: business(state, route), assertCurrent: state.guard }, input); return true;
}
export async function checkAgentNetProviderExecutor(input: SharingExecutorInput, signal?: AbortSignal) {
  if (!readDeviceLinkSettings().agentNetEnabled && !session?.vault.routes.some(r => r.kind === 'provider-share' && r.resourceId === input.shareId)) return null;
  const state = owner(), pinned = state.vault.routes.find(r => r.kind === 'provider-share' && r.resourceId === input.shareId);
  if (pinned && !readDeviceLinkSettings().agentNetEnabled) return { active: false as const };
  const selected = selectedAgentNetSharingRoute('provider-share');
  const candidates = pinned ? [pinned] : [...(selected ? [selected] : []), ...state.vault.routes,
    ...(state.vault.services ?? [])].map(r => ({ ...r, kind: 'provider-share' as const, memberId: undefined, seed: undefined }));
  const roots = new Map(candidates.map(r => [JSON.stringify([r.server, r.networkId, r.rootPublicKey]), r]));
  let failure: unknown;
  for (const route of roots.values()) {
    const client = hostClient(route); if (!client) continue;
    try {
      const result = await checkAgentNetSharingExecutor({ client, sharing: business(state, route), assertCurrent: state.guard }, input, signal);
      if (result.active) rememberAgentNetSharingHost('provider-share', input.shareId, { ...route, hostDeviceId: result.ownerDeviceId });
      return result;
    } catch (error) { state.guard(); if (signal?.aborted) throw error;
      if (pinned) throw error;
      if ((error as { status?: number }).status !== 404) failure = error;
    }
  }
  if (failure && !agentNetAllowsLegacy()) throw failure;
  return null;
}
/** Close-only cleanup for an outgoing account. Credentials, endpoints and pins
 * are captured before the boundary; nothing refreshes into the next account.
 *
 * Runs inside account teardown, after the app-session boundary is already
 * pending. `owner()` and the ordinary network accessors refuse that window by
 * design, so this reads the outgoing owner's live session (its scope key cannot
 * have advanced yet — the owner commit happens after teardown) or, failing that,
 * its vault without publishing a session, and resolves each hosted route's
 * authority synchronously here. Never throw: a throw aborted every account
 * switch after its services were already torn down. */
export function captureAgentNetSharingBoundaryClose(token: string, authBase: string) {
  const live = session?.key === activeOwnerScopeKey() ? session : null;
  let vault = live?.vault ?? null;
  if (!vault && getCurrentUserId()) { try { vault = readVault(true).vault; } catch { /* Unreadable vault: legacy close and journal retry still apply. */ } }
  if (!vault) return () => null;
  const committed = live?.committed ?? new Map<string, { route: AgentNetSharingRoute; member: AgentNetClient }>();
  const routes = vault.routes.filter(r => r.kind === 'shared-task' && !r.memberId);
  const identity = identityFromSeed('cindy-agent-net/sharing-business/2', vault.seed, getDeviceId());
  // Resolve each hosted route's authority now, while the outgoing owner is still
  // current; a null capture must not mask a committed create's own member client.
  const captured = new Map(routes.map(route => [route.resourceId, { route, member: hostClient(route, true) }]));
  return (resourceId: string): Promise<unknown> | null => {
    const hosted = captured.get(resourceId);
    const value = hosted?.member ? hosted : committed.get(resourceId); if (!value?.member) return null;
    const { route, member } = value, expires = Date.now() + 3000;
    const guard = () => { if (Date.now() >= expires) throw new Error('AGENT_NET_CLEANUP_EXPIRED'); };
    const client = new AgentNetSharingClient({ base: member.base, networkId: route.networkId, rootPublicKey: route.rootPublicKey,
      signer: signer(identity), hash, assertCurrent: guard, fetch: outboundFetch, ownerPinnedHttp: true,
      memberAuthorization: (method, path, body) => member.header(method, path, body),
      getIdentityCard: nonce => serverApiFetch<{ card: string; expiresAt: string }>('/api/me/identity-card', {
        method: 'POST', body: { audience: 'cindy-agent-net-sharing', purpose: 'network-session', nonce },
        token, baseUrl: authBase, skipAutoRefresh: true, skipSessionInvalidation: true,
        timeoutMs: 3000, cache: 'no-store', logLabel: '/api/me/identity-card', redactErrorDetails: true,
      }),
    });
    return client.request('/api/device-link/shared-tasks/' + encodeURIComponent(resourceId) + '/close', {
      method: 'POST', body: {}, signal: AbortSignal.timeout(3000),
    }).finally(() => client.close());
  };
}
export function agentNetSharingInvitation(kind: Kind, resourceId: string, invitation: string,
  app: 'cindy' | 'cindycn' | 'cindydev'): string | null {
  const route = agentNetSharingRoute(kind, resourceId); if (!route) return null;
  return buildAgentNetSharingInvitation(publicReceipt(route, invitation), route.server, app);
}
export function agentNetSharingInvitationRoute(input: string, kind: Kind): { route: AgentNetSharingRoute; invitation: string } | null {
  const parsed = parseAgentNetSharingInvitation(input, kind); if (!parsed) return null;
  const { invitation, ...receipt } = parsed.receipt, route: AgentNetSharingRoute = { ...receipt, server: parsed.server, guest: true };
  const pinned = agentNetSharingRoute(kind, route.resourceId);
  if (pinned && (pinned.server !== route.server || pinned.networkId !== route.networkId || pinned.rootPublicKey !== route.rootPublicKey
    || pinned.hostDeviceId !== route.hostDeviceId || pinned.region !== route.region)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
  return { route, invitation };
}
/** Each origin is its own authority. A failed origin retains its last display
 * rows, but is explicitly unavailable for permission/freshness decisions. */
export async function listAgentNetProviderShares(received: boolean, legacy: () => Promise<unknown>): Promise<unknown | null> {
  const state = owner(), selected = selectedAgentNetSharingRoute('provider-share');
  await syncOrigins(state);
  const known = state.vault.routes.filter(r => r.kind === 'provider-share');
  const origins = new Map<string, AgentNetSharingRoute>();
  const originKey = (r: AgentNetSharingRoute) => JSON.stringify([r.server, r.networkId, r.rootPublicKey]);
  for (const route of [...(selected ? [selected] : []), ...known, ...(state.vault.services ?? []).map(r => ({ ...r, kind: 'provider-share' as const }))]) {
    if (received || !route.memberId && hostClient(route)) origins.set(originKey(route), route);
  }
  if (!selected && known.length === 0 && origins.size === 0) return null;
  const path = '/api/device-link/provider-shares' + (received ? '/received' : '');
  const sources = [...origins.values()].map(route => ({ route, key: path + originKey(route),
    work: (signal: AbortSignal) => business(state, route).request(path, { method: 'GET', signal }) }));
  if (agentNetAllowsLegacy()) sources.push({ route: undefined as unknown as AgentNetSharingRoute, key: path + ':legacy', work: () => legacy() });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
  const values: PromiseSettledResult<unknown>[] = new Array(sources.length); let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      for (;;) {
        const i = cursor++; if (i >= sources.length) break;
        try { state.guard(); if (controller.signal.aborted) throw new Error('AGENT_NET_DIRECTORY_DEADLINE');
          const value = await sources[i].work(controller.signal), rows = (value as { shares?: unknown })?.shares;
          if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('INVALID_AGENT_NET_PROVIDER_LIST');
          values[i] = { status: 'fulfilled', value: rows }; }
        catch (reason) { values[i] = { status: 'rejected', reason }; }
      }
    }));
  } finally { clearTimeout(timer); controller.abort(); }
  state.guard();
  if (values.length === 0 || values.every(v => v.status === 'rejected')) throw new Error('AGENT_NET_SHARING_SERVICES_UNAVAILABLE');
  const rows = new Map<string, unknown>(), unavailable = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i], result = values[i];
    const items = result.status === 'fulfilled' ? result.value as unknown[] : state.lists.get(source.key) ?? [];
    if (result.status === 'fulfilled') state.lists.set(source.key, items);
    else if (source.route) for (const route of known.filter(r => originKey(r) === originKey(source.route))) unavailable.add(route.resourceId);
    for (const item of items) {
      const row = item as { shareId: string; hostDeviceId: string; memberId?: string; status?: string; members?: { memberId: string }[]; requests?: { requestId: string; linkId?: string }[] };
      if (!row || typeof row.shareId !== 'string' || rows.has(row.shareId)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
      rows.set(row.shareId, item);
      if (result.status === 'rejected') { unavailable.add(row.shareId); continue; }
      if (!source.route) continue;
      let route = known.find(r => r.resourceId === row.shareId);
      if (!received && row.hostDeviceId === getDeviceId()) {
        rememberAgentNetSharingHost('provider-share', row.shareId, resourceRoute(source.route, 'provider-share', row.shareId, row.hostDeviceId));
        route = agentNetSharingRoute('provider-share', row.shareId)!;
      } else if (received && row.memberId) {
        route = rememberAgentNetSharingGuest(resourceRoute(source.route, 'provider-share', row.shareId, row.hostDeviceId), row.memberId);
      }
      if (route) rememberAgentNetSharingAliases(route, { members: row.memberId ? [row.memberId] : row.members?.map(m => m.memberId) ?? [],
        requests: row.requests?.map(r => r.requestId) ?? route.aliases?.requests ?? [],
        invitations: [...new Set([...(route.aliases?.invitations ?? []), ...(row.requests?.flatMap(r => r.linkId ? [r.linkId] : []) ?? [])])] });
      if (received && row.memberId && row.status === 'active') reviveMemberConnection(state, agentNetSharingRoute('provider-share', row.shareId)!);
    }
    if (received && source.route && result.status === 'fulfilled') {
      const ids = new Set(items.map(r => (r as { shareId: string }).shareId));
      for (const route of known) if (route.memberId && originKey(route) === originKey(source.route) && !ids.has(route.resourceId)) retireAgentNetSharingGuest('provider-share', route.resourceId);
    }
  }
  return { shares: [...rows.values()], unavailableShareIds: [...unavailable],
    ...(values.some(v => v.status === 'rejected') ? { authorityIncomplete: true } : {}) };
}
export async function joinAgentNetSharedTask(input: string, displayName: string): Promise<Awaited<ReturnType<SharedTaskApi['join']>> | null> {
  const parsed = parseAgentNetSharingInvitation(input, 'shared-task'); if (!parsed) return null;
  const state = owner(), { invitation, ...receipt } = parsed.receipt;
  const route: AgentNetSharingRoute = { ...receipt, server: parsed.server, guest: true };
  const pinned = state.vault.routes.find(r => r.kind === route.kind && r.resourceId === route.resourceId);
  if (pinned && (pinned.server !== route.server || pinned.networkId !== route.networkId || pinned.rootPublicKey !== route.rootPublicKey
    || pinned.hostDeviceId !== route.hostDeviceId || pinned.region !== route.region)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
  const value = await business(state, route).request<Awaited<ReturnType<SharedTaskApi['join']>>>(
    '/api/device-link/shared-tasks/join', { method: 'POST', body: { invitation, displayName } });
  state.guard();
  if (value.sharedTaskId !== route.resourceId || value.status !== 'joined' || typeof value.created !== 'boolean'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.memberId)) throw new Error('INVALID_AGENT_NET_SHARING_ADMISSION');
  const old = state.vault.routes.find(r => r.kind === route.kind && r.resourceId === route.resourceId);
  remember(state, { ...route, retired: false, memberId: value.memberId, seed: old?.memberId === value.memberId && !old.retired ? old.seed : randomBytes(32).toString('base64url') }, true);
  return value;
}
/** Merge independent authority lists without interpreting a failed service as
 * deletion. The Host still fetches/validates each available resource's snapshot. */
export async function listAgentNetSharedTasks(legacy: () => Promise<unknown>): Promise<unknown | null> {
  const selected = selectedAgentNetSharingRoute('shared-task');
  const state = owner(); await syncOrigins(state);
  const known = state.vault.routes.filter(r => r.kind === 'shared-task');
  if (!selected && known.length === 0 && !state.vault.services?.length) return null;
  const services = new Map<string, AgentNetSharingRoute>();
  for (const route of [...(selected ? [selected] : []), ...known, ...(state.vault.services ?? []).map(r => ({ ...r, kind: 'shared-task' as const }))]) services.set(JSON.stringify([route.server, route.networkId, route.rootPublicKey]), route);
  const db = getCurrentDbClientSnapshot();
  const journal = db ? await createSharedTaskJournal(db.client).latest() : [];
  state.guard();
  const oldIds = journal.filter(item => !known.some(r => r.resourceId === item.sharedTaskId)).map(item => item.sharedTaskId);
  const sources: Array<{ route?: AgentNetSharingRoute; ids: string[]; work(signal: AbortSignal): Promise<unknown> }> = [...services.values()].map(route => ({
    route, ids: known.filter(r => r.server === route.server && r.networkId === route.networkId && r.rootPublicKey === route.rootPublicKey).map(r => r.resourceId),
    work: signal => business(state, route).request('/api/device-link/shared-tasks', { method: 'GET', signal }),
  }));
  if (agentNetAllowsLegacy()) sources.push({ ids: oldIds, work: () => legacy() });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
  const values: PromiseSettledResult<unknown>[] = new Array(sources.length); let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      for (;;) {
        const i = cursor++; if (i >= sources.length) break;
        try { state.guard(); if (controller.signal.aborted) throw new Error('AGENT_NET_DIRECTORY_DEADLINE');
          values[i] = { status: 'fulfilled', value: await sources[i].work(controller.signal) }; }
        catch (reason) { values[i] = { status: 'rejected', reason }; }
      }
    }));
  } finally { clearTimeout(timer); controller.abort(); }
  state.guard();
  if (values.every(value => value.status === 'rejected')) throw new Error('AGENT_NET_SHARING_SERVICES_UNAVAILABLE');
  const items = new Map<string, unknown>(), unavailable = new Set(agentNetAllowsLegacy() ? [] : oldIds);
  for (let i = 0; i < values.length; i++) {
    const value = values[i], source = sources[i];
    if (value.status === 'rejected') { for (const id of source.ids) unavailable.add(id); continue; }
    const rows = (value.value as { sharedTasks?: unknown })?.sharedTasks;
    if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('INVALID_AGENT_NET_SHARED_TASK_LIST');
    for (const item of rows) {
      const row = item as { sharedTaskId?: unknown; hostDeviceId?: unknown; ownerAccountId?: unknown };
      if (typeof row.sharedTaskId !== 'string' || items.has(row.sharedTaskId)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
      items.set(row.sharedTaskId, item);
      const subject = source.route ? agentNetSharingSubject(getCurrentUserId()!, getActiveAuthRealm(), source.route.region) : getCurrentUserId();
      if (source.route && row.ownerAccountId === subject && row.hostDeviceId === getDeviceId())
        remember(state, resourceRoute(source.route, 'shared-task', row.sharedTaskId, row.hostDeviceId));
      else if (source.route && row.ownerAccountId !== subject && typeof row.hostDeviceId === 'string' && !known.some(r => r.resourceId === row.sharedTaskId && !r.retired)) {
        const route = resourceRoute(source.route, 'shared-task', row.sharedTaskId, row.hostDeviceId);
        rememberAgentNetSharingGuest(route);
        try {
          const detail = await business(state, route).request<{ status: string; guests: { accountId: string; memberId: string }[] }>(
            '/api/device-link/shared-tasks/' + encodeURIComponent(row.sharedTaskId), { method: 'GET', signal: AbortSignal.timeout(3000) });
          const subject = agentNetSharingSubject(getCurrentUserId()!, getActiveAuthRealm(), route.region);
          const member = detail.status === 'active' && detail.guests?.find(g => g.accountId === subject);
          if (member && typeof member.memberId === 'string') rememberAgentNetSharingGuest(route, member.memberId);
        } catch { unavailable.add(row.sharedTaskId); }
      }
    }
  }
  return { sharedTasks: [...items.values()], unavailableSharedTaskIds: [...unavailable],
    ...(values.some(value => value.status === 'rejected') ? { authorityIncomplete: true } : {}) };
}
function installRoute(state: Session, route: AgentNetSharingRoute): void {
  const target = binding;
  if (!target || target.session !== state || target.pins.has(keyOf(route.kind, route.resourceId))) return;
  state.guard();
  const active = currentAgentNetClient(), member = hostClient(route);
  if (route.retired || !route.memberId && !member) {
    target.pins.set(keyOf(route.kind, route.resourceId), target.client.registerScopedConnection(route, 'blocked'));
    return; // Pending/unavailable credentials cannot fall through to V1.
  }
  const primary = !!member && active?.rootPublicKey === member.rootPublicKey
    && active.certificate.networkId === member.certificate.networkId;
  let connection: DeviceLinkClient | 'primary' = 'primary';
  if (!primary) {
    const key = connectionKey(route);
    let scoped = state.connections.get(key);
    if (!scoped) {
      const guard = () => { state.guard();
        const pin = state.vault.routes.find(r => r.kind === route.kind && r.resourceId === route.resourceId);
        // A guest admission was joined explicitly over V2 and has no V1 path to fall back to, so
        // the 「新版连接」toggle (this device's own network) does not gate it; own routes still do.
        if (binding !== target || !route.memberId && !readDeviceLinkSettings().agentNetEnabled
          || route.memberId && (!pin || pin.retired || pin.seed !== route.seed || pin.memberId !== route.memberId))
          throw new Error('AGENT_NET_OWNER_CHANGED'); };
      let lease: AgentNetSharingTransport | null = null;
      let identity: Identity | null = null;
      if (route.memberId && route.seed) {
        identity = identityFromSeed(JSON.stringify(['cindy-agent-net/sharing-transport/2', route.rootPublicKey, route.kind, route.resourceId]), route.seed, getDeviceId());
        lease = new AgentNetSharingTransport({ client: business(state, route), applicant: signer(identity), assertCurrent: guard,
          verifyCertificate, verifyDelegation, scope: { ...route, memberId: route.memberId,
            guestSubject: agentNetSharingSubject(getCurrentUserId()!, getActiveAuthRealm(), route.region) } });
        state.leases.add(lease);
      }
      scoped = new DeviceLinkClient({ ...target.options, scopedPeersOnly: true, frameAuth: undefined, directRuntime: undefined,
        getWsUrl: () => route.server.replace(/^http/, 'ws') + '/api/agent-net' + (lease ? '/guest' : '') + '/ws',
        transportAllowed: () => { try { guard(); return true; } catch { return false; } },
        getToken: async () => { guard(); return 'agent-net-scoped-node'; },
        createWebSocket: async () => {
          guard();
          let api = member;
          if (lease && identity) {
            const delegation = await lease.acquire(); guard();
            api = new AgentNetClient(route.server, identity, delegation.issuerCertificate, route.rootPublicKey, delegation, { fetch: outboundFetch,
              createWebSocket: async (url, options) => new WebSocket(url, { ...options, agent: await createOutboundHttpAgent(url) }) });
          }
          if (!api) throw new Error('AGENT_NET_SHARING_HOST_UNAVAILABLE');
          const socket = await openScopedAgentNetAppSocket(api, guard); guard();
          const live = { api, socket }; state.sockets.set(key, live);
          let renewal: ReturnType<typeof setTimeout> | undefined, ended = false;
          const schedule = (retry = false) => {
            if (ended || !lease || !identity || !live.api.delegation) return;
            renewal = setTimeout(() => { void renew(); }, retry ? 5000 : Math.max(1000, live.api.delegation.expiresAt - Date.now() - 60_000)); renewal.unref();
          };
          const renew = async () => {
            try {
              guard(); if (ended || state.sockets.get(key) !== live || !lease || !identity) return;
              const delegation = await lease.acquire(); guard(); if (ended || state.sockets.get(key) !== live) return;
              const next = new AgentNetClient(route.server, identity, delegation.issuerCertificate, route.rootPublicKey, delegation, live.api.transport);
              await socket.replaceClient(next); guard(); live.api = next; schedule();
            } catch { if (!ended && state.sockets.get(key) === live) schedule(true); }
          };
          schedule(); socket.once('close', () => { ended = true; if (renewal) clearTimeout(renewal); });
          return socket;
        } });
      if (lease) leaseOf.set(scoped, lease);
      state.connections.set(key, scoped);
    }
    connection = scoped;
  }
  target.pins.set(keyOf(route.kind, route.resourceId), target.client.registerScopedConnection(route, connection));
}
export function bindAgentNetSharing(client: RoutedDeviceLinkClient, options: ScopedConnectionOptions): () => void {
  const selection = agentNetSelectionKey();
  if (binding?.client === client && binding.session.key === activeOwnerScopeKey() && binding.selection === selection) return binding.stop;
  binding?.stop();
  const state = owner();
  const unprefer = client.preferPrimaryScopedConnection(isAgentNetActive);
  const target: NonNullable<typeof binding> = { client, options, session: state, selection, pins: new Map(), stop() {
    if (binding !== target) return;
    binding = null; unprefer(); for (const off of target.pins.values()) off();
    retire(state); if (session === state) session = null;
  } };
  binding = target;
  for (const route of state.vault.routes) installRoute(state, route);
  return target.stop;
}
export function stopAgentNetSharing(): void {
  binding?.stop();
  if (session) retire(session);
  session = null;
}
