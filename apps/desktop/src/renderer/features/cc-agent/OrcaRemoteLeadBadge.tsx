import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Session } from '@/lib/ccAgent.types';
import { Tip } from '@/components/ui/tooltip';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';

/**
 * 运行设备上的协同远端 Worker：标明是哪台电脑的 Lead 派来的。
 * 本机直接发的消息按插话处理，不回报给那台的 Lead；派活电脑结束协同后显示「协同已结束」。
 */
export function OrcaRemoteLeadBadge({ session }: { session: Session }) {
  const { t } = useTranslation();
  const lead = session.orcaRemoteLead;
  if (!lead) return null;
  const device = lead.leadDeviceName || t('ccAgent.sessionHeader.orcaRemoteLeadUnknownDevice');
  const released = lead.releasedAt !== undefined;
  const label = released
    ? t('ccAgent.sessionHeader.orcaRemoteLeadReleased', { device })
    : t('ccAgent.sessionHeader.orcaRemoteLead', { device });
  return (
    <Tip
      text={t('ccAgent.sessionHeader.orcaRemoteLeadTip', {
        device,
        lead: lead.leadTitle || device,
      })}
    >
      <span
        role="note"
        aria-label={label}
        className="ml-2 inline-flex min-w-0 max-w-56 shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 leading-4 text-[var(--text-secondary)]"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <Users size={12} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </Tip>
  );
}
