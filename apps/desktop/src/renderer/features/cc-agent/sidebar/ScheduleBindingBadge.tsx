/**
 * ScheduleBindingBadge — 会话被自动化任务(heartbeat schedule)绑定时的标识。
 *
 * 数据来自 useSessionBoundSchedules(schedulesStore 反向索引):schedule 删除 /
 * 过期后列表为空,调用方据此不渲染,徽章自动消失。SessionItem(size 10)与
 * SessionContentHeader(size 13)共用。
 *
 * 视觉:复用统一 AutomationTimerIcon。全部绑定均 paused 时主图标弱化 +
 * 右下叠 Pause mini-badge，不替换 Timer、不改变占位。
 */

import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { ScheduleBinding } from '@/features/scheduler/lib/scheduleBindingIndex';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import {
  cronToConfig,
  DEFAULT_CONFIG,
  summarizeConfig,
} from '@/features/scheduler/lib/cronCodexPreset';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import { AutomationTimerIcon } from './AutomationTimerIcon';

export interface ScheduleBindingBadgeProps {
  /** 绑定到当前会话的 schedules(expired 已由 selector 滤掉)。空数组不渲染。 */
  schedules: readonly ScheduleBinding[];
  /** 远程只展示绑定信息，不把远程 ID 带进本机自动化管理页。 */
  deviceLinkDeviceId?: string | null;
  /** Timer 图标尺寸,sidebar 10 / header 13。 */
  size?: number;
  className?: string;
  /** 宿主行处于红胶囊选中态 → Timer 反白(用户规则 2026-07-19:选中态前景与文字同色)。 */
  activeForeground?: boolean;
}

/** 手动、单次、相对间隔优先于兼容用的 Cron 占位值。 */
function frequencyText(
  schedule: ScheduleBinding,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (schedule.manual) return t('scheduler.detail.manualTrigger');
  if (schedule.recurring === false) return t('scheduler.cell.subtitleOnce');
  if (schedule.intervalMs !== undefined) {
    return summarizeConfig(
      {
        ...DEFAULT_CONFIG,
        mode: schedule.intervalMs % 3_600_000 === 0 ? 'interval' : 'intervalMinutes',
        intervalHours: schedule.intervalMs / 3_600_000,
        intervalMinutes: schedule.intervalMs / 60_000,
      },
      t,
    );
  }
  return summarizeConfig(cronToConfig(schedule.cronExpr), t);
}

export function ScheduleBindingBadge({
  schedules,
  deviceLinkDeviceId,
  size = 10,
  className,
  activeForeground = false,
}: ScheduleBindingBadgeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (schedules.length === 0) return null;

  const allPaused = schedules.every((s) => s.status === 'paused');
  const icon = (
    <AutomationTimerIcon size={size} paused={allPaused} activeForeground={activeForeground} />
  );

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {deviceLinkDeviceId ? (
          <span
            role="img"
            aria-label={t('ccAgent.sidebar.scheduleBinding.label')}
            tabIndex={0}
            className={cn('inline-flex shrink-0 items-center justify-center', className)}
          >
            {icon}
          </span>
        ) : (
          <button
            type="button"
            aria-label={t('ccAgent.sidebar.scheduleBinding.viewTask')}
            onClick={(e) => {
              // 防止冒泡触发 SessionItem 行导航(与 WorktreeBadge 同款处理)
              e.stopPropagation();
              navigate(scheduleFocusPath(schedules[0].id));
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(
              'inline-flex shrink-0 items-center justify-center',
              'cursor-pointer focus:outline-none',
              className,
            )}
          >
            {icon}
          </button>
        )}
      </Tooltip.Trigger>
      <Tooltip.Content side="top" variant="mono">
        <div className="flex flex-col gap-1">
          <span>{t('ccAgent.sidebar.scheduleBinding.label')}</span>
          {schedules.map((s) => (
            <div key={s.id} className="flex flex-col gap-0.5">
              <span>
                {t('ccAgent.sidebar.scheduleBinding.tooltipName', { name: s.name })}
                {s.status === 'paused'
                  ? ` ${t('ccAgent.sidebar.scheduleBinding.pausedSuffix')}`
                  : ''}
              </span>
              <span>
                {t('ccAgent.sidebar.scheduleBinding.tooltipFrequency', {
                  frequency: frequencyText(s, t),
                })}
              </span>
            </div>
          ))}
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
