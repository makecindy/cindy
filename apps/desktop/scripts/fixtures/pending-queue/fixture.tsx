import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { useState } from 'react';
import { appendPendingQueueItems } from '../../../src/renderer/components/chat/pendingQueueItems';
import { mountPage } from '../../ui-page/harness';
import { PendingQueueBubble } from '../../../src/renderer/components/chat/PendingQueueBubble';
import type { QueuedMessage } from '../../../src/renderer/lib/makerChatStore';
function entry(clientId: string, text: string): QueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    chatMessage: { clientId, role: 'user', content: text, isStreaming: false },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/fixture',
      model: 'test',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: false,
      displayReasoning: 'summarized',
    },
  } as QueuedMessage;
}
function Fixture() {
  const [queue, setQueue] = useState([
    entry('question-reply:answered:fixture', '这条回答只在原问题卡片展示。'),
    {
      ...entry('worker', '复核已完成，请先查看这条结果。'),
      origin: {
        kind: 'session' as const,
        senderSessionId: 'reviewer',
        senderSessionTitle: 'Worker · reviewer',
        displayText: '复核已完成，请先查看这条结果。',
      },
    },
    entry('first', '先检查手机版消息排队的处理逻辑。'),
    entry('second', '再把桌面版的交互对齐：消息显示在对话里，点击「排队中」调整顺序、编辑或取消。'),
  ]);
  const [editing, setEditing] = useState<string | null>(null);
  const visibleIds = new Set(appendPendingQueueItems([], queue.map(item => item.chatMessage), [])
    .map(item => item.type === 'message' ? item.message.clientId : ''));
  return (
    <main className="mx-auto flex max-w-[880px] flex-col gap-4 p-6">
      {queue.map((entry, index) => visibleIds.has(entry.clientId) ? (
        <PendingQueueBubble pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
          key={entry.clientId}
          entry={entry}
          index={index}
          count={queue.length}
          editingClientId={editing}
          steeringClientIds={[]}
          editLocks={editing ? [editing] : []}
          interactionLocks={[]}
          onEdit={(entry) => setEditing(entry.clientId)}
          onSteer={async (id) => {
            setQueue((q) => q.filter((e) => e.clientId !== id));
            return true;
          }}
          onRemove={(id) => setQueue((q) => q.filter((e) => e.clientId !== id))}
          onMove={(id, target) =>
            setQueue((q) => {
              const from = q.findIndex((e) => e.clientId === id);
              const result = q.filter((e) => e.clientId !== id);
              result.splice(target > from ? target - 1 : target, 0, q[from]);
              return result;
            })
          }
        />
      ) : null)}
    </main>
  );
}
void mountPage({ route: '/sessions/queue-fixture', render: () => <Fixture /> });
