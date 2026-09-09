import { groupWorkRuns } from './workRunGrouping.js';
import { isAgentPlanToolName, isDeliveryProseText } from './messageRender.js';
import { isAgentTaskToolName } from './agentTask.js';
import { extractPayloadToolResultMedia } from './payloadSummary.js';
import { isOrcaCommunicationTool, messageContentToPreview, parseMessageToolUse } from './messageNormalize.js';
import type { HistoryMessageSource, HistoryViewItem, HistoryWorkSummary } from './historyView.js';

type SourceItem<T extends HistoryMessageSource> = {
  type: 'source';
  row: T;
  activity: boolean;
  archivable: boolean;
};
type GroupItem<T extends HistoryMessageSource> = { type: 'group'; summary: HistoryWorkSummary; children?: HistoryViewItem<T>[] };

/** A tool can carry a durable card/interaction even before its result exists. */
export function isHistoryDetailTool(name: string): boolean {
  return !!name && !isAgentTaskToolName(name) && !isAgentPlanToolName(name)
    && !isOrcaCommunicationTool(name)
    && !['AskUserQuestion', 'ExitPlanMode', 'Workflow', 'Edit', 'Write', 'MultiEdit', 'edit', 'write'].includes(name)
    && !/(?:^|:|__)(?:create_worker|create_workers|send_to_worker|ghost_call)$/.test(name);
}

export function hasVisibleHistoryResult(content: unknown): boolean {
  const text = messageContentToPreview(content);
  if (extractPayloadToolResultMedia(text).length > 0 || /^(?:cindy-media|xdt-file):\/\/\S+$/.test(text.trim())) return true;
  // Source listings often contain these field names and error markers. Only a
  // real result object can claim a card; ordinary tool errors remain activities.
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    return !!value && !Array.isArray(value) && (typeof value.xdt_card_id === 'string'
      || typeof value.xdt_anchor_card_id === 'string');
  } catch { return false; }
}

/**
 * Uses the same turn/seal/delivery boundaries as both renderers. Unknown cards and
 * reference-bearing results stay as source rows, so platform presentation keeps
 * ownership of their rendering. Only contiguous, recoverable work ranges fold.
 */
export function projectHistoryView<T extends HistoryMessageSource>(
  rows: readonly T[],
  streaming: boolean,
): HistoryViewItem<T>[] {
  const names = new Map<string, string>();
  const visibleResults = new Set<string>();
  const nestedCalls = new Set<string>();
  for (const row of rows) {
    if (row.role === 'tool_use') {
      const tool = parseMessageToolUse(row);
      if (tool.toolUseId) names.set(tool.toolUseId, tool.toolName);
      if (tool.toolUseId && (row.agentMeta as { parentUuid?: unknown } | null)?.parentUuid) nestedCalls.add(tool.toolUseId);
    }
    if (row.role === 'tool_result' && row.toolUseId && hasVisibleHistoryResult(row.content)) {
      visibleResults.add(row.toolUseId);
    }
  }
  const source: SourceItem<T>[] = rows.map((row) => {
    const meta = row.agentMeta as Record<string, unknown> | null | undefined;
    const tool = row.role === 'tool_use' ? parseMessageToolUse(row) : null;
    const toolId = tool?.toolUseId ?? row.toolUseId;
    const toolName = tool?.toolName ?? (toolId ? names.get(toolId) : undefined);
    // True child-agent trees are owned by the original platform renderer. A
    // parentless placeholder must never lift their rows into the main timeline.
    const nested = (typeof meta?.parentUuid === 'string' && !!meta.parentUuid) || !!(toolId && nestedCalls.has(toolId));
    const thought = row.content as { text?: string; durationMs?: number; isRedacted?: boolean } | null;
    const visibleThinking = row.role === 'thinking' && (typeof row.content === 'string' ? !!row.content
      : !!thought?.text || !!thought?.durationMs || thought?.isRedacted === true);
    const activity = !nested && (visibleThinking || (
      (row.role === 'tool_use' || row.role === 'tool_result')
      && isHistoryDetailTool(toolName ?? '')
      && !(toolId && visibleResults.has(toolId))
    ));
    const plainAssistant = !nested && row.role === 'assistant' && typeof row.content === 'string'
      && !meta?.botCollaboration && !meta?.botDirectMessage
      && !meta?.systemCardType && !meta?.goalCompletion && !meta?.goalNotice && !meta?.reviewRun;
    return { type: 'source', row, activity, archivable: activity || (
      plainAssistant && !isDeliveryProseText(row.content as string)
    ) };
  });
  // Media/card placement belongs to the original renderer's whole tool segment.
  // Keep a mixed segment as source rather than inserting a thinking placeholder
  // between its tools, which would move the media and create an extra work group.
  let toolSegment: SourceItem<T>[] = [];
  const flushToolSegment = () => {
    if (toolSegment.some((item) => !item.activity)) {
      for (const item of toolSegment) { item.activity = false; item.archivable = false; }
    }
    toolSegment = [];
  };
  for (const item of source) {
    if (item.row.role === 'tool_use' || item.row.role === 'tool_result') toolSegment.push(item);
    else flushToolSegment();
  }
  flushToolSegment();
  type Item = SourceItem<T> | GroupItem<T>;
  const timestamp = (item: Item | undefined): number | null => {
    if (!item) return null;
    const ms = item.type === 'group' ? item.summary.startedAtMs : Date.parse(item.row.createdAt);
    return Number.isFinite(ms) ? ms : null;
  };
  const group = (run: SourceItem<T>[], active: boolean, boundary: number | null): GroupItem<T> => {
    const first = run[0].row;
    const last = run[run.length - 1].row;
    const anchor = run.find((item) => item.activity && item.row.role !== 'tool_result')?.row ?? first;
    const startedAtMs = boundary ?? Date.parse(first.createdAt);
    const endedAtMs = Date.parse(last.createdAt);
    let hash = 2166136261;
    for (const item of run) {
      const text = JSON.stringify(item.row);
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return { type: 'group', summary: {
      key: `work-${anchor.clientId || anchor.id}`,
      anchorClientId: anchor.clientId || anchor.id,
      firstMessageId: first.id, lastMessageId: last.id,
      ...(run.some((item) => item.row.id.startsWith('history-live:')) ? {
        firstStoredMessageId: run.find((item) => !item.row.id.startsWith('history-live:'))?.row.id,
        lastStoredMessageId: [...run].reverse().find((item) => !item.row.id.startsWith('history-live:'))?.row.id,
        liveMessageIds: run.filter((item) => item.row.id.startsWith('history-live:')).map((item) => item.row.id),
      } : {}),
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
      endedAtMs: Number.isFinite(endedAtMs) ? endedAtMs : 0,
      messageCount: run.length,
      toolCount: run.filter((item) => item.row.role === 'tool_use').length,
      isStreaming: active,
      revision: `${last.id}:${run.length}:${hash >>> 0}`,
    } };
  };
  const toViewItem = (item: Item): HistoryViewItem<T> => item.type === 'group'
    ? { type: 'work', key: item.summary.key, summary: item.summary, ...(item.children ? { children: item.children } : {}) }
    : { type: 'messages', key: item.row.clientId || item.row.id, messages: [item.row] };
  const activityGroup = (run: SourceItem<T>[], active: boolean, boundary: number | null): GroupItem<T> => {
    const result = group(run, active, boundary);
    const calls = new Set(run.filter((item) => item.row.role === 'tool_use').map((item) => parseMessageToolUse(item.row).toolUseId));
    const isUnpairedResult = (item: SourceItem<T>) => item.row.role === 'tool_result' && !calls.has(item.row.toolUseId ?? undefined);
    if (run.some(isUnpairedResult)) {
      const children: HistoryViewItem<T>[] = [];
      let segment: SourceItem<T>[] = [];
      const flush = () => {
        if (segment.length) children.push(toViewItem(activityGroup(segment, active, boundary)));
        segment = [];
      };
      for (const item of run) {
        if (isUnpairedResult(item)) { flush(); children.push(toViewItem(item)); }
        else segment.push(item);
      }
      flush();
      result.children = children;
      return result;
    }
    if (active) {
      const indexes = run.flatMap((item, index) => item.row.role === 'thinking' || item.row.role === 'tool_use' ? [index] : []);
      const tail = run.slice(indexes[Math.max(0, indexes.length - 5)] ?? 0);
      result.summary.preview = { ...group(tail, true, boundary).summary, key: `preview-${result.summary.key}` };
    }
    return result;
  };
  const grouped = groupWorkRuns<Item, SourceItem<T>>(source, streaming, {
    isUserBoundary: (item) => item.type === 'source' && item.row.role === 'user',
    isAnswer: (item) => item.type === 'source' && item.row.role === 'assistant'
      && typeof item.row.content === 'string' && !!item.row.content.trim(),
    isSealedAnswer: (item) => item.type === 'source'
      && (item.row.agentMeta as Record<string, unknown> | null)?.turnCompleted === true,
    isCompactBoundary: (item) => item.type === 'source' && item.row.role === 'system',
    isActivity: (item): item is SourceItem<T> => item.type === 'source' && item.activity,
    isArchivable: (item): item is SourceItem<T> => item.type === 'source' && item.archivable,
    startTimestamp: timestamp,
    endTimestamp: timestamp,
    boundaryTimestamp: timestamp,
    userBoundaryEnd: (item, previous) => timestamp(item) ?? previous,
    createGroup: (run, _next, active, boundary) => activityGroup(run, active, boundary),
    createCompletedGroup: (run, _next, boundary) => {
      if (!run.some((item) => !item.activity)) return activityGroup(run, false, boundary);
      const result = group(run, false, boundary);
      result.summary.key = `work-summary-${result.summary.anchorClientId}`;
      const children: HistoryViewItem<T>[] = [];
      let activities: SourceItem<T>[] = [];
      let previous = boundary;
      const flush = () => {
        if (activities.length) children.push(toViewItem(activityGroup(activities, false, previous)));
        activities = [];
      };
      for (const item of run) {
        if (item.activity) activities.push(item);
        else { flush(); children.push(toViewItem(item)); previous = timestamp(item); }
      }
      flush();
      result.children = children;
      return result;
    },
  });
  return grouped.map(toViewItem);
}
