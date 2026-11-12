/** Public progress only. Generated drafts remain in the owning local database. */
export type BotInvitationStage = 'profile' | 'skills' | 'avatar' | 'welcome' | 'ready' | 'failed';
export interface BotInvitationProgress {
  stage: BotInvitationStage;
  avatarSkipped?: boolean;
  avatarRequested?: boolean;
}

export function botInvitationProgress(value: unknown): BotInvitationProgress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { stage, avatarSkipped, avatarRequested } = value as Record<string, unknown>;
  if (!['profile', 'skills', 'avatar', 'welcome', 'ready', 'failed'].includes(String(stage)))
    return undefined;
  return {
    stage: stage as BotInvitationStage,
    avatarRequested: avatarRequested === true,
    ...(avatarSkipped === true ? { avatarSkipped } : {}),
  };
}
