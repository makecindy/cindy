/**
 * Renderer-side usage-limit detection.
 *
 * The live maker event is the most precise signal available to the chat UI:
 * Claude normally supplies sdkError='rate_limit', while Codex may only supply
 * an HTTP status / codexErrorInfo / human-readable message. Keep this
 * deliberately conservative because this result exposes an Automation action.
 */

export interface UsageLimitRecoveryHint {
  resetAtMs: number | null;
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

function parseRelativeResetAt(text: string, nowMs: number): number | null {
  const relative = text.match(
    /(?:resets?|retry(?:\s+after)?|try\s+again)\s+(?:in\s+)?(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/i,
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

function parseTimeOfDayResetAt(text: string, nowMs: number): number | null {
  const match = text.match(
    /\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i,
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = match[3].toLowerCase();
  if (hour === 12) hour = 0;
  if (meridiem === 'pm') hour += 12;
  const fallbackTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const timeZone = match[4]?.trim() || fallbackTimeZone;
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

function parseTextResetAt(text: string, nowMs: number): number | null {
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

  return parseRelativeResetAt(text, nowMs) ?? parseTimeOfDayResetAt(text, nowMs);
}

/**
 * Returns a hint only for a restorable account usage/rate limit. Billing
 * depletion and temporary upstream overload are intentionally excluded.
 */
export function extractUsageLimitRecoveryHint(
  data: unknown,
  nowMs = Date.now(),
): UsageLimitRecoveryHint | null {
  const root = asRecord(data);
  if (!root) return null;
  const records = collectRecords(root);
  const text = collectText(records);

  const sdkError = typeof root.sdkError === 'string' ? root.sdkError : '';
  const codexErrorInfo = typeof root.codexErrorInfo === 'string' ? root.codexErrorInfo : '';
  const status = finiteNumber(root.errorStatus ?? root.status);

  if (
    sdkError === 'billing_error' ||
    codexErrorInfo === 'serverOverloaded' ||
    status === 529 ||
    /\b(?:insufficient_quota|billing_error|credit(?:s| balance)?\s+(?:depleted|exhausted|too low)|at capacity|overloaded_error)\b/i.test(
      text,
    )
  ) {
    return null;
  }

  const isUsageLimit =
    sdkError === 'rate_limit' ||
    codexErrorInfo === 'usageLimitExceeded' ||
    root.usageLimit === true ||
    status === 429 ||
    /\b(?:rate.?limit|usage.?limit|too\s+many\s+requests|quota\s+(?:exceeded|exhausted)|you(?:'|’)ve\s+hit\s+your\s+(?:(?:session|weekly)\s+)?limit)\b/i.test(
      text,
    );
  if (!isUsageLimit) return null;

  return {
    resetAtMs: parseStructuredResetAt(records, nowMs) ?? parseTextResetAt(text, nowMs),
  };
}
