import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { Button } from '../../../src/renderer/components/ui/button';
import {
  commandDirectiveSegments,
  mentionDirectiveSegments,
} from '../../../src/renderer/cindy-brain/ghostCommand';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';

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
  const [stage, setStage] = useState(0);
  const [generation, setGeneration] = useState(0);
  const body =
    mode === 'explicit'
      ? '$xd-feishu 帮我读取方案。\n\n' +
        commandDirectiveSegments(directive)
          .map((part) => part.text)
          .join('')
      : mode === 'mention'
        ? '帮我看看方案。\n\n' +
          mentionDirectiveSegments([{ name: 'XD Feishu', ghostId: 'xd-feishu' }])
            .map((part) => part.text)
            .join('')
        : '你来梳理和实现吧，做好了开 pr。';
  const messages: ChatMessage[] = [
    message('ask', 'user', body),
    {
      ...message('call', 'tool_use'),
      toolName: 'mcp__cindy__ghost_call',
      toolUseId: 'call',
      toolInput: {
        ghost_id: 'xd-feishu',
        namespace: 'xd',
        tool: 'read_document',
        args: { document: 'fixture-plan' },
      },
    },
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
    ...(stage >= 2
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
      <div className="flex gap-2 p-2" data-ui-page-control>
        <Button data-testid="finish-call" onClick={() => setStage(1)}>
          Return result
        </Button>
        <Button data-testid="next-turn" onClick={() => setStage(2)}>
          Next turn
        </Button>
        <Button data-testid="remount" onClick={() => setGeneration((value) => value + 1)}>
          Reload history
        </Button>
      </div>
      <MessageStream
        key={generation}
        workingDir=""
        messages={messages}
        historyLoaded
        isSessionStreaming
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
          },
        ],
      }),
      onChanged: subscription('ghostsChanged'),
    },
  }),
  render: (ctx) => <Subject mode={ctx.case} />,
});
