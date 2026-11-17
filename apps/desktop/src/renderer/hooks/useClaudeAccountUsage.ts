/**
 * 订阅 Cindy AI 企业账号额度；接口沿用 Claude 历史命名。
 *
 * main/usage/claudeAccountUsage.ts 通过 Model Access GET /api/model-access/quota
 * 读取周期及服务端统计口径的当天跨客户端用量（8 秒超时、10 秒节流），沿
 * usage:claude-account-changed 推送。失败保留同账号缓存，权威 clear 才清除。
 *
 * mount / 手动刷新通过 getAccount('claude-code') 读取；任务收尾及空闲刷新由
 * main 触发。账号级缓存与 agent 无关，Claude Code / Codex 走 Cindy AI 时共用，
 * 自定义供应商不读取这份配额。enabled=false 返回 null 且不订阅。
 */

import { CLAUDE_QUOTA_STATE_READ, isClaudeQuotaClear } from '../../shared/claudeQuotaState';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MoneyCurrency } from '../../shared/regionalMoney';
import { useAuth } from '../contexts/AuthContext';

export interface ClaudeAccountUsageSnapshot {
  /** 月度周期跨客户端累计，保持服务端账号金额口径。 */
  spend: number;
  /** 月度周期上限，保持服务端账号金额口径。 */
  maxBudget: number;
  /** 服务端账号金额的原生币种。 */
  currency: MoneyCurrency;
  /** 下次月度 reset 时间 ISO8601。 */
  budgetResetAt?: string | null;
  /** 服务端统计口径的当天跨客户端累计；日额度未启用或明细不可用时为 null。 */
  todaySpend: number | null;
  /** 企业日额度开关；false 隐藏日额度和读取失败提示，旧主机可能不设置。 */
  dailyLimitEnabled?: boolean;
  fetchedAt: number;
}

interface OwnerBoundSnapshot {
  ownerKey: string;
  cachedAt: number;
  usage: ClaudeAccountUsageSnapshot | null;
  unlimited: boolean;
}

let lastSnapshot: OwnerBoundSnapshot | null = null;

// All panes for one account share a read. A null push emitted by that read must
// not make an idle pane start another forced read and wake the other panes again.
const reads = new Map<string, Promise<unknown>>();
function readQuota(ownerKey: string): Promise<unknown> {
  const pending = reads.get(ownerKey);
  if (pending) return pending;
  const request = Promise.resolve().then(() =>
    window.electronAPI.maker.usage.getAccount('claude-code', CLAUDE_QUOTA_STATE_READ),
  );
  reads.set(ownerKey, request);
  const clear = () => { if (reads.get(ownerKey) === request) reads.delete(ownerKey); };
  void request.then(clear, clear);
  return request;
}


function isSnapshot(v: unknown): v is ClaudeAccountUsageSnapshot {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<ClaudeAccountUsageSnapshot>;
  return (
    typeof r.spend === 'number' &&
    typeof r.maxBudget === 'number' &&
    r.maxBudget > 0 &&
    (r.currency === 'CNY' || r.currency === 'USD') &&
    (typeof r.todaySpend === 'number' || r.todaySpend === null)
  );
}

export function useClaudeAccountUsageResult(enabled: boolean) {
  const { dataOwnerId, dataOwnerGeneration, mode, user } = useAuth();
  const ownerKey =
    enabled &&
    dataOwnerId &&
    (mode === 'local' || (mode === 'cloud' && user?.membershipKind === 'org'))
      ? `${mode}:${dataOwnerId}:${dataOwnerGeneration}`
      : null;
  const [snapshot, setSnapshot] = useState<OwnerBoundSnapshot | null>(() =>
    ownerKey && lastSnapshot?.ownerKey === ownerKey ? lastSnapshot : null,
  );

  const reading = useRef(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [request, setRequest] = useState<{ ownerKey: string; loading: boolean } | null>(null);

  // 初次打开和手动刷新共用 main 的账号隔离、请求合并与节流。
  useEffect(() => {
    if (!ownerKey) return;
    const cached = lastSnapshot?.ownerKey === ownerKey ? lastSnapshot : null;
    if (cached) setSnapshot(cached);
    // Display warm data immediately, but read again to replay a missed authoritative clear.
    let cancelled = false;
    setRequest({ ownerKey, loading: true });
    reading.current = true;
    void readQuota(ownerKey)
      .then((res) => {
        if (cancelled) return;
        if (isClaudeQuotaClear(res)) {
          lastSnapshot = {
            ownerKey,
            cachedAt: Date.now(),
            usage: null,
            unlimited: res.quotaState === 'unlimited',
          };
          setSnapshot(lastSnapshot);
          return;
        }
        // Unavailable reads must retain the last owner-bound snapshot.
        if (!isSnapshot(res)) return;
        lastSnapshot = { ownerKey, cachedAt: Date.now(), usage: res, unlimited: false };
        setSnapshot(lastSnapshot);
      })
      .catch(() => {
        /* best-effort warm-start */
      })
      .finally(() => {
        if (!cancelled) {
          reading.current = false;
          setRequest({ ownerKey, loading: false });
        }
      });
    return () => {
      cancelled = true;
      reading.current = false;
    };
  }, [ownerKey, revision]);

  // 订阅 push (cc / codex-api turn done 后 main 推 — 都是同一把 XD key 的 spend)
  useEffect(() => {
    if (!ownerKey) return;
    return window.electronAPI.maker.usage.onClaudeAccountChanged((p) => {
      if (p === null) {
        if (lastSnapshot?.ownerKey === ownerKey) lastSnapshot = null;
        setSnapshot(null);
        // The legacy push cannot distinguish unlimited from invalidation. Read the explicit state.
        if (!reading.current) refresh();
        return;
      }
      if (!isSnapshot(p)) return;
      lastSnapshot = { ownerKey, cachedAt: Date.now(), usage: p, unlimited: false };
      setSnapshot(lastSnapshot);
    });
  }, [ownerKey, refresh]);

  const currentSnapshot = lastSnapshot?.ownerKey === ownerKey ? lastSnapshot : snapshot;
  return {
    unlimited: Boolean(ownerKey && currentSnapshot?.ownerKey === ownerKey && currentSnapshot.unlimited),
    usage: ownerKey && currentSnapshot?.ownerKey === ownerKey ? currentSnapshot.usage : null,
    loading: Boolean(ownerKey && (request?.ownerKey !== ownerKey || request.loading)),
    refresh,
  };
}

export function useClaudeAccountUsage(enabled: boolean): ClaudeAccountUsageSnapshot | null {
  return useClaudeAccountUsageResult(enabled).usage;
}
