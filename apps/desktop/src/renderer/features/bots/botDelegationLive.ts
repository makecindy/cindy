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
  /**
   * 首次拉取是否已经**落地**（成功或失败都算）。
   *
   * 「还没读到」和「读完了但没有这一行」是两回事：前者该继续显示进行中的样子，
   * 后者说明这条委派我们根本核实不了（列表拉取失败、或落在 100 行上限之外）。
   * 不区分的话，第二种情况会被当成第一种，卡片就永远停在带呼吸点的「正在开始」。
   */
  resolved: boolean;
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
    resolved: false,
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
    entry.resolved = true;
    emit(entry);
  } catch {
    if (!isDataOwnerGenerationCurrent(owner)) return;
    if (sessions.get(sessionId) !== entry) return;
    entry.rows = [];
    entry.resolved = true;
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

export interface BotDelegationLive {
  /** 这一条委派的实时行；还没读到、或读完了但不存在时为 null。 */
  row: BotDelegationView | null;
  /**
   * 本会话的委派列表是否已经拉过一次（成功或失败都算）。
   *
   * `resolved && row === null` 是一个**确定的**结论：这条委派我们核实不了。
   * 调用方必须据此改口，不能继续画「正在进行」。
   */
  resolved: boolean;
}

/** 取本会话发起的某一个委派的实时行，附带「首次拉取是否已落地」。 */
export function useBotDelegation(
  sessionId: string | null,
  delegationId: string,
): BotDelegationLive {
  const [live, setLive] = useState<BotDelegationLive>({ row: null, resolved: false });
  const read = useCallback((): BotDelegationLive => {
    if (!sessionId) return { row: null, resolved: false };
    const entry = sessions.get(sessionId);
    return {
      row: entry?.rows.find((item) => item.id === delegationId) ?? null,
      resolved: entry?.resolved ?? false,
    };
  }, [delegationId, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setLive({ row: null, resolved: false });
      return;
    }
    setLive(read());
    return subscribe(sessionId, () => setLive(read()));
  }, [read, sessionId]);

  return live;
}

/** 测试用：清掉进程内缓存，避免用例之间互相看到对方的订阅。 */
export function __resetBotDelegationLiveForTest(): void {
  for (const entry of sessions.values()) entry.unsubscribe?.();
  sessions.clear();
}
