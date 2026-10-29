/**
 * useClaudeAccountUsage — 订阅 Claude 账号配额 (LiteLLM spend / max_budget + 今日 daily) 实时推送。
 *
 * 数据语义: snapshot.spend = 月度跨客户端累计 (LiteLLM /v2/user/info); snapshot.todaySpend =
 * 今日 (UTC 日, 本 user 跨所有客户端 / 所有 key) 累计 (LiteLLM /user/daily/activity)。
 * null 表示对应端点暂时拉不到。详见 main/usage/claudeAccountUsage.ts 顶部注释。
 *
 * 数据通道:
 *   main/usage/claudeAccountUsage.ts triggerClaudeAccountUsageRefresh()
 *     → 走 ANTHROPIC_BASE_URL+/v2/user/info, 2s 超时, 10s 节流
 *     → broadcast usage:claude-account-changed
 *   IPC 出口: electronAPI.maker.usage.{getAccount('claude-code'), onClaudeAccountChanged}
 *
 * 触发时机:
 *   - mount / 手动刷新时调 getAccount('claude-code')，main 按既有节流查询后返回快照
 *   - 后续每个 cc turn done 后, main fire-and-forget 拉取并 push, 本 hook 收 push 直接覆盖
 *
 * 与 useAccountUsage(codex) 的差异:
 *   - 没有 sessionId 过滤 — 是账号级数据, 全局共享一份 module-local cache
 *   - enabled=false 直接返 null (不订阅, 节省一次回调过滤)
 *
 * enabled 语义 (而非 vendorKey): 这份 quota 是"XD gateway key 在 LiteLLM 上的 spend",
 * 与发起请求的 agent 无关。cc 固然要看; codex 的 'api' 鉴权模式复用同一把 XD key 走
 * 同一个 AI Gateway, 所以也该看同一份 quota。调用方只在当前会话实际走 Gateway 时
 * 启用；自定义供应商即使复用相同 host 也不会读这份账号配额。
 */

import { CLAUDE_QUOTA_STATE_READ, isClaudeQuotaClear } from '../../shared/claudeQuotaState';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MoneyCurrency } from '../../shared/regionalMoney';
import { useAuth } from '../contexts/AuthContext';

export interface ClaudeAccountUsageSnapshot {
  /** 月度周期跨客户端累计，保持 Gateway 部署区域的原生金额。 */
  spend: number;
  /** 月度周期上限，保持 Gateway 部署区域的原生金额。 */
  maxBudget: number;
  /** Gateway 账号金额的原生币种。 */
  currency: MoneyCurrency;
  /** 下次月度 reset 时间 ISO8601。 */
  budgetResetAt?: string | null;
  /**
   * 今日 (UTC 日) 跨客户端累计，保持 Gateway 部署区域的原生金额，来自
   * LiteLLM /user/daily/activity 的
   * results[0].metrics.spend。null 表示该端点暂时不可用 (跟 cycle 是独立 fetch),
   * 此时消费方应隐藏 daily 段。
   */
  todaySpend: number | null;
  /** 企业日额度开关；false 隐藏日额度和读取失败提示，旧网关路径不设置。 */
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
