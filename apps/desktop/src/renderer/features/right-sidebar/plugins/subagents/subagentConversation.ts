/**
 * Transcript → conversation projection for the Subagent detail view.
 *
 * The durable transcript is a flat, chronological record. The detail view shows
 * it the way the main session shows a turn: user bubbles, assistant prose and
 * one foldable card per tool call. That means the two halves of a tool call
 * (`toolPhase: 'start'` / `'end'`) must be folded into a single item, and the
 * runtime noise (`role: 'system'`) must be routed out of the reading flow into
 * the technical-details section.
 *
 * Pairing rules, in priority order:
 *  1. `toolCallId` match — the harness-native id, the only reliable pairing key.
 *  2. Nearest still-open card with no id — older records and harnesses that do
 *     not emit ids at all still read as one card per call.
 *  3. Orphan `end` (no matching open card) renders as its own finished card
 *     rather than being dropped: a result with no visible start is still the
 *     only evidence the user has that the call happened.
 */

import type {
  SubagentControlAction,
  SubagentTranscriptEntry,
} from '@cindy/maker-shared/subagent-workspace';

export interface SubagentMessageItem {
  kind: 'parent' | 'subagent';
  id: string;
  content: string;
  occurredAt: number;
  controlAction?: SubagentControlAction;
}

export interface SubagentToolItem {
  kind: 'tool';
  id: string;
  toolName?: string;
  /** One-line human-readable summary, e.g. `read(/tmp/a.ts)`. */
  summary: string;
  inputJson?: string;
  result?: string;
  isError: boolean;
  /** False while the matching `end` half has not arrived yet. */
  done: boolean;
  occurredAt: number;
}

export type SubagentConversationItem = SubagentMessageItem | SubagentToolItem;

export interface SubagentConversation {
  /** Reading flow, in transcript order. */
  items: SubagentConversationItem[];
  /** Runtime noise, kept out of the flow and shown under technical details. */
  system: SubagentTranscriptEntry[];
}

const EMPTY_CONVERSATION: SubagentConversation = { items: [], system: [] };

export function buildSubagentConversation(
  entries: readonly SubagentTranscriptEntry[],
): SubagentConversation {
  if (entries.length === 0) return EMPTY_CONVERSATION;
  const items: SubagentConversationItem[] = [];
  const system: SubagentTranscriptEntry[] = [];
  const openByCallId = new Map<string, SubagentToolItem>();
  const openAnonymous: SubagentToolItem[] = [];

  for (const entry of entries) {
    if (entry.role === 'system') {
      system.push(entry);
      continue;
    }
    if (entry.role !== 'tool') {
      items.push({
        kind: entry.role,
        id: entry.id,
        content: entry.content,
        occurredAt: entry.occurredAt,
        ...(entry.controlAction ? { controlAction: entry.controlAction } : {}),
      });
      continue;
    }
    if (entry.toolPhase === 'end') {
      const paired = entry.toolCallId
        ? openByCallId.get(entry.toolCallId)
        : openAnonymous[openAnonymous.length - 1];
      if (paired) {
        paired.result = entry.content;
        paired.isError = entry.isError === true;
        paired.done = true;
        if (entry.toolName && !paired.toolName) paired.toolName = entry.toolName;
        if (entry.toolCallId) openByCallId.delete(entry.toolCallId);
        else openAnonymous.pop();
        continue;
      }
      items.push({
        kind: 'tool',
        id: entry.id,
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
        summary: entry.toolName ?? '',
        result: entry.content,
        isError: entry.isError === true,
        done: true,
        occurredAt: entry.occurredAt,
      });
      continue;
    }
    if (entry.toolPhase !== 'start') {
      // Legacy entry with no phase at all — an older device-link host still
      // serializing the whole harness event into `content`. That text belongs
      // behind the fold, not on the one-line truncated header: put it in the
      // card body so the old record stays readable (the degradation promise in
      // `subagentWorkspace.ts`), and let the card's fallback name label it.
      items.push({
        kind: 'tool',
        id: entry.id,
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
        summary: entry.toolName ?? '',
        ...(entry.toolInputJson ? { inputJson: entry.toolInputJson } : {}),
        result: entry.content,
        isError: entry.isError === true,
        done: true,
        occurredAt: entry.occurredAt,
      });
      continue;
    }
    const item: SubagentToolItem = {
      kind: 'tool',
      id: entry.id,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      summary: entry.content,
      ...(entry.toolInputJson ? { inputJson: entry.toolInputJson } : {}),
      isError: entry.isError === true,
      done: false,
      occurredAt: entry.occurredAt,
    };
    items.push(item);
    if (entry.toolCallId) openByCallId.set(entry.toolCallId, item);
    else openAnonymous.push(item);
  }

  return { items, system };
}

/** Id of the last assistant item, used to gate the single hover action bar. */
export function lastAssistantItemId(items: readonly SubagentConversationItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'subagent') return item.id;
  }
  return null;
}
