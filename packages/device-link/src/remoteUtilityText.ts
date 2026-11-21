/** Optional same-account utility text RPC over the existing invoke envelope. */
export const REMOTE_UTILITY_TEXT_CHANNEL = 'maker:utility-text:v1';
export const REMOTE_UTILITY_TEXT_MAX_INPUT_BYTES = 96 * 1024;
export const REMOTE_UTILITY_TEXT_MAX_OUTPUT_BYTES = 64 * 1024;
export const REMOTE_UTILITY_TEXT_MAX_TIMEOUT_MS = 90_000;
export const REMOTE_UTILITY_TEXT_MAX_ROUTES = 4096;

export type RemoteUtilityRoute = {
  providerId: string;
  agentKind: 'codex' | 'claude-code' | 'pi';
  model: string;
};
export type RemoteUtilityOptions = {
  systemPrompt?: string;
  responseInstructions?: string;
  maxTokens?: number;
  timeoutMs?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  disableReasoning?: boolean;
};
export type RemoteUtilityRequest =
  | { version: 1; op: 'caps' }
  | { version: 1; op: 'cancel'; hostEpoch: string; requestId: string }
  | { version: 1; op: 'run'; hostEpoch: string; requestId: string; route: RemoteUtilityRoute; prompt: string; options: RemoteUtilityOptions };
export type RemoteUtilityError =
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'STALE_HOST' | 'ROUTE_UNAVAILABLE'
  | 'CANCELLED' | 'TIMEOUT' | 'BUSY' | 'EXECUTION_FAILED' | 'INVALID_RESPONSE';
export type RemoteUtilityAttemptReason = 'unsupported_transport' | 'agent_unavailable' | 'model_unavailable' | 'not_authenticated' | 'auth_probe_failed' | 'api_key_missing' | 'endpoint_missing' | 'timeout' | 'empty_response' | 'http_error' | 'request_failed';
export type RemoteUtilityAttempt = {
  providerId: string; model: string; transport: 'codex-responses' | 'litellm-chat-completions';
  status: 'skipped' | 'failed';
} & ({ reason: 'http_error'; httpStatus: number } | { reason: Exclude<RemoteUtilityAttemptReason, 'http_error'>; httpStatus?: never });
export type RemoteUtilityResult =
  | { ok: true; text: string; providerId: string; model: string; transport: 'codex-responses' | 'litellm-chat-completions' }
  | { ok: false; reason: 'no_candidate' | 'all_candidates_failed' | 'empty_response' | 'timeout'; attempts: RemoteUtilityAttempt[] };
export type RemoteUtilityResponse =
  | { version: 1; op: 'caps'; ok: true; hostEpoch: string; allowedRoutes: RemoteUtilityRoute[] }
  | { version: 1; op: 'cancel'; ok: true; requestId: string }
  | { version: 1; op: 'run'; ok: true; requestId: string; result: RemoteUtilityResult }
  | { version: 1; op: 'error'; ok: false; code: RemoteUtilityError };

const invalid = (): never => { throw new Error('INVALID_REQUEST'); };
const encoder = new TextEncoder();
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (Object.keys(value).some((key) => ![...required, ...optional].includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) invalid();
}
function text(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || encoder.encode(value).byteLength > max) return invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 256, true);
  if (result !== result.trim() || /[\x00-\x1f\x7f]/.test(result)) return invalid();
  return result;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return invalid();
  return value;
}
export function parseRemoteUtilityRoute(raw: unknown): RemoteUtilityRoute {
  const v = record(raw);
  keys(v, ['providerId', 'agentKind', 'model']);
  if (v.agentKind !== 'codex' && v.agentKind !== 'claude-code' && v.agentKind !== 'pi') return invalid();
  return { providerId: id(v.providerId), agentKind: v.agentKind, model: id(v.model) };
}
function options(raw: unknown): RemoteUtilityOptions {
  const v = record(raw);
  keys(v, [], ['systemPrompt', 'responseInstructions', 'maxTokens', 'timeoutMs', 'reasoningEffort', 'disableReasoning']);
  const result: RemoteUtilityOptions = {};
  if (Object.hasOwn(v, 'systemPrompt')) result.systemPrompt = text(v.systemPrompt, 32 * 1024);
  if (Object.hasOwn(v, 'responseInstructions')) result.responseInstructions = text(v.responseInstructions, 32 * 1024);
  if (Object.hasOwn(v, 'maxTokens')) result.maxTokens = integer(v.maxTokens, 81_920);
  if (Object.hasOwn(v, 'timeoutMs')) result.timeoutMs = integer(v.timeoutMs, REMOTE_UTILITY_TEXT_MAX_TIMEOUT_MS);
  if (Object.hasOwn(v, 'reasoningEffort')) {
    if (v.reasoningEffort !== 'minimal' && v.reasoningEffort !== 'low' && v.reasoningEffort !== 'medium' && v.reasoningEffort !== 'high') return invalid();
    result.reasoningEffort = v.reasoningEffort;
  }
  if (Object.hasOwn(v, 'disableReasoning')) {
    if (typeof v.disableReasoning !== 'boolean') return invalid();
    result.disableReasoning = v.disableReasoning;
  }
  return result;
}
/** Reject unknown fields and non-serializable options before any authorization or execution. */
export function parseRemoteUtilityRequest(raw: unknown): RemoteUtilityRequest {
  const v = record(raw);
  if (v.version !== 1) return invalid();
  if (v.op === 'caps') { keys(v, ['version', 'op']); return { version: 1, op: 'caps' }; }
  if (v.op === 'cancel') {
    keys(v, ['version', 'op', 'hostEpoch', 'requestId']);
    return { version: 1, op: 'cancel', hostEpoch: id(v.hostEpoch), requestId: id(v.requestId) };
  }
  if (v.op !== 'run') return invalid();
  keys(v, ['version', 'op', 'hostEpoch', 'requestId', 'route', 'prompt', 'options']);
  const prompt = text(v.prompt, 64 * 1024, true);
  const opts = options(v.options);
  if (encoder.encode(prompt).byteLength + encoder.encode(opts.systemPrompt ?? '').byteLength + encoder.encode(opts.responseInstructions ?? '').byteLength > REMOTE_UTILITY_TEXT_MAX_INPUT_BYTES) return invalid();
  return { version: 1, op: 'run', hostEpoch: id(v.hostEpoch), requestId: id(v.requestId), route: parseRemoteUtilityRoute(v.route), prompt, options: opts };
}
const attemptReasons: readonly RemoteUtilityAttemptReason[] = ['unsupported_transport', 'agent_unavailable', 'model_unavailable', 'not_authenticated', 'auth_probe_failed', 'api_key_missing', 'endpoint_missing', 'timeout', 'empty_response', 'http_error', 'request_failed'];
function transport(value: unknown): 'codex-responses' | 'litellm-chat-completions' {
  if (value !== 'codex-responses' && value !== 'litellm-chat-completions') return invalid();
  return value;
}
function parseResult(raw: unknown): RemoteUtilityResult {
  const v = record(raw);
  if (v.ok === true) {
    keys(v, ['ok', 'text', 'providerId', 'model', 'transport']);
    return { ok: true, text: text(v.text, REMOTE_UTILITY_TEXT_MAX_OUTPUT_BYTES, true), providerId: id(v.providerId), model: id(v.model), transport: transport(v.transport) };
  }
  if (v.ok !== false) return invalid();
  keys(v, ['ok', 'reason', 'attempts']);
  if (v.reason !== 'no_candidate' && v.reason !== 'all_candidates_failed' && v.reason !== 'empty_response' && v.reason !== 'timeout') return invalid();
  if (!Array.isArray(v.attempts) || v.attempts.length > 4096 || encoder.encode(JSON.stringify(v.attempts)).byteLength > REMOTE_UTILITY_TEXT_MAX_INPUT_BYTES) return invalid();
  const attempts: RemoteUtilityAttempt[] = v.attempts.map((rawAttempt: unknown) => {
    const a = record(rawAttempt);
    keys(a, ['providerId', 'model', 'transport', 'status', 'reason'], ['httpStatus']);
    if (a.status !== 'skipped' && a.status !== 'failed') return invalid();
    if (typeof a.reason !== 'string' || !attemptReasons.includes(a.reason as RemoteUtilityAttemptReason)) return invalid();
    const base = { providerId: id(a.providerId), model: id(a.model), transport: transport(a.transport), status: a.status as 'skipped' | 'failed' };
    if (a.reason === 'http_error') {
      if (typeof a.httpStatus !== 'number' || !Number.isInteger(a.httpStatus) || a.httpStatus < 100 || a.httpStatus > 599) return invalid();
      return { ...base, reason: 'http_error', httpStatus: a.httpStatus };
    }
    if (Object.hasOwn(a, 'httpStatus')) return invalid();
    return { ...base, reason: a.reason as Exclude<RemoteUtilityAttemptReason, 'http_error'> };
  });
  return { ok: false, reason: v.reason, attempts };
}
const errors: readonly RemoteUtilityError[] = ['INVALID_REQUEST', 'UNAUTHORIZED', 'STALE_HOST', 'ROUTE_UNAVAILABLE', 'CANCELLED', 'TIMEOUT', 'BUSY', 'EXECUTION_FAILED', 'INVALID_RESPONSE'];
/** Validate even authenticated peer responses: text and route lists remain bounded. */
export function parseRemoteUtilityResponse(raw: unknown): RemoteUtilityResponse {
  const v = record(raw);
  if (v.version !== 1) return invalid();
  if (v.op === 'error') {
    keys(v, ['version', 'op', 'ok', 'code']);
    if (v.ok !== false || typeof v.code !== 'string' || !errors.includes(v.code as RemoteUtilityError)) return invalid();
    return { version: 1, op: 'error', ok: false, code: v.code as RemoteUtilityError };
  }
  if (v.ok !== true) return invalid();
  if (v.op === 'cancel') {
    keys(v, ['version', 'op', 'ok', 'requestId']);
    return { version: 1, op: 'cancel', ok: true, requestId: id(v.requestId) };
  }
  if (v.op === 'run') {
    keys(v, ['version', 'op', 'ok', 'requestId', 'result']);
    return { version: 1, op: 'run', ok: true, requestId: id(v.requestId), result: parseResult(v.result) };
  }
  if (v.op === 'caps') {
    keys(v, ['version', 'op', 'ok', 'hostEpoch', 'allowedRoutes']);
    if (!Array.isArray(v.allowedRoutes) || v.allowedRoutes.length > REMOTE_UTILITY_TEXT_MAX_ROUTES) return invalid();
    const allowedRoutes = v.allowedRoutes.map(parseRemoteUtilityRoute);
    if (encoder.encode(JSON.stringify(allowedRoutes)).byteLength > 2 * 1024 * 1024) return invalid();
    return { version: 1, op: 'caps', ok: true, hostEpoch: id(v.hostEpoch), allowedRoutes };
  }
  return invalid();
}
