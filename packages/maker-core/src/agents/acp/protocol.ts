/**
 * Agent Client Protocol (ACP) v1 wire subset used by Cindy's generic ACP engine.
 *
 * Source of truth: https://agentclientprotocol.com (schema/v1/schema.json). Only
 * the fields Cindy reads or writes are typed here. Reads are tolerant in the same
 * way the schema is (`x-deserialize-default-on-error`): malformed optional fields
 * fall back to defaults instead of failing the whole message, because agents in
 * the wild send partial objects. Nothing in this file knows about a concrete
 * agent (DSH, Gemini, ...) or about plugins.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC error codes defined by ACP v1 on top of the JSON-RPC 2.0 reserved range. */
export const ACP_ERROR_AUTH_REQUIRED = -32000;
export const ACP_ERROR_RESOURCE_NOT_FOUND = -32002;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INTERNAL_ERROR = -32603;

/**
 * Same-turn steering. ACP v1 has no way to add input to a running prompt, so
 * agents that can do it (claude-agent-acp, codex-acp, oh-my-pi, ...) share this
 * extension request: `{ sessionId, prompt: ContentBlock[], _meta? }`, answered
 * with `{ outcome: 'injected' | 'promptRequired' | 'startedNewTurn' }`. Agents
 * advertise it in the `initialize` result as top-level `_meta.steering.supported: true`.
 * Request `_meta.steering.idleBehavior: 'promptRequired'` asks an agent whose turn
 * already ended to hand the content back instead of starting a turn on its own.
 */
export const ACP_STEERING_METHOD = '_session/steering';

export type AcpRecord = Record<string, unknown>;

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string };

export interface AcpHttpHeader { name: string; value: string }
export interface AcpEnvVariable { name: string; value: string }

export type AcpMcpServer =
  | { type: 'http'; name: string; url: string; headers: AcpHttpHeader[] }
  | { type: 'sse'; name: string; url: string; headers: AcpHttpHeader[] }
  | { name: string; command: string; args: string[]; env: AcpEnvVariable[] };

export interface AcpAgentCapabilities {
  loadSession: boolean;
  promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcpCapabilities: { http: boolean; sse: boolean };
  sessionCapabilities: { resume: boolean; close: boolean; list: boolean };
}

export interface AcpAuthMethod { id: string; name: string; type?: string }

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  authMethods: AcpAuthMethod[];
  agentInfo?: { name: string; title?: string; version: string };
  /** The agent takes ACP_STEERING_METHOD (top-level `_meta.steering.supported`). */
  steering: boolean;
}

export interface AcpConfigSelectOption {
  value: string;
  name: string;
  description?: string;
  /** Display group name when the agent publishes grouped options. */
  group?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  /** `mode` | `model` | `model_config` | `thought_level` | any agent-defined string. */
  category?: string;
  type: 'select' | 'boolean';
  currentValue: string | boolean;
  options: AcpConfigSelectOption[];
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/**
 * Tokens one prompt turn used, from the `usage` of the `session/prompt` result. Field names follow
 * the per-turn `done.data.usage` other engines emit, so usage ledgers and plugins read it without
 * an ACP branch. `inputTokens` excludes cached tokens.
 */
export interface AcpTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Union of `ToolCall` and `ToolCallUpdate`: every field but the id may be absent. */
export interface AcpToolCallFields {
  toolCallId: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: AcpToolCallStatus;
  content?: unknown[];
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind | string;
}

export type AcpPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export interface AcpPlanEntry {
  content: string;
  priority: string;
  status: string;
}

export function asRecord(value: unknown): AcpRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AcpRecord : {};
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/** `{}` (present) means supported; absent or `null` means unsupported. */
function capabilityPresent(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeInitializeResult(raw: unknown): AcpInitializeResult {
  const result = asRecord(raw);
  const caps = asRecord(result.agentCapabilities);
  const prompt = asRecord(caps.promptCapabilities);
  const mcp = asRecord(caps.mcpCapabilities);
  const session = asRecord(caps.sessionCapabilities);
  const agentInfo = asRecord(result.agentInfo);
  const name = asNonEmptyString(agentInfo.name);
  const version = asNonEmptyString(agentInfo.version);
  return {
    protocolVersion: typeof result.protocolVersion === 'number' ? result.protocolVersion : -1,
    agentCapabilities: {
      loadSession: asBoolean(caps.loadSession),
      promptCapabilities: {
        image: asBoolean(prompt.image),
        audio: asBoolean(prompt.audio),
        embeddedContext: asBoolean(prompt.embeddedContext),
      },
      mcpCapabilities: { http: asBoolean(mcp.http), sse: asBoolean(mcp.sse) },
      sessionCapabilities: {
        resume: capabilityPresent(session.resume),
        close: capabilityPresent(session.close),
        list: capabilityPresent(session.list),
      },
    },
    authMethods: Array.isArray(result.authMethods)
      ? result.authMethods.flatMap((entry) => {
          const method = asRecord(entry);
          const id = asNonEmptyString(method.id);
          const methodName = asNonEmptyString(method.name);
          if (!id || !methodName) return [];
          const type = asNonEmptyString(method.type);
          return [{ id, name: methodName, ...(type ? { type } : {}) }];
        })
      : [],
    ...(name && version
      ? { agentInfo: { name, version, ...(asNonEmptyString(agentInfo.title) ? { title: agentInfo.title as string } : {}) } }
      : {}),
    steering: asRecord(asRecord(result._meta).steering).supported === true,
  };
}

function normalizeSelectOption(raw: unknown, group?: string): AcpConfigSelectOption | null {
  const option = asRecord(raw);
  const value = asNonEmptyString(option.value);
  const name = asNonEmptyString(option.name);
  if (!value || !name) return null;
  const description = asNonEmptyString(option.description);
  return { value, name, ...(description ? { description } : {}), ...(group ? { group } : {}) };
}

/** Flattens grouped select options and drops invalid entries (schema: skip-invalid-items). */
export function normalizeConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOption[] = [];
  for (const entry of raw) {
    const option = asRecord(entry);
    const id = asNonEmptyString(option.id);
    const name = asNonEmptyString(option.name);
    if (!id || !name) continue;
    const category = asNonEmptyString(option.category);
    if (option.type === 'boolean') {
      if (typeof option.currentValue !== 'boolean') continue;
      out.push({ id, name, ...(category ? { category } : {}), type: 'boolean', currentValue: option.currentValue, options: [] });
      continue;
    }
    if (option.type !== 'select' || typeof option.currentValue !== 'string') continue;
    const values: AcpConfigSelectOption[] = [];
    for (const item of Array.isArray(option.options) ? option.options : []) {
      const record = asRecord(item);
      if (Array.isArray(record.options)) {
        const groupName = asNonEmptyString(record.name);
        for (const grouped of record.options) {
          const normalized = normalizeSelectOption(grouped, groupName);
          if (normalized) values.push(normalized);
        }
        continue;
      }
      const normalized = normalizeSelectOption(item);
      if (normalized) values.push(normalized);
    }
    out.push({ id, name, ...(category ? { category } : {}), type: 'select', currentValue: option.currentValue, options: values });
  }
  return out;
}

const TOOL_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);

export function normalizeToolCallFields(raw: unknown): AcpToolCallFields | null {
  const record = asRecord(raw);
  const toolCallId = asNonEmptyString(record.toolCallId);
  if (!toolCallId) return null;
  const fields: AcpToolCallFields = { toolCallId };
  const title = asNonEmptyString(record.title);
  if (title) fields.title = title;
  const name = asNonEmptyString(record.name);
  if (name) fields.name = name;
  const kind = asNonEmptyString(record.kind);
  if (kind) fields.kind = kind;
  if (typeof record.status === 'string' && TOOL_STATUSES.has(record.status)) {
    fields.status = record.status as AcpToolCallStatus;
  }
  if (Array.isArray(record.content)) fields.content = record.content;
  if (Array.isArray(record.locations)) {
    fields.locations = record.locations.flatMap((entry) => {
      const location = asRecord(entry);
      const path = asNonEmptyString(location.path);
      if (!path) return [];
      return [{ path, ...(typeof location.line === 'number' ? { line: location.line } : {}) }];
    });
  }
  if ('rawInput' in record && record.rawInput !== undefined) fields.rawInput = record.rawInput;
  if ('rawOutput' in record && record.rawOutput !== undefined) fields.rawOutput = record.rawOutput;
  return fields;
}

export function normalizePermissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const option = asRecord(entry);
    const optionId = asNonEmptyString(option.optionId);
    const name = asNonEmptyString(option.name);
    const kind = asNonEmptyString(option.kind);
    return optionId && name && kind ? [{ optionId, name, kind }] : [];
  });
}

const STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

/** Unknown stop reasons are treated as a normal end of turn rather than an error. */
export function normalizeStopReason(raw: unknown): AcpStopReason {
  const stopReason = asRecord(raw).stopReason;
  return typeof stopReason === 'string' && STOP_REASONS.has(stopReason) ? stopReason as AcpStopReason : 'end_turn';
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * `usage` of a `session/prompt` result (ACP `PromptResponse.usage`, unstable): the tokens of this
 * turn only, not a session total. Absent or malformed usage is `undefined`, never zero, so a turn
 * without a report is not recorded as free.
 *
 * Agents disagree on whether `inputTokens` already contains the cached tokens. `totalTokens`
 * settles it: Antigravity reports input + output + cached = total (input excludes the cache),
 * while an agent passing through OpenAI-style counts reports input + output = total. Counting the
 * cache twice would inflate usage, so the second form is converted to the first.
 */
export function normalizeTurnUsage(raw: unknown): AcpTurnUsage | undefined {
  const usage = asRecord(asRecord(raw).usage);
  const input = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  if (input === null || outputTokens === null) return undefined;
  const cacheReadTokens = tokenCount(usage.cachedReadTokens) ?? 0;
  const cacheCreationTokens = tokenCount(usage.cachedWriteTokens) ?? 0;
  const cached = cacheReadTokens + cacheCreationTokens;
  const inputIncludesCache = cached > 0 && tokenCount(usage.totalTokens) === input + outputTokens;
  return {
    inputTokens: inputIncludesCache ? Math.max(0, input - cached) : input,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
