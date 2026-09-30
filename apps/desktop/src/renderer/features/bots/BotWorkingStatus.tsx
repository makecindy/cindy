import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { readWorkingPhase, WORKING_PHASE_KEYS } from '../../../shared/workingStatus';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage as Message } from '@/lib/makerChatStore';
import { Spinner } from '@/components/ui/spinner';
import { useWorkingStatusCopy } from './useWorkingStatusCopy';
import { localizePlainAgentStatus, resolvePlainAgentPhase } from '@/features/cc-agent/lib/localizeAgentStatus';
import { WorkingStatusText } from '@/features/cc-agent/WorkingStatusText';

export function BotWorkingStatus({
  visible, status, messages, startedAt, foregroundRunning, backgroundWorkActive, avatar, inputWidth, sessionId, remote,
}: {
  sessionId?: string;
  remote?: { deviceId: string; botId: string };
  visible: boolean;
  status: string;
  messages: readonly Message[];
  startedAt: number | null;
  foregroundRunning: boolean;
  backgroundWorkActive: boolean;
  avatar: ReactNode;
  inputWidth?: CSSProperties['width'];
}) {
  const { t } = useTranslation();
  // A Workflow can run alongside the foreground turn. Only background-only
  // work lacks reliable foreground events for a more specific caption.
  const processingOnly = backgroundWorkActive && !foregroundRunning;
  const localActivity = useAgentIslandActivity(sessionId ?? '');
  const remoteActivity = useRemoteSessionActivity(sessionId ?? '', remote?.deviceId);
  const activity = remote ? remoteActivity : localActivity;
  const waiting = status === 'Waiting on approval' || status === 'Waiting on input';
  const sharedPhase = !waiting && activity?.phase === 'running' ? readWorkingPhase(activity.workingPhase) : null;
  const phase = processingOnly ? 'processing' : sharedPhase ?? resolvePlainAgentPhase(status, messages, startedAt);
  const polished = useWorkingStatusCopy(sessionId, startedAt, phase, visible && !processingOnly, remote);
  // Terminal events bypass cadence and opacity: never linger with working copy.
  if (!visible) return null;
  const text = processingOnly
    ? t('ccAgent.agentStatus.processing')
    : sharedPhase ? t(WORKING_PHASE_KEYS[sharedPhase]) : localizePlainAgentStatus(status, messages, startedAt, t);
  return (
    <div
      data-testid="bot-working-indicator"
      data-working-phase={phase}
      data-working-copy-source={polished ? 'generated' : 'default'}
      role="status"
      aria-live="polite"
      className="mx-auto flex min-w-0 select-none items-center gap-2 px-2 py-[6px] text-12 text-[var(--text-tertiary)]"
      style={{ width: inputWidth }}
    >
      {avatar}
      <Spinner size={12} />
      <WorkingStatusText key={startedAt} text={polished ?? text} />
    </div>
  );
}
