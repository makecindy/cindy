/**
 * Server-reported generation time of one Codex model response.
 *
 * The Responses API returns, with each WebSocket response, how many tokens the
 * engine sampled and how long sampling and streaming took. Codex does not pass
 * this on through the app-server protocol; it only writes it to its trace log
 * (`codex_api::responses_websocket_timing`). Cindy enables that one target and
 * reads the line here, solely to show an exact tok/s: a response that is only a
 * tool call streams nothing the client could time, and its wait before the first
 * token varies by seconds. The line never drives any other behaviour and is not
 * written to Cindy's own logs (it carries thread and response ids).
 *
 * The payload is undocumented and its fields are known to be null in some
 * releases (openai/codex#56481): anything missing or malformed yields
 * `undefined`, and the client-side measurement stays in charge.
 */

/** Added to RUST_LOG for Cindy's local app-server: one trace line per response. */
export const CODEX_RESPONSE_TIMING_LOG_DIRECTIVE = 'codex_api::responses_websocket_timing=trace';

/** Codex writes nothing to stderr below `error` by default; keep that and add the timing target. */
export function withResponseTimingLogFilter(current: string | undefined): string {
  const existing = current?.trim();
  if (!existing) return `error,${CODEX_RESPONSE_TIMING_LOG_DIRECTIVE}`;
  if (existing.includes('responses_websocket_timing')) return existing;
  return `${existing},${CODEX_RESPONSE_TIMING_LOG_DIRECTIVE}`;
}

export interface CodexResponseTiming {
  threadId: string;
  turnId: string;
  responseId: string;
  /** Tokens sampled so far in this native turn, this response included. */
  sampledTokensTotal: number;
  /** Time this response spent sampling and streaming tokens. */
  samplingMs: number;
}

const MARKER = 'responses websocket timing';
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts the ANSI colour codes Codex writes.
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function quotedField(line: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="((?:[^"\\\\]|\\\\.)*)"`).exec(line);
  return match?.[1];
}

/** Cheap check for the stderr hot path, before any parsing. */
export function isCodexResponseTimingLine(line: string): boolean {
  return line.includes(MARKER);
}

export function parseCodexResponseTiming(rawLine: string): CodexResponseTiming | undefined {
  if (!isCodexResponseTimingLine(rawLine)) return undefined;
  const line = rawLine.replace(ANSI_ESCAPE_RE, '');
  // The pre-connection warm-up request samples nothing and is not a model response.
  if (/\bwarmup=true\b/.test(line)) return undefined;
  const threadId = quotedField(line, 'thread_id');
  const turnId = quotedField(line, 'turn_id');
  const escaped = quotedField(line, 'payload');
  if (!threadId || !turnId || escaped === undefined) return undefined;
  let metrics: Record<string, unknown>;
  try {
    const payload = JSON.parse(JSON.parse(`"${escaped}"`) as string) as { timing_metrics?: unknown };
    if (!payload.timing_metrics || typeof payload.timing_metrics !== 'object') return undefined;
    metrics = payload.timing_metrics as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const path = metrics.critical_path as Record<string, unknown> | undefined;
  const responseId = metrics.response_id;
  const sampled = metrics.num_sampled_tokens_total;
  const samplingMs = path?.sampling_and_stream_total_ms;
  if (typeof responseId !== 'string' || !responseId) return undefined;
  if (typeof sampled !== 'number' || !Number.isFinite(sampled) || sampled <= 0) return undefined;
  if (typeof samplingMs !== 'number' || !Number.isFinite(samplingMs) || samplingMs <= 0) return undefined;
  return { threadId, turnId, responseId, sampledTokensTotal: Math.round(sampled), samplingMs };
}

/**
 * Thread config that keeps RUST_LOG out of the commands Codex runs, keeping every
 * exclusion the user already has (`policy` is `shell_environment_policy` from
 * `config/read`). Undefined when the policy cannot be read safely: replacing a list
 * that was not read could expose a variable the user keeps from commands.
 */
export function codexCommandRustLogExclusion(policy: unknown): Record<string, unknown> | undefined {
  if (policy !== undefined && policy !== null && (typeof policy !== 'object' || Array.isArray(policy))) return undefined;
  const exclude = (policy as { exclude?: unknown } | null | undefined)?.exclude;
  if (exclude !== undefined && exclude !== null &&
    (!Array.isArray(exclude) || !exclude.every((entry) => typeof entry === 'string'))) return undefined;
  const existing = (exclude ?? []) as string[];
  if (existing.includes('RUST_LOG')) return {};
  return { 'shell_environment_policy.exclude': [...existing, 'RUST_LOG'] };
}
