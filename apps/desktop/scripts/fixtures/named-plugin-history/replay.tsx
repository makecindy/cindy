import { useEffect, useState } from 'react';
import { projectHistoryView, type HistoryWorkReference } from '@cindy/maker-shared/message-window';
import { MessageStream } from '@/components/chat/MessageStream';
import { ingestCardPush } from '@/cindy-brain/ghostCardStore';
import { getRemoteHistoryView, makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
import { AppFrame, ctx, mountPage, subscription } from '../../ui-page/harness';

const completed = ctx.case === 'completed';
const isClaude = ctx.case.startsWith('claude');
const legacy = ctx.case === 'legacy';
const agentKind = isClaude ? 'cc' : ctx.case === 'pi' ? 'pi' : 'codex';
const sessionId = 'named-plugin-history-replay';
const startupToolName = 'ghost_start_library_find_529157ba331ac99bbeaa';
const toolPrefix = isClaude ? 'mcp__cindy__' : 'mcp:cindy:';
const toolName = toolPrefix + (legacy ? 'ghost_call' : startupToolName);
const toolUseId = isClaude ? 'toolu_replay' : 'call_replay';
const callId = 'replay-card';
const result = JSON.stringify({ xdt_card_id: callId, marker: 'startup-ping-ok' });

function row(index: number, role: Message['role'], content: Message['content']): Message {
  return {
    id: String(index), clientId: `row-${index}`, sessionId, role, content, agentKind,
    toolUseId: role === 'tool_use' || role === 'tool_result' ? toolUseId : null,
    createdAt: new Date(Date.UTC(2026, 10, 24) + index * 1000).toISOString(),
    agentMeta: role === 'assistant' ? { turnCompleted: true } : null,
  };
}

const user = row(1, 'user', 'Run the fixture tool');
const call = row(2, 'tool_use', {
  toolName, toolUseId, input: legacy ? { ghost_id: 'library', tool: 'find' } : { args: {} },
});
const resultRow = row(3, 'tool_result', result);
const liveResult: ChatMessage = {
  id: resultRow.id, clientId: resultRow.clientId, role: 'tool_result',
  content: result, toolUseId, createdAt: resultRow.createdAt, isStreaming: true,
};
const rows = completed
  ? [user, call, resultRow, row(4, 'assistant', 'Fixture complete')]
  : agentKind === 'pi' ? [user, call, resultRow] : [user, call];

function pushCard() {
  ingestCardPush({
    sessionId, callId, ghostId: 'library', state: 'done',
    toolUseId: isClaude || agentKind === 'pi' ? toolUseId : null,
    ...(legacy ? {} : { startupToolName }),
    html: '<p>startup-ping-ok</p>', height: 88,
  });
}

function Replay() {
  const [ready, setReady] = useState(false);
  const [frame, setFrame] = useState(0);
  const resultArrived = frame === 2;
  useEffect(() => {
    makerChatStore.ensureInitialMessages(sessionId);
    const view = getRemoteHistoryView(sessionId);
    if (!view) throw new Error('Local history controller unavailable');
    let previous = view.getSnapshot().expanded;
    let changes = 0;
    const observe = () => {
      const snapshot = view.getSnapshot();
      if (snapshot.ready) setReady(true);
      if (snapshot.expanded !== previous) {
        previous = snapshot.expanded;
        document.documentElement.dataset.replayExpansionChanges = String(++changes);
      }
      if ([...snapshot.details.values()].some(detail => detail.complete)) {
        document.documentElement.dataset.replayPreview = 'loaded';
      }
    };
    observe();
    return view.subscribe(observe);
  }, []);
  return (
    <AppFrame header={false}>
      {ready && (
        <div data-replay-ready className="flex min-h-0 flex-1 flex-col">
          {!completed && frame === 0 && (
            <button data-ui-page-control onClick={() => {
              pushCard();
              setFrame(ctx.case.endsWith('-together') || agentKind === 'pi' ? 2 : 1);
            }}>Deliver fixture frame</button>
          )}
          {frame === 1 && (
            <button data-ui-page-control onClick={() => setFrame(2)}>Deliver result</button>
          )}
          <MessageStream
            sessionId={sessionId} agentKind={agentKind} ownerDeviceId={null}
            historyLoaded workingDir="/fixture" isSessionStreaming={!completed}
            messages={resultArrived && agentKind !== 'pi' ? [liveResult] : []}
          />
        </div>
      )}
    </AppFrame>
  );
}

void mountPage({
  route: '/fixture',
  host: {
    onSelectionContextMenuAddToChat: subscription('selection-context-menu'),
    ghosts: {
      listCardsBySession: async () => ({ cards: completed ? [{ callId, ghostId: 'library', html: '<p>startup-ping-ok</p>', height: 88 }] : [] }),
    },
    localDb: {
      sessions: { get: async () => ({ id: sessionId, agentKind }) },
      messages: {
        historyView: async () => ({
          version: 1, items: projectHistoryView(rows, !completed, true),
          hasMore: false, nextCursor: null,
        }),
        workDetails: async (_session: string, reference: HistoryWorkReference) => {
          const first = rows.findIndex((item) => item.id === reference.firstMessageId);
          const last = rows.findIndex((item) => item.id === reference.lastMessageId);
          return { version: 1, messages: rows.slice(first, last + 1), hasMore: false, nextCursor: null };
        },
      },
    },
  },
  render: () => <Replay />,
});
