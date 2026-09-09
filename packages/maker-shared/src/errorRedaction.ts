/**
 * Remove credentials and credential-like values from user-visible or persisted
 * error text while keeping the surrounding diagnostic context.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return input;

  // Authorization values may use non-Bearer schemes (for example
  // `Basic <base64>`). Scan these fields directly so an attacker cannot make
  // a regex retry an unbounded value match at many `authorization(` offsets.
  let output = redactCredentialHeaderFields(input);

  // `token` is intentionally conservative here: error payloads frequently
  // carry credentials under this generic name. This may redact non-secret
  // cursors, but avoids leaking an unknown token-shaped credential. `key` is
  // included for opaque custom-provider keys and OAuth client secrets that do
  // not use a known prefix.
  output = output.replace(
    /((?:["']?)key(?:["']?)\s*(?:\([^)\r\n]{0,256}\)\s*)?(?:=|:)\s*)(?:sk|pk|rk)-[A-Za-z0-9][A-Za-z0-9._-]{6,}\b/gi,
    '$1[REDACTED_KEY]',
  );
  output = output.replace(
    /((?:["']?)(?:x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|proxy[-_ ]?token|client[-_ ]?secret|received\s+api\s+key|key\s+hash|key|secret|password|passwd|token)(?:["']?)\s*(?:\([^)\r\n]{0,256}\)\s*)?(?:=|:)\s*)(?!\[REDACTED(?:_KEY)?\])(?:"[^"]*"|'[^']*'|<[^>]*>|Bearer\s+[A-Za-z0-9._~+/=-]+|[^\s,;}\]]+)/gi,
    '$1[REDACTED]',
  );
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  output = output.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9][A-Za-z0-9._-]{6,}\b/g, '[REDACTED_KEY]');
  output = output.replace(
    /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token)=)[^&#\s]+/gi,
    '$1[REDACTED]',
  );
  // Gateway principals (`aigw:...`) are stable per-user identifiers; quota and
  // routing errors embed them verbatim. Strip the whole value so persisted or
  // displayed errors cannot leak an internal user id. The negative lookahead
  // keeps this idempotent: without it a second pass matches `aigw:[REDACTED`
  // (`]` is in the excluded set) and grows the placeholder to `[REDACTED]]`.
  output = output.replace(/\baigw:(?!\[REDACTED\])[^\s"'`,;)\]}]+/gi, 'aigw:[REDACTED]');
  return output;
}

export interface NonSecretErrorSignals {
  errorStatus?: 401 | 429 | 529;
  usageLimit: boolean;
}

const DETERMINISTIC_USAGE_EXHAUSTION_PATTERNS = [
  /\binsufficient[-_ ]?quota\b/i,
  /\binsufficient.{0,12}\b(?:balance|credit|funds)\b/i,
  /\bquota\b.{0,24}\b(?:exhausted|exceeded)\b/i,
  /\b(?:exhausted|exceeded)\b.{0,24}\bquota\b/i,
  /\busage\s+limit\b/i,
  /\b(?:exceeded[-_]?budget|budget[-_]?exceeded)\b/i,
  /\b(?:account|session|usage)\s+budget\b.{0,16}\b(?:exhausted|exceeded)\b/i,
  /\b(?:exhausted|exceeded)\b.{0,16}\b(?:account|session|usage)\s+budget\b/i,
  /余额不足|欠费/i,
];

/**
 * Match only explicit account/quota/budget exhaustion text whose recovery
 * requires more capacity or a reset. Unlike `usageLimit` below, this strict
 * signal deliberately excludes transient rate limiting (`429`, `Too Many
 * Requests`, `rate limit`) and retry-budget exhaustion.
 */
export function matchesDeterministicUsageExhaustionText(input: string): boolean {
  return DETERMINISTIC_USAGE_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(input));
}

/**
 * Preserve explicit, non-secret routing signals before the surrounding error
 * text is redacted. Requiring a field/phrase boundary avoids interpreting
 * status-like fragments inside opaque credentials such as `tok-401-x`.
 */
export function extractNonSecretErrorSignals(input: string): NonSecretErrorSignals {
  const statusMatch =
    /(?:^|[\s,{;])["']?(?:status(?:[-_ ]?code)?|http(?:[-_ ]?status)?|code)["']?\s*(?:[:=]\s*)?["']?(401|429|529)["']?(?=$|[\s,;:}\]])/i.exec(
      input,
    ) ?? /\brequest\s+rejected\s*\(\s*(401|429|529)\s*\)/i.exec(input);
  const usageLimit =
    /(?:^|[\s,{;])(?:rate\s+limit(?:ed|s|ing)?|usage\s+limit(?:ed|s|ing)?|too\s+many\s+requests|quota(?:["']?\s*[:=]\s*["']?|\s+)(?:exhausted|exceeded)|(?:["']?(?:code|type|error|message)["']?\s*[:=]\s*["']?)?(?:rate_limit_exceeded|insufficient_quota|exceeded[-_ ]?budget|budget[-_ ]?exceeded))\b/i.test(
      input,
    );

  return {
    ...(statusMatch ? { errorStatus: Number(statusMatch[1]) as 401 | 429 | 529 } : {}),
    usageLimit,
  };
}

function redactCredentialHeaderFields(input: string): string {
  return redactHeaderFields(
    redactHeaderFields(input, ['www-authenticate', 'authorization', 'proxy-authorization'], true),
    ['set-cookie', 'cookie'],
    false,
  );
}

function redactHeaderFields(
  input: string,
  names: readonly string[],
  stopAtSemicolon: boolean,
): string {
  let output = '';
  let copyFrom = 0;
  let cursor = 0;

  while (cursor < input.length) {
    const valueStart = matchHeaderField(input, cursor, names);
    if (valueStart === null) {
      cursor += 1;
      continue;
    }

    let boundary = valueStart;
    while (
      boundary < input.length &&
      (!stopAtSemicolon || input[boundary] !== ';') &&
      input[boundary] !== '\r' &&
      input[boundary] !== '\n'
    ) {
      boundary += 1;
    }
    output += input.slice(copyFrom, valueStart);
    output += '[REDACTED]';
    copyFrom = boundary;
    cursor = boundary;
  }

  return copyFrom === 0 ? input : output + input.slice(copyFrom);
}

function matchHeaderField(
  input: string,
  start: number,
  names: readonly string[],
): number | null {
  const quote = input[start];
  const quoted = quote === '"' || quote === "'";
  const nameStart = quoted ? start + 1 : start;
  const maxNameLength = names.reduce((max, candidate) => Math.max(max, candidate.length), 0);
  const lower = input.slice(nameStart, nameStart + maxNameLength).toLowerCase();
  const name = names.find((candidate) => lower.startsWith(candidate)) ?? null;
  if (!name) return null;

  let cursor = nameStart + name.length;
  if (quoted) {
    if (input[cursor] !== quote) return null;
    cursor += 1;
  }
  while (/\s/.test(input[cursor] ?? '')) cursor += 1;

  if (input[cursor] === '(') {
    let closing = -1;
    for (let offset = 1; offset <= 256 && cursor + offset < input.length; offset += 1) {
      if (input[cursor + offset] === ')') {
        closing = cursor + offset;
        break;
      }
    }
    if (closing < 0) return null;
    cursor = closing + 1;
    while (/\s/.test(input[cursor] ?? '')) cursor += 1;
  }

  if (input[cursor] !== '=' && input[cursor] !== ':') return null;
  cursor += 1;
  while (/\s/.test(input[cursor] ?? '')) cursor += 1;
  return cursor;
}

/**
 * LiteLLM 虚拟 Key 401：请求带的网关 token 不在 VerificationTokenTable。
 * 与 Claude.ai / Codex 订阅 401 不是同一类，不能当成「去重新登录第三方」。
 */
export const GATEWAY_PROXY_TOKEN_INVALID_REASON = 'gateway-proxy-token-invalid';

/** Cindy 内置网关：显式 `xd`，或旧会话未写 provider 的隐式默认来源。 */
export function isCindyGatewayProviderId(providerId: string | null | undefined): boolean {
  return providerId == null || providerId === 'xd';
}

export function isGatewayProxyTokenInvalidError(message: string): boolean {
  if (!message) return false;
  return /invalid[\s_-]*proxy[\s_-]*server[\s_-]*token|LiteLLM_VerificationTokenTable/i.test(
    message,
  );
}

export function isCindyGatewayProxyTokenInvalidError(input: {
  reason?: string | null;
  message?: string | null;
  providerId?: string | null;
}): boolean {
  if (input.reason === GATEWAY_PROXY_TOKEN_INVALID_REASON) return true;
  return (
    isCindyGatewayProviderId(input.providerId) &&
    isGatewayProxyTokenInvalidError(input.message ?? '')
  );
}
