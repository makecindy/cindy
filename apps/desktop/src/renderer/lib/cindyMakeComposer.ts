import type { Session } from './ccAgent.types';
import type { ChatMessage } from './makerChatStore';
import type { MakeDoctorReport, CindyMakeTaskPreparation } from '../../shared/cindyMakeDoctor';
import { CINDY_MAKE_SESSION_SOURCE } from '../../shared/cindyMakeSession';
import type { CindyMakeCompletionMeta } from '../../shared/cindyMakeSession';

export type CindyMakeComposerPhase =
  Exclude<CindyMakeTaskPreparation['phase'], 'completed'> | 'failed' | 'cancelled';

export function isCindyMakeCompletionMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.systemCardType === 'cindy-make-complete';
}

/** Only the newest completed edit can ask for testing; continued/new work supersedes it. */
export function getCindyMakePendingTest({
  session,
  messages,
  busy,
}: {
  session: Pick<Session, 'id' | 'source' | 'status' | 'clearedAt'> | null;
  messages: readonly ChatMessage[];
  busy: boolean;
}): { completionId: string; meta: CindyMakeCompletionMeta } | null {
  if (
    session?.source !== CINDY_MAKE_SESSION_SOURCE ||
    session.status !== 'active' ||
    session.clearedAt ||
    busy
  )
    return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.parentToolUseId) continue;
    if (message.role === 'user') return null;
    if (!isCindyMakeCompletionMessage(message)) continue;
    const meta = message.systemCardData as unknown as CindyMakeCompletionMeta | undefined;
    if (
      !meta ||
      typeof meta.reportedAt !== 'number' ||
      !Number.isFinite(meta.reportedAt) ||
      meta.continuedAt
    )
      return null;
    return { completionId: message.clientId, meta };
  }
  return null;
}

/**
 * Keep a way back to testing after Continue Editing, including when a later
 * reply omitted report_complete. This offers inline actions, never an input lock:
 * an ended assistant reply alone cannot certify the current workspace.
 */
export function getCindyMakeTestRecovery({
  session,
  messages,
  busy,
  historyLoaded,
}: {
  session: Pick<Session, 'id' | 'source' | 'status' | 'clearedAt'> | null;
  messages: readonly ChatMessage[];
  busy: boolean;
  historyLoaded: boolean;
}): string | null {
  if (
    session?.source !== CINDY_MAKE_SESSION_SOURCE ||
    session.status !== 'active' ||
    session.clearedAt ||
    busy ||
    !historyLoaded ||
    getCindyMakePendingTest({ session, messages, busy })
  )
    return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.parentToolUseId) continue;
    if (message.role === 'user') return null;
    if (isCindyMakeCompletionMessage(message)) {
      return typeof message.systemCardData?.continuedAt === 'number' ? message.clientId : null;
    }
    if (message.role === 'assistant' && typeof message.turnCompleted === 'boolean')
      return message.turnCompleted ? message.clientId : null;
  }
  return null;
}

type MakeSession = Pick<
  Session,
  'id' | 'source' | 'clearedAt' | 'lastTurnEndedAt' | 'interruptedTurnStartedAt'
>;

export function isCindyMakePreparationMessage(
  message: ChatMessage,
  sessionId: string | undefined,
): boolean {
  return (
    !!sessionId &&
    message.role === 'assistant' &&
    (message.systemCardType === 'cindy-make' || message.systemCardType === 'cindy-make-doctor') &&
    (message.systemCardData?.report as MakeDoctorReport | undefined)?.task?.sessionId === sessionId
  );
}

/** The composer and its lifecycle use the same live report, with durable history as fallback. */
export function getCindyMakePreparation({
  session,
  report,
  messages,
}: {
  session: MakeSession | null;
  report?: MakeDoctorReport;
  messages: readonly ChatMessage[];
}): { report: MakeDoctorReport; request?: string } | undefined {
  if (session?.source !== CINDY_MAKE_SESSION_SOURCE || session.clearedAt) return undefined;
  const saved = messages.find((message) => isCindyMakePreparationMessage(message, session.id));
  const savedReport = saved?.systemCardData?.report as MakeDoctorReport | undefined;
  const preparation = report?.task?.sessionId === session.id ? report : savedReport;
  if (!preparation) return undefined;
  const savedRequest =
    savedReport?.runId === preparation.runId && typeof saved?.systemCardData?.request === 'string'
      ? saved.systemCardData.request
      : undefined;
  return { report: preparation, request: preparation.task?.request ?? savedRequest };
}

/** Only preparation replaces input. Editing uses the ordinary composer from the first turn. */
export function getCindyMakeComposerPhase({
  session,
  report,
  messages,
  historyLoaded,
}: {
  session: MakeSession | null;
  report?: MakeDoctorReport;
  messages: readonly ChatMessage[];
  historyLoaded: boolean;
  busy: boolean;
  error: string | null;
}): CindyMakeComposerPhase | null {
  if (session?.source !== CINDY_MAKE_SESSION_SOURCE || session.clearedAt) return null;
  // A completed editing turn also rules out stale preparation history after reload.
  if (session.lastTurnEndedAt != null) return null;

  const preparation = getCindyMakePreparation({ session, report, messages })?.report;
  if (!preparation) return historyLoaded ? null : 'waiting';
  if (preparation.status === 'failed' || preparation.status === 'cancelled')
    return preparation.status;
  if (preparation.status === 'running')
    return preparation.task?.phase === 'completed' ? null : (preparation.task?.phase ?? 'waiting');
  return null;
}
