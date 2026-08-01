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
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { estimatedSessionValueFor } from '@/lib/makerTransport';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../shared/codexSubscriptionValue';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  usdMoney,
  USD_TO_CNY_FIXED_RATE,
  type MoneyEstimateReason,
  type RegionalMoney,
} from '../../shared/regionalMoney';
import { normalizeTurnUsageDetails } from '../../shared/turnUsageDetails';

interface EstimatedValueStoreSnapshot {
  messages: ChatMessage[];
  historyLoaded: boolean;
  hasMoreMessages: boolean;
}

interface EstimatedValueStoreSyncResult {
  costs: Map<string, RegionalMoney>;
  storeClientIds: Set<string>;
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
  const isLegacyCnyProjection =
    money.currency === 'CNY' &&
    reasons.includes('legacy-usd') &&
    reasons.includes('fixed-fx');
  if (money.currency !== 'USD' && !isLegacyCnyProjection) return money;
  const amountUsd = isLegacyCnyProjection
    ? money.amount / USD_TO_CNY_FIXED_RATE
    : money.amount;
  const corrected = resolveStaleCodexSubscriptionValueEstimate(
    amountUsd,
    normalizeTurnUsageDetails(turnUsageDetails),
    model,
  );
  if (corrected == null) return money;
  return {
    ...money,
    amount: isLegacyCnyProjection
      ? corrected * USD_TO_CNY_FIXED_RATE
      : corrected,
  };
}

function legacyEstimateMoney(costUsd: number): RegionalMoney | null {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return usdMoney(costUsd, 'value-estimate', 'legacy-usd');
}

function estimateFromChatMessage(message: ChatMessage): { clientId: string; money: RegionalMoney } | null {
  if (message.role !== 'assistant') return null;
  if (message.turnCostIsEstimate !== true) return null;
  const normalized =
    normalizeRegionalMoney(message.turnMoney) ??
    (typeof message.turnCostUsd === 'number'
      ? legacyEstimateMoney(message.turnCostUsd)
      : null);
  if (!normalized || normalized.amount <= 0) return null;
  return {
    clientId: message.clientId,
    money: correctStaleUsdEstimate(
      asValueEstimate(normalized),
      message.turnUsageDetails,
      message.model,
    ),
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
  return aReasons.length === bReasons.length &&
    aReasons.every((reason, index) => reason === bReasons[index]);
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
): EstimatedValueStoreSyncResult | null {
  if (snapshot.messages.length === 0 && !snapshot.historyLoaded) return null;

  const storeClientIds = new Set<string>();
  const next = new Map(currentCosts);
  if (isAuthoritativeEmptyTranscript(snapshot)) {
    return { costs: new Map(), storeClientIds };
  }

  for (const message of snapshot.messages) {
    if (message.clientId) storeClientIds.add(message.clientId);
  }
  for (const clientId of previousStoreClientIds) {
    if (!storeClientIds.has(clientId)) next.delete(clientId);
  }
  for (const message of snapshot.messages) {
    if (!message.clientId) continue;
    const entry = estimateFromChatMessage(message);
    if (entry) {
      next.set(entry.clientId, entry.money);
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
): { clientId: string; money: RegionalMoney } | null {
  if (payload.turnCostIsEstimate !== true) return null;
  if (!payload.clientId) return null;
  const normalized =
    normalizeRegionalMoney(payload.turnMoney) ??
    (typeof payload.turnCostUsd === 'number'
      ? legacyEstimateMoney(payload.turnCostUsd)
      : null);
  if (!normalized || normalized.amount <= 0) return null;
  return {
    clientId: payload.clientId,
    money: correctStaleUsdEstimate(
      asValueEstimate(normalized),
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
): RegionalMoney | null {
  const displaySnapshot = useChatDisplaySnapshot(sessionId);
  const displaySnapshotRef = useRef(displaySnapshot);
  const shouldListenForDirectTurnCost = !displaySnapshot || displaySnapshot.chatRealtime;
  const costsRef = useRef<Map<string, RegionalMoney>>(new Map());
  const storeClientIdsRef = useRef<Set<string>>(new Set());
  const transcriptClearedRef = useRef(false);
  const [valueMoney, setValueMoney] = useState<RegionalMoney | null>(null);
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
    storeClientIdsRef.current = new Set();
    transcriptClearedRef.current = false;
    setValueMoney(null);
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
    const applyCosts = (next: Map<string, RegionalMoney>): void => {
      if (cancelled || areCostMapsEqual(costsRef.current, next)) return;
      costsRef.current = next;
      setValueMoney(sumCosts(next));
    };
    const mergeEntry = (entry: { clientId: string; money: RegionalMoney } | null): void => {
      if (cancelled || !entry || !entry.clientId || entry.money.amount <= 0) return;
      const snapshot = displaySnapshotRef.current ?? makerChatStore.getSnapshot(sessionId);
      if (!shouldApplyEstimatedValueEntry(
        snapshot,
        entry.clientId,
        transcriptClearedRef.current,
      )) return;
      const prev = costsRef.current.get(entry.clientId);
      if (prev && areMoneyEqual(prev, entry.money)) return;
      const next = new Map(costsRef.current);
      next.set(entry.clientId, entry.money);
      applyCosts(next);
    };

    if (!shouldListenForDirectTurnCost) {
      return () => {
        cancelled = true;
      };
    }

    const unsubscribeTurnCost = window.electronAPI.onUsageMessageTurnCost?.((payload) => {
      if (payload.sessionId !== sessionId) return;
      mergeEntry(resolveEstimatedValueTurnCostEntry(payload));
    });
    // 按会话来源路由:device-link 远程会话查被控端(本地库无该会话的行,查本机恒 0)。
    void estimatedSessionValueFor(sessionId)
      .then((snapshot) => {
        if (cancelled) return;
        for (const entry of snapshot.entries) {
          const normalized =
            normalizeRegionalMoney(entry.money) ??
            (typeof entry.costUsd === 'number'
              ? legacyEstimateMoney(entry.costUsd)
              : null);
          if (!normalized) continue;
          mergeEntry({
            clientId: entry.clientId,
            money: correctStaleUsdEstimate(
              asValueEstimate(normalized),
              entry.turnUsageDetails,
            ),
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
  }, [enabled, sessionId, shouldListenForDirectTurnCost]);

  return valueMoney;
}
