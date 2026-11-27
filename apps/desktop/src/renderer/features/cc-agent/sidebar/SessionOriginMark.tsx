import { CornerDownRight, Users } from 'lucide-react';
import { useStableTranslation as useTranslation } from '@/hooks/useStableTranslation';

import { Tip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';

export interface SessionOriginMarkProps {
  session: Session;
  isActive?: boolean;
  size?: number;
  /** Suppress the task-origin icon when a buddy follow mark already identifies the delegating buddy. */
  suppressTaskOrigin?: boolean;
  className?: string;
}

/**
 * 侧边栏任务行的来源标记（零 store 订阅，保持 SessionItem memo 隔离）：
 * - `orcaRemoteLead`：另一台电脑协同 Lead 派来的远端 Worker（Users 图标 + hover 来源说明）
 * - `createdBySession`：由其他任务经 send_to_session（create 模式）新建的任务（CornerDownRight 图标 + hover 来源说明）
 * - 普通用户新建任务返回 null，不增加任何视觉噪音。
 */
export function SessionOriginMark({
  session,
  isActive = false,
  size = 12,
  suppressTaskOrigin = false,
  className,
}: SessionOriginMarkProps) {
  const { t } = useTranslation();
  const toneClass = isActive
    ? 'text-sidebar-item-active-foreground/80'
    : 'text-[var(--cmd-palette-item-meta)]';

  if (session.orcaRemoteLead) {
    const lead = session.orcaRemoteLead;
    const device = lead.leadDeviceName || t('ccAgent.sessionHeader.orcaRemoteLeadUnknownDevice');
    const released = lead.releasedAt !== undefined;
    const label = released
      ? t('ccAgent.sessionHeader.orcaRemoteLeadReleased', { device })
      : t('ccAgent.sessionHeader.orcaRemoteLead', { device });
    const tip = released
      ? label
      : t('ccAgent.sessionHeader.orcaRemoteLeadTip', {
          device,
          lead: lead.leadTitle || device,
        });
    return (
      <Tip text={tip} side="right">
        <span
          role="img"
          aria-label={label}
          data-testid={`session-origin-orca-remote-${session.id}`}
          className={cn('inline-flex shrink-0 items-center justify-center', toneClass, className)}
        >
          <Users size={size} strokeWidth={1.8} aria-hidden="true" />
        </span>
      </Tip>
    );
  }

  const origin = suppressTaskOrigin ? null : session.createdBySession;
  if (!origin) return null;

  const title = origin.title?.trim();
  const device = origin.deviceName?.trim()
    || (origin.deviceId ? t('ccAgent.sessionHeader.orcaRemoteLeadUnknownDevice') : '');
  const tip = origin.deviceId
    ? title
      ? t('ccAgent.sidebar.origin.createdByRemoteTaskNamed', { device, title })
      : t('ccAgent.sidebar.origin.createdByRemoteTask', { device })
    : title
      ? t('ccAgent.sidebar.origin.createdByTaskNamed', { title })
      : t('ccAgent.sidebar.origin.createdByTask');

  return (
    <Tip text={tip} side="right">
      <span
        role="img"
        aria-label={tip}
        data-testid={`session-origin-task-${session.id}`}
        className={cn('inline-flex shrink-0 items-center justify-center', toneClass, className)}
      >
        <CornerDownRight size={size} strokeWidth={1.8} aria-hidden="true" />
      </span>
    </Tip>
  );
}
