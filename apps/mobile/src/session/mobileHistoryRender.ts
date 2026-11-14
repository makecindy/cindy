import { renderHistoryView, type HistoryViewController, type HistoryViewSnapshot, type HistoryWorkSummary } from '@cindy/maker-shared/message-window';
import type { AgentTaskUpdate } from '@cindy/maker-shared/agent-task';
import { insertMobileForkOriginItem, type MobileForkOrigin, type MobileMessageRenderItem, type MobileWorkChildItem } from './messageRenderModel';
import type { RemoteMessage } from './types';
import { buildMobileStreamingRenderWindow, committedMobileStreamingPrefixItemCount,
  type MobileStreamingRenderPrefixCache } from './messageRenderStreamingCache';
import { reconcileMobileMessageRenderItems } from './messageRenderReconcile';
import { countMobileRenderItemDiffs } from './messagePresentation';

// One derived prefix per history owner; it cannot outlive the controller. The raw
// fallback has a separate cache because its sequence is not the history sequence.
const historyPrefixes = new WeakMap<HistoryViewController<RemoteMessage>, {
  key: string;
  prefix: { current: MobileStreamingRenderPrefixCache | null };
  placeholders: WeakMap<HistoryWorkSummary, RemoteMessage>;
}>();

export function buildMobileHistoryRenderItems(options: {
  view: HistoryViewController<RemoteMessage>;
  snapshot: HistoryViewSnapshot<RemoteMessage>;
  messages: readonly RemoteMessage[];
  streaming: boolean;
  sessionId: string;
  sessionSource?: string | null;
  pendingQuestionIds?: ReadonlySet<string>;
  pendingHandoff?: ReadonlySet<string>;
  staleTail?: ReadonlySet<string>;
  localUserClientIds?: ReadonlySet<string>;
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>;
  cacheKey?: string;
}): MobileMessageRenderItem[] {
  const key = JSON.stringify([options.sessionId, options.sessionSource, options.cacheKey]);
  let cache = historyPrefixes.get(options.view);
  if (!cache || cache.key !== key) {
    cache = { key, prefix: { current: null }, placeholders: new WeakMap() };
    historyPrefixes.set(options.view, cache);
  }
  const renderCache = cache;
  return renderHistoryView<RemoteMessage, MobileMessageRenderItem>({
    view: options.view, snapshot: options.snapshot, liveMessages: options.messages,
    isLive: (row) => row.agentMeta?.isStreaming === true,
    pendingHandoff: options.pendingHandoff,
    staleTail: options.staleTail,
    isLocalUser: (row) => options.localUserClientIds?.has(row.clientId) === true,
    streaming: options.streaming,
    build: (rows, streaming) => buildMobileStreamingRenderWindow({
      messages: rows, cacheKey: key, prefixCache: renderCache.prefix, allowTruncatedTurn: false,
      // Do not pass the raw store's structure token: history paging, handoff and
      // lazy work can give these rows a different order. Exact prefix references
      // prove reuse, including late edits and loaded/expanded work details.
      options: {
        isSessionStreaming: streaming,
        sessionId: options.sessionId,
        sessionSource: options.sessionSource,
        pendingQuestionIds: options.pendingQuestionIds,
        preserveSourceOrder: true,
      }, taskUpdates: options.taskUpdates,
    }).items,
    structure: {
      placeholder: (summary) => {
        let row = renderCache.placeholders.get(summary);
        if (!row) {
          row = { id: summary.firstMessageId,
            clientId: summary.anchorClientId ?? summary.key.slice('work-'.length), sessionId: options.sessionId,
            role: 'thinking', content: { text: '', isRedacted: true, durationMs: Math.max(0, summary.endedAtMs - summary.startedAtMs) },
            createdAt: new Date(summary.endedAtMs).toISOString(), toolUseId: null, agentMeta: null,
          };
          renderCache.placeholders.set(summary, row);
        }
        return row;
      },
      children: (item) => item.type === 'work_group' ? item.children
        : item.type === 'subagent_group' ? item.childItems : undefined,
      sourceIds: (item) => item.type === 'subagent_group' && item.sourceClientId ? [item.sourceClientId]
        : item.type === 'message' || item.type === 'thinking' ? [item.message.source.clientId]
        : item.type === 'tool_group' || item.type === 'tool_media' ? item.tools.map((tool) => tool.source.clientId)
        : item.type === 'agent_task' && item.toolCall ? [item.toolCall.source.clientId] : [],
      rebuild: (item, children, deferred) => item.type === 'work_group'
        ? { ...item, children: children as MobileWorkChildItem[], deferred }
        : item.type === 'subagent_group' ? { ...item, childItems: children, deferred } : item,
    },
  });
}

/** The screen's full render window, shared by history takeover and raw fallback. */
export function buildMobileSessionRenderWindow({
  history, raw, previousRenderState, forkOrigin, errorTailClientId, activeErrorClientId,
}: {
  history: Parameters<typeof buildMobileHistoryRenderItems>[0];
  raw: Parameters<typeof buildMobileStreamingRenderWindow>[0];
  previousRenderState?: {
    sessionId: string;
    items: readonly MobileMessageRenderItem[];
    prefix: MobileStreamingRenderPrefixCache | null;
  } | null;
  forkOrigin?: MobileForkOrigin | null;
  errorTailClientId?: string | null;
  /** Exact persisted error already owned by the live queue banner. */
  activeErrorClientId?: string | null;
}) {
  // A ready history view owns the displayed sequence. Retire the raw prefix
  // before a later fallback, and never normalize a transcript we will not show.
  if (history.snapshot.ready && raw.prefixCache) raw.prefixCache.current = null;
  const builtWindow = history.snapshot.ready ? null : buildMobileStreamingRenderWindow(raw);
  const historyItems = builtWindow ? builtWindow.items : buildMobileHistoryRenderItems({ ...history, cacheKey: raw.cacheKey });
  let items = insertMobileForkOriginItem(
    historyItems,
    forkOrigin,
  );
  const hasHiddenError = Boolean(errorTailClientId || activeErrorClientId);
  if (hasHiddenError) {
    items = items.filter(
      (item) => !(item.type === 'message' && item.message.role === 'error'
        && (item.message.source.clientId === errorTailClientId
          || item.message.source.clientId === activeErrorClientId)),
    );
  }
  const committed = previousRenderState?.sessionId === history.sessionId ? previousRenderState : null;
  const previous = committed?.items ?? [];
  const committedPrefix = !builtWindow || forkOrigin || hasHiddenError
    ? null
    : builtWindow.prefix;
  const stablePrefixItemCount = !builtWindow || forkOrigin || hasHiddenError
    ? 0
    : committedMobileStreamingPrefixItemCount(
        builtWindow,
        committed?.prefix,
      );
  const reconciled = reconcileMobileMessageRenderItems(
    previous,
    items,
    stablePrefixItemCount,
  );
  return {
    diffCount: !builtWindow || hasHiddenError
      ? countMobileRenderItemDiffs(reconciled)
      : builtWindow.diffCount,
    items: reconciled,
    prefix: committedPrefix,
    stablePrefixItemCount,
  };
}
