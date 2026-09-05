export type BotRuntimeEpochRefreshReason = 'profile' | 'resource';

type BotRuntimeEpochRefreshRequest = (
  sessionId: string,
  reason: BotRuntimeEpochRefreshReason,
) => void;

let requestRefresh: BotRuntimeEpochRefreshRequest | null = null;

/** Composition-root bridge: storage can request a safe runtime rebuild
 * without importing or owning the Maker Session runtime. */
export function configureBotRuntimeEpochRefreshRequest(
  handler: BotRuntimeEpochRefreshRequest | null,
): void {
  requestRefresh = handler;
}

export function requestBotRuntimeEpochRefresh(
  sessionId: string,
  reason: BotRuntimeEpochRefreshReason,
): void {
  requestRefresh?.(sessionId, reason);
}
