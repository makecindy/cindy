import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { BotDmThreadPanel } from '../../../src/renderer/features/bots/BotDmThreadViews';
import { ChatThreadPanel } from '../../../src/renderer/features/bots/ChatThreadPanel';
import type { BotGroupDetail } from '../../../src/shared/botGroupChat';

// The fixture origin lacks secure-context randomUUID. Only the ID source is
// supplied here; the production composer still owns the entire send path.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => ('00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0')) as ReturnType<typeof crypto.randomUUID>;
}

const text = '原消息开头 · Original message\n\n' + Array.from({ length: 6 }, (_,i) =>
  `### ${i + 1}. 完整阅读 · Full text\n\n原消息和回复一起滚动，不应被固定高度遮挡。The entire original message remains readable.\n\n- 第一项 First item\n- 第二项 Second item`).join('\n\n') + '\n\n原消息末尾 · End of original';
const bot = { id: 'fixture-bot', name: 'Aster', avatar: '🧪' };
const root = { id: 'root', sequence: 1, kind: 'message' as const, authorKind: 'bot' as const,
  authorBotId: bot.id, authorName: bot.name, content: text, mentions: { all: false, botIds: [] },
  noticeCode: null, planId: null, files: [], attachments: [], createdAt: 1792990000000 };

function Scenario({ kind }: { kind: string }) {
  const [closed, setClosed] = useState(false);
  return <div className="flex h-screen" data-ui-page-subject>
    <div className="min-w-0 flex-1" />
    {closed ? <span data-closed="" /> : kind.startsWith('group') ? <ChatThreadPanel
      group={{ id: 'fixture-group', members: [], messages: [root] } as unknown as BotGroupDetail}
      rootId="root" onClose={() => setClosed(true)} /> : <BotDmThreadPanel
      bot={bot} rootSessionId="fixture-main" rootClientId="root"
      state={kind === 'failed' ? { kind: 'failed', message: '暂时无法打开话题 · Could not open topic' } : { kind: 'opening' }}
      mentions={[]} lastAssistantAt={null} onRetry={() => undefined} onClose={() => setClosed(true)} />}
  </div>;
}

const replyControl = { calls: [] as unknown[], fail: () => {} };
(window as unknown as { __threadReplyControl: typeof replyControl }).__threadReplyControl = replyControl;

void mountPage({
  route: '/bots/fixture-bot/session/fixture-main',
  host: {
    getFilePath: (file: File) => '/fixture/' + file.name,
    getFileThumbnail: async () => null,
    maker: { onBotGroupChanged: subscription('groupChanged'), chatServer: {
      thread: async () => ({ ok: true, root, replies: [], hasMore: false }),
      reply: async (input: unknown) => {
        replyControl.calls.push(input);
        if (replyControl.calls.length === 1) return new Promise(resolve => {
          replyControl.fail = () => resolve({ ok: false, errorCode: 'INVALID_ATTACHMENT' });
        });
        return { ok: true, messageId: 'accepted-retry' };
      },
    } },
  },
  render: ctx => {
    // Only the source snapshot is simulated; both panels and root rendering are real.
    (window as unknown as { __threadRoot: unknown }).__threadRoot = {
      messages: [{ clientId: 'root', role: 'assistant', content: text, createdAt: new Date(root.createdAt).toISOString() }],
    };
    return <Scenario kind={ctx.case} />;
  },
});
