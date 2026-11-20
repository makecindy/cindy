/**
 * Usage-limit detection shared by the renderer banner and the main-process
 * usage-limit auto-resume.
 *
 * The terminal error event is the most precise signal available: Claude normally
 * supplies sdkError='rate_limit', while Codex may only supply an HTTP status /
 * codexErrorInfo / human-readable message. Keep this deliberately conservative
 * because a reset time here schedules an automatic continuation.
 */

/**
 * 重置时刻来自哪条解析分支。
 *
 * 入口层要靠它区分「本来就只对订阅账号生效」的分支与「裸本地时刻」这条：
 * 后者是智谱 GLM Coding Plan 的唯一例外(周期额度,不是分钟级速率限制)。
 */
export type UsageLimitResetSource =
  /** 结构化字段(usageResetAt / reset_at / retry_after)。 */
  | 'structured'
  /** 带时区的 ISO 8601 时刻。 */
  | 'iso'
  /** 报错原文里的 epoch 毫秒。 */
  | 'epoch'
  /** 不带时区的「日期 + 时刻」,按本机时区理解。 */
  | 'local-wall-clock'
  /** 相对时长(Try again in ~12 min)。 */
  | 'relative'
  /** 只给钟点(resets 2:30am)。 */
  | 'time-of-day'
  /** 来源不明。 */
  | 'unknown';

export interface UsageLimitRecoveryHint {
  resetAtMs: number | null;
  /** True only when upstream explicitly identifies account-cycle exhaustion, not a generic 429. */
  isAccountUsageLimit?: boolean;
  /** Upstream subscription plan when the provider exposes it (for example `business`). */
  planType?: string;
  /** 时刻来源分支;resetAtMs 为 null 时没有。 */
  resetAtSource?: UsageLimitResetSource;
}

type UnknownRecord = Record<string, unknown>;

const ABSOLUTE_RESET_KEYS = new Set([
  'resetat',
  'resetatms',
  'reset_at',
  'resetsat',
  'resets_at',
  'usageresetat',
  'usageresetatms',
  'usage_reset_at',
]);

const RETRY_AFTER_MS_KEYS = new Set(['retryafterms', 'retry_after_ms']);
const RETRY_AFTER_SECONDS_KEYS = new Set([
  'retryafter',
  'retryafterseconds',
  'retry_after',
  'retry_after_seconds',
]);
const PLAN_TYPE_KEYS = new Set(['plantype', 'plan_type']);
const EXPLICIT_ACCOUNT_USAGE_LIMIT_PATTERN = /\busage_limit_reached\b|\busageLimitExceeded\b|\[SUBSCRIPTION_ACCOUNT_LIMITED\]/;

/** Claude may expose only its human-readable limit message, without SDK tags. */
export function isClaudeUsageLimitMessage(message: string): boolean {
  return /\byou(?:'|’)ve\s+hit\s+your\s+(?:(?:session|weekly|5[- ]hour)\s+)?limit\b/i.test(message);
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function collectRecords(root: UnknownRecord): UnknownRecord[] {
  const records: UnknownRecord[] = [];
  const queue: Array<{ record: UnknownRecord; depth: number }> = [{ record: root, depth: 0 }];
  const seen = new Set<UnknownRecord>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.record)) continue;
    seen.add(current.record);
    records.push(current.record);
    if (current.depth >= 2) continue;
    for (const value of Object.values(current.record)) {
      const nested = asRecord(value);
      if (nested) queue.push({ record: nested, depth: current.depth + 1 });
    }
  }
  return records;
}

function collectText(records: readonly UnknownRecord[]): string {
  const parts: string[] = [];
  for (const record of records) {
    for (const value of Object.values(record)) {
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.join('\n');
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeAbsoluteTimestamp(value: unknown, nowMs: number): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    // Epoch seconds are currently around 1e9; epoch milliseconds around 1e12.
    const timestamp = numeric >= 100_000_000_000 ? numeric : numeric * 1000;
    return timestamp > nowMs ? timestamp : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : null;
}

function parseStructuredResetAt(records: readonly UnknownRecord[], nowMs: number): number | null {
  for (const record of records) {
    for (const [rawKey, value] of Object.entries(record)) {
      const key = rawKey.toLowerCase();
      if (ABSOLUTE_RESET_KEYS.has(key)) {
        const parsed = normalizeAbsoluteTimestamp(value, nowMs);
        if (parsed !== null) return parsed;
      }
      if (RETRY_AFTER_MS_KEYS.has(key)) {
        const delay = finiteNumber(value);
        if (delay !== null && delay > 0) return nowMs + delay;
      }
      if (RETRY_AFTER_SECONDS_KEYS.has(key)) {
        const delay = finiteNumber(value);
        if (delay !== null && delay > 0) return nowMs + delay * 1000;
      }
    }
  }
  return null;
}

function normalizePlanType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.length <= 64 ? normalized : null;
}

function parsePlanType(records: readonly UnknownRecord[], text: string): string | null {
  for (const record of records) {
    for (const [rawKey, value] of Object.entries(record)) {
      if (!PLAN_TYPE_KEYS.has(rawKey.toLowerCase())) continue;
      const normalized = normalizePlanType(value);
      if (normalized) return normalized;
    }
  }

  const textMatch = text.match(/["']?plan[_-]?type["']?\s*[:=]\s*["']?([a-z0-9_-]+)["']?/i);
  return normalizePlanType(textMatch?.[1]);
}

function parseRelativeResetAt(text: string, nowMs: number): number | null {
  // `~` / `about`: Pi rewrites ChatGPT's resets_at into "Try again in ~N min".
  const relative = text.match(
    /(?:resets?|retry(?:\s+after)?|try\s+again)\s+(?:in\s+)?(?:~\s*|about\s+)?(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/i,
  );
  if (!relative) return null;
  const days = Number(relative[1] ?? 0);
  const hours = Number(relative[2] ?? 0);
  const minutes = Number(relative[3] ?? 0);
  const seconds = Number(relative[4] ?? 0);
  const delayMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return delayMs > 0 ? nowMs + delayMs : null;
}

function partsInTimeZone(timestamp: number, timeZone: string): Record<string, number> | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    const parts: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(timestamp))) {
      if (
        part.type !== 'year' &&
        part.type !== 'month' &&
        part.type !== 'day' &&
        part.type !== 'hour' &&
        part.type !== 'minute' &&
        part.type !== 'second'
      ) {
        continue;
      }
      const value = Number(part.value);
      if (!Number.isFinite(value)) continue;
      // Keep parity with maker-scheduler's wallClock(): some Intl
      // implementations report midnight as 24 even with hourCycle=h23.
      parts[part.type] = part.type === 'hour' && value === 24 ? 0 : value;
    }
    return parts;
  } catch {
    return null;
  }
}

function zonedDateTimeToMs(
  input: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number | null {
  const targetAsUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const actual = partsInTimeZone(guess, timeZone);
    if (!actual) return null;
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    guess += targetAsUtc - actualAsUtc;
  }
  const verified = partsInTimeZone(guess, timeZone);
  if (
    !verified ||
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }
  return guess;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface UsageLimitRecoveryParseOptions {
  /**
   * 不带时区的绝对钟点(Codex `try again at 3:05 PM`)是否可按本机时区理解。SSH 远程会话的
   * 报错用的是远端主机的本地时间,传 false 时这类钟点不解析;相对时长与带时区的时刻不受影响。
   */
  localTimeZoneTrusted?: boolean;
}

function parseTimeOfDayResetAt(
  text: string,
  nowMs: number,
  opts?: UsageLimitRecoveryParseOptions,
): number | null {
  // Claude: "resets 1:20am (Pacific/Auckland)".
  // Codex: "try again at 3:05 PM." / "try again at Oct 8, 2026 3:05 PM." (local time).
  const match = text.match(
    /\b(?:resets?(?:\s+at)?|try\s+again\s+at)\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i,
  );
  if (!match) return null;
  let hour = Number(match[4]);
  const minute = Number(match[5] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = match[6].toLowerCase();
  if (hour === 12) hour = 0;
  if (meridiem === 'pm') hour += 12;
  const explicitTimeZone = match[7]?.trim();
  if (!explicitTimeZone && opts?.localTimeZoneTrusted === false) return null;
  const timeZone =
    explicitTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  if (match[1]) {
    const month = MONTH_INDEX[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!month || day < 1 || day > 31) return null;
    const candidate = zonedDateTimeToMs({ year, month, day, hour, minute }, timeZone);
    return candidate !== null && candidate > nowMs ? candidate : null;
  }

  const current = partsInTimeZone(nowMs, timeZone);
  if (!current) return null;

  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset));
    const candidate = zonedDateTimeToMs(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour,
        minute,
      },
      timeZone,
    );
    if (candidate !== null && candidate > nowMs) return candidate;
  }
  return null;
}

/**
 * 部分供应商在额度文案里给出「日期 + 时刻」但不带时区,例如 GLM(智谱)1308:
 *   「已达到 5 小时的使用上限。您的限额将在 2026-11-06 18:54:03 重置。」
 * 这类时间按本机时区理解,与 parseTimeOfDayResetAt 用同一套 localTimeZoneTrusted
 * 保护:SSH 远程会话时报错来自远端主机,此时不解析不带时区的时刻。
 */
const LOCAL_WALL_CLOCK_PATTERNS: readonly RegExp[] = [
  /(?:限额|额度|配额|用量)(?:将)?(?:于|在)\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*重置/,
  /\bresets?(?:\s+at)?\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/i,
];

/** 时刻之后紧跟时区标记(Z / ±HH:MM / 大写字母时区)说明它不是不带时区的本地时刻。 */
const TIMEZONE_SUFFIX_PATTERN = /^\s*(?:[Zz]|[+-]\d{2}:?\d{2}|[A-Z]{2,5}\b)/;

function parseLocalWallClockResetAt(
  text: string,
  nowMs: number,
  opts?: UsageLimitRecoveryParseOptions,
): number | null {
  if (opts?.localTimeZoneTrusted === false) return null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  for (const pattern of LOCAL_WALL_CLOCK_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rest = text.slice(match.index + match[0].length);
    // 带时区的时间交给上面的 ISO / 数字偏移分支,这里只处理裸本地时刻。
    if (TIMEZONE_SUFFIX_PATTERN.test(rest)) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] ? Number(match[6]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (hour > 23 || minute > 59 || second > 59) continue;

    const candidate = zonedDateTimeToMs({ year, month, day, hour, minute }, timeZone);
    if (candidate === null) continue;
    const withSeconds = candidate + second * 1000;
    if (withSeconds > nowMs) return withSeconds;
  }
  return null;
}

function parseTextResetAt(
  text: string,
  nowMs: number,
  opts?: UsageLimitRecoveryParseOptions,
): { at: number; source: UsageLimitResetSource } | null {
  const isoMatches = text.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g,
  );
  for (const value of isoMatches ?? []) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > nowMs) return { at: parsed, source: 'iso' };
  }

  const labeledEpoch = text.match(/(?:reset(?:s|_at|At)?|retry[_\s-]*after)\D{0,12}(\d{10,13})\b/i);
  if (labeledEpoch) {
    const parsed = normalizeAbsoluteTimestamp(labeledEpoch[1], nowMs);
    if (parsed !== null) return { at: parsed, source: 'epoch' };
  }

  const wallClock = parseLocalWallClockResetAt(text, nowMs, opts);
  if (wallClock !== null) return { at: wallClock, source: 'local-wall-clock' };

  const relative = parseRelativeResetAt(text, nowMs);
  if (relative !== null) return { at: relative, source: 'relative' };

  const timeOfDay = parseTimeOfDayResetAt(text, nowMs, opts);
  if (timeOfDay !== null) return { at: timeOfDay, source: 'time-of-day' };

  return null;
}

/**
 * Returns a hint only for a restorable account usage/rate limit. Billing
 * depletion and temporary upstream overload are intentionally excluded.
 */
const BILLING_DEPLETION_PATTERN =
  /\b(?:insufficient_quota|billing_error|credit(?:s| balance)?\s+(?:depleted|exhausted|too low)|you have run out of credits or need a Grok subscription)\b/i;

/**
 * 余额 / 计费耗尽（要充值，不会到点恢复）。即使文案里也出现 quota / limit，也不是周期额度上限，
 * 所有「等额度重置」的判定都必须先排除它。
 */
export function isBillingDepletionError(data: unknown): boolean {
  const root = asRecord(data);
  if (!root) return false;
  if (root.sdkError === 'billing_error') return true;
  return BILLING_DEPLETION_PATTERN.test(collectText(collectRecords(root)));
}

/**
 * 智谱 GLM Coding Plan 的周期额度措辞：5 小时 / 每周窗口用尽。
 *
 * 只认「周期窗口 + 额度上限」的组合措辞。分钟级速率限制(「请求过于频繁」「每分钟 N 次」)
 * 不命中——那类报错既不写明周期窗口，也不给出周期重置时刻。
 */
const GLM_CYCLE_QUOTA_PATTERN =
  /(?:\d+\s*小时|五\s*小时)\s*(?:的)?\s*(?:使用|积分)?\s*(?:上限|限额|额度|配额)|(?:每周|每\s*周|周)\s*(?:的)?\s*(?:使用|积分)?\s*(?:上限|限额|额度|配额)/;

/**
 * 报错原文是否表明「周期额度已用尽」（智谱 GLM Coding Plan 的 5 小时 / 每周窗口）。
 *
 * 与「普通 429」的区别：普通 429 只是速率限制，文案里没有周期窗口的说法，
 * 也不会给出周期重置时刻——不能把它当成周期额度。
 */
export function isGlmCycleQuotaExhausted(data: unknown): boolean {
  const root = asRecord(data);
  if (!root) return false;
  return GLM_CYCLE_QUOTA_PATTERN.test(collectText(collectRecords(root)));
}

export function extractUsageLimitRecoveryHint(
  data: unknown,
  nowMs = Date.now(),
  opts?: UsageLimitRecoveryParseOptions,
): UsageLimitRecoveryHint | null {
  const root = asRecord(data);
  if (!root) return null;
  const records = collectRecords(root);
  const text = collectText(records);

  const sdkError = typeof root.sdkError === 'string' ? root.sdkError : '';
  const codexErrorInfo = typeof root.codexErrorInfo === 'string' ? root.codexErrorInfo : '';
  const status = finiteNumber(root.errorStatus ?? root.status);

  if (
    isBillingDepletionError(root) ||
    codexErrorInfo === 'serverOverloaded' ||
    status === 529 ||
    /\b(?:at capacity|overloaded_error|currently overloaded)\b/i.test(text)
  ) {
    return null;
  }

  const isAccountUsageLimit = EXPLICIT_ACCOUNT_USAGE_LIMIT_PATTERN.test(text);
  // 智谱 GLM Coding Plan 的周期额度文案本身就说清了「窗口用尽」,不依赖上游有没有
  // 带上 429 之类的结构化标记(Claude Code bridge 常常不带)。
  const isGlmCycleQuota = isGlmCycleQuotaExhausted(root);
  const isUsageLimit =
    sdkError === 'rate_limit' ||
    codexErrorInfo === 'usageLimitExceeded' ||
    isAccountUsageLimit ||
    isGlmCycleQuota ||
    root.usageLimit === true ||
    status === 429 ||
    isClaudeUsageLimitMessage(text) ||
    /\b(?:rate.?limit|usage.?limit|too\s+many\s+requests|quota\s+(?:exceeded|exhausted))\b/i.test(
      text,
    );
  if (!isUsageLimit) return null;

  const planType = parsePlanType(records, text);
  const structured = parseStructuredResetAt(records, nowMs);
  const parsed = structured !== null
    ? { at: structured, source: 'structured' as const }
    : parseTextResetAt(text, nowMs, opts);
  return {
    resetAtMs: parsed?.at ?? null,
    ...(parsed ? { resetAtSource: parsed.source } : {}),
    ...(isAccountUsageLimit ? { isAccountUsageLimit: true } : {}),
    ...(planType ? { planType } : {}),
  };
}
