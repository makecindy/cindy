import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import {
  findLatestSidebarIndexRunForSession,
  loadScheduleSidebarIndexRuns,
} from '@/features/scheduler/lib/scheduleSidebarIndexRuns';
import { AutomationTimerIcon } from './AutomationTimerIcon';

// Keep the route subscription inside this optional control. Ordinary task rows
// must not subscribe to route changes merely to support an automation shortcut.
export function AutomationSessionButton({
  sessionId,
  size,
  activeForeground,
  centered = false,
}: {
  sessionId: string;
  size: number;
  activeForeground: boolean;
  centered?: boolean;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const openSchedule = async () => {
    try {
      const runs = await loadScheduleSidebarIndexRuns();
      const hit = findLatestSidebarIndexRunForSession(runs, sessionId);
      navigate(hit ? scheduleFocusPath(hit.scheduleId) : '/cc-agent/scheduled');
    } catch {
      navigate('/cc-agent/scheduled');
    }
  };
  return (
    <Tip text={t('ccAgent.sidebar.scheduleBinding.viewTask')}>
      <button
        type="button"
        className={
          centered
            ? 'inline-flex shrink-0 cursor-pointer items-center justify-center focus:outline-none'
            : 'inline-flex shrink-0 cursor-pointer focus:outline-none'
        }
        aria-label={t('ccAgent.sidebar.scheduleBinding.viewTask')}
        onClick={(event) => {
          event.stopPropagation();
          void openSchedule();
        }}
        onKeyDown={centered ? (event) => event.stopPropagation() : undefined}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <AutomationTimerIcon size={size} activeForeground={activeForeground} />
      </button>
    </Tip>
  );
}
