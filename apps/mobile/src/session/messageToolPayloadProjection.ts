import { isAgentTaskToolName } from '@cindy/maker-shared/agent-task';
import {
  isAgentPlanToolName,
} from '@cindy/maker-shared/message-render';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import {
  buildPayloadToolDiff,
  formatPayloadToolUseSummary,
} from '@/session/messagePayload';
import { classifyOrcaDispatchTool } from '@/session/orcaCollab';
import type { RemoteMessage } from '@/session/types';

export const MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES = 32 * 1024;

const TOOL_SUMMARY_MAX_CHARS = 480;

// Normalization can revisit the same immutable rows during pagination and refreshes.
// Remember only that a settled row was evaluated; WeakSet neither retains the row nor
// keeps any payload bytes alive.
const evaluatedSettledToolInputs = new WeakSet<RemoteMessage>();

export interface MobileToolInputProjection {
  projected: true;
  summary: string;
  toolName: string;
  toolUseId: string;
  toolUseMessageId: string;
  version: 1;
}

export interface MobileToolInputDetail {
  body: string;
  toolName: string;
}

export type MobileToolInputAroundLoader = (
  messageId: string,
  options: { radius: 0 },
) => Promise<readonly RemoteMessage[]>;

/**
 * Release only large, persisted tool inputs after their exact result has arrived.
 * Tool results are already bounded by the remote transport, while structural tools
 * need their original input to build Agent, plan, Todo, Orca, and diff render models.
 */
export function projectLargeSettledToolInputs(
  messages: readonly RemoteMessage[],
): RemoteMessage[] {
  const settledToolUseIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool_result') continue;
    const toolUseId = readToolUseId(message);
    if (toolUseId) settledToolUseIds.add(toolUseId);
  }
  if (settledToolUseIds.size === 0) return [...messages];

  return messages.map((message) => {
    if (
      message.role !== 'tool_use'
      || message.mobileToolInputProjection
      || !message.id
      || message.agentMeta?.remoteContentTruncated === true
    ) return message;

    const tool = parseMessageToolUse(message);
    if (
      !tool.toolUseId
      || !settledToolUseIds.has(tool.toolUseId)
    ) return message;
    if (evaluatedSettledToolInputs.has(message)) return message;
    evaluatedSettledToolInputs.add(message);
    if (!toolInputCanBeProjected(tool.toolName, tool.input)) return message;

    if (!toolInputExceedsProjectionThreshold(tool.input)) return message;

    const summary = limitText(
      formatPayloadToolUseSummary(tool.toolName, tool.input),
      TOOL_SUMMARY_MAX_CHARS,
    );
    const projection: MobileToolInputProjection = {
      projected: true,
      summary,
      toolName: tool.toolName,
      toolUseId: tool.toolUseId,
      toolUseMessageId: message.id,
      version: 1,
    };
    return {
      ...message,
      content: {
        input: null,
        mobilePayloadProjected: true,
        toolName: tool.toolName,
        toolUseId: tool.toolUseId,
      },
      mobileToolInputProjection: projection,
    };
  });
}

/** Build the one expanded detail directly from a radius-0 authoritative read. */
export function buildMobileToolInputDetail(
  messages: readonly RemoteMessage[],
  ref: MobileToolInputProjection,
): MobileToolInputDetail | null {
  const message = messages.find((candidate) => (
    candidate.role === 'tool_use' && candidate.id === ref.toolUseMessageId
  ));
  if (
    !message
    || message.agentMeta?.remoteContentTruncated === true
    || message.mobileToolInputProjection
  ) return null;

  const tool = parseMessageToolUse(message);
  if (tool.toolUseId !== ref.toolUseId || tool.toolName !== ref.toolName) return null;
  const body = formatFullToolInput(tool.input);
  return body ? { body, toolName: tool.toolName } : null;
}

export async function fetchMobileToolInputDetail(
  ref: MobileToolInputProjection,
  loadAround: MobileToolInputAroundLoader,
): Promise<MobileToolInputDetail> {
  const rows = await loadAround(ref.toolUseMessageId, { radius: 0 });
  const detail = buildMobileToolInputDetail(rows, ref);
  if (!detail) throw new Error('tool input is unavailable');
  return detail;
}

function toolInputCanBeProjected(toolName: string, input: unknown): boolean {
  if (!toolName) return false;
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return false;
  if (isAgentTaskToolName(toolName) || isAgentPlanToolName(toolName)) return false;
  if (classifyOrcaDispatchTool(toolName) !== null) return false;
  return buildPayloadToolDiff(toolName, input) === undefined;
}

function readToolUseId(message: RemoteMessage): string | null {
  if (message.toolUseId) return message.toolUseId;
  if (!message.content || typeof message.content !== 'object' || Array.isArray(message.content)) {
    return null;
  }
  const toolUseId = (message.content as Record<string, unknown>).toolUseId;
  return typeof toolUseId === 'string' && toolUseId.length > 0 ? toolUseId : null;
}

interface JsonByteBudget {
  ancestors: Set<object>;
  remaining: number;
}

/** Count decoded JSON until 32 KiB is crossed, without building its full string. */
function toolInputExceedsProjectionThreshold(input: unknown): boolean {
  const budget: JsonByteBudget = {
    ancestors: new Set(),
    remaining: MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES,
  };
  return typeof input === 'string'
    ? consumeUtf8(budget, input, false)
    : measureJsonValue(budget, input) === true;
}

/** `true` means over budget; `null` means this is not a decoded JSON value. */
function measureJsonValue(budget: JsonByteBudget, value: unknown): boolean | null {
  if (value === null) return consumeAscii(budget, 4);
  if (typeof value === 'string') return consumeUtf8(budget, value, true);
  if (typeof value === 'boolean') return consumeAscii(budget, value ? 4 : 5);
  if (typeof value === 'number') {
    return consumeAscii(budget, Number.isFinite(value) ? String(value).length : 4);
  }
  if (typeof value !== 'object' || budget.ancestors.has(value)) return null;

  if (!Array.isArray(value)) {
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
    } catch {
      return null;
    }
  }

  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (consumeAscii(budget, 1)) return true;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && consumeAscii(budget, 1)) return true;
        const measured = measureJsonValue(budget, value[index]);
        if (measured === true) return true;
        if (measured === null && consumeAscii(budget, 4)) return true;
      }
      return consumeAscii(budget, 1);
    }

    let written = 0;
    if (consumeAscii(budget, 1)) return true;
    for (const key of Object.keys(value)) {
      const property = (value as Record<string, unknown>)[key];
      if (property === undefined || typeof property === 'function' || typeof property === 'symbol') {
        continue;
      }
      if (written > 0 && consumeAscii(budget, 1)) return true;
      if (consumeUtf8(budget, key, true) || consumeAscii(budget, 1)) return true;
      const measured = measureJsonValue(budget, property);
      if (measured === null) return null;
      if (measured) return true;
      written += 1;
    }
    return consumeAscii(budget, 1);
  } catch {
    return null;
  } finally {
    budget.ancestors.delete(value);
  }
}

function consumeAscii(budget: JsonByteBudget, bytes: number): boolean {
  budget.remaining -= bytes;
  return budget.remaining < 0;
}

function consumeUtf8(budget: JsonByteBudget, value: string, jsonQuoted: boolean): boolean {
  if (jsonQuoted && consumeAscii(budget, 1)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let bytes: number;
    if (jsonQuoted && (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d)) bytes = 2;
    else if (jsonQuoted && code <= 0x1f) bytes = 6;
    else if (code <= 0x7f) bytes = 1;
    else if (code <= 0x7ff) bytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4;
        index += 1;
      } else bytes = jsonQuoted ? 6 : 3;
    } else if (jsonQuoted && code >= 0xdc00 && code <= 0xdfff) bytes = 6;
    else bytes = 3;
    if (consumeAscii(budget, bytes)) return true;
  }
  return jsonQuoted ? consumeAscii(budget, 1) : false;
}

function formatFullToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input ?? '');
  }
}

function limitText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
