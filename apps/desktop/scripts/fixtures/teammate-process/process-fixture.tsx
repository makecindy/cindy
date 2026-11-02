import { BotAvatar } from '../../../src/renderer/features/bots/BotAvatar';
import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import { Button } from '../../../src/renderer/components/ui/button';
const text = (clientId: string, content: string, phase?: 'commentary' | 'final_answer'): ChatMessage => ({
  clientId, role: 'assistant', content, assistantPhase: phase, createdAt: new Date(Date.now() - 47000).toISOString(),
} as ChatMessage);
const messages: ChatMessage[] = [
  { ...text('ask', '帮我整理任务和 PR 的进展，先核对还没处理完的部分。'), role: 'user' },
  { ...text('first-work', 'Inspecting task records'), role: 'thinking' },
  text('stage-1', '我先核对任务的最近进展，再看未完成 PR 的阻塞点。', 'commentary'),
  { ...text('second-work', 'Checking remaining work'), role: 'thinking' },
  { ...text('read-tool', ''), role: 'tool_use', toolName: 'Read', toolInput: { file_path: '/repo/tasks.md' }, toolUseId: 'read-tool' },
  { ...text('read-result', 'Error: file not found'), role: 'tool_result', toolUseId: 'read-tool' },
  text('stage-2', '刚才的读取没有完成。我会保留已有记录，换一种方式继续核对。', 'commentary'),
  { ...text('search-tool', ''), role: 'tool_use', toolName: 'Grep', toolInput: { pattern: 'task', path: '/repo' }, toolUseId: 'search-tool' },
  { ...text('search-result', 'Found task records'), role: 'tool_result', toolUseId: 'search-tool' },
  text('stage-3', '已经继续获取任务信息，接下来核对未完成 PR 的当前状态。', 'commentary'),
  text('stage-4', '任务与 PR 的信息已核对，正在整理成便于你校正口径的摘要。', 'commentary'),
];
const retryMessages: ChatMessage[] = [
  { ...text('retry-ask', '查看当前启用的技能。'), role: 'user' },
  { ...text('retry-one', ''), role: 'tool_use', toolName: 'mcp__helper__call_tool', toolInput: { name: 'list_skills' }, toolUseId: 'retry-one' },
  { ...text('retry-one-result', '{"ok":false,"error":"Unavailable"}'), role: 'tool_result', toolUseId: 'retry-one' },
  { ...text('retry-two', ''), role: 'tool_use', toolName: 'mcp__helper__call_tool', toolInput: { name: 'list_skills' }, toolUseId: 'retry-two' },
  { ...text('retry-two-result', '{"isError":true,"content":[{"type":"text","text":"Unavailable"}]}'), role: 'tool_result', toolUseId: 'retry-two' },
  { ...text('retry-active', ''), role: 'tool_use', toolName: 'Read', toolInput: { file_path: '/repo/skills.md' }, toolUseId: 'retry-active' },
];
function Subject({ done, retry }: { done: boolean; retry: boolean }) {
  const [finished, setFinished] = useState(done);
  const rows = retry ? retryMessages : messages;
  return <div className="flex h-screen w-full min-w-0 flex-col bg-[var(--surface)]" data-ui-page-subject>
    <div className="self-end p-2"><Button onClick={() => setFinished(true)} data-testid="fixture-finish">Finish fixture</Button></div>
    <MessageStream workingDir="" historyLoaded messages={finished ? [...rows, { ...text('final_answer', '任务与 PR 的进展已整理。未处理完的事项和需要你判断的部分，已分别列出。', 'final_answer'), turnCompleted: true }] : rows}
      assistantAvatar={<BotAvatar bot={{ id: "fixture", name: "Cindy", avatar: "cindy://avatar/preset/cindy" }} size="sm" />} simplifiedBotConversation isSessionStreaming={!finished} contentWidth={720} />
  </div>;
}
void mountPage({
  route: '/fixture',
  host: () => ({ agentIsland: { onSessionActivity: subscription('activity') }, maker: { polishWorkingStatus: async () => null } }),
  render: ctx => <Subject done={ctx.data.done === true} retry={ctx.data.retry === true} />,
});
