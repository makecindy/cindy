import { useRef } from 'react';
import { mountPage } from '../../ui-page/harness';
import { MessageNavRail } from '@/components/chat/MessageNavRail';
import { deriveNavRailEntries } from '@/components/chat/messageNavRailModel';
import type { ChatMessage } from '@/hooks/useCCAgentChat';

// 提问导航的悬停预览（DESIGN.md §4「Desktop message nav rail preview」）：
// 本人的提问装进用户气泡同色的圆角框，其他来源只写聊天同款署名、不加框。
const messages = [
  { role: 'user', clientId: 'own', content: '这次重构对移动端有影响吗？', createdAt: '2026-11-24T14:26:00' },
  { role: 'assistant', clientId: 'own-answer', content: '影响不大：Android 需要回归一遍，iOS 不用改。' },
  {
    role: 'user',
    clientId: 'worker',
    content: JSON.stringify({ orcaSource: 'worker', content: '桌面端检查完成' }),
    createdAt: '2026-11-24T14:28:00',
  },
  { role: 'assistant', clientId: 'worker-answer', content: '收到，继续推进。' },
  { role: 'user', clientId: 'third', content: '还剩哪些没做完？' },
  { role: 'user', clientId: 'fourth', content: '封版前还来得及补单测吗？' },
] as unknown as ChatMessage[];

const entries = deriveNavRailEntries(messages);

function Scenario() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <main className="relative h-screen bg-background" data-ui-page-subject>
      <div ref={ref} className="h-full" />
      <MessageNavRail entries={entries} contentMaxWidth={400} scrollRef={ref} bottomOffset={48} onJump={() => {}} />
    </main>
  );
}

void mountPage({ route: '/', cases: ['default', 'worker'], render: () => <Scenario /> });
