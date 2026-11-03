import { useTranslation } from 'react-i18next';
import { WORKING_PHASE_KEYS, type WorkingPhase } from '../../../shared/workingStatus';
import { WorkingStatusText } from '@/features/cc-agent/WorkingStatusText';
import { useWorkingStatusCopy } from './useWorkingStatusCopy';

/** Lists consume exactly the same public phase and host copy cache as the composer. */
export function BotGenerationLabel({ sessionId, phase = 'processing', startedAt = null, remote }: {
  sessionId?: string; phase?: WorkingPhase; startedAt?: number | null;
  remote?: { deviceId: string; botId: string };
}) {
  const { t } = useTranslation();
  const copy = useWorkingStatusCopy(sessionId, startedAt, phase, true, remote);
  return <WorkingStatusText key={startedAt} text={copy || t(WORKING_PHASE_KEYS[phase])} />;
}
