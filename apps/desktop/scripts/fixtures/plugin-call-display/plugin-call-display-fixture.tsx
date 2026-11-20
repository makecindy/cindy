import { useEffect, useMemo, useState } from 'react';
import { HistoryViewController, mapHistoryViewMessages, projectHistoryView } from '@cindy/maker-shared/message-window';
import { mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { Button } from '../../../src/renderer/components/ui/button';
import {
  commandDirectiveSegments,
  mentionDirectiveSegments,
} from '../../../src/renderer/cindy-brain/ghostCommand';
import type { ChatMessage, HistoryChatMessage } from '../../../src/renderer/lib/makerChatStore';
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

declare global {
  interface Window { pluginCallHistoryView?: HistoryViewController<HistoryChatMessage> }
}

function HistoryHandoffSubject({ mode }: { mode: string }) {
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [tokens, setTokens] = useState(0);
  const rows = useMemo((): HistoryChatMessage[] => {
    const turn = (id: string): ChatMessage[] => [
      message(id, 'user', '查询 GitHub 任务。'),
      ...(mode === 'history-steer' ? [{ ...message(`${id}-steer`, 'user', '也查看尚未完成的任务。'), delivery: 'steer' as const }] : []),
      { ...message(`${id}-call`, 'tool_use'), toolName: 'mcp__cindy__ghost_call', toolUseId: `${id}-call`,
        toolInput: { ghost_id: 'cindy-github', namespace: null, tool: 'list_issues' }, replyToClientId: mode === 'history-steer' ? `${id}-steer` : id },
      { ...message(`${id}-result`, 'tool_result', '{"ok":true}'), toolUseId: `${id}-call` },
      { ...message(`${id}-final`, 'assistant', '查询已完成。'), turnCompleted: true, replyToClientId: mode === 'history-steer' ? `${id}-steer` : id },
    ];
    const prefix = mode === 'long-history' ? Array.from({ length: 1000 }, (_, index) => turn(`history-${index}`)).flat() : [];
    return [...prefix, ...turn('ask'), message('next', 'user', '继续讨论，不调用插件。')]
      .map((row, index) => ({ ...row, id: row.clientId,
        ...(mode === 'history-legacy' ? { replyToClientId: undefined } : {}),
        createdAt: new Date(Date.UTC(2026, 10, 20) + index * 1000).toISOString(),
      }));
  }, [mode]);
  const view = useMemo(() => {
    const byId = new Map(rows.map(row => [row.clientId, row]));
    const sources = rows.map(row => ({ ...row,
      content: row.role === 'tool_use' ? { toolName: row.toolName, toolUseId: row.toolUseId, input: row.toolInput } : row.content,
      agentMeta: { replyToClientId: row.replyToClientId, turnCompleted: row.turnCompleted },
    }));
    const items = mapHistoryViewMessages(projectHistoryView(sources, false), page => page.map(row => byId.get(row.clientId)!));
    return new HistoryViewController<HistoryChatMessage>({
      page: async () => ({ version: 1, items, hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
  }, [rows]);
  useEffect(() => {
    window.pluginCallHistoryView = view;
    void view.refresh().then(() => setReady(true));
    return () => { window.pluginCallHistoryView = undefined; view.setActive(false); };
  }, [view]);
  const messages = useMemo(() => [...rows, {
    ...message('stream', 'assistant', `继续讨论。${'正文更新。'.repeat(tokens)}`),
    replyToClientId: 'next', isStreaming: true,
  }], [rows, tokens]);
  return <div className="flex h-screen flex-col bg-[var(--surface)]" data-ui-page-subject>
    <div className="p-2 text-xs text-[var(--text-tertiary)]">验收样本，非真实任务；历史折叠交接，共 {rows.length} 条记录</div>
    <div className="flex gap-2 p-2" data-ui-page-control>
      <Button data-testid="remount" onClick={() => { setGeneration(value => value + 1); }}>重载历史</Button>
      <Button data-testid="stream-text" onClick={async () => {
        for (let index = 1; index <= 50; index++) {
          setTokens(index);
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      }}>流式更新正文</Button>
      <span data-testid="stream-count">{tokens}</span>
    </div>
    {ready && <MessageStream key={generation} sessionId="plugin-history-fixture" workingDir=""
      messages={messages} historyLoaded isSessionStreaming contentWidth={720} />}
  </div>;
}
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
    onSelectionContextMenuAddToChat: subscription('selectionContextMenuAddToChat'),
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
  render: (ctx) => ['history-handoff', 'history-legacy', 'history-steer', 'long-history'].includes(ctx.case)
    ? <HistoryHandoffSubject mode={ctx.case} /> : <Subject mode={ctx.case} />,
});
