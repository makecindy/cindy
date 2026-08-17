/**
 * useSessionEstimatedValue — 订阅当前 Codex 订阅会话的"本会话价值"。
 *
 * 订阅价值不能写入 sessions.total_cost_usd（那是 scheduler / API 账单的真实 cost）。
 * 这里从 assistant message 的结构化 turnMoney 估算值汇总，历史初值走 main
 * 侧 SQLite 汇总，实时增量走 usage:message-turn-cost。旧 turnCostUsd 只作为
 * 历史 USD 候选；与当前会话账本币种不兼容时由统一展示投影丢弃。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { estimatedSessionValueFor } from '@/lib/makerTransport';
import { resolveMessageCustomProviderCostPresentation } from '@/lib/customProviderCostPresentation';
import {
  projectSdkCostMoneyWithBreakdown,
  resolveTurnSdkCostPresentation,
} from '../../shared/customProviderBilling';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../shared/codexSubscriptionValue';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  usdMoney,
  USD_TO_CNY_FIXED_RATE,
  type MoneyEstimateReason,
  type RegionalMoney,
  type SdkCostPresentation,
} from '../../shared/regionalMoney';
import { normalizeTurnUsageDetails } from '../../shared/turnUsageDetails';

interface EstimatedValueStoreSnapshot {
  messages: ChatMessage[];
  historyLoaded: boolean;
  hasMoreMessages: boolean;
}

interface EstimatedValueStoreSyncResult {
  costs: Map<string, RegionalMoney>;
  excludedActualCosts: Map<string, RegionalMoney>;
  storeClientIds: Set<string>;
}

export interface SessionEstimatedValueProjection {
  estimatedValueMoney: RegionalMoney | null;
  excludedActualMoney: RegionalMoney | null;
}

export function resolveEstimatedValueMessageProjection(
  message: ChatMessage,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): {
  clientId: string;
  money: RegionalMoney | null;
  excludedActualMoney: RegionalMoney | null;
} | null {
  return projectionFromChatMessage(message, presentation, showSdkEstimate);
}

interface EstimatedValueTurnCostPayload {
  clientId: string;
  turnMoney?: unknown;
  turnCostUsd?: number;
  /**
   * 无报价轮(main 的 recordTurnUsageOnMessage)只推 turnUsageDetails,整组金额字段
   * 缺省 —— 与 MessageTurnCostPayload 保持一致的可选性。下面的
   * `turnCostIsEstimate !== true` 早退本就把这类轮次挡在估值汇总之外。
   */
  turnCostIsEstimate?: boolean;
  turnCostIsCustomProvider?: boolean;
  turnUsageDetails?: unknown;
}

function asValueEstimate(
  money: RegionalMoney,
  reason: MoneyEstimateReason = 'subscription-value',
): RegionalMoney {
  const estimateReasons = [...new Set([...(money.estimateReasons ?? []), reason])];
  return {
    ...money,
    approximate: true,
    kind: 'value-estimate',
    estimateReasons,
  };
}

function correctStaleUsdEstimate(
  money: RegionalMoney,
  turnUsageDetails: unknown,
  model?: string,
): RegionalMoney {
  const reasons = money.estimateReasons ?? [];
  if (reasons.includes('sdk-estimate')) return money;
  const isLegacyCnyProjection =
    money.currency === 'CNY' && reasons.includes('legacy-usd') && reasons.includes('fixed-fx');
  if (money.currency !== 'USD' && !isLegacyCnyProjection) return money;
  const amountUsd = isLegacyCnyProjection ? money.amount / USD_TO_CNY_FIXED_RATE : money.amount;
  const corrected = resolveStaleCodexSubscriptionValueEstimate(
    amountUsd,
    normalizeTurnUsageDetails(turnUsageDetails),
    model,
  );
  if (corrected == null) return money;
  return {
    ...money,
    amount: isLegacyCnyProjection ? corrected * USD_TO_CNY_FIXED_RATE : corrected,
  };
}

function legacyEstimateMoney(costUsd: number): RegionalMoney | null {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return usdMoney(costUsd, 'value-estimate', 'legacy-usd');
}

function projectionFromChatMessage(
  message: ChatMessage,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): {
  clientId: string;
  money: RegionalMoney | null;
  excludedActualMoney: RegionalMoney | null;
} | null {
  if (message.role !== 'assistant') return null;
  const raw =
    normalizeRegionalMoney(message.turnMoney) ??
    (typeof message.turnCostUsd === 'number'
      ? message.turnCostIsEstimate === true
        ? legacyEstimateMoney(message.turnCostUsd)
        : usdMoney(message.turnCostUsd)
      : null);
  const turnPresentation = resolveMessageCustomProviderCostPresentation(
    message,
    presentation,
    showSdkEstimate,
  );
  const excludedActualMoney =
    raw?.kind === 'actual-cost' &&
    message.turnCostIsEstimate !== true &&
    turnPresentation !== 'regular'
      ? raw
      : null;
  if (turnPresentation === 'regular' && message.turnCostIsEstimate !== true) {
    return excludedActualMoney
      ? { clientId: message.clientId, money: null, excludedActualMoney }
      : null;
  }
  const details = normalizeTurnUsageDetails(message.turnUsageDetails);
  const normalized = projectSdkCostMoneyWithBreakdown(
    raw,
    details?.perModelCost?.map((entry) => entry.money),
    turnPresentation,
  );
  if (!normalized || normalized.amount <= 0 || normalized.kind !== 'value-estimate') {
    return excludedActualMoney
      ? { clientId: message.clientId, money: null, excludedActualMoney }
      : null;
  }
  return {
    clientId: message.clientId,
    money: correctStaleUsdEstimate(
      asValueEstimate(
        normalized,
        normalized.estimateReasons?.includes('sdk-estimate')
          ? 'sdk-estimate'
          : 'subscription-value',
      ),
      message.turnUsageDetails,
      message.model,
    ),
    excludedActualMoney,
  };
}

function areMoneyEqual(a: RegionalMoney, b: RegionalMoney): boolean {
  if (
    a.amount !== b.amount ||
    a.currency !== b.currency ||
    a.approximate !== b.approximate ||
    a.kind !== b.kind
  ) {
    return false;
  }
  const aReasons = a.estimateReasons ?? [];
  const bReasons = b.estimateReasons ?? [];
  return (
    aReasons.length === bReasons.length &&
    aReasons.every((reason, index) => reason === bReasons[index])
  );
}

function areCostMapsEqual(
  a: ReadonlyMap<string, RegionalMoney>,
  b: ReadonlyMap<string, RegionalMoney>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || !areMoneyEqual(value, other)) return false;
  }
  return true;
}

function isAuthoritativeEmptyTranscript(snapshot: EstimatedValueStoreSnapshot): boolean {
  return snapshot.historyLoaded && snapshot.messages.length === 0 && !snapshot.hasMoreMessages;
}

function hasVisibleClientId(snapshot: EstimatedValueStoreSnapshot, clientId: string): boolean {
  return snapshot.messages.some((message) => message.clientId === clientId);
}

export function shouldApplyEstimatedValueEntry(
  snapshot: EstimatedValueStoreSnapshot,
  clientId: string,
  transcriptCleared: boolean,
): boolean {
  if (!transcriptCleared) return true;
  return hasVisibleClientId(snapshot, clientId);
}

export function syncEstimatedValueCostsFromStoreSnapshot(
  currentCosts: ReadonlyMap<string, RegionalMoney>,
  previousStoreClientIds: ReadonlySet<string>,
  snapshot: EstimatedValueStoreSnapshot,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
  currentExcludedActualCosts: ReadonlyMap<string, RegionalMoney> = new Map(),
): EstimatedValueStoreSyncResult | null {
  if (snapshot.messages.length === 0 && !snapshot.historyLoaded) return null;

  const storeClientIds = new Set<string>();
  const next = new Map(currentCosts);
  const nextExcludedActualCosts = new Map(currentExcludedActualCosts);
  if (isAuthoritativeEmptyTranscript(snapshot)) {
    // /clear only hides the transcript. sessions.totalMoney remains a lifetime
    // ledger, so DB-backed legacy SDK exclusions must survive the empty view.
    return { costs: new Map(), excludedActualCosts: nextExcludedActualCosts, storeClientIds };
  }

  for (const message of snapshot.messages) {
    if (message.clientId) storeClientIds.add(message.clientId);
  }
  for (const clientId of previousStoreClientIds) {
    if (!storeClientIds.has(clientId)) {
      next.delete(clientId);
      // A disappearing row may have been cleared or rewound while its amount is
      // still present in sessions.totalMoney. Keep its exclusion until an
      // authoritative row for the same clientId replaces it.
    }
  }
  for (const message of snapshot.messages) {
    if (!message.clientId) continue;
    const entry = projectionFromChatMessage(message, presentation, showSdkEstimate);
    if (entry?.money) {
      next.set(entry.clientId, entry.money);
    } else {
      next.delete(message.clientId);
    }
    if (entry?.excludedActualMoney) {
      nextExcludedActualCosts.set(entry.clientId, entry.excludedActualMoney);
    } else {
      nextExcludedActualCosts.delete(message.clientId);
    }
  }
  if (
    areCostMapsEqual(currentCosts, next) &&
    areCostMapsEqual(currentExcludedActualCosts, nextExcludedActualCosts)
  ) {
    return {
      costs: new Map(currentCosts),
      excludedActualCosts: new Map(currentExcludedActualCosts),
      storeClientIds,
    };
  }
  return { costs: next, excludedActualCosts: nextExcludedActualCosts, storeClientIds };
}

export function resolveEstimatedValueTurnCostEntry(
  payload: EstimatedValueTurnCostPayload,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): { clientId: string; money: RegionalMoney } | null {
  if (!payload.clientId) return null;
  const raw =
    normalizeRegionalMoney(payload.turnMoney) ??
    (typeof payload.turnCostUsd === 'number'
      ? payload.turnCostIsEstimate === true
        ? legacyEstimateMoney(payload.turnCostUsd)
        : usdMoney(payload.turnCostUsd)
      : null);
  const turnPresentation = resolveTurnSdkCostPresentation({
    money: raw,
    isCustomProviderCost: payload.turnCostIsCustomProvider,
    fallback: presentation,
    showSdkEstimate,
  });
  if (turnPresentation === 'regular' && payload.turnCostIsEstimate !== true) return null;
  const details = normalizeTurnUsageDetails(payload.turnUsageDetails);
  const normalized = projectSdkCostMoneyWithBreakdown(
    raw,
    details?.perModelCost?.map((entry) => entry.money),
    turnPresentation,
  );
  if (!normalized || normalized.amount <= 0 || normalized.kind !== 'value-estimate') return null;
  return {
    clientId: payload.clientId,
    money: correctStaleUsdEstimate(
      asValueEstimate(
        normalized,
        normalized.estimateReasons?.includes('sdk-estimate')
          ? 'sdk-estimate'
          : 'subscription-value',
      ),
      payload.turnUsageDetails,
    ),
  };
}

function sumCosts(costs: Map<string, RegionalMoney>): RegionalMoney | null {
  const values = [...costs.values()];
  if (values.length === 0) return null;
  const total = addCompatibleRegionalMoney(values);
  if (!total) return null;
  return total.amount > 0 ? total : null;
}

const NOOP_UNSUBSCRIBE = () => {};

export function useSessionEstimatedValue(
  sessionId: string | undefined,
  enabled: boolean,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): SessionEstimatedValueProjection {
  const displaySnapshot = useChatDisplaySnapshot(sessionId);
  const displaySnapshotRef = useRef(displaySnapshot);
  const shouldListenForDirectTurnCost = !displaySnapshot || displaySnapshot.chatRealtime;
  const costsRef = useRef<Map<string, RegionalMoney>>(new Map());
  const excludedActualCostsRef = useRef<Map<string, RegionalMoney>>(new Map());
  const storeClientIdsRef = useRef<Set<string>>(new Set());
  const transcriptClearedRef = useRef(false);
  const [projection, setProjection] = useState<SessionEstimatedValueProjection>({
    estimatedValueMoney: null,
    excludedActualMoney: null,
  });
  const subscribeSnapshot = useCallback(
    (cb: () => void) =>
      !enabled || !sessionId || displaySnapshot
        ? NOOP_UNSUBSCRIBE
        : makerChatStore.subscribe(sessionId, cb),
    [displaySnapshot, enabled, sessionId],
  );
  const getSnapshot = useCallback<() => EstimatedValueStoreSnapshot | null>(() => {
    if (!enabled || !sessionId) return null;
    return displaySnapshot ?? makerChatStore.getSnapshot(sessionId);
  }, [displaySnapshot, enabled, sessionId]);
  const storeSnapshot = useSyncExternalStore(subscribeSnapshot, getSnapshot, getSnapshot);

  useEffect(() => {
    displaySnapshotRef.current = displaySnapshot;
  }, [displaySnapshot]);

  useEffect(() => {
    costsRef.current = new Map();
    excludedActualCostsRef.current = new Map();
    storeClientIdsRef.current = new Set();
    transcriptClearedRef.current = false;
    setProjection({ estimatedValueMoney: null, excludedActualMoney: null });
  }, [enabled, presentation, sessionId, showSdkEstimate]);

  useEffect(() => {
    if (!enabled || !sessionId || !storeSnapshot) return;
    if (isAuthoritativeEmptyTranscript(storeSnapshot)) {
      transcriptClearedRef.current = true;
    }
    const result = syncEstimatedValueCostsFromStoreSnapshot(
      costsRef.current,
      storeClientIdsRef.current,
      storeSnapshot,
      presentation,
      showSdkEstimate,
      excludedActualCostsRef.current,
    );
    if (!result) return;
    storeClientIdsRef.current = result.storeClientIds;
    if (
      areCostMapsEqual(costsRef.current, result.costs) &&
      areCostMapsEqual(excludedActualCostsRef.current, result.excludedActualCosts)
    ) {
      return;
    }
    costsRef.current = result.costs;
    excludedActualCostsRef.current = result.excludedActualCosts;
    setProjection({
      estimatedValueMoney: sumCosts(result.costs),
      excludedActualMoney: sumCosts(result.excludedActualCosts),
    });
  }, [enabled, presentation, sessionId, showSdkEstimate, storeSnapshot]);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let cancelled = false;
    const applyCosts = (
      next: Map<string, RegionalMoney>,
      nextExcludedActualCosts: Map<string, RegionalMoney>,
    ): void => {
      if (
        cancelled ||
        (areCostMapsEqual(costsRef.current, next) &&
          areCostMapsEqual(excludedActualCostsRef.current, nextExcludedActualCosts))
      ) {
        return;
      }
      costsRef.current = next;
      excludedActualCostsRef.current = nextExcludedActualCosts;
      setProjection({
        estimatedValueMoney: sumCosts(next),
        excludedActualMoney: sumCosts(nextExcludedActualCosts),
      });
    };
    const mergeEntry = (entry: {
      clientId: string;
      money?: RegionalMoney | null;
      excludedActualMoney?: RegionalMoney | null;
    } | null): void => {
      if (cancelled || !entry || !entry.clientId) return;
      const snapshot = displaySnapshotRef.current ?? makerChatStore.getSnapshot(sessionId);
      const shouldApplyVisibleEntry = shouldApplyEstimatedValueEntry(
        snapshot,
        entry.clientId,
        transcriptClearedRef.current,
      );
      if (!shouldApplyVisibleEntry && !entry.excludedActualMoney) return;
      const next = new Map(costsRef.current);
      const nextExcludedActualCosts = new Map(excludedActualCostsRef.current);
      if (shouldApplyVisibleEntry) {
        if (entry.money?.amount) next.set(entry.clientId, entry.money);
        else next.delete(entry.clientId);
      }
      if (entry.excludedActualMoney?.amount) {
        nextExcludedActualCosts.set(entry.clientId, entry.excludedActualMoney);
      } else if (shouldApplyVisibleEntry) {
        nextExcludedActualCosts.delete(entry.clientId);
      }
      applyCosts(next, nextExcludedActualCosts);
    };

    if (!shouldListenForDirectTurnCost) {
      return () => {
        cancelled = true;
      };
    }

    const unsubscribeTurnCost = window.electronAPI.onUsageMessageTurnCost?.(
      (payload, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        if (payload.sessionId !== sessionId) return;
        const resolved = resolveEstimatedValueTurnCostEntry(payload, presentation, showSdkEstimate);
        const raw =
          normalizeRegionalMoney(payload.turnMoney) ??
          (typeof payload.turnCostUsd === 'number' ? usdMoney(payload.turnCostUsd) : null);
        const turnPresentation = resolveTurnSdkCostPresentation({
          money: raw,
          isCustomProviderCost: payload.turnCostIsCustomProvider,
          fallback: presentation,
          showSdkEstimate,
        });
        mergeEntry({
          clientId: payload.clientId,
          money: resolved?.money ?? null,
          excludedActualMoney:
            raw?.kind === 'actual-cost' &&
            payload.turnCostIsEstimate !== true &&
            turnPresentation !== 'regular'
              ? raw
              : null,
        });
      },
    );
    // 按会话来源路由:device-link 远程会话查被控端(本地库无该会话的行,查本机恒 0)。
    void estimatedSessionValueFor(sessionId, presentation, showSdkEstimate)
      .then((snapshot) => {
        if (cancelled) return;
        for (const entry of snapshot.entries) {
          const normalized =
            normalizeRegionalMoney(entry.money) ??
            (typeof entry.costUsd === 'number' ? legacyEstimateMoney(entry.costUsd) : null);
          const entryPresentation = resolveTurnSdkCostPresentation({
            money: normalized,
            isCustomProviderCost: entry.turnCostIsCustomProvider,
            fallback: presentation,
            showSdkEstimate,
          });
          const details = normalizeTurnUsageDetails(entry.turnUsageDetails);
          const projected = projectSdkCostMoneyWithBreakdown(
            normalized,
            details?.perModelCost?.map((item) => item.money),
            entryPresentation,
          );
          mergeEntry({
            clientId: entry.clientId,
            money: projected?.kind === 'value-estimate'
              ? correctStaleUsdEstimate(
                  asValueEstimate(
                    projected,
                    projected.estimateReasons?.includes('sdk-estimate')
                      ? 'sdk-estimate'
                      : 'subscription-value',
                  ),
                  entry.turnUsageDetails,
                )
              : null,
            excludedActualMoney: entry.excludedActualMoney ?? null,
          });
        }
      })
      .catch(() => {
        // 历史汇总失败不影响实时增量；本 hook 只是展示辅助信息。
      });

    return () => {
      cancelled = true;
      unsubscribeTurnCost?.();
    };
  }, [enabled, presentation, sessionId, shouldListenForDirectTurnCost, showSdkEstimate]);

  return projection;
}

/** Backward-compatible money-only view for callers that do not own a persisted actual ledger. */
export function useSessionEstimatedValueMoney(
  sessionId: string | undefined,
  enabled: boolean,
  presentation: SdkCostPresentation = 'regular',
  showSdkEstimate: boolean = presentation === 'estimate',
): RegionalMoney | null {
  return useSessionEstimatedValue(sessionId, enabled, presentation, showSdkEstimate)
    .estimatedValueMoney;
}
