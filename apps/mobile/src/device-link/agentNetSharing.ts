import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { DeviceLinkClient, parseSharedTaskPeer, type DeviceLinkClientOptions, type RoutedDeviceLinkClient, type SharedTaskApi } from '@cindy/device-link';
import { AgentNetSharingClient, AgentNetSharingTransport, AgentNetSocket, NativeTransport, PortableAgentNetClient,
  encodeAgentNetSharingInvitation, parseAgentNetSharingInvitation, syncAgentNetSharingOrigins, toBase64Url, utf8,
  type AgentNetSharingInvitation, type BinarySocket, type SharingRequestOptions } from '@cindy/agent-net/portable';
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
interface Book { version: 2; routes: Route[]; origins?: SharingOrigin[]; }
interface Live {
  api: PortableAgentNetClient; native: NativeAgentNetOptions; signer: MobileAgentNetEngine;
  lease: AgentNetSharingTransport; socket?: AgentNetSocket;
}
interface State {
  key: string; context: MobileSharingContext; book: Book; storage: string; seed: string; guard(): void;
  business: Map<string, { api: AgentNetSharingClient; signer: MobileAgentNetEngine }>;
  live: Map<string, Live>; pins: Map<string, () => void>; connections: Map<string, DeviceLinkClient>;
  binding?: { client: RoutedDeviceLinkClient; options: Omit<DeviceLinkClientOptions, 'getWsUrl' | 'getToken'> };
  writes: Promise<void>;
  livePending: Map<string, Promise<Live>>;
  originSync?: Promise<void>; originDigest?: string; originSyncedAt?: number;
}
let pending: { key: string; value: Promise<State> } | null = null;
let current: State | null = null;
let lifecycle = 0;
const hash = (text: string) => bytesToHex(sha256(utf8(text)));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const routeKey = (r: Pick<Route, 'kind' | 'resourceId'>) => r.kind + ':' + r.resourceId;
const originKey = (r: Pick<Route, 'server' | 'networkId' | 'rootPublicKey'>) => JSON.stringify([r.server, r.networkId, r.rootPublicKey]);
export function mobileAgentNetSharingEnabled(): boolean {
  const p = getMobileAgentNetPreferences(); return p.ready && p.enabled && MobileAgentNetEngine.available();
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
    const storage = 'cindy.agent-net.sharing.v2.' + hash(JSON.stringify([owner.accountKey, context.deviceId]));
    const raw = await AsyncStorage.getItem(storage); guard();
    const book = (raw ? JSON.parse(raw) : { version: 2, routes: [] }) as Book;
    if (book.version !== 2 || !Array.isArray(book.routes) || book.routes.length > 1024 || book.routes.some(r => !valid(r))
      || book.origins !== undefined && (!Array.isArray(book.origins) || book.origins.length > 1024 || book.origins.some(o => !sharingOriginValid(o)))
      || new Set(book.routes.map(routeKey)).size !== book.routes.length) throw new Error('AGENT_NET_SHARING_BOOK_UNREADABLE');
    let seed = await getSecureItem(storage + '.business'); guard();
    if (!seed) { seed = toBase64Url(getRandomBytes(32)); await setSecureItem(storage + '.business', seed, { thisDeviceOnly: true }); guard(); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(seed)) throw new Error('AGENT_NET_SHARING_SEED_UNREADABLE');
    const state: State = { key, context, book, storage, seed, guard, business: new Map(), live: new Map(), pins: new Map(), connections: new Map(), livePending: new Map(), writes: Promise.resolve() };
    guard(); current = state; return state;
  })();
  pending = { key, value }; try { return await value; } finally { if (pending?.value === value) pending = null; }
}
async function business(state: State, route: Pick<Route, 'server' | 'networkId' | 'rootPublicKey'>): Promise<AgentNetSharingClient> {
  state.guard(); const key = originKey(route), old = state.business.get(key); if (old) return old.api;
  const signer = await MobileAgentNetEngine.create({ seed: state.seed, context: 'cindy-agent-net/sharing-business/2', deviceId: state.context.deviceId }, state.guard);
  state.guard(); const existing = state.business.get(key); if (existing) { await signer.destroy(); return existing.api; }
  const member = currentMobileAgentNetIdentity();
  const same = member && member.api.base === route.server && member.api.certificate.networkId === route.networkId && member.api.rootPublicKey === route.rootPublicKey;
  const api = new AgentNetSharingClient({ ...route, base: route.server, signer, hash: sha256, assertCurrent: state.guard,
    ...(same ? { memberAuthorization: (method: string, path: string, body: string) => member.api.header(method, path, body) } : {}),
    getIdentityCard: nonce => state.context.apiFetch<{ card: string; expiresAt: string }>('/api/me/identity-card', {
      method: 'POST', baseUrl: AUTH_API_BASE_URL, body: { audience: 'cindy-agent-net-sharing', purpose: 'network-session', nonce },
      cache: 'no-store', timeoutMs: 12_000, assertCurrent: state.guard,
    }) });
  state.business.set(key, { api, signer }); return api;
}
function checkPin(state: State, route: Pick<Route, 'kind' | 'resourceId' | 'server' | 'networkId' | 'rootPublicKey' | 'hostDeviceId' | 'region'>): Route | undefined {
  const old = state.book.routes.find(r => routeKey(r) === routeKey(route));
  if (old && (originKey(old) !== originKey(route) || old.hostDeviceId !== route.hostDeviceId || old.region !== route.region)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT');
  return old;
}
async function remember(state: State, route: Route, seed?: string): Promise<void> {
  const work = state.writes.then(async () => {
    state.guard(); if (!valid(route)) throw new Error('INVALID_AGENT_NET_SHARING_ROUTE');
    const old = checkPin(state, route), key = routeKey(route);
    if (!old && state.book.routes.length >= 1024) throw new Error('AGENT_NET_SHARING_ROUTE_LIMIT');
    if (seed) { await setSecureItem(state.storage + '.' + route.seedId, seed, { thisDeviceOnly: true }); state.guard(); }
    const next: Book = { ...state.book, routes: [...state.book.routes.filter(r => routeKey(r) !== key), route] };
    await AsyncStorage.setItem(state.storage, JSON.stringify(next)); state.guard(); state.book = next;
    if (!old || old.memberId !== route.memberId || old.seedId !== route.seedId || old.retired !== route.retired) {
      state.connections.get(key)?.stop(); state.connections.delete(key); state.pins.get(key)?.(); state.pins.delete(key);
      const live = state.live.get(key); live?.lease.close(); live?.socket?.close(); if (live) await live.signer.destroy(); state.live.delete(key);
    }
    install(state, route);
  }); state.writes = work.catch(() => undefined); return work;
}
export async function joinMobileAgentNetSharedTask(input: string, displayName: string, context: MobileSharingContext): Promise<Awaited<ReturnType<SharedTaskApi['join']>> | null> {
  const parsed = parseAgentNetSharingInvitation(input, 'shared-task'); if (!parsed) return null;
  const state = await stateFor(context), { invitation, ...receipt } = parsed.receipt, route = { ...receipt, server: parsed.server };
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
    const identity = currentMobileAgentNetIdentity(), origins = new Map<string, SharingOrigin>();
    for (const route of state.book.routes) origins.set(originKey(route), route);
    for (const origin of state.book.origins ?? []) origins.set(originKey(origin), origin);
    if (identity) { const route: SharingOrigin = { server: identity.api.base, networkId: identity.api.certificate.networkId,
      rootPublicKey: identity.api.rootPublicKey, region: getActiveMobileSessionRealm() === 'cn' ? 'cn' : 'global' }; origins.set(originKey(route), route); }
    if (!origins.size) {
      if (!mobileAgentNetAllowsLegacy()) throw new Error('AGENT_NET_SHARING_SERVICES_UNAVAILABLE');
      return null;
    }
    const sources = [...origins.values()].map(route => ({ route, read: async (signal: AbortSignal) => (await business(state, route)).request(path, { ...options, signal }) }));
    if (mobileAgentNetAllowsLegacy()) sources.push({ route: undefined as unknown as Route, read: legacy });
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
    for (let i = 0; i < results.length; i++) {
      const result = results[i], source = sources[i];
      if (result.status === 'rejected') { if (source.route) unavailable.push(...state.book.routes.filter(r => originKey(r) === originKey(source.route)).map(r => r.resourceId)); continue; }
      const items = (result.value as { sharedTasks?: unknown })?.sharedTasks;
      if (!Array.isArray(items) || items.length > 10_000) throw new Error('INVALID_AGENT_NET_SHARED_TASK_LIST');
      for (const item of items) { const row = item as { sharedTaskId?: unknown; hostDeviceId?: unknown; ownerAccountId?: unknown }, rid = row?.sharedTaskId;
        if (!id(rid) || rows.has(rid)) throw new Error('AGENT_NET_SHARING_ROUTE_CONFLICT'); rows.set(rid, item);
        const subject = source.route ? agentNetSharingSubject(getMobileAuthOwner().accountId, getActiveMobileSessionRealm() === 'cn' ? 'cn' : 'global', source.route.region) : getMobileAuthOwner().accountId;
        if (source.route && row.ownerAccountId !== subject && id(row.hostDeviceId)
          && !state.book.routes.some(r => r.resourceId === rid && !r.retired)) {
          try {
            const detail = await (await business(state, source.route)).request<{ status: string; guests: { accountId: string; memberId: string }[] }>(
              '/api/device-link/shared-tasks/' + encodeURIComponent(rid), { method: 'GET', signal: AbortSignal.timeout(3000) });
            const subject = agentNetSharingSubject(getMobileAuthOwner().accountId, getActiveMobileSessionRealm() === 'cn' ? 'cn' : 'global', source.route.region);
            const member = detail.status === 'active' && detail.guests?.find(g => g.accountId === subject);
            if (!member || !id(member.memberId)) throw new Error('AGENT_NET_SHARING_ADMISSION_REQUIRED');
            await remember(state, { ...source.route, v: 2, kind: 'shared-task', resourceId: rid, hostDeviceId: row.hostDeviceId,
              memberId: member.memberId, seedId: toBase64Url(getRandomBytes(18)) }, toBase64Url(getRandomBytes(32)));
          } catch { unavailable.push(rid); rows.delete(rid); }
        }
      }
    }
    return { sharedTasks: [...rows.values()], unavailableSharedTaskIds: unavailable, ...(results.some(r => r.status === 'rejected') ? { authorityIncomplete: true } : {}) };
  }
  const match = /^\/api\/device-link\/shared-tasks\/([^/]+)/.exec(path);
  const route = match && state.book.routes.find(r => r.resourceId === decodeURIComponent(match[1]));
  if (!route) { if (!mobileAgentNetAllowsLegacy()) throw new Error('AGENT_NET_SHARING_ROUTE_REQUIRED'); return null; }
  const result = await (await business(state, route)).request(path, options); state.guard();
  if (path.endsWith('/leave')) await remember(state, { ...route, retired: true });
  return result;
}
async function syncOrigins(state: State): Promise<void> {
  state.guard(); if (state.originSync) return state.originSync;
  const identity = currentMobileAgentNetIdentity(); if (!identity || identity.api.delegation) return;
  const origins = new Map<string, SharingOrigin>();
  for (const r of [...state.book.routes, ...(state.book.origins ?? [])]) {
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
      const next = { ...state.book, origins: [...merged.values()] };
      await AsyncStorage.setItem(state.storage, JSON.stringify(next)); state.guard(); state.book = next;
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
  guard(); const seed = await getSecureItem(state.storage + '.' + route.seedId); guard();
  if (!seed) throw new Error('AGENT_NET_SHARING_SEED_UNAVAILABLE');
  const native = { seed, context: JSON.stringify(['cindy-agent-net/sharing-transport/2', route.rootPublicKey, route.kind, route.resourceId]), deviceId: state.context.deviceId };
  const signer = await MobileAgentNetEngine.create(native, guard);
  const lease = new AgentNetSharingTransport({ client: await business(state, route), applicant: signer, assertCurrent: guard,
    verifyCertificate: verifyMobileAgentNetCertificate, verifyDelegation: verifyMobileAgentNetDelegation,
    scope: { ...route, guestSubject: agentNetSharingSubject(getMobileAuthOwner().accountId, getActiveMobileSessionRealm() === 'cn' ? 'cn' : 'global', route.region) } });
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
      const engine = await MobileAgentNetEngine.create({ ...live.native, udp: true }, guard);
      try {
        const socket = await AgentNetSocket.openWithBindings({ client: live.api, scoped: true, assertCurrent: guard,
          userId: getMobileAuthOwner().accountId, bindings: { verifyCertificate: verifyMobileAgentNetCertificate,
            verifyDelegation: verifyMobileAgentNetDelegation, createTransport: opts => NativeTransport.create(engine, opts) } });
        guard(); live.socket = socket;
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
