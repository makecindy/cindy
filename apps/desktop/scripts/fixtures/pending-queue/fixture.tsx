import { useState } from 'react';
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
    entry('first', '先检查手机版消息排队的处理逻辑。'),
    entry('second', '再把桌面版的交互对齐：消息显示在对话里，点击「排队中」调整顺序、编辑或取消。'),
  ]);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <main className="mx-auto flex max-w-[880px] flex-col gap-4 p-6">
      {queue.map((entry, index) => (
        <PendingQueueBubble
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
      ))}
    </main>
  );
}
void mountPage({ route: '/sessions/queue-fixture', render: () => <Fixture /> });
