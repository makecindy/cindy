/**
 * useSessionEstimatedValue — 订阅当前 Codex 订阅会话的"本会话价值"。
 *
 * 订阅价值不能写入 sessions.total_cost_usd（那是 scheduler / API 账单的真实 cost）。
 * 这里从 assistant message 的 agentMeta.turnCostUsd 估算值汇总，历史初值走 main
 * 侧 SQLite 汇总，实时增量走 usage:message-turn-cost。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { estimatedSessionValueFor } from '@/lib/makerTransport';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../shared/codexSubscriptionValue';
import { normalizeTurnUsageDetails } from '../../shared/turnUsageDetails';

interface EstimatedValueStoreSnapshot {
  messages: ChatMessage[];
  historyLoaded: boolean;
  hasMoreMessages: boolean;
}

interface EstimatedValueStoreSyncResult {
  costs: Map<string, number>;
  storeClientIds: Set<string>;
}

interface EstimatedValueTurnCostPayload {
  clientId: string;
  turnCostUsd: number;
  turnCostIsEstimate: boolean;
  turnUsageDetails?: unknown;
}

function estimateFromChatMessage(message: ChatMessage): { clientId: string; costUsd: number } | null {
  if (message.role !== 'assistant') return null;
  if (message.turnCostIsEstimate !== true) return null;
  if (typeof message.turnCostUsd !== 'number' || !Number.isFinite(message.turnCostUsd) || message.turnCostUsd <= 0) {
    return null;
  }
  return { clientId: message.clientId, costUsd: message.turnCostUsd };
}

function areCostMapsEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
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
  currentCosts: ReadonlyMap<string, number>,
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
      next.set(entry.clientId, entry.costUsd);
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
): { clientId: string; costUsd: number } | null {
  if (payload.turnCostIsEstimate !== true) return null;
  if (!payload.clientId) return null;
  if (!Number.isFinite(payload.turnCostUsd) || payload.turnCostUsd <= 0) return null;
  const corrected = resolveStaleCodexSubscriptionValueEstimate(
    payload.turnCostUsd,
    normalizeTurnUsageDetails(payload.turnUsageDetails),
  );
  return {
    clientId: payload.clientId,
    costUsd: corrected ?? payload.turnCostUsd,
  };
}

function sumCosts(costs: Map<string, number>): number | null {
  let total = 0;
  for (const cost of costs.values()) total += cost;
  return total > 0 ? total : null;
}

const NOOP_UNSUBSCRIBE = () => {};

export function useSessionEstimatedValue(
  sessionId: string | undefined,
  enabled: boolean,
): number | null {
  const displaySnapshot = useChatDisplaySnapshot(sessionId);
  const displaySnapshotRef = useRef(displaySnapshot);
  const shouldListenForDirectTurnCost = !displaySnapshot || displaySnapshot.chatRealtime;
  const costsRef = useRef<Map<string, number>>(new Map());
  const storeClientIdsRef = useRef<Set<string>>(new Set());
  const transcriptClearedRef = useRef(false);
  const [valueUsd, setValueUsd] = useState<number | null>(null);
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
    setValueUsd(null);
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
    setValueUsd(sumCosts(result.costs));
  }, [enabled, sessionId, storeSnapshot]);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let cancelled = false;
    const applyCosts = (next: Map<string, number>): void => {
      if (cancelled || areCostMapsEqual(costsRef.current, next)) return;
      costsRef.current = next;
      setValueUsd(sumCosts(next));
    };
    const mergeEntry = (entry: { clientId: string; costUsd: number } | null): void => {
      if (cancelled || !entry || !entry.clientId || !Number.isFinite(entry.costUsd) || entry.costUsd <= 0) return;
      const snapshot = displaySnapshotRef.current ?? makerChatStore.getSnapshot(sessionId);
      if (!shouldApplyEstimatedValueEntry(
        snapshot,
        entry.clientId,
        transcriptClearedRef.current,
      )) return;
      const prev = costsRef.current.get(entry.clientId);
      if (prev === entry.costUsd) return;
      const next = new Map(costsRef.current);
      next.set(entry.clientId, entry.costUsd);
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
        for (const entry of snapshot.entries) mergeEntry(entry);
      })
      .catch(() => {
        // 历史汇总失败不影响实时增量；本 hook 只是展示辅助信息。
      });

    return () => {
      cancelled = true;
      unsubscribeTurnCost?.();
    };
  }, [enabled, sessionId, shouldListenForDirectTurnCost]);

  return valueUsd;
}
