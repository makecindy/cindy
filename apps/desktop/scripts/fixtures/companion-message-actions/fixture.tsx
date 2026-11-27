import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { useState, type ComponentProps } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';

// The fixture's custom origin lacks secure-context randomUUID. These IDs only
// identify in-memory send snapshots; production uses Chromium's secure implementation.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

import { AssistantMessage } from '../../../src/renderer/components/chat/AssistantMessage';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';
import type { ChatReplyQuote } from '../../../src/shared/chatReplyQuote';
import { createLocalImSource } from '../../../src/shared/imMessageSource';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { BotChatQuoteProvider } from '../../../src/renderer/features/bots/botChatQuoteContext';
import { BotChatQuoteComposerPreview } from '../../../src/renderer/features/bots/BotChatQuoteViews';
import {
  clearSentBotReplyQuote,
  setPendingBotReplyQuote,
  usePendingBotReplyQuote,
} from '../../../src/renderer/features/bots/botDmQuote';
import { BotDmThreadsProvider } from '../../../src/renderer/features/bots/botDmThreadsContext';
import { BotDmThreadPanel } from '../../../src/renderer/features/bots/BotDmThreadViews';
const rootSessionId = 'fixture-companion';
const bot = { id: 'fixture-bot', name: 'Aster', avatar: null };
const messages: ChatMessage[] = [
  { clientId: 'owner', role: 'user', content: '请帮我核对消息下的操作。', images: [], files: [] },
  {
    clientId: 'answer',
    role: 'assistant',
    content: '已沿用现有组件。正文可以直接选择，引用后也可以继续编辑草稿。',
    images: [],
    files: [],
  },
];
const feishuText = '<p>演示记录 &amp; 备注。<br>请保留已确认的条目。</p>';
const feishuMessage: ChatMessage = {
  clientId: 'fixture-feishu', role: 'user', content: feishuText,
  hookSource: createLocalImSource('feishu', feishuText),
};
const names = { owner: 'Chris', companion: 'Aster' };
const noop = () => {};
function Fixture({ kind }: { kind: string }) {
  const quote = usePendingBotReplyQuote(rootSessionId);
  const feishu = kind === 'feishu-quote';
  const ownerMessage = feishu ? feishuMessage : messages[0];
  const [sentReply, setSentReply] = useState<{ text: string; quote: ChatReplyQuote }>();
  const [originalLoaded, setOriginalLoaded] = useState(true);
  const getMessage = (id: string) => feishu
    ? (originalLoaded && id === ownerMessage.clientId ? ownerMessage : undefined)
    : messages.find(message => message.clientId === id);
  const [topic, setTopic] = useState<string | null>(null);
  const thread: any = {
    rootClientId: 'answer',
    replyCount: 3,
    lastReplyAt: Date.now() - 120000,
    lastAssistantAt: Date.now() - 120000,
    sessionId: 'fixture-topic',
  };
  const quoteContext = {
    sessionId: rootSessionId,
    names,
    getMessage,
    isFirstReplyFor: () => false,
    showReplyTargets: false,
    quote: (q: any) => setPendingBotReplyQuote(rootSessionId, q),
    locate: noop,
  };
  const threads = {
    botId: bot.id,
    botName: bot.name,
    bot,
    rootSessionId,
    threads: new Map(kind === 'default' ? [] : [['answer', thread]]),
    openRootClientId: topic,
    isUnread: () => kind === 'unread',
    openThread: setTopic,
  };
  const files: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: [],
    hasAttachments: false,
    addFiles: async () => {},
    addClipboardImage: async () => {},
    rejections: [],
    dismissRejection: noop,
    clearRejections: noop,
    addFolderPath: noop,
    pendingFoldersVersion: 0,
    consumePendingFolders: () => [],
    addFileMention: noop,
    pendingFileMentionsVersion: 0,
    consumePendingFileMentions: () => [],
    removeFile: noop,
    updateFile: noop,
    discardFiles: noop,
    clearFiles: noop,
    restoreFiles: (files) => [...files],
  };
  return (
    <BotChatQuoteProvider value={quoteContext}>
      <BotDmThreadsProvider value={threads}>
        <main className="flex h-screen bg-[var(--surface)] text-[var(--text-primary)]">
          <div className="mx-auto flex w-full min-w-0 max-w-[1014px] flex-col gap-6 overflow-y-auto px-[50px] py-6">
            <div data-owner>
              <UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
                workingDir="/fixture"
                content={ownerMessage.content}
                hookSource={ownerMessage.hookSource}
                images={[]}
                files={[]}
                sessionId={rootSessionId}
                messageClientId={ownerMessage.clientId}
                simplifiedBotConversation
              />
            </div>
            {!feishu && <div data-answer>
              <AssistantMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
                workingDir="/fixture"
                content={messages[1].content}
                isStreaming={false}
                currentSessionId={rootSessionId}
                messageClientId="answer"
                showActionBar
                simplifiedBotConversation
              />
            </div>}
            {sentReply && (
              <UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/fixture"
                content={sentReply.text} replyQuote={sentReply.quote} sessionId={rootSessionId}
                messageClientId="fixture-sent-quote" simplifiedBotConversation />
            )}
            <div data-fixture-composer>
              <ChatInput
                sessionId="fixture-companion"
                focusRequest={quote}
                topSlot={
                  quote ? (
                    <BotChatQuoteComposerPreview
                      sessionId={rootSessionId}
                      quote={quote}
                      getMessage={getMessage}
                      names={names}
                    />
                  ) : undefined
                }
                initialWorkingDir="/fixture"
                runtimeAgentKind="codex"
                vendorKey="codex"
                deviceLinkDeviceId={null}
                initialModel="fixture-chat"
                initialProviderId="openai"
                attachmentState={files}
                hideRuntimeControls
                showFolderPicker={false}
                disableAutofocus
                onSend={async (text) => {
                  if (feishu && quote) {
                    setSentReply({ text, quote });
                    clearSentBotReplyQuote(rootSessionId, quote);
                  }
                  return true;
                }}
              />
            </div>
            {sentReply && <button data-ui-page-control data-testid="unload-quote-source" onClick={() => setOriginalLoaded(false)}>
              卸载引用原消息
            </button>}
          </div>
          {topic && (
            <BotDmThreadPanel
              bot={bot}
              rootSessionId={rootSessionId}
              rootClientId={topic}
              state={{ kind: 'failed', message: '演示：暂时无法打开话题' }}
              mentions={[]}
              lastAssistantAt={null}
              replyCount={topic === 'answer' ? 3 : 0}
              onRetry={noop}
              onClose={() => setTopic(null)}
            />
          )}
        </main>
      </BotDmThreadsProvider>
    </BotChatQuoteProvider>
  );
}

void mountPage({
  route: '/bots/fixture',
  host: {
    maker: {
      onDesktopCommandTriggered: subscription('desktop-command'),
      onSessionCredentialSwitchApplied: subscription('credential-applied'),
      onSessionCredentialSwitchFailed: subscription('credential-failed'),
      onPiPackagesChanged: subscription('pi-packages'),
      listAgentSkills: async () => ({ success: true, skills: [] }),
      getSessionAgentSwitchIntent: async () => null,
    },
    voiceInput: {
      getDataSnapshot: () => ({
        settings: { ...getDefaultVoiceInputSettings('darwin'), playInteractionSound: false },
      }),
      onDataChanged: subscription('voice-data'),
      onGlobalShortcutTrigger: subscription('voice-shortcut'),
    },
    deviceLink: { onRemotePush: subscription('remote-push') },
    ghosts: { listSync: () => ({ ghosts: [] }) },
  },
  render: (ctx) => {
    (window as any).__threadRoot = { messages };
    return <Fixture kind={ctx.case} />;
  },
});
