/**
 * ACP `session/update` → Cindy `AgentEvent`, one instance per session.
 *
 * The instance outlives turns so a tool call that starts during autonomous
 * background work and finishes inside a later prompt keeps a single card.
 * `finish()` closes the current turn; whether events belong to a turn or to
 * background work is decided by the session when it emits them.
 *
 * Event payloads follow the shapes the other engines already emit (see
 * `agents/pi/translator.ts`), so the renderer, persistence and IM channels need
 * no ACP-specific branch:
 *  - text:      `{ text, isFinal: false }` deltas, then `{ text, isFinal: true, isFullText: true }` per segment
 *  - thinking:  `stage: 'start' | 'delta' | 'final'` with a stable `blockId`
 *  - tools:     `tool_use` (including input patches), then paired results when the call settles
 *  - turn end:  `done` with `result` = last non-empty assistant segment
 *
 * Usage, configuration and session-info updates are session state and are
 * handled by `AcpSession`, not here.
 */

import { isDeepStrictEqual } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import type { AgentEvent } from '../../types/events.js';
import {
  asNonEmptyString,
  asRecord,
  normalizeToolCallFields,
  type AcpPlanEntry,
  type AcpRecord,
  type AcpStopReason,
  type AcpToolCallFields,
} from './protocol.js';

const MAX_TOOL_OUTPUT_CHARS = 200_000;

interface ToolState extends AcpToolCallFields {
  settled: boolean;
}

interface ThinkingBlock {
  blockId: string;
  startedAt: number;
  text: string;
}

export interface AcpUpdateTranslatorOptions {
  /** Unique per session; keeps thinking block ids distinct. */
  blockIdPrefix: string;
  now?: () => number;
}

export type AcpTurnOutcome =
  | { stopReason: AcpStopReason }
  | { error: string; reason?: string };

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…` : text;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

function contentBlockText(block: AcpRecord): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'resource_link':
      return asNonEmptyString(block.uri) ?? '';
    case 'resource': {
      const resource = asRecord(block.resource);
      return typeof resource.text === 'string' ? resource.text : asNonEmptyString(resource.uri) ?? '';
    }
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    default:
      return '';
  }
}

/** Renders ACP tool call content (text, diffs, terminal refs) as the detail-panel text. */
export function renderAcpToolContent(content: readonly unknown[] | undefined, rawOutput: unknown): string {
  const parts: string[] = [];
  for (const entry of content ?? []) {
    const item = asRecord(entry);
    if (item.type === 'content') {
      const text = contentBlockText(asRecord(item.content));
      if (text) parts.push(text);
    } else if (item.type === 'diff') {
      const path = asNonEmptyString(item.path) ?? 'file';
      const oldText = typeof item.oldText === 'string' ? item.oldText : '';
      const newText = typeof item.newText === 'string' ? item.newText : '';
      parts.push(createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, { context: 3 }));
    } else if (item.type === 'terminal') {
      const terminalId = asNonEmptyString(item.terminalId);
      if (terminalId) parts.push(`[terminal ${terminalId}]`);
    }
  }
  if (parts.length === 0 && rawOutput !== undefined && rawOutput !== null) {
    const text = stringify(rawOutput);
    if (text) parts.push(text);
  }
  return clip(parts.join('\n'));
}

/** Display name for a tool card / permission prompt: the agent's human title first. */
export function acpToolDisplayName(fields: Pick<AcpToolCallFields, 'title' | 'name' | 'kind'>): string {
  return fields.title ?? fields.name ?? fields.kind ?? 'tool';
}

export class AcpUpdateTranslator {
  private segmentText = '';
  private segmentMessageId: string | undefined;
  private lastText = '';
  private thinking: ThinkingBlock | null = null;
  private thinkingSeq = 0;
  private readonly tools = new Map<string, ToolState>();
  private plan: AcpPlanEntry[] | null = null;
  private readonly now: () => number;

  constructor(private readonly options: AcpUpdateTranslatorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Latest plan published in this turn (kept for the host; not rendered in phase 1). */
  getPlan(): AcpPlanEntry[] | null {
    return this.plan;
  }

  handleUpdate(update: AcpRecord): AgentEvent[] {
    const events: AgentEvent[] = [];
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const block = asRecord(update.content);
        if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) return events;
        this.closeThinking(events);
        const messageId = asNonEmptyString(update.messageId);
        if (messageId && this.segmentMessageId && messageId !== this.segmentMessageId) this.flushText(events);
        if (messageId) this.segmentMessageId = messageId;
        this.segmentText += block.text;
        events.push({ type: 'text', data: { text: block.text, isFinal: false } });
        return events;
      }
      case 'agent_thought_chunk': {
        const block = asRecord(update.content);
        if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) return events;
        this.flushText(events);
        if (!this.thinking) {
          this.thinking = { blockId: `${this.options.blockIdPrefix}-think-${++this.thinkingSeq}`, startedAt: this.now(), text: '' };
          events.push({ type: 'thinking', data: { stage: 'start', blockId: this.thinking.blockId, startedAt: this.thinking.startedAt } });
        }
        this.thinking.text += block.text;
        events.push({ type: 'thinking', data: { stage: 'delta', blockId: this.thinking.blockId, text: block.text } });
        return events;
      }
      case 'tool_call':
      case 'tool_call_update': {
        // Agents use the two interchangeably (ACP v2 RFD "tool-call-updates"):
        // treat both as an upsert keyed by toolCallId.
        const fields = normalizeToolCallFields(update);
        if (fields) this.upsertTool(fields, events);
        return events;
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        this.plan = entries.flatMap((entry) => {
          const record = asRecord(entry);
          const content = asNonEmptyString(record.content);
          return content
            ? [{ content, priority: String(record.priority ?? 'medium'), status: String(record.status ?? 'pending') }]
            : [];
        });
        return events;
      }
      default:
        return events;
    }
  }

  /**
   * Registers a tool call seen outside `session/update` (the permission request
   * carries one) so its card exists before the user is asked about it.
   */
  noteToolCall(fields: AcpToolCallFields): AgentEvent[] {
    const events: AgentEvent[] = [];
    this.upsertTool(fields, events);
    return events;
  }

  /** Closes open text / thinking segments without ending the turn (used before a new turn starts). */
  flushPending(): AgentEvent[] {
    const events: AgentEvent[] = [];
    this.flushText(events);
    this.closeThinking(events);
    return events;
  }

  /**
   * Ends the current turn: closes segments, emits `done` or a terminal `error`.
   *
   * A normal end (`end_turn`) keeps tool calls the agent has not finished open:
   * some agents answer the prompt and keep working, then report the result
   * outside any turn. Marking those calls done here would show work as finished
   * while it still runs. The session settles whatever stays open
   * (`settleOpenTools`) when the agent goes quiet or its process ends. A cancelled
   * or failed turn marks unfinished calls as interrupted; other stop reasons keep
   * the earlier rule and treat them as done.
   */
  finish(outcome: AcpTurnOutcome): AgentEvent[] {
    const events = this.flushPending();
    const interrupted = 'error' in outcome || outcome.stopReason === 'cancelled';
    const carryOpen = !interrupted && outcome.stopReason === 'end_turn';
    for (const [toolCallId, tool] of this.tools) {
      if (!tool.settled && carryOpen) continue;
      if (!tool.settled) this.settleTool(tool, events, interrupted ? 'interrupted' : 'done');
      this.tools.delete(toolCallId);
    }
    const result = this.lastText;
    this.lastText = '';
    if ('error' in outcome) {
      events.push({
        type: 'error',
        data: { message: outcome.error, isTerminal: true, ...(outcome.reason ? { reason: outcome.reason } : {}) },
      });
      return events;
    }
    events.push({
      type: 'done',
      data: {
        type: 'acp/prompt_end',
        status: outcome.stopReason === 'cancelled' ? 'cancelled' : 'completed',
        result: outcome.stopReason === 'cancelled' ? '' : result,
        stopReason: outcome.stopReason,
      },
    });
    return events;
  }

  /** Tool calls the agent started and has not reported finished. */
  openToolCount(): number {
    let count = 0;
    for (const tool of this.tools.values()) if (!tool.settled) count += 1;
    return count;
  }

  /** Settles every open tool call (the agent went quiet or its process ended) and forgets settled ones. */
  settleOpenTools(result: 'done' | 'interrupted'): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.settled) this.settleTool(tool, events, result);
    }
    this.tools.clear();
    return events;
  }

  private upsertTool(fields: AcpToolCallFields, events: AgentEvent[]): void {
    this.flushText(events);
    this.closeThinking(events);
    let tool = this.tools.get(fields.toolCallId);
    if (!tool) {
      tool = { ...fields, settled: false };
      this.tools.set(fields.toolCallId, tool);
      this.emitToolUse(tool, events);
    } else {
      // Later updates replace only the fields they carry.
      if (fields.title !== undefined) tool.title = fields.title;
      if (fields.name !== undefined) tool.name = fields.name;
      if (fields.kind !== undefined) tool.kind = fields.kind;
      if (fields.status !== undefined) tool.status = fields.status;
      if (fields.content !== undefined) tool.content = fields.content;
      if (fields.locations !== undefined) tool.locations = fields.locations;
      if (fields.rawOutput !== undefined) tool.rawOutput = fields.rawOutput;
      if (!tool.settled && fields.rawInput !== undefined && !isDeepStrictEqual(fields.rawInput, tool.rawInput)) {
        tool.rawInput = fields.rawInput;
        this.emitToolUse(tool, events, true);
      }
    }
    if (!tool.settled && (tool.status === 'completed' || tool.status === 'failed')) {
      this.settleTool(tool, events, tool.status === 'failed' ? 'failed' : 'done');
    }
  }

  private emitToolUse(tool: ToolState, events: AgentEvent[], inputPatch = false): void {
    const input = tool.rawInput !== null && typeof tool.rawInput === 'object'
      ? tool.rawInput
      : tool.rawInput === undefined ? {} : { value: tool.rawInput };
    events.push({
      type: 'tool_use',
      data: {
        ...parseMessageToolUse({
          role: 'tool_use',
          content: { toolName: acpToolDisplayName(tool), input },
          toolUseId: tool.toolCallId,
        }),
        toolUseId: tool.toolCallId,
        ...(tool.kind ? { acpKind: tool.kind } : {}),
        ...(tool.locations?.length ? { acpLocations: tool.locations } : {}),
        ...(inputPatch ? { acpInputPatch: true } : {}),
      },
    });
  }

  private settleTool(tool: ToolState, events: AgentEvent[], result: 'done' | 'failed' | 'interrupted'): void {
    tool.settled = true;
    const isError = result !== 'done';
    const rendered = renderAcpToolContent(tool.content, tool.rawOutput);
    const fullText = result === 'interrupted' && !rendered ? 'Interrupted before the tool finished.' : rendered;
    events.push({ type: 'tool_result_full', data: { toolUseId: tool.toolCallId, fullText, isError } });
    events.push({ type: 'tool_result', data: { summary: isError ? 'failed' : 'done', toolUseIds: [tool.toolCallId] } });
  }

  private flushText(events: AgentEvent[]): void {
    if (this.segmentText.length === 0) return;
    const text = this.segmentText;
    this.segmentText = '';
    this.segmentMessageId = undefined;
    if (text.trim().length > 0) this.lastText = text;
    events.push({ type: 'text', data: { text, isFinal: true, isFullText: true } });
  }

  private closeThinking(events: AgentEvent[]): void {
    if (!this.thinking) return;
    const block = this.thinking;
    this.thinking = null;
    events.push({
      type: 'thinking',
      data: { stage: 'final', blockId: block.blockId, text: block.text, durationMs: Math.max(0, this.now() - block.startedAt) },
    });
  }
}
