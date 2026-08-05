import type { RemoteSession } from '@/session/types';
import { isPreconditionFailedRemoteError } from '@cindy/maker-shared/device-link-contract';
export {
  summarizeAccountRateLimits,
  summarizeCodexRateLimitReset,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '@cindy/maker-shared/session-controls';

/** Local ChatGPT quota controls are only relevant to local Codex subscription sessions. */
export function canUseLocalCodexRateLimitControl(
  session: Pick<RemoteSession, 'agentKind' | 'model' | 'providerId' | 'remoteHostId'> | null,
): boolean {
  if (session?.agentKind !== 'codex' || session.remoteHostId?.trim()) return false;
  const providerId = session.providerId?.trim() ?? '';
  const model = session.model.trim();
  return (providerId === '' || providerId === 'openai')
    && !model.startsWith('codex/')
    && !model.startsWith('chatgpt/')
    && !model.startsWith('xai/');
}

/** Legacy usage is safe only when the authoritative read failed for a non-identity reason. */
export function shouldFallbackToLegacyCodexUsage(error: unknown): boolean {
  return !isPreconditionFailedRemoteError(error);
}

export function buildContextUsageCreateOpts(session: RemoteSession): Record<string, unknown> {
  return {
    agentKind: session.agentKind === 'codex' || session.agentKind === 'pi'
      ? session.agentKind
      : 'claude-code',
    workingDir: session.workingDir ?? '',
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    fastMode: session.fastMode,
  };
}
