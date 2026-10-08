/**
 * 供应商分享 · 受邀者这台电脑(guest)。
 *
 *  - 已收到的分享：REST 列表的本机缓存(同区域)，加上跨区域分享(providerShareCrossRegion)，
 *    供模型列表与远程 Agent 路由使用；
 *  - 加入：预览链接、用自己的身份名片发送申请、等待分享者同意、撤回；链接属于另一个官方区域时
 *    走跨区域流程(服务端开关关闭时提示暂不支持)；
 *  - 任务绑定：任务记录里「Agent 在哪台电脑」写成 `share:<shareId>`，发起远程 Agent 请求时
 *    在这里换成分享者那台电脑的本地 peer key(`providerShareHostPeer`)。旧版本读到这个值只会
 *    当作连不上的电脑处理。
 */
import {
  parseProviderShareInvitationIntent,
  parseProviderShareLink,
  providerShareHostPeer,
  type ProviderShareInvitationIntent,
  type ProviderShareLinkPreview,
  type ProviderShareReceived,
  type ProviderShareRequestState,
} from '@cindy/device-link';

import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAuthState } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { fetchIdentityCard, providerShareApi, providerShareOwnerKey, sha256Hex } from './providerShareApi.js';
import {
  crossRegionGetRequest,
  crossRegionLeave,
  crossRegionOfIntent,
  crossRegionPreview,
  crossRegionSendRequest,
  crossRegionWithdraw,
  getCrossRegionReceived,
  refreshProviderShareCrossRegion,
  startProviderShareCrossRegion,
  stopProviderShareCrossRegion,
} from './providerShareCrossRegion.js';

const log = createLogger('provider-share:guest');

const RECEIVED_POLL_MS = 60_000;
const RECEIVED_IDLE_POLL_MS = 5 * 60_000;
const REQUEST_POLL_MS = 4_000;
const ACCESS_FAILURE_REFRESH_MS = 10_000;
const SHARE_DEVICE_PREFIX = 'share:';
// 任务记录里的电脑 id 最长 128 个字符(含 `share:` 前缀)。
const SHARE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/;

type Region = 'cn' | 'global';

export interface ProviderShareGuestEvents {
  changed(received: readonly ProviderShareReceived[]): void;
  /** 发出的申请有了结果(同意、拒绝、过期、撤回)。 */
  settled(state: ProviderShareRequestState, preview: ProviderShareLinkPreview | null): void;
}

interface PendingRequest {
  state: ProviderShareRequestState;
  preview: ProviderShareLinkPreview | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 跨区域申请：对方区域与只限这条申请的令牌(只在内存里)。 */
  cross: { region: Region; requestToken: string } | null;
}

interface Runtime {
  events: ProviderShareGuestEvents;
  scope: string | null;
  received: ProviderShareReceived[];
  fetchedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  refreshing: Promise<void> | null;
  pending: Map<string, PendingRequest>;
  stopped: boolean;
}

interface ResolvedLink {
  intent: ProviderShareInvitationIntent;
  /** null = 本区域。 */
  region: Region | null;
}

let runtime: Runtime | null = null;

function current(rt: Runtime): boolean {
  return runtime === rt && !rt.stopped && getAuthState().isAuthenticated && !isAppSessionBoundaryPending()
    && providerShareOwnerKey() === rt.scope;
}

function requireRuntime(): Runtime {
  const rt = runtime;
  if (!rt || !current(rt)) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Provider sharing is not ready');
  return rt;
}

function allReceived(rt: Runtime | null): ProviderShareReceived[] {
  return rt ? [...rt.received, ...getCrossRegionReceived()] : [];
}

function emitChanged(rt: Runtime): void {
  if (current(rt)) rt.events.changed(allReceived(rt));
}

// ─── 任务绑定 ────────────────────────────────────────────────────

/** 任务记录里表示「Agent 在某个分享者的电脑上」的值。 */
export function providerShareAgentDeviceId(shareId: string): string {
  if (!SHARE_ID.test(shareId)) throw new Error('Invalid provider share id');
  return `${SHARE_DEVICE_PREFIX}${shareId}`;
}

export function parseProviderShareAgentDeviceId(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(SHARE_DEVICE_PREFIX)) return null;
  const shareId = value.slice(SHARE_DEVICE_PREFIX.length);
  return SHARE_ID.test(shareId) ? shareId : null;
}

export function findReceivedShare(shareId: string): ProviderShareReceived | null {
  return allReceived(runtime).find((share) => share.shareId === shareId) ?? null;
}

/**
 * 远程 Agent 的请求目标：同账号电脑原样返回；`share:<id>` 换成分享者电脑的本地 peer key。
 * 分享已不在(被删除或已退出)或已暂停时抛出带原因的错误，由任务提示并提供换模型。
 */
export function resolveRemoteAgentTarget(agentDeviceId: string): string {
  const shareId = parseProviderShareAgentDeviceId(agentDeviceId);
  if (!shareId) return agentDeviceId;
  const share = findReceivedShare(shareId);
  if (!share) throw new Error('[REMOTE_AGENT_SHARE_REMOVED] this shared provider is no longer available');
  if (share.status !== 'active') throw new Error('[REMOTE_AGENT_SHARE_PAUSED] the owner has paused this share');
  return providerShareHostPeer(share.shareId, share.hostDeviceId);
}

/**
 * 同上，但刚启动、已收到的分享还没拉到时先等第一次拉取，不把「还没加载」当成「已删除」。
 * 未登录或设备互联未就绪时按连不上处理。
 */
export async function resolveRemoteAgentTargetWhenReady(agentDeviceId: string): Promise<string> {
  if (!parseProviderShareAgentDeviceId(agentDeviceId)) return agentDeviceId;
  const rt = runtime;
  if (!rt || !current(rt)) throw new Error('[DEVICE_LINK_NOT_CONNECTED] provider sharing is not ready');
  if (rt.fetchedAt === 0) await refreshReceivedShares('resolve');
  if (rt.fetchedAt === 0) throw new Error('[DEVICE_LINK_NOT_CONNECTED] shared providers are not loaded yet');
  return resolveRemoteAgentTarget(agentDeviceId);
}

/** 分隔条与模型列表展示用的电脑名。 */
export function describeProviderShareDevice(agentDeviceId: string): string | null {
  const shareId = parseProviderShareAgentDeviceId(agentDeviceId);
  return shareId ? findReceivedShare(shareId)?.deviceName ?? null : null;
}

// ─── 已收到的分享 ────────────────────────────────────────────────

function schedule(rt: Runtime): void {
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = null;
  // 暂时不可用(账号边界切换中等)时照常排下一次，拉取本身会核对作用域；只有停掉运行时才断链。
  if (runtime !== rt || rt.stopped) return;
  // 还没有分享时放慢：同账号的另一台电脑申请成功后，这台也会在几分钟内出现。
  const delay = rt.received.length > 0 ? RECEIVED_POLL_MS : RECEIVED_IDLE_POLL_MS;
  rt.timer = setTimeout(() => { void refreshReceivedShares('poll'); }, delay);
  (rt.timer as { unref?: () => void }).unref?.();
}

export function startProviderShareGuest(events: ProviderShareGuestEvents, options: { userDataDir?: string } = {}): void {
  stopProviderShareGuest();
  const rt: Runtime = {
    events,
    scope: providerShareOwnerKey(),
    received: [],
    fetchedAt: 0,
    timer: null,
    refreshing: null,
    pending: new Map(),
    stopped: false,
  };
  runtime = rt;
  void refreshReceivedShares('start');
  if (options.userDataDir) startProviderShareCrossRegion({ changed: () => emitChanged(rt) }, { userDataDir: options.userDataDir });
}

export function stopProviderShareGuest(): void {
  stopProviderShareCrossRegion();
  const rt = runtime;
  if (!rt) return;
  rt.stopped = true;
  if (rt.timer) clearTimeout(rt.timer);
  for (const pending of rt.pending.values()) if (pending.timer) clearTimeout(pending.timer);
  runtime = null;
}

export function refreshReceivedShares(reason: string): Promise<void> {
  const rt = runtime;
  if (!rt) return Promise.resolve();
  if (rt.refreshing) return rt.refreshing;
  const run = (async () => {
    try {
      const received = await providerShareApi.listReceived();
      if (!current(rt)) return;
      rt.received = received;
      rt.fetchedAt = Date.now();
      emitChanged(rt);
    } catch (error) {
      if (current(rt)) log.warn('received shares refresh failed', { reason, error: error instanceof Error ? error.message : String(error) });
    } finally {
      rt.refreshing = null;
      schedule(rt);
    }
  })();
  rt.refreshing = run;
  return run;
}

/**
 * 分享者电脑拒绝了受邀者(分享被暂停、对方关了远程控制或这个供应商的「允许被远程调用」)：给受邀者
 * 分享专属的原因，不出现要求去「那台电脑」上操作的同账号文案。
 */
export const PROVIDER_SHARE_UNAVAILABLE_MESSAGE = '[REMOTE_AGENT_SHARE_UNAVAILABLE] the shared provider is not available right now';

/** 这次失败是不是分享者电脑拒绝了受邀者(而不是网络、超时等可重试故障)。 */
export function isProviderShareRefusal(code: string, message: string): boolean {
  // REMOTE_DISABLED：relay 在分享者关了「允许远程控制」时直接拒绝(契约 §2)。
  return code === 'ACCESS_REVOKED' || code === 'REMOTE_DISABLED'
    || (code === 'IPC_ERROR' && message.startsWith('[REMOTE_AGENT_PROVIDER_NOT_ALLOWED]'));
}

/**
 * 分享者那台电脑拒绝了请求(分享被暂停或删除时会这样)：尽快重新拉一次，让任务给出准确原因。
 * 连不上时远程 Agent 会反复重试，这里限频。
 */
let lastAccessFailureRefreshAt = 0;

export function noteProviderShareAccessFailure(): void {
  const now = Date.now();
  if (!runtime || now - lastAccessFailureRefreshAt < ACCESS_FAILURE_REFRESH_MS) return;
  lastAccessFailureRefreshAt = now;
  void refreshReceivedShares('access-failure');
}

export function getReceivedShares(): readonly ProviderShareReceived[] {
  return allReceived(runtime);
}

// ─── 加入 ────────────────────────────────────────────────────────

/** 粘贴的链接或 scheme intent → 口令与它所属的区域。只认两个官方区域。 */
export async function resolveProviderShareLink(input: string | ProviderShareInvitationIntent): Promise<ResolvedLink> {
  const intent = typeof input === 'string'
    ? parseProviderShareInvitationIntent(input) ?? parseProviderShareLink(input)
    : input;
  if (!intent) throwIpcError('INVALID_PARAMS', 'Invalid provider share link');
  const region = await crossRegionOfIntent(intent, getClientEndpoint('deviceLinkApiBaseUrl'));
  return { intent, region };
}

export async function previewProviderShare(link: string | ProviderShareInvitationIntent): Promise<ProviderShareLinkPreview> {
  requireRuntime();
  const { intent, region } = await resolveProviderShareLink(link);
  return region ? crossRegionPreview(region, intent.invitation) : providerShareApi.preview(intent.invitation);
}

function pollRequest(rt: Runtime, requestId: string): void {
  const pending = rt.pending.get(requestId);
  if (!pending || runtime !== rt || rt.stopped) return;
  pending.timer = setTimeout(() => {
    void (async () => {
      const entry = rt.pending.get(requestId);
      if (!entry || runtime !== rt || rt.stopped) return;
      // 账号边界切换中：稍后再查，不丢掉这条申请。
      if (!current(rt)) {
        pollRequest(rt, requestId);
        return;
      }
      try {
        const state = entry.cross
          ? await crossRegionGetRequest(entry.cross.region, requestId, entry.cross.requestToken)
          : await providerShareApi.getRequest(requestId);
        if (!current(rt)) return;
        entry.state = state;
        if (state.status === 'pending') {
          pollRequest(rt, requestId);
          return;
        }
        rt.pending.delete(requestId);
        if (state.status === 'approved') {
          if (entry.cross) await refreshProviderShareCrossRegion(entry.cross.region);
          else await refreshReceivedShares('approved');
        }
        rt.events.settled(state, entry.preview);
      } catch (error) {
        log.warn('provider share request status failed', { error: error instanceof Error ? error.message : String(error) });
        pollRequest(rt, requestId);
      }
    })();
  }, REQUEST_POLL_MS);
  (pending.timer as { unref?: () => void }).unref?.();
}

/** 发送申请：名片只含昵称与头像，用自己的登录凭证换取，并绑定这条链接。 */
export async function sendProviderShareRequest(link: string | ProviderShareInvitationIntent): Promise<ProviderShareRequestState> {
  const rt = requireRuntime();
  const { intent, region } = await resolveProviderShareLink(link);
  const { invitation } = intent;
  let state: ProviderShareRequestState;
  let cross: PendingRequest['cross'] = null;
  let preview: ProviderShareLinkPreview | null;
  if (region) {
    preview = await crossRegionPreview(region, invitation).catch(() => null);
    const sent = await crossRegionSendRequest(region, invitation);
    state = sent.state;
    cross = { region, requestToken: sent.requestToken };
  } else {
    preview = await providerShareApi.preview(invitation).catch(() => null);
    const card = await fetchIdentityCard('share-request', sha256Hex(invitation));
    state = await providerShareApi.sendRequest(invitation, card);
  }
  if (!current(rt)) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Account changed');
  if (state.status === 'pending') {
    rt.pending.set(state.requestId, { state, preview, timer: null, cross });
    pollRequest(rt, state.requestId);
  }
  return state;
}

export async function getProviderShareRequest(requestId: string): Promise<ProviderShareRequestState> {
  const rt = requireRuntime();
  const local = rt.pending.get(requestId);
  if (local?.cross) {
    local.state = await crossRegionGetRequest(local.cross.region, requestId, local.cross.requestToken);
    return local.state;
  }
  const state = await providerShareApi.getRequest(requestId);
  if (local) local.state = state;
  return state;
}

export async function withdrawProviderShareRequest(requestId: string): Promise<void> {
  const rt = requireRuntime();
  const pending = rt.pending.get(requestId);
  if (pending?.cross) await crossRegionWithdraw(pending.cross.region, requestId, pending.cross.requestToken);
  else await providerShareApi.withdraw(requestId);
  if (pending?.timer) clearTimeout(pending.timer);
  rt.pending.delete(requestId);
}

export async function leaveProviderShare(memberId: string): Promise<void> {
  requireRuntime();
  if (await crossRegionLeave(memberId)) return;
  await providerShareApi.leave(memberId);
  await refreshReceivedShares('left');
}
