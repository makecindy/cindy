/**
 * Usage-limit detection shared by the renderer banner and the main-process
 * usage-limit auto-resume.
 *
 * The terminal error event is the most precise signal available: Claude normally
 * supplies sdkError='rate_limit', while Codex may only supply an HTTP status /
 * codexErrorInfo / human-readable message. Keep this deliberately conservative
 * because a reset time here schedules an automatic continuation.
 */

export interface UsageLimitRecoveryHint {
  resetAtMs: number | null;
  /** True only when upstream explicitly identifies account-cycle exhaustion, not a generic 429. */
  isAccountUsageLimit?: boolean;
  /** Upstream subscription plan when the provider exposes it (for example `business`). */
  planType?: string;
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
const EXPLICIT_ACCOUNT_USAGE_LIMIT_PATTERN = /\busage_limit_reached\b|\busageLimitExceeded\b/;

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

function parseTextResetAt(
  text: string,
  nowMs: number,
  opts?: UsageLimitRecoveryParseOptions,
): number | null {
  const isoMatches = text.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g,
  );
  for (const value of isoMatches ?? []) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > nowMs) return parsed;
  }

  const labeledEpoch = text.match(/(?:reset(?:s|_at|At)?|retry[_\s-]*after)\D{0,12}(\d{10,13})\b/i);
  if (labeledEpoch) {
    const parsed = normalizeAbsoluteTimestamp(labeledEpoch[1], nowMs);
    if (parsed !== null) return parsed;
  }

  return parseRelativeResetAt(text, nowMs) ?? parseTimeOfDayResetAt(text, nowMs, opts);
}

/**
 * Returns a hint only for a restorable account usage/rate limit. Billing
 * depletion and temporary upstream overload are intentionally excluded.
 */
const BILLING_DEPLETION_PATTERN =
  /\b(?:insufficient_quota|billing_error|credit(?:s| balance)?\s+(?:depleted|exhausted|too low))\b/i;

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
    /\b(?:at capacity|overloaded_error)\b/i.test(text)
  ) {
    return null;
  }

  const isAccountUsageLimit = EXPLICIT_ACCOUNT_USAGE_LIMIT_PATTERN.test(text);
  const isUsageLimit =
    sdkError === 'rate_limit' ||
    codexErrorInfo === 'usageLimitExceeded' ||
    isAccountUsageLimit ||
    root.usageLimit === true ||
    status === 429 ||
    /\b(?:rate.?limit|usage.?limit|too\s+many\s+requests|quota\s+(?:exceeded|exhausted)|you(?:'|’)ve\s+hit\s+your\s+(?:(?:session|weekly)\s+)?limit)\b/i.test(
      text,
    );
  if (!isUsageLimit) return null;

  const planType = parsePlanType(records, text);
  return {
    resetAtMs: parseStructuredResetAt(records, nowMs) ?? parseTextResetAt(text, nowMs, opts),
    ...(isAccountUsageLimit ? { isAccountUsageLimit: true } : {}),
    ...(planType ? { planType } : {}),
  };
}
