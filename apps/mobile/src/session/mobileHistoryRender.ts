import { renderHistoryView, type HistoryViewController, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import type { AgentTaskUpdate } from '@cindy/maker-shared/agent-task';
import { buildMobileMessageRenderItems, type MobileMessageRenderItem, type MobileWorkChildItem } from './messageRenderModel';
import type { RemoteMessage } from './types';

export function buildMobileHistoryRenderItems(options: {
  view: HistoryViewController<RemoteMessage>;
  snapshot: HistoryViewSnapshot<RemoteMessage>;
  messages: readonly RemoteMessage[];
  streaming: boolean;
  sessionId: string;
  pendingHandoff?: ReadonlySet<string>;
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>;
}): MobileMessageRenderItem[] {
  return renderHistoryView<RemoteMessage, MobileMessageRenderItem>({
    view: options.view, snapshot: options.snapshot, liveMessages: options.messages,
    isLive: (row) => row.agentMeta?.isStreaming === true,
    pendingHandoff: options.pendingHandoff,
    streaming: options.streaming,
    build: (rows, streaming) => buildMobileMessageRenderItems(rows, { isSessionStreaming: streaming, sessionId: options.sessionId }, options.taskUpdates),
    structure: {
      placeholder: (summary) => ({ id: summary.firstMessageId,
        clientId: summary.anchorClientId ?? summary.key.slice('work-'.length), sessionId: options.sessionId,
        role: 'thinking', content: { text: '', isRedacted: true, durationMs: Math.max(0, summary.endedAtMs - summary.startedAtMs) },
        createdAt: new Date(summary.endedAtMs).toISOString(), toolUseId: null, agentMeta: null,
      }),
      children: (item) => item.type === 'work_group' ? item.children
        : item.type === 'subagent_group' ? item.childItems : undefined,
      sourceIds: (item) => item.type === 'message' || item.type === 'thinking' ? [item.message.source.clientId]
        : item.type === 'tool_group' || item.type === 'tool_media' ? item.tools.map((tool) => tool.source.clientId)
        : item.type === 'agent_task' && item.toolCall ? [item.toolCall.source.clientId] : [],
      rebuild: (item, children, deferred) => item.type === 'work_group'
        ? { ...item, children: children as MobileWorkChildItem[], deferred }
        : item.type === 'subagent_group' ? { ...item, childItems: children } : item,
    },
  });
}
