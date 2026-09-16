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

export async function requestBotRuntimeEpochRefresh(
  sessionId: string,
  reason: BotRuntimeEpochRefreshReason,
): Promise<boolean> {
  if (!requestRefresh) return false;
  try {
    return await requestRefresh(sessionId, reason) === 'refreshed';
  } catch {
    // The resource write succeeded even if rebuilding its runtime failed.
    return false;
  }
}
