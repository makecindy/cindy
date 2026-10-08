/**
 * 供应商分享在 Renderer 里的两份共享状态(模块级单例，app 生命周期常驻，与
 * useDeviceLinkDeviceList 同一做法)：
 *
 *  - 已收到的分享(受邀者)：首个订阅者触发一次 `received`，之后靠 RECEIVED_CHANGED 推送。
 *    分享的状态、在线或所在电脑变化时刷新对应 `share:<id>` 的模型目录缓存，消失的分享作废缓存。
 *  - 待审批申请(分享者)：由全局审批宿主播种(`owned` 一次)、REQUESTED 推送追加、审批后移除；
 *    管理页每次读取 `owned` 也会发布到这里。设置页入口的提示点读这份。
 *
 * 注意：`owned` 会让 main 进入快速拉取(每 5 秒)，所以这里**不**在每次 OWNED_CHANGED 都重读，
 * 只在还有待审批申请时重读(那时 main 本来就在快速拉取)，以便撤回、过期的申请及时消失。
 */
import { useSyncExternalStore } from 'react';

import type { ProviderShareReceived } from '@cindy/device-link';

import { getCachedDeviceProviders } from '@/hooks/useDeviceProviders';
import { refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';
import { createLogger } from '@/lib/logger';

import type {
  ProviderShareOwnerState,
  ProviderShareRequestedEvent,
} from '../../../shared/providerShare';
import {
  diffReceivedShares,
  pendingRequestsFromOwned,
  providerShareAgentDeviceId,
  type ProviderSharePendingRequest,
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
let receivedStarted = false;
/** 推送序号：首次 `received` 命令晚于推送返回时，不得用旧列表覆盖。 */
let receivedPushSeq = 0;
const receivedSubscribers = new Set<() => void>();

function invalidateShareCatalogs(
  previous: readonly ProviderShareReceived[],
  next: readonly ProviderShareReceived[],
): void {
  // 设备互联断开 / 换账号时 main 先推一份空列表：那是「暂时读不到」，不作废已取到的目录，
  // 否则重连后列表原样回来(前后无差异)也不会再触发重取。
  if (next.length === 0) return;
  const { changed, removed } = diffReceivedShares(previous, next);
  for (const shareId of changed) {
    void refreshRemoteCatalogSnapshot(providerShareAgentDeviceId(shareId)).catch(() => undefined);
  }
  for (const shareId of removed) {
    const deviceId = providerShareAgentDeviceId(shareId);
    // 没取过目录就没有要作废的缓存；取过的重取一次，让模型列表拿到「已不可用」。
    if (getCachedDeviceProviders(deviceId)) {
      void refreshRemoteCatalogSnapshot(deviceId).catch(() => undefined);
    }
  }
}

function setReceived(next: readonly ProviderShareReceived[]): void {
  const previous = receivedSnapshot.received;
  receivedSnapshot = { received: next, loaded: true };
  invalidateShareCatalogs(previous, next);
  for (const listener of receivedSubscribers) listener();
}

/** 启动已收到分享的同步(幂等)。Preload 不可用(测试 / 旧窗口)时什么都不做。 */
export function ensureProviderShareReceivedStarted(): void {
  if (receivedStarted) return;
  const api = providerShareApi();
  if (!api) return;
  receivedStarted = true;
  api.onReceivedChanged((list) => {
    receivedPushSeq += 1;
    setReceived(Array.isArray(list) ? list : []);
  });
  const seqAtRequest = receivedPushSeq;
  void api
    .command({ action: 'received' })
    .then((list) => {
      if (receivedPushSeq !== seqAtRequest) return;
      setReceived(list);
    })
    .catch((error: unknown) => {
      log.debug('provider share received list unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** 主动再取一次(退出分享后立即刷新列表；推送仍会随后到达)。 */
export function refreshProviderShareReceived(): void {
  const api = providerShareApi();
  if (!api) return;
  const seqAtRequest = receivedPushSeq;
  void api
    .command({ action: 'received' })
    .then((list) => {
      if (receivedPushSeq !== seqAtRequest) return;
      setReceived(list);
    })
    .catch(() => undefined);
}

function subscribeReceived(listener: () => void): () => void {
  ensureProviderShareReceivedStarted();
  receivedSubscribers.add(listener);
  return () => {
    receivedSubscribers.delete(listener);
  };
}

function getReceivedSnapshot(): ReceivedSnapshot {
  return receivedSnapshot;
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

/** 一份 owned 快照是本机待审批申请的权威来源：整体替换。 */
export function publishProviderShareOwnerState(state: ProviderShareOwnerState): void {
  setPending(state.ready ? pendingRequestsFromOwned(state.shares) : []);
}

export function addProviderShareRequested(event: ProviderShareRequestedEvent): void {
  if (pendingRequests.some((item) => item.request.requestId === event.request.requestId)) return;
  setPending([...pendingRequests, { request: event.request, share: event.share }]);
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
  receivedSnapshot = { received: [], loaded: false };
  receivedStarted = false;
  receivedPushSeq = 0;
  receivedSubscribers.clear();
  pendingRequests = [];
  pendingSubscribers.clear();
}
