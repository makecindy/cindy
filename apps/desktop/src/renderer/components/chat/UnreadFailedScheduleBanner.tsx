import { useEffect, type CSSProperties } from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isWindowVisiblyFocused, useWindowVisible } from '@/hooks/useWindowVisible';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { markScheduleRunsReadAndSync } from '@/features/scheduler/lib/scheduleRunReadSync';

const log = createLogger('UnreadFailedScheduleBanner');
const READ_DWELL_MS = 1_500;

/** 历史定时失败看过即已读；需要重试或继续的错误仍由各自的操作横幅负责。 */
export function UnreadFailedScheduleBanner({
  runIds,
  viewVisible,
  className,
  style,
}: {
  runIds: readonly string[];
  /** 隐藏的常驻 pane、折叠 rail 或历史尚未加载时不能确认已读。 */
  viewVisible: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const windowVisible = useWindowVisible(viewVisible);
  // 侧栏重查会重建数组；同一批记录的刷新不应反复重置阅读时间。
  const runIdsKey = JSON.stringify([...runIds].sort());

  useEffect(() => {
    if (!viewVisible || !windowVisible || runIdsKey === '[]') return;
    const seenRunIds: string[] = JSON.parse(runIdsKey);
    const timer = setTimeout(() => {
      if (!isWindowVisiblyFocused()) return;
      // 只确认这一轮驻留的快照。读库刷新移除成功记录，新失败会开始自己的驻留。
      void markScheduleRunsReadAndSync(seenRunIds)
        .then(({ failed }) => {
          if (failed.length > 0)
            log.warn('Could not mark seen runs read', { count: failed.length });
        })
        .catch(() => log.warn('Could not sync seen runs'));
    }, READ_DWELL_MS);
    // 失焦、面板隐藏、批次变化或卸载均取消；不把快速切过当作已经看过。
    return () => clearTimeout(timer);
  }, [runIdsKey, viewVisible, windowVisible]);

  if (runIds.length === 0) return null;

  return (
    <div
      className={cn(
        'mx-auto flex select-none items-start gap-2 rounded-md px-3 py-2',
        'border bg-[var(--error-bg)] border-[var(--error-border)]',
        className,
      )}
      style={style}
      data-testid="unread-failed-schedule-banner"
      data-banner-kind="unread-failed-schedule"
    >
      <AlertCircle size={14} className="shrink-0 mt-[2px] text-[var(--error-fg)]" />
      <span className="flex-1 min-w-0 text-xs break-all text-[var(--error-fg)]">
        {t('chat.unreadFailedScheduleBanner.text')}
      </span>
    </div>
  );
}
