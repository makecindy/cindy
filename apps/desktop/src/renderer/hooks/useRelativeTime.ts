/**
 * useRelativeTime
 * ---------------------------------------------------------------------------
 * Hook for the message-actions bar. Renders an ISO timestamp as a smart
 * relative-time string (just now / N minutes ago / N hours ago / N days ago /
 * MM-DD HH:mm / YYYY-MM-DD HH:mm) per the V1.2 product spec.
 *
 * Refresh policy: compute once on mount + tick every 30s **only while the
 * message is hovered**. Unhovered messages keep their initial render and
 * never own a timer — verified by spec ("性能验收：消息列表渲染数百条时，
 * 未 hover 的消息不创建任何 timer").
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;
const SEVEN_DAYS = 7 * ONE_DAY;

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function tr(
  t: TFunc | undefined,
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
): string {
  const value = t ? t(key, options) : '';
  return value && value !== key ? value : fallback;
}

/** Format the relative-time text per V1.2 spec. Exported for unit tests. */
export function formatRelative(createdAtMs: number, nowMs: number, t?: TFunc): string {
  const delta = nowMs - createdAtMs;

  if (delta < ONE_MINUTE) {
    return tr(t, 'chat.messageActionBar.relative.justNow', 'just now');
  }
  if (delta < ONE_HOUR) {
    const count = Math.floor(delta / ONE_MINUTE);
    return tr(t, 'chat.messageActionBar.relative.minutesAgo', count === 1 ? '1 minute ago' : `${count} minutes ago`, { count });
  }
  if (delta < ONE_DAY) {
    const count = Math.floor(delta / ONE_HOUR);
    return tr(t, 'chat.messageActionBar.relative.hoursAgo', count === 1 ? '1 hour ago' : `${count} hours ago`, { count });
  }
  if (delta < SEVEN_DAYS) {
    const count = Math.floor(delta / ONE_DAY);
    return tr(t, 'chat.messageActionBar.relative.daysAgo', count === 1 ? '1 day ago' : `${count} days ago`, { count });
  }

  const d = new Date(createdAtMs);
  const now = new Date(nowMs);
  const sameYear = d.getFullYear() === now.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return sameYear
    ? `${mm}-${dd} ${hh}:${mi}`
    : `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

/** Absolute timestamp shown as native browser tooltip on the <time> element. */
export function formatAbsolute(createdAt: string | undefined): string {
  if (!createdAt) return '';
  const ms = new Date(createdAt).getTime();
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

interface Options {
  /** Only ticks while hovered === true. Toggling false clears the timer. */
  hovered: boolean;
  /** Tick interval in ms; defaults to 30s per V1.2 spec. Override for tests. */
  tickMs?: number;
}

/**
 * Returns the relative-time string for `createdAt`. Empty string if the input
 * is missing or unparseable (defensive — older messages from before the field
 * existed render without a timestamp rather than crashing).
 */
export function useRelativeTime(
  createdAt: string | undefined,
  { hovered, tickMs = 30_000 }: Options,
): string {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState(() => {
    if (!createdAt) return '';
    const ms = new Date(createdAt).getTime();
    if (Number.isNaN(ms)) return '';
    return formatRelative(ms, Date.now(), t);
  });

  useEffect(() => {
    if (!createdAt) {
      setText('');
      return;
    }
    const ms = new Date(createdAt).getTime();
    if (Number.isNaN(ms)) {
      setText('');
      return;
    }

    // Recompute once whenever hover toggles on so a long-unhovered message
    // shows the current value the moment it becomes visible.
    setText(formatRelative(ms, Date.now(), t));

    if (!hovered) return;
    const id = setInterval(() => {
      setText(formatRelative(ms, Date.now(), t));
    }, tickMs);
    return () => clearInterval(id);
  }, [createdAt, hovered, tickMs, t, i18n.language]);

  return text;
}
