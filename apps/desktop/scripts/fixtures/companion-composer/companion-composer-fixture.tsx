import { useEffect, useState, type ComponentProps } from 'react';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import type { UiPageRuntime } from '../../ui-page/harness/types';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { makerChatStore, type QueuedMessage } from '../../../src/renderer/lib/makerChatStore';
import { GoalIndicator } from '../../../src/renderer/components/new-chat/GoalIndicator';
import { RunningStatusBar } from '../../../src/renderer/features/cc-agent/CCAgentSessionView';
import { PendingQueuePanel } from '../../../src/renderer/components/new-chat/PendingQueuePanel';
import { useAttachments } from '../../../src/renderer/hooks/useAttachments';
import { getDraft } from '../../../src/renderer/lib/composerDraftStore';
import { PluginUiProvider } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import type { InstalledGhost } from '../../../src/shared/ghost';
import { pluginUiInterestKey, type PluginUiInterest, type PluginUiControlItem } from '../../../src/shared/pluginUi';
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
const pluginItemValues: string[] = [];
let feedbackTarget: { epoch: string; entries: PluginUiInterest[] } | undefined;
let feedbackRevision = 0;
const plugin: InstalledGhost = {
  enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'fixture' },
  uiCapabilityApproved: true,
  manifest: {
    schemaVersion: 3, id: 'composer-fixture', name: 'Composer fixture', kind: 'chip', entry: 'main.js', version: '1',
    tools: [{ name: 'run', description: 'Run the fixture action' }],
    mcpApps: { ui: { resources: ctx.data.headerLong ? [{ uri: 'ui://header', file: 'header.html' }] : [], tools: { run: { visibility: ['app'] } } }, host: {
      views: ctx.data.headerLong ? [{ id: 'header', title: 'Header panel', resourceUri: 'ui://header', scope: 'task' as const }] : [],
      contributions: ctx.data.pluginHeader ? ctx.data.headerDynamic ? [
        { id: 'actions', title: 'Do not display the template', position: 'composer.header', tool: 'run', dynamicItems: true, visible: false },
      ] : [
        { id: 'refresh', title: ctx.data.headerLong ? 'Refresh with a very long plugin action title that must stay on one line' : 'Refresh', position: 'composer.header', tool: 'run', ...(ctx.data.headerIcons ? { icon: 'sparkles' } : {}) },
        { id: 'scope', title: 'Scope', position: 'composer.header', kind: 'select', tool: 'run', options: [{ label: 'All', value: 'all' }] },
        { id: 'status', title: ctx.data.headerLong ? 'Ready with a very long plugin status that must stay on one line' : 'Ready', position: 'composer.header', kind: 'status', ...(ctx.data.headerFeedback ? { visible: false } : {}) },
        ...(ctx.data.headerLong ? [
          ...(ctx.data.headerInlineHidden ? [{ id: 'hidden-inline', title: 'Hidden inline action', position: 'composer.toolbar',
            view: 'header', composerAction: 'inline' as const, visible: false }] : []),
          { id: 'popup', title: 'Open panel', position: 'composer.header', view: 'header', presentation: 'popover' as const, ...(ctx.data.headerIcons ? { icon: 'folder' } : {}) },
          ...Array.from({ length: 5 }, (_, index) => ({ id: `extra-${index}`,
            title: index === 4 ? 'Extra 5 with a long title that stays complete in More' : `Extra ${index + 1}`,
            position: 'composer.header', tool: 'run', ...(ctx.data.headerIcons && index === 1 ? { icon: 'code' } : {}),
            ...(ctx.data.headerIcons && index === 3 ? { icon: 'future-icon' } : {}) })),
        ] : []),
      ] : Array.from({ length: Number(ctx.data.pluginToolbar) || 0 }, (_, index) => ({
        id: `action-${index}`, title: String(ctx.data.pluginTitle || `Plugin ${index + 1}`), position: 'composer.toolbar' as const, tool: 'run',
      })),
    } },
  },
};

if (ctx.data.headerNoMatch) {
  for (const entry of plugin.manifest.mcpApps?.host?.contributions ?? []) entry.match = { roles: ['assistant'] };
}

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
  const [running, setRunning] = useState(Boolean(ctx.data.headerRuntime) || typeof ctx.data.followUp === 'string');
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
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
      <div className="text-16 font-medium">{ctx.data.pluginHeader
        ? ctx.data.headerNewTask ? '新建页回归：无新增入口（验收样本）' : '已有本机任务 · 输入区验收样本（非产品界面）'
        : 'Cindy'}</div>
      <div data-fixture-composer data-plugin-ui-task={ctx.data.headerRuntime ? 'fixture-companion' : undefined}>
        {ctx.data.headerRuntime && <RunningStatusBar status="Generating..." visible={running}
          sessionKey="fixture-companion" startedAt={running ? 1000 : null} tokenUsage={ctx.data.headerRate ? 1280 : 0}
          tokenSpeed={ctx.data.headerRate ? { rate: 64, average: 64, tokens: 1280, elapsedMs: 20000, streaming: true } : undefined}
          centeredSlot={ctx.data.headerCenter ? <span className="flex h-8 items-center px-2" data-header-center>验收计划</span> : undefined}
          inputWidth="100%" composerHeaderRef={setHeaderTarget} />}
        {ctx.data.switchPreparation === 'failed' && <UserMessage workingDir="/fixture" content="Continue the task"
          pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} allowPrivilegedLinks={false}
          dispatchRoute={{ agentKind: 'pi', model: 'fixture-chat', providerId: 'xd', agentDeviceId: null,
            selected: { agentKind: 'codex', model: 'fixture-chat', providerId: 'openai', agentDeviceId: null },
            switchError: '[DEVICE_LINK_TIMEOUT] Target preparation timed out' }} />}
        {ctx.data.headerStack && <div data-header-goal><GoalIndicator sessionId="fixture-companion" /></div>}
        <ChatInput
          sessionId={ctx.data.headerNewTask ? undefined : 'fixture-companion'}
          composerHeaderTarget={ctx.data.headerRuntime ? headerTarget : undefined}
          initialWorkingDir="/fixture"
          runtimeAgentKind={ctx.data.switchPreparation ? 'pi' : 'codex'}
          vendorKey={ctx.data.switchPreparation ? 'pi' : 'codex'}
          deviceLinkDeviceId={null}
          initialModel={modelReady ? 'fixture-chat' : undefined}
          initialProviderId={ctx.data.switchPreparation ? 'xd' : 'openai'}
          attachmentState={files}
          hideRuntimeControls={!ctx.data.showRuntimeControls}
          showFolderPicker={false}
          disableAutofocus
          planModeEnabled={Boolean(ctx.data.headerStack)}
          onPlanModeChange={ctx.data.headerStack ? noop : undefined}
          topSlot={ctx.data.headerStack ? <PendingQueuePanel expanded={false} onToggle={noop} onRemove={noop} mergedWithBelow
            queue={[{ clientId: 'queued-header', text: '验收排队消息', persistedContent: '验收排队消息',
              chatMessage: { clientId: 'queued-header', role: 'user', content: '验收排队消息', isStreaming: false },
              createOpts: { workingDir: '/fixture' } } as QueuedMessage]} /> : undefined}
          isStreaming={running}
          onStop={() => setRunning(false)}
          onQueueSteer={typeof ctx.data.followUp === 'string' ? async () => true : undefined}
          onStartVoiceConversation={() => setCallOpen(true)}
          voiceConversationActive={callOpen}
          onSend={async (text, _model, _effort, _permission, _files, _mentions, opts) => {
            setSent(typeof ctx.data.followUp === 'string' ? `${opts?.deliveryMode}:${text}` : text);
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
    ...(ctx.data.headerRuntime ? { localDb: { sessions: { get: async (id: string) => ({ id, activeTurnStartedAt: 1000, turnElapsedMs: 12000 }) } } } : {}),
    getFilePath: (file: File) => `/fixture/${file.name}`,
    cacheImageFromPath: async () => new Promise<{ url: string }>(resolve => {
      imageCache.finish = () => resolve({ url: fixturePhoto });
    }),
    maker: {
      getGoalStatus: async () => ctx.data.headerStack ? { sessionId: 'fixture-companion', status: 'paused', objective: '验收目标',
        turnsUsed: 1, tokensUsed: 20, maxTurns: null, noProgressLimit: null, budgetTokens: null, usageResetAt: null, startedAt: 0, lastReason: null } : null,
      onGoalStatusChanged: subscription('goal-status'),
      onDesktopCommandTriggered: subscription('desktop-command'),
      onSessionCredentialSwitchApplied: subscription('credential-applied'),
      onSessionCredentialSwitchFailed: subscription('credential-failed'),
      onPiPackagesChanged: subscription('pi-packages'),
      listAgentSkills: async () => ({ success: true, skills: [] }),
      getSessionAgentSwitchIntent: async () => ctx.data.switchPreparation ? {
        targetAgentKind: 'codex', model: 'fixture-chat', providerId: 'openai', preparation: ctx.data.switchPreparation,
      } : null,
      onPluginUiState: subscription('plugin-ui'),
      mcpApps: async (_session: string | null, input: { op: string; id?: string; value?: string; epoch?: string; entries?: PluginUiInterest[]; title?: string; visible?: boolean; items?: PluginUiControlItem[] }) => {
        if (input.op === 'plugin-action' && input.id) pluginActions.push(input.id);
        if (input.op === 'plugin-action' && typeof input.value === 'string') pluginItemValues.push(input.value);
        if ((ctx.data.headerFeedback || ctx.data.headerDynamic) && input.op === 'native-interest') {
          feedbackTarget = { epoch: input.epoch!, entries: input.entries ?? [] };
        }
        // Scenario producer only: deliver the same native-state event the host
        // emits when a plugin publishes a phase, hint, or visibility change.
        if (input.op === 'fixture-feedback' && feedbackTarget) {
          const revision = ++feedbackRevision;
          (window as unknown as { __uiPage: UiPageRuntime }).__uiPage.emit?.('plugin-ui', {
            epoch: feedbackTarget.epoch,
            updates: feedbackTarget.entries.filter(interest => interest.id === (ctx.data.headerDynamic ? 'actions' : 'status')).map(interest => ({
              key: pluginUiInterestKey(interest), revision, state: { title: input.title, visible: input.visible, items: input.items },
            })),
          });
        }
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
    ghosts: { listSync: () => ({ ghosts: ctx.data.pluginToolbar || ctx.data.pluginHeader ? [plugin] : [] }), onChanged: subscription('ghosts') },
  },
  render: () => {
    if (ctx.data.switchPreparation) makerChatStore.mirrorAgentSwitchIntent('fixture-companion', {
      targetAgentKind: 'codex', model: 'fixture-chat', providerId: 'openai', preparation: ctx.data.switchPreparation,
    });
    (window as unknown as { __composerImageCache: typeof imageCache }).__composerImageCache = imageCache;
    // The preference is local state; seed it per variant the way the product stores it.
    if (ctx.data.followUp === 'steer') localStorage.setItem('chat.followUpBehavior', 'steer');
    else localStorage.removeItem('chat.followUpBehavior');
    if (ctx.data.sendKey === 'modifier-enter') localStorage.setItem('chat.sendShortcutPreference', 'modifier-enter');
    else localStorage.removeItem('chat.sendShortcutPreference');
    (window as unknown as { __pluginActions: string[] }).__pluginActions = pluginActions;
    (window as unknown as { __pluginItemValues: string[] }).__pluginItemValues = pluginItemValues;
    return <PluginUiProvider>{ctx.case === 'late-attachment' ? <CacheScenario /> : <Fixture />}</PluginUiProvider>;
  },
});
