import type { BotCompactRuntimeRefreshOutcome } from './botCompactRuntimeRefresh.js';

export type BotRuntimeEpochRefreshReason = 'profile' | 'resource' | 'model';

type BotRuntimeEpochRefreshRequest = (
  sessionId: string,
  reason: BotRuntimeEpochRefreshReason,
) => Promise<BotCompactRuntimeRefreshOutcome>;

let requestRefresh: BotRuntimeEpochRefreshRequest | null = null;

/** Composition-root bridge: storage can request a safe runtime rebuild
 * without importing or owning the Maker Session runtime. */
export function configureBotRuntimeEpochRefreshRequest(
  handler: BotRuntimeEpochRefreshRequest | null,
): void {
  requestRefresh = handler;
}

/** Keep the boolean receipt used by existing memory/Skill callers. */
export async function requestBotRuntimeEpochRefresh(
  sessionId: string,
  reason: BotRuntimeEpochRefreshReason,
): Promise<boolean> {
  return await requestBotRuntimeEpochRefreshOutcome(sessionId, reason) === 'refreshed';
}

/** Target configuration needs failure evidence, not just whether a rebuild ran. */
export async function requestBotRuntimeEpochRefreshOutcome(
  sessionId: string,
  reason: BotRuntimeEpochRefreshReason,
): Promise<BotCompactRuntimeRefreshOutcome | 'unavailable'> {
  if (!requestRefresh) return 'unavailable';
  try {
    return await requestRefresh(sessionId, reason);
  } catch {
    // The resource write succeeded even if rebuilding its runtime failed.
    return 'failed';
  }
}
