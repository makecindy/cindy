import { useState } from 'react';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import { Button } from '../../../src/renderer/components/ui/button';
import { mountPage, subscription } from '../../ui-page/harness';

const messages = ['first', 'second'].flatMap((clientId, index) => [
  {
    clientId: `ask-${clientId}`,
    role: 'user',
    content: `查看第 ${index + 1} 条结果`,
    createdAt: new Date(1700000000000 + index * 10000 - 1000).toISOString(),
  },
  {
    clientId,
    role: 'assistant',
    content: `定位提示 ${index + 1}：短暂显示高亮后，背景和边框应恢复。`,
    assistantPhase: 'final_answer',
    turnCompleted: true,
    createdAt: new Date(1700000000000 + index * 10000).toISOString(),
  },
]) as ChatMessage[];

function Subject({ compact }: { compact: boolean }) {
  const [focus, setFocus] = useState({ id: '', request: 0 });
  const [revision, setRevision] = useState(0);
  return (
    <div className="flex h-screen min-w-0 flex-col bg-[var(--surface)]" data-ui-page-subject>
      <div className="flex flex-wrap gap-2 p-3">
        {messages
          .filter((message) => message.role === 'assistant')
          .map((message) => (
            <Button
              key={message.clientId}
              data-testid={`focus-${message.clientId}`}
              onClick={() =>
                setFocus((previous) => ({ id: message.clientId, request: previous.request + 1 }))
              }
            >
              {message.clientId}
            </Button>
          ))}
        <Button data-testid="update" onClick={() => setRevision((value) => value + 1)}>
          Update
        </Button>
        <Button
          data-testid="clear"
          onClick={() => setFocus((previous) => ({ id: '', request: previous.request + 1 }))}
        >
          Clear
        </Button>
      </div>
      <MessageStream
        workingDir=""
        historyLoaded
        simplifiedBotConversation={compact}
        messages={
          revision
            ? messages.map((message) =>
                message.clientId === 'second'
                  ? { ...message, content: `${message.content} 更新 ${revision}` }
                  : message,
              )
            : messages
        }
        focusMessageClientId={focus.id || undefined}
        focusMessageRequestId={focus.request}
      />
    </div>
  );
}

void mountPage({
  route: '/fixture',
  host: () => ({
    agentIsland: { onSessionActivity: subscription('activity') },
    maker: { polishWorkingStatus: async () => null },
  }),
  render: (ctx) => <Subject compact={ctx.case === 'compact'} />,
});
