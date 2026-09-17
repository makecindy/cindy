import type { Session } from './ccAgent.types';
import type { ChatMessage } from './makerChatStore';
import type { MakeDoctorReport, CindyMakeTaskPreparation } from '../../shared/cindyMakeDoctor';
import { CINDY_MAKE_SESSION_SOURCE } from '../../shared/cindyMakeSession';

export type CindyMakeComposerPhase =
  Exclude<CindyMakeTaskPreparation['phase'], 'completed'> | 'executing' | 'failed' | 'cancelled';

type MakeSession = Pick<
  Session,
  'id' | 'source' | 'clearedAt' | 'lastTurnEndedAt' | 'interruptedTurnStartedAt'
>;

/** Preparation completion means dispatch accepted, not the end of the first execution. */
export function getCindyMakeComposerPhase({
  session,
  report,
  messages,
  historyLoaded,
  busy,
  error,
}: {
  session: MakeSession | null;
  report?: MakeDoctorReport;
  messages: readonly ChatMessage[];
  historyLoaded: boolean;
  busy: boolean;
  error: string | null;
}): CindyMakeComposerPhase | null {
  if (session?.source !== CINDY_MAKE_SESSION_SOURCE || session.clearedAt) return null;
  // Main persists this only at a product-turn terminal, not while waiting for
  // questions, plan review, permission, or an automatic continuation. It also
  // survives remounts and keeps later manual turns from locking the composer.
  if (session.lastTurnEndedAt != null) return null;

  const saved = messages.find(
    (message) =>
      message.systemCardType === 'cindy-make' &&
      (message.systemCardData?.report as MakeDoctorReport | undefined)?.task?.sessionId ===
        session.id,
  )?.systemCardData?.report as MakeDoctorReport | undefined;
  const preparation = report?.task?.sessionId === session.id ? report : saved;
  if (!preparation) return historyLoaded ? null : 'waiting';
  if (preparation.status === 'failed' || preparation.status === 'cancelled')
    return preparation.status;
  if (preparation.status === 'running')
    return preparation.task?.phase === 'completed'
      ? 'executing'
      : (preparation.task?.phase ?? 'waiting');

  // Old history can arrive before the session patch. An interrupted/failed
  // execution must leave the existing recovery controls and manual input usable.
  if (
    (!busy && (error || session.interruptedTurnStartedAt != null)) ||
    messages.some((message) => !message.parentToolUseId && message.turnCompleted === true)
  )
    return null;
  return 'executing';
}
