/**
 * claudeSubscriptionUsage — Claude 订阅(Anthropic OAuth)账号余量的共享类型与纯函数。
 *
 * 数据有两个来源,口径不同,统一归一化成 `ClaudeSubscriptionUsageSnapshot`(utilization
 * 一律 0-100 已用百分比):
 *   1. `oauth-endpoint` — GET api.anthropic.com/api/oauth/usage(未文档化端点,Claude Code
 *      自己的 /usage 命令同源)。utilization 为 0-100;新 schema 以 `limits[]` 数组为准
 *      (kind: session / weekly_all / weekly_scoped,scoped 带 scope.model),旧 schema 的
 *      `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` 顶层键做兜底。
 *      仅端点源有分模型周窗口(Fable / Opus / Sonnet 各自独立)与 extra usage。
 *   2. `unified-headers` — 订阅直连响应上的 `anthropic-ratelimit-unified-*` headers
 *      (每次 API call 都带,由本地 proxy 旁路读取)。utilization 为 0.0-1.0 分数,
 *      解析时 ×100;只有 5h / 7d 总窗口,没有 scoped。
 *
 * 两源合并语义见 mergeClaudeSubscriptionUsageSnapshot:endpoint 全量替换,headers 只
 * 增量刷新 5h / 7d 与整体状态,保留 endpoint 独有的 scoped / extraUsage / 套餐信息。
 *
 * ⚠️ 这两个数据源都未文档化,解析必须 fail-safe:任何字段缺失 / 形状不符都跳过该字段
 * 而不是抛错;完全解析不出内容时返回 null,调用方按"无数据"处理(绝不从 token 用量反推)。
 */

/** 单个用量窗口(5h / 周 / 分模型周)。utilization 一律 0-100 已用百分比。 */
export interface ClaudeUsageWindow {
  utilization: number;
  /** Unix epoch 秒;缺失 = 未知。 */
  resetsAt?: number | null;
  /** 服务端判定的告警级别(端点 limits[].severity,如 'normal';headers 源无此字段)。 */
  severity?: string | null;
}

/** 分模型周窗口(端点 limits[] 里 kind=weekly_scoped 的条目)。 */
export interface ClaudeScopedUsageWindow extends ClaudeUsageWindow {
  /** scope.model.display_name,如 'Fable' / 'Opus' / 'Sonnet'。 */
  modelDisplayName: string;
  /** scope.model.id(端点常为 null)。 */
  modelId?: string | null;
}

/** extra usage(usage credits)状态 —— 套餐打满后的按量付费通道。 */
export interface ClaudeExtraUsageSnapshot {
  isEnabled: boolean;
  /** 0-100;仅启用且服务端给值时有。 */
  utilization?: number | null;
  /**
   * 已用 credits(服务端原值)。单位未文档化,不要当货币金额展示;
   * 仅保留原始值,等拿到 extra-usage 账号实样后再定展示口径。
   */
  usedCredits?: number | null;
  /** 月度上限原值;0 = 不限。单位未文档化,不要当货币金额展示。 */
  monthlyLimit?: number | null;
}

export interface ClaudeSubscriptionUsageSnapshot {
  /** 5 小时滚动窗口。 */
  fiveHour?: ClaudeUsageWindow | null;
  /** 总周限窗口。 */
  sevenDay?: ClaudeUsageWindow | null;
  /** 分模型周窗口(仅 oauth-endpoint 源有)。 */
  scoped?: ClaudeScopedUsageWindow[];
  /** 订阅套餐(凭证 blob 的 subscriptionType: pro / max 等,记录时由 main 一并写入)。 */
  subscriptionType?: string | null;
  /** headers 源的整体状态:allowed / allowed_warning / rejected。 */
  rateLimitStatus?: string | null;
  /** headers 源:当前代表性(最紧)窗口名,如 'five_hour' / 'seven_day'。 */
  representativeClaim?: string | null;
  extraUsage?: ClaudeExtraUsageSnapshot | null;
  source?: 'oauth-endpoint' | 'unified-headers' | string | null;
  /** 快照生成时间(ms epoch)。 */
  updatedAt?: number | null;
  /**
   * 归属账号的 OAuth token 指纹(sha256 截断, main 记录时附加, 不含 token 原文)。
   * 同机换号时 reader 据此判定持久化快照已过期, 避免 chip 闪上一个账号的余量。
   * 缺失(旧快照 / 仅 headers 源)时按未知归属处理, 不据此清除。
   */
  accountFingerprint?: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  // Number(null) / Number('') 都是 0 —— 显式排除, null 语义必须保留为"无数据"。
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** ISO8601 字符串 / epoch 秒 → epoch 秒;解析不了 → null。 */
function toEpochSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string' && v.length > 0) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return null;
}

function toOptionalString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// ── oauth-endpoint 解析 ──────────────────────────────────────────────────────

/** limits[] 单条 → 窗口(utilization 取 percent 字段,0-100)。 */
function parseLimitEntryWindow(entry: Record<string, unknown>): ClaudeUsageWindow | null {
  const percent = toFiniteNumber(entry.percent);
  if (percent === null) return null;
  return {
    utilization: clampPercent(percent),
    resetsAt: toEpochSeconds(entry.resets_at),
    severity: toOptionalString(entry.severity),
  };
}

/** 旧 schema 顶层键(five_hour 等)→ 窗口(utilization 字段,0-100)。 */
function parseLegacyWindow(v: unknown): ClaudeUsageWindow | null {
  if (!isPlainObject(v)) return null;
  const utilization = toFiniteNumber(v.utilization);
  if (utilization === null) return null;
  return {
    utilization: clampPercent(utilization),
    resetsAt: toEpochSeconds(v.resets_at),
  };
}

function parseExtraUsage(v: unknown): ClaudeExtraUsageSnapshot | null {
  if (!isPlainObject(v)) return null;
  const isEnabled = v.is_enabled === true;
  const utilization = toFiniteNumber(v.utilization);
  const usedCredits = toFiniteNumber(v.used_credits);
  const monthlyLimit = toFiniteNumber(v.monthly_limit);
  if (!isEnabled && utilization === null && usedCredits === null) return null;
  return {
    isEnabled,
    utilization: utilization === null ? null : clampPercent(utilization),
    usedCredits,
    monthlyLimit,
  };
}

/**
 * 解析 GET /api/oauth/usage 的响应 JSON。
 *
 * 优先走新 schema 的 `limits[]`(带 severity / scoped 模型信息);旧 schema 顶层键兜底。
 * 未知字段(实验性混淆键等)一律忽略。解析不出任何窗口时返回 null。
 */
export function parseClaudeOAuthUsageResponse(
  data: unknown,
  now: number,
): ClaudeSubscriptionUsageSnapshot | null {
  if (!isPlainObject(data)) return null;

  let fiveHour: ClaudeUsageWindow | null = null;
  let sevenDay: ClaudeUsageWindow | null = null;
  const scoped: ClaudeScopedUsageWindow[] = [];

  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const raw of limits) {
    if (!isPlainObject(raw)) continue;
    const window = parseLimitEntryWindow(raw);
    if (!window) continue;
    const kind = toOptionalString(raw.kind);
    if (kind === 'session') {
      fiveHour = window;
    } else if (kind === 'weekly_all') {
      sevenDay = window;
    } else if (kind === 'weekly_scoped') {
      const scope = isPlainObject(raw.scope) ? raw.scope : null;
      const model = scope && isPlainObject(scope.model) ? scope.model : null;
      const displayName = model ? toOptionalString(model.display_name) : null;
      if (displayName) {
        scoped.push({
          ...window,
          modelDisplayName: displayName,
          modelId: model ? toOptionalString(model.id) : null,
        });
      }
    }
    // 未知 kind(未来新窗口类型)静默跳过 —— fail-safe。
  }

  // 旧 schema 兜底:limits[] 没给的窗口再看顶层键。
  if (!fiveHour) fiveHour = parseLegacyWindow(data.five_hour);
  if (!sevenDay) sevenDay = parseLegacyWindow(data.seven_day);
  if (scoped.length === 0) {
    const legacyScoped: Array<[unknown, string]> = [
      [data.seven_day_opus, 'Opus'],
      [data.seven_day_sonnet, 'Sonnet'],
    ];
    for (const [raw, displayName] of legacyScoped) {
      const window = parseLegacyWindow(raw);
      if (window) scoped.push({ ...window, modelDisplayName: displayName });
    }
  }

  if (!fiveHour && !sevenDay && scoped.length === 0) return null;

  return {
    fiveHour,
    sevenDay,
    scoped,
    extraUsage: parseExtraUsage(data.extra_usage),
    source: 'oauth-endpoint',
    updatedAt: now,
  };
}

// ── unified-headers 解析 ─────────────────────────────────────────────────────

const UNIFIED_HEADER_PREFIX = 'anthropic-ratelimit-unified-';

/** headers 的 utilization 是 0.0-1.0 分数(与端点的 0-100 不同),×100 归一化。 */
function parseHeaderUtilization(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return clampPercent(n * 100);
}

function parseHeaderEpochSeconds(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * 解析 `anthropic-ratelimit-unified-*` 响应 headers(key 需已小写化)。
 *
 * 只认 5h / 7d 两个总窗口 + 整体 status / representative-claim;没有任何 unified
 * header 时返回 null(非订阅直连响应,如网关路由,天然没有这些头)。
 */
export function parseClaudeUnifiedRateLimitHeaders(
  headers: Readonly<Record<string, string>>,
  now: number,
): ClaudeSubscriptionUsageSnapshot | null {
  const fiveHourUtil = parseHeaderUtilization(headers[`${UNIFIED_HEADER_PREFIX}5h-utilization`]);
  const sevenDayUtil = parseHeaderUtilization(headers[`${UNIFIED_HEADER_PREFIX}7d-utilization`]);
  const status = toOptionalString(headers[`${UNIFIED_HEADER_PREFIX}status`]);
  const representativeClaim = toOptionalString(
    headers[`${UNIFIED_HEADER_PREFIX}representative-claim`],
  );

  if (fiveHourUtil === null && sevenDayUtil === null && !status) return null;

  return {
    fiveHour: fiveHourUtil === null
      ? null
      : {
        utilization: fiveHourUtil,
        resetsAt: parseHeaderEpochSeconds(headers[`${UNIFIED_HEADER_PREFIX}5h-reset`]),
      },
    sevenDay: sevenDayUtil === null
      ? null
      : {
        utilization: sevenDayUtil,
        resetsAt: parseHeaderEpochSeconds(headers[`${UNIFIED_HEADER_PREFIX}7d-reset`]),
      },
    rateLimitStatus: status,
    representativeClaim,
    source: 'unified-headers',
    updatedAt: now,
  };
}

// ── 双源合并 ─────────────────────────────────────────────────────────────────

/**
 * 双源合并:
 *   - incoming 为 headers 源 → 以 prev 为底做增量:只覆盖 headers 有的 5h / 7d 窗口与
 *     整体状态,保留 endpoint 独有的 scoped / extraUsage / subscriptionType / severity
 *     不被清掉(headers 没有这些维度,不代表它们消失了)。
 *   - incoming 为 endpoint 源 → 全量替换(endpoint 是权威全集),仅 subscriptionType /
 *     headers 独有的 rateLimitStatus 在 incoming 缺失时沿用 prev。
 */
export function mergeClaudeSubscriptionUsageSnapshot(
  prev: ClaudeSubscriptionUsageSnapshot | null,
  incoming: ClaudeSubscriptionUsageSnapshot,
): ClaudeSubscriptionUsageSnapshot {
  if (!prev) return incoming;

  // 归属指纹冲突(同机换号): prev 属于另一个 Claude 账号, 任何字段都不得沿用 ——
  // 否则 headers 增量会把上一个账号的 scoped / subscriptionType / extraUsage 串给
  // 新账号(owner 维度是 App 用户, 换 Claude 号时不变, prev 不会被 owner 逻辑清除)。
  // incoming 直接作为新账号的起点。
  if (
    prev.accountFingerprint
    && incoming.accountFingerprint
    && prev.accountFingerprint !== incoming.accountFingerprint
  ) {
    return incoming;
  }

  if (incoming.source === 'unified-headers') {
    return {
      ...prev,
      fiveHour: incoming.fiveHour ?? prev.fiveHour,
      sevenDay: incoming.sevenDay ?? prev.sevenDay,
      rateLimitStatus: incoming.rateLimitStatus ?? prev.rateLimitStatus,
      representativeClaim: incoming.representativeClaim ?? prev.representativeClaim,
      updatedAt: incoming.updatedAt ?? prev.updatedAt,
      accountFingerprint: incoming.accountFingerprint ?? prev.accountFingerprint,
      // 展示来源标为最近一次更新者;scoped / extraUsage 仍是 endpoint 的旧值。
      source: 'unified-headers',
    };
  }

  // endpoint 全量替换: headers-only 的 rateLimitStatus / representativeClaim 是
  // 瞬时信号, **不**沿用 —— 限额重置后若长期没有新直连响应(如 app 重启后仅端点
  // 轮询), 陈旧的 rejected / allowed_warning 会与端点刚带回的最新窗口数据矛盾,
  // chip 永久挂警示色。真实限流时下一次直连响应的 headers 会立即重新带回 status;
  // 端点源自身的窗口 severity 也表达告警。subscriptionType / accountFingerprint
  // 是稳定事实(凭证派生), 保留兜底。
  return {
    ...incoming,
    subscriptionType: incoming.subscriptionType ?? prev.subscriptionType,
    accountFingerprint: incoming.accountFingerprint ?? prev.accountFingerprint,
  };
}

// ── 方案 B:当前模型 → scoped 窗口匹配 ───────────────────────────────────────

/**
 * 从 model id 提取模型家族名(与端点 scope.model.display_name 对齐的小写词)。
 *   'claude-fable-5[1m]' → 'fable';'claude-opus-4-8' → 'opus';'sonnet' → 'sonnet'
 * 未识别 → null(调用方回退总周限)。
 */
export function claudeModelFamily(modelId: string | null | undefined): string | null {
  const normalized = (modelId ?? '').trim().toLowerCase().replace(/\[[^\]]*\]\s*$/, '');
  if (!normalized) return null;
  // 顺序无关 —— 家族名互斥地出现在 Anthropic model id 里。
  for (const family of ['fable', 'mythos', 'opus', 'sonnet', 'haiku']) {
    if (normalized.includes(family)) return family;
  }
  return null;
}

/**
 * 找当前会话模型对应的分模型周窗口(chip 方案 B:第二栏跟随当前模型)。
 * 匹配口径:scoped.modelDisplayName 小写 == 模型家族名。找不到 → null,调用方回退
 * sevenDay 总周限(绝不臆造)。
 */
export function matchScopedWindowForModel(
  scoped: ClaudeScopedUsageWindow[] | null | undefined,
  modelId: string | null | undefined,
): ClaudeScopedUsageWindow | null {
  if (!scoped || scoped.length === 0) return null;
  const family = claudeModelFamily(modelId);
  if (!family) return null;
  return scoped.find((w) => w.modelDisplayName.trim().toLowerCase() === family) ?? null;
}

// ── 告警判定(chip 变红的口径;tooltip 另有 status 分流,见 TodaySpendChip) ───

/**
 * 窗口进入告警的剩余水位:剩余 ≤10%(已用 ≥90%)。
 *
 * 兜的是 unified-headers 源没有 per-window `severity` 这个事实 —— 该源只给 utilization,
 * 光靠「打满」判定会让 chip 一直到 99.95% 才变红。用固定水位而不是 headers 的整体
 * `allowed_warning`:水位对着 chip 上正在显示的那个数字,「剩余 8%」是红的能自证;
 * 整体 status 综合了 chip 上没有的窗口,红了无从解释(见 isClaudeSubscriptionAlerting)。
 */
const WINDOW_ALERT_UTILIZATION_PERCENT = 90;

/**
 * 单个窗口告警:剩余水位见底,或服务端 severity 明确非 normal。
 *
 * utilization 走 Number.isFinite 而不只是 typeof —— 与本文件其它调用点同口径。解析层
 * (toFiniteNumber / parseHeaderUtilization)本就只放行有限数, 但持久化快照是 JSON.parse
 * 后直接断言成 snapshot 的(见 usageBroadcaster hydration), 不重新校验字段; 万一有脏值
 * 滑进来, +Infinity 会被 clampPercent 夹成 100 并误判成额度耗尽而染红。
 */
export function isClaudeUsageWindowAlerting(
  window: ClaudeUsageWindow | null | undefined,
): boolean {
  if (!window) return false;
  if (
    typeof window.utilization === 'number'
    && Number.isFinite(window.utilization)
    && clampPercent(window.utilization) >= WINDOW_ALERT_UTILIZATION_PERCENT
  ) {
    return true;
  }
  const severity = window.severity?.trim().toLowerCase();
  return Boolean(severity && severity !== 'normal');
}

/**
 * 影响当前会话的窗口是否告警:只看 5h / 总周限 / **当前模型**的 scoped 周限 ——
 * 其它模型的 scoped 窗口打满不限流当前会话(跑 Opus 时 Fable 周限见底与本会话无关),
 * 只在 tooltip 的全量窗口列表里可见,不参与判定。
 */
export function hasAlertingClaudeSessionWindow(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId: string | null | undefined,
): boolean {
  if (!snapshot) return false;
  return (
    isClaudeUsageWindowAlerting(snapshot.fiveHour)
    || isClaudeUsageWindowAlerting(snapshot.sevenDay)
    || isClaudeUsageWindowAlerting(matchScopedWindowForModel(snapshot.scoped, modelId))
  );
}

/**
 * chip 警示态(变红):只在当前会话**真的**受限时亮 —— 请求已被拒(headers 整体
 * status = rejected),或影响当前会话的窗口告警(见上)。
 *
 * headers 的 `allowed_warning` **不**单独染红:它是服务端综合全部窗口(含其它模型的
 * 分模型周限)给出的模糊信号,而 chip 只显示 5h + 周限两段 —— 拿 Fable 周限 87% 把跑
 * Opus 的会话染红,用户看到的是「剩余 91% / 56% 却是红的」,颜色与数字自相矛盾且无处
 * 解释(chip 上没有那个窗口)。真限流时 rejected 会立刻到,不需要它兜底;「接近限额」
 * 提示仍留在 tooltip —— 那里紧邻全量窗口列表,有上下文。
 *
 * 也没有走 `representativeClaim`(「只在 claim 指向 chip 上的窗口时才认 allowed_warning」):
 * 2026-07-25 实测快照里 claim=`five_hour`,而当时真正吃紧的是 Fable 周限(87%,
 * severity=warning),5h 只用了 10% —— 这个字段并不指向触发 warning 的窗口,以它为条件
 * 会原样退回误红。headers 源缺 severity 的预警缺口改由 WINDOW_ALERT_UTILIZATION_PERCENT
 * 的剩余水位兜住,判据始终是 chip 上看得见的那个数字。
 */
export function isClaudeSubscriptionAlerting(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId: string | null | undefined,
): boolean {
  if (!snapshot) return false;
  if (snapshot.rateLimitStatus?.trim().toLowerCase() === 'rejected') return true;
  return hasAlertingClaudeSessionWindow(snapshot, modelId);
}
