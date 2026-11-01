import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { AssistantMessage } from '../../../src/renderer/components/chat/AssistantMessage';
import { MessageReadAloudContext } from '../../../src/renderer/components/chat/MessageReadAloudContext';
import { ThreadPanel } from '../../../src/renderer/features/bots/ThreadPanel';

function CompanionReply() {
  const [reading, setReading] = useState(false);
  return <MessageReadAloudContext.Provider value={{
    sessionId: 'shared-task', available: true, disabled: false,
    messageId: reading ? 'reply-2' : null, phase: reading ? 'playing' : 'idle',
    canRead: () => true, toggle: () => setReading(value => !value),
  }}>
    <AssistantMessage workingDir="/project" currentSessionId="shared-task" messageClientId="reply-2"
      content="先收好桌面上的文件，再把常用物品放回顺手的位置。整理完成后，记得留出一块空白的工作区域。"
      agentKind="cc" simplifiedBotConversation showActionBar />
  </MessageReadAloudContext.Provider>;
}

void mountPage({
  route: '/cc-agent/shared-task',
  host: { maker: { getCapabilities: async () => ({ availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [], fork: { supported: true }, rewind: { supported: false } }) } },
  render: (ctx) => ctx.case === 'companion-thread'
    ? <div className="flex h-screen" data-ui-page-subject><div className="flex-1" /><ThreadPanel onClose={() => undefined}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4"><CompanionReply />
          <UserMessage workingDir="/project" content="这些文件整理好了，请继续检查附件与结果是否完整。" sessionId="shared-task" messageClientId="user-2" agentKind="cc" simplifiedBotConversation />
        </div></ThreadPanel></div>
    : ctx.case.startsWith('companion')
    ? <div className="p-4" data-ui-page-subject><CompanionReply /></div>
    : <div className="p-8 space-y-10" data-ui-page-subject>
    <UserMessage workingDir="/project" content="技术上能想办法实现吗？" sessionId="shared-task" messageClientId="user-2" agentKind="cc" remoteHostId={ctx.case === 'ssh' ? 'ssh-host' : undefined} />
    <AssistantMessage workingDir="/project" content="可以。分叉后会保留历史上下文，继续使用原来那台电脑上的共享模型。" currentSessionId="shared-task" messageClientId="reply-2" agentKind="cc" remoteHostId={ctx.case === 'ssh' ? 'ssh-host' : undefined} showActionBar />
  </div>,
});
