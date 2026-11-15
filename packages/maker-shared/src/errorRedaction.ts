export const REMOTE_COMPACT_ENCRYPTED_CONTENT_REASON = 'remote-compact-encrypted-content';

/**
 * Raw failures require explicit ciphertext evidence. For persisted UI errors,
 * the old overflow reason plus the exact bare wrapper recovers details that an
 * older translator discarded. Concrete error details must keep their meaning.
 */
export function isRemoteCompactEncryptedContentError(message: string, reason?: unknown): boolean {
  if (reason === REMOTE_COMPACT_ENCRYPTED_CONTENT_REASON || /\bCINDY_ENCRYPTED_COMPACTION_INCOMPATIBLE\b/.test(message)) return true;
  return (/remote compact/i.test(message) && /invalid_encrypted_content/i.test(message))
    || (reason === 'context-overflow' && /^Error running remote compact task$/i.test(message.trim()));
}

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

/**
 * Recursively apply `redactSensitiveText` to every string leaf of an unknown
 * structure, preserving keys and shape.
 *
 * Why this exists: error rows are persisted as `{ message, reason?, sdkError?,
 * toolLoop?, providerId? }` but only `message` / `sdkError` pass through
 * `redactSensitiveText` on the write path — `reason` is stored verbatim. Any
 * exit that hands error rows to another process or device must therefore
 * redact on the way out, otherwise raw operator-visible strings can leave the
 * controlled device.
 *
 * Non-string leaves (number / boolean / null / undefined) are returned as-is;
 * the intent is masking, not coercion. Input is expected to come from
 * JSON.parse, so reference cycles are not handled.
 */
export function redactSensitiveTextDeep(input: unknown): unknown {
  if (typeof input === 'string') return redactSensitiveText(input);
  if (Array.isArray(input)) return input.map((item) => redactSensitiveTextDeep(item));
  if (input && typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = redactSensitiveTextDeep(value);
    }
    return output;
  }
  return input;
}

export interface NonSecretErrorSignals {
  errorStatus?: 401 | 403 | 429 | 529;
  usageLimit: boolean;
}

const DETERMINISTIC_USAGE_EXHAUSTION_PATTERNS = [
  // #8705: LiteLLM may retain only the structured error type in the message.
  /\binsufficient_balance_error\b/i,
  /\binsufficient[-_ ]?quota\b/i,
  /\binsufficient.{0,12}\b(?:balance|credit|funds)\b/i,
  /\bquota\b.{0,24}\b(?:exhausted|exceeded)\b/i,
  /\b(?:exhausted|exceeded)\b.{0,24}\bquota\b/i,
  /\busage\s+limit\b/i,
  /\b(?:exceeded[-_]?budget|budget[-_]?exceeded)\b/i,
  /\b(?:account|session|usage)\s+budget\b.{0,16}\b(?:exhausted|exceeded)\b/i,
  /\b(?:exhausted|exceeded)\b.{0,16}\b(?:account|session|usage)\s+budget\b/i,
  // ChatGPT workspace member spend cap (Codex): "You hit your spend cap set by the
  // owner of your workspace". The owner must raise it; waiting does not help.
  /\bspend(?:ing)?[-_ ]?cap\b/i,
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
    /(?:^|[\s,{;])["']?(?:status(?:[-_ ]?code)?|http(?:[-_ ]?status)?|code)["']?\s*(?:[:=]\s*)?["']?(401|403|429|529)["']?(?=$|[\s,;:}\]])/i.exec(
      input,
    ) ?? /\brequest\s+rejected\s*\(\s*(401|403|429|529)\s*\)/i.exec(input);
  const usageLimit =
    /(?:^|[\s,{;])(?:rate\s+limit(?:ed|s|ing)?|usage\s+limit(?:ed|s|ing)?|too\s+many\s+requests|quota(?:["']?\s*[:=]\s*["']?|\s+)(?:exhausted|exceeded)|(?:["']?(?:code|type|error|message)["']?\s*[:=]\s*["']?)?(?:rate_limit_exceeded|insufficient_quota|exceeded[-_ ]?budget|budget[-_ ]?exceeded))\b/i.test(
      input,
    );

  // Do not promote an unstructured permission denial into the newly supported
  // provider 403 signal. Callers still preserve an explicit SDK errorStatus.
  const errorStatus = statusMatch
    && !(statusMatch[1] === '403' && /permission denied/i.test(input))
    ? Number(statusMatch[1]) as NonSecretErrorSignals['errorStatus']
    : undefined;
  return {
    ...(errorStatus !== undefined ? { errorStatus } : {}),
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

/** The Lite transport rejects an omitted parallel-tool flag; this is a client request error, not auth. */
export function isResponsesLiteParallelToolCallsError(message: string): boolean {
  return /X-OpenAI-Internal-Codex-Responses-Lite requires `?parallel_tool_calls`? to be false\./i.test(message);
}

/** UI-only recovery offer. A premature close does not establish an encryption failure. */
export function canOfferCodexHistoryRecovery(input: {
  message: string;
  agentKind?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  running?: boolean;
}): boolean {
  return input.agentKind === 'codex' && !input.remoteHostId && !input.agentDeviceId &&
    !input.running && /stream disconnected before completion:\s*stream closed before response\.completed\b/i.test(input.message);
}

const AGENT_CHAT_ERROR_CODES: ReadonlySet<string> = new Set([
  'SUBSCRIPTION_ACCOUNT_LIMITED',
  'SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED',
  'SUBSCRIPTION_ACCOUNT_SIGNING_IN',
  'SUBSCRIPTION_ACCOUNT_UNAVAILABLE',
  'SSH_HARNESS_SWITCH_UNSUPPORTED',
  'MODEL_SELECTION_UNAVAILABLE',
  'SUBSCRIPTION_ACCOUNTS_FULL',
  'HARNESS_SWITCH_NOT_READY',
  'DEVICE_LINK_BUSY',
  'DEVICE_LINK_CONTROL_DISABLED',
  'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
  'DEVICE_LINK_MEDIA_ACCESS_DENIED',
  'AUTO_REVIEW_UNAVAILABLE',
  'AUTO_REVIEW_CONFIRM_UNDELIVERED',
  'MCP_APPROVAL_AUTO_BLOCKED',
  'MCP_APPROVAL_CONFIRMATION_TIMEOUT',
  'MCP_APPROVAL_CONFIRMATION_UNAVAILABLE',
]);

/** Parse the runtime envelope, including Electron and device-link IPC wrappers.
 * A parsed code is only a translation candidate: unknown REMOTE codes must not
 * promote their upstream fallback text into localized user-facing guidance.
 */
export function parseAgentErrorCode(message: string): { code: string; fallback: string } | null {
  // Host send failures wrap the original startup error in a stable
  // `LAZY_CREATE_FAILED:` envelope. Keep accepting that wrapper here so the
  // renderer can still select the actionable remote-provider guidance instead
  // of collapsing the whole failure to the generic "reply failed" card.
  const match = /(?:^|: Error: )(?:\[IPC_ERROR\]\s*)?(?:(?:LAZY_CREATE_FAILED|REHYDRATE_FAILED):\s*)?\[([A-Z0-9_]+)\]\s*([\s\S]*)$/.exec(message);
  if (!match || (!/^REMOTE_[A-Z_]+$/.test(match[1]) && !AGENT_CHAT_ERROR_CODES.has(match[1]))) {
    return null;
  }
  // Released guest hosts and Pi use INVALID for a specific native-history
  // rejection. Refine only its presentation; keep the wire error and ownership
  // check intact. Other INVALID errors must not suggest a history recovery.
  const code = match[1] === 'REMOTE_AGENT_INVALID'
    && /^this conversation cannot be resumed on this computer\.?$/i.test(match[2].trim())
    ? 'REMOTE_AGENT_RESUME_UNAVAILABLE' : match[1];
  return { code, fallback: match[2] || message };
}

/**
 * Presentation-only recognition of runHost's guest ownership refusal (#10187).
 * Keep the exact message: other INVALID errors, including Pi's differently
 * capitalized/punctuated refusal, have not established this recovery condition.
 * This never authorizes clearing native ids, moving a task or consuming input.
 */
export function isRemoteAgentResumeRejectedError(message: string): boolean {
  const parsed = parseAgentErrorCode(message);
  return parsed?.code === 'REMOTE_AGENT_RESUME_UNAVAILABLE'
    && parsed.fallback.trim() === 'this conversation cannot be resumed on this computer';
}

/** Resending unchanged content cannot fix these explicit configuration/startup failures. */
export function requiresAgentErrorConfigurationChange(message: string): boolean {
  const code = parseAgentErrorCode(message)?.code;
  return isRemoteAgentResumeRejectedError(message)
    || code === 'REMOTE_LOCAL_ATTACHMENT_UNSUPPORTED'
    || code === 'REMOTE_COMPAT_MODE_UNSUPPORTED'
    || code === 'REMOTE_LOCAL_ONLY_PROVIDER'
    || code === 'DEVICE_LINK_CONTROL_DISABLED'
    || code === 'REMOTE_AGENT_RESUME_UNAVAILABLE';
}

/** Presentation only: startup failures must not be mistaken for a new retry policy.
 * Account identities are intentionally absent from the wire error. Old hosts have
 * only an ambiguous message; never infer a login or limit cause from that text.
 */
export function localizeSubscriptionAccountError(
  message: string,
  translate: (key: string, options?: { resetAt: string }) => string,
  locale?: string,
): string | null {
  const parsed = parseAgentErrorCode(message);
  switch (parsed?.code) {
    case 'SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED': return translate('chat.subscriptionAccountError.loginRequired');
    case 'SUBSCRIPTION_ACCOUNT_SIGNING_IN': return translate('chat.subscriptionAccountError.signingIn');
    case 'SUBSCRIPTION_ACCOUNT_UNAVAILABLE': return translate('chat.subscriptionAccountError.unavailable');
    case 'SUBSCRIPTION_ACCOUNT_LIMITED': {
      const reset = Number(/(?:^|\n)resetAtMs=(\d{1,16})(?:\n|$)/.exec(parsed.fallback)?.[1]);
      if (Number.isSafeInteger(reset) && reset > Date.now() && reset <= 8.64e15) {
        // Classical editions use the corresponding script for Intl formatting.
        const language = locale?.replace(/-x-lzh$/, '');
        const resetAt = new Intl.DateTimeFormat(language, {
          dateStyle: 'medium', timeStyle: 'short',
        }).format(new Date(reset));
        return translate('chat.subscriptionAccountError.limitedUntil', { resetAt });
      }
      return translate('chat.subscriptionAccountError.limited');
    }
  }
  if (/(?:^|: Error: )(?:\[IPC_ERROR\]\s*)?(?:LAZY_CREATE_FAILED:\s*)?The task subscription account requires login or quota reset$/.test(message))
    return translate('chat.subscriptionAccountError.legacy');
  return null;
}
