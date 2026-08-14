// 5-field cron parser + IANA-timezone-aware nextRun + cronToHuman.
// Zero npm dependencies (uses Intl.DateTimeFormat for tz wall-clock conversion).
//
// Field order: minute hour dayOfMonth month dayOfWeek
// Supports: '*', 'N', 'N-M', 'N-M/S', '*/S', 'N,M,O' (combination), dayOfWeek 7=Sun.
// Vixie-cron day matching: when both DOM and DOW are restricted, OR; else only the restricted one.

export type CronField = readonly number[];

export interface ParsedCron {
  minute: CronField; // 0-59
  hour: CronField; // 0-23
  dayOfMonth: CronField; // 1-31
  month: CronField; // 1-12
  dayOfWeek: CronField; // 0-6 (Sun=0)
  domRestricted: boolean;
  dowRestricted: boolean;
  expr: string;
}

interface FieldRange {
  min: number;
  max: number;
}

const RANGES: Record<keyof Pick<ParsedCron, 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek'>, FieldRange> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
};

export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression (need 5 fields): ${expr}`);
  }
  const [mi, h, dom, mo, dow] = parts;
  const dowField = parseField(dow, RANGES.dayOfWeek, /* allowDowSeven */ true);
  return {
    minute: parseField(mi, RANGES.minute),
    hour: parseField(h, RANGES.hour),
    dayOfMonth: parseField(dom, RANGES.dayOfMonth),
    month: parseField(mo, RANGES.month),
    dayOfWeek: dowField,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
    expr: trimmed,
  };
}

function parseField(token: string, range: FieldRange, allowDowSeven = false): number[] {
  const out = new Set<number>();
  const effectiveMax = allowDowSeven ? 7 : range.max;
  for (const part of token.split(',')) {
    if (part.length === 0) {
      throw new Error(`Empty cron field segment in "${token}"`);
    }
    const stepSegments = part.split('/');
    if (stepSegments.length > 2) {
      throw new Error(`Invalid step syntax in "${part}"`);
    }
    const [rangePart, stepPart] = stepSegments;
    let step = 1;
    if (stepPart !== undefined) {
      step = parseDecimalInteger(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid step "${stepPart}" in "${part}"`);
      }
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = range.min;
      hi = range.max;
    } else if (rangePart.includes('-')) {
      const rangeSegments = rangePart.split('-');
      if (rangeSegments.length !== 2) {
        throw new Error(`Invalid range "${rangePart}" in "${part}"`);
      }
      const [aStr, bStr] = rangeSegments;
      lo = parseDecimalInteger(aStr);
      hi = parseDecimalInteger(bStr);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
        throw new Error(`Invalid range "${rangePart}" in "${part}"`);
      }
    } else {
      const v = parseDecimalInteger(rangePart);
      if (!Number.isInteger(v)) {
        throw new Error(`Invalid value "${rangePart}" in "${part}"`);
      }
      lo = v;
      // "N/S" expands as "N,N+S,N+2S,...,max"
      hi = stepPart !== undefined ? effectiveMax : v;
    }
    if (lo < range.min || hi > effectiveMax) {
      throw new Error(`Field "${part}" out of range [${range.min}, ${effectiveMax}]`);
    }
    for (let v = lo; v <= hi; v += step) {
      const normalized = allowDowSeven && v === 7 ? 0 : v;
      out.add(normalized);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function parseDecimalInteger(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

// ---------- timezone helpers ----------

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTER_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
      hour12: false,
    });
    FORMATTER_CACHE.set(tz, f);
  }
  return f;
}

export interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  dow: number;
}

const DOW_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Exported so siblings (monthlyClamp) can build wall-clock-aware logic without
// duplicating the Intl.DateTimeFormat plumbing. Not part of the public package API.
export function wallClock(epochMs: number, tz: string): WallClock {
  const parts = getFormatter(tz).formatToParts(epochMs);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }
  let h = parseInt(map.hour, 10);
  if (h === 24) h = 0; // some impls return "24" for midnight
  return {
    y: parseInt(map.year, 10),
    mo: parseInt(map.month, 10),
    d: parseInt(map.day, 10),
    h,
    mi: parseInt(map.minute, 10),
    s: parseInt(map.second, 10),
    dow: DOW_MAP[map.weekday] ?? 0,
  };
}

// ms-offset between wall-clock-as-UTC and the actual epoch (positive = tz ahead of UTC)
function tzOffsetMs(epochMs: number, tz: string): number {
  const w = wallClock(epochMs, tz);
  const wallAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const epochSec = Math.floor(epochMs / 1000) * 1000;
  return wallAsUtc - epochSec;
}

// Convert wall-clock (y,mo,d,h,mi) in tz back to epoch ms. Handles DST edges by re-checking offset.
// Exported for sibling use (see wallClock comment above).
export function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMs(guess, tz);
  const candidate = guess - off1;
  const off2 = tzOffsetMs(candidate, tz);
  if (off2 === off1) return candidate;
  return guess - off2;
}

// ---------- nextRun ----------

const MAX_ITERATIONS = 366 * 24 * 60; // safety cap; smart walk converges much faster

export function nextRun(expr: string, fromMs: number, tz: string): number {
  const cron = parseCron(expr);
  // Snap to next minute boundary (cron resolution is 1 min)
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  let cur = startMs;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const w = wallClock(cur, tz);

    if (!cron.month.includes(w.mo)) {
      const next = nextOrWrap(cron.month, w.mo);
      const wrapsYear = next <= w.mo;
      cur = fromWallClock(wrapsYear ? w.y + 1 : w.y, next, 1, 0, 0, tz);
      continue;
    }

    if (!matchesDay(cron, w)) {
      // Advance to start-of-next-day in tz
      const sod = fromWallClock(w.y, w.mo, w.d, 0, 0, tz);
      const nextDay = sod + 26 * 3600 * 1000; // +26h ensures we cross any DST gap
      const w2 = wallClock(nextDay, tz);
      cur = fromWallClock(w2.y, w2.mo, w2.d, 0, 0, tz);
      continue;
    }

    if (!cron.hour.includes(w.h)) {
      const next = nextOrWrap(cron.hour, w.h);
      if (next > w.h) {
        cur = fromWallClock(w.y, w.mo, w.d, next, 0, tz);
      } else {
        // wrap into next day
        const sod = fromWallClock(w.y, w.mo, w.d, 0, 0, tz);
        const nextDay = sod + 26 * 3600 * 1000;
        const w2 = wallClock(nextDay, tz);
        cur = fromWallClock(w2.y, w2.mo, w2.d, next, 0, tz);
      }
      continue;
    }

    if (!cron.minute.includes(w.mi)) {
      const next = nextOrWrap(cron.minute, w.mi);
      if (next > w.mi) {
        cur = fromWallClock(w.y, w.mo, w.d, w.h, next, tz);
      } else {
        // wrap into next hour. +1h on UTC then re-derive wall components handles DST jumps:
        // spring-forward jumps the wall hour past the missing slot; fall-back may land us
        // back in the same wall hour, which the outer loop will then advance again.
        const soh = fromWallClock(w.y, w.mo, w.d, w.h, 0, tz) + 3600_000;
        const w2 = wallClock(soh, tz);
        cur = fromWallClock(w2.y, w2.mo, w2.d, w2.h, next, tz);
      }
      continue;
    }

    return cur;
  }
  throw new Error(`Could not find next run within iteration limit for "${expr}"`);
}

function matchesDay(cron: ParsedCron, w: WallClock): boolean {
  const domMatch = cron.dayOfMonth.includes(w.d);
  const dowMatch = cron.dayOfWeek.includes(w.dow);
  if (cron.domRestricted && cron.dowRestricted) return domMatch || dowMatch;
  if (cron.domRestricted) return domMatch;
  if (cron.dowRestricted) return dowMatch;
  return true;
}

function nextOrWrap(list: CronField, current: number): number {
  for (const x of list) if (x > current) return x;
  return list[0];
}

// ---------- cronToHuman ----------
//
// English-only by design. Phase 6 (renderer UI) wraps this with an i18n layer
// (`apps/desktop/src/renderer/features/scheduler/lib/cronToHuman.ts`) that key-maps
// these strings to localized output. Do not add locale switches here — keep this
// pure and stable so the engine remains zero-dep.

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function cronToHuman(expr: string): string {
  let cron: ParsedCron;
  try {
    cron = parseCron(expr);
  } catch {
    return expr;
  }
  const trimmed = expr.trim();

  // Common patterns
  switch (trimmed) {
    case '* * * * *':
      return 'Every minute';
    case '*/5 * * * *':
      return 'Every 5 minutes';
    case '*/10 * * * *':
      return 'Every 10 minutes';
    case '*/15 * * * *':
      return 'Every 15 minutes';
    case '*/30 * * * *':
      return 'Every 30 minutes';
    case '0 * * * *':
      return 'Every hour';
  }

  const parts: string[] = [];
  const minStar = cron.minute.length === 60;
  const hourStar = cron.hour.length === 24;

  if (cron.minute.length === 1 && cron.hour.length === 1) {
    parts.push(`At ${pad2(cron.hour[0])}:${pad2(cron.minute[0])}`);
  } else if (!minStar || !hourStar) {
    if (cron.minute.length === 1) {
      parts.push(`At minute ${cron.minute[0]} of hour ${formatList(cron.hour)}`);
    } else {
      parts.push(`At minute ${formatList(cron.minute)} of hour ${formatList(cron.hour)}`);
    }
  }

  if (cron.dowRestricted) {
    parts.push(`on ${cron.dayOfWeek.map((d) => DOW_NAMES[d]).join(',')}`);
  }
  if (cron.domRestricted) {
    parts.push(`on day-of-month ${formatList(cron.dayOfMonth)}`);
  }
  if (cron.month.length !== 12) {
    parts.push(`in ${cron.month.map((m) => MONTH_NAMES[m - 1]).join(',')}`);
  }

  return parts.length === 0 ? 'Every minute' : parts.join(' ');
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatList(list: CronField): string {
  if (list.length <= 4) return list.join(',');
  return `${list[0]},...,${list[list.length - 1]}`;
}
