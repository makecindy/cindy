import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { useAttachments } from '../../../src/renderer/hooks/useAttachments';
import { UI_MOCK_BIDI_TASK, UI_MOCK_BIDI_TEXT, UI_MOCK_BIDI_MARKDOWN, UI_MOCK_BIDI_ORCA_MESSAGES } from '../../../../../packages/maker-shared/src/uiMockBidi';

function Fixture({ composerOnly = false }: { composerOnly?: boolean }) {
  const [stream, setStream] = useState('...');
  const attachments = useAttachments('fixture-bidi');
  return <main className="p-4 space-y-4" data-ui-page-subject>
    {!composerOnly && <>
    <section data-testid="user"><UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
      content={UI_MOCK_BIDI_TEXT} workingDir="" simplifiedBotConversation /></section>
    <section data-testid="markdown"><MarkdownRenderer content={UI_MOCK_BIDI_MARKDOWN} workingDir="" allowPrivilegedLinks={false} /></section>
    <section data-testid="rich"><MarkdownRenderer content={(UI_MOCK_BIDI_TASK.messages[2] as { text: string }).text}
      workingDir="" renderRichAnswers allowPrivilegedLinks={false} /></section>
    <section data-testid="stream"><MarkdownRenderer content={stream} workingDir="" isStreaming allowPrivilegedLinks={false} /></section>
    <button data-ui-page-control data-testid="stream-next" onClick={() => setStream('... سلام API 123.\n\nEnglish 456.')}>Append stream</button>
    </>}
    <ChatInput sessionId="fixture-bidi" initialWorkingDir="" runtimeAgentKind="codex" vendorKey="codex"
      attachmentState={attachments}
      initialModel="fixture-chat" initialProviderId="openai" hideRuntimeControls showFolderPicker={false}
      disableAutofocus onSend={async () => true} />
  </main>;
}

function SourceMessagesFixture() {
  const hookText = Array(4).fill(UI_MOCK_BIDI_TEXT).join('\n');
  return <main className="p-4 space-y-4" data-ui-page-subject>
    <section data-testid="letter"><UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
      content={UI_MOCK_BIDI_TEXT} workingDir="" simplifiedBotConversation
      automationOrigin={{ kind: 'session', senderSessionTitle: 'BiDi source' }} /></section>
    <section data-testid="hook"><UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
      content={hookText} workingDir=""
      hookSource={{ im: 'feishu', contentFormat: 'user-text', userText: hookText }} /></section>
  </main>;
}

function OrcaMessagesFixture() {
  return <main className="p-4 space-y-4" data-ui-page-subject>
    {UI_MOCK_BIDI_ORCA_MESSAGES.map((message) => <UserMessage key={message.text}
      pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} content={message.text} workingDir="" />)}
  </main>;
}

function HookContextFixture() {
  return <main className="p-4" data-ui-page-subject>
    <UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} content="Context layout" workingDir=""
      hookSource={{ im: 'feishu', contentFormat: 'user-text', userText: 'Context layout',
        threadContext: [{ author: 'Alex', text: UI_MOCK_BIDI_TEXT }],
        contextSnapshot: { replyContext: UI_MOCK_BIDI_TEXT, replyMessageCount: 1,
          groupContext: UI_MOCK_BIDI_TEXT, groupMessageCount: 1 } }} />
  </main>;
}

void mountPage({
  route: '/bots/fixture-bidi',
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
      getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('win32'), playInteractionSound: false } }),
      onDataChanged: subscription('voice-data'),
      getMicrophonePermissionCached: () => ({ ok: true, status: 'granted' }),
      onGlobalShortcutTrigger: subscription('voice-shortcut'),
    },
    deviceLink: { onRemotePush: subscription('remote-push') },
    ghosts: { listSync: () => ({ ghosts: [] }) },
  },
  render: (ctx) => ctx.case === 'context' ? <HookContextFixture /> : ctx.case === 'orca' ? <OrcaMessagesFixture />
    : ctx.case === 'sources' ? <SourceMessagesFixture /> : <Fixture composerOnly={ctx.case === 'lists'} />,
});
