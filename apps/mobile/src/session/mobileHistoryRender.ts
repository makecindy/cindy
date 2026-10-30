import { renderHistoryView, type HistoryViewController, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import type { AgentTaskUpdate } from '@cindy/maker-shared/agent-task';
import { buildMobileMessageRenderItems, insertMobileForkOriginItem, type MobileForkOrigin, type MobileMessageRenderItem, type MobileWorkChildItem } from './messageRenderModel';
import type { RemoteMessage } from './types';
import { buildMobileStreamingRenderWindow, committedMobileStreamingPrefixItemCount,
  type MobileStreamingRenderPrefixCache } from './messageRenderStreamingCache';
import { reconcileMobileMessageRenderItems } from './messageRenderReconcile';
import { countMobileRenderItemDiffs } from './messagePresentation';

export function buildMobileHistoryRenderItems(options: {
  view: HistoryViewController<RemoteMessage>;
  snapshot: HistoryViewSnapshot<RemoteMessage>;
  messages: readonly RemoteMessage[];
  streaming: boolean;
  sessionId: string;
  sessionSource?: string | null;
  pendingHandoff?: ReadonlySet<string>;
  staleTail?: ReadonlySet<string>;
  localUserClientIds?: ReadonlySet<string>;
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>;
}): MobileMessageRenderItem[] {
  return renderHistoryView<RemoteMessage, MobileMessageRenderItem>({
    view: options.view, snapshot: options.snapshot, liveMessages: options.messages,
    isLive: (row) => row.agentMeta?.isStreaming === true,
    pendingHandoff: options.pendingHandoff,
    staleTail: options.staleTail,
    isLocalUser: (row) => options.localUserClientIds?.has(row.clientId) === true,
    streaming: options.streaming,
    build: (rows, streaming) => buildMobileMessageRenderItems(rows, {
      isSessionStreaming: streaming,
      sessionId: options.sessionId,
      sessionSource: options.sessionSource,
      preserveSourceOrder: true,
    }, options.taskUpdates),
    structure: {
      placeholder: (summary) => ({ id: summary.firstMessageId,
        clientId: summary.anchorClientId ?? summary.key.slice('work-'.length), sessionId: options.sessionId,
        role: 'thinking', content: { text: '', isRedacted: true, durationMs: Math.max(0, summary.endedAtMs - summary.startedAtMs) },
        createdAt: new Date(summary.endedAtMs).toISOString(), toolUseId: null, agentMeta: null,
      }),
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
  history, raw, previousRenderState, forkOrigin, errorTailClientId,
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
}) {
  // A ready history view owns the displayed sequence. Retire the raw prefix
  // before a later fallback, and never normalize a transcript we will not show.
  if (history.snapshot.ready && raw.prefixCache) raw.prefixCache.current = null;
  const builtWindow = history.snapshot.ready ? null : buildMobileStreamingRenderWindow(raw);
  const historyItems = builtWindow ? builtWindow.items : buildMobileHistoryRenderItems(history);
  let items = insertMobileForkOriginItem(
    historyItems,
    forkOrigin,
  );
  if (errorTailClientId) {
    items = items.filter(
      (item) => !(item.type === 'message' && item.message.source.clientId === errorTailClientId),
    );
  }
  const committed = previousRenderState?.sessionId === history.sessionId ? previousRenderState : null;
  const previous = committed?.items ?? [];
  const committedPrefix = !builtWindow || forkOrigin || errorTailClientId
    ? null
    : builtWindow.prefix;
  const stablePrefixItemCount = !builtWindow || forkOrigin || errorTailClientId
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
    diffCount: !builtWindow || errorTailClientId
      ? countMobileRenderItemDiffs(reconciled)
      : builtWindow.diffCount,
    items: reconciled,
    prefix: committedPrefix,
    stablePrefixItemCount,
  };
}
