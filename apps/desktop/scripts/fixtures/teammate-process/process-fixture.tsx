import { BotAvatar } from '../../../src/renderer/features/bots/BotAvatar';
import { ThreadPanel } from '../../../src/renderer/features/bots/ThreadPanel';
import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import { Button } from '../../../src/renderer/components/ui/button';
import { WorkGroupBlock } from '../../../src/renderer/components/chat/WorkGroupBlock';
import { readSendFollowCancelGeneration, tryRequestFollowLatest } from '../../../src/renderer/components/chat/autoFollowIntent';
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
const artifactMessages: ChatMessage[] = [
  { ...text('ask-artifacts', '整理这周的交付清单，生成表格并保留整理脚本。'), role: 'user' },
  { ...text('make-sheet', ''), role: 'tool_use', toolName: 'make_xlsx', toolUseId: 'make-sheet', toolInput: {
    outPath: '/repo/deliveries.xlsx', title: '本周交付清单',
    sheets: [{ name: '交付清单', header: ['事项', '说明', '状态'], rows: [['界面对齐', '成果与回复同列', '完成'], ['回归验证', '检查窄栏与主题', '完成']] }],
  } },
  { ...text('sheet-result', '{"ok":true}'), role: 'tool_result', toolUseId: 'make-sheet' },
  { ...text('write-script', ''), role: 'tool_use', toolName: 'Write', toolUseId: 'write-script', toolInput: { file_path: '/repo/prepare.py', content: '# fixture' } },
  { ...text('script-result', 'File created'), role: 'tool_result', toolUseId: 'write-script' },
  { ...text('topic-summary', ''), systemCardType: 'bot-session-task-result', systemCardData: {
    v: 1, role: 'delegation-result', delegationId: 'fixture-topic', fromBotId: 'fixture', fromBotName: 'Cindy',
    toBotId: null, toBotName: 'Cindy', parentSessionId: null, childSessionId: null, objective: '整理交付记录',
    result: { title: '整理交付记录', runSequence: 1, status: 'completed', text: '已核对清单内容。', artifacts: [] },
  } },
  { ...text('artifact-answer', '交付清单已经整理好。表格按事项列出说明和完成状态，方便你逐项核对。\n\n同时保留了整理脚本，之后有新增记录时可以继续更新。下方是本次生成的表格和相关文件。', 'final_answer'), turnCompleted: true,
    // Several saves in one turn join into one long footer row.
    botLearning: ['按工作流分批与独立推进节奏', '七机 CI 管理基线', '游戏开发与测试电脑', 'CI 优先用自有机器，减少 GitHub 云机器开支', '内部 CI 采用务实方案，避免过度安全设计', '每件事新任务，派活使用用户原话']
      .map((title, index) => ({ kind: 'memory' as const, key: `memory-${index}`, title, action: 'updated' as const })) },
];

let holdArtifactStats = false;
const pendingArtifactStats: Array<(missing: boolean) => void> = [];
function settleArtifactStats(missing: boolean) {
  holdArtifactStats = false;
  for (const settle of pendingArtifactStats.splice(0)) settle(missing);
}

function ArtifactStream({ artifactCase }: { artifactCase: string }) {
  const [generation, setGeneration] = useState(0);
  const stream = <MessageStream key={generation} workingDir="/repo" historyLoaded messages={artifactMessages}
    assistantAvatar={artifactCase === 'artifacts-task' || artifactCase === 'artifacts-no-avatar' ? undefined : <BotAvatar bot={{ id: 'fixture', name: 'Cindy', avatar: 'cindy://avatar/preset/cindy' }} size="sm" />}
    simplifiedBotConversation={artifactCase !== 'artifacts-task'} contentWidth={720} />;
  if (artifactCase === 'artifacts-thread') return <div className="flex h-screen w-full" data-ui-page-subject>
    <div className="flex-1" />
    <ThreadPanel onClose={() => undefined}>
      <div className="chat-rail-compact flex min-h-0 flex-1 flex-col">{stream}</div>
    </ThreadPanel>
  </div>;
  return <div className="flex h-screen w-full min-w-0 flex-col bg-[var(--surface)]" data-ui-page-subject>
    {artifactCase === 'artifacts-cached' && <div className="flex gap-2" data-ui-page-control>
      <Button data-testid="fixture-remount" onClick={() => { holdArtifactStats = true; setGeneration(value => value + 1); }}>Remount</Button>
      <Button data-testid="fixture-confirm" onClick={() => settleArtifactStats(false)}>Confirm</Button>
      <Button data-testid="fixture-remove" onClick={() => settleArtifactStats(true)}>Remove</Button>
    </div>}
    {stream}
  </div>;
}

function RefreshingProcess({ running }: { running: boolean }) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="p-6 bg-[var(--surface)]" data-ui-page-subject>
    <div className="flex gap-2" data-ui-page-control>
      <Button data-testid="refresh-start" onClick={() => setLoading(true)}>Load details</Button>
      <Button data-testid="refresh-end" onClick={() => setLoading(false)}>Finish loading</Button>
      <Button data-testid="refresh-fail" onClick={() => { setLoading(false); setFailed(true); }}>Fail loading</Button>
    </div>
    <WorkGroupBlock journal blockId="refreshing-process" isStreaming={running} durationMs={25000}
      childItems={[{ kind: 'rendered', key: 'note', renderNode: () => <p>正在核对任务进展。</p> }]}
      deferred={{ key: 'details', expanded: true, loading, failed,
        toggle: () => undefined, retry: () => { setFailed(false); setLoading(true); } }} />
  </div>;
}

const disclosureHistory: ChatMessage[] = Array.from({ length: 8 }, (_, index) => [
  { ...text(`history-ask-${index}`, `核对第 ${index + 1} 项记录。`), role: 'user' as const },
  { ...text(`history-answer-${index}`, '记录已经核对。\n\n已完成的内容保持可查，未完成的事项继续跟进。', 'final_answer'), turnCompleted: true },
]).flat();

function Subject({ done, retry, artifactCase, refresh, disclosure }: { done: boolean; retry: boolean; artifactCase?: string; refresh?: boolean; disclosure?: boolean }) {
  const [finished, setFinished] = useState(done);
  const [revision, setRevision] = useState(0);
  const rows = retry ? retryMessages : messages;
  if (refresh) return <RefreshingProcess running={!done} />;
  if (artifactCase) return <ArtifactStream artifactCase={artifactCase} />;
  return <div className="flex h-screen w-full min-w-0 flex-col bg-[var(--surface)]" data-ui-page-subject>
    <div className="self-end p-2" data-ui-page-control><Button onClick={() => setFinished(true)} data-testid="fixture-finish">Finish fixture</Button>
      {disclosure && <><Button data-testid="fixture-update" onClick={() => setRevision(value => value + 1)}>Update</Button><Button data-testid="fixture-send" onClick={() => tryRequestFollowLatest({ sourceSessionId: 'disclosure-fixture', currentSessionId: 'disclosure-fixture', startGeneration: readSendFollowCancelGeneration('disclosure-fixture') })}>Follow latest</Button></>}
    </div>
    <MessageStream workingDir="" historyLoaded sessionId={disclosure ? 'disclosure-fixture' : undefined} messages={[...(disclosure ? disclosureHistory : []), ...(finished ? [...rows, { ...text('final_answer', `任务与 PR 的进展已整理。未处理完的事项和需要你判断的部分，已分别列出。${revision ? `\n\n补充记录 ${revision}。` : ''}`, 'final_answer'), turnCompleted: true }] : rows)]}
      assistantAvatar={<span data-testid="fixture-partner-avatar"><BotAvatar bot={{ id: "fixture", name: "Cindy", avatar: "cindy://avatar/preset/cindy" }} size="sm" /></span>} simplifiedBotConversation isSessionStreaming={!finished} contentWidth={720} />
  </div>;
}
void mountPage({
  route: '/fixture',
  host: ctx => ({ agentIsland: { onSessionActivity: subscription('activity') }, maker: { polishWorkingStatus: async () => null },
    onSelectionContextMenuAddToChat: subscription('selection'),
    fsBrowse: { statPath: async () => {
      const root = document.documentElement;
      root.dataset.fixtureFileStats = String(Number(root.dataset.fixtureFileStats ?? 0) + 1);
      const missing = holdArtifactStats ? await new Promise<boolean>(resolve => pendingArtifactStats.push(resolve)) : ctx.case === 'artifacts-missing';
      return { kind: missing ? 'missing' : 'file', birthtimeMs: Date.now() - 46000, mtimeMs: Date.now() - 46000 };
    } },
  }),
  render: ctx => <Subject done={ctx.data.done === true} retry={ctx.data.retry === true} refresh={ctx.data.refresh === true} disclosure={ctx.data.disclosure === true} artifactCase={ctx.case.startsWith('artifacts-') ? ctx.case : undefined} />,
});
