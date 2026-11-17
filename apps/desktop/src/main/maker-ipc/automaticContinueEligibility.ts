import type { ProviderGroupEligibilityContext } from '../provider-group/service.js';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

export function isQuotaScheduleCurrent(schedule: { status: string; targetSessionId?: string | null } | undefined,
  sessionId: string): boolean {
  // Unbound schedules create a new task per run; a bound schedule must still own this task.
  return schedule?.status === 'active' && (!schedule.targetSessionId || schedule.targetSessionId === sessionId);
}

/** Invoked at the provider boundary, after asynchronous group/runtime preparation. */
export function createScheduledQuotaDispatchGuard(deps: {
  origin(sessionId: string, clientId: string): AgentInputQueuedMessage['origin'];
  isScheduleActive(scheduleId: string, sessionId: string): Promise<boolean>;
  reject(): never;
}) {
  return async (sessionId: string, sendOpts: unknown): Promise<void> => {
    const clientId = (sendOpts as { persistUserMessage?: { clientId?: string } } | undefined)?.persistUserMessage?.clientId;
    if (!clientId) return;
    const origin = deps.origin(sessionId, clientId);
    if (origin?.kind !== 'scheduler') return;
    if (!await deps.isScheduleActive(origin.scheduleId, sessionId) || deps.origin(sessionId, clientId) !== origin) deps.reject();
  };
}

interface SessionSnapshot {
  source?: string | null;
  status?: string;
  orcaRole?: string | null;
  agentDeviceId?: string | null;
  remoteHostId?: string | null;
}

export interface CompanionFailoverSnapshot {
  role: string;
  profileStatus: string;
  hiddenAt: number | null;
  shadowed: boolean;
}

export function isActiveCompanionFailoverSession(companion: CompanionFailoverSnapshot | null): boolean {
  return !!companion && (companion.role === 'canonical' || companion.role === 'thread')
    && companion.profileStatus === 'active' && companion.hiddenAt === null && !companion.shadowed;
}

/** Keep delayed quota recovery separate from an immediate group relocation. */
export function createAutomaticContinueEligibility(deps: {
  ownerEpoch(): string;
  isPaused(sessionId: string): boolean;
  readSession(sessionId: string): Promise<SessionSnapshot | null>;
  isShared(sessionId: string): boolean;
  goalOwnsRecovery(sessionId: string): Promise<boolean>;
  readCompanion(sessionId: string): Promise<CompanionFailoverSnapshot | null>;
  ownsCompanionInput(sessionId: string, context: ProviderGroupEligibilityContext): boolean;
  ownsScheduledQuotaInput?(sessionId: string, clientId?: string): boolean;
}) {
  async function eligible(sessionId: string, context?: ProviderGroupEligibilityContext): Promise<boolean> {
    const owner = deps.ownerEpoch();
    if (deps.isPaused(sessionId)) return false;
    const row = await deps.readSession(sessionId);
    if (!row || (row.orcaRole === 'worker' && !context)) return false;
    const ownsQuota = () => !!row.agentDeviceId && !row.remoteHostId
      && (!context || context.kind === 'before-send')
      && (deps.ownsScheduledQuotaInput?.(sessionId, context?.kind === 'before-send' ? context.clientId : undefined) ?? false);
    const ownsInput = () => ownsQuota() || (!!context && deps.ownsCompanionInput(sessionId, context));
    if (row.source === 'bot') {
      // A role alone cannot identify who owns the turn: IM and scheduling can
      // also enter canonical. Only coordinator-owned human input qualifies.
      if ((!ownsQuota() && (!context || (context.kind !== 'failure' && context.kind !== 'before-send'))) || row.status !== 'active') return false;
      // Candidate recovery owns these remote turns, including when it declines
      // recovery. No visible output does not prove the remote work never ran.
      if (context?.kind === 'failure'
        && (context.reason === 'remote_agent_lost' || context.reason === 'remote_agent_closed')) return false;
      const companion = await deps.readCompanion(sessionId);
      if (!isActiveCompanionFailoverSession(companion)) return false;
      if (deps.ownerEpoch() !== owner || deps.isPaused(sessionId)
        || !ownsInput()) return false;
    }
    // Sharing must not disable recovery within the owner's selected group.
    // Delayed quota waits and proactive rebalancing still require owner control.
    if (deps.isShared(sessionId) && (!context || context.kind === 'rebalance' || context.kind === 'reconnect'
      || (context.kind === 'restart' && !context.verifiedGroup) || row.source === 'bot')) return false;
    if (await deps.goalOwnsRecovery(sessionId)) return false;
    return row.source !== 'bot' || (deps.ownerEpoch() === owner && !deps.isPaused(sessionId)
      && !deps.isShared(sessionId) && ownsInput());
  }
  return {
    usageLimit: (sessionId: string) => eligible(sessionId),
    providerGroup: (sessionId: string, context: ProviderGroupEligibilityContext) => eligible(sessionId, context),
  };
}
