export const BOT_FAILURE_REASONS = [
  'runtime_offline',
  'queued_expired',
  'delivery_timeout',
  'agent_blocked',
  'cancelled',
  'provider_auth_or_access',
  'provider_quota_limit',
  'provider_rate_limit',
  'provider_server_error',
  'context_overflow',
  'missing_config',
  'model_unavailable',
  'unknown',
] as const;

export type BotFailureReason = (typeof BOT_FAILURE_REASONS)[number];

const REASON_SET = new Set<string>(BOT_FAILURE_REASONS);
const ATTENTION_REASONS = new Set<BotFailureReason>([
  'agent_blocked',
  'missing_config',
  'provider_auth_or_access',
  'provider_quota_limit',
]);

function typedReason(value: unknown): BotFailureReason | null {
  if (typeof value === 'string' && REASON_SET.has(value)) return value as BotFailureReason;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['reason', 'reasonCode', 'failureReason', 'errorCode']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && REASON_SET.has(candidate)) {
      return candidate as BotFailureReason;
    }
  }
  return null;
}

function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value == null) return '';
  try {
    return JSON.stringify(value).slice(0, 8_000);
  } catch {
    return String(value).slice(0, 8_000);
  }
}

/** Ordered to match Hermes: auth wins over quota words inside a provider 401 body. */
export function classifyBotFailureReason(value: unknown): BotFailureReason {
  const exact = typedReason(value);
  if (exact) return exact;
  const text = searchableText(value);
  if (!text.trim()) return 'unknown';
  if (
    /authentication_error|invalid api key|(?:error code:?\s*|status(?:\s*code)?:?\s*|http\s*)(?:401|403)\b/i.test(text)
  ) return 'provider_auth_or_access';
  if (
    /(?:error code:?\s*|status(?:\s*code)?:?\s*|http\s*)402\b|out of funds|quota|balance/i.test(text)
  ) return 'provider_quota_limit';
  if (
    /(?:error code:?\s*|status(?:\s*code)?:?\s*|http\s*)429\b|rate.?limit/i.test(text)
  ) return 'provider_rate_limit';
  if (
    /(?:error code:?\s*|status(?:\s*code)?:?\s*|http\s*)5\d{2}\b|server error|overloaded/i.test(text)
  ) return 'provider_server_error';
  if (/context length|context_overflow|maximum context/i.test(text)) return 'context_overflow';
  if (/no llm provider configured|missing config|no access token/i.test(text)) return 'missing_config';
  if (/model .*(?:not found|does not exist)|model_not_found/i.test(text)) return 'model_unavailable';
  if (/agent (?:is )?blocked|awaiting approval|waiting for approval/i.test(text)) return 'agent_blocked';
  return 'unknown';
}

export function isBotFailureAttentionWorthy(reason: BotFailureReason): boolean {
  return ATTENTION_REASONS.has(reason);
}
