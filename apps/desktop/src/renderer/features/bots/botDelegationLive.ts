import { useCallback, useEffect, useState } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { BotDelegationStatus, BotDelegationView } from '../../../shared/botDelegation';

/** 未落终态的委派：协作卡按这个集合决定「还在干活」还是「收拢成战报」。 */
const ACTIVE_STATUSES = new Set<BotDelegationStatus>(['queued', 'waiting', 'running']);

export function isActiveDelegationStatus(status: BotDelegationStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

interface SessionEntry {
  rows: BotDelegationView[];
  listeners: Set<() => void>;
  unsubscribe: (() => void) | null;
  loading: Promise<void> | null;
}

/**
 * 每个会话一份委派快照，会话内所有协作卡共用。
 *
 * 存在的理由：一次连环编排里父任务可能挂三四张协作卡，每张都自己 `listBotDelegations`
 * + 订阅推送的话，一条状态变更会引发 N 次全量拉取。这里把「一个会话一次订阅、一次
 * 拉取、广播给所有卡」收在一处；组件侧只按 delegationId 取自己那行。
 *
 * 数据主人切换（登出 / 切账号）沿用既有 dataOwnerGeneration 守卫丢弃旧结果。
 */
const sessions = new Map<string, SessionEntry>();

function ensureEntry(sessionId: string): SessionEntry {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const entry: SessionEntry = {
    rows: [],
    listeners: new Set(),
    unsubscribe: null,
    loading: null,
  };
  sessions.set(sessionId, entry);
  return entry;
}

function emit(entry: SessionEntry): void {
  for (const listener of [...entry.listeners]) listener();
}

async function reload(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const owner = getDataOwnerGeneration();
  try {
    const result = await window.electronAPI.maker.listBotDelegations(sessionId);
    if (!isDataOwnerGenerationCurrent(owner)) return;
    if (sessions.get(sessionId) !== entry) return;
    // 读不到就保持空：宁可少一张卡，也不要把无法核实的状态挂在对话里。
    entry.rows = result.ok ? result.delegations : [];
    emit(entry);
  } catch {
    if (!isDataOwnerGenerationCurrent(owner)) return;
    if (sessions.get(sessionId) !== entry) return;
    entry.rows = [];
    emit(entry);
  }
}

function subscribe(sessionId: string, listener: () => void): () => void {
  const entry = ensureEntry(sessionId);
  entry.listeners.add(listener);
  if (!entry.unsubscribe) {
    entry.unsubscribe = window.electronAPI.maker.onBotDelegationChanged((payload, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp) || payload.parentSessionId !== sessionId) return;
      void reload(sessionId);
    });
    void reload(sessionId);
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    entry.unsubscribe?.();
    sessions.delete(sessionId);
  };
}

/** 取本会话发起的某一个委派的实时行；还没读到或已不存在时返回 null。 */
export function useBotDelegation(
  sessionId: string | null,
  delegationId: string,
): BotDelegationView | null {
  const [row, setRow] = useState<BotDelegationView | null>(null);
  const read = useCallback(() => {
    if (!sessionId) return null;
    return sessions.get(sessionId)?.rows.find((item) => item.id === delegationId) ?? null;
  }, [delegationId, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setRow(null);
      return;
    }
    setRow(read());
    return subscribe(sessionId, () => setRow(read()));
  }, [read, sessionId]);

  return row;
}

/** 测试用：清掉进程内缓存，避免用例之间互相看到对方的订阅。 */
export function __resetBotDelegationLiveForTest(): void {
  for (const entry of sessions.values()) entry.unsubscribe?.();
  sessions.clear();
}
