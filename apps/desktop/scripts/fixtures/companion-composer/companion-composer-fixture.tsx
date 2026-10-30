import { useEffect, useState, type ComponentProps } from 'react';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { makerChatStore } from '../../../src/renderer/lib/makerChatStore';
import {
  __testing as promptRecommendations,
  beginPromptRecommendationPrediction,
  clearPromptRecommendationSession,
  resolvePromptRecommendationPrediction,
} from '../../../src/renderer/lib/promptRecommendationStore';

// The fixture's custom origin lacks secure-context randomUUID. These IDs only
// identify in-memory send snapshots; production uses Chromium's secure implementation.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

const noop = () => {};
function Fixture() {
  const [attached, setAttached] = useState(false);
  const [running, setRunning] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [sent, setSent] = useState('');
  useEffect(() => {
    if (typeof ctx.data.recommendation !== 'string') return;
    const sessionId = 'fixture-companion';
    // Seed a completed turn and model result; keep the real recommendation
    // store, editor acceptance and call/send dispatch for the coexistence check.
    makerChatStore.getSnapshot(sessionId);
    promptRecommendations.applyRunningSnapshot(new Map([[sessionId, { isRunning: true }]]));
    promptRecommendations.noteTurnEnded(sessionId, 200);
    promptRecommendations.applyRunningSnapshot(new Map());
    promptRecommendations.settleCompletion(sessionId);
    const seq = beginPromptRecommendationPrediction(sessionId, 200);
    if (seq !== null)
      resolvePromptRecommendationPrediction(sessionId, 200, seq, ctx.data.recommendation);
    return () => clearPromptRecommendationSession(sessionId);
  }, []);
  const files: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: attached
      ? [
          {
            id: 'fixture-file',
            name: 'notes.txt',
            path: '/fixture/notes.txt',
            ext: '.txt',
            size: 12,
            category: 'text',
            mimeType: 'text/plain',
          },
        ]
      : [],
    hasAttachments: attached,
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
    removeFile: () => setAttached(false),
    updateFile: noop,
    discardFiles: noop,
    clearFiles: () => setAttached(false),
    restoreFiles: (files) => [...files],
  };
  return (
    <main className="flex h-screen flex-col justify-center gap-6 bg-[var(--surface-base)] p-6 text-[var(--text-primary)]">
      <div className="text-16 font-medium">Cindy</div>
      <div data-fixture-composer>
        <ChatInput
          sessionId="fixture-companion"
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
          isStreaming={running}
          onStop={() => setRunning(false)}
          onStartVoiceConversation={() => setCallOpen(true)}
          voiceConversationActive={callOpen}
          onSend={async (text) => {
            setSent(text);
            return true;
          }}
        />
      </div>
      <div className="flex flex-wrap gap-4 text-13" data-fixture-controls>
        <button onClick={() => setAttached((value) => !value)} data-testid="attachment">
          Attachment
        </button>
        <button onClick={() => setRunning((value) => !value)} data-testid="running">
          Running
        </button>
        {callOpen && (
          <button onClick={() => setCallOpen(false)} data-testid="end-call">
            End call
          </button>
        )}
        <output data-testid="sent">{sent}</output>
      </div>
    </main>
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
      getMicrophonePermissionCached: () => ({ ok: true, status: 'granted' }),
      onGlobalShortcutTrigger: subscription('voice-shortcut'),
    },
    deviceLink: { onRemotePush: subscription('remote-push') },
    ghosts: { listSync: () => ({ ghosts: [] }) },
  },
  render: () => <Fixture />,
});
