import {
  HISTORY_WORK_LINE_TEXT_CHARS, isHistoryDetailTool, hasVisibleHistoryResult,
  type HistoryMessageSource, type HistoryViewPage, type HistoryWorkPatch,
} from '@cindy/maker-shared/message-window';
import type { HistoryPageShape } from '../localDb/ipc/historyViewReader';
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Conservative classification: interactions, errors and reference-bearing results stay live. */
export function isDeferredHistoryPush(channel: string, payload: unknown, toolName: (id: string) => string): boolean {
  const push = record(payload);
  if (!push) return false;
  if (channel === 'local-db:messages:created') {
    const row = record(push.message);
    if (!row) return false;
    if (row.role === 'thinking') return true;
    const content = record(row.content);
    if (row.role === 'tool_use') return isHistoryDetailTool(String(content?.toolName ?? ''));
    if (row.role !== 'tool_result' || hasVisibleHistoryResult(row.content)) return false;
    return typeof row.toolUseId === 'string' && isHistoryDetailTool(toolName(row.toolUseId));
  }
  if (channel !== 'maker:event') return false;
  const event = record(push.event);
  const data = record(event?.data);
  if (!event || !data || data.isError === true) return false;
  if (event.type === 'thinking') return true;
  if (event.type === 'tool_use') return isHistoryDetailTool(String(data.toolName ?? ''));
  if (event.type !== 'tool_result' && event.type !== 'tool_result_full') return false;
  if ([push.resolvedContent, data.summary, data.fullText].some(hasVisibleHistoryResult)) return false;
  const ids = typeof data.toolUseId === 'string' ? [data.toolUseId] : data.toolUseIds;
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && isHistoryDetailTool(toolName(id)));
}

/** Retain tool-start boundaries so a controller can finish the preceding assistant text. */
export function deferredToolBoundary(payload: unknown): unknown | null {
  const push = record(payload);
  const event = record(push?.event);
  const data = record(event?.data);
  return push && event?.type === 'tool_use' && data
    ? { ...push, event: { ...event, data: { toolUseId: data.toolUseId, toolName: data.toolName, input: null } } }
    : null;
}

const HISTORY_WORK_PATCH_MAX_BYTES = 64 * 1024;

type WorkPageReader = (sessionId: string, onShape: (shape: HistoryPageShape) => void) => Promise<HistoryViewPage<HistoryMessageSource>>;
let workPageReader: WorkPageReader | null = null;

/** Registered by the history IPC module; dispatch reads the same latest page the controller would. */
export function setHistoryWorkPageReader(reader: WorkPageReader | null): void {
  workPageReader = reader;
}

/**
 * The single running top-level item whose replacement turns `delivered` into `next`,
 * or null when anything else on the page changed (new group, prose, cards, a cleared or
 * rewound range, a different page window) and the controller must re-read the page.
 */
export function historyWorkPatchKey(delivered: HistoryPageShape, next: HistoryPageShape): string | null {
  if (next.running.size !== 1 || delivered.running.size !== 1) return null;
  if (delivered.keys.length !== next.keys.length || delivered.keys.some((key, index) => key !== next.keys[index])) return null;
  if (delivered.fingerprints.some((value, index) => value !== next.fingerprints[index])) return null;
  const [key] = next.running.keys();
  return delivered.running.has(key) ? key : null;
}

export type HistoryWorkPatchResult =
  | { kind: 'patch'; patch: HistoryWorkPatch; shape: HistoryPageShape }
  | { kind: 'unchanged' }
  | { kind: 'refresh' };

/** Build the push that replaces an activity notice for a controller with a delivered shape. */
export async function buildHistoryWorkPatch(sessionId: string, delivered: HistoryPageShape): Promise<HistoryWorkPatchResult> {
  if (!workPageReader) return { kind: 'refresh' };
  let shape: HistoryPageShape | undefined;
  let page: HistoryViewPage<HistoryMessageSource>;
  try {
    page = await workPageReader(sessionId, (value) => { shape = value; });
  } catch {
    // The controller's own read reports a real failure through its existing path.
    return { kind: 'refresh' };
  }
  const key = shape ? historyWorkPatchKey(delivered, shape) : null;
  const item = key ? page.items.find((value) => value.key === key) : undefined;
  if (!shape || !key || item?.type !== 'work' || item.children) return { kind: 'refresh' };
  const baseRevision = delivered.running.get(key)!;
  if (item.summary.revision === baseRevision) return { kind: 'unchanged' };
  const patch: HistoryWorkPatch = { version: 1, sessionId, baseRevision, item: { type: 'work', key, summary: item.summary } };
  // A summary with an unusually long artifact list goes through the page read, which
  // owns the oversized-frame handling; a push has none.
  if (Buffer.byteLength(JSON.stringify(patch), 'utf8') > HISTORY_WORK_PATCH_MAX_BYTES) return { kind: 'refresh' };
  return { kind: 'patch', shape, patch };
}

/**
 * Folded thinking deltas normally produce no notice. A work-line controller still needs
 * the opening of the thought, so deltas notify while its visible line can still change.
 * The visible prefix follows the line projection: leading and trailing whitespace is
 * dropped and every whitespace run becomes one space, including runs split across chunks.
 */
const thinkingLinePrefixes = new Map<string, { blockId: unknown; visible: string; pendingSpace: boolean }>();
export function thinkingDeltaUpdatesWorkLine(sessionId: string, payload: unknown): boolean {
  const event = record(record(payload)?.event);
  const data = record(event?.data);
  if (event?.type !== 'thinking' || data?.stage !== 'delta') return false;
  const current = thinkingLinePrefixes.get(sessionId);
  const state = current && current.blockId === data.blockId
    ? current : { blockId: data.blockId, visible: '', pendingSpace: false };
  const before = state.visible;
  // One character past the line length decides whether the line shows an ellipsis.
  const text = typeof data.text === 'string' ? data.text : '';
  for (let index = 0; index < text.length && state.visible.length <= HISTORY_WORK_LINE_TEXT_CHARS; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      state.pendingSpace = state.visible.length > 0;
      continue;
    }
    if (state.pendingSpace) state.visible += ' ';
    state.pendingSpace = false;
    state.visible += char;
  }
  thinkingLinePrefixes.delete(sessionId);
  thinkingLinePrefixes.set(sessionId, state);
  if (thinkingLinePrefixes.size > 256) thinkingLinePrefixes.delete(thinkingLinePrefixes.keys().next().value!);
  return state.visible !== before;
}
