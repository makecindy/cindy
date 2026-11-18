/** Counts are disjoint: input excludes cache reads/writes. Missing facts stay absent. */
export interface AuxiliaryTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}
export interface AuxiliaryAttribution {
  providerId?: string;
  model?: string;
  source?: string;
  sessionId?: string;
  transport?: string;
}
export type AuxiliaryUsageRecorder = ((
  tokens: AuxiliaryTokens,
  route?: AuxiliaryAttribution,
  receiptId?: string,
) => Promise<void>) & { close(): void };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function usageTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** Protocol prompt totals include cached input on OpenAI, but exclude it on Messages. */
export function parseAuxiliaryTokens(body: unknown, wire: string): AuxiliaryTokens | null {
  const record = object(body);
  const usage = object(
    record.usage ?? object(record.response).usage ?? object(record.message).usage,
  );
  const google = object(record.usageMetadata);
  if (Object.keys(google).length) {
    const input = usageTokenCount(google.promptTokenCount);
    const cache = usageTokenCount(google.cachedContentTokenCount);
    const output = usageTokenCount(google.candidatesTokenCount);
    const thinking = usageTokenCount(google.thoughtsTokenCount);
    const tokens = {
      inputTokens: input === undefined ? undefined : Math.max(0, input - (cache ?? 0)),
      outputTokens:
        output === undefined && thinking === undefined
          ? undefined
          : (output ?? 0) + (thinking ?? 0),
      cacheReadTokens: cache,
    };
    return Object.values(tokens).some((value) => value !== undefined) ? tokens : null;
  }
  const read = usageTokenCount(
    usage.cache_read_input_tokens ??
      object(usage.input_tokens_details).cached_tokens ??
      object(usage.prompt_tokens_details).cached_tokens,
  );
  const input = usageTokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const tokens: AuxiliaryTokens = {
    inputTokens:
      input === undefined
        ? undefined
        : wire === 'anthropic-messages'
          ? input
          : Math.max(0, input - (read ?? 0)),
    outputTokens: usageTokenCount(usage.output_tokens ?? usage.completion_tokens),
    cacheReadTokens: read,
    cacheCreateTokens: usageTokenCount(usage.cache_creation_input_tokens),
  };
  return Object.values(tokens).some((value) => value !== undefined) ? tokens : null;
}
/** SSE usage is cumulative and often split between message_start and message_delta. */
export function parseAuxiliaryResponse(
  raw: string,
  wire: string,
): {
  tokens: AuxiliaryTokens | null;
  model?: string;
} {
  const parts = raw.trimStart().startsWith('{')
    ? [raw]
    : raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
  const accumulator = createAuxiliaryUsageAccumulator(wire);
  for (const part of parts) {
    try {
      accumulator.observe(JSON.parse(part));
    } catch {
      /* Keep complete earlier usage when the last frame is truncated. */
    }
  }
  return accumulator.snapshot();
}

/** Merge raw cumulative counters before splitting cached input from prompt totals. */
export function createAuxiliaryUsageAccumulator(wire: string) {
  let merged: Record<string, unknown> = {};
  let model: string | undefined;
  let google: Record<string, unknown> = {};
  return {
    observe(body: unknown): void {
      const root = object(body);
      const response = object(root.response ?? root.message ?? root);
      if (typeof response.model === 'string' && response.model) model = response.model;
      google = { ...google, ...object(root.usageMetadata) };
      if (!model && typeof root.modelVersion === 'string') model = root.modelVersion;
      const usage = object(root.usage ?? response.usage);
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number' && typeof merged[key] === 'number') {
          merged[key] = Math.max(merged[key] as number, value);
        } else if (value && typeof value === 'object') {
          merged[key] = { ...object(merged[key]), ...object(value) };
        } else {
          merged[key] = value;
        }
      }
    },
    snapshot() {
      return {
        tokens: parseAuxiliaryTokens({ usage: merged, usageMetadata: google }, wire),
        model,
      };
    },
  };
}
