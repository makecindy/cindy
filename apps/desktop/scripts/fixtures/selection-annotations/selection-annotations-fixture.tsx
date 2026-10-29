import { useRef, useState, type ComponentProps } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { SelectionQuoteButton } from '../../../src/renderer/components/chat/SelectionQuoteButton';
import { QuoteChip } from '../../../src/renderer/components/chat/QuoteChip';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { parseChatQuoteSegments } from '../../../src/renderer/lib/chatQuotes';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';

// Fixture IDs only: the runner's custom origin is not a secure context.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

const noop = () => {};
const files: ComponentProps<typeof ChatInput>['attachmentState'] = {
  attachments: [], hasAttachments: false, addFiles: async () => {}, addClipboardImage: async () => {},
  rejections: [], dismissRejection: noop, clearRejections: noop, addFolderPath: noop,
  pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noop,
  pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [], removeFile: noop,
  updateFile: noop, discardFiles: noop, clearFiles: noop, restoreFiles: (value) => [...value],
};
function Fixture() {
  const container = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState('annotation-a');
  const [source, setSource] = useState('spec.md');
  const [failNext, setFailNext] = useState(false);
  const [sent, setSent] = useState('');
  const [attempts, setAttempts] = useState(0);
  return <main className="flex h-screen flex-col gap-4 bg-[var(--surface-base)] p-4 text-[var(--text-primary)]">
    <div className="flex flex-wrap gap-3 text-12">
      <button data-testid="task-a" onClick={() => setSessionId('annotation-a')}>Task A</button>
      <button data-testid="task-b" onClick={() => setSessionId('annotation-b')}>Task B</button>
      <button data-testid="source" onClick={() => setSource('other.md')}>Other source</button>
      <button data-testid="fail-next" onClick={() => setFailNext(true)}>Fail next send</button>
      <output data-testid="attempts">{attempts}</output>
    </div>
    <div ref={container} data-testid="reading" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap text-14">
      <div className="msg-markdown"><p data-testid="first">First selected paragraph. 原文与意见一起保留。</p></div>
      <p data-testid="second" className="mt-8">Second selected paragraph.</p>
      <SelectionQuoteButton sessionId={sessionId} sourcePath={source} containerRef={container} />
    </div>
    <div data-testid="history" className="flex flex-wrap gap-2">
      {parseChatQuoteSegments(sent).map((segment, index) => segment.kind === 'quote'
        ? <QuoteChip key={index} quote={segment.quote} /> : <span key={index}>{segment.text}</span>)}
    </div>
    <ChatInput sessionId={sessionId} initialWorkingDir="/fixture" runtimeAgentKind="codex" vendorKey="codex"
      deviceLinkDeviceId={null} initialModel="fixture-chat" initialProviderId="openai" attachmentState={files}
      hideRuntimeControls showFolderPicker={false} disableAutofocus
      onSend={async (text) => {
        setAttempts((value) => value + 1);
        if (failNext) { setFailNext(false); return false; }
        setSent(text); return true;
      }}
    />
  </main>;
}
void mountPage({
  route: '/sessions/annotation-a',
  host: {
    onSelectionContextMenuAddToChat: subscription('selection-context-menu'),
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
      onDataChanged: subscription('voice-data'), onGlobalShortcutTrigger: subscription('voice-shortcut'),
    },
    deviceLink: { onRemotePush: subscription('remote-push') },
    ghosts: { listSync: () => ({ ghosts: [] }) },
  },
  render: () => <Fixture />,
});
