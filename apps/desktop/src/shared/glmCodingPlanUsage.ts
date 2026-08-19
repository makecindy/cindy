/**
 * glmCodingPlanUsage — GLM Coding Plan（智谱 / Z.ai 编码订阅套餐）余量的共享类型与纯函数。
 *
 * 数据来源：`GET {origin}/api/monitor/usage/quota/limit`（无参）——智谱官方 Claude Code 插件
 * `glm-plan-usage`（zai-org/zai-coding-plugins 的 query-usage.mjs）使用的同一端点。
 * 未列入智谱正式 API 文档，属官方插件在用的事实接口；响应可能整体包在 `data` 键里
 * （官方插件按 `json.data || json` 兜底）。
 *
 * 已证实的窗口形状（官方插件源码口径）：
 *   - `limits[].type === 'TOKENS_LIMIT'` → 5 小时 token 窗（percentage = 已用百分比）；
 *   - `limits[].type === 'TIME_LIMIT'`   → MCP 月度窗（percentage + currentValue / usage /
 *     usageDetails 明细）。
 * ⚠️ 未证实项，解析必须保守：
 *   - 官方插件源码没有映射**周额度**条目（FAQ 说套餐含每周限额，但该端点是否返回周窗
 *     无实样佐证）——未知 type 一律跳过，不推测、不补 0；
 *   - 同 type 出现多条（如未来 5h + 周都是 TOKENS_LIMIT）时无法区分——**全部跳过**该
 *     type，等真实 fixture 明确区分字段后再支持；
 *   - `percentage` 一律按已用百分比处理（官方插件对 TOKENS_LIMIT/TIME_LIMIT 同口径）。
 *
 * fail-safe 约定与 claudeSubscriptionUsage 相同：任何字段缺失 / 形状不符都跳过该字段
 * 而不是抛错；完全解析不出窗口时返回 null，调用方按"无数据"处理。
 */

/** 单个用量窗口。utilization 一律 0-100 已用百分比。 */
export interface GlmCodingPlanUsageWindow {
  utilization: number;
  /** Unix epoch 秒；缺失 = 未知（该字段未经 fixture 证实，UI 缺省时不渲染倒计时）。 */
  resetsAt?: number | null;
}

export interface GlmCodingPlanUsageSnapshot {
  /** 5 小时 token 窗（limits[].type === 'TOKENS_LIMIT'）。 */
  fiveHour?: GlmCodingPlanUsageWindow | null;
  /** MCP 月度窗（limits[].type === 'TIME_LIMIT'）；与 token 窗是不同维度，展示不相加。 */
  monthlyMcp?: GlmCodingPlanUsageWindow | null;
  /** 供应平台（决定用量端点 origin：zhipu=open.bigmodel.cn / zai=api.z.ai）。 */
  platform: 'zhipu' | 'zai';
  /** 查询所用 runtime 的 baseUrl（main 记录时附加）——同 key 换端点时判定快照过期。 */
  runtimeBaseUrl?: string | null;
  source?: 'monitor-endpoint' | string | null;
  /** 快照生成时间（ms epoch）。 */
  updatedAt?: number | null;
  /**
   * 归属 provider API key 的指纹（哈希截断，main 记录时附加，不含 key 原文）。
   * 同一 provider 换 key 后 reader 据此判定持久化快照过期，避免串账号。
   */
  keyFingerprint?: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  // Number(null) / Number('') 都是 0 —— 显式排除，null 语义必须保留为"无数据"。
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** ISO8601 字符串 / epoch 秒 / epoch 毫秒 → epoch 秒；解析不了 → null。 */
function toEpochSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // 毫秒级时间戳（> 10^12）归一到秒；fixture 未证实单位前两端都兼容。
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  if (typeof v === 'string' && v.length > 0) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return null;
}

/** 已知 reset 字段候选（fixture 未证实；命中即取，全部缺失 → null）。 */
const RESET_FIELD_CANDIDATES = ['resetsAt', 'resetAt', 'resetTime', 'reset_time', 'endTime'] as const;

function parseLimitEntryWindow(entry: Record<string, unknown>): GlmCodingPlanUsageWindow | null {
  const percentage = toFiniteNumber(entry.percentage);
  if (percentage === null) return null;
  let resetsAt: number | null = null;
  for (const field of RESET_FIELD_CANDIDATES) {
    resetsAt = toEpochSeconds(entry[field]);
    if (resetsAt !== null) break;
  }
  return { utilization: clampPercent(percentage), resetsAt };
}

/**
 * 解析 GET /api/monitor/usage/quota/limit 的响应 JSON。
 *
 * 同 type 多条时该 type 整体跳过（无法区分 5h 与未来可能的周窗，不猜第一条）；
 * 未知 type 静默跳过；解析不出任何已知窗口时返回 null。
 */
export function parseGlmCodingPlanQuotaLimitResponse(
  data: unknown,
  now: number,
  platform: 'zhipu' | 'zai',
): GlmCodingPlanUsageSnapshot | null {
  if (!isPlainObject(data)) return null;
  // 官方插件口径：响应可能整体包在 data 键里。
  const root = isPlainObject(data.data) ? data.data : data;

  const limits = Array.isArray(root.limits) ? root.limits : [];
  const tokensWindows: GlmCodingPlanUsageWindow[] = [];
  const timeWindows: GlmCodingPlanUsageWindow[] = [];
  for (const raw of limits) {
    if (!isPlainObject(raw)) continue;
    const window = parseLimitEntryWindow(raw);
    if (!window) continue;
    if (raw.type === 'TOKENS_LIMIT') tokensWindows.push(window);
    else if (raw.type === 'TIME_LIMIT') timeWindows.push(window);
    // 未知 type（周窗等未经证实的条目）静默跳过 —— fail-safe。
  }

  const fiveHour = tokensWindows.length === 1 ? tokensWindows[0] : null;
  const monthlyMcp = timeWindows.length === 1 ? timeWindows[0] : null;
  if (!fiveHour && !monthlyMcp) return null;

  return {
    fiveHour,
    monthlyMcp,
    platform,
    source: 'monitor-endpoint',
    updatedAt: now,
  };
}

// ── 告警判定（chip 变红的口径；与 claudeSubscriptionUsage 的剩余水位同标准） ───

/** 窗口进入告警的剩余水位：剩余 ≤10%（已用 ≥90%）。 */
const WINDOW_ALERT_UTILIZATION_PERCENT = 90;

/** 单个窗口告警：剩余水位见底。端点无 severity 字段，只有水位一条判据。 */
export function isGlmUsageWindowAlerting(
  window: GlmCodingPlanUsageWindow | null | undefined,
): boolean {
  if (!window) return false;
  return (
    typeof window.utilization === 'number'
    && Number.isFinite(window.utilization)
    && clampPercent(window.utilization) >= WINDOW_ALERT_UTILIZATION_PERCENT
  );
}

/** 影响当前会话的窗口是否告警（GLM 已知窗口都影响会话：5h token 窗 + MCP 月度窗）。 */
export function hasAlertingGlmWindow(snapshot: GlmCodingPlanUsageSnapshot | null): boolean {
  if (!snapshot) return false;
  return (
    isGlmUsageWindowAlerting(snapshot.fiveHour)
    || isGlmUsageWindowAlerting(snapshot.monthlyMcp)
  );
}
