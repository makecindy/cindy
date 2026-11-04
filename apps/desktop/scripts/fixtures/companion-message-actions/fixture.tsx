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
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { BotChatQuoteProvider } from '../../../src/renderer/features/bots/botChatQuoteContext';
import { BotChatQuoteComposerPreview } from '../../../src/renderer/features/bots/BotChatQuoteViews';
import {
  setPendingBotReplyQuote,
  usePendingBotReplyQuote,
} from '../../../src/renderer/features/bots/botDmQuote';
import { BotDmThreadsProvider } from '../../../src/renderer/features/bots/botDmThreadsContext';
import { BotDmThreadPanel } from '../../../src/renderer/features/bots/BotDmThreadViews';
const rootSessionId = 'fixture-companion';
const bot = { id: 'fixture-bot', name: 'Aster', avatar: null };
const messages = [
  { clientId: 'owner', role: 'user', content: '请帮我核对消息下的操作。', images: [], files: [] },
  {
    clientId: 'answer',
    role: 'assistant',
    content: '已沿用现有组件。正文可以直接选择，引用后也可以继续编辑草稿。',
    images: [],
    files: [],
  },
];
const getMessage = (id: string) => messages.find((m) => m.clientId === id) as any;
const names = { owner: 'Chris', companion: 'Aster' };
const noop = () => {};
function Fixture({ kind }: { kind: string }) {
  const quote = usePendingBotReplyQuote(rootSessionId);
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
              <UserMessage
                workingDir="/fixture"
                content={messages[0].content}
                images={[]}
                files={[]}
                sessionId={rootSessionId}
                messageClientId="owner"
                simplifiedBotConversation
              />
            </div>
            <div data-answer>
              <AssistantMessage
                workingDir="/fixture"
                content={messages[1].content}
                isStreaming={false}
                currentSessionId={rootSessionId}
                messageClientId="answer"
                showActionBar
                simplifiedBotConversation
              />
            </div>
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
                onSend={async () => true}
              />
            </div>
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
