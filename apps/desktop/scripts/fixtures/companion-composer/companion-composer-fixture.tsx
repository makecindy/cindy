import { useEffect, useState, type ComponentProps } from 'react';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { makerChatStore } from '../../../src/renderer/lib/makerChatStore';
import { useAttachments } from '../../../src/renderer/hooks/useAttachments';
import { getDraft } from '../../../src/renderer/lib/composerDraftStore';
import { PluginUiProvider } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import { ghostHostUiApprovalTokens, type InstalledGhost } from '../../../src/shared/ghost';
import { pluginUiInterestKey, type PluginUiInterest } from '../../../src/shared/pluginUi';
import fixturePhoto from '../../../src/renderer/assets/bot-presets/cindy.png';
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
const imageCache = { finish: undefined as (() => void) | undefined,
  getDraft: () => getDraft('fixture-cache-draft') };
const pluginActions: string[] = [];
const plugin: InstalledGhost = {
  enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'fixture' },
  uiCapabilityApproved: true,
  manifest: {
    schemaVersion: 3, id: 'composer-fixture', name: 'Composer fixture', kind: 'chip', entry: 'main.js', version: '1',
    tools: [{ name: 'run', description: 'Run the fixture action' }],
    mcpApps: { ui: { resources: [], tools: { run: { visibility: ['app'] } } }, host: {
      contributions: Array.from({ length: Number(ctx.data.pluginToolbar) || 0 }, (_, index) => ({
        id: `action-${index}`, title: String(ctx.data.pluginTitle || `Plugin ${index + 1}`), position: 'composer.toolbar' as const, tool: 'run',
      })),
    } },
  },
};
plugin.approvedHostUi = ghostHostUiApprovalTokens(plugin.manifest);

function CacheComposer() {
  const attachmentState = useAttachments('fixture-cache-draft');
  return <ChatInput sessionId="fixture-cache-draft" initialWorkingDir="/fixture"
    runtimeAgentKind="codex" vendorKey="codex" deviceLinkDeviceId={null}
    initialModel="fixture-chat" initialProviderId="openai" attachmentState={attachmentState}
    hideRuntimeControls showFolderPicker={false} disableAutofocus onSend={async () => true} />;
}

function CacheScenario() {
  const [visible, setVisible] = useState(true);
  return <main className="flex h-screen flex-col justify-center gap-6 bg-[var(--surface-base)] p-6 text-[var(--text-primary)]">
    <button data-testid="toggle-composer" onClick={() => setVisible(value => !value)}>Toggle composer</button>
    {visible ? <CacheComposer /> : null}
  </main>;
}

function Fixture() {
  const [attached, setAttached] = useState(false);
  const [running, setRunning] = useState(false);
  const [modelReady, setModelReady] = useState(!ctx.data.modelLoading);
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
          initialModel={modelReady ? 'fixture-chat' : undefined}
          initialProviderId="openai"
          attachmentState={files}
          hideRuntimeControls={!ctx.data.showRuntimeControls}
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
      <div className="flex flex-wrap gap-4 text-13" data-ui-page-control>
        {ctx.data.modelLoading && <button data-testid="toggle-model-ready" onClick={() => setModelReady(true)}>Load model</button>}
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
    getFilePath: (file: File) => `/fixture/${file.name}`,
    cacheImageFromPath: async () => new Promise<{ url: string }>(resolve => {
      imageCache.finish = () => resolve({ url: fixturePhoto });
    }),
    maker: {
      onDesktopCommandTriggered: subscription('desktop-command'),
      onSessionCredentialSwitchApplied: subscription('credential-applied'),
      onSessionCredentialSwitchFailed: subscription('credential-failed'),
      onPiPackagesChanged: subscription('pi-packages'),
      listAgentSkills: async () => ({ success: true, skills: [] }),
      getSessionAgentSwitchIntent: async () => null,
      onPluginUiState: subscription('plugin-ui'),
      mcpApps: async (_session: string | null, input: { op: string; id?: string; entries?: PluginUiInterest[] }) => {
        if (input.op === 'plugin-action' && input.id) pluginActions.push(input.id);
        return { updates: ctx.data.pluginHidden ? (input.entries ?? []).map(interest => ({
          key: pluginUiInterestKey(interest), revision: 1, state: { visible: false },
        })) : [] };
      },
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
    ghosts: { listSync: () => ({ ghosts: ctx.data.pluginToolbar ? [plugin] : [] }), onChanged: subscription('ghosts') },
  },
  render: () => {
    (window as unknown as { __composerImageCache: typeof imageCache }).__composerImageCache = imageCache;
    (window as unknown as { __pluginActions: string[] }).__pluginActions = pluginActions;
    return <PluginUiProvider>{ctx.case === 'late-attachment' ? <CacheScenario /> : <Fixture />}</PluginUiProvider>;
  },
});
