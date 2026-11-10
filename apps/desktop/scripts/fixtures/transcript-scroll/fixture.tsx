import { useState } from 'react';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { ConversationStream } from '../../../src/renderer/features/right-sidebar/plugins/subagents/ConversationStream';
import type { SubagentConversationItem } from '../../../src/renderer/features/right-sidebar/plugins/subagents/subagentConversation';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import { readSessionScroll } from '../../../src/renderer/lib/sessionScrollStore';
import { mountPage, subscription } from '../../ui-page/harness';

const prose = (index: number) => `### 检查记录 ${index}\n\n` +
  '这是合成长任务记录，用于检查滚动、选字和阅读位置。**完整保留内容**，包括工具结果和历史回复。\n\n'.repeat(4) +
  '```ts\nconst result = { ready: true, count: 12 };\nconsole.log(result);\n```';
const items: SubagentConversationItem[] = Array.from({ length: 300 }, (_, index) => ({
  kind: 'subagent', id: `reply-${index}`, content: prose(index), occurredAt: 1700000000000 + index * 1000,
}));
const messages: ChatMessage[] = items.map((item, index) => ({
  clientId: item.id, role: index % 2 ? 'assistant' : 'user', content: prose(index),
  createdAt: new Date(item.occurredAt).toISOString(), turnCompleted: true, assistantPhase: 'final_answer',
}));

const toolMessages: ChatMessage[] = [
  { clientId: 'request', role: 'user', content: '查看完整检查过程' },
  ...Array.from({ length: 300 }, (_, index): ChatMessage[] => [
    { clientId: `note-${index}`, role: 'assistant', content: prose(index), assistantPhase: 'commentary' },
    { clientId: `tool-${index}`, role: 'tool_use', content: '', toolName: 'Bash', toolUseId: `tool-${index}`, toolInput: { command: `echo check-${index}` } },
    { clientId: `result-${index}`, role: 'tool_result', toolUseId: `tool-${index}`, content: 'complete' },
  ]).flat(),
  { clientId: 'final', role: 'assistant', content: '已完成合成检查。', assistantPhase: 'final_answer', turnCompleted: true },
];

const headerSession = 'transcript-header-scroll';
function ResizableHeader() {
  const [expanded, setExpanded] = useState(true);
  return <div style={{ height: expanded ? 2000 : 40 }}>
    <button className="fixed left-2 top-2 z-50" onClick={() => setExpanded(value => !value)}>Resize header</button>
    Synthetic thread root
  </div>;
}
function SnapshotProbe() {
  const [snapshot, setSnapshot] = useState('');
  return <div className="fixed right-2 top-2 z-50">
    <button onClick={() => setSnapshot(JSON.stringify(readSessionScroll(headerSession)))}>Read saved position</button>
    <output data-testid="saved-position" className="sr-only">{snapshot}</output>
  </div>;
}
function Subject({ subagent, tools, header }: { subagent: boolean; tools: boolean; header: boolean }) {
  return <div className="flex h-screen flex-col bg-[var(--surface)]" data-ui-page-subject>
    {header && <SnapshotProbe />}
    {subagent ? <div data-scroll-container className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex max-w-[720px] flex-col gap-5">
        <ConversationStream items={items}
          workdir="" allowPrivilegedLinks={false} />
      </div>
    </div> : <div className="min-h-0 flex-1"><MessageStream workingDir="" historyLoaded messages={tools ? toolMessages : messages}
      sessionId={header ? headerSession : undefined} header={header ? <ResizableHeader /> : undefined} /></div>}
  </div>;
}

void mountPage({ route: '/fixture',
  host: () => ({ agentIsland: { onSessionActivity: subscription('activity') }, maker: { polishWorkingStatus: async () => null },
    onSelectionContextMenuAddToChat: subscription('selection-context-menu') }),
  render: ctx => <Subject subagent={ctx.case === 'subagent'} tools={ctx.case === 'tools'} header={ctx.case === 'header'} />,
});
