import type { TFunction } from 'i18next';
import type { RemoteSessionListItem } from '@/session/sessionList';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 首页自动化组行第二行的任务态摘要。优先级:需关注 / 等待处理 > 执行中 > 已停止 >
 * 下次运行倒计时 > 共 N 次运行。倒计时与桌面组头同一取整(向下取整到分 / 时 / 天),
 * 不足一分钟或宿主已到点尚未认领时显示「即将运行」。
 */
export function automationGroupPreview(
  item: RemoteSessionListItem,
  sessionCount: number,
  t: TFunction,
  now: number,
): string {
  const info = item.scheduleInfo;
  const unread = info?.unreadCount ?? 0;
  const waiting = item.pendingInteractionCount;
  if (unread > 0 || waiting > 0) {
    return [
      unread > 0 ? t('devices.list.preview.needAttention', { count: unread }) : null,
      waiting > 0 ? t('devices.list.preview.waiting', { count: waiting }) : null,
    ].filter(Boolean).join(' · ');
  }
  if (info?.running) return t('devices.list.preview.automationRunning');
  const runCount = t('devices.list.preview.runCount', { count: sessionCount });
  // 与右下 Timer 暂停角标同一判据:组内所有绑定都已暂停 / 结束才算停止。
  if (info?.allSchedulesStopped) return `${t('devices.list.preview.stopped')} · ${runCount}`;
  if (info?.scheduleStatus === 'active' && typeof info.nextFireAt === 'number') {
    return `${nextRunText(info.nextFireAt - now, t)} · ${runCount}`;
  }
  return t('devices.list.preview.totalRuns', { count: sessionCount });
}

function nextRunText(diffMs: number, t: TFunction): string {
  if (diffMs < MINUTE_MS) return t('devices.list.preview.imminent');
  if (diffMs < HOUR_MS) {
    return t('devices.list.preview.nextRunMinutes', { count: Math.floor(diffMs / MINUTE_MS) });
  }
  if (diffMs < DAY_MS) {
    return t('devices.list.preview.nextRunHours', { count: Math.floor(diffMs / HOUR_MS) });
  }
  return t('devices.list.preview.nextRunDays', { count: Math.floor(diffMs / DAY_MS) });
}
