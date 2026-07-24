/**
 * claudeAccountUsage — Claude 账号配额 (LiteLLM spend / max_budget) 拉取与广播。
 *
 * 配额周期:
 *   字段来自 LiteLLM /v2/user/info 的 spend / max_budget / budget_reset_at。
 *   网关当前部署 budget_duration='30d', 所以 cycleSpend 是"本月度周期 (距上次 reset)
 *   跨所有客户端 / 所有 API key 的累计花费", cycleMaxBudget 是月度上限。
 *
 * 今日跨客户端 (todaySpend):
 *   走 LiteLLM /user/daily/activity?start_date=<UTC today>&end_date=<UTC today>, 返回
 *   results[0].metrics.spend (本 user 名下跨所有客户端 / 所有 API key 的当日累计, 与 web
 *   看板同源)。UTC 日切, 跟 web 看板边界完全对齐。
 *   历史: 早期网关没开这个端点, 改用 dailyBaselineStore (本机 baseline diff) 反推,
 *   现已下线 (2026-05-22 GateWay 同事 ship 后)。
 *   注: 曾额外用 /key/info + breakdown.api_keys 算"当前 API key 今日", 但 /key/info 解析到
 *   的是管理用途 key, 与子进程实际计费 key 不是同一把, 取出来的桶并非用户真实用量;
 *   且 todaySpend 已是本 user 当日全部用量, 该指标冗余, 2026-06-21 移除。
 *
 * 设计取舍 (与 usageBroadcaster.ts 拆开的理由):
 *   - usageBroadcaster.ts 原本职责 = 本机 SQLite 累加的"今日金额" + Codex token, 是
 *     turn 收尾的"记账"层。账号配额是"账号画像"层, 来源是 HTTP API 而非 SDK turn delta —
 *     两件事不同步 (前者写 SQLite + 同步广播, 后者 fire-and-forget + 节流), 强行混在
 *     一个文件里会让 broadcaster 的 turn-done 路径多一个 IO side-effect。
 *   - 拆出后:
 *     · usageBroadcaster 回到只管"两类本机累计"
 *     · register.ts turn-done handler 并列调用 recordTurnSpend(...) 与本模块的
 *       triggerClaudeAccountUsageRefresh() — 两个 side-effect 平级显式
 *     · 鉴权 / endpoint 来源走 maker-host (auth-adapters + runtime-configs), 不再
 *       直接读 process.env (生产链路下 ANTHROPIC_API_KEY 是空的, 真 key 在
 *       safeStorage 加密存)
 *
 * 节流与超时:
 *   - 单次 fetch 8s AbortController 超时
 *   - 距上次成功 / 失败拉取 < 10s 直接跳过 (force=true 跳过节流, IPC handler warm-start 用)
 *   - in-flight 去重 — 防 turn 密集时排队
 *
 * 失败语义:
 *   - env / 鉴权缺 / /v2/user/info 非 2xx / 超时 → 返 null, 不写 snapshot, 不广播
 *   - /user/daily/activity 非 2xx / 超时 → 仍广播月度 snapshot, todaySpend=null,
 *     renderer 隐藏 Daily 段并在 tooltip 标注端点暂不可用
 */

import { BrowserWindow } from 'electron';

import { createLogger } from '../logger';
import { readClaudeApiKey } from '../maker-host/auth-adapters';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs';

const log = createLogger('claudeAccountUsage');

/** IPC channel: main → renderer 推 Claude 月度配额变化。 */
export const USAGE_CLAUDE_ACCOUNT_CHANGED = 'usage:claude-account-changed';

export interface ClaudeAccountUsageSnapshot {
  /**
   * 当前周期(网关部署为 30d / 月度) 跨所有客户端 + 所有 API key 的累计花费,
   * 来自 Gateway user.spend，数值保持部署区域原生金额。不只本机本壳。
   */
  spend: number;
  /** 周期内预算上限，保持 Gateway 原值 (来自 user.max_budget)。 */
  maxBudget: number;
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
let fetchInFlight = false;
let lastFetchAt = 0;
let idlePollTimer: NodeJS.Timeout | null = null;

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
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v2/user/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) {
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
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/user/daily/activity?start_date=${today}&end_date=${today}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal },
    );
    if (!res.ok) {
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

async function fetchOnce(): Promise<ClaudeAccountUsageSnapshot | null> {
  const apiKey = readClaudeApiKey();
  // 直连真上游,不走本地 anthropic-compat-proxy —— 这条账号查询路径跟 Claude Code 子进程
  // 无关,proxy 只服务于子进程的 chat completion 请求。
  const baseUrl = claudeUpstreamEndpoint().trim();
  if (!apiKey || !baseUrl) return null;

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
    const todaySpend = dailyActivity ? resolveDailyActivitySpend(dailyActivity).todaySpend : null;
    log.info(
      `refreshed cycle=${cycle.spend.toFixed(2)}/${cycle.maxBudget.toFixed(2)} today=${todaySpend == null ? 'n/a' : todaySpend.toFixed(2)} resetAt=${cycle.budgetResetAt ?? 'n/a'}`,
    );
    return {
      spend: cycle.spend,
      maxBudget: cycle.maxBudget,
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
 *   - in-flight 去重: 已有进行中直接跳过
 *   - 节流: 距上次拉取 < 10s 跳过 (force=true 跳过节流, warm-start 用)
 *   - 拉到新数据后写 in-memory snapshot + broadcast
 *   - 首次成功 fetch 后启动空闲轮询定时器 (5 分钟周期, 保活 dailyBaselineStore.lastSeenSpend)
 */
export async function triggerClaudeAccountUsageRefresh(force = false): Promise<void> {
  if (fetchInFlight) return;
  if (!force && Date.now() - lastFetchAt < THROTTLE_MS) return;

  fetchInFlight = true;
  lastFetchAt = Date.now();
  try {
    const next = await fetchOnce();
    if (!next) return;
    snapshot = next;
    broadcast(next);
    ensureIdlePoll();
  } finally {
    fetchInFlight = false;
  }
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

export function readClaudeAccountUsageSnapshot(): ClaudeAccountUsageSnapshot | null {
  return snapshot;
}

function broadcast(payload: ClaudeAccountUsageSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(USAGE_CLAUDE_ACCOUNT_CHANGED, payload);
    }
  }
}
