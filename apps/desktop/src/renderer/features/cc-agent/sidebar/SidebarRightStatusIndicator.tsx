import { useTranslation } from 'react-i18next';
import { CircleDashed } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { SidebarRightStatusKind } from './sidebarRightStatus';

/**
 * 会话行的右侧状态指示器。文字模式与列表模式共用这一份
 * 颜色和文案；状态点保留语义色，不随选中前景反色，各宿主只决定定位。
 */
export function SidebarRightStatusIndicator({
  kind,
  isActive,
  className,
}: {
  kind: Exclude<SidebarRightStatusKind, 'time'>;
  isActive: boolean;
  className?: string;
}) {
  const { t } = useTranslation();

  if (kind === 'running') {
    return (
      <Spinner
        data-sidebar-right-status={kind}
        role="img"
        size={12}
        strokeWidth={2}
        className={cn(
          'size-4',
          isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
          className,
        )}
        aria-label={t('ccAgent.sidebar.status.running', 'Running')}
        title={t('ccAgent.sidebar.status.running', 'Running')}
      />
    );
  }

  // 队列里还有没派发的消息：会话没在跑，但也不是空闲。用静止的虚线环，
  // 与「运行中」的转圈 spinner 区分开 —— 一个在等，一个在干活(#11299)。
  if (kind === 'queued') {
    const queuedLabel = t('newChat.pendingQueue.queued', 'Queued');
    return (
      <span
        data-sidebar-right-status={kind}
        role="img"
        className={cn('inline-flex size-4 items-center justify-center', className)}
        aria-label={queuedLabel}
        title={queuedLabel}
      >
        <CircleDashed
          size={13}
          strokeWidth={1.75}
          aria-hidden
          className={cn(
            isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
          )}
        />
      </span>
    );
  }

  const label =
    kind === 'error'
      ? t('ccAgent.sidebar.status.error', 'Failed — click to view')
      : kind === 'awaiting'
        ? t('ccAgent.sidebar.status.needsAttention', 'Awaiting your input')
        : t('ccAgent.sidebar.status.done', 'Completed — click to view');
  const color =
    kind === 'error'
      ? 'var(--card-status-error)'
      : kind === 'awaiting'
        ? 'var(--card-status-awaiting)'
        : 'var(--card-status-done)';

  return (
    <span
      data-sidebar-right-status={kind}
      role="img"
      className={cn('inline-flex size-4 items-center justify-center', className)}
      aria-label={label}
      title={label}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
    </span>
  );
}
