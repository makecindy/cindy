/**
 * scheduler/lib/formatters — 时间显示 + 路径精简 + agent 显示名
 * ---------------------------------------------------------------------------
 * 设计稿要求的相对时间表达：
 *   - 任务列表副标题：'Last 2h ago' / 'Last 2025-04-12'
 *   - Run card 时间戳：'Today, 09:00:12' / 'Yesterday, 09:00:08' / '2 days ago, ...' / 'YYYY-MM-DD HH:mm:ss'
 *
 * 全部走纯函数 + 用户本地时区（与 toLocaleString 一致）。
 * `now` 参数显式传入，便于单元测试时注入固定值，不依赖 Date.now()。
 */

import type { AgentKind } from '@cindy/maker-scheduler';
import type { TFunction } from 'i18next';

import { stripTrailingPathSeparators } from '../../../../shared/pathText';

const MS_MIN = 60_000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

/** 24h HH:mm:ss，用户本地时区。 */
function hms(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

/** 24h HH:mm，用户本地时区。 */
function hm(d: Date): string {
  return d.toTimeString().slice(0, 5);
}

/** 'YYYY-MM-DD'，用户本地时区。 */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

/** 'MM-DD'，用户本地时区。 */
function md(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${m}-${da}`;
}

/** 同一本地日历日的零点；用来按"日"切而不是按"24h 间隔"切。 */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * 任务列表 cell 副标题：绝对时间，按本地日历日切（不显示秒）。
 *   - 从未执行     → null（cell 不渲染副标题）
 *   - 当天         → "Last 14:23"
 *   - 跨天同年     → "Last 04-30 14:23"
 *   - 跨年         → "Last 2025-04-12 14:23"
 */
export function formatLastRun(
  lastFiredAt?: number,
  now: number = Date.now(),
  translate?: TFunction,
): string | null {
  if (!lastFiredAt) return null;
  const fired = new Date(lastFiredAt);
  const today = startOfLocalDay(new Date(now));
  const firedDay = startOfLocalDay(fired);
  const time = hm(fired);
  const value = firedDay.getTime() === today.getTime()
    ? time
    : fired.getFullYear() === new Date(now).getFullYear()
      ? `${md(fired)} ${time}`
      : `${ymd(fired)} ${time}`;
  return translate?.('scheduler.presentation.time.last', {
    defaultValue: `Last ${value}`,
    value,
  }) ?? `Last ${value}`;
}

/**
 * Run card 时间戳。按本地日历日切，避免凌晨边界把 26h 前显示成"昨天"的歧义。
 *   - 同一本地日 → 'Today, 09:00:12'
 *   - 昨天      → 'Yesterday, 09:00:08'
 *   - 7d 以内   → '3 days ago, 09:00:09'
 *   - 7d 以外   → '2025-04-12 09:00:11'
 */
export function formatRunTimestamp(
  firedAt: number,
  now: number = Date.now(),
  translate?: TFunction,
): string {
  const fired = new Date(firedAt);
  const today = startOfLocalDay(new Date(now));
  const firedDay = startOfLocalDay(fired);
  const diffDays = Math.round((today.getTime() - firedDay.getTime()) / MS_DAY);
  const time = hms(fired);
  // 用中点分隔，避免 'Today,' 小写 x-height 和 '09:25:47' 数字 cap-height
  // 在同一行被视觉对比时显得 "数字偏高"。中点把两段隔成并列块，眼睛不再比顶边。
  if (diffDays <= 0) {
    return translate?.('scheduler.presentation.time.today', {
      defaultValue: `Today · ${time}`,
      time,
    }) ?? `Today · ${time}`;
  }
  if (diffDays === 1) {
    return translate?.('scheduler.presentation.time.yesterday', {
      defaultValue: `Yesterday · ${time}`,
      time,
    }) ?? `Yesterday · ${time}`;
  }
  if (diffDays < 7) {
    return translate?.('scheduler.presentation.time.daysAgo', {
      defaultValue: `${diffDays} days ago · ${time}`,
      count: diffDays,
      time,
    }) ?? `${diffDays} days ago · ${time}`;
  }
  return `${ymd(fired)} ${time}`;
}

/** Run 用时：未结束返回 '—'；其余 'XXX ms' / 'X.X s' / 'Xm Ys'。 */
export function formatDuration(start: number, end?: number): string {
  if (!end) return '—';
  const diff = Math.max(0, end - start);
  if (diff < 1000) return `${diff} ms`;
  if (diff < MS_MIN) return `${(diff / 1000).toFixed(1)} s`;
  const min = Math.floor(diff / MS_MIN);
  const sec = Math.floor((diff % MS_MIN) / 1000);
  return `${min}m ${sec}s`;
}

/** USD 金额短显示：小额保留可见性，普通金额保留 2 位。 */
export function formatUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return '$0.00';
  if (costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

/** Running 中的 run 用："Started 12s ago" / "Started 4m ago" / "Started 2h ago"。 */
export function formatStartedAgo(
  start: number,
  now: number = Date.now(),
  translate?: TFunction,
): string {
  const diff = Math.max(0, now - start);
  if (diff < MS_MIN) {
    const count = Math.floor(diff / 1000);
    return translate?.('scheduler.presentation.time.startedSeconds', {
      defaultValue: `Started ${count}s ago`,
      count,
    }) ?? `Started ${count}s ago`;
  }
  if (diff < MS_HOUR) {
    const count = Math.floor(diff / MS_MIN);
    return translate?.('scheduler.presentation.time.startedMinutes', {
      defaultValue: `Started ${count}m ago`,
      count,
    }) ?? `Started ${count}m ago`;
  }
  const count = Math.floor(diff / MS_HOUR);
  return translate?.('scheduler.presentation.time.startedHours', {
    defaultValue: `Started ${count}h ago`,
    count,
  }) ?? `Started ${count}h ago`;
}

/**
 * 任务列表 cell 副标题 fallback：展示下一次触发的"绝对时间 + 间隔"。
 *   绝对时间按本地日历日切（与 formatLastRun 对齐：当天只显时分，跨天补日期）；
 *   间隔放括号里做辅助，让用户既能一眼看到"还有多久"，也能精确到"几点跑"。
 * - 已过期或 nextFireAt 缺失 → null（cell 不渲染副标题）
 * - 1m 内 → "Next less than 1 min"
 * - 当天   → "Next 13:09 (in 22m)" / "Next 17:30 (in 4h)"
 * - 跨天同年 → "Next 05-11 09:00 (in 2d)"
 * - 跨年   → "Next 2027-01-02 09:00 (in 1d)"
 */
export function formatNextRun(
  nextFireAt?: number,
  now: number = Date.now(),
  translate?: TFunction,
): string | null {
  if (!nextFireAt) return null;
  const diff = nextFireAt - now;
  if (diff <= 0 || diff < MS_MIN) {
    return translate?.('scheduler.presentation.time.nextLessThanMinute', {
      defaultValue: 'Next less than 1 min',
    }) ?? 'Next less than 1 min';
  }
  const next = new Date(nextFireAt);
  const today = startOfLocalDay(new Date(now));
  const nextDay = startOfLocalDay(next);
  let interval: string;
  if (diff < MS_HOUR) {
    const count = Math.floor(diff / MS_MIN);
    interval = translate?.('scheduler.presentation.time.intervalMinutes', {
      defaultValue: `${count}m`,
      count,
    }) ?? `${count}m`;
  } else if (diff < MS_DAY) {
    const count = Math.floor(diff / MS_HOUR);
    interval = translate?.('scheduler.presentation.time.intervalHours', {
      defaultValue: `${count}h`,
      count,
    }) ?? `${count}h`;
  } else {
    const count = Math.floor(diff / MS_DAY);
    interval = translate?.('scheduler.presentation.time.intervalDays', {
      defaultValue: `${count}d`,
      count,
    }) ?? `${count}d`;
  }
  const time = hm(next);
  let when: string;
  if (nextDay.getTime() === today.getTime()) when = time;
  else if (next.getFullYear() === new Date(now).getFullYear()) when = `${md(next)} ${time}`;
  else when = `${ymd(next)} ${time}`;
  return translate?.('scheduler.presentation.time.next', {
    defaultValue: `Next ${when} (in ${interval})`,
    interval,
    when,
  }) ?? `Next ${when} (in ${interval})`;
}

/** Working dir 用 …/<parent>/<basename> 简显，避免一长串绝对路径撑爆 pane header。 */
export function shortenWorkingDir(p?: string | null): string | null {
  if (!p) return null;
  const segs = stripTrailingPathSeparators(p).split(/[\\/]/);
  if (segs.length <= 2) return p;
  return `…/${segs.slice(-2).join('/')}`;
}

/** Working dir 只取最后一段（文件夹名），用于 pane header 内嵌 chip。 */
export function basenameOf(p?: string | null): string | null {
  if (!p) return null;
  const segs = stripTrailingPathSeparators(p).split(/[\\/]/);
  return segs[segs.length - 1] || p;
}

/**
 * 'claude-code' → 'Claude'（agent 标识对齐草稿界面 vendor 切换；provider 分离后
 * cc agent 统一以 Claude 品牌呈现，路由到哪个供应商由来源选择器单独控制）。
 * 'codex' → 'Codex'（保持 OpenAI 原品牌名）。
 */
export function humanizeAgentKind(k: AgentKind): string {
  return k === 'codex' ? 'Codex' : 'Claude';
}

/**
 * Pane header 副行的 destination 描述。返回结构化 parts，让调用方把 workingDir
 * 单独渲染成可点击 chip（点击直接在系统文件管理器打开目录）。
 *   - 绑定到现有会话 → { prefix: "Heartbeat to session abcdef12" }
 *   - 新会话 + 对话目标 → { prefix: "New dialogue" }
 *   - 新会话 + worktree + workingDir → { prefix: "New worktree session in ", workingDir }
 *   - 新会话 + 普通 dir → { prefix: "New session in ", workingDir }
 *   - 新会话 + 无 dir → { prefix: "New session" }
 */
export function describeDestination(s: {
  targetSessionId?: string;
  workspaceKind?: 'project' | 'dialogue';
  workingDir?: string;
  useWorktree: boolean;
}, translate?: TFunction): { prefix: string; workingDir?: string } {
  if (s.targetSessionId) {
    const id = s.targetSessionId.slice(0, 8);
    return {
      prefix: translate?.('scheduler.presentation.destination.boundSession', {
        defaultValue: `Heartbeat to session ${id}`,
        id,
      }) ?? `Heartbeat to session ${id}`,
    };
  }
  if (s.workspaceKind === 'dialogue') {
    return {
      prefix: translate?.('scheduler.presentation.destination.newDialogue', {
        defaultValue: 'New dialogue',
      }) ?? 'New dialogue',
    };
  }
  const base = s.useWorktree
    ? translate?.('scheduler.presentation.destination.newWorktreeSession', {
        defaultValue: 'New worktree session',
      }) ?? 'New worktree session'
    : translate?.('scheduler.presentation.destination.newSession', {
        defaultValue: 'New session',
      }) ?? 'New session';
  if (!s.workingDir) return { prefix: base };
  return {
    prefix: translate?.('scheduler.presentation.destination.inDirectory', {
      defaultValue: `${base} in `,
      base,
    }) ?? `${base} in `,
    workingDir: s.workingDir,
  };
}
