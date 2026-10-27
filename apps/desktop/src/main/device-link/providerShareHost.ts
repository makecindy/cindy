/**
 * 供应商分享 · 分享者这台电脑(host)。
 *
 * 服务端是成员关系的权威(谁是成员、是否暂停或删除)；本机缓存最近一次的分享快照，按它为受邀者
 * 准入，并在每次开启运行、发消息、换模型时复核(见 remote-agent/host)。快照来源只有 REST：
 *  - 刚生成链接或有待审批申请时每 5 秒拉一次(申请要尽快弹出)；
 *  - 有分享但没有待处理的事时每 60 秒拉一次(受邀者退出等变化)；
 *  - 不认识的受邀者连进来时按需立即拉一次(限频)。
 * 本机做的暂停、删除先改本机快照、立即撤权，不等下一次拉取。
 *
 * 审批弹窗跟着生成链接的电脑(provider-sharing.md §4.1)：同账号另一台电脑经管理为本机的分享生成链接后，
 * 窗口期内的新申请在本机只进管理页与提示点；那台电脑在同一窗口期关注本机的分享，由它弹审批窗。
 */
import {
  parseProviderSharePeer,
  type ProviderShareOwned,
  type ProviderShareRequestItem,
} from '@cindy/device-link';

import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAuthState, getDeviceId } from '../authManager.js';
import { createLogger } from '../logger.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { providerShareApi, providerShareOwnerKey } from './providerShareApi.js';
import {
  PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS,
  readProviderShareApprovalWindows,
  updateProviderShareApprovalWindows,
} from './providerShareApprovalWindows.js';
import { readDeviceLinkSettings } from './settings-store.js';

export { PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS } from './providerShareApprovalWindows.js';

const log = createLogger('provider-share:host');

const FAST_POLL_MS = 5_000;
const SLOW_POLL_MS = 60_000;
/** 生成链接后保持快速拉取的时长：链接 5 分钟有效，再留出申请到达的余量。 */
const HOT_AFTER_LINK_MS = 6 * 60_000;
const ON_DEMAND_MIN_INTERVAL_MS = 5_000;
export interface ProviderShareGuestAccess {
  shareId: string;
  memberId: string;
  providerId: string;
}

export interface ProviderShareHostEvents {
  /** 快照变化(管理页刷新)。 */
  changed(shares: readonly ProviderShareOwned[]): void;
  /**
   * 出现新的待审批申请(审批弹窗与系统通知)。quiet = 链接由同账号另一台电脑生成，由那台弹窗，本机不弹。
   */
  requested(request: ProviderShareRequestItem, share: ProviderShareOwned, quiet: boolean): void;
  /** 本机为同账号另一台电脑上的分享生成链接后，那条分享出现新申请：由本机弹审批窗。 */
  watchedRequested(item: ProviderShareWatchedRequest): void;
  /** 成员不再 active(暂停、删除、退出)：结束它的任务、断开它的连接；purge 时清理本机数据。 */
  revoked(member: ProviderShareMemberRef, purge: boolean): void;
  /**
   * 启动后第一次拿到快照：本机仍留着、但已不在这些分享成员里的受邀者数据需要清理
   * (分享者电脑离线期间被删除或退出的成员)。owned 只含当前账号在本机的分享。
   */
  reconcile(owned: ReadonlyMap<string, ReadonlySet<string>>): void;
}

export interface ProviderShareMemberRef {
  shareId: string;
  memberId: string;
}

/** 同账号另一台电脑上的分享里、由本机负责弹窗的待审批申请。 */
export interface ProviderShareWatchedRequest {
  request: ProviderShareRequestItem;
  share: { shareId: string; providerId: string; providerLabel: string };
  hostDeviceId: string;
}

/** 同账号管理的 owned 回包；只把申请用于本机弹窗，不作为受邀者准入快照。 */
export type ProviderShareWatchedSnapshot = Pick<ProviderShareOwned, 'shareId' | 'providerId' | 'providerLabel' | 'requests'>;

interface RemoteLinkWatch {
  hostDeviceId: string;
  providerId: string;
  linkId?: string;
  until: number;
  readShares(): Promise<readonly ProviderShareWatchedSnapshot[]>;
}

interface Runtime {
  events: ProviderShareHostEvents;
  scope: string | null;
  shares: ProviderShareOwned[];
  fetchedAt: number;
  hotUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
  refreshing: Promise<void> | null;
  remoteRefreshing: Map<string, Promise<void>>;
  lastOnDemandAt: number;
  knownRequests: Set<string>;
  reconciled: boolean;
  stopped: boolean;
  /** 本机分享：供应商 → 另一台电脑生成的链接的窗口期截止时刻。 */
  quietUntil: Map<string, number>;
  /** 本机分享：服务端返回 linkId 时，按具体链接归属的窗口期截止时刻。 */
  quietLinks: Map<string, number>;
  /** 本机分享里由另一台电脑弹窗的申请。 */
  quietRequests: Set<string>;
  /** 本机为另一台电脑上的分享生成了链接，窗口期内关注那条分享。 */
  watches: RemoteLinkWatch[];
  /** 关注到、仍待审批的申请。 */
  watched: Map<string, ProviderShareWatchedRequest>;
  watchedSeen: Set<string>;
}

interface RetainedRemoteLinkState {
  watches: RemoteLinkWatch[];
  watched: Map<string, ProviderShareWatchedRequest>;
  watchedSeen: Set<string>;
}

let runtime: Runtime | null = null;
let accessRevision = 0;
export function providerShareAccessRevision(): number { return accessRevision; }
/** 分享快照变化的旁听者(见 onProviderShareHostChanged)。 */
const snapshotListeners = new Set<() => void>();

/**
 * 远程管理生成链接后，host runtime 可能因设备互联断开、重新接管或账号边界重建。
 * 同进程重建时保留回调与去重；完整进程重启则从按账号保存的七分钟窗口恢复，不存申请或链接口令。
 */
const retainedQuietUntilByScope = new Map<string, Map<string, number>>();
const retainedQuietLinksByScope = new Map<string, Map<string, number>>();
const retainedRemoteLinkStateByScope = new Map<string, RetainedRemoteLinkState>();

function activeQuietUntil(source: ReadonlyMap<string, number>): Map<string, number> {
  const now = Date.now();
  return new Map([...source].filter(([, until]) => until > now));
}

function retainQuietUntil(rt: Runtime): void {
  if (rt.scope === null) return;
  const active = activeQuietUntil(rt.quietUntil);
  if (active.size > 0) retainedQuietUntilByScope.set(rt.scope, active);
  else retainedQuietUntilByScope.delete(rt.scope);
  const activeLinks = activeQuietUntil(rt.quietLinks);
  if (activeLinks.size > 0) retainedQuietLinksByScope.set(rt.scope, activeLinks);
  else retainedQuietLinksByScope.delete(rt.scope);
}

function restoreQuietUntil(scope: string | null): Map<string, number> {
  if (scope === null) return new Map();
  const retained = retainedQuietUntilByScope.get(scope);
  retainedQuietUntilByScope.delete(scope);
  return retained ? activeQuietUntil(retained) : new Map();
}

function restoreQuietLinks(scope: string | null): Map<string, number> {
  if (scope === null) return new Map();
  const retained = retainedQuietLinksByScope.get(scope);
  retainedQuietLinksByScope.delete(scope);
  return retained ? activeQuietUntil(retained) : new Map();
}

function activeRemoteLinkWatches(source: readonly RemoteLinkWatch[]): RemoteLinkWatch[] {
  const now = Date.now();
  return source.filter((watch) => watch.until > now);
}

function retainRemoteLinkState(rt: Runtime): void {
  if (rt.scope === null) return;
  const watches = activeRemoteLinkWatches(rt.watches);
  const watched = new Map(rt.watched);
  const watchedSeen = new Set(rt.watchedSeen);
  if (watches.length > 0) {
    retainedRemoteLinkStateByScope.set(rt.scope, { watches, watched, watchedSeen });
  } else {
    retainedRemoteLinkStateByScope.delete(rt.scope);
  }
}

function restoreRemoteLinkState(scope: string | null): RetainedRemoteLinkState {
  if (scope === null) return { watches: [], watched: new Map(), watchedSeen: new Set() };
  const retained = retainedRemoteLinkStateByScope.get(scope);
  retainedRemoteLinkStateByScope.delete(scope);
  if (!retained) return { watches: [], watched: new Map(), watchedSeen: new Set() };
  return {
    watches: activeRemoteLinkWatches(retained.watches),
    watched: new Map(retained.watched),
    watchedSeen: new Set(retained.watchedSeen),
  };
}

function current(rt: Runtime): boolean {
  return runtime === rt && !rt.stopped && getAuthState().isAuthenticated && !isAppSessionBoundaryPending()
    && providerShareOwnerKey() === rt.scope;
}

/** 某个成员的全部设备(本地 peer key 里带设备 id，同一成员可能从多台电脑连进来)。 */
export function providerShareMemberMatcher(member: ProviderShareMemberRef): (controller: string) => boolean {
  return (controller) => {
    const peer = parseProviderSharePeer(controller);
    return !!peer && peer.role === 'guest' && peer.shareId === member.shareId && peer.memberId === member.memberId;
  };
}

function schedule(rt: Runtime): void {
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = null;
  // 暂时不可用(账号边界切换中等)时照常排下一次，拉取本身会核对作用域；只有停掉运行时才断链。
  if (runtime !== rt || rt.stopped) return;
  const pending = rt.shares.some((share) => share.requests.length > 0) || rt.watched.size > 0;
  const hot = Date.now() < rt.hotUntil || pending || rt.watches.some((watch) => watch.until > Date.now());
  if (!hot && rt.shares.length === 0 && rt.fetchedAt > 0) return;
  rt.timer = setTimeout(() => { void refreshProviderShareHost('poll'); }, hot ? FAST_POLL_MS : SLOW_POLL_MS);
  (rt.timer as { unref?: () => void }).unref?.();
}

function applySnapshot(rt: Runtime, next: ProviderShareOwned[]): void {
  const previous = rt.shares;
  if (JSON.stringify(previous) !== JSON.stringify(next)) accessRevision++;
  rt.shares = next;
  rt.fetchedAt = Date.now();
  // 原来 active 的成员不再 active：结束任务、断开连接。成员从快照里消失(删除、退出)时，不论之前
  // 是否已暂停，都清理他留在本机的数据。
  for (const share of previous) {
    for (const member of share.members) {
      const after = next.find((item) => item.shareId === share.shareId)?.members.find((item) => item.memberId === member.memberId);
      if (!after) rt.events.revoked({ shareId: share.shareId, memberId: member.memberId }, true);
      else if (member.status === 'active' && after.status !== 'active') rt.events.revoked({ shareId: share.shareId, memberId: member.memberId }, false);
    }
  }
  const now = Date.now();
  const pendingIds = new Set<string>();
  for (const share of next) {
    for (const request of share.requests) {
      pendingIds.add(request.requestId);
      if (rt.knownRequests.has(request.requestId)) continue;
      rt.knownRequests.add(request.requestId);
      const quiet = request.linkId
        ? (rt.quietLinks.get(`${share.providerId}:${request.linkId}`) ?? 0) > now
        : (rt.quietUntil.get(share.providerId) ?? 0) > now;
      if (quiet) rt.quietRequests.add(request.requestId);
      rt.events.requested(request, share, quiet);
    }
  }
  for (const requestId of rt.quietRequests) {
    if (!pendingIds.has(requestId)) rt.quietRequests.delete(requestId);
  }
  for (const [providerId, until] of rt.quietUntil) {
    if (until <= now) rt.quietUntil.delete(providerId);
  }
  for (const [key, until] of rt.quietLinks) {
    if (until <= now) rt.quietLinks.delete(key);
  }
  rt.events.changed(next);
  for (const listener of snapshotListeners) {
    try {
      listener();
    } catch (error) {
      log.warn('provider share snapshot listener failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * 分享快照变了(成员加入、暂停、删除等)：供应商组的转分享据此重新报上分享的人(provider-sharing.md §4.3)。
 * 只通知，不带内容；读最新的用 {@link getProviderShareHostLoadedSnapshot}。
 */
export function onProviderShareHostChanged(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

/** 已拉到过、仍属于当前账号的分享快照；还没拉到或已换账号时为 null(不能当成「没有分享给任何人」)。 */
export function getProviderShareHostLoadedSnapshot(): readonly ProviderShareOwned[] | null {
  const rt = runtime;
  if (!rt || rt.fetchedAt === 0 || !current(rt)) return null;
  return rt.shares;
}

/**
 * 同账号其他电脑上的分享：窗口期内关注的那条分享出现的申请由本机弹窗；已关注的申请从快照里消失
 * (在任一台电脑上处理、撤回或过期)时移除。只用于弹窗，不进入本机快照，不影响受邀者准入。
 */
function applyWatched(rt: Runtime, hostDeviceId: string, shares: readonly ProviderShareWatchedSnapshot[]): void {
  const now = Date.now();
  const present = new Set<string>();
  for (const share of shares) {
    for (const request of share.requests) present.add(request.requestId);
  }
  for (const [requestId, item] of rt.watched) {
    if (item.hostDeviceId === hostDeviceId && !present.has(requestId)) rt.watched.delete(requestId);
  }
  for (const share of shares) {
    const watches = rt.watches.filter((watch) => watch.hostDeviceId === hostDeviceId && watch.providerId === share.providerId && watch.until > now);
    if (watches.length === 0) continue;
    for (const request of share.requests) {
      // 旧窗口只接无标识的旧回包，不能接管升级后其它电脑生成的链接。
      if (!watches.some((watch) => watch.linkId === request.linkId)) continue;
      // 弹过一次的不再弹(本机处理后，处理前发出的那次拉取可能还带着它)。
      if (rt.watchedSeen.has(request.requestId)) continue;
      rt.watchedSeen.add(request.requestId);
      const item: ProviderShareWatchedRequest = {
        request,
        share: { shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel },
        hostDeviceId,
      };
      rt.watched.set(request.requestId, item);
      rt.events.watchedRequested(item);
    }
  }
}

export function startProviderShareHost(events: ProviderShareHostEvents, options: {
  readWatchedShares?: (hostDeviceId: string) => Promise<readonly ProviderShareWatchedSnapshot[]>;
} = {}): void {
  stopProviderShareHost();
  const scope = providerShareOwnerKey();
  const remoteLinkState = restoreRemoteLinkState(scope);
  const saved = scope === null ? null : readProviderShareApprovalWindows();
  const retainedQuiet = restoreQuietUntil(scope);
  const retainedQuietLinks = restoreQuietLinks(scope);
  // 启动的第一轮快照之前恢复两侧归属。读远端的函数由新运行时接线提供，不能从磁盘恢复旧账号闭包。
  if (saved) {
    remoteLinkState.watches = saved.watches.flatMap((watch) => {
      const retained = remoteLinkState.watches.find((item) => item.hostDeviceId === watch.hostDeviceId
        && item.providerId === watch.providerId && item.linkId === watch.linkId);
      const readShares = options.readWatchedShares
        ? () => options.readWatchedShares!(watch.hostDeviceId)
        : retained?.readShares;
      return readShares ? [{ ...watch, readShares }] : [];
    });
  }
  const rt: Runtime = {
    events,
    scope,
    shares: [],
    fetchedAt: 0,
    hotUntil: 0,
    timer: null,
    refreshing: null,
    remoteRefreshing: new Map(),
    lastOnDemandAt: 0,
    knownRequests: new Set(),
    reconciled: false,
    stopped: false,
    quietUntil: saved ? new Map(Object.entries(saved.quietUntil)) : retainedQuiet,
    quietLinks: saved
      ? new Map((saved.quietLinks ?? []).map((item) => [`${item.providerId}:${item.linkId}`, item.until]))
      : retainedQuietLinks,
    quietRequests: new Set(),
    watches: remoteLinkState.watches,
    watched: remoteLinkState.watched,
    watchedSeen: remoteLinkState.watchedSeen,
  };
  runtime = rt;
  void refreshProviderShareHost('start');
}

export function stopProviderShareHost(): void {
  accessRevision++;
  const rt = runtime;
  if (!rt) return;
  rt.stopped = true;
  if (rt.timer) clearTimeout(rt.timer);
  retainQuietUntil(rt);
  retainRemoteLinkState(rt);
  runtime = null;
}

/** 拉一次分享快照。本机与每台关注电脑各自合并在途读取，不让一个 peer 卡住下一轮。 */
export function refreshProviderShareHost(reason: string): Promise<void> {
  const rt = runtime;
  if (!rt) return Promise.resolve();
  const readLocal = async () => {
    try {
      const shares = await providerShareApi.listOwned();
      if (!current(rt)) return;
      const self = getDeviceId();
      applySnapshot(rt, shares.filter((share) => !self || share.hostDeviceId === self));
      if (!rt.reconciled) {
        rt.reconciled = true;
        rt.events.reconcile(new Map(rt.shares.map((share) => [share.shareId, new Set(share.members.map((member) => member.memberId))])));
      }
    } catch (error) {
      if (current(rt)) log.warn('provider share snapshot refresh failed', { reason, error: error instanceof Error ? error.message : String(error) });
    }
  };
  // REST 只返回本机分享。远端申请经已有同账号管理通道读取，每台电脑最多一次在途；
  // 拉取本机或某个 peer 仍在途时只跳过它，不延迟其它电脑。
  const local = rt.refreshing ?? readLocal().finally(() => {
    rt.refreshing = null;
    schedule(rt);
  });
  rt.refreshing = local;
  schedule(rt);
  const pendingHosts = new Set([...rt.watched.values()].map((item) => item.hostDeviceId));
  rt.watches = rt.watches.filter((watch) => watch.until > Date.now() || pendingHosts.has(watch.hostDeviceId));
  const readers = new Map(rt.watches.map((watch) => [watch.hostDeviceId, watch.readShares]));
  const remote = [...readers].flatMap(([hostDeviceId, readShares]) => {
    if (rt.remoteRefreshing.has(hostDeviceId)) return [];
    const read = (async () => {
      try {
        if (!current(rt)) return;
        const shares = await readShares();
        if (current(rt)) applyWatched(rt, hostDeviceId, shares);
      } catch {
        if (current(rt)) log.warn('provider share watched snapshot refresh failed', { reason, hostDeviceId });
      }
    })().finally(() => { rt.remoteRefreshing.delete(hostDeviceId); });
    rt.remoteRefreshing.set(hostDeviceId, read);
    return [read];
  });
  return Promise.all([local, ...remote]).then(() => undefined);
}

/** 生成链接、打开管理页时进入快速拉取。 */
export function markProviderShareHostActive(durationMs = HOT_AFTER_LINK_MS): void {
  const rt = runtime;
  if (!rt) return;
  rt.hotUntil = Math.max(rt.hotUntil, Date.now() + durationMs);
  schedule(rt);
}

export function getProviderShareHostSnapshot(): readonly ProviderShareOwned[] {
  return runtime?.shares ?? [];
}

/** 同账号另一台电脑经管理生成的链接：只将这条链接的申请交给那台弹窗。 */
export async function quietProviderShareRequests(providerId: string, linkId?: string): Promise<void> {
  const rt = runtime;
  assertApprovalWindowCurrent(rt);
  const assertCurrent = () => assertApprovalWindowCurrent(rt);
  const until = Date.now() + PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
  await updateProviderShareApprovalWindows((value) => linkId
    ? {
      ...value,
      quietLinks: [...(value.quietLinks ?? []).filter((item) => item.providerId !== providerId || item.linkId !== linkId),
        { providerId, linkId, until }],
    }
    : { ...value, quietUntil: { ...value.quietUntil, [providerId]: until } }, assertCurrent);
  if (linkId) rt.quietLinks.set(`${providerId}:${linkId}`, until);
  else rt.quietUntil.set(providerId, until);
}

/** 本机新链接清除旧版按供应商静默的窗口；其它链接的精确归属保持不变。 */
export async function clearProviderShareRequestQuiet(providerId: string): Promise<void> {
  const rt = runtime;
  assertApprovalWindowCurrent(rt);
  const assertCurrent = () => assertApprovalWindowCurrent(rt);
  await updateProviderShareApprovalWindows((value) => {
    const quietUntil = { ...value.quietUntil };
    delete quietUntil[providerId];
    return { ...value, quietUntil };
  }, assertCurrent);
  rt.quietUntil.delete(providerId);
}

/** 本机为另一台电脑上的分享生成了链接：窗口期内关注那条分享，新申请由本机弹窗。 */
export async function watchProviderShareRequests(
  hostDeviceId: string,
  providerId: string,
  linkIdOrReadShares: string | RemoteLinkWatch['readShares'],
  maybeReadShares?: RemoteLinkWatch['readShares'],
): Promise<void> {
  const rt = runtime;
  assertApprovalWindowCurrent(rt);
  const assertCurrent = () => assertApprovalWindowCurrent(rt);
  const until = Date.now() + PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
  const linkId = typeof linkIdOrReadShares === 'string' ? linkIdOrReadShares : undefined;
  const readShares = typeof linkIdOrReadShares === 'function' ? linkIdOrReadShares : maybeReadShares;
  if (!readShares) throwIpcError('PRECONDITION_FAILED', 'Provider share approval reader is unavailable');
  await updateProviderShareApprovalWindows((value) => ({
    ...value,
    watches: [...value.watches.filter((watch) => watch.hostDeviceId !== hostDeviceId || watch.providerId !== providerId || watch.linkId !== linkId),
      { hostDeviceId, providerId, ...(linkId ? { linkId } : {}), until }],
  }), assertCurrent);
  rt.watches = [
    ...rt.watches.filter((watch) => watch.hostDeviceId !== hostDeviceId || watch.providerId !== providerId || watch.linkId !== linkId),
    { hostDeviceId, providerId, ...(linkId ? { linkId } : {}), until, readShares },
  ];
  markProviderShareHostActive(PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS);
}

function assertApprovalWindowCurrent(rt: Runtime | null): asserts rt is Runtime {
  if (!rt || !current(rt)) throwIpcError('PRECONDITION_FAILED', 'The account or runtime changed during provider share approval setup');
}

/** 本机经管理处理了关注到的申请：立即移除，不等下一次拉取。 */
export function forgetWatchedProviderShareRequest(requestId: string): void {
  runtime?.watched.delete(requestId);
}

export function getProviderShareQuietRequestIds(): string[] {
  return [...(runtime?.quietRequests ?? [])];
}

export function getProviderShareWatchedRequests(): ProviderShareWatchedRequest[] {
  return [...(runtime?.watched.values() ?? [])];
}

/** 受邀者对端被拒的原因(只进日志，不发给对方)。 */
export type ProviderShareGuestDenial =
  | 'host-not-running'
  | 'host-scope-stale'
  | 'not-guest-peer'
  | 'self-device'
  | 'snapshot-not-loaded'
  | 'share-unknown'
  | 'share-on-other-device'
  | 'member-not-active'
  | 'remote-control-off'
  | 'provider-not-remote';

type GuestAccessCheck = { access: ProviderShareGuestAccess } | { denied: ProviderShareGuestDenial };

function checkGuestAccess(controller: string): GuestAccessCheck {
  const rt = runtime;
  if (!rt || rt.stopped || runtime !== rt) return { denied: 'host-not-running' };
  if (!current(rt)) return { denied: 'host-scope-stale' };
  const peer = parseProviderSharePeer(controller);
  if (!peer || peer.role !== 'guest') return { denied: 'not-guest-peer' };
  const self = getDeviceId();
  if (self && peer.deviceId === self) return { denied: 'self-device' };
  const share = rt.shares.find((item) => item.shareId === peer.shareId);
  if (!share) return { denied: rt.fetchedAt === 0 ? 'snapshot-not-loaded' : 'share-unknown' };
  if (self && share.hostDeviceId !== self) return { denied: 'share-on-other-device' };
  const member = share.members.find((item) => item.memberId === peer.memberId);
  if (!member || member.status !== 'active') return { denied: 'member-not-active' };
  if (!readDeviceLinkSettings().remoteControlEnabled) return { denied: 'remote-control-off' };
  if (!isRemoteProviderInvocationAllowed(share.providerId)) return { denied: 'provider-not-remote' };
  return { access: { shareId: share.shareId, memberId: member.memberId, providerId: share.providerId } };
}

/**
 * 受邀者对端的准入：分享与成员在本机快照里 active、这台电脑允许远程控制、分享的供应商仍开放
 * 「允许被远程调用」。任一不满足返回 null。
 */
export function providerShareGuestAccess(controller: string): ProviderShareGuestAccess | null {
  const result = checkGuestAccess(controller);
  return 'access' in result ? result.access : null;
}

/** 受邀者对端为什么被拒；放行时为 null。只用于诊断日志。 */
export function providerShareGuestDenial(controller: string): ProviderShareGuestDenial | null {
  const result = checkGuestAccess(controller);
  return 'denied' in result ? result.denied : null;
}

/** 不认识的受邀者连进来：可能是刚同意的成员，按需立即拉一次(限频)。 */
export async function ensureProviderSharePeerKnown(controller: string): Promise<void> {
  const rt = runtime;
  if (!rt || providerShareGuestAccess(controller)) return;
  const now = Date.now();
  if (now - rt.lastOnDemandAt < ON_DEMAND_MIN_INTERVAL_MS) {
    await rt.refreshing;
    return;
  }
  rt.lastOnDemandAt = now;
  await refreshProviderShareHost('peer');
}

/** 本机执行暂停 / 恢复 / 删除后立即更新快照并撤权，不等下一次拉取。 */
export function applyLocalMemberChange(memberId: string, status: 'active' | 'paused' | 'removed'): void {
  const rt = runtime;
  if (!rt) return;
  const next = rt.shares.map((share) => ({
    ...share,
    members: share.members.flatMap((member) => {
      if (member.memberId !== memberId) return [member];
      return status === 'removed' ? [] : [{ ...member, status }];
    }),
  }));
  applySnapshot(rt, next);
}

/** 本机审批后从快照里移除这条申请(同意的成员由下一次拉取带回)。 */
export function applyLocalRequestDecision(requestId: string): void {
  const rt = runtime;
  if (!rt) return;
  applySnapshot(rt, rt.shares.map((share) => ({ ...share, requests: share.requests.filter((item) => item.requestId !== requestId) })));
}
