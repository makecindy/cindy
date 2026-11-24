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
import { hasSubscriptionEstimateSource, legacyEstimateMoney, turnEstimateAmounts } from '../../shared/turnEstimateAmounts';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  sumMoneyByCurrency,
  type RegionalMoney,
} from '../../shared/regionalMoney';

interface EstimatedValueStoreSnapshot {
  messages: ChatMessage[];
  historyLoaded: boolean;
  hasMoreMessages: boolean;
}

interface EstimatedValueStoreSyncResult {
  costs: Map<string, RegionalMoney[]>;
  /** Loaded window clientIds, oldest first; the next sync uses the order. */
  storeClientIds: string[];
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
  turnUsageDetails?: unknown;
}

type EstimateEntry = { clientId: string; money: RegionalMoney; additionalEstimates?: RegionalMoney[] };

function estimateFromChatMessage(message: ChatMessage): EstimateEntry | null {
  return message.role === 'assistant' ? resolveEstimatedValueTurnCostEntry(message) : null;
}

function areMoneyEqual(a: RegionalMoney, b: RegionalMoney): boolean {
  if (
    a.amount !== b.amount ||
    a.currency !== b.currency ||
    a.approximate !== b.approximate ||
    a.kind !== b.kind ||
    a.subscriptionSourceConfirmed !== b.subscriptionSourceConfirmed
  ) {
    return false;
  }
  const aReasons = a.estimateReasons ?? [];
  const bReasons = b.estimateReasons ?? [];
  return aReasons.length === bReasons.length &&
    aReasons.every((reason, index) => reason === bReasons[index]);
}

function areCostMapsEqual(
  a: ReadonlyMap<string, RegionalMoney[]>,
  b: ReadonlyMap<string, RegionalMoney[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || value.length !== other.length || !value.every((money, index) => areMoneyEqual(money, other[index]))) return false;
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

/**
 * The loaded chat window is only the newest slice of a task: it is trimmed,
 * reseeded with the latest page and replaced on reconnect. Rows that leave the
 * top of the window (older than the oldest row still loaded) remain persisted,
 * so their DB-backed value stays in the total. Explicit removals apply even
 * when the row is outside the loaded range or the display snapshot is stale.
 */
export function syncEstimatedValueCostsFromStoreSnapshot(
  currentCosts: ReadonlyMap<string, RegionalMoney[]>,
  previousStoreClientIds: readonly string[],
  snapshot: EstimatedValueStoreSnapshot,
  removedClientIds?: ReadonlySet<string>,
): EstimatedValueStoreSyncResult | null {
  if (snapshot.messages.length === 0 && !snapshot.historyLoaded) return null;

  const next = new Map(currentCosts);
  if (isAuthoritativeEmptyTranscript(snapshot)) {
    return { costs: new Map(), storeClientIds: [] };
  }

  const loaded = new Set<string>();
  for (const message of snapshot.messages) {
    if (message.clientId) loaded.add(message.clientId);
  }
  const storeClientIds = [...loaded];
  const oldestRetained = previousStoreClientIds.findIndex((clientId) => loaded.has(clientId));
  if (oldestRetained >= 0) {
    for (const [index, clientId] of previousStoreClientIds.entries()) {
      if (index > oldestRetained && !loaded.has(clientId)) next.delete(clientId);
    }
  }
  for (const clientId of removedClientIds ?? []) next.delete(clientId);
  for (const message of snapshot.messages) {
    if (!message.clientId || removedClientIds?.has(message.clientId)) continue;
    const entry = estimateFromChatMessage(message);
    if (entry) {
      next.set(entry.clientId, [entry.money, ...(entry.additionalEstimates ?? [])]);
    } else {
      next.delete(message.clientId);
    }
  }
  if (areCostMapsEqual(currentCosts, next)) {
    return { costs: new Map(currentCosts), storeClientIds };
  }
  return { costs: next, storeClientIds };
}

export function resolveEstimatedValueTurnCostEntry(
  payload: EstimatedValueTurnCostPayload,
): EstimateEntry | null {
  if (!payload.clientId) return null;
  const [money, ...additionalEstimates] = turnEstimateAmounts({ ...payload, turnCost: payload.turnMoney });
  return money ? { clientId: payload.clientId, money, ...(additionalEstimates.length > 0 && { additionalEstimates }) } : null;
}

function sumCosts(costs: Map<string, RegionalMoney[]>): RegionalMoney[] {
  const estimates = [...costs.values()].flat().filter(money => money.amount > 0);
  const otherEstimateCurrencies = new Set(estimates
    .filter(money => !hasSubscriptionEstimateSource(money))
    .map(money => money.currency));
  return sumMoneyByCurrency(estimates).map(total => {
    if (otherEstimateCurrencies.has(total.currency)) {
      return { ...total, estimateReasons: total.estimateReasons?.filter(reason => reason !== 'subscription-value') };
    }
    return total.estimateReasons?.includes('legacy-usd')
      ? { ...total, subscriptionSourceConfirmed: true }
      : total;
  });
}

const NOOP_UNSUBSCRIBE = () => {};

export function useSessionEstimatedAmounts(
  sessionId: string | undefined,
  enabled: boolean,
): RegionalMoney[] {
  const displaySnapshot = useChatDisplaySnapshot(sessionId);
  const displaySnapshotRef = useRef(displaySnapshot);
  const shouldListenForDirectTurnCost = !displaySnapshot || displaySnapshot.chatRealtime;
  const costsRef = useRef<Map<string, RegionalMoney[]>>(new Map());
  const storeClientIdsRef = useRef<string[]>([]);
  const transcriptClearedRef = useRef(false);
  const removedClientIdsRef = useRef(new Set<string>());
  const [valueMoney, setValueMoney] = useState<RegionalMoney[]>([]);
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
    storeClientIdsRef.current = [];
    transcriptClearedRef.current = false;
    removedClientIdsRef.current.clear();
    setValueMoney([]);
  }, [enabled, sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    return makerChatStore.subscribeToMessageRemovals(sessionId, (clientIds) => {
      let changed = false;
      for (const clientId of clientIds) {
        // A history read or turn-cost push already in flight can still contain this row.
        removedClientIdsRef.current.add(clientId);
        if (displaySnapshotRef.current?.chatRealtime === false) continue;
        if (costsRef.current.delete(clientId)) changed = true;
      }
      if (changed) setValueMoney(sumCosts(costsRef.current));
    });
  }, [enabled, sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId || !storeSnapshot) return;
    if (isAuthoritativeEmptyTranscript(storeSnapshot)) {
      transcriptClearedRef.current = true;
    }
    const result = syncEstimatedValueCostsFromStoreSnapshot(
      costsRef.current,
      storeClientIdsRef.current,
      storeSnapshot,
      removedClientIdsRef.current,
    );
    if (!result) return;
    storeClientIdsRef.current = result.storeClientIds;
    if (areCostMapsEqual(costsRef.current, result.costs)) return;
    costsRef.current = result.costs;
    setValueMoney(sumCosts(result.costs));
  }, [enabled, sessionId, storeSnapshot]);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let cancelled = false;
    const applyCosts = (next: Map<string, RegionalMoney[]>): void => {
      if (cancelled || areCostMapsEqual(costsRef.current, next)) return;
      costsRef.current = next;
      setValueMoney(sumCosts(next));
    };
    const canMerge = (clientId: string): boolean => {
      if (cancelled || !clientId || removedClientIdsRef.current.has(clientId)) return false;
      const snapshot = displaySnapshotRef.current ?? makerChatStore.getSnapshot(sessionId);
      return shouldApplyEstimatedValueEntry(snapshot, clientId, transcriptClearedRef.current);
    };
    let updatedDuringRead: Set<string> | null = new Set();

    if (!shouldListenForDirectTurnCost) {
      return () => {
        cancelled = true;
      };
    }

    const unsubscribeTurnCost = window.electronAPI.onUsageMessageTurnCost?.(
      (payload, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        if (payload.sessionId !== sessionId) return;
        if (!canMerge(payload.clientId)) return;
        const entry = resolveEstimatedValueTurnCostEntry(payload);
        if (!entry && payload.turnCostIsEstimate === undefined && !payload.turnMoney) return;
        updatedDuringRead?.add(payload.clientId);
        const next = new Map(costsRef.current);
        if (entry) next.set(entry.clientId, [entry.money, ...(entry.additionalEstimates ?? [])]);
        else next.delete(payload.clientId);
        applyCosts(next);
      },
    );
    // 按会话来源路由:device-link 远程会话查被控端(本地库无该会话的行,查本机恒 0)。
    void estimatedSessionValueFor(sessionId)
      .then((snapshot) => {
        if (cancelled) return;
        const next = new Map(costsRef.current);
        for (const entry of snapshot.entries) {
          if (updatedDuringRead?.has(entry.clientId) || !canMerge(entry.clientId)) continue;
          const normalized =
            normalizeRegionalMoney(entry.money) ??
            (typeof entry.costUsd === 'number'
              ? legacyEstimateMoney(entry.costUsd)
              : null);
          if (!normalized) continue;
          const amounts = entry.additionalEstimates?.length
            ? [normalized, ...entry.additionalEstimates.map(normalizeRegionalMoney)
                .filter((value): value is RegionalMoney => value?.kind === 'value-estimate' && value.amount > 0)]
            : turnEstimateAmounts({ turnCost: normalized, turnCostIsEstimate: true, turnUsageDetails: entry.turnUsageDetails });
          if (amounts.length) next.set(entry.clientId, amounts);
        }
        applyCosts(next);
      })
      .catch(() => {
        // 历史汇总失败不影响实时增量；本 hook 只是展示辅助信息。
      })
      .finally(() => { updatedDuringRead = null; });

    return () => {
      cancelled = true;
      unsubscribeTurnCost?.();
    };
  }, [enabled, sessionId, shouldListenForDirectTurnCost]);

  return valueMoney;
}

export function useSessionEstimatedValue(sessionId: string | undefined, enabled: boolean): RegionalMoney | null {
  return addCompatibleRegionalMoney(useSessionEstimatedAmounts(sessionId, enabled));
}
