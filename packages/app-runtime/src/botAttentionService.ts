import type { DbClient } from '@cindy/runtime-db';
import {
  classifyBotFailureReason,
  isBotFailureAttentionWorthy,
  type BotFailureReason,
} from '@cindy/companion-core/botFailureReason';

export interface BotAttentionWriteResult {
  reason: BotFailureReason | null;
  changed: boolean;
}

export function createBotAttentionService(getDbClient: () => DbClient, broadcastBotRemoteResourceChanged: (botId: string) => void) {
/**
 * Persist only Hermes-style failures that need durable user action. Transient
 * transport/provider errors remain in their native diagnostics and retries.
 */
async function noteBotAttention(input: {
  botId: string;
  failure: unknown;
  observedAt?: number;
}): Promise<BotAttentionWriteResult> {
  const reason = classifyBotFailureReason(input.failure);
  if (!isBotFailureAttentionWorthy(reason)) return { reason, changed: false };
  const result = await getDbClient().tx<{ changed: boolean }>('bots.updateAttention', {
    botId: input.botId,
    reason,
    observedAt: input.observedAt ?? Date.now(),
  });
  if (result.changed) broadcastBotRemoteResourceChanged(input.botId);
  return { reason, changed: result.changed };
}

/** A successful, newer Bot-owned operation clears an older durable failure. */
async function clearBotAttention(input: {
  botId: string;
  successfulAt?: number;
}): Promise<BotAttentionWriteResult> {
  const result = await getDbClient().tx<{ changed: boolean }>('bots.updateAttention', {
    botId: input.botId,
    reason: null,
    observedAt: input.successfulAt ?? Date.now(),
  });
  if (result.changed) broadcastBotRemoteResourceChanged(input.botId);
  return { reason: null, changed: result.changed };
}

return { noteBotAttention, clearBotAttention };
}
