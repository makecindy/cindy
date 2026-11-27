import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { DeviceLinkClient, parseSharedTaskPeer, type DeviceLinkClientOptions, type RoutedDeviceLinkClient, type SharedTaskApi } from '@cindy/device-link';
import { AgentNetSharingClient, AgentNetSharingTransport, AgentNetSocket, NativeTransport, PortableAgentNetClient,
  encodeAgentNetSharingInvitation, parseAgentNetSharingInvitation, syncAgentNetSharingOrigins, toBase64Url, utf8,
  type AgentNetSharingInvitation, type BinarySocket, type SessionConfig, type SessionHandle, type SharingRequestOptions } from '@cindy/agent-net/portable';
import { agentNetMediaBinding, agentNetSharingSubject, sharingOriginValid, type SharingOrigin, type Delegation } from '@cindy/agent-net-protocol';
import type { ApiFetchOptions } from '@/api/client';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { AUTH_API_BASE_URL, getActiveMobileSessionRealm } from '@/config/env';
import { currentMobileAgentNetIdentity } from './agentNetIdentity';
import { MobileAgentNetEngine, type NativeAgentNetOptions } from './agentNetNative';
import { getMobileAgentNetPreferences, mobileAgentNetAllowsLegacy, subscribeMobileAgentNetPreferences } from './agentNetPreferences';
import { verifyMobileAgentNetCertificate, verifyMobileAgentNetDelegation, verifyMobileAgentNetSignature } from './agentNetProtocol';

export interface MobileSharingContext {
  deviceId: string;
  apiFetch<T>(path: string, options: Omit<ApiFetchOptions, 'token'>): Promise<T>;
}
interface Route extends Omit<AgentNetSharingInvitation, 'invitation'> { server: string; memberId: string; seedId: string; retired?: boolean; }
type RouteVersion = Route['v'];
interface SharingRoutes { routes: Route[]; origins?: SharingOrigin[]; }
interface Book extends SharingRoutes { version: RouteVersion; }
type SharingSource = SharingOrigin & { v?: RouteVersion; privateMember?: true };
interface OwnedPrivateTask { origin: SharingSource; subject: string; hostDeviceId: string; }
interface Live {
  api: PortableAgentNetClient; native: NativeAgentNetOptions; signer: MobileAgentNetEngine;
  lease: AgentNetSharingTransport; socket?: AgentNetSocket;
}
interface State {
  key: string; context: MobileSharingContext; book: SharingRoutes; storage: Record<RouteVersion, string>; seed: string; guard(): void;
  business: Map<string, { api: AgentNetSharingClient; signer: MobileAgentNetEngine }>;
  ownedPrivateTasks: Map<string, OwnedPrivateTask>;
  live: Map<string, Live>; pins: Map<string, () => void>; connections: Map<string, DeviceLinkClient>;
  binding?: { client: RoutedDeviceLinkClient; options: Omit<DeviceLinkClientOptions, 'getWsUrl' | 'getToken'> };
  writes: Promise<void>;
  livePending: Map<string, Promise<Live>>;
  originSync?: Promise<void>; originDigest?: string; originSyncedAt?: number;
}
let pending: { key: string; value: Promise<State> } | null = null;
let current: State | null = null;
let lifecycle = 0;
let privateSharingRelay: { base: string; root: string } | null = null;
const hash = (text: string) => bytesToHex(sha256(utf8(text)));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const routeKey = (r: Pick<Route, 'kind' | 'resourceId'>) => r.kind + ':' + r.resourceId;
const originKey = (r: Pick<Route, 'server' | 'networkId' | 'rootPublicKey'> & { v?: 2 | 3 }) => JSON.stringify([r.v ?? 2, r.server, r.networkId, r.rootPublicKey]);
export function setMobileAgentNetPrivateSharingSupport(base: string, root: string, supported: boolean): void {
  privateSharingRelay = supported ? { base, root } : null;
}
export function isMobileAgentNetPrivateOwnedTask(sharedTaskId: string): boolean {
  try { current?.guard(); return current?.ownedPrivateTasks.has(sharedTaskId) ?? false; }
  catch { return false; }
}
export function mobileAgentNetSharingEnabled(): boolean {
  const p = getMobileAgentNetPreferences(); return p.ready && p.enabled && MobileAgentNetEngine.available();
}
/** Sessions on each shared task's own connection; one-way, this phone only calls (agentNetRuntime.useMobileAgentNetSessions). */
let sharingSessions: SessionConfig | null = null;
export function useMobileAgentNetSharingSessions(config: SessionConfig | null): void {
  sharingSessions = config;
  if (config) for (const live of current?.live.values() ?? []) live.socket?.useSessions(config);
}
/** The connection of the shared task this scoped peer names, once it is open. Only that registered connection carries its session. */
function sharingSocket(peer: string): AgentNetSocket | null {
  const task = parseSharedTaskPeer(peer), state = current;
  if (!task || !state || !mobileAgentNetSharingEnabled()) return null;
  try { state.guard(); } catch { return null; }
  const route = state.book.routes.find(r => r.kind === 'shared-task' && r.resourceId === task.sharedTaskId && !r.retired);
  return route ? state.live.get(routeKey(route))?.socket ?? null : null;
}
export function mobileAgentNetSharingSession(peer: string): SessionHandle | null { return sharingSocket(peer)?.session(peer) ?? null; }
/** This shared task has its own Agent-Net connection open (its session may still be on the way). */
export function mobileAgentNetSharingReachable(peer: string): boolean { return !!sharingSocket(peer); }
export function connectMobileAgentNetSharingSession(peer: string): Promise<boolean> {
  return sharingSocket(peer)?.connectSession(peer) ?? Promise.resolve(false);
}
function valid(route: Route): boolean {
  try {
    encodeAgentNetSharingInvitation({ v: route.v, kind: route.kind, resourceId: route.resourceId, networkId: route.networkId,
      rootPublicKey: route.rootPublicKey, hostDeviceId: route.hostDeviceId, region: route.region, invitation: 'A'.repeat(43) });
    const url = new URL(route.server);
    return (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      && !url.username && !url.password && !url.hash && !url.search && route.server === route.server.replace(/\/+$/, '')
      && id(route.memberId) && /^[A-Za-z0-9_-]{24}$/.test(route.seedId) && (route.retired === undefined || typeof route.retired === 'boolean');
  } catch { return false; }
}
function closeState(state: State): void {
  if (current === state) { current = null; lifecycle++; }
  state.binding = undefined;
  for (const off of state.pins.values()) off();
  for (const connection of state.connections.values()) connection.stop();
  for (const { api, signer } of state.business.values()) { api.close(); void signer.destroy(); }
  for (const live of state.live.values()) { live.lease.close(); live.socket?.close(); void live.signer.destroy(); }
  state.pins.clear(); state.connections.clear(); state.business.clear(); state.live.clear();
}
export function stopMobileAgentNetSharing(): void { lifecycle++; const old = current; current = null; pending = null; if (old) closeState(old); }
subscribeMobileAuthOwner(stopMobileAgentNetSharing);
subscribeMobileAgentNetPreferences(stopMobileAgentNetSharing);
async function stateFor(context: MobileSharingContext): Promise<State> {
  const owner = getMobileAuthOwner(), auth = AUTH_API_BASE_URL;
  const key = JSON.stringify([owner.accountKey, owner.generation, context.deviceId, auth]);
  if (!owner.accountId || !context.deviceId) throw new Error('AGENT_NET_OWNER_CHANGED');
  if (current?.key === key) { current.guard(); return current; }
  if (pending?.key === key) return pending.value;
  if (current) closeState(current); current = null;
  const epoch = lifecycle;
  const guard = () => { if (epoch !== lifecycle || !isMobileAuthOwnerCurrent(owner) || AUTH_API_BASE_URL !== auth) throw new Error('AGENT_NET_OWNER_CHANGED'); };
  const value = (async () => {
    const suffix = hash(JSON.stringify([owner.accountKey, context.deviceId]));
    const storage = { 2: 'cindy.agent-net.sharing.v2.' + suffix, 3: 'cindy.agent-net.sharing.v3.' + suffix };
    const read = async (version: RouteVersion): Promise<Book> => {
      const raw = await AsyncStorage.getItem(storage[version]); guard();
      const saved = (raw ? JSON.parse(raw) : { version, routes: [] }) as Book;
      if (saved?.version !== version || !Array.isArray(saved.routes) || saved.routes.length > 1024
        || saved.routes.some(r => r?.v !== version || !valid(r))
        || saved.origins !== undefined && (version !== 2 || !Array.isArray(saved.origins)
          || saved.origins.length > 1024 || saved.origins.some(o => !sharingOriginValid(o)))) throw new Error('AGENT_NET_SHARING_BOOK_UNREADABLE');
      return saved;
    };
    const [legacy, local] = await Promise.all([read(2), read(3)]);
    const book = { routes: [...legacy.routes, ...local.routes], origins: legacy.origins };
    if (new Set(book.routes.map(routeKey)).size !== book.routes.length) throw new Error('AGENT_NET_SHARING_BOOK_UNREADABLE');
    const identityKey = storage[2] + '.business';
    let seed = await getSecureItem(identityKey); guard();
    if (!seed) { seed = toBase64Url(getRandomBytes(32)); await setSecureItem(identityKey, seed, { thisDeviceOnly: true }); guard(); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(seed)) throw new Error('AGENT_NET_SHARING_SEED_UNREADABLE');
    const state: State = { key, context, book, storage, seed, guard, business: new Map(), ownedPrivateTasks: new Map(),
      live: new Map(), pins: new Map(), connections: new Map(), livePending: new Map(), writes: Promise.resolve() };
    guard(); current = state; return state;
  })();
  pending = { key, value }; try { return await value; } finally { if (pending?.value === value) pending = null; }
}
async function business(state: State, route: Pick<SharingSource, 'server' | 'networkId' | 'rootPublicKey' | 'v' | 'privateMember'>): Promise<AgentNetSharingClient> {
  state.guard();
  const member = currentMobileAgentNetIdentity()?.api;
  const authority = member && !member.delegation && member.base === route.server && member.certificate.networkId === route.networkId
    && member.rootPublicKey === route.rootPublicKey && (route.v !== 3 || route.privateMember) ? member : null;
  if (route.privateMember && !authority) throw new Error('AGENT_NET_SHARING_MEMBER_UNAVAILABLE');
  const key = JSON.stringify([originKey(route), authority?.certificate.signature ?? null]);
  const old = state.business.get(key); if (old) return old.api;
  const signer = await MobileAgentNetEngine.create({ seed: state.seed, context: 'cindy-agent-net/sharing-business/2', deviceId: state.context.deviceId }, state.guard);
  state.guard(); const existing = state.business.get(key); if (existing) { await signer.destroy(); return existing.api; }
  const api = new AgentNetSharingClient({ privateSharing: route.v === 3, base: route.server, networkId: route.networkId,
    rootPublicKey: route.rootPublicKey, signer, hash: sha256, assertCurrent: state.guard,
    ...(authority ? { memberAuthorization: (method: string, path: string, body: string) => authority.header(method, path, body) } : {}),
    getIdentityCard: nonce => state.context.apiFetch<{ card: string; expiresAt: string }>('/api/me/identity-card', {
      method: 'POST', baseUrl: AUTH_API_BASE_URL, body: { audience: 'cindy-agent-net-sharing', purpose: 'network-session', nonce },
      cache: 'no-store', timeoutMs: 12_000, assertCurrent: state.guard,
    }) });
  state.business.set(key, { api, signer }); return api;
}
function checkPin(state: State, route: Pick<Route, 'v' | 'kind' | 'resourceId' | 'server' | 'networkId' | 'rootPublicKey' | 'hostDeviceId' | 'region'>): Route | undefined {
  const old = state.book.routes.find(r => routeKey(r) === routeKey(route));
  if (old && (originKey(old) !== originKey(route) || old.hostDeviceId !== route.hostDeviceId || old.region !== route.region)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
  return old;
}
async function saveBook(state: State, routes: SharingRoutes, version: RouteVersion): Promise<void> {
  // Older clients still read the original book, including after a downgrade.
  const book: Book = { version, routes: routes.routes.filter(r => r.v === version),
    ...(version === 2 && routes.origins ? { origins: routes.origins } : {}) };
  await AsyncStorage.setItem(state.storage[version], JSON.stringify(book)); state.guard(); state.book = routes;
}
async function remember(state: State, route: Route, seed?: string): Promise<void> {
  const work = state.writes.then(async () => {
    state.guard(); if (!valid(route)) throw new Error('INVALID_AGENT_NET_SHARING_ROUTE');
    const old = checkPin(state, route), key = routeKey(route);
    if (!old && state.book.routes.filter(r => r.v === route.v).length >= 1024) throw new Error('AGENT_NET_SHARING_ROUTE_LIMIT');
    if (seed) { await setSecureItem(state.storage[route.v] + '.' + route.seedId, seed, { thisDeviceOnly: true }); state.guard(); }
    await saveBook(state, { ...state.book, routes: [...state.book.routes.filter(r => routeKey(r) !== key), route] }, route.v);
    if (!old || old.memberId !== route.memberId || old.seedId !== route.seedId || old.retired !== route.retired) {
      state.connections.get(key)?.stop(); state.connections.delete(key); state.pins.get(key)?.(); state.pins.delete(key);
      const live = state.live.get(key); live?.lease.close(); live?.socket?.close(); if (live) await live.signer.destroy(); state.live.delete(key);
    }
    install(state, route);
  }); state.writes = work.catch(() => undefined); return work;
}
export async function joinMobileAgentNetSharedTask(input: string, displayName: string, context: MobileSharingContext): Promise<Awaited<ReturnType<SharedTaskApi['join']>> | null> {
  const parsed = parseAgentNetSharingInvitation(input, 'shared-task'); if (!parsed) return null;
  const { invitation, ...receipt } = parsed.receipt, route = { ...receipt, server: parsed.server };
  const member = currentMobileAgentNetIdentity()?.api;
  if (route.v === 3 && member && !member.delegation && member.certificate.networkId === route.networkId && member.rootPublicKey === route.rootPublicKey)
    throw Object.assign(new Error('Use existing same-account device control'), { code: 'SHARED_TASK_SELF_JOIN' });
  const state = await stateFor(context);
  const old = checkPin(state, route), api = await business(state, route);
  const result = await api.request<Awaited<ReturnType<SharedTaskApi['join']>>>('/api/device-link/shared-tasks/join', { method: 'POST', body: { invitation, displayName } });
  state.guard(); if (result.sharedTaskId !== route.resourceId || result.status !== 'joined' || !id(result.memberId) || typeof result.created !== 'boolean') throw new Error('INVALID_AGENT_NET_SHARING_ADMISSION');
  const reuse = old?.memberId === result.memberId && !old.retired;
  await remember(state, { ...route, memberId: result.memberId, seedId: reuse ? old.seedId : toBase64Url(getRandomBytes(18)), retired: false }, reuse ? undefined : toBase64Url(getRandomBytes(32)));
  return result;
}
export async function requestMobileAgentNetSharedTask(path: string, options: SharingRequestOptions, context: MobileSharingContext,
  legacy: () => Promise<unknown>): Promise<unknown | null> {
  const state = await stateFor(context);
  if (path === '/api/device-link/shared-tasks' && options.method === 'GET') {
    await syncOrigins(state);
    const member = currentMobileAgentNetIdentity()?.api;
    const privateMember = mobileAgentNetSharingEnabled() && member && !member.delegation && member.certificate.networkId.startsWith('private:')
      && privateSharingRelay?.base === member.base && privateSharingRelay.root === member.rootPublicKey ? member : null;
    const origins = new Map<string, SharingSource>();
    for (const route of state.book.routes) {
      // Once paired to this exact network, the member directory owns these rows.
      if (route.v === 3 && privateMember && privateMember.certificate.networkId === route.networkId
        && privateMember.rootPublicKey === route.rootPublicKey) continue;
      origins.set(originKey(route), route);
    }
    for (const origin of state.book.origins ?? []) origins.set(originKey(origin), origin);
    if (member) {
      const route: SharingOrigin = { server: member.base, networkId: member.certificate.networkId,
        rootPublicKey: member.rootPublicKey, region: getActiveMobileSessionRealm() === 'cn' ? 'cn' : 'global' };
      origins.set(originKey(route), route);
      if (privateMember) origins.set(originKey({ ...route, v: 3 }), { ...route, v: 3, privateMember: true });
    }
    if (!origins.size) {
      if (!mobileAgentNetAllowsLegacy()) throw new Error('AGENT_NET_SHARING_SERVICES_UNAVAILABLE');
      return null;
    }
    const sources: Array<{ route?: SharingSource; read(signal: AbortSignal): Promise<unknown> }> =
      [...origins.values()].map(route => ({ route, read: async signal => (await business(state, route)).request(path, { ...options, signal }) }));
    if (mobileAgentNetAllowsLegacy()) sources.push({ read: legacy });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
    const results: PromiseSettledResult<unknown>[] = new Array(sources.length); let cursor = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
        for (;;) {
          const i = cursor++; if (i >= sources.length) break;
          try { state.guard(); if (controller.signal.aborted) throw new Error('AGENT_NET_DIRECTORY_DEADLINE');
            results[i] = { status: 'fulfilled', value: await sources[i].read(controller.signal) }; }
          catch (reason) { results[i] = { status: 'rejected', reason }; }
        }
      }));
    } finally { clearTimeout(timer); controller.abort(); }
    state.guard();
    if (results.every(r => r.status === 'rejected')) throw new Error('AGENT_NET_SHARING_SERVICES_UNAVAILABLE');
    const rows = new Map<string, unknown>(), unavailable: string[] = [];
    const ownedPrivateTasks = new Map<string, OwnedPrivateTask>();
    for (let i = 0; i < results.length; i++) {
      const result = results[i], route = sources[i].route;
      if (result.status === 'rejected') {
        if (route) unavailable.push(...state.book.routes.filter(r => originKey(r) === originKey(route)).map(r => r.resourceId));
        continue;
      }
      const items = (result.value as { sharedTasks?: unknown })?.sharedTasks;
      if (!Array.isArray(items) || items.length > 10_000) throw new Error('INVALID_AGENT_NET_SHARED_TASK_LIST');
      const accountId = getMobileAuthOwner().accountId;
      const subject = route?.privateMember ? privateMember?.certificate.subject
        : route?.v === 3 ? 'guest:' + (await business(state, route)).options.signer.identity.signingKey
        : route ? agentNetSharingSubject(accountId, getActiveMobileSessionRealm() === 'cn' ? 'cn' : 'global', route.region) : accountId;
      for (const item of items) {
        const row = item as { sharedTaskId?: unknown; hostDeviceId?: unknown; ownerAccountId?: unknown }, rid = row?.sharedTaskId;
        if (!id(rid) || rows.has(rid)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
        if (route?.privateMember && typeof subject === 'string' && row.ownerAccountId === subject && id(row.hostDeviceId)) {
          ownedPrivateTasks.set(rid, { origin: route, subject, hostDeviceId: row.hostDeviceId });
          rows.set(rid, { ...row, ownerAccountId: accountId });
        } else rows.set(rid, item);
        if (route && !route.privateMember && row.ownerAccountId !== subject && id(row.hostDeviceId)
          && !state.book.routes.some(r => r.resourceId === rid && !r.retired)) {
          try {
            const detail = await (await business(state, route)).request<{ status: string; guests: { accountId: string; memberId: string }[] }>(
              '/api/device-link/shared-tasks/' + encodeURIComponent(rid), { method: 'GET', signal: AbortSignal.timeout(3000) });
            const member = detail.status === 'active' && detail.guests?.find(g => g.accountId === subject);
            if (!member || !id(member.memberId)) throw new Error('AGENT_NET_SHARING_ADMISSION_REQUIRED');
            await remember(state, { ...route, v: route.v ?? 2, kind: 'shared-task', resourceId: rid, hostDeviceId: row.hostDeviceId,
              memberId: member.memberId, seedId: toBase64Url(getRandomBytes(18)) }, toBase64Url(getRandomBytes(32)));
          } catch { unavailable.push(rid); rows.delete(rid); }
        }
      }
    }
    state.guard();
    for (const [resourceId, task] of ownedPrivateTasks) {
      state.ownedPrivateTasks.delete(resourceId);
      state.ownedPrivateTasks.set(resourceId, task);
    }
    // Retain recent pins across incomplete refreshes so a stale click stays on its original authority.
    for (const resourceId of state.ownedPrivateTasks.keys()) {
      if (state.ownedPrivateTasks.size <= 10_000) break;
      state.ownedPrivateTasks.delete(resourceId);
    }
    return { sharedTasks: [...rows.values()], unavailableSharedTaskIds: unavailable, ...(results.some(r => r.status === 'rejected') ? { authorityIncomplete: true } : {}) };
  }
  const match = /^\/api\/device-link\/shared-tasks\/([^/]+)/.exec(path);
  const resourceId = match && decodeURIComponent(match[1]);
  const owned = resourceId && state.ownedPrivateTasks.get(resourceId);
  if (owned) {
    if (options.method !== 'GET') throw new Error('AGENT_NET_SHARING_HOST_REQUIRED');
    const detail = await (await business(state, owned.origin)).request<{ sharedTaskId: string; hostDeviceId: string; ownerAccountId: string }>(path, options);
    state.guard();
    if (detail?.sharedTaskId !== resourceId || detail.hostDeviceId !== owned.hostDeviceId || detail.ownerAccountId !== owned.subject)
      throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
    return { ...detail, ownerAccountId: getMobileAuthOwner().accountId };
  }
  const route = resourceId && state.book.routes.find(r => r.resourceId === resourceId);
  if (!route) { if (!mobileAgentNetAllowsLegacy()) throw new Error('AGENT_NET_SHARING_ROUTE_REQUIRED'); return null; }
  const result = await (await business(state, route)).request(path, options); state.guard();
  if (path.endsWith('/leave')) await remember(state, { ...route, retired: true });
  return result;
}
async function syncOrigins(state: State): Promise<void> {
  state.guard(); if (state.originSync) return state.originSync;
  const identity = currentMobileAgentNetIdentity(); if (!identity || identity.api.delegation) return;
  const origins = new Map<string, SharingOrigin & { v?: 2 | 3 }>();
  for (const r of [...state.book.routes, ...(state.book.origins ?? [])]) {
    if ('v' in r && r.v === 3) continue;
    const o: SharingOrigin = { server: r.server, networkId: r.networkId, rootPublicKey: r.rootPublicKey, region: r.region }; origins.set(JSON.stringify(o), o);
  }
  const digest = JSON.stringify([identity.api.base, identity.api.certificate.signature, [...origins.values()]]);
  if (state.originDigest === digest && Date.now() - (state.originSyncedAt ?? 0) < 5 * 60_000) return;
  const work = (async () => {
    const found = await syncAgentNetSharingOrigins({ client: identity.api, signer: identity.signer, origins: [...origins.values()], assertCurrent: state.guard,
      verifyCertificate: verifyMobileAgentNetCertificate, verifySignature: verifyMobileAgentNetSignature }); state.guard();
    const save = state.writes.then(async () => {
      state.guard();
      const merged = new Map((state.book.origins ?? []).map(o => [JSON.stringify(o), o])); for (const o of found) merged.set(JSON.stringify(o), o);
      if (merged.size > 1024) throw new Error('AGENT_NET_ORIGIN_LIMIT');
      await saveBook(state, { ...state.book, origins: [...merged.values()] }, 2);
    }); state.writes = save.catch(() => undefined); await save;
    state.originDigest = digest; state.originSyncedAt = Date.now();
  })().catch(() => { /* Known roots work independently of the own-account relay. */ });
  state.originSync = work; try { await work; } finally { if (state.originSync === work) state.originSync = undefined; }
}
function binarySocket(url: string, headers: Record<string, string>): BinarySocket {
  const Constructor = globalThis.WebSocket as unknown as new (url: string, protocols?: null, options?: { headers: Record<string, string> }) => BinarySocket;
  return new Constructor(url, null, { headers });
}
function liveFor(state: State, route: Route): Promise<Live> {
  const key = routeKey(route), pending = state.livePending.get(key); if (pending) return pending;
  const work = prepareLive(state, route).finally(() => { if (state.livePending.get(key) === work) state.livePending.delete(key); });
  state.livePending.set(key, work); return work;
}
async function prepareLive(state: State, route: Route): Promise<Live> {
  state.guard(); const key = routeKey(route), saved = state.live.get(key);
  if (saved && (saved.api.delegation?.expiresAt ?? 0) - Date.now() > 60_000) return saved;
  const guard = () => { state.guard(); const pin = state.book.routes.find(r => routeKey(r) === key);
    if (!mobileAgentNetSharingEnabled() || !pin || pin.retired || pin.seedId !== route.seedId) throw new Error('AGENT_NET_SHARING_RETIRED'); };
  if (saved) {
    const delegation = await saved.lease.acquire(); guard(); saved.signer.assertCurrent();
    saved.api = guestApi(route, saved.signer, delegation, guard); return saved;
  }
  guard(); const seed = await getSecureItem(state.storage[route.v] + '.' + route.seedId); guard();
  if (!seed) throw new Error('AGENT_NET_SHARING_SEED_UNAVAILABLE');
  const api = await business(state, route);
  const guestId = 'guest:' + api.options.signer.identity.signingKey;
  const native = { seed, context: JSON.stringify(['cindy-agent-net/sharing-transport/2', route.rootPublicKey, route.kind, route.resourceId]), deviceId: route.v === 3 ? guestId : state.context.deviceId };
  const signer = await MobileAgentNetEngine.create(native, guard);
  const lease = new AgentNetSharingTransport({ client: api, applicant: signer, assertCurrent: guard,
    verifyCertificate: verifyMobileAgentNetCertificate, verifyDelegation: verifyMobileAgentNetDelegation,
    scope: { ...route, guestSubject: route.v === 3 ? guestId : agentNetSharingSubject(getMobileAuthOwner().accountId, getActiveMobileSessionRealm() === 'cn' ? 'cn' : 'global', route.region) } });
  try {
    const delegation = await lease.acquire(); guard();
    const api = guestApi(route, signer, delegation, guard);
    const result = { api, signer, native, lease }; state.live.set(key, result);
    return result;
  } catch (error) { lease.close(); await signer.destroy(); throw error; }
}
function guestApi(route: Route, signer: MobileAgentNetEngine, delegation: Delegation, guard: () => void) {
  return new PortableAgentNetClient(route.server, signer, delegation.issuerCertificate, route.rootPublicKey, {
    delegation, assertCurrent: guard, sha256: bytes => toBase64Url(sha256(bytes)), createWebSocket: binarySocket,
    verifyCertificate: verifyMobileAgentNetCertificate, verifyDelegation: verifyMobileAgentNetDelegation });
}
function install(state: State, route: Route): void {
  if (!state.binding || state.pins.has(routeKey(route))) return;
  const { client, options } = state.binding, key = routeKey(route);
  if (route.retired) { state.pins.set(key, client.registerScopedConnection(route, 'blocked')); return; }
  const scoped = new DeviceLinkClient({ ...options, scopedPeersOnly: true, frameAuth: undefined, directRuntime: undefined,
    transportAllowed: mobileAgentNetSharingEnabled, getWsUrl: () => route.server.replace(/^http/, 'ws') + '/api/agent-net/guest/ws',
    getToken: async () => { state.guard(); return 'agent-net-scoped-native'; },
    createWebSocket: async () => {
      const live = await liveFor(state, route), guard = () => { state.guard(); live.signer.assertCurrent(); };
      const engine = await MobileAgentNetEngine.create({ ...live.native, udp: true, enhancedTransport: true }, guard);
      try {
        const socket = await AgentNetSocket.openWithBindings({ client: live.api, scoped: true, assertCurrent: guard,
          userId: getMobileAuthOwner().accountId, bindings: { verifyCertificate: verifyMobileAgentNetCertificate,
            verifyDelegation: verifyMobileAgentNetDelegation, createTransport: opts => NativeTransport.create(engine, opts) } });
        guard(); live.socket = socket;
        if (sharingSessions) socket.useSessions(sharingSessions);
        let timer: ReturnType<typeof setTimeout> | undefined, ended = false;
        const schedule = (retry = false) => { if (ended) return;
          timer = setTimeout(() => { void renew(); }, retry ? 5000 : Math.max(1000, live.api.delegation!.expiresAt - Date.now() - 60_000)); };
        const renew = async () => {
          try {
            guard(); if (ended || state.live.get(key) !== live) return;
            const delegation = await live.lease.acquire(); guard(); if (ended) return;
            const next = guestApi(route, live.signer, delegation, guard);
            await socket.replaceClient(next); guard(); live.api = next; schedule();
          } catch { if (!ended && state.live.get(key) === live) schedule(true); }
        };
        schedule(); socket.once('close', () => { ended = true; if (timer) clearTimeout(timer); }); return socket;
      } catch (error) { await engine.destroy(); throw error; }
    } });
  state.connections.set(key, scoped); state.pins.set(key, client.registerScopedConnection(route, scoped));
}
export function bindMobileAgentNetSharing(client: RoutedDeviceLinkClient, options: Omit<DeviceLinkClientOptions, 'getWsUrl' | 'getToken'>,
  context: MobileSharingContext): () => void {
  let stopped = false, bound: State | null = null;
  void stateFor(context).then(state => { if (stopped) return; state.guard(); bound = state; state.binding = { client, options };
    for (const route of state.book.routes) install(state, route);
  }).catch(() => undefined);
  return () => { stopped = true; if (bound?.binding?.client === client) closeState(bound); };
}
function mediaSlot(route: Route): string {
  const hex = hash(JSON.stringify(['cindy-agent-net/sharing-media-slot/2', route.rootPublicKey, route.networkId, route.kind, route.resourceId, null])).slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
export function mobileAgentNetSharingMediaTarget(peer: string) {
  const task = parseSharedTaskPeer(peer), state = current;
  if (!task || !state) return null; state.guard();
  const route = state.book.routes.find(r => r.kind === 'shared-task' && r.resourceId === task.sharedTaskId);
  if (!route) return null;
  const live = state.live.get(routeKey(route)), target = live?.socket?.scopedPeerTarget(peer);
  if (!live || !target || route.retired) throw new Error('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
  const slot = mediaSlot(route);
  return { ...live, slot, binding: agentNetMediaBinding(slot), recipient: target.relayId, transportKey: target.transportKey,
    sharedTaskId: route.resourceId };
}
export function mobileAgentNetSharingMediaSource(slot: string, networkId: string, sharedTaskId?: string) {
  const state = current; if (!state) return null; state.guard();
  const route = state.book.routes.find(r => mediaSlot(r) === slot && r.networkId === networkId);
  if (!route) return null;
  if (route.retired || sharedTaskId && route.resourceId !== sharedTaskId) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  const live = state.live.get(routeKey(route)); if (!live) throw new Error('AGENT_NET_MEDIA_SOURCE_UNAVAILABLE');
  return { ...live, slot, binding: agentNetMediaBinding(slot) };
}
