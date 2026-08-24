import type { TFunction } from 'i18next';

/**
 * cronCodexPreset — codex 8 种 schedule mode ↔ 5-field cron 双向转换
 * ---------------------------------------------------------------------------
 * codex 用 RRULE，我们底层继续 cron（避免动 Phase 1 引擎）。GUI 层呈现
 * codex 的 8 种预设，转回 cron string 存 DB。
 *
 * 8 种 mode（codex i18n source: settings.automations.scheduleMode.*）:
 *   - minute   每分钟
 *   - hourly   每小时
 *   - daily    每天 HH:MM
 *   - weekly   每周 <weekday> HH:MM
 *   - weekdays 工作日 HH:MM
 *   - weekends 周末 HH:MM
 *   - interval 每 N 小时（在第 0 分触发）
 *   - custom   自由 cron string
 *
 * 解析（cron→mode）尽力而为：复杂表达式归 'custom'。表单回显时若非简单形态
 * 直接回 custom + 原 cron string，让用户看完整字符串。
 */

export type CodexScheduleMode =
  | 'minute'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'weekdays'
  | 'weekends'
  | 'monthly'
  | 'interval'
  | 'intervalMinutes'
  | 'custom';

export interface CodexScheduleConfig {
  mode: CodexScheduleMode;
  /** HH (0-23)，daily / weekly / weekdays / weekends 用 */
  hour: number;
  /** MM (0-59)，daily / weekly / weekdays / weekends 用 */
  minute: number;
  /** weekday (0=Sun..6=Sat)，weekly 用 */
  weekday: number;
  /** month day (1-31)，monthly 用 */
  monthDay: number;
  /** 间隔小时数（>=1）。interval 用 */
  intervalHours: number;
  /** 间隔分钟数（1-59）。intervalMinutes 用；N=1 等价于 cron `* * * * *` */
  intervalMinutes: number;
  /** 任意 cron 字符串。custom 用 */
  customCron: string;
}

export const SCHEDULE_MODE_LABELS: Record<CodexScheduleMode, string> = {
  minute: 'Every minute',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  weekdays: 'Weekdays',
  weekends: 'Weekends',
  monthly: 'Monthly',
  interval: 'Interval',
  intervalMinutes: 'Every N minutes',
  custom: 'Custom',
};

export const WEEKDAY_LABELS: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

export const DEFAULT_CONFIG: CodexScheduleConfig = {
  mode: 'daily',
  hour: 9,
  minute: 0,
  weekday: 1, // 周一
  monthDay: 1,
  intervalHours: 2,
  intervalMinutes: 5,
  customCron: '0 9 * * *',
};

const NUM = /^\d+$/;

/** 把 mode + 参数序列化为 5-field cron string。 */
export function configToCron(c: CodexScheduleConfig): string {
  switch (c.mode) {
    case 'minute':
      return '* * * * *';
    case 'hourly':
      return '0 * * * *';
    case 'daily':
      return `${c.minute} ${c.hour} * * *`;
    case 'weekly':
      return `${c.minute} ${c.hour} * * ${c.weekday}`;
    case 'weekdays':
      return `${c.minute} ${c.hour} * * 1-5`;
    case 'weekends':
      return `${c.minute} ${c.hour} * * 0,6`;
    case 'monthly':
      return `${c.minute} ${c.hour} ${c.monthDay} * *`;
    case 'interval':
      return `0 */${c.intervalHours} * * *`;
    case 'intervalMinutes':
      // N=1 等价于 `* * * * *`，cron parser 把 `*/1` 视作 `*`，二者语义相同。
      // 直接 emit `* * * * *` 让 cronToConfig 反向时落到 minute mode（兼容旧数据）。
      return c.intervalMinutes <= 1 ? '* * * * *' : `*/${c.intervalMinutes} * * * *`;
    case 'custom':
      return c.customCron.trim();
  }
}

/** 把 cron string 反向解析为 mode + 参数；不能精确还原走 custom 兜底。 */
export function cronToConfig(expr: string): CodexScheduleConfig {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { ...DEFAULT_CONFIG, mode: 'custom', customCron: trimmed };
  const [mm, hh, dom, mon, dow] = parts;

  // every minute → 用 intervalMinutes(1) 表示，让用户能看见"每 1 分钟"的语义而不是裸 cron
  if (trimmed === '* * * * *') {
    return { ...DEFAULT_CONFIG, mode: 'intervalMinutes', intervalMinutes: 1, customCron: trimmed };
  }
  // every hour at minute 0
  if (trimmed === '0 * * * *') {
    return { ...DEFAULT_CONFIG, mode: 'hourly', customCron: trimmed };
  }
  // every N minutes: */N * * * *  (N: 2-59)
  const intervalMinMatch = /^\*\/(\d+) \* \* \* \*$/.exec(trimmed);
  if (intervalMinMatch) {
    return {
      ...DEFAULT_CONFIG,
      mode: 'intervalMinutes',
      intervalMinutes: clampIntervalMinutes(Number(intervalMinMatch[1])),
      customCron: trimmed,
    };
  }

  const isDayWildcard = dom === '*' && mon === '*';
  // daily: M H * * *
  if (isDayWildcard && dow === '*' && NUM.test(mm) && NUM.test(hh)) {
    return {
      ...DEFAULT_CONFIG,
      mode: 'daily',
      hour: clampHour(Number(hh)),
      minute: clampMinute(Number(mm)),
      customCron: trimmed,
    };
  }
  // weekdays: M H * * 1-5
  if (isDayWildcard && dow === '1-5' && NUM.test(mm) && NUM.test(hh)) {
    return {
      ...DEFAULT_CONFIG,
      mode: 'weekdays',
      hour: clampHour(Number(hh)),
      minute: clampMinute(Number(mm)),
      customCron: trimmed,
    };
  }
  // weekends: M H * * 0,6
  if (isDayWildcard && (dow === '0,6' || dow === '6,0') && NUM.test(mm) && NUM.test(hh)) {
    return {
      ...DEFAULT_CONFIG,
      mode: 'weekends',
      hour: clampHour(Number(hh)),
      minute: clampMinute(Number(mm)),
      customCron: trimmed,
    };
  }
  // weekly: M H * * <0..6 single digit>
  if (isDayWildcard && /^[0-6]$/.test(dow) && NUM.test(mm) && NUM.test(hh)) {
    return {
      ...DEFAULT_CONFIG,
      mode: 'weekly',
      hour: clampHour(Number(hh)),
      minute: clampMinute(Number(mm)),
      weekday: Number(dow),
      customCron: trimmed,
    };
  }
  // monthly: M H <1..31> * *
  if (mon === '*' && dow === '*' && NUM.test(mm) && NUM.test(hh) && NUM.test(dom)) {
    return {
      ...DEFAULT_CONFIG,
      mode: 'monthly',
      hour: clampHour(Number(hh)),
      minute: clampMinute(Number(mm)),
      monthDay: clampMonthDay(Number(dom)),
      customCron: trimmed,
    };
  }
  // interval hours: 0 */N * * *
  const intervalMatch = /^0 \*\/(\d+) \* \* \*$/.exec(trimmed);
  if (intervalMatch) {
    return {
      ...DEFAULT_CONFIG,
      mode: 'interval',
      intervalHours: Math.max(1, Math.min(23, Number(intervalMatch[1]))),
      customCron: trimmed,
    };
  }

  return { ...DEFAULT_CONFIG, mode: 'custom', customCron: trimmed };
}

function clampHour(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(23, Math.floor(n)));
}

function clampMinute(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(59, Math.floor(n)));
}

function clampMonthDay(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(31, Math.floor(n)));
}

function clampIntervalMinutes(n: number): number {
  if (Number.isNaN(n)) return 5;
  return Math.max(1, Math.min(59, Math.floor(n)));
}

// 把 cron 表达式反推成 interval 毫秒——只识别 UI 的 4 个 interval-style preset：
//   - `* * * * *`             → 60_000（1 分钟）
//   - `*\/N * * * *` (N: 2-59) → N * 60_000
//   - `0 * * * *`             → 3_600_000（1 小时）
//   - `0 *\/N * * *` (N: 1-23) → N * 3_600_000
// 其它任何 cron（daily/weekly/custom）→ undefined，让该任务继续走 cron 槽位语义。
//
// 用途：用户显式切到相对间隔模式时，从当前 Cron preset 初始化 intervalMs。
export function cronExprToIntervalMs(expr: string): number | undefined {
  const trimmed = expr.trim();
  if (trimmed === '* * * * *') return 60_000;
  if (trimmed === '0 * * * *') return 60 * 60_000;
  const minMatch = /^\*\/(\d+) \* \* \* \*$/.exec(trimmed);
  if (minMatch) {
    const n = Number(minMatch[1]);
    if (n >= 2 && n <= 59) return n * 60_000;
    return undefined;
  }
  const hourMatch = /^0 \*\/(\d+) \* \* \*$/.exec(trimmed);
  if (hourMatch) {
    const n = Number(hourMatch[1]);
    if (n >= 1 && n <= 23) return n * 60 * 60_000;
    return undefined;
  }
  return undefined;
}

/**
 * 把当前 UI 可编辑的相对间隔转换成等价 Cron preset，供 interval 回显和显式切回
 * Cron 使用。返回 undefined 表示该间隔无法由现有“每 N 分钟/小时”控件精确表达。
 */
export function intervalMsToCronExpr(intervalMs: number): string | undefined {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;
  if (intervalMs % (60 * 60_000) === 0) {
    const hours = intervalMs / (60 * 60_000);
    if (hours >= 1 && hours <= 23) return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
  }
  if (intervalMs % 60_000 === 0) {
    const minutes = intervalMs / 60_000;
    if (minutes >= 1 && minutes <= 59) return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
  }
  return undefined;
}

export type ScheduleTimingPresentation =
  | { kind: 'cron'; displayCronExpr: string }
  | { kind: 'intervalPreset'; displayCronExpr: string }
  | { kind: 'intervalExact' };

/**
 * 决定时间编辑器如何呈现当前权威调度值。不可由现有预设精确表达的 interval
 * 必须进入独立 exact 状态，禁止伪造一个 5 分钟 Cron 配置参与显示或保存。
 */
export function resolveScheduleTimingPresentation(
  cronExpr: string,
  intervalMs: number | undefined,
): ScheduleTimingPresentation {
  if (intervalMs === undefined) return { kind: 'cron', displayCronExpr: cronExpr };
  const displayCronExpr = intervalMsToCronExpr(intervalMs);
  return displayCronExpr
    ? { kind: 'intervalPreset', displayCronExpr }
    : { kind: 'intervalExact' };
}

export const DEFAULT_SCHEDULE_INTERVAL_MS = 5 * 60_000;

/** Cron / 相对间隔显式切换的单一确定性入口。 */
export function switchScheduleTimingMode(
  cronExpr: string,
  intervalMs: number | undefined,
  nextMode: 'cron' | 'interval',
): { cronExpr: string; intervalMs?: number } {
  if (nextMode === 'interval') {
    const nextIntervalMs = cronExprToIntervalMs(cronExpr) ?? DEFAULT_SCHEDULE_INTERVAL_MS;
    return {
      cronExpr: intervalMsToCronExpr(nextIntervalMs) ?? '*/5 * * * *',
      intervalMs: nextIntervalMs,
    };
  }
  return {
    cronExpr: intervalMsToCronExpr(intervalMs ?? DEFAULT_SCHEDULE_INTERVAL_MS) ?? cronExpr,
    intervalMs: undefined,
  };
}

/** chip 文案：mode + 关键参数；"每天 09:00" / "工作日 09:00" / "每 2 小时" */
export function summarizeConfig(c: CodexScheduleConfig, translate?: TFunction): string {
  const time = `${pad(c.hour)}:${pad(c.minute)}`;
  const text = (key: string, fallback: string, values?: Record<string, string | number>) =>
    translate?.(key, { defaultValue: fallback, ...values }) ?? fallback;
  switch (c.mode) {
    case 'minute':
      return text('scheduler.chips.schedulePreview.everyMinute', 'Every minute');
    case 'hourly':
      return text('scheduler.presentation.summary.hourly', 'Hourly');
    case 'daily':
      return text('scheduler.presentation.summary.daily', `Daily at ${time}`, { time });
    case 'weekly':
      return text('scheduler.presentation.summary.weekly', `${WEEKDAY_LABELS[c.weekday]} at ${time}`, {
        weekday: text(`scheduler.presentation.weekday.full.${c.weekday}`, WEEKDAY_LABELS[c.weekday]),
        time,
      });
    case 'weekdays':
      return text('scheduler.presentation.summary.weekdays', `Weekdays at ${time}`, { time });
    case 'weekends':
      return text('scheduler.presentation.summary.weekends', `Weekends at ${time}`, { time });
    case 'monthly':
      return text('scheduler.presentation.summary.monthly', `Monthly on day ${c.monthDay} at ${time}`, {
        day: c.monthDay,
        time,
      });
    case 'interval':
      return text('scheduler.chips.schedulePreview.everyHours', `Every ${c.intervalHours} hours`, {
        count: c.intervalHours,
      });
    case 'intervalMinutes':
      return c.intervalMinutes === 1
        ? text('scheduler.chips.schedulePreview.everyMinute', 'Every minute')
        : text('scheduler.chips.schedulePreview.everyMinutes', `Every ${c.intervalMinutes} minutes`, {
            count: c.intervalMinutes,
          });
    case 'custom':
      return c.customCron || text('scheduler.presentation.summary.custom', 'Custom');
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
