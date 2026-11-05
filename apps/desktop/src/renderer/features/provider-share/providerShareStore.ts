/**
 * 供应商分享在 Renderer 里的两份共享状态(模块级单例，app 生命周期常驻，与
 * useDeviceLinkDeviceList 同一做法)：
 *
 *  - 已收到的分享(受邀者)：首个订阅者触发一次 `received`，之后靠 RECEIVED_CHANGED 推送。
 *    分享的状态、在线或所在电脑变化时刷新对应 `share:<id>` 的模型目录缓存，消失的分享作废缓存。
 *  - 待审批申请(分享者)：由全局审批宿主播种(`owned` 一次)、REQUESTED 推送追加、审批后移除；
 *    本机管理页每次读取 `owned` 也会发布到这里。设置页入口的提示点读这份。其中带 hostDeviceId 的是
 *    本机为同账号另一台电脑上的分享生成链接后、由本机负责弹窗的申请(provider-sharing.md §4.1)。
 *  - 待处理的转分享请求(分享者)：同一份 `owned` 快照里成员带的 reshares；RESHARE_REQUESTED 推送时重读。
 *
 * 注意：`owned` 会让 main 进入快速拉取(每 5 秒)，所以这里**不**在每次 OWNED_CHANGED 都重读，
 * 只在还有待审批申请时重读(那时 main 本来就在快速拉取)，以便撤回、过期的申请及时消失。
 */
import { useSyncExternalStore } from 'react';

import { PROVIDER_METADATA_TRUST_MS, readProviderMetadataContinuity, type ProviderShareReceived } from '@cindy/device-link';

import { hasSubscriptionShareCatalog, isSubscriptionShareCatalogStale } from '@/hooks/useDeviceProviders';
import { refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';
import { createLogger } from '@/lib/logger';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { getProviderShareFavoriteRegions, reconcileProviderShareFavorites } from '@/state/providerShareFavorites';

import type {
  ProviderShareOwnerState,
  ProviderShareReceivedSnapshot,
  ProviderShareRequestedEvent,
} from '../../../shared/providerShare';
import {
  diffReceivedShares,
  pendingRequestsFromOwnerState,
  pendingResharesFromOwned,
  providerShareAgentDeviceId,
  type ProviderSharePendingRequest,
  type ProviderSharePendingReshare,
} from './providerShareFormat';

const log = createLogger('providerShareStore');

type ProviderShareApi = Window['electronAPI']['providerShare'];

function providerShareApi(): ProviderShareApi | null {
  return (window as Partial<Window>).electronAPI?.providerShare ?? null;
}

// ─── 已收到的分享 ────────────────────────────────────────────────

export interface ReceivedSnapshot {
  received: readonly ProviderShareReceived[];
  /** 已拿到过一次权威列表(命令返回或推送)。 */
  loaded: boolean;
}

let receivedSnapshot: ReceivedSnapshot = { received: [], loaded: false };
type ShareRegion = ProviderShareReceived['owner']['region'];
/** Stable empty result while the renderer owner changed but no new snapshot has arrived. */
const EMPTY_OWNER_SNAPSHOT: ReceivedSnapshot = { received: [], loaded: false };
let receivedOwnerId: string | null = null;
let receivedOwnerGeneration = 0;
const retiredReceivedOwnerKeys = new Set<string>();
let receivedStarted = false;
let unsubscribeCatalogPush: (() => void) | undefined;
/** 推送序号：首次 `received` 命令晚于推送返回时，不得用旧列表覆盖。 */
let receivedPushSeq = 0;
const receivedSubscribers = new Set<() => void>();

type RegionBudget = NonNullable<ProviderShareReceivedSnapshot['regionBudget']>;

interface BudgetRequestStart {
  wall: number;
  mono: number;
}

interface RegionRetention {
  sourceId: string;
  /** Main-assigned request order; absent only for legacy/local projections. */
  order?: number;
  wallUntil: number;
  monoUntil: number;
  expired: boolean;
  retired: boolean;
}
const regionRetention = new Map<ShareRegion, RegionRetention>();
let regionRetentionTimer: ReturnType<typeof setTimeout> | null = null;
let expiredReadSource: ReceivedSnapshot | null = null;
let expiredReadSnapshot: ReceivedSnapshot | null = null;
let retentionCleanupTimer: ReturnType<typeof setTimeout> | null = null;
let expiredReadKey = '';

function clearRegionRetention(): void {
  if (regionRetentionTimer) clearTimeout(regionRetentionTimer);
  if (retentionCleanupTimer) clearTimeout(retentionCleanupTimer);
  regionRetentionTimer = null;
  retentionCleanupTimer = null;
  regionRetention.clear();
}

function scheduleExpiredRetentionCleanup(): void {
  if (retentionCleanupTimer) return;
  retentionCleanupTimer = setTimeout(() => {
    retentionCleanupTimer = null;
    expireRegionRetention();
  }, 0);
}

function sourceIsNewer(previous: RegionRetention | undefined, next: NonNullable<RegionBudget[ShareRegion]>): boolean {
  if (!previous) return true;
  if (previous.expired) {
    // Keep an expired source fenced until Main confirms a later request. A
    // wall-clock comparison cannot distinguish a rollback from an old reply.
    return previous.order !== undefined && next.order !== undefined && next.order > previous.order;
  }
  if (previous.order !== undefined) {
    return next.order !== undefined && next.order > previous.order;
  }
  return true;
}

function advanceRegionRetention(
  budget: RegionBudget | undefined,
  receivedWall = Date.now(),
  receivedMono = performance.now(),
  requestStart?: BudgetRequestStart,
): boolean {
  if (!budget) return false;
  let changed = false;
  for (const region of ['cn', 'global'] as const) {
    const row = budget[region];
    if (!row) continue;
    // For an IPC reply, deduct the whole renderer-side request interval. Main's
    // remainingMs is measured at snapshot generation; both local clocks bound
    // the hop without comparing absolute performance origins across processes.
    const hopWall = Math.max(0, receivedWall - (requestStart?.wall ?? row.generatedAt));
    const hopMono = requestStart ? Math.max(0, receivedMono - requestStart.mono) : 0;
    const hopAge = Math.max(hopWall, hopMono);
    const remaining = Math.max(0, Math.min(PROVIDER_METADATA_TRUST_MS, row.remainingMs - hopAge));
    const previous = regionRetention.get(region);
    if (previous?.sourceId === row.id) {
      if (previous.expired) continue;
      const wallUntil = receivedWall + remaining;
      const monoUntil = receivedMono + remaining;
      if (remaining <= 0) {
        previous.wallUntil = receivedWall;
        previous.monoUntil = receivedMono;
        previous.expired = true;
        changed = true;
      } else if (wallUntil < previous.wallUntil || monoUntil < previous.monoUntil) {
        // A repeated projection of the same confirmation may inherit a
        // shorter positive remainder; only tighten, never start a new window.
        previous.wallUntil = Math.min(previous.wallUntil, wallUntil);
        previous.monoUntil = Math.min(previous.monoUntil, monoUntil);
        changed = true;
      }
      continue;
    }
    if (!sourceIsNewer(previous, row)) continue;
    regionRetention.set(region, {
      sourceId: row.id,
      ...(row.order === undefined ? {} : { order: row.order }),
      wallUntil: receivedWall + remaining,
      monoUntil: receivedMono + remaining,
      expired: remaining <= 0,
      retired: false,
    });
    changed = true;
  }
  return changed;
}

function retentionLive(region: ShareRegion): boolean {
  const deadline = regionRetention.get(region);
  // No timestamp means an older Main snapshot; keep its original lifecycle.
  if (!deadline) return true;
  if (deadline.expired) {
    if (!deadline.retired) scheduleExpiredRetentionCleanup();
    return false;
  }
  const live = Date.now() < deadline.wallUntil && performance.now() < deadline.monoUntil;
  // Latch an observed expiry even when the timer is suspended. This is
  // metadata-only; getSnapshot must not notify or set React state. A bounded
  // deferred timer performs the one eventual catalog retirement.
  if (!live) {
    deadline.expired = true;
    scheduleExpiredRetentionCleanup();
  }
  return live;
}

/** A snapshot's region may be listed without being backed by its current source. */
function regionSourceCurrent(region: ShareRegion, sourceId: string | undefined): boolean {
  const deadline = regionRetention.get(region);
  if (!deadline) return true;
  if (deadline.expired) return false;
  return sourceId === undefined || deadline.sourceId === sourceId;
}

function armRegionRetentionTimer(): void {
  if (regionRetentionTimer) clearTimeout(regionRetentionTimer);
  regionRetentionTimer = null;
  let remaining = Infinity;
  let needsCleanup = false;
  for (const deadline of regionRetention.values()) {
    if (deadline.retired) continue;
    if (deadline.expired) { needsCleanup = true; continue; }
    const candidate = Math.min(deadline.wallUntil - Date.now(), deadline.monoUntil - performance.now());
    if (candidate > 0) remaining = Math.min(remaining, candidate);
    else needsCleanup = true;
  }
  if (needsCleanup) scheduleExpiredRetentionCleanup();
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  regionRetentionTimer = setTimeout(expireRegionRetention, remaining);
}

function expireRegionRetention(): void {
  regionRetentionTimer = null;
  // An old-owner timer must not re-attribute its surviving region rows to the
  // current account. Retire the previous owner first and drop this snapshot.
  const currentOwner = getDataOwnerGeneration().dataOwnerId;
  if (receivedOwnerId !== currentOwner) {
    clearReceivedIfOwnerChanged(currentOwner);
    return;
  }
  const now = Date.now(), mono = performance.now();
  const expired = new Set<ShareRegion>();
  for (const [region, deadline] of regionRetention) {
    if (deadline.retired) continue;
    if (deadline.expired || now >= deadline.wallUntil || mono >= deadline.monoUntil) {
      deadline.expired = true;
      expired.add(region);
    }
  }
  if (expired.size === 0) { armRegionRetentionTimer(); return; }
  // Mark the fence retired before notifying subscribers, so retentionLive
  // cannot schedule a second 0ms cleanup during setReceived.
  for (const region of expired) {
    const deadline = regionRetention.get(region);
    if (deadline) deadline.retired = true;
  }
  const previous = receivedSnapshot.received;
  const next = previous.filter(share => !expired.has(share.owner.region));
  if (next.length !== previous.length) setReceived(next, { clearEmpty: true });
  armRegionRetentionTimer();
}

function invalidateShareCatalogs(
  previous: readonly ProviderShareReceived[],
  next: readonly ProviderShareReceived[],
  options?: { clearEmpty?: boolean; skipCatalogs?: boolean; retireShareIds?: ReadonlySet<string> },
): void {
  // 旧 Main 把临时不可达也投影成空列表；调用方只有在确认区域完整时
  // 才允许用空列表撤权，否则必须保留上一份有界显示。
  if (next.length === 0 && !options?.clearEmpty && !options?.retireShareIds?.size) return;
  // An owner transition retires all previous rows at once; do not run a second
  // per-target refresh against the new owner.
  if (options?.skipCatalogs) return;
  const revokedCatalog = { providerContinuity: { stale: true, remainingMs: 0 } };
  const nextById = new Map(next.map((share) => [share.shareId, share]));
  const { changed, removed, revoked } = diffReceivedShares(previous, next);
  const revokedById = new Set(revoked);
  for (const shareId of changed) {
    const deviceId = providerShareAgentDeviceId(shareId);
    const after = nextById.get(shareId);
    // 暂停、成员/供应商/区域/主机身份变化是明确换了一代许可：
    // 即使刷新失败或卡住，也不能继续显示旧目录。
    const mustClear = revokedById.has(shareId) || after?.status !== 'active';
    if (options?.retireShareIds?.has(shareId)) void refreshRemoteCatalogSnapshot(deviceId, revokedCatalog, { retireOnly: true }).catch(() => undefined);
    else void refreshRemoteCatalogSnapshot(deviceId, mustClear ? revokedCatalog : undefined)
      .catch(() => undefined);
  }
  for (const shareId of removed) {
    // 已移出名单的分享没有可再读的目录；清掉界面上可能仍挂着的旧行。
    const deviceId = providerShareAgentDeviceId(shareId);
    // A share no longer in the authoritative list has no target to read; do
    // not repopulate its mounted catalog after removing the row.
    void refreshRemoteCatalogSnapshot(deviceId, revokedCatalog, { retireOnly: true }).catch(() => undefined);
  }
  for (const share of next) {
    const deviceId = providerShareAgentDeviceId(share.shareId);
    if (share.status === 'active' && isSubscriptionShareCatalogStale(deviceId)) {
      void refreshRemoteCatalogSnapshot(deviceId).catch(() => undefined);
    }
  }
}

function setReceived(
  next: readonly ProviderShareReceived[],
  options?: { clearEmpty?: boolean; skipCatalogs?: boolean; ownerId?: string | null; ownerGeneration?: number; loaded?: boolean },
): void {
  const previous = receivedSnapshot.received;
  const expiredShareIds = new Set<string>();
  const filtered = next.filter(share => {
    if (retentionLive(share.owner.region)) return true;
    expiredShareIds.add(share.shareId);
    return false;
  });
  // A stale row can already be absent from next (for example while a partial
  // neighbor-only projection is applied); it still must retire its catalog.
  // Do not turn one expired region into a blanket retirement of changed,
  // healthy neighbours in the same snapshot.
  for (const share of previous) {
    if (!retentionLive(share.owner.region)) expiredShareIds.add(share.shareId);
  }
  receivedOwnerId = options?.ownerId !== undefined ? options.ownerId : getDataOwnerGeneration().dataOwnerId;
  receivedOwnerGeneration = options?.ownerGeneration ?? getDataOwnerGeneration().generation;
  receivedSnapshot = { received: filtered, loaded: options?.loaded ?? true };
  expiredReadSource = null;
  expiredReadSnapshot = null;
  expiredReadKey = '';
  invalidateShareCatalogs(previous, filtered, expiredShareIds.size > 0
    ? { ...options, retireShareIds: expiredShareIds } : options);
  for (const listener of receivedSubscribers) listener();
}

function clearReceivedIfOwnerChanged(ownerId: string | null = getDataOwnerGeneration().dataOwnerId): void {
  if (receivedOwnerId === ownerId) return;
  if (receivedOwnerId !== null) retiredReceivedOwnerKeys.add(receivedOwnerId + ':' + receivedOwnerGeneration);
  const previous = receivedSnapshot.received;
  const changed = receivedSnapshot.loaded || previous.length > 0;
  receivedOwnerId = ownerId;
  receivedOwnerGeneration = getDataOwnerGeneration().generation;
  receivedSnapshot = EMPTY_OWNER_SNAPSHOT;
  expiredReadSource = null;
  expiredReadSnapshot = null;
  expiredReadKey = '';
  clearRegionRetention();
  if (changed) for (const listener of receivedSubscribers) listener();
}

function readRegionBudget(value: unknown): RegionBudget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed: RegionBudget = {};
  for (const region of ['cn', 'global'] as const) {
    const item = (value as Record<string, unknown>)[region];
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 256) continue;
    if (typeof row.remainingMs !== 'number' || !Number.isFinite(row.remainingMs)
      || row.remainingMs < 0 || row.remainingMs > PROVIDER_METADATA_TRUST_MS) continue;
    if (typeof row.generatedAt !== 'number' || !Number.isFinite(row.generatedAt) || row.generatedAt <= 0) continue;
    const order = typeof row.order === 'number' && Number.isInteger(row.order) && row.order >= 0
      ? row.order : undefined;
    parsed[region] = { id: row.id, ...(order === undefined ? {} : { order }),
      remainingMs: row.remainingMs, generatedAt: row.generatedAt };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function readReceivedSnapshot(value: unknown): ProviderShareReceivedSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<ProviderShareReceivedSnapshot>;
  if (!Array.isArray(row.received) || !Array.isArray(row.confirmedRegions)
    || !row.confirmedRegions.every(region => region === 'cn' || region === 'global')
    || !isDataOwnerPushStampCurrent(row.ownerStamp)) return null;
  const regionBudget = readRegionBudget(row.regionBudget);
  return {
    ownerStamp: row.ownerStamp,
    confirmedRegions: row.confirmedRegions,
    received: row.received,
    ...(typeof row.active === 'boolean' ? { active: row.active } : {}),
    ...(regionBudget ? { regionBudget } : {}),
  };
}

/** A snapshot with confirmed regions can tell an authoritative empty result from a
 * temporarily incomplete cross-region projection. An inactive runtime with no
 * shares is an explicit boundary and must retire all mounted catalogs. */
function applyReceivedSnapshot(snapshot: ProviderShareReceivedSnapshot, requestStart?: BudgetRequestStart): void {
  const ownerId = snapshot.ownerStamp.dataOwnerId;
  const previous = receivedSnapshot.received;
  const ownerChanged = receivedOwnerId === null ? previous.length > 0 : receivedOwnerId !== ownerId;
  if (ownerChanged) clearRegionRetention();
  if (snapshot.active === false && snapshot.received.length === 0) {
    clearRegionRetention();
    setReceived([], { clearEmpty: true, skipCatalogs: ownerChanged, ownerId });
    return;
  }
  advanceRegionRetention(snapshot.regionBudget, Date.now(), performance.now(), requestStart);
  const budget = snapshot.regionBudget;
  const acceptedConfirmed = snapshot.confirmedRegions.filter(region =>
    regionSourceCurrent(region, budget?.[region]?.id));
  const confirmed = new Set(acceptedConfirmed);
  const incoming = snapshot.received.filter(share =>
    retentionLive(share.owner.region) && regionSourceCurrent(share.owner.region, budget?.[share.owner.region]?.id));
  const currentIds = new Set(incoming.map(share => share.shareId));
  // Same-owner incomplete projections keep their unconfirmed rows only within the
  // deadline inherited from their last true confirmation; an owner change must not
  // carry the previous account's rows into the new owner.
  const retained = ownerChanged ? [] : previous.filter(share => !confirmed.has(share.owner.region)
    && !currentIds.has(share.shareId) && retentionLive(share.owner.region));
  // An empty, unconfirmed snapshot is not an authoritative empty list. This also
  // keeps a favorites-side query from claiming the new owner is fully loaded.
  const loaded = acceptedConfirmed.length > 0 || incoming.length > 0
    || (!ownerChanged && previous.length > 0);
  const next = [...incoming, ...retained];
  setReceived(next, { clearEmpty: true, skipCatalogs: ownerChanged, ownerId,
    ownerGeneration: snapshot.ownerStamp.ownerGeneration, loaded });
  armRegionRetentionTimer();
}

/** Apply only the monotonic/wall display window from an already-current
 * snapshot. This entry must not treat a cached row list as a fresh confirmation. */
function applyReceivedSnapshotBudget(snapshot: ProviderShareReceivedSnapshot, requestStart?: BudgetRequestStart): void {
  if (!advanceRegionRetention(snapshot.regionBudget, Date.now(), performance.now(), requestStart)) return;
  const previous = receivedSnapshot.received;
  const next = previous.filter(share => retentionLive(share.owner.region));
  if (next.length !== previous.length) {
    setReceived(next, { clearEmpty: true,
      ownerId: snapshot.ownerStamp.dataOwnerId, loaded: receivedSnapshot.loaded });
  } else {
    armRegionRetentionTimer();
  }
}

let membershipRequest = 0;
let membershipRetryTimer: ReturnType<typeof setTimeout> | null = null;
let membershipFailures = 0;
/** 远程任务所在电脑的收藏不在本机存储里，它们的区域同样是查询线索；按账号隔离，换账号即作废。 */
let favoriteRegionHints: { dataOwnerId: string | null; regions: ReadonlySet<ShareRegion> } = {
  dataOwnerId: null, regions: new Set(),
};

function hintedFavoriteRegions(dataOwnerId: string | null): readonly ShareRegion[] {
  return favoriteRegionHints.dataOwnerId === dataOwnerId ? [...favoriteRegionHints.regions] : [];
}

function refreshFavoriteMembership(api: ProviderShareApi): void {
  if (membershipRetryTimer) clearTimeout(membershipRetryTimer);
  membershipRetryTimer = null;
  const request = ++membershipRequest;
  const owner = getDataOwnerGeneration();
  const current = () => request === membershipRequest && isDataOwnerGenerationCurrent(owner);
  const retry = () => {
    if (!current()) return;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(membershipFailures++, 4));
    membershipRetryTimer = setTimeout(() => {
      membershipRetryTimer = null;
      if (current()) refreshFavoriteMembership(api);
    }, delay);
  };
  void (async () => {
    try {
      let local: ShareRegion[] = [];
      try { local = getProviderShareFavoriteRegions(owner.dataOwnerId); }
      catch { /* 清理器会报告存储错误并安排重试；读取恢复后再补齐区域线索。 */ }
      const regions = [...new Set([...local, ...hintedFavoriteRegions(owner.dataOwnerId)])];
      const requestStart = { wall: Date.now(), mono: performance.now() };
      const snapshot = await api.command({
        action: 'received-snapshot',
        favoriteRecovery: { ownerStamp: { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation }, regions },
      });
      if (!current()) return;
      if (!isDataOwnerPushStampCurrent(snapshot.ownerStamp)) { retry(); return; }
      // This entry may be the only call after a new owner switch. A returning
      // owner is fenced until an authoritative push/initial snapshot arrives;
      // a late favorites projection must not resurrect old A rows after A-B-A.
      const snapshotOwnerId = snapshot.ownerStamp.dataOwnerId;
      const retired = snapshotOwnerId !== null
        && retiredReceivedOwnerKeys.has(snapshotOwnerId + ':' + snapshot.ownerStamp.ownerGeneration);
      if (!retired && (receivedOwnerId !== snapshot.ownerStamp.dataOwnerId
        || !receivedSnapshot.loaded || snapshot.active === false || snapshot.regionBudget !== undefined)) {
        // A full authoritative snapshot (including an empty list or an explicit
        // inactive boundary) must remove rows immediately. applyReceivedSnapshot
        // still enforces source order and owner fences.
        applyReceivedSnapshot(snapshot, requestStart);
      } else if (!retired) {
        applyReceivedSnapshotBudget(snapshot, requestStart);
      }
      const cleaned = reconcileProviderShareFavorites(snapshot);
      if (!cleaned || regions.some((region) => !snapshot.confirmedRegions.includes(region))) retry();
      else membershipFailures = 0;
    } catch { retry(); } // 读失败不是撤权，重取最新名单而不是重放旧删除。
  })();
}

/** 启动已收到分享的同步(幂等)。Preload 不可用(测试 / 旧窗口)时什么都不做。 */
export function ensureProviderShareReceivedStarted(): void {
  // An owner switch remounts the router; subscription effects must retire the old owner's rows even when no share push/snapshot arrives.
  clearReceivedIfOwnerChanged();
  if (receivedStarted) return;
  const api = providerShareApi();
  if (!api) return;
  receivedStarted = true;
  unsubscribeCatalogPush = window.electronAPI?.deviceLink?.onRemotePush?.(push => {
    if (push.channel !== 'maker:provider:changed' || !push.deviceId.startsWith('share:')) return;
    if (!getReceivedSnapshot().received.some(share => providerShareAgentDeviceId(share.shareId) === push.deviceId && share.status === 'active')) return;
    const continuity = readProviderMetadataContinuity(push.payload);
    if (continuity?.remainingMs === 0) {
      // Explicit denial / expired budget: retire the display without reopening
      // the denied target (a prefetch would revive it and can feed a 403 loop).
      void refreshRemoteCatalogSnapshot(push.deviceId, push.payload, { retireOnly: true }).catch(() => undefined);
    } else if (hasSubscriptionShareCatalog(push.deviceId)) {
      void refreshRemoteCatalogSnapshot(push.deviceId, push.payload).catch(() => undefined);
    }
  });
  api.onReceivedChanged((list) => {
    const pushed = Array.isArray(list) ? list : [];
    receivedPushSeq += 1;
    const seq = receivedPushSeq;
    const owner = getDataOwnerGeneration();
    // Retire the old owner immediately; the new snapshot may stay pending or fail.
    clearReceivedIfOwnerChanged(owner.dataOwnerId);
    // The push is only a hint; ask Main for the same runtime snapshot with
    // confirmed regions so a cross-region outage cannot masquerade as removal.
    const requestStart = { wall: Date.now(), mono: performance.now() };
    void api.command({ action: 'received-snapshot' }).then((value) => {
      if (seq !== receivedPushSeq || !isDataOwnerGenerationCurrent(owner)) return;
      const snapshot = readReceivedSnapshot(value);
      if (snapshot) applyReceivedSnapshot(snapshot, requestStart);
      else setReceived(pushed, { ownerId: owner.dataOwnerId }); // Older Main / old preload fallback.
      refreshFavoriteMembership(api);
    }).catch(() => {
      if (seq !== receivedPushSeq || !isDataOwnerGenerationCurrent(owner)) return;
      setReceived(pushed, { ownerId: owner.dataOwnerId });
      refreshFavoriteMembership(api);
    });
  });
  const ownerAtRequest = getDataOwnerGeneration();
  clearReceivedIfOwnerChanged(ownerAtRequest.dataOwnerId);
  const seqAtRequest = receivedPushSeq;
  void (async () => {
    // Prefer the timestamped snapshot. Older Main falls back to the list command.
    try {
      const requestStart = { wall: Date.now(), mono: performance.now() };
      const value = await api.command({ action: 'received-snapshot' });
      if (receivedPushSeq !== seqAtRequest || !isDataOwnerGenerationCurrent(ownerAtRequest)) return;
      const snapshot = readReceivedSnapshot(value);
      if (snapshot) {
        applyReceivedSnapshot(snapshot, requestStart);
        refreshFavoriteMembership(api);
        return;
      }
    } catch { /* Older Main / unsupported snapshot command. */ }
    try {
      const list = await api.command({ action: 'received' });
      if (receivedPushSeq !== seqAtRequest || !isDataOwnerGenerationCurrent(ownerAtRequest)) return;
      clearReceivedIfOwnerChanged(ownerAtRequest.dataOwnerId);
      setReceived(list, { ownerId: ownerAtRequest.dataOwnerId });
      refreshFavoriteMembership(api);
    } catch (error: unknown) {
      log.debug('provider share received list unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (receivedPushSeq === seqAtRequest && isDataOwnerGenerationCurrent(ownerAtRequest)) refreshFavoriteMembership(api);
    }
  })();
}

/** AuthContext 的同账号修复不会重挂宿主，generation 更新时仍须重新核对收藏。 */
export function refreshProviderShareFavoriteMembership(): void {
  // ProviderShareGlobalHost runs this on every dataOwnerId/generation change; this is
  // the non-push owner-boundary entry that retires old-owner rows.
  clearReceivedIfOwnerChanged();
  if (!receivedStarted) {
    ensureProviderShareReceivedStarted();
    return;
  }
  const api = providerShareApi();
  if (api) refreshFavoriteMembership(api);
}

/**
 * 远程任务读写任务所在电脑的收藏：其中分享收藏的区域本机可能从没加载过，补进查询线索并重新
 * 核对一次名单，让对方区域的授权被恢复。区域已在线索里时什么都不做。
 */
export function requestProviderShareFavoriteRegions(regions: readonly ShareRegion[]): void {
  const { dataOwnerId } = getDataOwnerGeneration();
  const known = favoriteRegionHints.dataOwnerId === dataOwnerId ? favoriteRegionHints.regions : new Set<ShareRegion>();
  if (regions.every((region) => known.has(region))) return;
  favoriteRegionHints = { dataOwnerId, regions: new Set([...known, ...regions]) };
  refreshProviderShareFavoriteMembership();
}

/** 主动再取一次(退出分享后立即刷新列表；推送仍会随后到达)。 */
export function refreshProviderShareReceived(): void {
  const api = providerShareApi();
  if (!api) return;
  const ownerAtRequest = getDataOwnerGeneration();
  clearReceivedIfOwnerChanged(ownerAtRequest.dataOwnerId);
  const seqAtRequest = receivedPushSeq;
  void (async () => {
    try {
      // Use the timestamped snapshot first so a manual refresh inherits the
      // request-start budget instead of treating a cached array as a renewal.
      const requestStart = { wall: Date.now(), mono: performance.now() };
      const value = await api.command({ action: 'received-snapshot' });
      if (receivedPushSeq !== seqAtRequest || !isDataOwnerGenerationCurrent(ownerAtRequest)) return;
      const snapshot = readReceivedSnapshot(value);
      if (snapshot) {
        applyReceivedSnapshot(snapshot, requestStart);
        refreshFavoriteMembership(api);
        return;
      }
    } catch { /* Older Main / unsupported snapshot command. */ }
    try {
      const list = await api.command({ action: 'received' });
      if (receivedPushSeq !== seqAtRequest || !isDataOwnerGenerationCurrent(ownerAtRequest)) return;
      clearReceivedIfOwnerChanged(ownerAtRequest.dataOwnerId);
      setReceived(list, { ownerId: ownerAtRequest.dataOwnerId });
      refreshFavoriteMembership(api);
    } catch { /* The push path can still deliver a later authoritative list. */ }
  })();
}

function subscribeReceived(listener: () => void): () => void {
  ensureProviderShareReceivedStarted();
  receivedSubscribers.add(listener);
  return () => {
    receivedSubscribers.delete(listener);
  };
}

function getReceivedSnapshot(): ReceivedSnapshot {
  // The owner may change before the new IPC settles or after it fails. Never expose
  // the previous account's rows while the store is still attributed to the old owner.
  const owner = getDataOwnerGeneration().dataOwnerId;
  if (receivedOwnerId !== owner && (receivedOwnerId !== null || receivedSnapshot.loaded || receivedSnapshot.received.length > 0)) return EMPTY_OWNER_SNAPSHOT;
  const live = receivedSnapshot.received.filter(share => retentionLive(share.owner.region));
  if (live.length === receivedSnapshot.received.length) return receivedSnapshot;
  const liveKey = live.map(share => share.shareId + '@' + share.owner.region).join('|');
  // A timer may be suspended while the renderer is in the background. Keep the
  // read synchronous and stable, but never mutate/notify from getSnapshot.
  if (expiredReadSource !== receivedSnapshot || expiredReadKey !== liveKey) {
    expiredReadSource = receivedSnapshot;
    expiredReadKey = liveKey;
    expiredReadSnapshot = { received: live, loaded: receivedSnapshot.loaded };
  }
  return expiredReadSnapshot!;
}

export function useProviderShareReceived(): ReceivedSnapshot {
  return useSyncExternalStore(subscribeReceived, getReceivedSnapshot, getReceivedSnapshot);
}

// ─── 待审批申请(分享者) ────────────────────────────────────────

let pendingRequests: readonly ProviderSharePendingRequest[] = [];
const pendingSubscribers = new Set<() => void>();

function setPending(next: readonly ProviderSharePendingRequest[]): void {
  pendingRequests = next;
  for (const listener of pendingSubscribers) listener();
}

// 待处理的转分享请求(分享者，provider-sharing.md §4.3)：与待审批申请同出一份 owned 快照。
let pendingReshares: readonly ProviderSharePendingReshare[] = [];
const reshareSubscribers = new Set<() => void>();

function setPendingReshares(next: readonly ProviderSharePendingReshare[]): void {
  if (next.length === 0 && pendingReshares.length === 0) return;
  pendingReshares = next;
  for (const listener of reshareSubscribers) listener();
}

/** 一份 owned 快照是本机待审批申请(含转分享请求)的权威来源：整体替换。 */
export function publishProviderShareOwnerState(state: ProviderShareOwnerState, options: { hostDeviceId?: string } = {}): void {
  // 远程管理页只把审批申请交给本机审批宿主；转分享请求仍由管理对象本机维护。
  if (!options.hostDeviceId) setPendingReshares(state.ready ? pendingResharesFromOwned(state.shares) : []);
  const pending = pendingRequestsFromOwnerState(state);
  if (!options.hostDeviceId) {
    setPending(pending);
    return;
  }
  // 远程快照只覆盖这台被管理电脑，不能抹掉本机或其他被管理电脑的待审批申请。
  // watchedRequests 属于另一台电脑的审批宿主；远程快照只发布当前被管理电脑自己的申请。
  const remotePending = pending
    .filter((item) => !item.hostDeviceId || item.hostDeviceId === options.hostDeviceId)
    .map((item) => item.hostDeviceId ? item : { ...item, hostDeviceId: options.hostDeviceId });
  setPending([
    ...pendingRequests.filter((item) => item.hostDeviceId !== options.hostDeviceId),
    ...remotePending,
  ]);
}

export function getProviderSharePendingReshares(): readonly ProviderSharePendingReshare[] {
  return pendingReshares;
}

function subscribeReshares(listener: () => void): () => void {
  reshareSubscribers.add(listener);
  return () => {
    reshareSubscribers.delete(listener);
  };
}

/** 设置页入口的提示点与管理页「待处理」一栏读这份。 */
export function useProviderSharePendingReshares(): readonly ProviderSharePendingReshare[] {
  return useSyncExternalStore(subscribeReshares, getProviderSharePendingReshares, getProviderSharePendingReshares);
}

export function addProviderShareRequested(event: ProviderShareRequestedEvent): void {
  if (pendingRequests.some((item) => item.request.requestId === event.request.requestId)) return;
  setPending([...pendingRequests, {
    request: event.request,
    share: event.share,
    ...(event.hostDeviceId ? { hostDeviceId: event.hostDeviceId } : {}),
    ...(event.quiet ? { quiet: true } : {}),
  }]);
}

export function removeProviderSharePendingRequest(requestId: string): void {
  if (!pendingRequests.some((item) => item.request.requestId === requestId)) return;
  setPending(pendingRequests.filter((item) => item.request.requestId !== requestId));
}

export function getProviderSharePendingRequests(): readonly ProviderSharePendingRequest[] {
  return pendingRequests;
}

function subscribePending(listener: () => void): () => void {
  pendingSubscribers.add(listener);
  return () => {
    pendingSubscribers.delete(listener);
  };
}

export function useProviderSharePendingRequests(): readonly ProviderSharePendingRequest[] {
  return useSyncExternalStore(subscribePending, getProviderSharePendingRequests, getProviderSharePendingRequests);
}

// 管理页手动选中的申请也交给唯一的全局审批宿主展示，避免与迟到的自动弹窗叠在一起。
interface ProviderShareApprovalSelection {
  item: ProviderSharePendingRequest;
  onClose: () => void;
  trigger: HTMLElement | null;
}
let approvalSelection: ProviderShareApprovalSelection | null = null;
const approvalSubscribers = new Set<() => void>();

function setApprovalSelection(next: ProviderShareApprovalSelection | null): void {
  approvalSelection = next;
  for (const listener of approvalSubscribers) listener();
}

/** 页面用最新列表中的申请维护展示意图；刷新后申请消失或离开页面时撤销，不修改申请本身。 */
export function presentProviderShareApproval(
  item: ProviderSharePendingRequest,
  onClose: () => void,
  trigger: HTMLElement | null,
): () => void {
  const selection = { item, onClose, trigger };
  setApprovalSelection(selection);
  return () => { if (approvalSelection === selection) setApprovalSelection(null); };
}

function subscribeApprovalSelection(listener: () => void): () => void {
  approvalSubscribers.add(listener);
  return () => { approvalSubscribers.delete(listener); };
}

function getApprovalSelection(): ProviderShareApprovalSelection | null { return approvalSelection; }

export function useProviderShareApprovalSelection(): ProviderShareApprovalSelection | null {
  return useSyncExternalStore(subscribeApprovalSelection, getApprovalSelection, getApprovalSelection);
}

/** 读一次 owned 并发布(审批宿主播种 / 有待审批申请时随推送重读)。 */
export async function refreshProviderShareOwnerPending(): Promise<ProviderShareOwnerState | null> {
  const api = providerShareApi();
  if (!api) return null;
  try {
    const state = await api.command({ action: 'owned', range: 'month' });
    publishProviderShareOwnerState(state);
    return state;
  } catch (error) {
    log.debug('provider share owner state unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 仅测试用：重置模块状态。 */
export function resetProviderShareStoreForTests(): void {
  unsubscribeCatalogPush?.();
  unsubscribeCatalogPush = undefined;
  receivedSnapshot = { received: [], loaded: false };
  receivedOwnerId = null;
  retiredReceivedOwnerKeys.clear();
  receivedOwnerGeneration = 0;
  expiredReadSource = null;
  expiredReadSnapshot = null;
  expiredReadKey = '';
  clearRegionRetention();
  receivedStarted = false;
  receivedPushSeq = 0;
  membershipRequest += 1;
  if (membershipRetryTimer) clearTimeout(membershipRetryTimer);
  membershipRetryTimer = null;
  membershipFailures = 0;
  favoriteRegionHints = { dataOwnerId: null, regions: new Set() };
  receivedSubscribers.clear();
  pendingRequests = [];
  pendingSubscribers.clear();
  approvalSelection = null;
  approvalSubscribers.clear();
  pendingReshares = [];
  reshareSubscribers.clear();
}
