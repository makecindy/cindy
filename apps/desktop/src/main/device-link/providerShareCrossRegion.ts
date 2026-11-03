/**
 * 供应商分享 · 跨区域受邀者(P3，契约 docs/provider-sharing-contract.md §6)。
 *
 * 分享属于分享者所在区域。受邀者在另一个官方区域时：
 *  - 从不把自己区域的 Access Token 发给对方区域；只用自己区域签发的身份名片(只含昵称与头像)
 *    换取只限分享的凭证；
 *  - 对方区域的服务地址只取自内置的对方区域清单，链接里的地址只用来比对；
 *  - 凭证只在内存里，过期或重启后用新名片重新换取；
 *  - 分享属于账号：每台已登录电脑都自动向对方官方区域核验已有分享，不依赖本机加入记录；
 *    本机标记只保留兼容记录，不决定账号是否有分享；
 *  - 远程 Agent 经第二条 relay 连接(对方区域，`ProviderShareGuest` 认证)访问分享者电脑。
 * 对方区域关闭跨区开关时，接口返回 PROVIDER_SHARE_CROSS_REGION_DISABLED，同区域分享不受影响。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';
import WebSocket from 'ws';

import {
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
  DeviceLinkClient,
  DeviceLinkError,
  PROVIDER_SHARE_RELAY_CAPABILITY,
  parseProviderSharePeer,
  providerShareLinkRegion,
  providerShareParsers,
  type InvokeResultPayload,
  type ProviderShareInvitationIntent,
  type ProviderShareLinkPreview,
  type ProviderShareReceived,
  type ProviderShareRequestState,
} from '@cindy/device-link';

import { getActiveAuthRealm, getAuthState, getCurrentUserId, getDeviceId } from '../authManager.js';
import { getClientEndpointForRealm, loadClientEndpointsForRealm } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { createOutboundHttpAgent } from '../maker-host/outbound-fetch.js';
import { serverApiFetch } from '../serverApiClient.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { deviceName } from './deviceName.js';
import { desktopDirectRuntime } from './directLink.js';
import { fetchIdentityCard, rethrowProviderShareError, sha256Hex } from './providerShareApi.js';

const log = createLogger('provider-share:cross-region');

type Region = 'cn' | 'global';

const API_PREFIX = '/api/device-link/provider-shares/x';
const WS_PATH = '/api/device-link/ws';
/** 凭证 24 小时过期；提前一小时轮换。 */
const CREDENTIAL_REFRESH_MARGIN_MS = 60 * 60_000;
const SESSION_REFRESH_MS = 12 * 60 * 60_000;
/** 尚无分享时也定期发现账号在其它电脑新接受的分享，不建立空 relay。 */
const EMPTY_DISCOVERY_MS = 5 * 60_000;
const ONLINE_WAIT_MS = 8_000;
const MARKER_FILE = 'provider-share-regions.json';
const GROUP_RECOVERY_INTERVAL_MS = 30_000;

export interface CrossRegionEvents {
  changed(): void;
  catalogChanged?(agentDeviceId: string): void;
}

interface RegionState {
  region: Region;
  apiBase: string;
  credential: string | null;
  expiresAt: number;
  shares: ProviderShareReceived[];
  client: DeviceLinkClient | null;
  refreshing: Promise<void> | null;
  refreshingRevision: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 连续失败次数，用于退避重试(网络或对方区域暂时不可用时不让分享整段消失)。 */
  failures: number;
  loaded: boolean;
  requestRevision: number;
}

interface Runtime {
  events: CrossRegionEvents;
  account: string;
  regions: Map<Region, RegionState>;
  stopped: boolean;
  groupRecovery: Promise<void> | null;
  nextGroupRecoveryAt: number;
}

let runtime: Runtime | null = null;
let userDataDir: string | null = null;
let markerWrites: Promise<void> = Promise.resolve();

function peerRegion(): Region {
  return getActiveAuthRealm() === 'cn' ? 'global' : 'cn';
}

function accountKey(): string | null {
  const id = getCurrentUserId();
  return id ? sha256Hex(`${getActiveAuthRealm()}:${id}`) : null;
}

function current(rt: Runtime): boolean {
  return runtime === rt && !rt.stopped && getAuthState().isAuthenticated && accountKey() === rt.account;
}

// ─── 本机标记(不含凭证) ─────────────────────────────────────────

function markerPath(): string | null {
  return userDataDir ? path.join(userDataDir, 'remote-agent', MARKER_FILE) : null;
}

function readMarkers(field: 'accounts' | 'emptyAccounts' = 'accounts', file = markerPath()): Record<string, Region[]> {
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; accounts?: unknown; emptyAccounts?: unknown };
    const records = parsed[field];
    if (parsed.version !== 1 || !records || typeof records !== 'object') return {};
    const out: Record<string, Region[]> = {};
    for (const [key, value] of Object.entries(records as Record<string, unknown>)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(value)) continue;
      out[key] = value.filter((item): item is Region => item === 'cn' || item === 'global');
    }
    return out;
  } catch {
    return {};
  }
}

function writeMarker(account: string, region: Region, present: boolean, confirmedEmpty = false, isCurrent = () => true): Promise<void> {
  const file = markerPath();
  if (!file) return Promise.resolve();
  // 整份文件共享一条写链；读取也必须在队列内，失败不能阻塞后续账号/区域的更新。
  const write = markerWrites.then(() => writeMarkerFile(file, account, region, present, confirmedEmpty, isCurrent));
  markerWrites = write.catch(() => undefined);
  return write;
}

async function writeMarkerFile(file: string, account: string, region: Region, present: boolean, confirmedEmpty: boolean, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  const markers = readMarkers('accounts', file);
  // 空名单保留旧版本的收藏清理兼容记录；新申请使旧结论失效。
  const emptyAccounts = readMarkers('emptyAccounts', file);
  const emptyRegions = new Set(emptyAccounts[account] ?? []);
  if (confirmedEmpty && !present) emptyRegions.add(region);
  else emptyRegions.delete(region);
  if (emptyRegions.size > 0) emptyAccounts[account] = [...emptyRegions];
  else delete emptyAccounts[account];
  const regions = new Set(markers[account] ?? []);
  if (present) regions.add(region);
  else regions.delete(region);
  if (regions.size > 0) markers[account] = [...regions];
  else delete markers[account];
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, accounts: markers, emptyAccounts }), { encoding: 'utf8', mode: 0o600 });
    if (isCurrent()) await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// ─── 对方区域 REST(不带本区域 Access Token) ───────────────────────

async function peerApiBase(region: Region): Promise<string> {
  await loadClientEndpointsForRealm(region);
  return getClientEndpointForRealm(region, 'deviceLinkApiBaseUrl');
}

async function peerRequest(
  base: string,
  pathname: string,
  body: unknown,
  credential?: string,
): Promise<Record<string, unknown>> {
  try {
    const value = await serverApiFetch<unknown>(`${API_PREFIX}${pathname}`, {
      method: 'POST',
      body,
      baseUrl: base,
      // 不带本区域 Access Token，也不因对方区域的 401 刷新或登出本区域账号。
      token: null,
      skipAutoRefresh: true,
      skipSessionInvalidation: true,
      ...(credential ? { headers: { Authorization: `ProviderShareGuest ${credential}` } } : {}),
      timeoutMs: 15_000,
      cache: 'no-store',
      logLabel: API_PREFIX,
      redactErrorDetails: true,
      allowedRedactedErrorCodes: [
        'NOT_FOUND', 'CONFLICT', 'PERMISSION_DENIED', 'INVALID_PARAMS', 'BAD_REQUEST', 'RATE_LIMITED',
        'PROVIDER_SHARE_LINK_USED', 'PROVIDER_SHARE_LINK_EXPIRED', 'PROVIDER_SHARE_SELF', 'PROVIDER_SHARE_ALREADY_MEMBER',
        'PROVIDER_SHARE_IDENTITY_INVALID', 'PROVIDER_SHARE_CROSS_REGION_DISABLED',
      ],
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider share response');
    return value as Record<string, unknown>;
  } catch (error) {
    rethrowProviderShareError(error);
  }
}

/**
 * 链接属于哪个区域：本区域返回 null(走同区域流程)，对方官方区域返回该区域；
 * 其他地址一律拒绝。
 */
export async function crossRegionOfIntent(intent: ProviderShareInvitationIntent, localBase: string): Promise<Region | null> {
  if (providerShareLinkRegion(intent, { local: localBase }) === 'local') return null;
  const region = peerRegion();
  let base: string;
  try {
    base = await peerApiBase(region);
  } catch {
    throwIpcError('REGION_MISMATCH', 'This link belongs to another Cindy service');
  }
  if (providerShareLinkRegion(intent, { peer: base }) !== 'peer') throwIpcError('INVALID_PARAMS', 'Unknown provider share service');
  return region;
}

/** 服务端确认已是成员时，恢复本机尚未加载的分享；提示仍沿用「已在使用」。 */
async function recoverExistingMembership(rt: Runtime | null, region: Region, error: unknown): Promise<void> {
  if (!rt || !current(rt) || !error || typeof error !== 'object'
    || !('code' in error) || error.code !== 'PROVIDER_SHARE_ALREADY_MEMBER') return;
  const state = rt.regions.get(region);
  if (state) {
    // 成员确认比在途旧名单更新；旧空名单不能撤销本次恢复。
    state.requestRevision += 1;
    if (state.shares.length === 0) state.loaded = false;
  }
  // 已确认的往来先落盘：暂时断网或重启后仍可沿原退避路径恢复。
  await writeMarker(rt.account, region, true, false, () => current(rt)).catch((error) =>
    log.warn('cross-region marker write failed', { error: String(error) }));
  if (current(rt)) await refreshRegion(rt, region);
}

/** An invitation belongs to the account/runtime that began it, including before startup. */
function assertRequestCurrent(rt: Runtime | null, account: string | null): void {
  if (!account || accountKey() !== account || runtime !== rt || (rt && !current(rt))) {
    throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Account changed');
  }
}

export async function crossRegionPreview(region: Region, invitation: string): Promise<ProviderShareLinkPreview> {
  const account = accountKey();
  const rt = runtime;
  const base = await peerApiBase(region);
  assertRequestCurrent(rt, account);
  const identityCard = await fetchIdentityCard('share-request', sha256Hex(invitation));
  assertRequestCurrent(rt, account);
  const value = await peerRequest(base, '/preview', { invitation, identityCard }).catch(async (error: unknown) => {
    await recoverExistingMembership(rt, region, error);
    throw error;
  });
  return providerShareParsers.preview(value);
}

export interface CrossRegionRequest {
  state: ProviderShareRequestState;
  requestToken: string;
}

export async function crossRegionSendRequest(region: Region, invitation: string): Promise<CrossRegionRequest> {
  const account = accountKey();
  if (!account) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Not signed in');
  const rt = runtime;
  const base = await peerApiBase(region);
  assertRequestCurrent(rt, account);
  const identityCard = await fetchIdentityCard('share-request', sha256Hex(invitation));
  assertRequestCurrent(rt, account);
  const value = await peerRequest(base, '/requests', { invitation, identityCard }).catch(async (error: unknown) => {
    await recoverExistingMembership(rt, region, error);
    throw error;
  });
  const result = { state: providerShareParsers.requestState(value), requestToken: providerShareParsers.secret(value.requestToken) };
  if (rt && current(rt) && rt.account === account) {
    const state = rt.regions.get(region);
    if (state) {
      // 先使在途旧名单失效，再排队落盘；旧空名单不能清理新申请对应的收藏。
      state.requestRevision += 1;
      if (state.shares.length === 0) state.loaded = false;
    }
  }
  // 记下「这个账号在对方区域有往来」，之后才会去对方区域拉分享。
  await writeMarker(account, region, true).catch((error) => log.warn('cross-region marker write failed', { error: String(error) }));
  return result;
}

export async function crossRegionGetRequest(region: Region, requestId: string, requestToken: string): Promise<ProviderShareRequestState> {
  const base = await peerApiBase(region);
  return providerShareParsers.requestState(await peerRequest(base, `/requests/${encodeURIComponent(requestId)}`, { requestToken }));
}

export async function crossRegionWithdraw(region: Region, requestId: string, requestToken: string): Promise<void> {
  const base = await peerApiBase(region);
  await peerRequest(base, `/requests/${encodeURIComponent(requestId)}/withdraw`, { requestToken });
}

// ─── 分享连接 ────────────────────────────────────────────────────

function createClient(rt: Runtime, state: RegionState): DeviceLinkClient {
  const wsUrl = state.apiBase.replace(/^http/, 'ws') + WS_PATH;
  const client = new DeviceLinkClient({
    // The capture process is shared with the local-region client. A cross-region
    // socket closing must only close its own sessions, never suspend that process.
    directRuntime: { create: (id, events) => desktopDirectRuntime.create(id, events) },
    getWsUrl: () => wsUrl,
    authorizationScheme: 'ProviderShareGuest',
    getToken: async () => {
      if (!current(rt)) return null;
      if (!state.credential || Date.now() > state.expiresAt - CREDENTIAL_REFRESH_MARGIN_MS) await refreshRegion(rt, state.region);
      return state.credential;
    },
    getHello: () => ({
      capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY],
      deviceName: deviceName(),
      platform: process.platform,
      appVersion: app.getVersion(),
      // 这条连接只用来使用别人分享的供应商，本机不接受对方区域的任何控制。
      remoteControlEnabled: false,
      busy: false,
    }),
    createWebSocket: async (url, headers) => new WebSocket(url, {
      headers,
      agent: await createOutboundHttpAgent(url),
    } as WebSocket.ClientOptions),
    logger: {
      debug: (...args) => log.debug(...args),
      info: (...args) => log.info(...args),
      warn: (...args) => log.warn(...args),
      error: (...args) => log.error(...args),
    },
    timing: { pingIntervalMs: 15_000 },
  });
  client.onFrame?.(frame => {
    if (!current(rt) || frame.kind !== 'push' || !frame.src) return;
    const peer = parseProviderSharePeer(frame.src);
    const payload = frame.payload as { channel?: unknown };
    if (peer?.role !== 'host' || payload?.channel !== 'maker:provider:changed') return;
    if (state.shares.some(share => share.shareId === peer.shareId && share.hostDeviceId === peer.deviceId && share.status === 'active')) {
      rt.events.catalogChanged?.(`share:${peer.shareId}`);
    }
  });
  client.start();
  return client;
}

function scheduleRefresh(rt: Runtime, state: RegionState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (!current(rt)) return;
  state.timer = setTimeout(() => { void refreshRegion(rt, state.region); },
    state.shares.length > 0 ? SESSION_REFRESH_MS : EMPTY_DISCOVERY_MS);
  (state.timer as { unref?: () => void }).unref?.();
}

function initialRegionState(region: Region, loaded = false): RegionState {
  return { region, apiBase: '', credential: null, expiresAt: 0, shares: [], client: null, refreshing: null, refreshingRevision: 0, timer: null, failures: 0, loaded, requestRevision: 0 };
}

/** 用新名片换取这台电脑在对方区域的分享列表与连接凭证。 */
function refreshRegion(rt: Runtime, region: Region): Promise<void> {
  let state = rt.regions.get(region);
  if (state?.refreshing) {
    // 新申请获批后的刷新不能仅等待旧一轮；排在旧请求后补读，不提前查询待审批申请。
    return state.refreshingRevision === state.requestRevision ? state.refreshing
      : state.refreshing.then(() => current(rt) ? refreshRegion(rt, region) : undefined);
  }
  if (!state) {
    state = initialRegionState(region);
    rt.regions.set(region, state);
  }
  const target = state;
  if (target.timer) clearTimeout(target.timer);
  target.timer = null;
  const revision = target.requestRevision;
  target.refreshingRevision = revision;
  const isCurrent = () => current(rt) && target.requestRevision === revision;
  const run = (async () => {
    try {
      const deviceId = getDeviceId();
      if (!deviceId) return;
      const base = await peerApiBase(region);
      if (!isCurrent()) return;
      const identityCard = await fetchIdentityCard('share-session', sha256Hex(deviceId));
      if (!isCurrent()) return;
      const value = await peerRequest(base, '/session', {
        identityCard,
        deviceId,
        deviceName: deviceName(),
        platform: process.platform,
      });
      if (!isCurrent()) return;
      const shares = providerShareParsers.receivedList(value);
      const credential = value.credential === null || value.credential === undefined ? null : providerShareParsers.secret(value.credential);
      const expiresAt = credential ? Date.parse(providerShareParsers.timestamp(value.expiresAt)) : 0;
      state = target;
      state.failures = 0;
      state.apiBase = base;
      state.credential = credential;
      state.expiresAt = expiresAt;
      state.shares = shares;
      state.loaded = true;
      if (shares.length === 0 || !credential) {
        state.client?.stop();
        state.client = null;
      }
      await writeMarker(rt.account, region, shares.length > 0 && !!credential, shares.length === 0, isCurrent).catch((error) =>
        log.warn('cross-region marker write failed', { error: String(error) }));
      if (!isCurrent()) return;
      if (shares.length > 0 && credential && !state.client) {
        state.client = createClient(rt, state);
      }
      scheduleRefresh(rt, state);
      rt.events.changed();
    } catch (error) {
      if (isCurrent()) {
        log.warn('cross-region session refresh failed', { region, error: error instanceof Error ? error.message : String(error) });
        // 退避重试：1 → 2 → 4 … 最多 30 分钟；关闭跨区开关等确定性错误同样按退避慢慢重试。
        target.failures += 1;
        if (target.timer) clearTimeout(target.timer);
        target.timer = setTimeout(() => { void refreshRegion(rt, region); }, Math.min(30 * 60_000, 60_000 * 2 ** Math.min(target.failures - 1, 5)));
        (target.timer as { unref?: () => void }).unref?.();
      }
    } finally {
      target.refreshing = null;
      if (current(rt) && target.requestRevision !== revision) scheduleRefresh(rt, target);
    }
  })();
  target.refreshing = run;
  return run;
}

export function startProviderShareCrossRegion(events: CrossRegionEvents, options: { userDataDir: string }): void {
  stopProviderShareCrossRegion();
  userDataDir = options.userDataDir;
  const account = accountKey();
  if (!account || !getAuthState().isAuthenticated) return;
  const rt: Runtime = { events, account, regions: new Map(), stopped: false, groupRecovery: null, nextGroupRecoveryAt: 0 };
  runtime = rt;
  // 接受分享的是账号；另一台电脑的本地标记和旧空名单都不能决定本机的账号成员关系。
  // 与本区独立加载，只让官方服务确认已有授权，不发起新的分享申请。
  void refreshRegion(rt, peerRegion());
}

export function stopProviderShareCrossRegion(): void {
  const rt = runtime;
  if (!rt) return;
  rt.stopped = true;
  for (const state of rt.regions.values()) {
    if (state.timer) clearTimeout(state.timer);
    state.client?.stop();
    state.client = null;
    state.credential = null;
  }
  runtime = null;
}

/** 申请被同意后：在对方区域登记这台电脑并连上。 */
export function refreshProviderShareCrossRegion(region: Region): Promise<void> {
  const rt = runtime;
  return rt && current(rt) ? refreshRegion(rt, region) : Promise.resolve();
}

/**
 * A verified same-account group references shares already accepted on another computer.
 * Register this computer with the official peer region; its server still decides membership.
 * Never call this for renderer hints, favorites or arbitrary missing share IDs.
 */
export function restoreCrossRegionReceivedForRemoteGroup(shareIds: readonly string[]): Promise<void> {
  const rt = runtime;
  if (!rt || !current(rt) || shareIds.length === 0) return Promise.resolve();
  const region = peerRegion();
  const state = rt.regions.get(region);
  if (shareIds.every((id) => state?.shares.some((share) => share.shareId === id))) return Promise.resolve();
  if (rt.groupRecovery) return rt.groupRecovery;
  if (state?.refreshing) return state.refreshing;
  if ((state?.failures && state.timer) || Date.now() < rt.nextGroupRecoveryAt) return Promise.resolve();
  rt.nextGroupRecoveryAt = Date.now() + GROUP_RECOVERY_INTERVAL_MS;
  // A previously confirmed empty list is stale once another computer reports membership.
  if (state && state.shares.length === 0) state.loaded = false;
  const run = (async () => {
    await writeMarker(rt.account, region, true, false, () => current(rt)).catch((error) =>
      log.warn('cross-region marker write failed', { error: String(error) }));
    if (current(rt)) await refreshRegion(rt, region);
  })().finally(() => { rt.groupRecovery = null; });
  rt.groupRecovery = run;
  return run;
}

/** Missing shares are not removed until account discovery has answered successfully. */
export async function waitForCrossRegionReceived(): Promise<boolean> {
  const rt = runtime;
  if (!rt) return true;
  if (!current(rt)) return false;
  await rt.groupRecovery;
  const state = rt.regions.get(peerRegion());
  await state?.refreshing;
  return current(rt) && isCrossRegionReceivedReady() && !state?.failures;
}

export function getCrossRegionReceived(): ProviderShareReceived[] {
  return runtime && current(runtime) ? [...runtime.regions.values()].flatMap((state) => state.shares) : [];
}

/** 收藏读取只复用账号发现，不增加查询或越过失败退避。 */
export function ensureCrossRegionReceivedForFavorites(regions: readonly Region[]): void {
  const rt = runtime;
  const region = peerRegion();
  if (!rt || !current(rt) || !regions.includes(region)) return;
  const state = rt.regions.get(region);
  if (!state?.loaded && !state?.refreshing && !state?.timer) void refreshRegion(rt, region);
}

/**
 * 本账号在对方区域的名单已由服务端确认；本机没有标记不能证明账号没有分享。
 * 运行时没起来或已换账号时为 false(说不准)。
 */
export function isCrossRegionReceivedComplete(): boolean {
  const rt = runtime;
  if (!rt || !current(rt)) return false;
  return rt.regions.get(peerRegion())?.loaded === true;
}

/** 只确认已成功返回名单的区域，失败区域不能阻塞其它区域的收藏。 */
export function getConfirmedCrossRegionReceivedRegions(): Region[] {
  const rt = runtime;
  return rt && current(rt) ? [...rt.regions.values()].filter((state) => state.loaded).map((state) => state.region) : [];
}

/** 本账号的首次跨区分享查询是否已完成。 */
export function isCrossRegionReceivedReady(): boolean {
  const rt = runtime;
  // 未启动跨区 runtime 时，当前进程没有跨区分享需要等待。
  if (!rt) return true;
  if (!current(rt)) return false;
  return isCrossRegionReceivedComplete();
}

function stateForShare(shareId: string): RegionState | null {
  for (const state of runtime?.regions.values() ?? []) {
    if (state.shares.some((share) => share.shareId === shareId)) return state;
  }
  return null;
}

export function isCrossRegionShare(shareId: string): boolean {
  return stateForShare(shareId) !== null;
}

/** 远程 Agent 的请求目标是对方区域分享者电脑的 peer key 时，经对方区域的连接发送。 */
export function isCrossRegionProviderShareTarget(peerKey: string): boolean {
  const peer = parseProviderSharePeer(peerKey);
  return peer?.role === 'host' && isCrossRegionShare(peer.shareId);
}

/** Relay-confirmed link renewal refreshes the bounded direct lease on both peers. */
export async function renewCrossRegionProviderShareLink(peerKey: string): Promise<void> {
  const peer = parseProviderSharePeer(peerKey);
  const client = peer ? stateForShare(peer.shareId)?.client : null;
  if (!client) throw new DeviceLinkError('NOT_CONNECTED', 'cross-region provider share is not connected');
  await client.waitUntilOnline(ONLINE_WAIT_MS);
  await client.openLink(peerKey, {
    controllerName: deviceName(), protocolVersion: 1, appVersion: app.getVersion(),
    capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1],
  });
}

export async function crossRegionInvoke(peerKey: string, channel: string, args: unknown[], timeoutMs?: number): Promise<InvokeResultPayload> {
  const peer = parseProviderSharePeer(peerKey);
  const state = peer ? stateForShare(peer.shareId) : null;
  const client = state?.client;
  if (!client) throw new DeviceLinkError('NOT_CONNECTED', 'cross-region provider share is not connected');
  if (!client.hasOfflineDirectPath(peerKey)) await client.waitUntilOnline(ONLINE_WAIT_MS);
  const open = () => client.openLink(peerKey, {
    controllerName: deviceName(),
    protocolVersion: 1,
    appVersion: app.getVersion(),
    capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1],
  });
  if (!client.isLinkReady(peerKey)) await open();
  try {
    return await client.invoke(peerKey, { channel, args }, timeoutMs);
  } catch (error) {
    if (!(error instanceof DeviceLinkError) || error.code !== 'LINK_NOT_OPEN') throw error;
    await open();
    return client.invoke(peerKey, { channel, args }, timeoutMs);
  }
}

export async function crossRegionLeave(memberId: string): Promise<boolean> {
  const rt = runtime;
  if (!rt) return false;
  for (const state of rt.regions.values()) {
    if (!state.shares.some((share) => share.memberId === memberId)) continue;
    if (!state.credential) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Cross-region share is not connected');
    await peerRequest(state.apiBase, `/received/${encodeURIComponent(memberId)}/leave`, {}, state.credential);
    await refreshRegion(rt, state.region);
    return true;
  }
  return false;
}

/** 测试用：内部的对方区域推断与标记格式。 */
export const __testing = {
  peerRegion,
  readMarkers,
  writeMarker,
  setUserDataDir(dir: string | null) {
    userDataDir = dir;
  },
};
