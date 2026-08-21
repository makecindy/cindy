/**
 * Shared sidebar cost projection.
 *
 * SessionItem/SessionCard used to call useSessionUsageMoney per row, which
 * scanned every assistant message and registered a turn-cost listener. This
 * store coalesces visible rows into one main-process batch query and one
 * shared listener pair.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import {
  combineSessionUsageMoney,
  subtractExcludedActualMoney,
  type SessionUsageMoney,
} from '@/hooks/useSessionUsageMoney';
import { estimatedSessionValueBatchFor } from '@/lib/makerTransport';
import {
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
  type SdkCostPresentation,
} from '../../../../shared/regionalMoney';

export const EMPTY_SIDEBAR_SESSION_USAGE: SessionUsageMoney = {
  actualMoney: null,
  estimatedValueMoney: null,
  totalMoney: null,
};

interface CacheEntry {
  actualMoney: RegionalMoney | null;
  estimatedValueMoney: RegionalMoney | null;
  excludedActualMoney: RegionalMoney | null;
  usage: SessionUsageMoney;
  presentation: SdkCostPresentation;
  showSdkEstimate: boolean;
}

interface Interest {
  presentation: SdkCostPresentation;
  showSdkEstimate: boolean;
}

const cache = new Map<string, CacheEntry>();
const interests = new Map<string, Set<() => void>>();
const interestParams = new Map<string, Interest>();
const pending = new Set<string>();
const inflight = new Set<string>();
let listenersInstalled = false;
let unsubscribeTurnCost: (() => void) | undefined;
let unsubscribeSpend: (() => void) | undefined;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function buildUsage(
  actualMoney: RegionalMoney | null,
  estimatedValueMoney: RegionalMoney | null,
  excludedActualMoney: RegionalMoney | null,
): SessionUsageMoney {
  return combineSessionUsageMoney(
    subtractExcludedActualMoney(actualMoney, excludedActualMoney),
    estimatedValueMoney,
  );
}

function notify(sessionId: string): void {
  const subs = interests.get(sessionId);
  if (!subs) return;
  for (const listener of subs) listener();
}

function areMoneyEqual(a: RegionalMoney | null, b: RegionalMoney | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.amount === b.amount && a.currency === b.currency && a.kind === b.kind;
}

function writeCache(
  sessionId: string,
  patch: Partial<Omit<CacheEntry, 'usage'>> & Pick<CacheEntry, 'presentation' | 'showSdkEstimate'>,
): CacheEntry {
  const prev = cache.get(sessionId);
  const actualMoney = patch.actualMoney !== undefined ? patch.actualMoney : (prev?.actualMoney ?? null);
  const estimatedValueMoney =
    patch.estimatedValueMoney !== undefined
      ? patch.estimatedValueMoney
      : (prev?.estimatedValueMoney ?? null);
  const excludedActualMoney =
    patch.excludedActualMoney !== undefined
      ? patch.excludedActualMoney
      : (prev?.excludedActualMoney ?? null);
  if (
    prev &&
    prev.presentation === patch.presentation &&
    prev.showSdkEstimate === patch.showSdkEstimate &&
    areMoneyEqual(prev.actualMoney, actualMoney) &&
    areMoneyEqual(prev.estimatedValueMoney, estimatedValueMoney) &&
    areMoneyEqual(prev.excludedActualMoney, excludedActualMoney)
  ) {
    return prev;
  }
  const next: CacheEntry = {
    actualMoney,
    estimatedValueMoney,
    excludedActualMoney,
    presentation: patch.presentation,
    showSdkEstimate: patch.showSdkEstimate,
    usage: buildUsage(actualMoney, estimatedValueMoney, excludedActualMoney),
  };
  cache.set(sessionId, next);
  notify(sessionId);
  return next;
}

function installSharedListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  unsubscribeSpend = window.electronAPI.onUsageSessionSpendChanged?.((res, ownerStamp) => {
    if (!isDataOwnerPushCurrent(ownerStamp)) return;
    const params = interestParams.get(res.sessionId);
    if (!params) return;
    writeCache(res.sessionId, {
      actualMoney:
        normalizeRegionalMoney(res.totalMoney) ??
        (typeof res.totalCostUsd === 'number' ? legacyUsdMoney(res.totalCostUsd) : null),
      presentation: params.presentation,
      showSdkEstimate: params.showSdkEstimate,
    });
  });
  unsubscribeTurnCost = window.electronAPI.onUsageMessageTurnCost?.((payload, ownerStamp) => {
    if (!isDataOwnerPushCurrent(ownerStamp)) return;
    if (!interestParams.has(payload.sessionId)) return;
    pending.add(payload.sessionId);
    scheduleFlush();
  });
}

function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, 0);
}

async function flushPending(): Promise<void> {
  const sessionIds = [...pending].filter((sessionId) => !inflight.has(sessionId));
  for (const sessionId of sessionIds) pending.delete(sessionId);
  if (sessionIds.length === 0) return;
  for (const sessionId of sessionIds) inflight.add(sessionId);
  const requests = sessionIds.flatMap((sessionId) => {
    const params = interestParams.get(sessionId);
    return params ? [{ sessionId, presentation: params.presentation, showSdkEstimate: params.showSdkEstimate }] : [];
  });
  const grouped = new Map<boolean, typeof requests>();
  for (const request of requests) {
    const list = grouped.get(request.showSdkEstimate) ?? [];
    list.push(request);
    grouped.set(request.showSdkEstimate, list);
  }
  try {
    for (const [showSdkEstimate, group] of grouped) {
      const summaries = await estimatedSessionValueBatchFor(group, showSdkEstimate);
      for (const request of group) {
        const summary = summaries[request.sessionId];
        const params = interestParams.get(request.sessionId);
        if (!params) continue;
        writeCache(request.sessionId, {
          estimatedValueMoney: summary?.estimatedValueMoney ?? null,
          excludedActualMoney: summary?.excludedActualMoney ?? null,
          presentation: params.presentation,
          showSdkEstimate: params.showSdkEstimate,
        });
      }
    }
  } catch {
    // Sidebar cost is decorative; keep the last snapshot / ledger amount.
  } finally {
    for (const sessionId of sessionIds) inflight.delete(sessionId);
    if (pending.size > 0) scheduleFlush();
  }
}

function ensureInterest(
  sessionId: string,
  presentation: SdkCostPresentation,
  showSdkEstimate: boolean,
  actualMoney: RegionalMoney | null,
): void {
  const prev = interestParams.get(sessionId);
  const presentationChanged =
    !prev || prev.presentation !== presentation || prev.showSdkEstimate !== showSdkEstimate;
  interestParams.set(sessionId, { presentation, showSdkEstimate });
  const cached = cache.get(sessionId);
  if (!cached || presentationChanged) {
    writeCache(sessionId, {
      actualMoney: actualMoney ?? cached?.actualMoney ?? null,
      presentation,
      showSdkEstimate,
      ...(presentationChanged ? { estimatedValueMoney: null, excludedActualMoney: null } : {}),
    });
    pending.add(sessionId);
    scheduleFlush();
    return;
  }
  if (actualMoney && cached.actualMoney == null) {
    writeCache(sessionId, { actualMoney, presentation, showSdkEstimate });
  }
}

function subscribeSession(sessionId: string, listener: () => void): () => void {
  installSharedListeners();
  const subs = interests.get(sessionId) ?? new Set<() => void>();
  subs.add(listener);
  interests.set(sessionId, subs);
  return () => {
    const current = interests.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      interests.delete(sessionId);
      interestParams.delete(sessionId);
    }
  };
}

function getSessionSnapshot(sessionId: string): SessionUsageMoney {
  return cache.get(sessionId)?.usage ?? EMPTY_SIDEBAR_SESSION_USAGE;
}

export function useSidebarSessionUsageMoney(
  sessionId: string | undefined,
  initialMoney: RegionalMoney | null | undefined,
  initialCostUsd: number | null | undefined,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): SessionUsageMoney {
  const actualMoney =
    normalizeRegionalMoney(initialMoney) ??
    (typeof initialCostUsd === 'number' ? legacyUsdMoney(initialCostUsd) : null);
  const actualRef = useRef(actualMoney);
  actualRef.current = actualMoney;
  useEffect(() => {
    if (!sessionId) return undefined;
    ensureInterest(sessionId, presentation, showSdkEstimate, actualRef.current);
    return undefined;
  }, [presentation, sessionId, showSdkEstimate]);

  const subscribe = useCallback((listener: () => void) => {
    if (!sessionId) return () => undefined;
    return subscribeSession(sessionId, listener);
  }, [sessionId]);

  const getSnapshot = useCallback(
    () => (sessionId ? getSessionSnapshot(sessionId) : EMPTY_SIDEBAR_SESSION_USAGE),
    [sessionId],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SIDEBAR_SESSION_USAGE);
}

export function __resetSidebarSessionUsageStoreForTests(): void {
  cache.clear();
  interests.clear();
  interestParams.clear();
  pending.clear();
  inflight.clear();
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  unsubscribeTurnCost?.();
  unsubscribeSpend?.();
  unsubscribeTurnCost = undefined;
  unsubscribeSpend = undefined;
  listenersInstalled = false;
}

