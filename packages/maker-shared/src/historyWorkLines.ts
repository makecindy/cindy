/**
 * Single-line work activities for a running remote work group.
 *
 * The Host projects them from the complete rows with the same latest-N projection
 * every client already uses (Codex command splitting, repeated-read de-duplication),
 * then sends only display facts. Clients localize the descriptor themselves and never
 * re-describe a truncated input, so a cut command cannot change its recognized intent.
 */

import type { HistoryMessageSource } from './historyView.js';
import { isToolResultFailureLike } from './messagePresentation.js';
import { messageContentToPreview, parseMessageToolUse } from './messageNormalize.js';
import { describeToolUse, type ToolUseDescriptor } from './toolUseDescriptor.js';
import {
  projectRecentWorkActivities,
  type ProjectableWorkChild,
  type WorkActivityMessageLike,
} from './workActivityProjection.js';

export const HISTORY_WORK_LINE_LIMIT = 5;
/** One rendered line never shows more; longer values only cost bytes. */
export const HISTORY_WORK_LINE_TEXT_CHARS = 160;
/** UTF-8 budget for the whole window, so one patch stays a small push. */
export const HISTORY_WORK_LINES_MAX_BYTES = 6 * 1024;
/** Each line fits its share of the window, so five lines always fit together. */
export const HISTORY_WORK_LINE_MAX_BYTES = Math.floor(HISTORY_WORK_LINES_MAX_BYTES / HISTORY_WORK_LINE_LIMIT);
/** Descriptor reductions tried in order until the whole line fits its byte share. */
const DESCRIPTOR_LIMITS = [
  { text: 300, items: 20 },
  { text: 80, items: 4 },
  { text: 40, items: 1 },
] as const;

export type HistoryWorkLine =
  | {
      kind: 'tool';
      key: string;
      toolName: string;
      /** Resolved from the full input (intent override applied); long text cut afterwards. */
      descriptor: ToolUseDescriptor;
      status: 'running' | 'done';
      hasError?: true;
      /** ghost_call identity, the only input fields a row header reads besides the descriptor. */
      ghost?: { id: string; tool: string };
    }
  | {
      kind: 'thinking';
      key: string;
      /** Whitespace-collapsed opening of the thought. */
      text: string;
      truncated?: true;
    };

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** A list keeps at most this many entries, so counts such as "edited N files" stay exact up to it. */
const DESCRIPTOR_LIST_ENTRIES = 20;

/**
 * Display facts only: diffs are dropped, strings and lists bounded. Entries past
 * `limits.items` become empty shells that only keep a list's length: a row reads list
 * entries only when there is exactly one, and a remote line opens its group on click.
 */
function liteDescriptor(value: unknown, limits: { text: number; items: number }): unknown {
  if (typeof value === 'string') return cut(value, limits.text);
  if (Array.isArray(value)) {
    return value.slice(0, DESCRIPTOR_LIST_ENTRIES)
      .map((entry, index) => index < limits.items ? liteDescriptor(entry, limits) : {});
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = key === 'diff' ? '' : liteDescriptor(entry, limits);
  }
  return result;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

interface LineSource extends WorkActivityMessageLike {
  toolInput?: unknown;
}

function thinkingText(content: unknown): { text: string; redacted: boolean } {
  if (typeof content === 'string') return { text: content, redacted: false };
  const thought = content as { text?: unknown; isRedacted?: unknown } | null;
  return {
    text: typeof thought?.text === 'string' ? thought.text : '',
    redacted: thought?.isRedacted === true,
  };
}

/**
 * Project the latest lines from the rows of one running work range. Rows belonging to
 * a child agent stay inside that agent's own card and never become main-timeline lines.
 */
export function projectHistoryWorkLines(
  rows: readonly HistoryMessageSource[],
  isStreaming: boolean,
  limit = HISTORY_WORK_LINE_LIMIT,
): HistoryWorkLine[] {
  const children: ProjectableWorkChild<LineSource>[] = [];
  const toolClientIds = new Map<string, string>();
  const results = new Map<string, string>();
  const inputs = new Map<string, unknown>();
  let tools: ProjectableWorkChild<LineSource> | null = null;
  for (const row of rows) {
    if ((row.agentMeta as { parentUuid?: unknown } | null | undefined)?.parentUuid) continue;
    if (row.role === 'tool_use') {
      const tool = parseMessageToolUse(row);
      if (tool.toolUseId) toolClientIds.set(tool.toolUseId, row.clientId);
      inputs.set(row.clientId, tool.input);
      if (!tools) {
        tools = { kind: 'tools', key: row.clientId, toolCalls: [], resultMap: results };
        children.push(tools);
      }
      tools.toolCalls!.push({ clientId: row.clientId, content: '', toolName: tool.toolName, toolInput: tool.input });
      continue;
    }
    if (row.role === 'tool_result') {
      const owner = row.toolUseId ? toolClientIds.get(row.toolUseId) : undefined;
      if (owner) results.set(owner, messageContentToPreview(row.content));
      continue;
    }
    if (row.role === 'thinking') {
      const thought = thinkingText(row.content);
      tools = null;
      children.push({
        kind: 'thinking',
        key: row.clientId,
        message: { clientId: row.clientId, content: thought.text, thinkingRedacted: thought.redacted },
      });
    }
  }

  const lines = projectRecentWorkActivities(children, isStreaming, limit).map((activity): HistoryWorkLine => {
    if (activity.kind === 'thinking') {
      const text = cut(activity.content, HISTORY_WORK_LINE_TEXT_CHARS);
      return { kind: 'thinking', key: activity.key, text, ...(text !== activity.content ? { truncated: true as const } : {}) };
    }
    const toolName = activity.message.toolName ?? '';
    const input = inputs.get(activity.message.clientId);
    const resolved = describeToolUse(toolName, input);
    const descriptor = activity.intentOverride && resolved.kind === 'command' && !resolved.description
      ? { ...resolved, intent: activity.intentOverride }
      : resolved;
    const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
    const hasError = activity.toolResult !== undefined && isToolResultFailureLike(descriptor, activity.toolResult);
    for (const limits of DESCRIPTOR_LIMITS) {
      const ghost = /(?:^|:|__)ghost_call$/.test(toolName) && typeof record?.ghost_id === 'string'
        ? { id: cut(record.ghost_id, limits.text), tool: cut(typeof record.tool === 'string' ? record.tool : '', limits.text) }
        : undefined;
      const line: HistoryWorkLine = {
        kind: 'tool',
        key: activity.key,
        toolName: cut(toolName, limits.text),
        descriptor: liteDescriptor(descriptor, limits) as ToolUseDescriptor,
        status: activity.status,
        ...(hasError ? { hasError: true as const } : {}),
        ...(ghost ? { ghost } : {}),
      };
      if (utf8Length(JSON.stringify(line)) <= HISTORY_WORK_LINE_MAX_BYTES) return line;
    }
    // Nothing descriptive fits: the tool name alone still reports the activity and its state.
    const last = DESCRIPTOR_LIMITS[DESCRIPTOR_LIMITS.length - 1].text;
    return {
      kind: 'tool',
      key: activity.key,
      toolName: cut(toolName, last),
      descriptor: { kind: 'generic', toolName: cut(toolName, last) },
      status: activity.status,
      ...(hasError ? { hasError: true as const } : {}),
    };
  });
  // Every line is within its share, so this only guards the invariant itself.
  while (lines.length > 0 && utf8Length(JSON.stringify(lines)) > HISTORY_WORK_LINES_MAX_BYTES) lines.shift();
  return lines;
}
