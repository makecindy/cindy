import { useState } from 'react';
import { forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotDmThreadPanel } from '../../../src/renderer/features/bots/BotDmThreadViews';
import { ChatThreadPanel } from '../../../src/renderer/features/bots/ChatThreadPanel';
import type { BotGroupDetail } from '../../../src/shared/botGroupChat';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';

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
    {closed ? <span data-closed="" /> : kind === 'group' ? <ChatThreadPanel
      group={{ id: 'fixture-group', members: [], messages: [root] } as unknown as BotGroupDetail}
      rootId="root" onClose={() => setClosed(true)} /> : <BotDmThreadPanel
      bot={bot} rootSessionId="fixture-main" rootClientId="root"
      state={kind === 'failed' ? { kind: 'failed', message: '暂时无法打开话题 · Could not open topic' } : { kind: 'opening' }}
      mentions={[]} lastAssistantAt={null} onRetry={() => undefined} onClose={() => setClosed(true)} />}
  </div>;
}

void mountPage({
  route: '/bots/fixture-bot/session/fixture-main',
  host: {
    voiceInput: {
      getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('win32'), fastActivationEnabled: false }, history: [] }),
      onDataChanged: subscription('voiceDataChanged'),
      onEvent: subscription('voiceEvent'),
      onGlobalShortcutTrigger: subscription('voiceShortcut'),
      setGlobalShortcut: async () => ({ ok: true }),
      prewarm: async () => ({ ok: true }),
      start: forbid('voiceInput.start'),
    },
    maker: { onBotGroupChanged: subscription('groupChanged'), chatServer: {
      thread: async () => ({ ok: true, root, replies: [], hasMore: false }),
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
