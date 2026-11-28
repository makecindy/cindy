/**
 * Device Link（V1）供应商分享改走 Agent-Net
 * （docs/dev-rules/protocol-compatibility/agent-net-linked-provider-shares.md）。
 *
 * 授权不动，只换线路：成员关系、暂停、移除、额度都还是原来的 V1 分享，没有新的申请与批准。
 * - 受邀者（两边都开着官方 Agent-Net 时）在已认证的 Device Link 分享连接上把自己为这个分享生成的
 *   Agent-Net 公钥报给分享者电脑（PROVIDER_SHARE_AGENT_NET_LINK_CHANNEL）。
 * - 分享者电脑在自己的 Agent-Net 服务上登记这个分享（只说明分享在这台电脑上，不带成员），记下这把钥匙，
 *   之后只给登记过的钥匙、且本机 V1 成员表仍有效的受邀者签放行证（最长 30 分钟，自动续签）。
 * - 受邀者拿到放行证后，这个分享的会话（建链、调用、推送）与附件走 Agent-Net；连接没起来、被撤、
 *   连续失败时整体照旧走 Device Link，不会一半走一边。
 * 本机记录放在账号作用域内的加密文件里（linked-shares-v1.enc），旧版本不读它，降级后自然回到 Device Link。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import {
  DeviceLinkClient, parseProviderSharePeer, providerShareGuestPeer, providerShareHostPeer,
  type DeviceLinkClientOptions, type InvokeResultPayload, type ProviderShareReceived, type RoutedDeviceLinkClient,
} from '@cindy/device-link';
import { AgentNetSharingClient, AgentNetSharingError, AgentNetSharingTransport,
  type AgentNetAppSocket, type SharingExecutorInput } from '@cindy/agent-net';
import { identityFromSeed, signature, verifyCertificate, verifyDelegation, type Identity } from '@cindy/agent-net-relay';
import { AgentNetClient } from '@cindy/agent-net-relay/client';
import { MAX_GRANT_LIFETIME_MS, agentNetMediaBinding, agentNetSharingSubject, delegationPayload,
  type Delegation, type DelegationRequest } from '@cindy/agent-net-protocol';
import type { DeviceLinkPeerLinkView, DeviceLinkProviderShareRouteView } from '../../shared/deviceLinkIpc.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getActiveAuthRealm, getAuthState, getCurrentUserId, getDeviceId } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import {
  PROVIDER_SHARE_AGENT_NET_LINK_CHANNEL, parseProviderShareAgentNetLinkRequest, parseProviderShareAgentNetLinkResponse,
  type ProviderShareAgentNetLinkResponse, type ProviderShareAgentNetLinkRoute,
} from '../../shared/providerShareAgentNetLink.js';
import { agentNetRequiresEncryption, currentAgentNetClient, currentAgentNetExecutorCertificate,
  currentAgentNetScopedTarget, isAgentNetActive, openScopedAgentNetAppSocket, supportsLinkedProviderShares } from './agentNetRuntime.js';
import { officialAgentNetBase } from './agentNetOfficial.js';
import { openLinkWebSocket } from './linkWebSocket.desktop.js';
import { relayDataPath, secureStorageAvailable } from './selfHostedRelayConfig.js';
import { activeSelfHostedRelay } from './selfHostedRelayRouting.js';
import { readDeviceLinkSettings } from './settings-store.desktop.js';

const log = createLogger('agent-net:linked-shares');

/** 一个分享最多记多少台受邀设备的钥匙（同一成员同一台设备只留最新一把）。 */
const MAX_GUESTS_PER_SHARE = 64;
const MAX_LINKS = 1024;
/** 分享者暂时不能登记（关着 Agent-Net、临时出错）或尚未升级：30 分钟后再问。 */
const RETRY_COOLDOWN_MS = 30 * 60_000;
const UNSUPPORTED_COOLDOWN_MS = 30 * 60_000;
/** 分享者离线重连（如重启升级完成）时立即清冷却，但两次探测至少间隔 1 分钟防止抖动放大。 */
const RECONNECT_CLEAR_FLOOR_MS = 60_000;
const EXECUTOR_PROOF_WAIT_MS = 3_000;
const MAX_NOTED_EXECUTORS = 512;
/** 连续这么多次拿不到放行证就退回 Device Link，等冷却后再重新登记。 */
const MAX_LEASE_FAILURES = 3;

type ScopedConnectionOptions = Omit<DeviceLinkClientOptions, 'getWsUrl' | 'getToken'>;
type ShareInvoke = (agentDeviceId: string, channel: string, args: unknown[]) => Promise<InvokeResultPayload>;
/**
 * 这台电脑和这个分享对端的控制链路此刻是不是走在 Agent-Net 会话上（index.ts 按会话层装上）。附件跟着它走：会话层规定
 * 链路中途不换路，已经开在 Device Link 上的链路要等它结束、下一次建链才到会话上，在那之前附件也留在 Device Link。
 */
let controlOnSession: (peer: string) => boolean = () => false;
export function setLinkedShareControlTransport(check: ((peer: string) => boolean) | null): void { controlOnSession = check ?? (() => false); }
type LinkRoute = ProviderShareAgentNetLinkRoute;
interface HostedGuest { memberId: string; deviceId: string; signingKey: string; transportKey: string; at: number }
/** `pendingUnlink`: the share is gone here, its service registration not yet confirmed removed (retried, never admits). */
interface HostedLink { shareId: string; route: LinkRoute; guests: HostedGuest[]; pendingUnlink?: true }
interface JoinedLink { shareId: string; memberId: string; seed: string; route: LinkRoute }
interface VaultFile { version: 1; seed: string; hosted: HostedLink[]; joined: JoinedLink[] }
interface Live {
  link: JoinedLink;
  client?: DeviceLinkClient;
  lease: AgentNetSharingTransport;
  api?: AgentNetClient;
  socket?: AgentNetAppSocket;
  failures: number;
}
interface State {
  key: string;
  file: string;
  vault: VaultFile;
  guard(): void;
  live: Map<string, Live>;
  business: Map<string, AgentNetSharingClient>;
  cooldown: Map<string, number>;
  attemptAt: Map<string, number>;
  hostDevices: Map<string, string>;
  hostOnline: Map<string, boolean>;
  notedExecutors: Map<string, number>;
  lastPoll: Parameters<typeof linkReceivedProviderShares>[0] | null;
  linking: string | null;
}

let state: State | null = null;
let bound: { client: RoutedDeviceLinkClient; options: ScopedConnectionOptions; offPresence?: () => void } | null = null;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const seedValid = (seed: unknown): seed is string => typeof seed === 'string' && /^[A-Za-z0-9_-]{43}$/.test(seed)
  && Buffer.from(seed, 'base64url').toString('base64url') === seed;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const short = (id: string) => id.slice(0, 8);
const stripSlash = (value: string) => value.replace(/\/+$/, '');

function routeValid(route: unknown): route is LinkRoute {
  const r = route as LinkRoute | null;
  try {
    const url = new URL(r!.server);
    const secure = url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !!r && secure && !url.username && !url.password && !url.search && !url.hash && stripSlash(r.server) === r.server
      && typeof r.networkId === 'string' && ID.test(r.networkId) && typeof r.rootPublicKey === 'string' && KEY.test(r.rootPublicKey)
      && typeof r.hostDeviceId === 'string' && ID.test(r.hostDeviceId) && (r.region === 'cn' || r.region === 'global');
  } catch { return false; }
}
function vaultValid(value: unknown): value is VaultFile {
  const v = value as VaultFile | null;
  return !!v && v.version === 1 && seedValid(v.seed) && Array.isArray(v.hosted) && Array.isArray(v.joined)
    && v.hosted.length <= MAX_LINKS && v.joined.length <= MAX_LINKS
    && v.hosted.every(h => !!h && ID.test(h.shareId) && routeValid(h.route) && Array.isArray(h.guests) && h.guests.length <= MAX_GUESTS_PER_SHARE
      && (h.pendingUnlink === undefined || h.pendingUnlink === true)
      && h.guests.every(g => !!g && ID.test(g.memberId) && ID.test(g.deviceId) && KEY.test(g.signingKey) && KEY.test(g.transportKey) && Number.isSafeInteger(g.at)))
    && v.joined.every(j => !!j && ID.test(j.shareId) && ID.test(j.memberId) && seedValid(j.seed) && routeValid(j.route))
    && new Set(v.hosted.map(h => h.shareId)).size === v.hosted.length && new Set(v.joined.map(j => j.shareId)).size === v.joined.length;
}

function readVault(file: string): VaultFile {
  if (!fs.existsSync(file)) return { version: 1, seed: randomBytes(32).toString('base64url'), hosted: [], joined: [] };
  if (!secureStorageAvailable() || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('AGENT_NET_LINKED_SHARES_UNAVAILABLE');
  let saved: unknown;
  try { saved = JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64'))); }
  catch { throw new Error('AGENT_NET_LINKED_SHARES_UNREADABLE'); }
  if (!vaultValid(saved)) throw new Error('AGENT_NET_LINKED_SHARES_UNREADABLE');
  return saved;
}
function save(s: State, vault: VaultFile): void {
  s.guard();
  if (!secureStorageAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
  const encrypted = safeStorage.encryptString(JSON.stringify(vault)).toString('base64'); s.guard();
  fs.mkdirSync(path.dirname(s.file), { recursive: true, mode: 0o700 });
  const temporary = s.file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, s.file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  s.vault = vault;
}

function stopLive(live: Live): void {
  live.client?.stop(); live.lease.close();
  live.client = undefined; live.socket = undefined; live.api = undefined;
}
function retire(s: State): void {
  for (const live of s.live.values()) stopLive(live);
  for (const client of s.business.values()) client.close();
  s.live.clear(); s.business.clear();
}
/** 当前账号的记录；账号、作用域或登录服务变了就换一份（旧连接全部关掉）。 */
function owner(): State {
  const account = getCurrentUserId(), key = activeOwnerScopeKey(), auth = getClientEndpoint('authApiBaseUrl');
  if (!account || !getAuthState().isAuthenticated || isAppSessionBoundaryPending()) throw new Error('AGENT_NET_OWNER_CHANGED');
  if (state?.key === key) { state.guard(); return state; }
  if (state) retire(state);
  const guard = () => {
    if (!getAuthState().isAuthenticated || getCurrentUserId() !== account || activeOwnerScopeKey() !== key
      || isAppSessionBoundaryPending() || getClientEndpoint('authApiBaseUrl') !== auth) throw new Error('AGENT_NET_OWNER_CHANGED');
  };
  const file = relayDataPath('agent-net', 'linked-shares-v1.enc');
  state = { key, file, vault: readVault(file), guard, live: new Map(), business: new Map(),
    cooldown: new Map(), attemptAt: new Map(), hostDevices: new Map(), hostOnline: new Map(),
    notedExecutors: new Map(), lastPoll: null, linking: null };
  return state;
}
/** 热路径（会话选路、附件）只读已经打开的当前账号记录，不读盘、不抛错。 */
function currentState(): State | null {
  if (!state || isAppSessionBoundaryPending() || state.key !== activeOwnerScopeKey()) return null;
  try { state.guard(); return state; } catch { return null; }
}

function signer(identity: Identity) {
  return { identity, sign: async (value: string) => signature(identity.signingPrivateKey, value),
    random: async () => randomBytes(18).toString('base64url') };
}
function transportIdentity(shareId: string, seed: string): Identity {
  return identityFromSeed(JSON.stringify(['cindy-agent-net/linked-sharing-transport/1', 'provider-share', shareId]), seed, getDeviceId());
}
/** 与 Agent-Net 分享同一种附件分区：按网络、分享与成员隔开。 */
function mediaSlot(route: Pick<LinkRoute, 'rootPublicKey' | 'networkId'>, shareId: string, memberId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['cindy-agent-net/sharing-media-slot/2',
    route.rootPublicKey, route.networkId, 'provider-share', shareId, memberId])).digest('hex').slice(0, 32);
  return [bytes.slice(0, 8), bytes.slice(8, 12), bytes.slice(12, 16), bytes.slice(16, 20), bytes.slice(20)].join('-');
}
function businessClient(s: State, route: LinkRoute, member?: AgentNetClient): AgentNetSharingClient {
  const key = JSON.stringify([route.server, route.networkId, route.rootPublicKey, member?.certificate.signature ?? null]);
  const existing = s.business.get(key); if (existing) return existing;
  const identity = identityFromSeed('cindy-agent-net/linked-sharing-business/1', s.vault.seed, getDeviceId());
  const client = new AgentNetSharingClient({ base: route.server, networkId: route.networkId, rootPublicKey: route.rootPublicKey,
    signer: signer(identity), hash, assertCurrent: s.guard, fetch: outboundFetch,
    memberAuthorization: member ? (method, resource, body) => { s.guard(); return member.header(method, resource, body); } : undefined,
    async getIdentityCard(nonce) {
      return serverApiFetch<{ card: string; expiresAt: string }>('/api/me/identity-card', { method: 'POST',
        body: { audience: 'cindy-agent-net-sharing', purpose: 'network-session', nonce },
        baseUrl: () => { s.guard(); return getClientEndpoint('authApiBaseUrl'); }, timeoutMs: 12_000,
        cache: 'no-store', logLabel: '/api/me/identity-card', redactErrorDetails: true });
    } });
  s.business.set(key, client); return client;
}

// ─── 分享者电脑 ────────────────────────────────────────────────────────────────

/** 本机的官方 Agent-Net 主连接；关着、走自建中转、仅自建网络时为 null（第一版只在官方服务上换线路）。 */
function hostAgentNetClient(): AgentNetClient | null {
  if (readDeviceLinkSettings().agentNetEnabled !== true || activeSelfHostedRelay() || !isAgentNetActive()) return null;
  const base = officialAgentNetBase(), api = currentAgentNetClient();
  if (!base || !api || api.delegation || api.base !== base || !api.certificate.networkId.startsWith('account:')
    || api.identity.deviceId !== getDeviceId()) return null;
  return api;
}
const sameRoute = (a: LinkRoute | undefined, b: LinkRoute) => !!a && a.server === b.server && a.networkId === b.networkId
  && a.rootPublicKey === b.rootPublicKey && a.hostDeviceId === b.hostDeviceId && a.region === b.region;

/**
 * 受邀者经 Device Link 分享连接发来的登记请求。调用方（dispatch）已按本机 V1 成员表放行这个受邀者，
 * 委托执行电脑的短期授权也到不了这里。成功时返回本机所在的 Agent-Net 网络。
 */
export async function handleProviderShareAgentNetLink(controller: string, raw: unknown): Promise<ProviderShareAgentNetLinkResponse> {
  const peer = parseProviderSharePeer(controller);
  const request = parseProviderShareAgentNetLinkRequest(raw);
  if (!peer || peer.role !== 'guest' || !request) throw new Error('[INVALID_PARAMS] Invalid Agent-Net link request');
  const api = hostAgentNetClient();
  if (!api) return { unavailable: 'agent-net-off' };
  if (!supportsLinkedProviderShares(api.base, api.rootPublicKey)) return { unavailable: 'relay-unsupported' };
  const s = owner();
  const route: LinkRoute = { server: api.base, networkId: api.certificate.networkId, rootPublicKey: api.rootPublicKey,
    hostDeviceId: api.identity.deviceId, region: getActiveAuthRealm() };
  try {
    // 幂等：每次登记都确认一遍服务端那条记录在（服务端数据丢了也能自己补回来）。
    await businessClient(s, route, api).request('/api/device-link/provider-shares/linked', { method: 'POST', body: { shareId: peer.shareId } });
  } catch (error) {
    s.guard();
    const status = error instanceof AgentNetSharingError ? error.status : 0;
    log.warn(`linking share ${short(peer.shareId)} on Agent-Net failed (${status || (error instanceof Error ? error.message : 'error')})`);
    return { unavailable: status === 404 ? 'relay-unsupported' : 'link-failed' };
  }
  s.guard();
  const previous = s.vault.hosted.find(h => h.shareId === peer.shareId);
  const guests = (sameRoute(previous?.route, route) ? previous!.guests : [])
    .filter(g => !(g.memberId === peer.memberId && g.deviceId === peer.deviceId));
  guests.push({ memberId: peer.memberId, deviceId: peer.deviceId, signingKey: request.signingKey, transportKey: request.transportKey, at: Date.now() });
  const hosted = [...s.vault.hosted.filter(h => h.shareId !== peer.shareId), { shareId: peer.shareId, route, guests: guests.slice(-MAX_GUESTS_PER_SHARE) }];
  if (hosted.length > MAX_LINKS) return { unavailable: 'link-failed' };
  save(s, { ...s.vault, hosted });
  log.info(`share ${short(peer.shareId)} member ${short(peer.memberId)} may use Agent-Net`);
  return { route };
}

/**
 * 放行证申请是不是本机登记过的旧分享：null 表示不是（交给原来的 Agent-Net 分享规则）。
 * 是的话只认登记过的那把钥匙；成员是否仍有效由调用方按本机 V1 成员表再核对。
 */
export function linkedProviderShareAdmission(request: DelegationRequest): boolean | null {
  if (request.kind !== 'provider-share') return null;
  let s: State;
  try { s = owner(); } catch { return null; }
  const hosted = s.vault.hosted.find(h => h.shareId === request.resourceId);
  if (!hosted) return null;
  if (hosted.pendingUnlink) return false;
  const api = hostAgentNetClient();
  return !!api && hosted.route.networkId === request.networkId && hosted.route.rootPublicKey === api.rootPublicKey
    && hosted.route.hostDeviceId === request.hostDeviceId && api.identity.deviceId === request.hostDeviceId
    && hosted.guests.some(g => g.memberId === request.scope.memberId && g.deviceId === request.guestDeviceId
      && g.signingKey === request.guestSigningKey && g.transportKey === request.guestTransportKey);
}

/** 成员被暂停、移除或分享被删：忘掉他登记的钥匙，并撤掉已签的放行证（服务端随即断开他的 Agent-Net 连接）。 */
export function revokeLinkedProviderShareGuests(match: (controller: string) => boolean): void {
  let s: State;
  try { s = owner(); } catch { return; }
  const removed: Array<{ shareId: string; memberId: string; deviceId: string }> = [];
  const hosted = s.vault.hosted.map(h => ({ ...h, guests: h.guests.filter(g => {
    const hit = match(providerShareGuestPeer(h.shareId, g.memberId, g.deviceId));
    if (hit) removed.push({ shareId: h.shareId, memberId: g.memberId, deviceId: g.deviceId });
    return !hit;
  }) }));
  if (!removed.length) return;
  try { save(s, { ...s.vault, hosted }); } catch (error) { log.warn(`could not save linked share revocation: ${String(error)}`); }
  void withdrawGrants(s, removed).catch((error: unknown) => log.warn(`withdrawing linked share grants failed: ${String(error)}`));
}
async function withdrawGrants(s: State, targets: Array<{ shareId: string; memberId: string; deviceId: string }>): Promise<void> {
  // 本机此刻不在 Agent-Net 上：已签的放行证最多 30 分钟后失效，期间每次调用仍按成员表拒绝。
  const api = hostAgentNetClient(); if (!api) return;
  const { grants } = await api.request<{ grants: Delegation[] }>('GET', '/grants'); s.guard();
  for (const d of Array.isArray(grants) ? grants : []) {
    if (d?.kind !== 'provider-share' || !targets.some(t => t.shareId === d.resourceId && t.memberId === d.scope?.memberId
      && t.deviceId === d.guestDeviceId)) continue;
    await api.request('DELETE', '/grants/' + encodeURIComponent(d.id)).catch(() => undefined); s.guard();
  }
}

/** 取消登记失败（本机不在 Agent-Net 上、断网、服务出错）后，同一条记录多久再试一次。 */
const UNLINK_RETRY_MS = 10 * 60_000;
const unlinkRetryAt = new Map<string, number>();
const executorWrites = new Map<string, Promise<unknown>>();
function orderedExecutorWrite<T>(api: AgentNetClient, input: SharingExecutorInput, guard: () => void, work: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([api.base, api.certificate.networkId, api.identity.deviceId, input.shareId, input.memberId, input.guestDeviceId]);
  const result = (executorWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => { guard(); return work(); });
  executorWrites.set(key, result);
  void result.finally(() => { if (executorWrites.get(key) === result) executorWrites.delete(key); }).catch(() => undefined);
  return result;
}
export function hasHostedLinkedProviderShare(shareId: string): boolean {
  const s = currentState(), api = s && hostAgentNetClient(), hosted = s?.vault.hosted.find(h => h.shareId === shareId);
  return !!hosted && !hosted.pendingUnlink && !!api && hosted.route.networkId === api.certificate.networkId
    && hosted.route.rootPublicKey === api.rootPublicKey && hosted.route.hostDeviceId === api.identity.deviceId;
}
/**
 * 供应商组主机为已迁移到 Agent-Net 的旧分享受邀者授权组内同账号执行机：只在该受邀者当前持有有效 Agent-Net 放行证、
 * 且目标执行机此刻在本账号 Agent-Net 上在线时签入 `Delegation.executors`；否则返回 null，照旧走 Device Link 委托。
 */
export async function grantLinkedProviderShareExecutor(input: SharingExecutorInput, signal?: AbortSignal): Promise<{
  generation: string; expiresAt: number; linkedShareAgentNet: true;
} | null> {
  let s: State;
  try { s = owner(); } catch { return null; }
  const hosted = s.vault.hosted.find(h => h.shareId === input.shareId);
  if (!hosted || hosted.pendingUnlink) return null;
  const api = hostAgentNetClient();
  if (!api || hosted.route.networkId !== api.certificate.networkId || hosted.route.rootPublicKey !== api.rootPublicKey
    || hosted.route.hostDeviceId !== api.identity.deviceId) return null;
  const guest = hosted.guests.find(g => g.memberId === input.memberId && g.deviceId === input.guestDeviceId);
  if (!guest || !currentAgentNetExecutorCertificate(input.executorDeviceId)) return null;
  return orderedExecutorWrite(api, input, s.guard, async () => {
    for (let attempt = 0; ; attempt++) {
      const { grants } = await api.request<{ grants: Delegation[] }>('GET', '/grants', undefined, { signal }); s.guard();
      const delegation = (Array.isArray(grants) ? grants : []).filter(d => d?.kind === 'provider-share'
        && d.resourceId === input.shareId && d.hostDeviceId === api.identity.deviceId && d.networkId === api.certificate.networkId
        && d.scope?.memberId === input.memberId && d.guestDeviceId === input.guestDeviceId
        && d.guestSigningKey === guest.signingKey && d.guestTransportKey === guest.transportKey
        && verifyDelegation(api.rootPublicKey, d) && d.expiresAt > Date.now()).sort((a, b) => b.expiresAt - a.expiresAt)[0];
      const executorCertificate = currentAgentNetExecutorCertificate(input.executorDeviceId);
      if (!delegation || !executorCertificate) return null;
      const at = Date.now(), expiresAt = Math.min(at + MAX_GRANT_LIFETIME_MS, delegation.expiresAt, executorCertificate.expiresAt);
      if (expiresAt - at < 5000) return null;
      const generation = randomUUID(), executors = (delegation.executors ?? [])
        .filter(e => e.expiresAt > at && e.certificate.deviceId !== input.executorDeviceId);
      if (executors.length >= 32) throw new Error('AGENT_NET_EXECUTOR_LIMIT');
      executors.push({ certificate: executorCertificate, generation, expiresAt });
      const plain = { ...delegation, issuedAt: Math.max(Date.now(), delegation.issuedAt), executors };
      const updated = { ...plain, signature: signature(api.identity.signingPrivateKey, delegationPayload(plain)) };
      if (!verifyDelegation(api.rootPublicKey, updated)) throw new Error('INVALID_AGENT_NET_EXECUTOR_GRANT');
      try {
        const result = await api.request<{ delegation: Delegation }>('POST', '/grants',
          { delegation: updated, previousSignature: delegation.signature }, { signal });
        s.guard();
        if (result.delegation.signature !== updated.signature) throw new Error('UNCONFIRMED_AGENT_NET_EXECUTOR_GRANT');
        return { generation, expiresAt, linkedShareAgentNet: true as const };
      } catch (error) {
        if ((error as { code?: string }).code !== 'GRANT_CHANGED' || attempt >= 2) throw error;
      }
    }
  });
}
export async function revokeLinkedProviderShareExecutor(
  input: SharingExecutorInput & { generation: string; linkedShareAgentNet?: boolean },
  signal?: AbortSignal,
): Promise<boolean> {
  if (!input.linkedShareAgentNet) return false;
  let s: State;
  try { s = owner(); } catch { return true; }
  const hosted = s.vault.hosted.find(h => h.shareId === input.shareId), api = hostAgentNetClient();
  if (!hosted || !api || hosted.route.networkId !== api.certificate.networkId || hosted.route.rootPublicKey !== api.rootPublicKey
    || hosted.route.hostDeviceId !== api.identity.deviceId) return true;
  await orderedExecutorWrite(api, input, s.guard, async () => {
    for (let attempt = 0; ; attempt++) {
      const { grants } = await api.request<{ grants: Delegation[] }>('GET', '/grants', undefined, { signal }); s.guard();
      const delegation = (Array.isArray(grants) ? grants : []).find(d => d?.kind === 'provider-share'
        && d.resourceId === input.shareId && d.scope?.memberId === input.memberId && d.guestDeviceId === input.guestDeviceId
        && d.executors?.some(e => e.certificate.deviceId === input.executorDeviceId && e.generation === input.generation));
      if (!delegation) return;
      const executors = (delegation.executors ?? []).filter(e => e.expiresAt > Date.now()
        && !(e.certificate.deviceId === input.executorDeviceId && e.generation === input.generation));
      const plain = { ...delegation, issuedAt: Math.max(Date.now(), delegation.issuedAt), executors };
      const updated = { ...plain, signature: signature(api.identity.signingPrivateKey, delegationPayload(plain)) };
      if (!verifyDelegation(api.rootPublicKey, updated)) throw new Error('INVALID_AGENT_NET_EXECUTOR_GRANT');
      try {
        await api.request('POST', '/grants', { delegation: updated, previousSignature: delegation.signature }, { signal });
        s.guard(); return;
      } catch (error) {
        if ((error as { code?: string }).code !== 'GRANT_CHANGED' || attempt >= 2) throw error;
      }
    }
  });
  return true;
}
function executorVerifiedTarget(peer: string) {
  if (isAppSessionBoundaryPending() || !getAuthState().isAuthenticated) return null;
  const p = parseProviderSharePeer(peer);
  if (p?.role !== 'guest') return null;
  const api = hostAgentNetClient();
  if (!api) return null;
  const target = currentAgentNetScopedTarget(peer), proof = target?.delegation;
  if (!target || !proof || proof.kind !== 'provider-share' || proof.networkId !== api.certificate.networkId
    || proof.resourceId !== p.shareId || proof.scope?.memberId !== p.memberId || proof.guestDeviceId !== p.deviceId
    || !verifyDelegation(api.rootPublicKey, proof)) return null;
  const executor = proof.executors?.find(row => row.certificate.deviceId === api.identity.deviceId);
  if (!executor || executor.expiresAt <= Date.now() || executor.certificate.subject !== api.certificate.subject
    || executor.certificate.signingKey !== api.identity.signingKey || executor.certificate.transportKey !== api.identity.transportKey) return null;
  return { api, peer: p, target, proof, executor };
}
/** 组内执行机核验由分享主机签在已登记旧分享放行证上的执行机授权，不写入原生 V2 分享路由表，保留其它未迁移成员的 V1 通路。 */
export function linkedProviderShareExecutorProof(input: SharingExecutorInput, generation?: string) {
  if (input.executorDeviceId !== getDeviceId()) return null;
  const verified = executorVerifiedTarget(providerShareGuestPeer(input.shareId, input.memberId, input.guestDeviceId));
  if (!verified || (generation !== undefined && verified.executor.generation !== generation)) return null;
  return { delegation: verified.proof, generation: verified.executor.generation, expiresAt: verified.executor.expiresAt,
    ownerDeviceId: verified.proof.hostDeviceId, active: true as const };
}
export async function waitLinkedProviderShareExecutorProof(input: SharingExecutorInput,
  generation: string | undefined, signal?: AbortSignal) {
  const immediate = linkedProviderShareExecutorProof(input, generation);
  if (immediate) return { active: true as const, ownerDeviceId: immediate.ownerDeviceId,
    generation: immediate.generation, expiresAt: immediate.expiresAt, proofId: immediate.delegation.id };
  const deadline = performance.now() + EXECUTOR_PROOF_WAIT_MS;
  while (performance.now() < deadline && !signal?.aborted && hostAgentNetClient()) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 25); t.unref?.();
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    const found = linkedProviderShareExecutorProof(input, generation);
    if (found) return { active: true as const, ownerDeviceId: found.ownerDeviceId,
      generation: found.generation, expiresAt: found.expiresAt, proofId: found.delegation.id };
  }
  signal?.throwIfAborted();
  return { active: false as const };
}
/**
 * 拿到完整的本机分享快照后：已不在快照里的分享不再登记在 Agent-Net 上。本机记录先标为待取消（不再放行任何人），
 * 服务端确认删除后才去掉；没确认的随下一次快照重试（每条最多 10 分钟一次），名额不会被遗留登记占满。
 */
export function reconcileLinkedProviderShares(owned: ReadonlyMap<string, ReadonlySet<string>>): void {
  let s: State;
  try { s = owner(); } catch { return; }
  if (s.vault.hosted.some(h => !owned.has(h.shareId) && !h.pendingUnlink)) {
    try { save(s, { ...s.vault, hosted: s.vault.hosted.map(h => owned.has(h.shareId) || h.pendingUnlink ? h : { ...h, guests: [], pendingUnlink: true as const }) }); }
    catch (error) { log.warn(`could not save linked share cleanup: ${String(error)}`); return; }
  }
  const api = hostAgentNetClient(); if (!api) return;
  const now = Date.now();
  for (const h of s.vault.hosted) {
    if (!h.pendingUnlink || (unlinkRetryAt.get(h.shareId) ?? 0) > now) continue;
    // Another network or service cannot be asked from here; nothing there can admit anyone for this computer either.
    if (h.route.server !== api.base || h.route.networkId !== api.certificate.networkId) { dropHosted(s, h.shareId); continue; }
    unlinkRetryAt.set(h.shareId, now + UNLINK_RETRY_MS);
    void businessClient(s, h.route, api).request(`/api/device-link/provider-shares/linked/${encodeURIComponent(h.shareId)}/remove`,
      { method: 'POST', body: {} }).then(() => { if (state === s) { unlinkRetryAt.delete(h.shareId); dropHosted(s, h.shareId); } })
      .catch(() => undefined);
  }
}
function dropHosted(s: State, shareId: string): void {
  const current = s.vault.hosted.find(h => h.shareId === shareId);
  if (!current?.pendingUnlink) return;
  try { save(s, { ...s.vault, hosted: s.vault.hosted.filter(h => h !== current) }); }
  catch (error) { log.warn(`could not save linked share cleanup: ${String(error)}`); }
}

// ─── 受邀者电脑 ────────────────────────────────────────────────────────────────

/** 受邀者这台此刻能不能换线路：开着官方 Agent-Net、没走自建中转、没开「仅使用 Agent-Net」（那时旧分享本来就不可用）。 */
function guestEligible(): boolean {
  return readDeviceLinkSettings().agentNetEnabled === true && isAgentNetActive() && !activeSelfHostedRelay()
    && !!officialAgentNetBase() && !agentNetRequiresEncryption() && secureStorageAvailable();
}

function forgetJoined(s: State, shareId: string, cooldownMs?: number): void {
  const live = s.live.get(shareId);
  if (live) { stopLive(live); s.live.delete(shareId); }
  if (cooldownMs) s.cooldown.set(shareId, Date.now() + cooldownMs);
  if (!s.vault.joined.some(j => j.shareId === shareId)) return;
  try { save(s, { ...s.vault, joined: s.vault.joined.filter(j => j.shareId !== shareId) }); }
  catch (error) { log.warn(`could not save linked share removal: ${String(error)}`); }
}

/** 账号、开关或这条记录本身变了（连接马上会被整批重建或停掉）：不是放行证的问题，不计失败。 */
const ownerChanged = (error: unknown) => ['AGENT_NET_OWNER_CHANGED', 'AGENT_NET_SHARING_CLOSED'].includes((error as Error | null)?.message ?? '');
function noteLeaseFailure(s: State, live: Live, error: unknown): void {
  if (ownerChanged(error)) return;
  const status = error instanceof AgentNetSharingError ? error.status : 0;
  // 服务端不认这个分享了（分享者取消登记、服务回滚）或明确拒绝：马上退回 Device Link。
  const terminal = status === 400 || status === 403 || status === 404;
  live.failures += 1;
  if (!terminal && live.failures < MAX_LEASE_FAILURES) return;
  log.info(`share ${short(live.link.shareId)} returns to Device Link (${terminal ? 'refused ' + status : 'lease unavailable'})`);
  queueMicrotask(() => {
    if (s.live.get(live.link.shareId) !== live) return;
    forgetJoined(s, live.link.shareId, terminal ? UNSUPPORTED_COOLDOWN_MS : RETRY_COOLDOWN_MS);
  });
}

function install(s: State, link: JoinedLink): void {
  const target = bound;
  if (!target || s.live.has(link.shareId) || !guestEligible()) return;
  const route = link.route;
  const guard = () => {
    s.guard();
    const current = s.vault.joined.find(j => j.shareId === link.shareId);
    if (bound !== target || state !== s || !current || current.seed !== link.seed || current.memberId !== link.memberId
      || readDeviceLinkSettings().agentNetEnabled !== true) throw new Error('AGENT_NET_OWNER_CHANGED');
  };
  const identity = transportIdentity(link.shareId, link.seed);
  const lease = new AgentNetSharingTransport({ client: businessClient(s, route), applicant: signer(identity), assertCurrent: guard,
    verifyCertificate, verifyDelegation, scope: { kind: 'provider-share', resourceId: link.shareId, networkId: route.networkId,
      rootPublicKey: route.rootPublicKey, hostDeviceId: route.hostDeviceId, memberId: link.memberId,
      guestSubject: agentNetSharingSubject(getCurrentUserId()!, getActiveAuthRealm(), route.region) } });
  const live: Live = { link, lease, failures: 0 };
  live.client = new DeviceLinkClient({ ...target.options, scopedPeersOnly: true, frameAuth: undefined, directRuntime: undefined,
    getWsUrl: () => route.server.replace(/^http/, 'ws') + '/api/agent-net/guest/ws',
    transportAllowed: () => { try { guard(); return true; } catch { return false; } },
    getToken: async () => { guard(); return 'agent-net-scoped-node'; },
    createWebSocket: async () => {
      guard();
      let delegation: Delegation;
      try { delegation = await lease.acquire(); }
      catch (error) { if (s.live.get(link.shareId) === live) noteLeaseFailure(s, live, error); throw error; }
      guard(); live.failures = 0;
      const api = new AgentNetClient(route.server, identity, delegation.issuerCertificate, route.rootPublicKey, delegation, { fetch: outboundFetch,
        createWebSocket: (url, options) => openLinkWebSocket('agent-net', url, options) });
      const socket = await openScopedAgentNetAppSocket(api, guard); guard();
      live.api = api; live.socket = socket;
      let renewal: ReturnType<typeof setTimeout> | undefined, ended = false;
      const schedule = (retry = false) => {
        if (ended || !live.api?.delegation) return;
        renewal = setTimeout(() => { void renew(); }, retry ? 5000 : Math.max(1000, live.api.delegation.expiresAt - Date.now() - 60_000));
        renewal.unref();
      };
      const renew = async () => {
        try {
          guard(); if (ended || live.socket !== socket) return;
          const next = await lease.acquire(); guard(); if (ended || live.socket !== socket) return;
          const client = new AgentNetClient(route.server, identity, next.issuerCertificate, route.rootPublicKey, next, api.transport);
          await socket.replaceClient(client); guard(); live.api = client; live.failures = 0; schedule();
        } catch (error) {
          if (ended || live.socket !== socket || ownerChanged(error)) return;
          noteLeaseFailure(s, live, error);
          if (s.live.get(link.shareId) === live) schedule(true);
        }
      };
      schedule();
      socket.once('close', () => {
        ended = true; if (renewal) clearTimeout(renewal);
        if (live.socket === socket) { live.socket = undefined; live.api = undefined; }
      });
      return socket;
    } });
  s.live.set(link.shareId, live);
  live.client.start();
}

function noteHostPresence(s: State, shareId: string, online: boolean): boolean {
  const wasOnline = s.hostOnline.get(shareId);
  s.hostOnline.set(shareId, online);
  if (wasOnline === false && online && s.cooldown.has(shareId)
    && Date.now() - (s.attemptAt.get(shareId) ?? 0) >= RECONNECT_CLEAR_FLOOR_MS) {
    s.cooldown.delete(shareId);
    return true;
  }
  return false;
}

/** 受邀者这台此刻是否已为该旧分享建起可用的 Agent-Net 连接（供组分配声明支持执行机换线）。 */
export function hasLinkedProviderShareGuest(shareId: string): boolean {
  const s = currentState();
  return !!s && guestEligible() && !!s.live.get(shareId)?.socket;
}

/** 组主机刚在 Agent-Net 上签发了某台执行机：在中转目录推送到达前的几十毫秒窗口内先把选路钉到该分享连接上。 */
export function noteLinkedProviderShareExecutor(shareId: string, executorDeviceId: string, expiresAt: number): void {
  const s = currentState();
  const link = s?.vault.joined.find(j => j.shareId === shareId);
  if (!s || !link || executorDeviceId === link.route.hostDeviceId || expiresAt <= Date.now()) return;
  const now = Date.now();
  for (const [k, until] of s.notedExecutors) if (until <= now) s.notedExecutors.delete(k);
  if (s.notedExecutors.size >= MAX_NOTED_EXECUTORS) s.notedExecutors.delete(s.notedExecutors.keys().next().value!);
  s.notedExecutors.set(JSON.stringify([shareId, executorDeviceId]), expiresAt);
}

/**
 * 每次拉到收到的分享列表后调用（约每分钟）：整理已换线路的分享，再给还没换的分享发一次登记请求
 * （一次一个，冷却期内的不问）。只做本机判断时不发任何请求。
 */
export function linkReceivedProviderShares(input: {
  received: readonly ProviderShareReceived[];
  /** 已确认的完整列表；null 表示列表还没确认，这时不因为「不在列表里」而丢掉记录。 */
  confirmedShareIds: ReadonlySet<string> | null;
  /** 已经是 Agent-Net 分享（V2）的不需要换线路。 */
  isAgentNetShare(shareId: string): boolean;
  invoke: ShareInvoke | null;
}): void {
  let s: State;
  try { s = owner(); } catch { return; }
  s.lastPoll = input;
  const byId = new Map(input.received.map(share => [share.shareId, share]));
  for (const share of input.received) {
    if (share.hostDeviceId) s.hostDevices.set(share.shareId, share.hostDeviceId);
    noteHostPresence(s, share.shareId, Boolean(share.hostDeviceOnline ?? share.hostOnline));
  }
  for (const link of [...s.vault.joined]) {
    const share = byId.get(link.shareId);
    const stale = share ? share.status !== 'active' || share.memberId !== link.memberId || share.hostDeviceId !== link.route.hostDeviceId
      : !!input.confirmedShareIds && !input.confirmedShareIds.has(link.shareId);
    if (stale) forgetJoined(s, link.shareId);
  }
  if (!guestEligible()) return;
  for (const link of s.vault.joined) install(s, link);
  if (s.linking || !input.invoke) return;
  const now = Date.now(), realm = getActiveAuthRealm();
  const candidate = input.received.find(share => share.status === 'active' && (share.hostDeviceOnline ?? share.hostOnline)
    && share.owner.region === realm && !s.vault.joined.some(j => j.shareId === share.shareId)
    && (s.cooldown.get(share.shareId) ?? 0) <= now && !input.isAgentNetShare(share.shareId));
  if (!candidate) return;
  s.linking = candidate.shareId;
  void linkOne(s, candidate, input.invoke)
    .catch((error: unknown) => { if (!ownerChanged(error)) log.warn(`moving share ${short(candidate.shareId)} to Agent-Net failed: ${String(error)}`); })
    .finally(() => { if (s.linking === candidate.shareId) s.linking = null; });
}

async function linkOne(s: State, share: ProviderShareReceived, invoke: ShareInvoke): Promise<void> {
  s.attemptAt.set(share.shareId, Date.now());
  const seed = randomBytes(32).toString('base64url');
  const identity = transportIdentity(share.shareId, seed);
  let result: InvokeResultPayload;
  try {
    result = await invoke(`share:${share.shareId}`, PROVIDER_SHARE_AGENT_NET_LINK_CHANNEL,
      [{ version: 1, signingKey: identity.signingKey, transportKey: identity.transportKey }]);
  } catch {
    if (state === s) s.cooldown.set(share.shareId, Date.now() + RETRY_COOLDOWN_MS);
    return;
  }
  if (state !== s) return;
  try { s.guard(); } catch { return; }
  if (!result.ok) {
    // 旧版本的分享者不认识这个通道。
    const old = result.error.code === 'CHANNEL_NOT_ALLOWED';
    s.cooldown.set(share.shareId, Date.now() + (old ? UNSUPPORTED_COOLDOWN_MS : RETRY_COOLDOWN_MS));
    if (old) log.info(`share ${short(share.shareId)} stays on Device Link: the sharer's Cindy is older`);
    return;
  }
  const parsed = parseProviderShareAgentNetLinkResponse(result.result);
  if (!parsed || 'unavailable' in parsed) {
    const reason = parsed && 'unavailable' in parsed ? parsed.unavailable : 'invalid';
    s.cooldown.set(share.shareId, Date.now() + (reason === 'relay-unsupported' || reason === 'invalid' ? UNSUPPORTED_COOLDOWN_MS : RETRY_COOLDOWN_MS));
    log.info(`share ${short(share.shareId)} stays on Device Link (${reason})`);
    return;
  }
  const route = { ...parsed.route, server: stripSlash(parsed.route.server) };
  // 只接受和本机同一个官方 Agent-Net 服务、同一个区域、就是这个分享那台电脑的线路。
  if (!guestEligible() || route.server !== officialAgentNetBase() || route.region !== getActiveAuthRealm()
    || route.hostDeviceId !== share.hostDeviceId || !route.networkId.startsWith('account:') || !routeValid(route)) {
    s.cooldown.set(share.shareId, Date.now() + UNSUPPORTED_COOLDOWN_MS);
    log.warn(`share ${short(share.shareId)} offered an Agent-Net route this computer does not accept`);
    return;
  }
  if (s.vault.joined.length >= MAX_LINKS) return;
  const link: JoinedLink = { shareId: share.shareId, memberId: share.memberId, seed, route };
  save(s, { ...s.vault, joined: [...s.vault.joined.filter(j => j.shareId !== share.shareId), link] });
  log.info(`share ${short(share.shareId)} moves to Agent-Net`);
  install(s, link);
}

/**
 * 会话选路（agentNetSharing.ts 的 sessionRoute）：受邀者这边已换线路的分享（含分享主机及其签名的组内执行机）
 * 用它的 Agent-Net 连接；连接还没起来时为 null（照旧走 Device Link）；不是换过线路的对端为 undefined（按原来的规则）。
 */
export function linkedProviderShareSessionSocket(peer: string): AgentNetAppSocket | null | undefined {
  try { return sessionSocketFor(peer); } catch { return undefined; }
}
function sessionSocketFor(peer: string): AgentNetAppSocket | null | undefined {
  const p = parseProviderSharePeer(peer);
  const s = p?.role === 'host' ? currentState() : null;
  const link = s?.vault.joined.find(j => j.shareId === p!.shareId);
  if (!s || !link) return undefined;
  const live = s.live.get(link.shareId);
  if (p!.deviceId === link.route.hostDeviceId) return live?.socket ?? null;
  const notedKey = JSON.stringify([link.shareId, p!.deviceId]);
  const notedUntil = s.notedExecutors.get(notedKey) ?? 0;
  if (notedUntil > 0 && notedUntil <= Date.now()) s.notedExecutors.delete(notedKey);
  if (!live?.socket?.scopedPeerTarget(peer) && notedUntil <= Date.now()) return undefined;
  return live?.socket ?? null;
}

/** 发往换过线路的分享的附件：连接通着时走 Agent-Net 附件，否则返回 null（照旧走 Device Link 附件）。 */
export function linkedProviderShareMediaTarget(peer: string) {
  try { return mediaTargetFor(peer); } catch { return null; }
}
function mediaTargetFor(peer: string) {
  const p = parseProviderSharePeer(peer);
  if (!p) return null;
  if (p.role === 'host') {
    const s = currentState();
    const link = s?.vault.joined.find(j => j.shareId === p.shareId), live = s?.live.get(p.shareId);
    if (!link || !live?.socket || !live.api || !controlOnSession(peer)) return null;
    const target = live.socket.scopedPeerTarget(peer);
    if (!target || target.delegation.resourceId !== p.shareId || target.delegation.networkId !== link.route.networkId
      || target.delegation.scope?.memberId !== link.memberId || !verifyDelegation(link.route.rootPublicKey, target.delegation)) return null;
    const slot = mediaSlot(link.route, p.shareId, link.memberId);
    return { api: live.api, recipient: target.relayId, transportKey: target.transportKey, slot, grantId: target.delegation.id, binding: agentNetMediaBinding(slot) };
  }
  const s = currentState(), hosted = s?.vault.hosted.find(h => h.shareId === p.shareId);
  if (hosted) {
    const api = hostAgentNetClient();
    if (hosted.pendingUnlink || !api || api.rootPublicKey !== hosted.route.rootPublicKey || api.certificate.networkId !== hosted.route.networkId
      || !controlOnSession(peer)) return null;
    const target = currentAgentNetScopedTarget(peer);
    if (!target || target.delegation.resourceId !== p.shareId || target.delegation.networkId !== hosted.route.networkId
      || target.delegation.scope?.memberId !== p.memberId || !verifyDelegation(hosted.route.rootPublicKey, target.delegation)) return null;
    const slot = mediaSlot(hosted.route, p.shareId, p.memberId);
    return { api, recipient: target.relayId, transportKey: target.transportKey, slot, grantId: target.delegation.id, binding: agentNetMediaBinding(slot) };
  }
  if (!controlOnSession(peer)) return null;
  const verified = executorVerifiedTarget(peer);
  if (!verified) return null;
  const slot = mediaSlot({ rootPublicKey: verified.api.rootPublicKey, networkId: verified.api.certificate.networkId }, p.shareId, p.memberId);
  return { api: verified.api, recipient: verified.target.relayId, transportKey: verified.target.transportKey,
    slot, grantId: verified.proof.id, binding: agentNetMediaBinding(slot) };
}

/** 读换过线路的分享发来的附件：只认本机登记过的分区或本机经主人签名授权的执行机分区，附件键本身不提供地址。 */
export function linkedProviderShareMediaClient(slot: string, networkId: string, caller?: string): AgentNetClient | null {
  try { return mediaClientFor(slot, networkId, caller); } catch { return null; }
}
function mediaClientFor(slot: string, networkId: string, caller?: string): AgentNetClient | null {
  const p = parseProviderSharePeer(caller);
  if (!p) return null;
  if (p.role === 'guest') {
    const s = currentState(), hosted = s?.vault.hosted.find(h => h.shareId === p.shareId);
    if (hosted) {
      if (hosted.pendingUnlink || hosted.route.networkId !== networkId || mediaSlot(hosted.route, p.shareId, p.memberId) !== slot) return null;
      const api = hostAgentNetClient();
      return api && api.rootPublicKey === hosted.route.rootPublicKey && api.certificate.networkId === networkId ? api : null;
    }
    const verified = caller ? executorVerifiedTarget(caller) : null;
    if (!verified || verified.api.certificate.networkId !== networkId) return null;
    const expected = mediaSlot({ rootPublicKey: verified.api.rootPublicKey, networkId }, p.shareId, p.memberId);
    return expected === slot ? verified.api : null;
  }
  const s = currentState(), link = s?.vault.joined.find(j => j.shareId === p.shareId);
  if (!link || link.route.networkId !== networkId || mediaSlot(link.route, p.shareId, link.memberId) !== slot) return null;
  return s!.live.get(p.shareId)?.api ?? null;
}

/** 拓扑面板只读视图：已换到 Agent-Net 的旧分享在连接就绪且没被旧链路占住时按 `agent-net` 展示。 */
export function linkedProviderShareRouteViews(
  linkByShare: ReadonlyMap<string, DeviceLinkPeerLinkView>,
): DeviceLinkProviderShareRouteView[] {
  const s = currentState();
  if (!s || !guestEligible()) return [];
  const out: DeviceLinkProviderShareRouteView[] = [];
  for (const joined of s.vault.joined) {
    const live = s.live.get(joined.shareId), sock = live?.socket;
    if (!sock) continue;
    const link = linkByShare.get(joined.shareId) ?? null;
    if (link?.open && !controlOnSession(link.deviceId)) continue;
    const peerKey = link?.deviceId ?? providerShareHostPeer(joined.shareId, joined.route.hostDeviceId);
    const targetId = sock.sessionDevice?.(peerKey) ?? peerKey;
    const snap = sock.peerSnapshot(targetId);
    const scopedRelay = sock.relayRoute?.() ?? null;
    out.push({
      shareId: joined.shareId,
      path: snap?.path ?? (link?.open ? link.path : null),
      protocol: 'agent-net',
      rttMs: snap?.rttMs ?? (link?.open ? link.rttMs : null),
      sentAgoMs: link?.sentAgoMs ?? null,
      receivedAgoMs: link?.receivedAgoMs ?? null,
      relayKind: 'official',
      relayHost: null,
      ...(scopedRelay?.via ? { relayTransport: scopedRelay.via } : {}),
      relayRttMs: scopedRelay?.rttMs ?? null,
      region: joined.route.region,
    });
  }
  return out;
}

/** 跟着 agentNetSharing.ts 的 bindAgentNetSharing：Agent-Net 开关、账号或中转一变，连接整批重建。 */
export function bindLinkedProviderShares(client: RoutedDeviceLinkClient, options: ScopedConnectionOptions): () => void {
  stopLinkedProviderShares();
  const offPresence = typeof client.onPresenceChanged === 'function' ? client.onPresenceChanged(snap => {
    const p = parseProviderSharePeer(snap.deviceId);
    const s = p?.role === 'host' ? currentState() : null;
    if (!s || s.hostDevices.get(p!.shareId) !== p!.deviceId) return;
    if (!noteHostPresence(s, p!.shareId, snap.online) || !s.lastPoll) return;
    linkReceivedProviderShares({
      ...s.lastPoll,
      received: s.lastPoll.received.map(share => share.shareId === p!.shareId
        ? { ...share, hostOnline: true, hostDeviceOnline: true } : share),
    });
  }) : undefined;
  const target = { client, options, offPresence };
  bound = target;
  try {
    const s = owner();
    for (const link of s.vault.joined) install(s, link);
  } catch (error) {
    if ((error as Error)?.message !== 'AGENT_NET_OWNER_CHANGED') log.warn(`linked shares unavailable: ${String(error)}`);
  }
  return () => { if (bound === target) stopLinkedProviderShares(); };
}
/** 主连接刚连上：已换线路、此前因为 Agent-Net 还没就绪没连的分享现在连。 */
export function ensureLinkedProviderShares(): void {
  if (!bound) return;
  try {
    const s = owner();
    for (const link of s.vault.joined) install(s, link);
  } catch { /* 账号切换中：下一次绑定再装。 */ }
}
export function stopLinkedProviderShares(): void {
  bound?.offPresence?.();
  bound = null;
  if (!state) return;
  for (const live of state.live.values()) stopLive(live);
  state.live.clear();
}

export const __testing = {
  reset(): void {
    bound?.offPresence?.();
    if (state) retire(state);
    state = null; bound = null; unlinkRetryAt.clear(); executorWrites.clear(); controlOnSession = () => false;
  },
  mediaSlot,
  transportIdentity,
};
