
import type { ClaudeQuotaClear } from './claudeQuotaState.js';

import type { MoneyCurrency } from '@cindy/maker-shared/regional-money';
import type {DbLogger} from '@cindy/runtime-db/logging';import type {QuotaAuthState,createQuotaCredentialState} from './quotaCredentialState.js';import type {createOrganizationAccountUsage} from './organizationAccountUsage.js';import type {createGatewayModelPricing} from './modelPricing.js';
export interface createClaudeAccountUsageHost extends Pick<ReturnType<typeof createQuotaCredentialState>,'refreshQuotaCredentialOwner'|'cloudQuotaOwnerKey'|'quotaCredentialsReady'|'quotaCredentialGeneration'|'onQuotaCredentialSourceChanged'>,ReturnType<typeof createOrganizationAccountUsage>,Pick<ReturnType<typeof createGatewayModelPricing>,'getGatewayAccountCurrency'> {
getAuthState():QuotaAuthState;createLogger(name:string):DbLogger;readClaudeApiKey():string|null;reportCindyGatewayKeyRejected(key:string|null|undefined):void;outboundFetch:typeof fetch;claudeUpstreamEndpoint():string;currentLedgerCurrency():MoneyCurrency;tapWindowBroadcast(channel:string,payload:unknown):void;broadcastLocal(channel:string,payload:unknown):void;
}


export interface ClaudeAccountUsageSnapshot {
  /**
   * 当前周期(网关部署为 30d / 月度) 跨所有客户端 + 所有 API key 的累计花费,
   * 来自 Gateway user.spend，数值与币种均保持 Gateway 账号口径。不只本机本壳。
   */
  spend: number;
  /** 周期内预算上限，保持 Gateway 原值 (来自 user.max_budget)。 */
  maxBudget: number;
  /** 与当前 Model Access 模型目录声明一致的 Gateway 账号原生币种。 */
  currency: MoneyCurrency;
  /** 下次重置时间 ISO8601 (来自 user.budget_reset_at)。 */
  budgetResetAt?: string | null;
  /**
   * 今日 (UTC 日) 跨所有客户端累计金额，保持 Gateway 原值，来自
   * LiteLLM /user/daily/activity 的
   * results[0].metrics.spend。null = 端点暂时拉不到 (跟 cycle 是两个独立 fetch,
   * 任一可能失败); chip 的 daily 段会因此变 unavailable。
   */
  todaySpend: number | null;
  /** 拉取时戳 (Date.now)。 */
  fetchedAt: number;
}

interface LiteLlmUserInfo {
  spend?: number;
  max_budget?: number;
  budget_reset_at?: string | null;
}

interface LiteLlmDailyActivity {
  results?: Array<{
    date?: string;
    metrics?: { spend?: number };
  }>;
}

interface QuotaOwner {
  key: string;
  authenticatedUserId?: string;
}
export function createClaudeAccountUsage(host:createClaudeAccountUsageHost) {
const {refreshQuotaCredentialOwner,cloudQuotaOwnerKey,quotaCredentialsReady,quotaCredentialGeneration,onQuotaCredentialSourceChanged,readOrganizationAccountUsage,getAuthState,tapWindowBroadcast,createLogger,readClaudeApiKey,reportCindyGatewayKeyRejected,outboundFetch,claudeUpstreamEndpoint,getGatewayAccountCurrency,currentLedgerCurrency}=host;


const log = createLogger('claudeAccountUsage');

/** IPC channel: main → renderer 推 Claude 月度配额变化。 */
const USAGE_CLAUDE_ACCOUNT_CHANGED = 'usage:claude-account-changed';

const FETCH_TIMEOUT_MS = 8000;
const THROTTLE_MS = 10_000;
/**
 * 空闲轮询周期: 5 分钟。
 * 目的: 即使本机不跑 cc turn (其它客户端在消费), chip 上的 daily / monthly 也要能
 * 持续追到最新状态, 不能停在最后一次 turn 的快照。5 分钟是经验权衡: 比 10s 节流松,
 * 不会无谓打 LiteLLM; 比小时级紧, 用户感知滞后控制在 ~5min。
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
function __resetClaudeAccountUsageForTesting(): void {
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

/** 组织账号与 local 手填网关可读周期配额；个人账号只读额度池账本。 */
function currentQuotaOwner(): QuotaOwner | null {
  const auth = getAuthState();
  if (auth.mode === 'cloud') {
    if (auth.user?.membershipKind !== 'org' || !auth.dataOwnerId) return null;
    return { key: cloudQuotaOwnerKey(auth)!, authenticatedUserId: auth.user.id };
  }
  if (auth.mode === 'local' && auth.dataOwnerId) {
    return { key: `local:${auth.dataOwnerId}` };
  }
  return null;
}

/** UTC YYYY-MM-DD。跟 web 看板 的 daily 边界对齐。 */
function utcTodayKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchUserInfo(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ spend: number; maxBudget: number; budgetResetAt: string | null } | null> {
  try {
    const res = await outboundFetch(`${baseUrl.replace(/\/+$/, '')}/v2/user/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) {
      if (res.status === 401) reportCindyGatewayKeyRejected(apiKey);
      log.debug(`user/info non-2xx: ${res.status}`);
      return null;
    }
    const json = (await res.json()) as LiteLlmUserInfo;
    const spend = Number(json.spend);
    const maxBudget = Number(json.max_budget);
    if (!Number.isFinite(spend) || !Number.isFinite(maxBudget) || maxBudget <= 0) {
      return null;
    }
    return {
      spend,
      maxBudget,
      budgetResetAt: typeof json.budget_reset_at === 'string' ? json.budget_reset_at : null,
    };
  } catch (err) {
    log.debug('user/info failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function fetchTodayActivity(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<LiteLlmDailyActivity | null> {
  const today = utcTodayKey();
  try {
    const res = await outboundFetch(
      `${baseUrl.replace(/\/+$/, '')}/user/daily/activity?start_date=${today}&end_date=${today}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal },
    );
    if (!res.ok) {
      if (res.status === 401) reportCindyGatewayKeyRejected(apiKey);
      log.debug(`daily/activity non-2xx: ${res.status}`);
      return null;
    }
    return (await res.json()) as LiteLlmDailyActivity;
  } catch (err) {
    log.debug('daily/activity failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function resolveDailyActivitySpend(activity: LiteLlmDailyActivity): { todaySpend: number } {
  const today = utcTodayKey();
  if (!Array.isArray(activity.results) || activity.results.length === 0) {
    return { todaySpend: 0 };
  }

  const todayRow = activity.results.find((r) => r.date === today) ?? activity.results[0];
  const totalSpend = Number(todayRow?.metrics?.spend);
  return { todaySpend: Number.isFinite(totalSpend) ? totalSpend : 0 };
}

async function fetchOnce(authenticatedUserId?: string): Promise<ClaudeAccountUsageSnapshot | 'unlimited' | null> {
  // Enterprise AIGateway inference endpoints need not expose LiteLLM management APIs.
  // Resolve the signed-in member's tenant in Model Access. Nova/older servers keep
  // the existing direct query; authorization/network errors never trigger fallback.
  if (getAuthState().mode === 'cloud') {
    const managed = await readOrganizationAccountUsage();
    if (managed !== undefined) return managed;
  }
  // 币种优先取账号目录声明。取不到时**不放弃整个快照**,回落本地账本币种:
  // 手填 XD key 是明确支持的兜底流程(Model Access 处于 disabled / failed 时),那时没有
  // 目录可推导,若直接 return 会让这些会话永久看不到账号配额 —— 比"币种按账本回落"更糟。
  // 回落值与账本写入侧同源(currentLedgerCurrency),不会与同一行的其它金额混排。
  const currency =
    (await getGatewayAccountCurrency(authenticatedUserId)) ?? currentLedgerCurrency();
  const apiKey = readClaudeApiKey();
  // 直连真上游,不走本地 anthropic-compat-proxy —— 这条账号查询路径跟 Claude Code 子进程
  // 无关,proxy 只服务于子进程的 chat completion 请求。
  const baseUrl = claudeUpstreamEndpoint().trim();
  if (!apiKey || !baseUrl) return null;
  const legacyOwner = currentQuotaOwner();
  if (getAuthState().mode === 'cloud' && (!legacyOwner || !quotaCredentialsReady(legacyOwner.key, baseUrl))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // 两条独立 endpoint 并行:
    //   - user/info 给月度配额
    //   - daily/activity 给今日 (本 user 跨所有客户端 / 所有 key) 累计
    // 月度失败则整个 snapshot 视为不可用(null)。daily 失败只让 todaySpend=null。
    const [cycle, dailyActivity] = await Promise.all([
      fetchUserInfo(baseUrl, apiKey, controller.signal),
      fetchTodayActivity(baseUrl, apiKey, controller.signal),
    ]);
    if (!cycle) return null;
    if (getAuthState().mode === 'cloud' && (!legacyOwner || !quotaCredentialsReady(legacyOwner.key, baseUrl))) return null;
    const todaySpend = dailyActivity ? resolveDailyActivitySpend(dailyActivity).todaySpend : null;
    log.info(
      `refreshed cycle=${cycle.spend.toFixed(2)}/${cycle.maxBudget.toFixed(2)} today=${todaySpend == null ? 'n/a' : todaySpend.toFixed(2)} resetAt=${cycle.budgetResetAt ?? 'n/a'}`,
    );
    return {
      spend: cycle.spend,
      maxBudget: cycle.maxBudget,
      currency,
      budgetResetAt: cycle.budgetResetAt,
      todaySpend,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 触发一次 Claude 账号配额刷新 (background)。
 *   - in-flight 去重: 已有同账号读取时等待共享结果
 *   - 节流: 距上次拉取 < 10s 跳过 (force=true 跳过节流, warm-start 用)
 *   - 拉到新数据后写 in-memory snapshot + broadcast
 *   - 首次成功 fetch 后启动空闲轮询定时器 (5 分钟周期, 保活 dailyBaselineStore.lastSeenSpend)
 */
async function triggerClaudeAccountUsageRefresh(force = false): Promise<void> {
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
      if (owner.key.startsWith('cloud:')) refreshQuotaCredentialOwner(owner.key);
      const generation = quotaCredentialGeneration();
      const next = await fetchOnce(owner.authenticatedUserId);
      if (getAuthState().mode === 'cloud' && quotaCredentialGeneration() !== generation) return;
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
 * 故意不放 module load 时 — 等到首次有用户产生的 fetch 成功后才启动, 避免无 Claude 用户的
 * 进程也在后台打 LiteLLM。
 */
function ensureIdlePoll(): void {
  if (idlePollTimer) return;
  idlePollTimer = setInterval(() => {
    void triggerClaudeAccountUsageRefresh(true);
  }, IDLE_POLL_INTERVAL_MS);
  if (typeof idlePollTimer.unref === 'function') idlePollTimer.unref();
}

function readClaudeAccountUsageSnapshot(): ClaudeAccountUsageSnapshot | null {
  const owner = currentQuotaOwner();
  return owner && snapshotOwnerKey === owner.key ? snapshot : null;
}

/** Authoritative no-limit state is replayable even if no renderer heard its push. */
function readClaudeAccountQuotaClear(): ClaudeQuotaClear | null {
  const owner = currentQuotaOwner();
  return owner && snapshotOwnerKey === owner.key && snapshot === null
    ? { quotaState: clearReason } : null;
}

let quotaSnapshotRevision = 0;
const quotaSnapshotListeners = new Set<() => void>();
function readClaudeAccountUsageRevision(): number { return quotaSnapshotRevision; }
function observeClaudeAccountUsage(listener: () => void): () => void {
  quotaSnapshotListeners.add(listener);
  return () => { quotaSnapshotListeners.delete(listener); };
}

function broadcast(payload: ClaudeAccountUsageSnapshot | null): void {
  quotaSnapshotRevision++;
  for (const listener of quotaSnapshotListeners) listener();

  host.broadcastLocal(USAGE_CLAUDE_ACCOUNT_CHANGED,payload);
  // device-link:控制端远程网关形态会话 chip 镜像被控端 daily/monthly 配额
  // (刷新自带 10s 节流 + turn-done 触发,低频;无 active 链路时 O(1) no-op)。
  tapWindowBroadcast(USAGE_CLAUDE_ACCOUNT_CHANGED, payload);
}

// A new gateway invalidates both finite and unlimited results from the previous
// source. Replayable invalidation also covers renderers that missed the push.
const disposeSourceObserver=onQuotaCredentialSourceChanged((ownerKey) => {
  const owner = currentQuotaOwner();
  if (!owner || !owner.key.startsWith('cloud:') || owner.key !== ownerKey) return;
  snapshot = null;
  snapshotOwnerKey = owner.key;
  clearReason = 'invalidated';
  lastFetchAt = 0;
  broadcast(null);
  if (fetchInFlight) refreshQueued = true;
  else void triggerClaudeAccountUsageRefresh(true).catch(() => undefined);
});
return {
  close(){if(idlePollTimer)clearInterval(idlePollTimer);idlePollTimer=null;disposeSourceObserver();},
  USAGE_CLAUDE_ACCOUNT_CHANGED,
  __resetClaudeAccountUsageForTesting,
  triggerClaudeAccountUsageRefresh,
  readClaudeAccountUsageSnapshot,
  readClaudeAccountQuotaClear,
  readClaudeAccountUsageRevision,
  observeClaudeAccountUsage
};
}
