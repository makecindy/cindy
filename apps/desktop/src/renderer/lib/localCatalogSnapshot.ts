/**
 * 本地 provider catalog 的 renderer 原子刷新协调器。
 *
 * providers 与核心 agent capabilities 必须来自同一轮 main 快照：核心 IPC 全部成功、
 * 且期间没有更新一代目录时才同步提交。明确未注册的可选引擎可从快照中省略；其它失败
 * 或乱序结果一律保留上一份有效快照。
 * device-link 的远端 capabilities 不经过这里，继续按 deviceId 独立缓存。
 */
import type { ProviderView } from '@cindy/model-providers';
import { createLogger } from '@/lib/logger';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import {
  getModelVisibilityInitializationFailure,
  migrateModelVisibilityDefaults,
} from '@/state/modelVisibilityPrefs';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  getLocalCatalogFailure,
  setLocalCatalogFailure,
  type LocalCatalogFailureReason,
} from './localCatalogLoadState';
import { extractIpcError } from '@/utils/ipcError';
import {
  beginLocalCapabilitiesRefresh,
  commitLocalCapabilitiesSnapshot,
  isLocalCapabilitiesRefreshCurrent,
  loadLocalCapabilitiesSnapshot,
} from '@/hooks/useAgentCapabilities';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
  failProvidersRefresh,
  getCachedProvidersSnapshot,
  isProvidersRefreshCurrent,
  loadProvidersSnapshot,
  type ProvidersSnapshot,
} from '@/lib/providersSnapshotStore';

/** Only model presentation reads this projection. Shared catalog consumers use current routes. */
export function withSubscriptionDisplayModels(provider: ProviderView): ProviderView {
  const models = provider.subscriptionDisplayModels;
  return !provider.removed && models && Object.values(models).some(entries => entries?.length)
    ? { ...provider, models, connected: true }
    : provider;
}

const log = createLogger('localCatalogSnapshot');
let refreshGeneration = 0;
let refreshOwner = getDataOwnerGeneration();
let scheduleRefresh = createCoalescedRefresh<boolean>();
const RECOVERY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
// Network-type failures (catalog IPC failed, or a subscription account cannot be read) then
// retry once a minute for ten more minutes: an outage often outlasts the first minute and the
// OS may never report it offline/online (2026-11-20). Local storage failures keep the short budget.
const NETWORK_RECOVERY_DELAYS_MS = [...RECOVERY_DELAYS_MS, ...Array<number>(10).fill(60_000)];
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryAttempt = 0;
let recoveryOwners = 0;

function cancelRecovery(): void {
  clearTimeout(recoveryTimer);
  recoveryTimer = undefined;
}

function scheduleRecovery(owner: DataOwnerGeneration, network: boolean): void {
  const delays: readonly number[] = network ? NETWORK_RECOVERY_DELAYS_MS : RECOVERY_DELAYS_MS;
  if (!recoveryOwners || document.visibilityState !== 'visible'
    || recoveryAttempt >= delays.length) return;
  cancelRecovery();
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined;
    if (!isDataOwnerGenerationCurrent(owner) || document.visibilityState !== 'visible') return;
    recoveryAttempt += 1;
    void refreshSnapshot();
  }, delays[recoveryAttempt]);
}

function failed(owner: DataOwnerGeneration, reason: LocalCatalogFailureReason): void {
  if (!isDataOwnerGenerationCurrent(owner)) return;
  setLocalCatalogFailure(owner, reason);
  // Corrupt preferences require deliberate repair. Other failures share the
  // existing bounded recovery timer, including a partial native-account read.
  if (reason !== 'preferences-corrupt') scheduleRecovery(owner, reason === 'catalog-unavailable');
}

function isUnavailableSubscription(provider: ProvidersSnapshot['providers'][number]): boolean {
  return !provider.suspended && !provider.removed && provider.subscriptionReadUnavailable === true;
}

function hasUnavailableSubscription(snapshot: ProvidersSnapshot | null): boolean {
  return snapshot?.providers.some(isUnavailableSubscription) ?? false;
}

function hasRecoveredSubscription(previous: ProvidersSnapshot | null, next: ProvidersSnapshot): boolean {
  if (!previous || previous.dataOwnerId !== next.dataOwnerId
    || previous.ownerGeneration !== next.ownerGeneration) return false;
  const previouslyUnavailable = new Map(previous.providers.filter(isUnavailableSubscription)
    .map(provider => [provider.id, provider.connected]));
  return next.providers.some(provider => {
    if (!provider.connected || provider.suspended || provider.removed) return false;
    const wasConnected = previouslyUnavailable.get(provider.id);
    return wasConnected !== undefined && (!wasConnected || !provider.subscriptionReadUnavailable);
  });
}

/**
 * Network is back: let Main retry the model sources whose last fetch failed now instead of
 * after their failure cooldown. Main joins in-flight work and keeps successful sources on
 * their normal cooldown, so repeated reports stay cheap.
 */
function requestNetworkRestoredRefresh(): void {
  // Optional: test windows and older preloads may not expose it.
  const maker = window.electronAPI?.maker;
  if (typeof maker?.requestProviderModelsAutoRefresh !== 'function') return;
  Promise.resolve(maker.requestProviderModelsAutoRefresh('network-restored')).catch(() => {});
}

/** Main-window lifecycle owns recovery. Never leave polling behind after unmount/HMR. */
export function startLocalCatalogRecovery(): () => void {
  if (!recoveryOwners) recoveryAttempt = 0;
  recoveryOwners += 1;
  const retry = (): void => {
    if (document.visibilityState !== 'visible') return;
    const owner = getDataOwnerGeneration();
    const snapshot = getCachedProvidersSnapshot();
    // An owner-generation change hides the previous failure. A foreground
    // retry may still be needed if this account has no current complete snapshot.
    if (getLocalCatalogFailure() || (owner.dataOwnerId && (!snapshot
      || snapshot.ownerGeneration !== owner.generation || hasUnavailableSubscription(snapshot)))) void refreshLocalCatalogSnapshot();
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') retry();
    else cancelRecovery();
  };
  const onOnline = (): void => {
    requestNetworkRestoredRefresh();
    retry();
  };
  window.addEventListener('focus', retry);
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  // Initial preload can finish before this lifecycle mounts. Recover its partial
  // read through the same bounded timer; configuration uses onProvidersChanged.
  if (hasUnavailableSubscription(getCachedProvidersSnapshot())) scheduleRecovery(getDataOwnerGeneration(), true);
  return () => {
    recoveryOwners -= 1;
    window.removeEventListener('focus', retry);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    if (!recoveryOwners) cancelRecovery();
  };
}

/** 联合刷新 providers + 可用 agent capabilities，并只提交最新的完整结果。 */
export async function refreshLocalCatalogSnapshot(): Promise<boolean> {
  recoveryAttempt = 0;
  return refreshSnapshot();
}

async function refreshSnapshot(): Promise<boolean> {
  cancelRecovery();
  const owner = getDataOwnerGeneration();
  if (owner !== refreshOwner) {
    // A new owner must not wait for an old owner's outstanding IPC.
    refreshOwner = owner;
    scheduleRefresh = createCoalescedRefresh<boolean>();
  }
  const generation = ++refreshGeneration;
  const providersGeneration = beginProvidersRefresh();
  const capabilitiesGeneration = beginLocalCapabilitiesRefresh();

  return scheduleRefresh(async () => {
    if (generation !== refreshGeneration) return false;
    try {
      // A failed member must not release the scheduling slot while its siblings
      // are still reading; otherwise the trailing round overlaps them again.
      const results = await Promise.allSettled([
        loadProvidersSnapshot(),
        loadLocalCapabilitiesSnapshot(),
      ]);
      const [providerResult, capabilitiesResult] = results;
      if (providerResult.status === 'rejected') throw providerResult.reason;
      if (capabilitiesResult.status === 'rejected') throw capabilitiesResult.reason;
      const providers = providerResult.value;
      const capabilities = capabilitiesResult.value;
      const isCurrent = (): boolean => refreshGeneration === generation
        && isProvidersRefreshCurrent(providersGeneration, providers)
        && isLocalCapabilitiesRefreshCurrent(capabilitiesGeneration);
      if (!isCurrent()) {
        if (refreshGeneration === generation) failed(owner, 'owner-pending');
        return false;
      }
      const initialized = await migrateModelVisibilityDefaults(
        providers.dataOwnerId,
        providers.ownerGeneration,
        providers.providers,
        isCurrent,
      );
      // Failed persistence/locking must reach preload's retry loop. Waiting for another
      // renderer's preference write must not publish a stale catalog either.
      if (!isCurrent()) {
        if (refreshGeneration === generation) failed(owner, 'owner-pending');
        failProvidersRefresh(providersGeneration);
        return false;
      }
      if (!initialized) {
        failProvidersRefresh(providersGeneration);
        failed(owner, getModelVisibilityInitializationFailure(providers.dataOwnerId, providers.ownerGeneration)
          ?? 'preferences-unavailable');
        return false;
      }

      // One source recovering is enough to retry failed refreshes, even without an OS event.
      const recovered = hasRecoveredSubscription(getCachedProvidersSnapshot(), providers);
      // 两次提交均为同步通知；React 会把同一事件循环内的 hook 更新批处理到同一帧。
      commitLocalCapabilitiesSnapshot(capabilitiesGeneration, capabilities);
      commitProvidersSnapshot(providersGeneration, providers);
      setLocalCatalogFailure(owner, null);
      if (hasUnavailableSubscription(providers)) scheduleRecovery(owner, true);
      else recoveryAttempt = 0;
      if (recovered) requestNetworkRestoredRefresh();
      return true;
    } catch (error) {
      if (refreshGeneration === generation) {
        failProvidersRefresh(providersGeneration);
        if (isDataOwnerGenerationCurrent(owner)) {
          log.warn('local catalog snapshot refresh failed; keeping last valid snapshot', {
            code: extractIpcError(error)?.code ?? 'UNKNOWN',
          });
          failed(owner, 'catalog-unavailable');
        }
      }
      return false;
    }
  });
}

/** 启动预热保留原有三次瞬时 IPC 重试语义；每次仍按可用快照原子提交。 */
export async function preloadLocalCatalogSnapshot(): Promise<void> {
  const owner = getDataOwnerGeneration();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isDataOwnerGenerationCurrent(owner)) return;
    if (await refreshLocalCatalogSnapshot()) return;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (isDataOwnerGenerationCurrent(owner)) {
    log.warn('local catalog snapshot preload failed after 3 attempts');
  }
}
