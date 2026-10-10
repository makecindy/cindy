import { isBotGroupRuntimeFailureCode, type BotGroupRuntimeFailureCode } from '../../shared/botGroupChat.js';
import { isPiImageInputUnsupportedError } from '../../shared/inputError.js';
import type { BotGroupChatService } from './botGroupChatService.js';

export const BOT_GROUP_RUNTIME_FAILURE_PREFIX = 'cindy-runtime-error:';

/** Classify on the executor. Only the fixed category is visible to other group members. */
export function botGroupRuntimeFailureCode(error: unknown): BotGroupRuntimeFailureCode {
  if (isPiImageInputUnsupportedError(error)) return 'IMAGE_INPUT_UNSUPPORTED';
  const data = error && typeof error === 'object' ? error as { code?: unknown; reason?: unknown; message?: unknown } : null;
  const values = [data?.code, data?.reason, data?.message, error instanceof Error ? error.message : error];
  for (const value of values) {
    if (typeof value === 'string' && isPiImageInputUnsupportedError(value)) return 'IMAGE_INPUT_UNSUPPORTED';
    if (isBotGroupRuntimeFailureCode(value)) return value;
  }
  const text = values.filter((value): value is string => typeof value === 'string').join('\n');
  if (/\b(?:MODEL_NOT_FOUND|MODEL_UNAVAILABLE|NO_AVAILABLE_MODEL|BOT_MODEL_REQUIRED|MODEL_REQUIRED)\b/i.test(text)) return 'MODEL_UNAVAILABLE';
  if (/\b(?:AUTH_REQUIRED|INVALID_TOKEN|TOKEN_EXPIRED|UNAUTHORIZED|invalid_api_key|authentication_error)\b/i.test(text)) return 'AUTH_REQUIRED';
  if (/\b(?:QUOTA_EXCEEDED|USAGE_LIMIT_EXCEEDED|INSUFFICIENT_BALANCE|insufficient_quota)\b/i.test(text)) return 'QUOTA_EXCEEDED';
  if (/\b(?:RATE_LIMITED|RATE_LIMIT_EXCEEDED|rate_limit_error)\b|too many requests/i.test(text)) return 'RATE_LIMITED';
  if (/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|REQUEST_TIMEOUT)\b|fetch failed|socket hang up/i.test(text)) return 'NETWORK_ERROR';
  return 'RUNTIME_ERROR';
}

export function botGroupRuntimeFailureDetail(code: BotGroupRuntimeFailureCode): string {
  return `${BOT_GROUP_RUNTIME_FAILURE_PREFIX}${code}`;
}

export function readBotGroupRuntimeFailureDetail(value: unknown): BotGroupRuntimeFailureCode | undefined {
  if (typeof value !== 'string' || !value.startsWith(BOT_GROUP_RUNTIME_FAILURE_PREFIX)) return undefined;
  const code = value.slice(BOT_GROUP_RUNTIME_FAILURE_PREFIX.length);
  return isBotGroupRuntimeFailureCode(code) ? code : undefined;
}

/** A persisted input can fail without producing any Agent terminal event. */
export async function settleUndispatchedBotGroupTurn(
  service: Pick<BotGroupChatService, 'settleLaneTurn'> | null,
  sessionId: string,
  clientId: string,
  disposition: 'failed' | 'cancelled',
  error: unknown,
): Promise<boolean> {
  if (disposition !== 'failed' || !service) return false;
  return service.settleLaneTurn({ sessionId, activeInputClientId: clientId, outcome: 'error',
    resultText: '', failureCode: botGroupRuntimeFailureCode(error), undispatched: true });
}
