/**
 * 供应商分享 · 跨区域受邀者(P3，契约 docs/provider-sharing-contract.md §6)。
 *
 * 分享属于分享者所在区域。受邀者在另一个官方区域时：
 *  - 从不把自己区域的 Access Token 发给对方区域；只用自己区域签发的身份名片(只含昵称与头像)
 *    换取只限分享的凭证；
 *  - 对方区域的服务地址只取自内置的对方区域清单，链接里的地址只用来比对；
 *  - 凭证只在内存里，过期或重启后用新名片重新换取；
 *  - 只有本账号确实在对方区域发过申请或加入过分享时，才会联系对方区域(本机记一个不含凭证的标记)，
 *    不会在每次启动时把身份发到另一个区域；
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
import { fetchIdentityCard, rethrowProviderShareError, sha256Hex } from './providerShareApi.js';

const log = createLogger('provider-share:cross-region');

type Region = 'cn' | 'global';

const API_PREFIX = '/api/device-link/provider-shares/x';
const WS_PATH = '/api/device-link/ws';
/** 凭证 24 小时过期；提前一小时轮换。 */
const CREDENTIAL_REFRESH_MARGIN_MS = 60 * 60_000;
const SESSION_REFRESH_MS = 12 * 60 * 60_000;
const ONLINE_WAIT_MS = 8_000;
const MARKER_FILE = 'provider-share-regions.json';

export interface CrossRegionEvents {
  changed(): void;
}

interface RegionState {
  region: Region;
  apiBase: string;
  credential: string | null;
  expiresAt: number;
  shares: ProviderShareReceived[];
  client: DeviceLinkClient | null;
  refreshing: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 连续失败次数，用于退避重试(网络或对方区域暂时不可用时不让分享整段消失)。 */
  failures: number;
}

interface Runtime {
  events: CrossRegionEvents;
  account: string;
  regions: Map<Region, RegionState>;
  stopped: boolean;
}

let runtime: Runtime | null = null;
let userDataDir: string | null = null;

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

function readMarkers(): Record<string, Region[]> {
  const file = markerPath();
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; accounts?: unknown };
    if (parsed.version !== 1 || !parsed.accounts || typeof parsed.accounts !== 'object') return {};
    const out: Record<string, Region[]> = {};
    for (const [key, value] of Object.entries(parsed.accounts as Record<string, unknown>)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(value)) continue;
      out[key] = value.filter((item): item is Region => item === 'cn' || item === 'global');
    }
    return out;
  } catch {
    return {};
  }
}

async function writeMarker(account: string, region: Region, present: boolean): Promise<void> {
  const file = markerPath();
  if (!file) return;
  const markers = readMarkers();
  const regions = new Set(markers[account] ?? []);
  if (present) regions.add(region);
  else regions.delete(region);
  if (regions.size > 0) markers[account] = [...regions];
  else delete markers[account];
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, accounts: markers }), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
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

export async function crossRegionPreview(region: Region, invitation: string): Promise<ProviderShareLinkPreview> {
  const base = await peerApiBase(region);
  const identityCard = await fetchIdentityCard('share-request', sha256Hex(invitation));
  return providerShareParsers.preview(await peerRequest(base, '/preview', { invitation, identityCard }));
}

export interface CrossRegionRequest {
  state: ProviderShareRequestState;
  requestToken: string;
}

export async function crossRegionSendRequest(region: Region, invitation: string): Promise<CrossRegionRequest> {
  const account = accountKey();
  if (!account) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Not signed in');
  const base = await peerApiBase(region);
  const identityCard = await fetchIdentityCard('share-request', sha256Hex(invitation));
  const value = await peerRequest(base, '/requests', { invitation, identityCard });
  const result = { state: providerShareParsers.requestState(value), requestToken: providerShareParsers.secret(value.requestToken) };
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
  client.start();
  return client;
}

function scheduleRefresh(rt: Runtime, state: RegionState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (!current(rt) || state.shares.length === 0) return;
  state.timer = setTimeout(() => { void refreshRegion(rt, state.region); }, SESSION_REFRESH_MS);
  (state.timer as { unref?: () => void }).unref?.();
}

/** 用新名片换取这台电脑在对方区域的分享列表与连接凭证。 */
function refreshRegion(rt: Runtime, region: Region): Promise<void> {
  let state = rt.regions.get(region);
  if (state?.refreshing) return state.refreshing;
  if (!state) {
    state = { region, apiBase: '', credential: null, expiresAt: 0, shares: [], client: null, refreshing: null, timer: null, failures: 0 };
    rt.regions.set(region, state);
  }
  const target = state;
  const run = (async () => {
    try {
      const deviceId = getDeviceId();
      if (!deviceId) return;
      const base = await peerApiBase(region);
      const identityCard = await fetchIdentityCard('share-session', sha256Hex(deviceId));
      const value = await peerRequest(base, '/session', {
        identityCard,
        deviceId,
        deviceName: deviceName(),
        platform: process.platform,
      });
      if (!current(rt)) return;
      const shares = providerShareParsers.receivedList(value);
      const credential = value.credential === null || value.credential === undefined ? null : providerShareParsers.secret(value.credential);
      const expiresAt = credential ? Date.parse(providerShareParsers.timestamp(value.expiresAt)) : 0;
      state = target;
      state.failures = 0;
      state.apiBase = base;
      state.credential = credential;
      state.expiresAt = expiresAt;
      state.shares = shares;
      if (shares.length === 0 || !credential) {
        state.client?.stop();
        state.client = null;
        await writeMarker(rt.account, region, false).catch(() => undefined);
      } else if (!state.client) {
        state.client = createClient(rt, state);
      }
      scheduleRefresh(rt, state);
      rt.events.changed();
    } catch (error) {
      if (current(rt)) {
        log.warn('cross-region session refresh failed', { region, error: error instanceof Error ? error.message : String(error) });
        // 退避重试：1 → 2 → 4 … 最多 30 分钟；关闭跨区开关等确定性错误同样按退避慢慢重试。
        target.failures += 1;
        if (target.timer) clearTimeout(target.timer);
        target.timer = setTimeout(() => { void refreshRegion(rt, region); }, Math.min(30 * 60_000, 60_000 * 2 ** Math.min(target.failures - 1, 5)));
        (target.timer as { unref?: () => void }).unref?.();
      }
    } finally {
      target.refreshing = null;
    }
  })();
  target.refreshing = run;
  return run;
}

export function startProviderShareCrossRegion(events: CrossRegionEvents, options: { userDataDir: string }): void {
  stopProviderShareCrossRegion();
  userDataDir = options.userDataDir;
  const account = accountKey();
  if (!account) return;
  const rt: Runtime = { events, account, regions: new Map(), stopped: false };
  runtime = rt;
  // 只联系标记过的区域(本账号在那里发过申请或加入过分享)。
  for (const region of readMarkers()[account] ?? []) {
    if (region !== peerRegion()) continue;
    void refreshRegion(rt, region);
  }
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

export function getCrossRegionReceived(): ProviderShareReceived[] {
  return runtime ? [...runtime.regions.values()].flatMap((state) => state.shares) : [];
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

export async function crossRegionInvoke(peerKey: string, channel: string, args: unknown[], timeoutMs?: number): Promise<InvokeResultPayload> {
  const peer = parseProviderSharePeer(peerKey);
  const state = peer ? stateForShare(peer.shareId) : null;
  const client = state?.client;
  if (!client) throw new DeviceLinkError('NOT_CONNECTED', 'cross-region provider share is not connected');
  await client.waitUntilOnline(ONLINE_WAIT_MS);
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
