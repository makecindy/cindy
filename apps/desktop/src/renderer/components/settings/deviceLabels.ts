/**
 * deviceLabels —— 「远程连接」页设备文案的共用小函数(列表页与拓扑页同口径)。
 */

import appI18n from 'i18next';

type T = (key: string, options?: Record<string, unknown>) => string;

export function platformLabel(platform: string | null): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    default:
      return platform ?? '—';
  }
}

/** lastSeenAt 相对时间(分钟粒度,超过 7 天显示日期)。 */
export function relativeTime(iso: string | null, t: T, now = Date.now()): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';
  const diffMin = Math.floor((now - ts) / 60_000);
  if (diffMin < 1) return t('settings.devices.justNow');
  if (diffMin < 60) return t('settings.devices.minutesAgo', { count: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('settings.devices.hoursAgo', { count: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return t('settings.devices.daysAgo', { count: diffDay });
  return new Date(ts).toLocaleDateString(appI18n.language);
}
