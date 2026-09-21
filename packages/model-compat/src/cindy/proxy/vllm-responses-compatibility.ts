import type { RecoveryRule } from './types.js';

interface ResponsesCompatibilityBody {
  instructions?: unknown;
  input?: unknown;
  reasoning?: { effort?: unknown };
  [key: string]: unknown;
}

interface ResponsesCompatibilityMessage {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

const REASONING_EFFORT_ERROR_RE =
  /Unexpected reasoning effort high\. Supported types are xhigh \(default\), medium, and low\./i;
const UNEXPECTED_MESSAGE_ROLE_RE = /Unexpected message role\./i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is ResponsesCompatibilityMessage {
  return isRecord(value) && typeof value.role === 'string';
}

function normalizeRoles(input: readonly unknown[]): { input: unknown[]; changed: boolean } {
  let changed = false;
  const normalized = input.map((item) => {
    if (!isMessage(item) || item.role !== 'developer') return item;
    changed = true;
    return { ...item, role: 'system' };
  });
  return { input: normalized, changed };
}

/**
 * Convert only the Responses fields that Qwen's vLLM chat template rejected.
 * This runs after an exact 400, so native Responses endpoints keep byte-for-byte
 * requests; normal endpoints never see the rewritten shape.
 */
export function normalizeVllmResponsesRequest(body: unknown): object | null {
  if (!isRecord(body)) return null;
  const source = body as ResponsesCompatibilityBody;
  let changed = false;
  const next: ResponsesCompatibilityBody = { ...source };

  if (source.reasoning?.effort === 'high') {
    next.reasoning = { ...source.reasoning, effort: 'xhigh' };
    changed = true;
  }

  let input: unknown = source.input;
  if (Array.isArray(source.input)) {
    const roles = normalizeRoles(source.input);
    input = roles.input;
    changed ||= roles.changed;
  }

  if (source.instructions !== undefined && source.instructions !== null && source.instructions !== '') {
    const systemMessage = { type: 'message', role: 'system', content: source.instructions };
    // Responses 允许 input 为纯字符串（等价单条 user 消息）。重试时必须把它转成
    // 显式 user 消息追加在 system 之后，绝不能被 instructions 的 system 消息覆盖。
    if (typeof input === 'string') {
      input = [systemMessage, { type: 'message', role: 'user', content: input }];
    } else if (Array.isArray(input)) {
      input = [systemMessage, ...input];
    } else {
      input = [systemMessage];
    }
    delete next.instructions;
    changed = true;
  }
  next.input = input;

  return changed ? next : null;
}

export function createVllmResponsesCompatibilityRule(): RecoveryRule {
  return {
    id: 'vllm_responses_compat',
    enabled: () => true,
    matches: (errorText) =>
      REASONING_EFFORT_ERROR_RE.test(errorText) || UNEXPECTED_MESSAGE_ROLE_RE.test(errorText),
    strip: (body) => {
      try {
        const normalized = normalizeVllmResponsesRequest(JSON.parse(body.toString('utf8')));
        return normalized ? Buffer.from(JSON.stringify(normalized), 'utf8') : null;
      } catch {
        return null;
      }
    },
    applyOnUnmatchedRetry: false,
  };
}
