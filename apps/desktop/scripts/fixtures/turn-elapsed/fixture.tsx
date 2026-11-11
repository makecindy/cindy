import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 10, 22, 5, 20) + seconds * 1000).toISOString();
const rows: ChatMessage[] = [
  { clientId: 'ask', role: 'user', content: 'Check the source material and summarize the findings.', createdAt: at(0) },
  { clientId: 'thinking', role: 'thinking', content: 'Checking the first part.', createdAt: at(1000), thinkingDurationMs: 1000 },
  { clientId: 'more-thinking', role: 'thinking', content: 'Cross-checking the material.', createdAt: at(1800), thinkingDurationMs: 1000 },
  { clientId: 'delivery', role: 'assistant', content: '# Findings\n\nThe first part has been checked.', createdAt: at(3173) },
  { clientId: 'last-thinking', role: 'thinking', content: 'Checking the remaining material.', createdAt: at(3180), thinkingDurationMs: 1000 },
  { clientId: 'final', role: 'assistant', content: 'The source material has been checked. The findings are ready.', createdAt: at(3630), turnCompleted: true },
];

void mountPage({
  route: '/fixture',
  host: () => ({
    agentIsland: { onSessionActivity: subscription('activity') },
    maker: { polishWorkingStatus: async () => null },
    onSelectionContextMenuAddToChat: subscription('selection'),
  }),
  render: ctx => <main className="flex h-screen w-full flex-col bg-[var(--surface)]">
    <MessageStream workingDir="" historyLoaded contentWidth={720}
      messages={ctx.data.missingStart ? rows.slice(1) : rows}
      historyWindowHasIsland={ctx.data.island === true} />
  </main>,
});
