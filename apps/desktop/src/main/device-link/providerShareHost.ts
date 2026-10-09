/**
 * 供应商分享 · 分享者这台电脑(host)。
 *
 * 服务端是成员关系的权威(谁是成员、是否暂停或删除)；本机缓存最近一次的分享快照，按它为受邀者
 * 准入，并在每次开启运行、发消息、换模型时复核(见 remote-agent/host)。快照来源只有 REST：
 *  - 刚生成链接或有待审批申请时每 5 秒拉一次(申请要尽快弹出)；
 *  - 有分享但没有待处理的事时每 60 秒拉一次(受邀者退出等变化)；
 *  - 不认识的受邀者连进来时按需立即拉一次(限频)。
 * 本机做的暂停、删除先改本机快照、立即撤权，不等下一次拉取。
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
import { providerShareApi, providerShareOwnerKey } from './providerShareApi.js';
import { readDeviceLinkSettings } from './settings-store.js';

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
  /** 出现新的待审批申请(审批弹窗与系统通知)。 */
  requested(request: ProviderShareRequestItem, share: ProviderShareOwned): void;
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

interface Runtime {
  events: ProviderShareHostEvents;
  scope: string | null;
  shares: ProviderShareOwned[];
  fetchedAt: number;
  hotUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
  refreshing: Promise<void> | null;
  lastOnDemandAt: number;
  knownRequests: Set<string>;
  reconciled: boolean;
  stopped: boolean;
}

let runtime: Runtime | null = null;

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
  const pending = rt.shares.some((share) => share.requests.length > 0);
  const hot = Date.now() < rt.hotUntil || pending;
  if (!hot && rt.shares.length === 0 && rt.fetchedAt > 0) return;
  rt.timer = setTimeout(() => { void refreshProviderShareHost('poll'); }, hot ? FAST_POLL_MS : SLOW_POLL_MS);
  (rt.timer as { unref?: () => void }).unref?.();
}

function applySnapshot(rt: Runtime, next: ProviderShareOwned[]): void {
  const previous = rt.shares;
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
  for (const share of next) {
    for (const request of share.requests) {
      if (rt.knownRequests.has(request.requestId)) continue;
      rt.knownRequests.add(request.requestId);
      rt.events.requested(request, share);
    }
  }
  rt.events.changed(next);
}

export function startProviderShareHost(events: ProviderShareHostEvents): void {
  stopProviderShareHost();
  const rt: Runtime = {
    events,
    scope: providerShareOwnerKey(),
    shares: [],
    fetchedAt: 0,
    hotUntil: 0,
    timer: null,
    refreshing: null,
    lastOnDemandAt: 0,
    knownRequests: new Set(),
    reconciled: false,
    stopped: false,
  };
  runtime = rt;
  void refreshProviderShareHost('start');
}

export function stopProviderShareHost(): void {
  const rt = runtime;
  if (!rt) return;
  rt.stopped = true;
  if (rt.timer) clearTimeout(rt.timer);
  runtime = null;
}

/** 拉一次分享快照。并发调用合并为一次。 */
export function refreshProviderShareHost(reason: string): Promise<void> {
  const rt = runtime;
  if (!rt) return Promise.resolve();
  if (rt.refreshing) return rt.refreshing;
  const run = (async () => {
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
    } finally {
      rt.refreshing = null;
      schedule(rt);
    }
  })();
  rt.refreshing = run;
  return run;
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
