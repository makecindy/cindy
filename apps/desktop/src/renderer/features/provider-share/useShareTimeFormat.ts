/**
 * 分享界面的时间写法：一周内用相对时间(沿用消息操作栏的「刚刚 / N 分钟前」)，更早的写日期；
 * 加入日期只写月日(跨年再带年份)，跟随界面语言。
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { formatRelative } from '@/hooks/useRelativeTime';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ShareTimeFormat {
  /** 「3 分钟前」「2 天前」，一周以上写日期。 */
  relative: (atMs: number) => string;
  /** 「9月28日」/「Sep 28」，跨年带年份。 */
  date: (atMs: number) => string;
}

export function useShareTimeFormat(): ShareTimeFormat {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;

  const date = useCallback(
    (atMs: number) => {
      const value = new Date(atMs);
      if (Number.isNaN(value.getTime())) return '';
      const sameYear = value.getFullYear() === new Date().getFullYear();
      try {
        return new Intl.DateTimeFormat(language || undefined, {
          ...(sameYear ? {} : { year: 'numeric' as const }),
          month: 'short',
          day: 'numeric',
        }).format(value);
      } catch {
        return value.toLocaleDateString();
      }
    },
    [language],
  );

  const relative = useCallback(
    (atMs: number) => {
      const now = Date.now();
      if (!Number.isFinite(atMs)) return '';
      if (now - atMs >= SEVEN_DAYS_MS) return date(atMs);
      return formatRelative(atMs, now, t as (key: string, options?: Record<string, unknown>) => string);
    },
    [date, t],
  );

  return { relative, date };
}
