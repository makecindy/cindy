/**
 * Error classification for the Google AI Ultra Interactions endpoint
 * (`POST /v1beta/interactions:createPerUserQuota`).
 *
 * Parses all three response shapes Google returns (JSON object, JSON array of
 * `google.rpc.Status`, and SSE `event: error` / `data:` frames) and separates
 * retryable per-minute 429s from terminal daily limits, ineligible plans,
 * scope errors, and client kill-switch rejections.
 */

export interface GoogleInteractionsError {
  message: string;
  final: boolean;
  kind:
    | 'per-minute-rate-limit'
    | 'daily-limit'
    | 'not-on-plan'
    | 'auth-required'
    | 'client-unauthorized'
    | 'plan-ineligible'
    | 'other';
}

interface ParsedErrorBody {
  message: string;
  reason?: string;
  perDayQuota?: { limit?: number };
}

type RateLimitKind =
  | { kind: 'per-minute' }
  | { kind: 'not-on-plan' }
  | { kind: 'daily'; resetInMessage: boolean };

const GOOGLE_AI_PLANS_URL = 'https://one.google.com/ai';
const SIGN_IN_AGAIN_HINT = 'Sign in again in Settings → Model Providers.';

export function classifyGoogleInteractionsError(input: {
  status: number;
  headers: Headers;
  body: string;
  modelId: string;
}): GoogleInteractionsError {
  const { status, headers, modelId } = input;
  const error = parseErrorBody(input.body);
  const compose = (hint?: string) => [String(status), error.message, hint].filter(Boolean).join(' ');

  if (status === 429) {
    const rateLimit = classifyRateLimit(error);
    switch (rateLimit.kind) {
      case 'per-minute':
        return { message: compose(), final: false, kind: 'per-minute-rate-limit' };
      case 'not-on-plan':
        return { message: compose(notOnPlanHint(modelId)), final: true, kind: 'not-on-plan' };
      case 'daily': {
        const reset = rateLimit.resetInMessage ? '' : formatReset(headers);
        const hint = `Daily limit reached for ${modelId}${reset}: switch to another model, or use a Gemini API key.`;
        return { message: compose(hint), final: true, kind: 'daily-limit' };
      }
    }
  }

  if (status === 400 && /not supported for per-user quota/i.test(error.message)) {
    return { message: compose(notOnPlanHint(modelId)), final: true, kind: 'not-on-plan' };
  }
  if (status === 401) {
    return { message: compose(SIGN_IN_AGAIN_HINT), final: true, kind: 'auth-required' };
  }
  if (
    status === 403 &&
    (error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      /insufficient authentication scopes/i.test(error.message))
  ) {
    return { message: compose(SIGN_IN_AGAIN_HINT), final: true, kind: 'auth-required' };
  }
  if (
    status === 403 &&
    (error.reason === 'SERVICE_DISABLED' || /oauth client is not authorized/i.test(error.message))
  ) {
    return {
      message: compose(
        'The Google AI Ultra OAuth client is not currently enabled or approved for this endpoint.',
      ),
      final: true,
      kind: 'client-unauthorized',
    };
  }
  if (status === 402 || status === 403) {
    return {
      message: compose(
        `Your Google account does not have an eligible Google AI Ultra plan. Upgrade at ${GOOGLE_AI_PLANS_URL}, or use a Gemini API key.`,
      ),
      final: true,
      kind: 'plan-ineligible',
    };
  }

  return { message: compose(), final: status >= 400 && status < 500, kind: 'other' };
}

function classifyRateLimit(error: ParsedErrorBody): RateLimitKind {
  const dailyMessage = /reached today's .*? limit/i.test(error.message);
  const perDayMessage =
    /rate limit exceeded(?: for model \S+)? \(limit: (\d+) (?:tokens|requests) per day\)/i.exec(
      error.message,
    );
  if (!dailyMessage && !perDayMessage && !error.perDayQuota) return { kind: 'per-minute' };
  if (error.perDayQuota?.limit === 0 || perDayMessage?.[1] === '0') return { kind: 'not-on-plan' };
  return { kind: 'daily', resetInMessage: dailyMessage };
}

function notOnPlanHint(modelId: string): string {
  return `${modelId} is not available on the Google AI Ultra plan. Choose another model.`;
}

function formatReset(headers: Headers): string {
  const seconds = Number(headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return ` (resets in ${hours > 0 ? `${hours}h ` : ''}${minutes}m)`;
}

function parseErrorBody(body: string): ParsedErrorBody {
  const trimmed = body.trim();
  const json = /^[[{]/.test(trimmed)
    ? trimmed
    : trimmed
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? '');
  } catch {
    return { message: trimmed };
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = (first as { error?: { message?: unknown; details?: unknown } } | null)?.error;
  if (typeof error?.message !== 'string') return { message: trimmed };
  const details = Array.isArray(error.details) ? (error.details as Record<string, unknown>[]) : [];
  const reason = details.find((d) => String(d['@type']).endsWith('google.rpc.ErrorInfo'))?.reason;
  const violations = details.find((d) =>
    String(d['@type']).endsWith('google.rpc.QuotaFailure'),
  )?.violations;
  const perDay = Array.isArray(violations)
    ? (violations as Array<{ quotaId?: unknown; quotaValue?: unknown }>).find(
        (v) => typeof v.quotaId === 'string' && v.quotaId.includes('PerDay'),
      )
    : undefined;
  const rawLimit = perDay?.quotaValue;
  const limit =
    typeof rawLimit === 'number' || (typeof rawLimit === 'string' && rawLimit.trim())
      ? Number(rawLimit)
      : Number.NaN;
  return {
    message: error.message,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(perDay ? { perDayQuota: Number.isFinite(limit) ? { limit } : {} } : {}),
  };
}
