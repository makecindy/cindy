const INPUT_METRIC = 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count';

interface GoogleError {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  details?: unknown;
}

/** Pi can wrap the entire Google error as a JSON string inside error.message. */
export function parseGeminiInputRateLimit(raw?: string): { retryDelayMs: number | null } | null {
  if (!raw || !raw.includes(INPUT_METRIC) || raw.length > 128_000) return null;
  let text = raw;
  for (let depth = 0; depth < 2; depth++) {
    let error: GoogleError | undefined;
    try {
      error = JSON.parse(text)?.error;
    } catch {
      return null;
    }
    if (typeof error?.message !== 'string') return null;
    text = error.message.trim();
    if (text.startsWith('{')) continue;
    if (error.code !== 429 || error.status !== 'RESOURCE_EXHAUSTED') return null;
    let minuteLimit = text.includes(INPUT_METRIC) && /input tokens per minute limit exceeded/i.test(text);
    const delays: number[] = [];
    const seconds = /\bplease retry in (\d+(?:\.\d+)?)s\b/i.exec(text)?.[1];
    if (seconds) delays.push(Number(seconds));
    for (const detail of Array.isArray(error.details) ? error.details : []) {
      if (detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' && Array.isArray(detail.violations)) {
        for (const violation of detail.violations) {
          if (violation?.quotaMetric !== INPUT_METRIC || typeof violation.quotaId !== 'string' ||
              !/perminute/i.test(violation.quotaId) || String(violation.quotaValue) === '0') return null;
          minuteLimit = true;
        }
      }
      if (detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
        const duration = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay)?.[1];
        if (duration) delays.push(Number(duration));
      }
    }
    // RetryInfo sometimes rounds down to whole seconds. Respect the longer hint.
    if (!minuteLimit) return null;
    const ms = Math.ceil(Math.max(...delays) * 1000);
    return { retryDelayMs: ms > 0 && ms <= 2_147_483_647 ? ms : null };
  }
  return null;
}
