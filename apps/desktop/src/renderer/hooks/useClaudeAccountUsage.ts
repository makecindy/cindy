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
 *   - mount 时调一次 getAccount('claude-code'), main 端若无 snapshot 会 force 刷新一次
 *   - 后续每个 cc turn done 后, main fire-and-forget 拉取并 push, 本 hook 收 push 直接覆盖
 *
 * 与 useAccountUsage(codex) 的差异:
 *   - 没有 sessionId 过滤 — 是账号级数据, 全局共享一份 module-local cache
 *   - enabled=false 直接返 null (不订阅, 节省一次回调过滤)
 *
 * enabled 语义 (而非 vendorKey): 这份 quota 是"XD gateway key 在 LiteLLM 上的 spend",
 * 与发起请求的 agent 无关。cc 固然要看; codex 的 'api' 鉴权模式复用同一把 XD key 走
 * 同一个 AI Gateway, 所以也该看同一份 quota。调用方据此决定 enabled (cc || codex-api),
 * 本 hook 不感知 vendor。
 */

import { useEffect, useState } from 'react';

export interface ClaudeAccountUsageSnapshot {
  /** 月度周期跨客户端累计，保持 Gateway 部署区域的原生金额。 */
  spend: number;
  /** 月度周期上限，保持 Gateway 部署区域的原生金额。 */
  maxBudget: number;
  /** 下次月度 reset 时间 ISO8601。 */
  budgetResetAt?: string | null;
  /**
   * 今日 (UTC 日) 跨客户端累计，保持 Gateway 部署区域的原生金额，来自
   * LiteLLM /user/daily/activity 的
   * results[0].metrics.spend。null 表示该端点暂时不可用 (跟 cycle 是独立 fetch),
   * 此时消费方应隐藏 daily 段。
   */
  todaySpend: number | null;
  fetchedAt: number;
}

let lastSnapshot: ClaudeAccountUsageSnapshot | null = null;

function isSnapshot(v: unknown): v is ClaudeAccountUsageSnapshot {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<ClaudeAccountUsageSnapshot>;
  return (
    typeof r.spend === 'number' &&
    typeof r.maxBudget === 'number' &&
    r.maxBudget > 0 &&
    (typeof r.todaySpend === 'number' || r.todaySpend === null)
  );
}

export function useClaudeAccountUsage(
  enabled: boolean,
): ClaudeAccountUsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<ClaudeAccountUsageSnapshot | null>(() =>
    enabled ? lastSnapshot : null,
  );

  useEffect(() => {
    setSnapshot(enabled ? lastSnapshot : null);
  }, [enabled]);

  // mount 拉一次 (warm-start: main 若无 snapshot 会 force 刷新, 那一次的结果走 push 通道补帧)
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.electronAPI.maker.usage.getAccount('claude-code').then((res) => {
      if (cancelled) return;
      if (!isSnapshot(res)) return;
      lastSnapshot = res;
      setSnapshot(res);
    }).catch(() => {
      /* best-effort warm-start */
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // 订阅 push (cc / codex-api turn done 后 main 推 — 都是同一把 XD key 的 spend)
  useEffect(() => {
    if (!enabled) return;
    return window.electronAPI.maker.usage.onClaudeAccountChanged((p) => {
      if (!isSnapshot(p)) return;
      lastSnapshot = p;
      setSnapshot(p);
    });
  }, [enabled]);

  return snapshot;
}
