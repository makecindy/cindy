import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { Button } from '../../../src/renderer/components/ui/button';
import {
  commandDirectiveSegments,
  mentionDirectiveSegments,
} from '../../../src/renderer/cindy-brain/ghostCommand';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
// Original plugin artwork, copied unchanged from the plugin source assets.
import feishuIcon from './assets/feishu.png';
import githubIcon from './assets/github.png';

const directive = {
  kind: 'command' as const,
  command: 'xd-feishu',
  name: 'XD Feishu',
  ghostId: 'xd-feishu',
  namespace: 'xd',
  raw: '',
};
const timestamp = new Date(Date.now() - 5000).toISOString();
const message = (clientId: string, role: ChatMessage['role'], content = ''): ChatMessage => ({
  clientId,
  role,
  content,
  createdAt: timestamp,
});
function Subject({ mode }: { mode: string }) {
  const multi = mode === 'multi' || mode === 'explicit-multi' || mode === 'mention-multi';
  const [stage, setStage] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [turnFinished, setTurnFinished] = useState(false);
  const body =
    mode === 'explicit' || mode === 'explicit-multi' || mode === 'selection'
      ? '$xd-feishu 帮我读取方案。\n\n' +
        commandDirectiveSegments(directive)
          .map((part) => part.text)
          .join('')
      : mode === 'mention' || mode === 'mention-multi'
        ? '帮我看看方案。\n\n' +
          mentionDirectiveSegments([{ name: 'XD Feishu', ghostId: '_ns__xd__xd-feishu' }])
            .map((part) => part.text)
            .join('')
        : multi ? '读取飞书方案，再帮我查看 GitHub 的相关任务。' : '调用下 GitHub 插件。';
  const messages: ChatMessage[] = [
    message('ask', 'user', body),
    ...(mode === 'selection' ? [] : [{
      ...message('call', 'tool_use'),
      toolName: 'mcp__cindy__ghost_call',
      toolUseId: 'call',
      toolInput: {
        ghost_id: mode === 'default' || mode === 'interrupted' ? 'cindy-github' : 'xd-feishu',
        namespace: mode === 'default' || mode === 'interrupted' ? null : 'xd',
        tool: mode === 'default' || mode === 'interrupted' ? 'list_issues' : 'read_document',
        args: { document: 'fixture-plan' },
      },
    }]),
    ...(multi ? [{
      ...message('github-call', 'tool_use'), toolName: 'mcp:cindy:ghost_call', toolUseId: 'github-call',
      toolInput: { ghost_id: 'cindy-github', namespace: null, tool: 'list_issues', args: {} },
    }] : []),
    ...(stage >= 1
      ? [
          {
            ...message('result', 'tool_result', '{"ok":true,"content":"方案已读取"}'),
            toolUseId: 'call',
          },
          {
            ...message('working', 'assistant', '方案已读取，继续整理实现。'),
            assistantPhase: 'commentary' as const,
          },
        ]
      : []),
    ...(stage >= 2 && multi ? [{ ...message('github-result', 'tool_result', '{"ok":true}'), toolUseId: 'github-call' }] : []),
    ...(stage >= 3
      ? [
          {
            ...message('final', 'assistant', '方案已整理。'),
            assistantPhase: 'final_answer' as const,
            turnCompleted: true,
          },
          message('next', 'user', '继续实现。'),
          {
            ...message('next-reply', 'assistant', '我继续修改代码。'),
            assistantPhase: 'commentary' as const,
          },
        ]
      : []),
  ];
  return (
    <div className="flex h-screen flex-col bg-[var(--surface)]" data-ui-page-subject>
      <div className="p-2 text-xs text-[var(--text-tertiary)]">验收样本，非真实任务；下方为实际产品组件</div>
      <div className="flex flex-wrap gap-2 p-2" data-ui-page-control>
        <Button data-testid="finish-call" onClick={() => setStage(1)}>
          返回首个结果
        </Button>
        <Button data-testid="next-turn" onClick={() => setStage(2)}>
          全部返回
        </Button>
        <Button data-testid="finish-turn" onClick={() => setTurnFinished(true)}>
          结束本轮
        </Button>
        <Button data-testid="plain-turn" onClick={() => { setStage(3); setTurnFinished(false); }}>
          下一条消息
        </Button>
        <Button data-testid="remount" onClick={() => setGeneration((value) => value + 1)}>
          重载历史
        </Button>
      </div>
      <MessageStream
        key={generation}
        workingDir=""
        messages={messages}
        historyLoaded
        isSessionStreaming={!turnFinished}
        contentWidth={720}
      />
    </div>
  );
}
void mountPage({
  route: '/fixture',
  host: () => ({
    agentIsland: { onSessionActivity: subscription('activity') },
    maker: { polishWorkingStatus: async () => null },
    ghosts: {
      listSync: () => ({
        ghosts: [
          {
            manifest: {
              schemaVersion: 2,
              id: 'xd-feishu',
              name: 'XD Feishu',
              version: '1.0.0',
              kind: 'chip',
              command: 'xd-feishu',
              entry: 'main.js',
            },
            namespace: 'xd',
            dir: '/fixture/_ns/xd/xd-feishu',
            enabled: true,
            iconDataUrl: feishuIcon,
          },
          {
            manifest: { schemaVersion: 2, id: 'cindy-github', name: 'GitHub', version: '1.0.0', kind: 'chip', command: 'cindy-github', entry: 'main.js' },
            namespace: null, dir: '/fixture/_root/cindy-github', enabled: true,
            iconDataUrl: githubIcon,
          },
        ],
      }),
      onChanged: subscription('ghostsChanged'),
    },
  }),
  render: (ctx) => <Subject mode={ctx.case} />,
});
