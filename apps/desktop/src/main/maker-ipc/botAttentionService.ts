import { getDbClient } from '../localDb/client/current.js';
import {
  classifyBotFailureReason,
  isBotFailureAttentionWorthy,
  type BotFailureReason,
} from '../../shared/botFailureReason.js';

export interface BotAttentionWriteResult {
  reason: BotFailureReason | null;
  changed: boolean;
}

/**
 * Persist only Hermes-style failures that need durable user action. Transient
 * transport/provider errors remain in their native diagnostics and retries.
 */
export async function noteBotAttention(input: {
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
  return { reason, changed: result.changed };
}

/** A successful, newer Bot-owned operation clears an older durable failure. */
export async function clearBotAttention(input: {
  botId: string;
  successfulAt?: number;
}): Promise<BotAttentionWriteResult> {
  const result = await getDbClient().tx<{ changed: boolean }>('bots.updateAttention', {
    botId: input.botId,
    reason: null,
    observedAt: input.successfulAt ?? Date.now(),
  });
  return { reason: null, changed: result.changed };
}
