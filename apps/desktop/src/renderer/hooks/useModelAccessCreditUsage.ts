/**
 * useModelAccessCreditUsage — 订阅当前账号的额度池账本
 * (订阅 / 充值 / 赠送三池的 remaining / used / total)。
 *
 * 为什么不复用 useClaudeAccountUsage:
 *   两者是**两种不同的额度语义**,不是同一份数据的两个入口。服务端按账号所属租户
 *   二选一提供:
 *     - 周期配额语义(spend / max_budget,有月度周期):由 useClaudeAccountUsage
 *       直接向推理入口查询。
 *     - 额度池账本语义(三池,发放 + 充值 + 赠送制,没有周期):推理入口不提供该查询,
 *       只能经服务端的 /api/model-access/credit-usage 拿 —— 即本 hook。
 *
 * 数据通道: billingApi.getCreditUsage() → IPC billing:get-credit-usage
 *   → main/billing GET /api/model-access/credit-usage。是 invoke 拉取,没有 push 通道。
 *
 * 刷新: mount 拉一次 + enabled 期间定时轮询。额度只在跑 turn 后变化,轮询周期取
 * 得比较松 —— 这是状态栏的辅助信息,不值得为它加高频请求。
 *
 * 失败一律返 null (消费方隐藏该指标,不显示会误导的 0):
 *   - 账号所属租户不提供该查询 → 服务端返回 BALANCE_NOT_SUPPORTED
 *   - 账号尚未开户 / 上游不可用 / 网络失败
 *
 * module-local cache 让切换会话时 chip 不闪空 (与 useClaudeAccountUsage 同做法)。
 */

import { useEffect, useState } from 'react';

import type { ModelAccessCreditUsage } from '../../shared/modelAccess';
import { billingApi } from '../features/billing/api';
import { useAuth } from '../contexts/AuthContext';

/** 额度变化只跟 turn 走,状态栏辅助信息不值得高频拉取。 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * 防闪烁缓存，**按账号绑定**。
 *
 * 额度是财务数据，缓存必须跟着账号走：同一个 renderer 生命周期内可以登出再登录另一个
 * 账号，若缓存不绑身份，新账号在自己的请求返回前会看到上一个账号的已用 / 总额；而下面
 * 的 catch 又刻意保留旧值（避免网络抖动清空），新账号不支持该查询或请求失败时这个错值
 * 会一直挂着。所以缓存连同当前账号 id 一起存，账号不匹配时视为无缓存。
 *
 * 本 hook 走 invoke 拉取、没有 main→renderer 的推送通道，不像 useClaudeAccountUsage
 * 那样会被新账号的广播覆盖，因此必须自己做这层隔离。
 */
interface CreditUsageSnapshot {
  accountId: string;
  usage: ModelAccessCreditUsage;
}

let cache: CreditUsageSnapshot | null = null;

function readCache(accountId: string | null): CreditUsageSnapshot | null {
  if (!accountId || cache?.accountId !== accountId) return null;
  return cache;
}

function isCreditPool(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const pool = v as { remaining?: unknown; used?: unknown; total?: unknown };
  return (
    typeof pool.remaining === 'string' &&
    (typeof pool.used === 'string' || pool.used === null) &&
    (typeof pool.total === 'string' || pool.total === null)
  );
}

function isCreditUsage(v: unknown): v is ModelAccessCreditUsage {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<ModelAccessCreditUsage>;
  return (
    typeof r.available === 'string' &&
    isCreditPool(r.plan) &&
    isCreditPool(r.purchased) &&
    isCreditPool(r.promotional)
  );
}

export function useModelAccessCreditUsage(
  enabled: boolean,
): ModelAccessCreditUsage | null {
  const { dataOwnerId } = useAuth();
  // state 连账号 id 一起存，隔离在**渲染期**完成而不是 effect 里:effect 要等本轮渲染
  // 提交后才执行，靠它清空会让切号后的首帧仍把上一个账号的额度渲染出去。
  const [snapshot, setSnapshot] = useState<CreditUsageSnapshot | null>(() =>
    readCache(dataOwnerId),
  );

  useEffect(() => {
    if (!enabled || !dataOwnerId) return;
    let cancelled = false;

    const load = () => {
      void billingApi
        .getCreditUsage()
        .then((res) => {
          if (cancelled) return;
          if (!isCreditUsage(res)) return;
          cache = { accountId: dataOwnerId, usage: res };
          setSnapshot(cache);
        })
        .catch(() => {
          /* 租户不提供该查询 / 未开户 / 上游不可用 → 保持本账号上一次值, 不清空 */
        });
    };

    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, dataOwnerId]);

  // 账号不匹配 / 未启用 → 当作没有数据。切号当帧即生效。
  if (!enabled || !dataOwnerId || snapshot?.accountId !== dataOwnerId) return null;
  return snapshot.usage;
}
