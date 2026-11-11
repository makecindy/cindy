import type { ProviderGroupEligibilityContext } from '../provider-group/service.js';

interface SessionSnapshot {
  source?: string | null;
  status?: string;
  orcaRole?: string | null;
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
}) {
  async function eligible(sessionId: string, context?: ProviderGroupEligibilityContext): Promise<boolean> {
    const owner = deps.ownerEpoch();
    if (deps.isPaused(sessionId)) return false;
    const row = await deps.readSession(sessionId);
    if (!row || (row.orcaRole === 'worker' && !context)) return false;
    if (row.source === 'bot') {
      // A role alone cannot identify who owns the turn: IM and scheduling can
      // also enter canonical. Only coordinator-owned human input qualifies.
      if (!context || (context.kind !== 'failure' && context.kind !== 'before-send') || row.status !== 'active') return false;
      // Candidate recovery owns these remote turns, including when it declines
      // recovery. No visible output does not prove the remote work never ran.
      if (context.kind === 'failure'
        && (context.reason === 'remote_agent_lost' || context.reason === 'remote_agent_closed')) return false;
      const companion = await deps.readCompanion(sessionId);
      if (!isActiveCompanionFailoverSession(companion)) return false;
      if (deps.ownerEpoch() !== owner || deps.isPaused(sessionId)
        || !deps.ownsCompanionInput(sessionId, context)) return false;
    }
    if (deps.isShared(sessionId)) return false;
    if (await deps.goalOwnsRecovery(sessionId)) return false;
    return row.source !== 'bot' || (deps.ownerEpoch() === owner && !deps.isPaused(sessionId)
      && !deps.isShared(sessionId) && !!context && deps.ownsCompanionInput(sessionId, context));
  }
  return {
    usageLimit: (sessionId: string) => eligible(sessionId),
    providerGroup: (sessionId: string, context: ProviderGroupEligibilityContext) => eligible(sessionId, context),
  };
}
