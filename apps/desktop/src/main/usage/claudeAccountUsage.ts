import { refreshQuotaCredentialOwner, cloudQuotaOwnerKey, quotaCredentialGeneration, onQuotaCredentialSourceChanged } from '../model-access/quotaCredentialState.js';
import type { ClaudeQuotaClear } from '../../shared/claudeQuotaState.js';
import { readOrganizationAccountUsage } from './organizationAccountUsage.js';
/**
 * Cindy AI 企业账号配额读取与广播。公开函数和 IPC 沿用 Claude 历史命名。
 *
 * 唯一来源是 Model Access GET /api/model-access/quota，使用 Cindy 登录认证，
 * 不读取推理 Key，也不直连网关管理 API。旧服务端缺少接口时按不可用处理。
 * spend / maxBudget / currency / budgetResetAt 保持服务端周期额度口径；
 * todaySpend 为服务端统计口径的当天跨客户端消费，dailyLimitEnabled 控制日额度是否启用。
 *
 * 账号配额独立于 usageBroadcaster 的本机 turn 记账：任务收尾并列触发刷新，
 * 同账号并发合并、10 秒节流，首次成功后每 5 分钟空闲刷新。请求超时为 8 秒。
 * 失败不覆盖同账号已有快照、不广播；权威不限额和身份/来源失效会清缓存并广播。
 */

import { BrowserWindow } from 'electron';
import { isProviderDisabled } from '@cindy/model-providers';

import type { MoneyCurrency } from '../../shared/regionalMoney';
import { getAuthState } from '../authManager';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';

/** IPC channel: main → renderer 推 Claude 月度配额变化。 */
export const USAGE_CLAUDE_ACCOUNT_CHANGED = 'usage:claude-account-changed';

export interface ClaudeAccountUsageSnapshot {
  /** 当前周期跨客户端累计消费，保持服务端账号口径。 */
  spend: number;
  /** 周期预算上限，保持服务端原值。 */
  maxBudget: number;
  /** 服务端账号金额的原生币种。 */
  currency: MoneyCurrency;
  /** 下次周期重置时间 ISO8601。 */
  budgetResetAt?: string | null;
  /** 服务端统计口径的当天跨客户端累计；日额度未启用或明细不可用时为 null。 */
  todaySpend: number | null;
  /** 企业日额度开关；false 隐藏日额度和读取失败提示，旧主机可能不设置。 */
  dailyLimitEnabled?: boolean;
  /** 拉取时戳 (Date.now)。 */
  fetchedAt: number;
}

const THROTTLE_MS = 10_000;
/**
 * 空闲轮询周期: 5 分钟。
 * 目的: 即使本机不跑 cc turn (其它客户端在消费), chip 上的 daily / monthly 也要能
 * 持续追到最新状态, 不能停在最后一次 turn 的快照。5 分钟是经验权衡: 比 10s 节流松,
 * 不会无谓请求 Model Access; 比小时级紧, 用户感知滞后控制在 ~5min。
 */
const IDLE_POLL_INTERVAL_MS = 5 * 60 * 1000;

let snapshot: ClaudeAccountUsageSnapshot | null = null;
let snapshotOwnerKey: string | null = null;
let clearReason: ClaudeQuotaClear['quotaState'] = 'unlimited';
let fetchInFlight = false;
let fetchPromise: Promise<void> | null = null;
let fetchOwnerKey: string | null = null;
let refreshQueued = false;
let lastFetchAt = 0;
let lastFetchOwnerKey: string | null = null;
let idlePollTimer: NodeJS.Timeout | null = null;

/** Reset process-local quota state for tests that share one module instance. */
export function __resetClaudeAccountUsageForTesting(): void {
  if (idlePollTimer) clearInterval(idlePollTimer);
  idlePollTimer = null;
  snapshot = null;
  snapshotOwnerKey = null;
  clearReason = 'unlimited';
  fetchInFlight = false;
  fetchPromise = null;
  fetchOwnerKey = null;
  refreshQueued = false;
  lastFetchAt = 0;
  lastFetchOwnerKey = null;
  quotaSnapshotRevision = 0;
  quotaSnapshotListeners.clear();
}

/** 仅已登录的组织账号读取企业额度；个人账号和未登录模式不请求。 */
function currentQuotaOwner(): { key: string } | null {
  if (isProviderDisabled(readModelDisableOverrides(), 'xd')) return null;
  const auth = getAuthState();
  if (auth.mode !== 'cloud' || auth.user?.membershipKind !== 'org' || !auth.dataOwnerId) return null;
  return { key: cloudQuotaOwnerKey(auth)! };
}

/**
 * 触发一次 Claude 账号配额刷新 (background)。
 *   - in-flight 去重: 已有同账号读取时等待共享结果
 *   - 节流: 距上次拉取 < 10s 跳过 (force=true 跳过节流, warm-start 用)
 *   - 拉到新数据后写 in-memory snapshot + broadcast
 *   - 首次成功 fetch 后启动空闲轮询定时器 (5 分钟周期)
 */
export async function triggerClaudeAccountUsageRefresh(force = false): Promise<void> {
  const owner = currentQuotaOwner();
  if (!owner) return;
  if (fetchInFlight) {
    if (fetchOwnerKey !== owner.key) refreshQueued = true;
    await fetchPromise;
    return;
  }
  if (!force && lastFetchOwnerKey === owner.key && Date.now() - lastFetchAt < THROTTLE_MS) return;

  fetchInFlight = true;
  fetchOwnerKey = owner.key;
  lastFetchAt = Date.now();
  lastFetchOwnerKey = owner.key;
  let resolveFetch!: () => void;
  let rejectFetch!: (error: unknown) => void;
  const pending = new Promise<void>((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject; });
  fetchPromise = pending;
  void (async () => {
    try {
      refreshQuotaCredentialOwner(owner.key);
      const generation = quotaCredentialGeneration();
      const next = await readOrganizationAccountUsage();
      if (quotaCredentialGeneration() !== generation) return;
      if (currentQuotaOwner()?.key !== owner.key) return;
      if (next === 'unlimited') {
        const changed = snapshotOwnerKey !== owner.key || snapshot !== null || clearReason !== 'unlimited';
        clearReason = 'unlimited';
        snapshot = null;
        snapshotOwnerKey = owner.key;
        if (changed) broadcast(null);
        ensureIdlePoll();
        return;
      }
      if (!next) return;
      snapshot = next;
      snapshotOwnerKey = owner.key;
      broadcast(next);
      ensureIdlePoll();
    } finally {
      fetchInFlight = false;
      fetchPromise = null;
      fetchOwnerKey = null;
      if (refreshQueued) {
        refreshQueued = false;
        void triggerClaudeAccountUsageRefresh(true);
      }
    }
  })().then(resolveFetch, rejectFetch);
  await pending;
}

/**
 * 启动空闲轮询定时器 (idempotent)。每 5 分钟无条件触发一次 refresh, 让 chip 在用户不活
 * 跃时也能持续追到 daily / monthly 最新状态。
 *
 * 故意不放 module load 时 — 等到首次有用户产生的 fetch 成功后才启动, 避免未读取企业额度的
 * 进程也在后台请求 Model Access。
 */
function ensureIdlePoll(): void {
  if (idlePollTimer) return;
  idlePollTimer = setInterval(() => {
    void triggerClaudeAccountUsageRefresh(true);
  }, IDLE_POLL_INTERVAL_MS);
  if (typeof idlePollTimer.unref === 'function') idlePollTimer.unref();
}

export function readClaudeAccountUsageSnapshot(): ClaudeAccountUsageSnapshot | null {
  const owner = currentQuotaOwner();
  return owner && snapshotOwnerKey === owner.key ? snapshot : null;
}

/** Authoritative no-limit state is replayable even if no renderer heard its push. */
export function readClaudeAccountQuotaClear(): ClaudeQuotaClear | null {
  const owner = currentQuotaOwner();
  return owner && snapshotOwnerKey === owner.key && snapshot === null
    ? { quotaState: clearReason } : null;
}

let quotaSnapshotRevision = 0;
const quotaSnapshotListeners = new Set<() => void>();
export function readClaudeAccountUsageRevision(): number { return quotaSnapshotRevision; }
export function observeClaudeAccountUsage(listener: () => void): () => void {
  quotaSnapshotListeners.add(listener);
  return () => { quotaSnapshotListeners.delete(listener); };
}

function broadcast(payload: ClaudeAccountUsageSnapshot | null): void {
  quotaSnapshotRevision++;
  for (const listener of quotaSnapshotListeners) listener();

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_CLAUDE_ACCOUNT_CHANGED, payload);
    }
  }
  // device-link:控制端远程网关形态会话 chip 镜像被控端 daily/monthly 配额
  // (刷新自带 10s 节流 + turn-done 触发,低频;无 active 链路时 O(1) no-op)。
  tapWindowBroadcast(USAGE_CLAUDE_ACCOUNT_CHANGED, payload);
}

// A new gateway invalidates both finite and unlimited results from the previous
// source. Replayable invalidation also covers renderers that missed the push.
onQuotaCredentialSourceChanged((ownerKey) => {
  const owner = currentQuotaOwner();
  if (!owner || owner.key !== ownerKey) return;
  snapshot = null;
  snapshotOwnerKey = owner.key;
  clearReason = 'invalidated';
  lastFetchAt = 0;
  broadcast(null);
  if (fetchInFlight) refreshQueued = true;
  else void triggerClaudeAccountUsageRefresh(true).catch(() => undefined);
});
