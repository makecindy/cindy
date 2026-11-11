import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { SidebarRightStatusKind } from './sidebarRightStatus';

export interface SidebarRightStatusIndicatorProps {
  kind: Exclude<SidebarRightStatusKind, 'time'>;
  isActive: boolean;
  showLabel?: boolean;
  className?: string;
}

/**
 * 会话行的右侧状态指示器。文字模式与列表模式共用这一份
 * 颜色、文案和选中反白规则，各宿主只决定定位。
 */
export function SidebarRightStatusIndicator({
  kind,
  isActive,
  showLabel = false,
  className,
}: SidebarRightStatusIndicatorProps) {
  const { t } = useTranslation();

  const textLabel =
    kind === 'running'
      ? t('ccAgent.sidebar.status.runningText', '运行中')
      : kind === 'error'
        ? t('ccAgent.sidebar.status.errorText', '失败')
        : kind === 'awaiting'
          ? t('ccAgent.sidebar.status.awaitingText', '等待输入')
          : t('ccAgent.sidebar.status.doneText', '已完成');

  const tooltipLabel =
    kind === 'error'
      ? t('ccAgent.sidebar.status.error', 'Failed — click to view')
      : kind === 'awaiting'
        ? t('ccAgent.sidebar.status.needsAttention', 'Awaiting your input')
        : kind === 'done'
          ? t('ccAgent.sidebar.status.done', 'Completed — click to view')
          : t('ccAgent.sidebar.status.running', 'Running');

  const color =
    kind === 'error'
      ? 'var(--card-status-error)'
      : kind === 'awaiting'
        ? 'var(--card-status-awaiting)'
        : 'var(--card-status-done)';

  if (!showLabel) {
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
          aria-label={tooltipLabel}
          title={tooltipLabel}
        />
      );
    }

    return (
      <span
        data-sidebar-right-status={kind}
        role="img"
        className={cn('inline-flex size-4 items-center justify-center', className)}
        aria-label={tooltipLabel}
        title={tooltipLabel}
      >
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      </span>
    );
  }

  const textColorClass =
    kind === 'running'
      ? isActive
        ? 'text-sidebar-item-active-foreground'
        : 'text-sidebar-action-icon'
      : kind === 'error'
        ? 'text-[var(--card-status-error)]'
        : kind === 'awaiting'
          ? 'text-[var(--card-status-awaiting)]'
          : 'text-[var(--card-status-done)]';

  const dot = (
    <span
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );

  return (
    <span
      data-sidebar-right-status={kind}
      role="status"
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums select-none',
        textColorClass,
        className,
      )}
      aria-label={tooltipLabel}
      title={tooltipLabel}
    >
      {kind === 'running' ? (
        <Spinner
          size={11}
          strokeWidth={2}
          className={cn(
            'size-3 shrink-0',
            isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
          )}
          aria-hidden
        />
      ) : (
        dot
      )}
      <span className="truncate">{textLabel}</span>
    </span>
  );
}
