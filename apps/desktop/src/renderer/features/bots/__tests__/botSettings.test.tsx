// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotModelRoute, BotProfile } from '../botStore';
import { MainViewHistoryContext, type MainViewHistory } from '@/contexts/MainViewHistoryContext';
import type { CustomMcpListContext, CustomMcpListResult } from '../../../../shared/customMcp';
import { beginProvidersRefresh, commitProvidersSnapshot } from '@/lib/providersSnapshotStore';

// #6889 unit regression: the real settings picker must wait for crop
// confirmation; the old upload-only assertion skipped cancellation entirely.
vi.mock('@/components/settings/avatarCropImage', () => ({
  loadAvatarSource: async () => ({ bitmap: { close() {} }, size: { width: 800, height: 400 } }),
  exportAvatarCrop: async () => ({ blob: new Blob(['cropped'], { type: 'image/png' }) }),
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({ migrateModelVisibilityDefaults: vi.fn() }));

vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: mocks.selectableDevices }),
}));
vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: mocks.onboarding }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => <div data-testid="connect-provider-card" />,
}));

const translate = (key: string, opts?: Record<string, unknown>) =>
  key.startsWith('settings.builtinTools.plugins.') ? String(opts?.defaultValue ?? key) : opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'fixture-owner' }), useOptionalAuthDeviceId: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }));

const mocks = vi.hoisted(() => {
  const sessionGet = vi.fn();
  return {
  navigate: vi.fn(),
  retryBotInvitation: vi.fn(async (_id: string) => {}),
  onboarding: false,
  selectableDevices: [] as Array<{ deviceId: string; name: string; platform: string; online: boolean }>,
  readSession: sessionGet,
  initialSearch: '' as string,
  listCustomMcpServers: vi.fn<(context?: CustomMcpListContext) => Promise<CustomMcpListResult>>(),
  getSession: sessionGet,
  onSessionPatched: vi.fn(),
  onMcpChanged: vi.fn(),
  listAgentSkills: vi.fn(),
  listToolsets: vi.fn(),
  profiles: [] as BotProfile[],
  profilesLoaded: true,
  profileLoadError: false,
  refreshBotProfiles: vi.fn(),
  params: {} as { botId?: string },
  availableVendors: new Set(['cc', 'codex', 'pi']),
  defaultModelChain: [] as BotModelRoute[],
  modelListeners: new Set<() => void>(),
  runtimeListeners: new Set<() => void>(),
  updateBotProfile: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  })),
  chooseBotAvatar: vi.fn(async () => ({
    avatar: `cindy-media://blobs/${'a'.repeat(64)}.png`,
    avatarColor: 'violet',
  })),
  openPath: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  projectRepository: vi.fn(),
  };
});

vi.mock('@/lib/sessionService', () => ({ get: mocks.readSession }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const { useCallback, useState } = await import('react');
  return {
    ...actual,
    useParams: () => mocks.params,
    useNavigate: () => mocks.navigate,
    useSearchParams: () => {
      const [params, setParams] = useState(() => new URLSearchParams(mocks.initialSearch));
      const setSearchParams = useCallback(
        (next: URLSearchParams | ((current: URLSearchParams) => URLSearchParams)) => {
          setParams((current) =>
            typeof next === 'function' ? next(new URLSearchParams(current)) : next,
          );
        },
        [],
      );
      return [params, setSearchParams] as const;
    },
  };
});

vi.mock('../botStore', () => ({
  updateBotProfile: mocks.updateBotProfile,
  retryBotInvitation: mocks.retryBotInvitation,
  chooseBotAvatar: mocks.chooseBotAvatar,
  setCanonicalBotSession: vi.fn(),
  useBotProfiles: () => mocks.profiles,
  hasLoadedBotProfiles: () => mocks.profilesLoaded,
  useBotProfilesLoadState: () => mocks.profileLoadError ? 'error' : mocks.profilesLoaded ? 'ready' : 'pending',
  refreshBotProfiles: mocks.refreshBotProfiles,
  canonicalBotSessionId: (bot: BotProfile) => bot.canonicalSessionId,
  getEffectiveBotModelChain: () => mocks.defaultModelChain,
  subscribeBotGlobalModel: (listener: () => void) => {
    mocks.modelListeners.add(listener);
    return () => mocks.modelListeners.delete(listener);
  },
}));
vi.mock('../BotLifecycleSettings', () => ({
  BotLifecycleSettings: () => <div data-testid="bot-lifecycle-settings" />,
}));
vi.mock('../BotChannelsPage', () => ({
  BotChannelsPage: ({ bot }: { bot: { id: string } }) => (
    <div data-testid="bot-channels-page">{bot.id}</div>
  ),
}));
vi.mock('@/hooks/useModelRouteDevices', () => ({
  useModelRouteDevices: () => ({ devices: [], leadAgentDeviceId: null }),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({ unifiedAgents, onUnifiedSelect, modelId, onEffortChange, onNavigateToProviders }: {
    onNavigateToProviders?: () => void;
    modelId: string;
    onEffortChange: (effort: string) => void;
    unifiedAgents: string[];
    onUnifiedSelect: (selection: unknown) => void;
  }) => <>{onNavigateToProviders && <button type="button" onClick={onNavigateToProviders}>connect-source</button>}<button data-testid="current-model" onClick={() => onEffortChange('high')}>{modelId}</button>{(['pi', 'codex'] as const).filter((engine) => unifiedAgents.includes(engine)).map((engine) => (
    <button key={engine} data-testid={engine === 'pi' ? 'model-selector' : 'codex-model-selector'} onClick={() => onUnifiedSelect({ engine, providerId: 'custom', modelId: 'custom-model', effort: 'high', fast: false })}>select-{engine}-model</button>
  ))}<button data-testid="remote-model-selector" onClick={() => onUnifiedSelect({ engine: 'codex', providerId: 'custom', modelId: 'custom-model', effort: 'high', fast: false, agentDevice: { deviceId: 'share:one' } })}>select-remote-model</button></>,
}));
vi.mock('@/hooks/useAvailableAgents', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAvailableAgents: () => ({
      availableVendors: useSyncExternalStore((listener) => {
        mocks.runtimeListeners.add(listener);
        return () => mocks.runtimeListeners.delete(listener);
      }, () => mocks.availableVendors),
      loaded: true,
    }),
  };
});
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({
    lastByVendor: {
      cc: { model: 'claude-x', providerId: null, effort: 'medium' },
      codex: { model: 'codex-x', providerId: null, effort: 'medium' },
      pi: { model: 'pi-x', providerId: null, effort: 'medium' },
    },
    fastModeByModel: {},
  }),
}));

vi.mock('../../feature-context', () => ({ useRegisterContentHeader: () => undefined }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../voice/CompanionVoiceSettings', () => ({
  CompanionVoiceSettings: ({ botId, sessionId }: { botId: string; sessionId?: string }) =>
    <div data-testid="companion-voice-settings">{botId}:{sessionId}</div>,
}));

import { BotsHomeView, BotSettings } from '../BotsHomeView';
import { readBotSettingsPatch } from '../../../../main/localDb/ipc/botRemoteSettingsOps';
import { createIpcError } from '../../../../shared/ipc-errors';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

function capabilities(overrides: Partial<BotCapabilities> = {}): BotCapabilities {
  return {
    model: 'claude-x',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    modelChain: [
      { harness: 'claude', model: 'claude-x', providerId: null, effort: 'medium', fastMode: false },
    ],
    modelChainOverride: null,
    skillMode: 'inherit',
    skillsExcluded: [],
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    permissions: 'ask',
    ...overrides,
  };
}

function bot(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: 'bot-1',
    name: 'PR steward',
    description: 'Delivery steward',
    identitySource: 'Persistent role',
    userContextSource: 'Call me Chris',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    currentVersion: 1,
    skills: [],
    capabilities: capabilities(),
    canonicalSessionId: 'bot-1-chat',
    homeDir: '/managed/bots/bot-1',
    createdAt: Date.now(),
    sessions: [
      {
        id: 'bot-1-chat',
        title: 'Chat',
        kind: 'chat',
        updatedAt: 0,
        profileVersion: 1,
      },
    ],
    ...overrides,
  };
}

function renderSettings(overrides: Partial<BotProfile> = {}, initialSearch = 'settings=1') {
  mocks.initialSearch = initialSearch;
  const onBack = vi.fn();
  const onOpenSession = vi.fn();
  // The capability page asks before discarding an edited Skill, as in the app shell.
  const view = render(
    <BotSettings bot={bot(overrides)} onBack={onBack} onOpenSession={onOpenSession} />,
    { wrapper: ConfirmDialogProvider },
  );
  return { ...view, onBack, onOpenSession };
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.retryBotInvitation.mockClear();
  mocks.onboarding = false;
  mocks.selectableDevices = [];
  mocks.readSession.mockReset();
  mocks.updateBotProfile.mockReset();
  mocks.updateBotProfile.mockImplementation(async (_id, patch) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  }));
  mocks.chooseBotAvatar.mockClear();
  mocks.openPath.mockReset();
  mocks.openPath.mockResolvedValue({ success: true });
  mocks.initialSearch = '';
  mocks.profiles = [];
  mocks.profilesLoaded = true;
  mocks.profileLoadError = false;
  mocks.refreshBotProfiles.mockClear();
  mocks.params = {};
  mocks.projectRepository.mockReset().mockResolvedValue('ready');
  mocks.availableVendors = new Set(['cc', 'codex', 'pi']);
  mocks.defaultModelChain = [];
  mocks.modelListeners.clear();
  mocks.runtimeListeners.clear();
  mocks.getSession.mockReset().mockResolvedValue({ agentKind: 'cc', workingDir: '/bot/workspace' });
  mocks.onSessionPatched.mockReset().mockReturnValue(vi.fn());
  mocks.onMcpChanged.mockReset().mockReturnValue(vi.fn());
  mocks.listAgentSkills.mockReset().mockResolvedValue({ success: true, skills: [{ name: 'release-check' }] });
  mocks.listToolsets.mockReset().mockResolvedValue([
    { id: 'docs', name: 'Documents', effectiveEnabled: true, available: true },
    { id: 'browser', name: 'Browser', effectiveEnabled: true, available: true },
    { id: 'contacts', name: 'Contacts', effectiveEnabled: true, available: false },
  ]);
  mocks.listCustomMcpServers.mockReset();
  mocks.listCustomMcpServers.mockImplementation(async (context) => ({
    agentKind: context?.modelChain?.[0]?.harness === 'codex' ? 'codex'
      : context?.modelChain?.[0]?.harness === 'pi' ? 'pi' : 'claude-code',
    servers: [
    { id: 'shared-docs', name: 'Shared Docs', transport: 'http', url: 'https://example.com/mcp', headers: {}, available: true },
    { id: 'bad-headers', name: 'Legacy MCP', transport: 'http', url: 'https://example.com/mcp', headers: {}, available: false },
  ] }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    openPath: mocks.openPath,
    localDb: { sessionsPush: { onPatched: mocks.onSessionPatched }, bots: { listSkills: vi.fn().mockResolvedValue([]), projectRepository: mocks.projectRepository } },
    maker: {
      onMcpChanged: mocks.onMcpChanged,
      listAgentSkills: mocks.listAgentSkills,
      listCustomMcpServers: mocks.listCustomMcpServers,
      plugins: { list: mocks.listToolsets },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// #10985 unit: real settings input/leave guard. Existing transient-error cases
// did not cover imported oversized originals, equal-length edits, full copy,
// cancel/discard, or zero invalid host requests. Minimal input: 12001 units.
it('retains a long original and draft, offers full copy, and resumes saving after correction', async () => {
  const original = 'x'.repeat(12001);
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const view = renderSettings({ identitySource: original });
  fireEvent.click(screen.getByRole('button', { name: 'bots.profile.personality' }));
  const input = screen.getByRole('textbox', { name: 'bots.profile.personality' });
  expect(input).toHaveProperty('value', original);
  expect(screen.getByText('bots.profile.sourceLength:{"length":12001,"limit":12000}')).toBeTruthy();
  expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  const edited = 'y' + original.slice(1);
  fireEvent.change(input, { target: { value: edited } });
  await act(async () => { fireEvent.blur(input); });
  expect(screen.queryByRole('button', { name: 'bots.autosave.retry' })).toBeNull();
  expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'bots.profile.sourceCopy' })); });
  expect(writeText).toHaveBeenCalledWith(edited);
  expect(screen.queryByRole('button', { name: 'chat.messageActionBar.copied' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.memory.continueEditing' }));
  expect(input).toHaveProperty('value', edited);
  fireEvent.change(input, { target: { value: edited.slice(0, 12000) } });
  await act(async () => { fireEvent.blur(input); });
  expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
  expect(mocks.updateBotProfile).toHaveBeenCalledWith('bot-1', { identitySource: edited.slice(0, 12000) });
  view.unmount();
});

// A resolved write is not proof of a backup. A silent drop and a rejected write
// must both leave the draft, without a verified-success claim (#10985 review).
it.each(['silent-drop', 'denied'] as const)('keeps the draft when clipboard write is %s', async failure => {
  const original = 'x'.repeat(12001);
  const writeText = vi.fn(async () => { if (failure === 'denied') throw new Error('write denied'); });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  renderSettings({ identitySource: original });
  fireEvent.click(screen.getByRole('button', { name: 'bots.profile.personality' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'bots.profile.sourceCopy' })); });
  if (failure === 'denied') expect(screen.getByText('chat.media.copyFailed')).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith(original);
  expect(screen.queryByRole('button', { name: 'chat.messageActionBar.copied' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'bots.profile.personality' })).toHaveProperty('value', original);
  expect(mocks.updateBotProfile).not.toHaveBeenCalled();
});

it('only discards an oversized edit on explicit confirmation and never resubmits on unmount', async () => {
  const original = 'x'.repeat(12001);
  const view = renderSettings({ identitySource: original });
  fireEvent.click(screen.getByRole('button', { name: 'bots.profile.personality' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'bots.profile.personality' }), { target: { value: 'y' + original.slice(1) } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
  fireEvent.click(await screen.findByRole('button', { name: 'bots.memory.discard' }));
  await screen.findByRole('button', { name: 'bots.profile.personality' });
  fireEvent.click(screen.getByRole('button', { name: 'bots.profile.personality' }));
  expect(screen.getByRole('textbox', { name: 'bots.profile.personality' })).toHaveProperty('value', original);
  view.unmount();
  expect(mocks.updateBotProfile).not.toHaveBeenCalled();
});

describe('Bot entry after deletion', () => {
  it('opens an ordinary teammate when Cindy is absent without flashing creation', () => {
    mocks.profiles = [bot()];
    render(<BotsHomeView />);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1', { replace: true });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('prefers the last viewed ID over Cindy, independent of renamed profiles', () => {
    mocks.profiles = [bot({ id: 'cindy', name: 'Renamed', templateId: 'cindy' }), bot()];
    const history = { current: { lastMatchedKey: 'bots', paths: {}, lastBotId: 'bot-1' } as MainViewHistory };
    render(<MainViewHistoryContext.Provider value={history}><BotsHomeView /></MainViewHistoryContext.Provider>);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1', { replace: true });
  });

  it('waits for hydration before recovering a stale deep link', () => {
    mocks.profilesLoaded = false;
    mocks.params = { botId: 'deleted' };
    const view = render(<BotsHomeView />);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    mocks.profiles = [bot()];
    mocks.profilesLoaded = true;
    view.rerender(<BotsHomeView />);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1', { replace: true });
  });

  it('skips a deleting current profile and opens recovery settings for the remaining paused one', () => {
    mocks.params = { botId: 'deleted' };
    mocks.profiles = [bot({ id: 'deleted', status: 'deleting' }), bot({ status: 'paused' })];
    render(<BotsHomeView />);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1?settings=1', { replace: true });
    expect(mocks.readSession).not.toHaveBeenCalled();
  });

  // #9978: a failed first read is neither an empty roster nor endless opening.
  it('offers read recovery without navigating or creating after a failed first roster read', () => {
    mocks.profilesLoaded = false;
    mocks.profileLoadError = true;
    const view = render(<BotsHomeView />);
    expect(screen.getByRole('alert').textContent).toContain('bots.rosterLoadFailed');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.rosterReload' }));
    expect(mocks.refreshBotProfiles).toHaveBeenCalledOnce();
    mocks.profileLoadError = false;
    mocks.profilesLoaded = true;
    mocks.profiles = [bot()];
    view.rerender(<BotsHomeView />);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1', { replace: true });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains the creation draft after a loaded empty roster refresh fails', () => {
    const view = render(<BotsHomeView />);
    const name = screen.getByRole('textbox');
    fireEvent.change(name, { target: { value: 'My draft buddy' } });
    mocks.profileLoadError = true;
    view.rerender(<BotsHomeView />);
    expect(screen.getByRole('textbox')).toBe(name);
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'My draft buddy');
    mocks.profileLoadError = false;
    view.rerender(<BotsHomeView />);
    expect(screen.getByRole('textbox')).toBe(name);
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'My draft buddy');
  });

  it('prioritizes initial roster recovery before provider onboarding', () => {
    mocks.onboarding = true;
    mocks.profilesLoaded = false;
    mocks.profileLoadError = true;
    const view = render(<BotsHomeView />);
    expect(screen.getByRole('alert').textContent).toContain('bots.rosterLoadFailed');
    expect(screen.queryByTestId('connect-provider-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.rosterReload' }));
    expect(mocks.refreshBotProfiles).toHaveBeenCalledOnce();
    mocks.profileLoadError = false;
    mocks.profilesLoaded = true;
    view.rerender(<BotsHomeView />);
    expect(screen.getByTestId('connect-provider-card')).toBeTruthy();
  });

  it('only shows creation once the loaded roster is empty', () => {
    mocks.params = { botId: 'deleted' };
    render(<BotsHomeView />);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(mocks.navigate).toHaveBeenCalledWith('/bots', { replace: true });
  });
});

describe('Bot settings profile consolidation', () => {
  // PR #11347 review regression (unit/jsdom): the real settings header must
  // describe the completed commit, not the page entered during its 1.8s hold.
  // Existing model receipt cases only saved a model on the model page.
  // Minimal input: save a name, then immediately open the model page.
  it('does not turn a profile save into a model receipt when switching pages', async () => {
    vi.useFakeTimers();
    renderSettings();
    const name = screen.getByLabelText('bots.nameLabel');
    fireEvent.change(name, { target: { value: 'Updated name' } });
    await act(async () => { fireEvent.blur(name); });
    expect(screen.getByRole('status').textContent).toContain('bots.autosave.saved');
    await act(async () => { fireEvent.click(screen.getByText('bots.settingsTabs.model')); });
    expect(screen.getByRole('status').textContent).toContain('bots.autosave.saved');
    expect(screen.getByRole('status').textContent).not.toContain('bots.autosave.savedModel');
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
  });

  // PR #11347 unit regression: exercise real canLeave, autosave and patch
  // generation. Existing picker tests used explicit model revisions, so never
  // covered an ordinary field reverted to baseline while its old write hung.
  it('keeps a reverted profile on screen after timeout and persists it after forced unmount', async () => {
    vi.useFakeTimers();
    let savedName = bot().name;
    let finish!: () => void;
    mocks.updateBotProfile.mockImplementation(async (_id, patch) => {
      if (mocks.updateBotProfile.mock.calls.length === 1) {
        await new Promise<void>(resolve => { finish = resolve; });
      }
      if (typeof patch.name === 'string') savedName = patch.name;
      return { ...bot({ name: savedName }), currentVersion: 2 };
    });
    const beforeCloseRef = { current: null as (() => Promise<boolean>) | null };
    const view = render(<BotSettings bot={bot()} onBack={vi.fn()} onOpenSession={vi.fn()} beforeCloseRef={beforeCloseRef} />,
      { wrapper: ConfirmDialogProvider });
    const name = screen.getByLabelText('bots.nameLabel');
    fireEvent.change(name, { target: { value: 'Temporary edit' } });
    fireEvent.blur(name);
    await act(async () => {});
    fireEvent.change(name, { target: { value: bot().name } });
    let allowed: boolean | undefined;
    await act(async () => { void beforeCloseRef.current!().then(value => { allowed = value; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(allowed).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('bots.autosave.unconfirmed');
    expect(name).toHaveProperty('value', bot().name);
    view.unmount();
    await act(async () => { finish(); });
    expect(mocks.updateBotProfile.mock.calls.map(([, patch]) => patch.name)).toEqual(['Temporary edit', bot().name]);
    expect(savedName).toBe(bot().name);
    renderSettings({ name: savedName });
    expect(screen.getByLabelText('bots.nameLabel')).toHaveProperty('value', bot().name);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
  });

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  // 2026-11-26 decision: the drawer's model page is a read-only display plus an entry to Settings.
  it('shows the current model read-only, says it follows the default, and opens the buddy model settings', async () => {
    mocks.defaultModelChain = capabilities().modelChain;
    renderSettings();
    fireEvent.click(screen.getByText('bots.settingsTabs.model'));
    const controls = within(screen.getByTestId('bot-primary-model-controls'));
    expect(controls.getByTestId('current-model').textContent).toBe('claude-x');
    expect(screen.getByText('bots.model.followsDefault')).toBeTruthy();
    expect(screen.queryByText('bots.model.ownModel')).toBeNull();
    expect(screen.getByText('bots.model.managedInSettings')).toBeTruthy();
    // The picker callbacks are blocked, so no model write can happen from the drawer.
    fireEvent.click(controls.getByTestId('codex-model-selector'));
    fireEvent.click(controls.getByTestId('remote-model-selector'));
    await act(async () => {});
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    expect(screen.queryByText('bots.model.restoreDefault')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.model.openSettings' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=model-groups&section=buddies');
  });

  it('says the buddy has its own model when an override is saved', () => {
    const own = { ...capabilities().modelChain[0]!, model: 'own-model' };
    renderSettings({ capabilities: capabilities({ modelChain: [own], modelChainOverride: [own] }) });
    fireEvent.click(screen.getByText('bots.settingsTabs.model'));
    expect(within(screen.getByTestId('bot-primary-model-controls')).getByTestId('current-model').textContent).toBe('own-model');
    expect(screen.getByText('bots.model.ownModel')).toBeTruthy();
    expect(screen.queryByText('bots.model.followsDefault')).toBeNull();
  });

  // The settings drawer previously showed its editable identity under the invitation card.
  it.each(['failed', 'welcome'] as const)('shows only the invitation header and keeps the read-only model page accessible while invitation is %s', async (stage) => {
    mocks.defaultModelChain = capabilities().modelChain;
    renderSettings({ invitation: { stage }, canonicalSessionId: undefined });
    expect(screen.getByText(/^bots\.invitation\.waiting:/)).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'PR steward' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.profile.changeAvatar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'bots.homeFolder.title' })).toBeTruthy();
    expect(screen.getByLabelText('bots.nameLabel')).toHaveProperty('readOnly', true);
    expect(screen.getByLabelText('bots.profile.summary')).toHaveProperty('readOnly', true);
    expect(screen.getByLabelText('bots.profile.personality')).toHaveProperty('readOnly', true);
    // 2026-11-26 decision: the model page is reachable but read-only; changing the model happens in Settings.
    fireEvent.click(screen.getByRole('button', { name: 'bots.invitation.changeModel' }));
    const controls = within(screen.getByTestId('bot-primary-model-controls'));
    expect(controls.getByTestId('current-model').textContent).toBe('claude-x');
    fireEvent.click(controls.getByTestId('codex-model-selector'));
    await act(async () => {});
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.model.openSettings' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=model-groups&section=buddies');
  });

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  it.each([true, false])('opens existing history without a model when onboarding is %s', async (onboarding) => {
    const existing = bot({ capabilities: capabilities({ modelChain: [], model: '' }) });
    mocks.profiles = [existing];
    mocks.params = { botId: existing.id };
    mocks.onboarding = onboarding;
    mocks.readSession.mockResolvedValue({ id: existing.canonicalSessionId, status: 'active', source: 'bot', title: 'History', updatedAt: new Date().toISOString() });
    const createCanonicalSession = vi.fn();
    Object.assign(window.electronAPI, { localDb: { bots: { createCanonicalSession } } });
    render(<BotsHomeView />);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1/session/bot-1-chat', { replace: true }));
    expect(screen.queryByTestId('connect-provider-card')).toBeNull();
    expect(screen.queryByTestId('model-selector')).toBeNull();
    expect(createCanonicalSession).not.toHaveBeenCalled();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it.each(['missing', 'archived', 'foreign'])('requires a model before rebuilding a %s canonical task', async (state) => {
    const existing = bot({ capabilities: capabilities({ modelChain: [], model: '' }) });
    mocks.profiles = [existing];
    mocks.params = { botId: existing.id };
    if (state === 'missing') mocks.readSession.mockRejectedValue(new Error('missing'));
    else mocks.readSession.mockResolvedValue({ status: state === 'archived' ? 'archived' : 'active', source: state === 'foreign' ? 'user' : 'bot' });
    const createCanonicalSession = vi.fn();
    Object.assign(window.electronAPI, { localDb: { bots: { createCanonicalSession } } });
    render(<BotsHomeView />);
    await screen.findByTestId('model-selector');
    expect(createCanonicalSession).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('opens a model picker for an existing empty-chain bot without retrying creation', async () => {
    const emptyBot = bot({ capabilities: capabilities({ modelChain: [], model: '' }), sessions: [], canonicalSessionId: undefined });
    mocks.profiles = [emptyBot];
    mocks.params = { botId: emptyBot.id };
    const createCanonicalSession = vi.fn();
    Object.assign(window.electronAPI, { localDb: { bots: { createCanonicalSession } } });
    render(<BotsHomeView />);
    expect(createCanonicalSession).not.toHaveBeenCalled();
    expect(screen.queryByText('commonUi.retry')).toBeNull();
    fireEvent.click(screen.getByTestId('model-selector'));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenCalledWith(emptyBot.id, expect.objectContaining({
      capabilities: expect.objectContaining({ modelChainOverride: [expect.objectContaining({ model: 'custom-model', providerId: 'custom' })] }),
    })));
  });

  // Unit, BotsHomeView recovery: an online same-account computer may offer the only model.
  // With onboarding active and an empty chain, the old gate hid the model picker before the directory could load.
  it('lets an empty-chain companion browse models when another computer is online', () => {
    const emptyBot = bot({ capabilities: capabilities({ modelChain: [], model: '' }), sessions: [], canonicalSessionId: undefined });
    mocks.profiles = [emptyBot];
    mocks.params = { botId: emptyBot.id };
    mocks.onboarding = true;
    mocks.selectableDevices = [{ deviceId: 'other-computer', name: 'Other computer', platform: 'win32', online: true }];

    render(<BotsHomeView />);

    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.queryByTestId('connect-provider-card')).toBeNull();
  });

  it('can connect a source from existing empty-chain recovery when onboarding is hidden', () => {
    const emptyBot = bot({ capabilities: capabilities({ modelChain: [], model: '' }), sessions: [], canonicalSessionId: undefined });
    mocks.profiles = [emptyBot];
    mocks.params = { botId: emptyBot.id };
    render(<BotsHomeView />);
    fireEvent.click(screen.getByText('connect-source'));
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=providers');
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it('filters unavailable runtimes when recovering an existing empty-chain bot', async () => {
    mocks.availableVendors = new Set(['codex']);
    const emptyBot = bot({ capabilities: capabilities({ modelChain: [], model: '' }), sessions: [], canonicalSessionId: undefined });
    mocks.profiles = [emptyBot];
    mocks.params = { botId: emptyBot.id };
    const createCanonicalSession = vi.fn();
    Object.assign(window.electronAPI, { localDb: { bots: { createCanonicalSession } } });
    render(<BotsHomeView />);
    expect(createCanonicalSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('model-selector')).toBeNull();
    fireEvent.click(screen.getByTestId('codex-model-selector'));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenCalledWith(emptyBot.id, expect.objectContaining({
      capabilities: expect.objectContaining({ modelChainOverride: [expect.objectContaining({ harness: 'codex', model: 'custom-model' })] }),
    })));
  });

  it.each(['provider', 'runtime', 'global chain'] as const)(
    'opens a stale empty-chain follower when the %s recovers without a profile write',
    async (source) => {
      if (source === 'runtime') mocks.availableVendors = new Set(['pi']);
      const emptyBot = bot({ capabilities: capabilities({ modelChain: [], model: '' }), sessions: [], canonicalSessionId: undefined });
      mocks.profiles = [emptyBot];
      mocks.params = { botId: emptyBot.id };
      let release!: (result: unknown) => void;
      const createCanonicalSession = vi.fn(() => new Promise((resolve) => { release = resolve; }));
      Object.assign(window.electronAPI, { localDb: { bots: { createCanonicalSession } } });
      render(<BotsHomeView />);
      expect(createCanonicalSession).not.toHaveBeenCalled();
      expect(screen.getByTestId('model-selector')).toBeTruthy();

      const publish = () => {
        if (source === 'provider') {
          commitProvidersSnapshot(beginProvidersRefresh(), {
            dataOwnerId: null, ownerGeneration: 0, providers: [], providerOrder: [],
          });
        } else if (source === 'runtime') {
          mocks.availableVendors = new Set(['pi', 'codex']);
          for (const listener of mocks.runtimeListeners) listener();
        } else {
          for (const listener of mocks.modelListeners) listener();
        }
      };
      act(() => {
        mocks.defaultModelChain = [{ harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false }];
        publish();
      });
      await waitFor(() => expect(createCanonicalSession).toHaveBeenCalledOnce());
      expect(screen.queryByTestId('model-selector')).toBeNull();
      expect(createCanonicalSession).toHaveBeenCalledWith(expect.objectContaining({ botId: emptyBot.id, expectedProfileVersion: 1 }));
      // Further input refreshes while Main resolves the route must not restart creation.
      act(publish);
      expect(createCanonicalSession).toHaveBeenCalledOnce();
      await act(async () => release({ session: { id: 'recovered-chat', title: 'Recovered' } }));
      await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1/session/recovered-chat', { replace: true }));
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
      expect(emptyBot.capabilities.modelChainOverride).toBeNull();
    },
  );

  it('does not substitute global defaults for an explicitly configured empty projection', () => {
    mocks.defaultModelChain = [{ harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false }];
    const explicit = { harness: 'pi' as const, providerId: 'custom', model: 'custom-model', effort: 'high', fastMode: false };
    const emptyBot = bot({ capabilities: capabilities({ modelChain: [], modelChainOverride: [explicit], model: '' }), sessions: [], canonicalSessionId: undefined });
    mocks.profiles = [emptyBot];
    mocks.params = { botId: emptyBot.id };
    const createCanonicalSession = vi.fn();
    Object.assign(window.electronAPI, { localDb: { bots: { createCanonicalSession } } });
    render(<BotsHomeView />);
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(createCanonicalSession).not.toHaveBeenCalled();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    expect(emptyBot.capabilities.modelChainOverride).toEqual([explicit]);
  });

  it('shows one inline basic-information editor and no legacy profile/persona/growth editors', () => {
    renderSettings();

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
    expect(screen.getByLabelText('bots.profile.summary')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.profile.changeAvatar' })).toBeTruthy();
    expect(screen.getByText('bots.homeFolder.title')).toBeTruthy();
    expect(within(screen.getByTestId('bot-primary-model-controls')).getByTestId('model-selector')).toBeTruthy();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.getByTestId('bot-lifecycle-settings').closest('details')).toBeNull();
    expect(screen.queryByText('bots.settingsTabs.growth')).toBeNull();
    expect(screen.queryByText('bots.persona.adjustButton')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  // 2026-11-09: the task model setting is retired. An older controller's autosave that still carries
  // it applies its other changes; the retired field alone is refused as an empty patch.
  it('drops an older controller\'s retired task model from a settings patch', () => {
    const route = { harness: 'codex', model: 'm', providerId: 'p', effort: 'high', fastMode: false };
    expect(readBotSettingsPatch({ capabilities: { memory: false, taskModelOverride: route } })).toEqual({ capabilities: { memory: false } });
    expect(() => readBotSettingsPatch({ capabilities: { taskModelOverride: route } })).toThrow();
  });

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  // Unit regression: the autosave previously discarded every cause, so an invalid
  // field and an offline host were indistinguishable. Exercise the real hook/UI.
  it.each([
    [createIpcError('INVALID_PARAMS', 'capabilities has an unsupported field'), 'ipcError.INVALID_PARAMS'],
    [createIpcError('INVALID_PARAMS', 'Model route unavailable'), 'ipcError.MODEL_SELECTION_UNAVAILABLE'],
    [createIpcError('DEVICE_LINK_DEVICE_OFFLINE', 'offline'), 'bots.profileSaveOffline'],
    // Relay/link disconnects use a different IPC code from a known offline device.
    [createIpcError('DEVICE_LINK_NOT_CONNECTED', 'link not open'), 'bots.profileSaveOffline'],
    [createIpcError('DEVICE_LINK_TIMEOUT', 'timeout'), 'bots.remoteSettings.saveFailed'],
    [new Error('/private/profile.db failed'), 'bots.profileSaveFailed'],
  ])('shows a safe save failure reason and clears it after retry: %s', async (error, key) => {
    vi.useFakeTimers();
    mocks.updateBotProfile.mockRejectedValueOnce(error);
    renderSettings();
    // 2026-11-26 decision: the model is no longer edited here, so the failing write is an ordinary profile edit.
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Renamed buddy' } });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(screen.getByRole('alert').textContent).toContain(key);
    expect(screen.getByRole('alert').textContent).not.toContain('/private');
    await act(async () => { fireEvent.click(screen.getByText('bots.autosave.retry')); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
  });

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  it('keeps a long description inside the single editable field', () => {
    const long = 'x'.repeat(500);
    renderSettings({ description: long });
    const summary = screen.getByLabelText('bots.profile.summary') as HTMLTextAreaElement;
    expect(summary.value).toBe(long);
    expect(summary.tagName).toBe('TEXTAREA');
  });

  it('opens the managed advanced folder without exposing a second editor', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.title' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.open' }));
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/managed/bots/bot-1'));
  });

  // #10216 unit: the actual settings entry must read without writing, explain
  // missing identity, and finish an explicit retry without duplicate writes.
  it('shows the Git identity problem and retries only when requested', async () => {
    let finish!: (value: string) => void;
    mocks.projectRepository.mockResolvedValueOnce('needs-identity')
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.title' }));
    await screen.findByText('bots.homeFolder.repository.needsIdentity');
    expect(mocks.projectRepository).toHaveBeenCalledExactlyOnceWith('bot-1', false);
    const retry = screen.getByRole('button', { name: 'bots.retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(mocks.projectRepository).toHaveBeenLastCalledWith('bot-1', true);
    expect(mocks.projectRepository).toHaveBeenCalledTimes(2);
    await act(async () => finish('ready'));
    expect(screen.getByText('bots.homeFolder.repository.ready')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.retry' })).toBeNull();
  });

  it('shows the open-folder failure in place', async () => {
    mocks.openPath.mockResolvedValue({ success: false, error: 'missing' });
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.title' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.open' }));
    expect((await screen.findByRole('alert')).textContent).toContain('missing');
  });

  it('starts at grouped settings and opens real inner pages without exposing hidden inputs', async () => {
    renderSettings({ invitation: { stage: 'ready' } }, 'settings=1&tab=growth');
    expect(screen.getByRole('heading', { level: 1, name: 'PR steward' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.profile.changeAvatar' })).toBeTruthy();
    expect(screen.queryByText(/^bots\.invitation\.waiting:/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'bots.historySearch.title' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.title' }));
    expect(screen.getByRole('textbox', { name: 'bots.nameLabel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.profile.changeAvatar' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.nameLabel' }), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'bots.settingsTabs.model' })).toBeTruthy());
    expect(mocks.updateBotProfile).toHaveBeenCalledWith('bot-1', { name: 'New name' });
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsTabs.model' }));
    expect(screen.getByRole('region', { name: 'bots.settingsTabs.model' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'bots.nameLabel' })).toBeNull();
  });

  it('lists messaging platforms after capabilities and opens it from the home row or a deep link', () => {
    const view = renderSettings();
    const rows = screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text) => text === 'bots.capabilities.title' || text === 'bots.channels.title');
    expect(rows).toEqual(['bots.capabilities.title', 'bots.channels.title']);
    fireEvent.click(screen.getByRole('button', { name: 'bots.channels.title' }));
    expect(screen.getByTestId('bot-channels-page').textContent).toBe('bot-1');
    expect(screen.getByRole('heading', { name: 'bots.channels.title' })).toBeTruthy();
    view.unmount();

    render(
      <BotSettings bot={bot()} initialPage="channels" onBack={vi.fn()} onOpenSession={vi.fn()} />,
      { wrapper: ConfirmDialogProvider },
    );
    expect(screen.getByTestId('bot-channels-page')).toBeTruthy();
  });

  it('keeps the current inner page and its draft when saving before navigation fails', async () => {
    mocks.updateBotProfile.mockRejectedValue(new Error('offline'));
    const beforeCloseRef = { current: null as (() => Promise<boolean>) | null };
    render(<BotSettings bot={bot()} onBack={vi.fn()} onOpenSession={vi.fn()} beforeCloseRef={beforeCloseRef} />, { wrapper: ConfirmDialogProvider });
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.title' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.nameLabel' }), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    await screen.findByRole('button', { name: 'bots.autosave.retry' });
    expect((screen.getByRole('textbox', { name: 'bots.nameLabel' }) as HTMLInputElement).value).toBe('Keep this draft');
    let allowed = true;
    await act(async () => { allowed = await beforeCloseRef.current!(); });
    expect(allowed).toBe(false);
  });

  it('does not duplicate the chat action inside the settings panel', () => {
    renderSettings();
    expect(screen.queryByRole('button', { name: 'bots.actions.message' })).toBeNull();
  });

  it('keeps archived teammates read-only', () => {
    renderSettings({ status: 'archived' });
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByLabelText('bots.nameLabel')).toBeNull();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });
});

describe('Bot settings unified autosave', () => {
  it('follows defaults when they recover for a buddy with no own model, without saving', async () => {
    vi.useFakeTimers();
    const route = capabilities().modelChain[0]!;
    const view = renderSettings({ capabilities: capabilities({ modelChainOverride: null, modelChain: [], model: '' }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    act(() => {
      mocks.defaultModelChain = [{ ...route, model: 'recovered-model' }];
      for (const listener of mocks.modelListeners) listener();
    });
    expect(screen.getAllByTestId('current-model')[0]?.textContent).toBe('recovered-model');
    expect(screen.getAllByText('bots.model.followsDefault').length).toBeGreaterThan(0);
    view.unmount();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it.each(['provider', 'runtime', 'global chain'] as const)(
    'refreshes a nonempty default chain after %s changes without saving or losing edits',
    async (source) => {
      vi.useFakeTimers();
      const oldRoute = capabilities().modelChain[0]!;
      mocks.defaultModelChain = [oldRoute];
      const view = renderSettings();
      const nextRoute = { ...oldRoute, harness: 'codex' as const, model: 'new-default', providerId: 'openai' };
      act(() => {
        mocks.defaultModelChain = [nextRoute];
        if (source === 'provider') {
          commitProvidersSnapshot(beginProvidersRefresh(), {
            dataOwnerId: null, ownerGeneration: 0, providers: [], providerOrder: [],
          });
        } else if (source === 'runtime') {
          mocks.availableVendors = new Set(['codex']);
          for (const listener of mocks.runtimeListeners) listener();
        } else {
          for (const listener of mocks.modelListeners) listener();
        }
      });
      expect(within(screen.getByTestId('bot-primary-model-controls')).getByTestId('current-model').textContent).toBe('new-default');
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Pending name' } });
      act(() => {
        mocks.defaultModelChain = [{ ...nextRoute, model: 'later-default' }];
        for (const listener of mocks.modelListeners) listener();
      });
      // 2026-11-26 decision: no local model edit exists in the drawer, so it keeps following the newest default.
      expect(within(screen.getByTestId('bot-primary-model-controls')).getByTestId('current-model').textContent).toBe('later-default');
      expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Pending name');
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(mocks.updateBotProfile.mock.lastCall?.[1]).toMatchObject({ name: 'Pending name' });
      expect((mocks.updateBotProfile.mock.lastCall?.[1] as { capabilities?: { modelChainOverride?: unknown } } | undefined)?.capabilities?.modelChainOverride).toBeUndefined();
      view.unmount();
    },
  );

  it('does not persist a default refresh when leaving settings', () => {
    const view = renderSettings();
    act(() => {
      mocks.defaultModelChain = [{ ...capabilities().modelChain[0]!, model: 'updated-default' }];
      for (const listener of mocks.modelListeners) listener();
    });
    view.unmount();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it('debounces basic text edits through the existing profile channel', async () => {
    vi.useFakeTimers();
    renderSettings();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), {
      target: { value: 'Release buddy' },
    });
    fireEvent.change(screen.getByLabelText('bots.profile.summary'), {
      target: { value: 'Own releases' },
    });
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    // Unedited identity and capabilities must not overwrite concurrent Bot updates.
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toEqual({
      name: 'Release buddy',
      description: 'Own releases',
    });
  });

  it('saves Cindy from the settings gallery without changing the name or persona', async () => {
    vi.stubGlobal('Image', class { src = ''; width = 256; height = 256; decode = async () => {}; });
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const output = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cG9ydHJhaXQ=');
    try {
      renderSettings();
      fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
      await waitFor(() => expect(mocks.chooseBotAvatar).toHaveBeenCalledWith('bot-1', 'cG9ydHJhaXQ='));
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
      expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('PR steward');
    } finally {
      context.mockRestore();
      output.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('keeps the local Bot avatar through crop cancellation and saves only confirmed bytes', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const source = vi.fn(async () => ({ canceled: false, previewDataUrl: 'data:image/png;base64,c2Ry' }));
    window.electronAPI.localDb.bots.chooseAvatarSource = source;
    window.electronAPI.profileChooseAvatar = vi.fn(async () => { throw new Error('Local mode has no account'); });
    const previous = `cindy-media://blobs/${'b'.repeat(64)}.png`;
    try {
      renderSettings({ avatar: previous });
      const upload = () => {
        fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
        fireEvent.click(screen.getByRole('button', { name: 'bots.guided.upload' }));
      };
      upload();
      await screen.findByRole('alertdialog');
      expect(mocks.chooseBotAvatar).not.toHaveBeenCalled();
      expect(document.querySelector('img')?.getAttribute('src')).toBe(previous);
      fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.cancel' }));
      expect(mocks.chooseBotAvatar).not.toHaveBeenCalled();
      upload();
      await screen.findByRole('alertdialog');
      fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
      await waitFor(() => expect(mocks.chooseBotAvatar).toHaveBeenCalledExactlyOnceWith('bot-1', 'Y3JvcHBlZA=='));
      expect(document.querySelector('img')?.getAttribute('src')).toBe(`cindy-media://blobs/${'a'.repeat(64)}.png`);
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
      expect(source).toHaveBeenCalledTimes(2);
      expect(window.electronAPI.profileChooseAvatar).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('turns memory on and off from the memory page', async () => {
    vi.useFakeTimers();
    const listMemory = vi.fn(async () => []);
    Object.assign(window.electronAPI, {
      localDb: { ...window.electronAPI.localDb, bots: { memory: { list: listMemory } } },
    });
    renderSettings({ capabilities: capabilities({ memory: false }) });
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.title' }));
    expect(screen.queryByRole('switch', { name: 'bots.memory.enabled' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.title' }));
    expect(screen.getByText('bots.memory.disabledHint')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'bots.memory.enabled' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listMemory).toHaveBeenCalledWith('bot-1', undefined);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ memory: true }),
    });
  });

  it('edits what the teammate knows about its owner on the memory page and saves it as userContextSource', async () => {
    vi.useFakeTimers();
    Object.assign(window.electronAPI, {
      localDb: { ...window.electronAPI.localDb, bots: { memory: { list: vi.fn(async () => []) } } },
    });
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.title' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.aboutMe' }), {
      target: { value: 'Prefers tea' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toEqual({ userContextSource: 'Prefers tea' });
  });
});


describe('settings text fields', () => {
  it('never saves unconfirmed IME text on any save path and saves it once committed', async () => {
    vi.useFakeTimers();
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.title' }));
    const name = screen.getByRole('textbox', { name: 'bots.nameLabel' });
    const summary = screen.getByLabelText('bots.profile.summary');
    // A save already scheduled before the composition still fires, without the pinyin.
    fireEvent.change(summary, { target: { value: 'Own releases' } });
    fireEvent.compositionStart(name);
    fireEvent.change(name, { target: { value: 'PR stewardni' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // An explicit flush in the middle of the composition is held to the same snapshot.
    fireEvent.blur(summary);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toEqual({ description: 'Own releases' });
    fireEvent.change(name, { target: { value: 'PR steward你' } });
    fireEvent.compositionEnd(name);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(mocks.updateBotProfile.mock.calls[1]?.[1]).toEqual({ name: 'PR steward你' });
  });

  it('keeps showing the saved name for a cleared field and tidies the field on blur', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.title' }));
    const name = screen.getByRole('textbox', { name: 'bots.nameLabel' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.blur(name);
    expect(name.value).toBe('PR steward');
    fireEvent.change(name, { target: { value: '  Release buddy ' } });
    fireEvent.blur(name);
    expect(name.value).toBe('Release buddy');
    await waitFor(() =>
      expect(mocks.updateBotProfile).toHaveBeenCalledWith('bot-1', { name: 'Release buddy' }),
    );
    const summary = screen.getByLabelText('bots.profile.summary') as HTMLTextAreaElement;
    fireEvent.change(summary, { target: { value: 'Own releases \n' } });
    fireEvent.blur(summary);
    expect(summary.value).toBe('Own releases');
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Release buddy' })).toBeTruthy();
  });

  it('moves focus to the opened page and back to the row that opened it', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.personality' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'bots.settingsBack' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'bots.profile.personality' }),
      ),
    );
  });
});

describe('same-Bot capability updates while editing settings', () => {
  beforeEach(() => {
    mocks.defaultModelChain = capabilities().modelChain;
  });
  async function openCapabilities() {
    const entry = screen.queryByRole('button', { name: 'bots.capabilities.title' });
    if (entry) await act(async () => { fireEvent.click(entry); });
    const details = screen.getByTestId('bot-capability-editor') as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event('toggle'));
    });
  }
  const cases = [
    { name: 'release-check', selected: { skills: ['release-check'], capabilities: capabilities({ skillMode: 'allowlist' }) }, empty: { skills: [], capabilities: capabilities({ skillMode: 'allowlist' }) }, patch: { skills: [], capabilityBaseline: { skills: ['release-check'] } }, addPatch: { skills: ['release-check'], capabilityBaseline: { skills: [] } } },
    { name: 'Shared Docs', selected: { capabilities: capabilities({ mcpMode: 'allowlist', mcpServers: ['shared-docs'] }) }, empty: { capabilities: capabilities({ mcpMode: 'allowlist' }) }, patch: { capabilities: { mcpServers: [] }, capabilityBaseline: { mcpServers: ['shared-docs'] } }, addPatch: { capabilities: { mcpServers: ['shared-docs'] }, capabilityBaseline: { mcpServers: [] } } },
    { name: 'Documents', selected: { capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['docs'] }) }, empty: { capabilities: capabilities({ toolsetMode: 'allowlist' }) }, patch: { capabilities: { toolsets: [] }, capabilityBaseline: { toolsets: ['docs'] } }, addPatch: { capabilities: { toolsets: ['docs'] }, capabilityBaseline: { toolsets: [] } } },
  ];

  function sseCatalog(agentKind: 'claude-code' | 'codex'): CustomMcpListResult {
    return { agentKind, servers: [{ id: 'events', name: 'SSE Events', transport: 'sse', url: 'https://example.com/mcp', headers: {}, available: agentKind !== 'codex' }] };
  }

  it('saves the explicit restriction mode when an inherited tool is turned off', async () => {
    renderSettings({ capabilities: capabilities({ toolsetMode: 'inherit', toolsets: [] }) });
    await openCapabilities();
    expect(screen.getByRole('switch', { name: 'Documents' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('switch', { name: 'Documents' }));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenCalledWith('bot-1', {
      capabilities: { toolsetMode: 'allowlist', toolsets: ['browser'] },
      capabilityBaseline: { toolsets: [] },
    }));
    expect(screen.getByRole('switch', { name: 'Browser' }).getAttribute('aria-checked')).toBe('true');
  });

  it.each(['provider', 'runtime', 'global chain'] as const)(
    'refreshes capability availability with the displayed default after %s changes', async (source) => {
      mocks.listCustomMcpServers.mockImplementation(async (context) =>
        sseCatalog(context?.modelChain?.[0]?.harness === 'codex' ? 'codex' : 'claude-code'));
      const view = renderSettings();
      await openCapabilities();
      expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
      const publish = () => {
        if (source === 'provider') {
          commitProvidersSnapshot(beginProvidersRefresh(), {
            dataOwnerId: null, ownerGeneration: 0, providers: [], providerOrder: [],
          });
        } else if (source === 'runtime') {
          mocks.availableVendors = new Set(mocks.defaultModelChain.map((route) => route.harness === 'claude' ? 'cc' : route.harness));
          for (const listener of mocks.runtimeListeners) listener();
        } else {
          for (const listener of mocks.modelListeners) listener();
        }
      };
      const next = [{ ...capabilities().modelChain[0]!, harness: 'codex' as const, model: 'next-default' }];
      await act(async () => { mocks.defaultModelChain = next; publish(); });
      expect(within(screen.getByTestId('bot-primary-model-controls')).getByTestId('current-model').textContent).toBe('next-default');
      expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ modelChain: next }));
      expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
      expect(mocks.listToolsets).toHaveBeenLastCalledWith('/bot/workspace', true, expect.objectContaining({ agentKind: 'codex' }));
      expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
      await act(async () => { mocks.defaultModelChain = capabilities().modelChain; publish(); });
      expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
      view.unmount();
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    },
  );

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  it('uses the effective canonical fallback for every catalog despite a Claude primary', async () => {
    mocks.getSession.mockResolvedValue({ agentKind: 'cc', workingDir: '/bot/workspace', runtimeEffective: { agentKind: 'codex', model: 'codex-x', providerId: null, effort: 'medium', fastMode: false } });
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('codex'));
    renderSettings();
    await openCapabilities();
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ agentKind: 'codex', botSessionId: 'bot-1-chat', modelChain: capabilities().modelChain }));
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
    expect(mocks.listToolsets).toHaveBeenLastCalledWith('/bot/workspace', true, expect.objectContaining({ agentKind: 'codex' }));
    expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('refreshes an open panel on pending fallback and ignores unrelated session pushes', async () => {
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('claude-code'));
    renderSettings();
    await openCapabilities();
    expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
    const patched = mocks.onSessionPatched.mock.calls[0]![0];
    await act(async () => {
      patched({ sessionId: 'other', patch: { agentKind: 'codex' } });
      patched({ sessionId: 'bot-1-chat', patch: { totalCostUsd: 1 } });
    });
    expect(mocks.listCustomMcpServers).toHaveBeenCalledTimes(1);
    const pending = { generation: 2, source: 'fallback' as const, profile: { agentKind: 'codex' as const, model: 'codex-x', providerId: null, effort: 'medium' as const, fastMode: false } };
    mocks.getSession.mockResolvedValue({ agentKind: 'cc', workingDir: '/bot/workspace', runtimePending: pending });
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('codex'));
    await act(async () => { patched({ sessionId: 'bot-1-chat', patch: { runtimePending: pending } }); });
    expect(mocks.listCustomMcpServers).toHaveBeenCalledTimes(2);
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ agentKind: 'codex' }));
    expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it.each(['deleted', 'unavailable'] as const)('refreshes MCP %s while open and preserves removal of selected references', async (change) => {
    const off = vi.fn();
    mocks.onMcpChanged.mockReturnValue(off);
    renderSettings({ capabilities: capabilities({ mcpMode: 'allowlist', mcpServers: ['events'] }) });
    expect(mocks.onMcpChanged).not.toHaveBeenCalled();
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('claude-code'));
    await openCapabilities();
    expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(true);
    let finishRefresh!: (result: CustomMcpListResult) => void;
    mocks.listCustomMcpServers.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    await act(async () => { mocks.onMcpChanged.mock.calls[0]![0](); });
    // The old available catalog is invalidated immediately, while the selected ref stays removable.
    expect((screen.getByRole('switch', { name: /events/ }) as HTMLInputElement).disabled).toBe(false);
    await act(async () => { finishRefresh(change === 'deleted' ? { agentKind: 'claude-code', servers: [] }
      : { ...sseCatalog('claude-code'), servers: sseCatalog('claude-code').servers.map((entry) => ({ ...entry, available: false })) }); });
    const checkbox = screen.getByRole('switch', { name: change === 'deleted' ? /events/ : /SSE Events/ }) as HTMLInputElement;
    expect(checkbox.getAttribute('aria-checked') === 'true').toBe(true);
    expect(checkbox.disabled).toBe(false);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { capabilities: { mcpServers: [] }, capabilityBaseline: { mcpServers: ['events'] } }));
    if (change === 'unavailable') expect(checkbox.disabled).toBe(true);
    else expect(screen.queryByRole('switch', { name: /events/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' })); });
    expect(screen.queryByTestId('bot-capability-editor')).toBeNull();
    expect(off).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'ssh-host'])('reloads installed and deleted Codex Skills on reopen for target %s', async (remoteHostId) => {
    let disk = ['old-skill'];
    let cached = [...disk];
    mocks.getSession.mockResolvedValue({ agentKind: 'codex', workingDir: '/bot/workspace', remoteHostId });
    mocks.listCustomMcpServers.mockResolvedValue({ agentKind: 'codex', servers: [] });
    mocks.listAgentSkills.mockImplementation(async (_kind, options) => {
      if (options?.forceReload) cached = [...disk];
      return { success: true, skills: cached.map((name) => ({ name })) };
    });
    renderSettings();
    await openCapabilities();
    expect(screen.getByRole('switch', { name: 'old-skill' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' })); });
    expect(screen.queryByTestId('bot-capability-editor')).toBeNull();
    disk = ['new-skill'];
    await openCapabilities();
    expect(screen.queryByRole('switch', { name: 'old-skill' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'new-skill' })).toBeTruthy();
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', {
      forceReload: true, workingDir: '/bot/workspace', remoteHostId,
    });
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it('invalidates selectable MCPs immediately and ignores an outdated refresh after another change', async () => {
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('claude-code'));
    const off = vi.fn();
    mocks.onMcpChanged.mockReturnValue(off);
    const view = renderSettings();
    await openCapabilities();
    expect((screen.getByRole('switch', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
    let finishOld!: (result: CustomMcpListResult) => void;
    mocks.listCustomMcpServers.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ agentKind: 'claude-code', servers: [] });
    await act(async () => { mocks.onMcpChanged.mock.calls[0]![0](); });
    expect(screen.queryByRole('switch', { name: /SSE Events/ })).toBeNull();
    await act(async () => { mocks.onMcpChanged.mock.calls[0]![0](); });
    expect(mocks.listCustomMcpServers).toHaveBeenCalledTimes(3);
    await act(async () => { finishOld(sseCatalog('claude-code')); });
    expect(screen.queryByRole('switch', { name: /SSE Events/ })).toBeNull();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    view.unmount();
    expect(off).toHaveBeenCalledOnce();
  });

  // 2026-11-26 decision: the buddy drawer no longer edits the model (it is managed in Settings > model groups); the editing test(s) here were removed.

  it('refreshes when the followed default model chain changes without reopening the panel', async () => {
    renderSettings();
    await openCapabilities();
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({
      modelChain: capabilities().modelChain,
    }));
    const chain = [{ ...capabilities().modelChain[0]!, harness: 'pi' as const, model: 'pi-x' }];
    mocks.defaultModelChain = chain;
    await act(async () => { mocks.modelListeners.forEach((listener) => listener()); });
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ modelChain: chain }));
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('pi', expect.anything());
  });

  it.each(['claude', 'codex', 'pi'] as const)('uses the %s runtime catalog and keeps unavailable MCP references removable', async (harness) => {
    vi.useFakeTimers();
    const chain = [{ ...capabilities().modelChain[0]!, harness }];
    const profile = capabilities({ harness, modelChain: chain, modelChainOverride: chain, mcpMode: 'allowlist' });
    const view = renderSettings({ capabilities: profile });
    await openCapabilities();
    expect(mocks.listCustomMcpServers).toHaveBeenCalledWith({ agentKind: 'claude-code', botSessionId: 'bot-1-chat', modelChain: profile.modelChain });
    const unavailable = screen.getByRole('switch', { name: /Legacy MCP/ }) as HTMLInputElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute('aria-checked') === 'true').toBe(false);
    unavailable.click();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    expect((screen.getByRole('switch', { name: 'Shared Docs' }) as HTMLInputElement).disabled).toBe(false);

    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: { ...profile, mcpServers: ['bad-headers'] } })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect(unavailable.disabled).toBe(false);
    expect(unavailable.getAttribute('aria-checked') === 'true').toBe(true);
    fireEvent.click(unavailable);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { capabilities: { mcpServers: [] }, capabilityBaseline: { mcpServers: ['bad-headers'] } });
    expect(unavailable.disabled).toBe(true);
  });

  it.each(cases)('can remove externally joined $name and add it back after external removal', async ({ name, selected, empty, patch, addPatch }) => {
    vi.useFakeTimers();
    const view = renderSettings(empty);
    await openCapabilities();
    const rerender = (profile: Partial<BotProfile>) => view.rerender(
      <BotSettings bot={bot(profile)} onBack={view.onBack} onOpenSession={view.onOpenSession} />,
    );
    rerender({ ...selected, currentVersion: 2 });
    expect((screen.getByRole('switch', { name }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(true);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', patch);
    // Restore externally, then remove externally: re-adding must also be dirty.
    rerender({ ...selected, currentVersion: 3 });
    rerender({ ...empty, currentVersion: 4 });
    expect((screen.getByRole('switch', { name }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(false);
    fireEvent.click(screen.getByRole('switch', { name }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', addPatch);
    expect((screen.getByRole('switch', { name }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(true);
  });

  it('preserves pending text and per-item choices while incorporating external additions', async () => {
    vi.useFakeTimers();
    const view = renderSettings({ capabilities: capabilities({ toolsetMode: 'allowlist' }) });
    await openCapabilities();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Local name' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Browser' }));
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['docs'] }) })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Local name');
    expect((screen.getByRole('switch', { name: 'Documents' }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(true);
    expect((screen.getByRole('switch', { name: 'Browser' }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { name: 'Local name', capabilities: { toolsets: ['docs', 'browser'] }, capabilityBaseline: { toolsets: ['docs'] } });
  });

  it('explains a rename that collides with another teammate instead of a generic save failure', async () => {
    mocks.profiles = [bot(), bot({ id: 'bot-2', name: 'Ｒｅｌｅａｓｅ Buddy' })];
    renderSettings();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: ' release buddy ' } });
    expect(screen.getByRole('alert').textContent).toBe('bots.guided.duplicateName');
    expect(screen.queryByText('bots.autosave.retry')).toBeNull();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Release buddy 2' } });
    expect(screen.queryByText('bots.guided.duplicateName')).toBeNull();
  });

  it('keeps a trailing line break typed before the debounced save lands', async () => {
    vi.useFakeTimers();
    const view = renderSettings();
    fireEvent.change(screen.getByLabelText('bots.profile.summary'), { target: { value: 'Own releases\n' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { description: 'Own releases' });
    // The host stores the trimmed text; the field must not snap the caret back a line.
    view.rerender(<BotSettings bot={bot({ description: 'Own releases' })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    await act(async () => {});
    expect((screen.getByLabelText('bots.profile.summary') as HTMLTextAreaElement).value).toBe('Own releases\n');
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(mocks.updateBotProfile).toHaveBeenCalledOnce();
  });

  it('keeps edits made during a successful save and adopts concurrent capability updates', async () => {
    vi.useFakeTimers();
    let finishSave!: (value: { id: string; currentVersion: number; name: string }) => void;
    mocks.updateBotProfile.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const view = renderSettings();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'First name' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    view.rerender(<BotSettings bot={bot({ name: 'First name' })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Second name' } });
    view.rerender(<BotSettings bot={bot({ name: 'First name', currentVersion: 3, skills: ['release-check'] })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    await act(async () => { finishSave({ id: 'bot-1', currentVersion: 2, name: 'First name' }); });
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Second name');
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { name: 'Second name' });
    await openCapabilities();
    expect((screen.getByRole('switch', { name: /release-check/ }) as HTMLButtonElement).getAttribute('aria-checked') === 'true').toBe(true);
  });

  it('keeps a failed optimistic edit dirty and retries it after a profile rollback', async () => {
    vi.useFakeTimers();
    let rejectSave!: (error: Error) => void;
    mocks.updateBotProfile.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const view = renderSettings();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Local name' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    view.rerender(<BotSettings bot={bot({ name: 'Local name' })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Newer local name' } });
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, skills: ['release-check'] })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    await act(async () => { rejectSave(new Error('save failed')); });
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Newer local name');
    fireEvent.click(screen.getByRole('button', { name: 'bots.autosave.retry' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { name: 'Newer local name' });
  });

  it('uses host availability and still allows removing a joined unavailable toolset', async () => {
    const view = renderSettings();
    await openCapabilities();
    expect((screen.getByRole('switch', { name: /Contacts/ }) as HTMLInputElement).disabled).toBe(true);
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['contacts'] }) })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect((screen.getByRole('switch', { name: /Contacts/ }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: /Contacts/ }));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { capabilities: { toolsets: [] }, capabilityBaseline: { toolsets: ['contacts'] } }));
  });
});

it('opens voice settings from the companion settings list and supports the dedicated entry page', async () => {
  const companion = { ...bot(), canonicalSessionId: 'canonical-voice' };
  const view = render(<BotSettings bot={companion} onBack={vi.fn()} onOpenSession={vi.fn()} />, { wrapper: ConfirmDialogProvider });
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.settingsTitle' }));
  expect(screen.getByTestId('companion-voice-settings').textContent).toBe(`${companion.id}:canonical-voice`);
  fireEvent.click(screen.getByRole('button', { name: 'bots.settingsBack' }));
  await waitFor(() => expect(screen.queryByTestId('companion-voice-settings')).toBeNull());
  expect(screen.getByRole('button', { name: 'bots.voiceMode.settingsTitle' })).toBe(document.activeElement);
  view.unmount();
  render(<BotSettings bot={companion} initialPage="voice" onBack={vi.fn()} onOpenSession={vi.fn()} />, { wrapper: ConfirmDialogProvider });
  expect(screen.getByTestId('companion-voice-settings')).toBeTruthy();
});
