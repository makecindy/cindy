// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotModelRoute, BotProfile } from '../botStore';
import type { CustomMcpListContext, CustomMcpListResult } from '../../../../shared/customMcp';
import { beginProvidersRefresh, commitProvidersSnapshot } from '@/lib/providersSnapshotStore';

vi.mock('@/state/modelVisibilityPrefs', () => ({ migrateModelVisibilityDefaults: vi.fn() }));

vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: mocks.onboarding }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => <div data-testid="connect-provider-card" />,
}));

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => {
  const sessionGet = vi.fn();
  return {
  navigate: vi.fn(),
  onboarding: false,
  readSession: sessionGet,
  initialSearch: '' as string,
  listCustomMcpServers: vi.fn<(context?: CustomMcpListContext) => Promise<CustomMcpListResult>>(),
  getSession: sessionGet,
  onSessionPatched: vi.fn(),
  onMcpChanged: vi.fn(),
  listAgentSkills: vi.fn(),
  listToolsets: vi.fn(),
  profiles: [] as BotProfile[],
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
  chooseBotAvatar: mocks.chooseBotAvatar,
  setCanonicalBotSession: vi.fn(),
  useBotProfiles: () => mocks.profiles,
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
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({ unifiedAgents, onUnifiedSelect, modelId, onEffortChange, onNavigateToProviders }: {
    onNavigateToProviders?: () => void;
    modelId: string;
    onEffortChange: (effort: string) => void;
    unifiedAgents: string[];
    onUnifiedSelect: (selection: unknown) => void;
  }) => <>{onNavigateToProviders && <button type="button" onClick={onNavigateToProviders}>connect-source</button>}<button data-testid="current-model" onClick={() => onEffortChange('high')}>{modelId}</button>{(['pi', 'codex'] as const).filter((engine) => unifiedAgents.includes(engine)).map((engine) => (
    <button key={engine} data-testid={engine === 'pi' ? 'model-selector' : 'codex-model-selector'} onClick={() => onUnifiedSelect({ engine, providerId: 'custom', modelId: 'custom-model', effort: 'high', fast: false })}>select-{engine}-model</button>
  ))}</>,
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

import { BotsHomeView, BotSettings } from '../BotsHomeView';

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
  const view = render(
    <BotSettings bot={bot(overrides)} onBack={onBack} onOpenSession={onOpenSession} />,
  );
  return { ...view, onBack, onOpenSession };
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.onboarding = false;
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
  mocks.params = {};
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
    { id: 'scheduler', name: 'Scheduler', effectiveEnabled: true, available: true },
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
    localDb: { sessionsPush: { onPatched: mocks.onSessionPatched } },
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

describe('Bot settings profile consolidation', () => {
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
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByText('bots.settingsTabs.growth')).toBeNull();
    expect(screen.queryByText('bots.persona.adjustButton')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a long description inside the single editable field', () => {
    const long = 'x'.repeat(500);
    renderSettings({ description: long });
    const summary = screen.getByLabelText('bots.profile.summary') as HTMLTextAreaElement;
    expect(summary.value).toBe(long);
    expect(summary.tagName).toBe('TEXTAREA');
  });

  it('opens the managed advanced folder without exposing a second editor', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.open' }));
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/managed/bots/bot-1'));
  });

  it('shows the open-folder failure in place', async () => {
    mocks.openPath.mockResolvedValue({ success: false, error: 'missing' });
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.open' }));
    expect((await screen.findByRole('alert')).textContent).toContain('missing');
  });

  it('ignores retired tab deep links and keeps every setting on the same page', () => {
    renderSettings({}, 'settings=1&tab=growth');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
  });

  it('does not duplicate the chat action inside the settings panel', () => {
    renderSettings();
    expect(screen.queryByRole('button', { name: 'bots.actions.message' })).toBeNull();
  });

  it('shows structured communication-style controls on the same page', () => {
    renderSettings();
    expect(screen.getByTestId('bot-communication-style')).toBeTruthy();
    expect(screen.getByLabelText('bots.profile.style.tone')).toBeTruthy();
    expect(screen.getByLabelText('bots.profile.style.replyLength')).toBeTruthy();
  });

  it('associates communication-style hints with their controls', () => {
    renderSettings();
    const banned = screen.getByLabelText('bots.profile.style.bannedPhrases');
    const bannedHintId = banned.getAttribute('aria-describedby');
    expect(bannedHintId).toBeTruthy();
    expect(document.getElementById(bannedHintId!)?.textContent).toBe(
      'bots.profile.style.bannedPhrasesHint',
    );
    const tone = screen.getByLabelText('bots.profile.style.tone');
    const toneHintId = tone.getAttribute('aria-describedby');
    expect(toneHintId).toBeTruthy();
    expect(document.getElementById(toneHintId!)?.textContent).toBe('bots.profile.style.toneHint');
  });

  it('keeps archived teammates read-only', () => {
    renderSettings({ status: 'archived' });
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByLabelText('bots.nameLabel')).toBeNull();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });
});

describe('Bot settings unified autosave', () => {
  it('clears an override with no default route and follows defaults when they recover', async () => {
    vi.useFakeTimers();
    const route = capabilities().modelChain[0]!;
    const view = renderSettings({ capabilities: capabilities({ modelChainOverride: [route] }) });
    const details = view.container.querySelector('[data-testid="bot-model-chain-editor"] details')!;
    (details as HTMLDetailsElement).open = true;
    fireEvent(details, new Event('toggle'));
    fireEvent.click(screen.getByText('bots.model.restoreDefault'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(mocks.updateBotProfile.mock.lastCall?.[1]).toMatchObject({
      capabilities: { modelChainOverride: null, modelChain: [], model: '' },
    });
    const saves = mocks.updateBotProfile.mock.calls.length;
    act(() => {
      mocks.defaultModelChain = [{ ...route, model: 'recovered-model' }];
      for (const listener of mocks.modelListeners) listener();
    });
    expect(screen.getAllByTestId('current-model')[0]?.textContent).toBe('recovered-model');
    view.unmount();
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(saves);
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
      expect(screen.getByTestId('current-model').textContent).toBe('new-default');
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Pending name' } });
      fireEvent.click(screen.getByTestId('current-model'));
      act(() => {
        mocks.defaultModelChain = [{ ...nextRoute, model: 'later-default' }];
        for (const listener of mocks.modelListeners) listener();
      });
      expect(screen.getByTestId('current-model').textContent).toBe('new-default');
      expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Pending name');
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(mocks.updateBotProfile.mock.lastCall?.[1]).toMatchObject({
        name: 'Pending name',
        capabilities: { modelChainOverride: [{ ...nextRoute, effort: 'high' }] },
      });
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

  it('autosaves a discrete tone selection with the rest of the profile', async () => {
    vi.useFakeTimers();
    renderSettings();
    fireEvent.click(screen.getByRole('radio', { name: 'bots.profile.style.tones.warm' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      style: { tone: 'warm' },
    });
  });

  it('keeps trailing spaces while typing style text and trims on blur', async () => {
    vi.useFakeTimers();
    const view = renderSettings();
    const address = screen.getByLabelText('bots.profile.style.addressUserAs') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'Chris ' } });
    expect(address.value).toBe('Chris ');
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      style: { addressUserAs: 'Chris' },
    });
    expect(address.value).toBe('Chris ');
    // Production updateBotProfile publishes the normalized bot; the echo must
    // not trim the still-focused draft before blur.
    await act(async () => {
      view.rerender(
        <BotSettings
          bot={bot({ style: { addressUserAs: 'Chris' } })}
          onBack={view.onBack}
          onOpenSession={view.onOpenSession}
        />,
      );
    });
    expect(address.value).toBe('Chris ');
    fireEvent.blur(address);
    expect(address.value).toBe('Chris');

    const habits = screen.getByLabelText('bots.profile.style.languageHabits') as HTMLTextAreaElement;
    fireEvent.change(habits, { target: { value: '先结论\n后解释\n' } });
    expect(habits.value).toBe('先结论\n后解释\n');
  });

  it('clears discrete style fields when the user picks follow-default', async () => {
    vi.useFakeTimers();
    renderSettings({
      style: { tone: 'warm', replyLength: 'short', emojiDensity: 'sparse' },
    });
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'bots.profile.style.tone' })).getByRole('radio', {
        name: 'bots.profile.style.tones.followDefault',
      }),
    );
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'bots.profile.style.replyLength' })).getByRole('radio', {
        name: 'bots.profile.style.replyLengths.followDefault',
      }),
    );
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'bots.profile.style.emojiDensity' })).getByRole('radio', {
        name: 'bots.profile.style.emojiDensities.followDefault',
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const lastPatch = mocks.updateBotProfile.mock.calls.at(-1)?.[1] as {
      style?: unknown;
      styleBaseline?: unknown;
    };
    expect(lastPatch.style).toBeNull();
    expect(lastPatch).not.toHaveProperty('styleBaseline');
  });

  it('clears every style field with the group restore-default action', async () => {
    vi.useFakeTimers();
    renderSettings({
      style: {
        tone: 'custom',
        customTone: '像老朋友',
        addressUserAs: 'Chris',
        selfName: '小满',
        replyLength: 'short',
        emojiDensity: 'sparse',
        bannedPhrases: '亲爱的',
        languageHabits: '先结论',
      },
    });
    expect(screen.getByLabelText('bots.profile.style.customTone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.style.restoreDefault' }));
    expect(screen.queryByLabelText('bots.profile.style.customTone')).toBeNull();
    expect((screen.getByLabelText('bots.profile.style.addressUserAs') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('bots.profile.style.selfName') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('bots.profile.style.bannedPhrases') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('bots.profile.style.languageHabits') as HTMLTextAreaElement).value).toBe('');
    expect(
      within(screen.getByRole('radiogroup', { name: 'bots.profile.style.tone' }))
        .getByRole('radio', { name: 'bots.profile.style.tones.followDefault' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      within(screen.getByRole('radiogroup', { name: 'bots.profile.style.replyLength' }))
        .getByRole('radio', { name: 'bots.profile.style.replyLengths.followDefault' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      within(screen.getByRole('radiogroup', { name: 'bots.profile.style.emojiDensity' }))
        .getByRole('radio', { name: 'bots.profile.style.emojiDensities.followDefault' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const lastPatch = mocks.updateBotProfile.mock.calls.at(-1)?.[1] as {
      style?: unknown;
      styleBaseline?: unknown;
    };
    expect(lastPatch.style).toBeNull();
    expect(lastPatch).not.toHaveProperty('styleBaseline');
  });

  it('changes the avatar through the host-owned image picker', async () => {
    vi.useFakeTimers();
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(mocks.chooseBotAvatar).toHaveBeenCalledWith('bot-1');
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      `cindy-media://blobs/${'a'.repeat(64)}.png`,
    );
  });

  it('offers one recovery action only for a legacy profile with memory disabled', async () => {
    vi.useFakeTimers();
    renderSettings({ capabilities: capabilities({ memory: false }) });
    fireEvent.click(screen.getByRole('button', { name: 'bots.memoryRecovery.action' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ memory: true }),
    });
  });
});


describe('same-Bot capability updates while editing settings', () => {
  beforeEach(() => {
    mocks.defaultModelChain = capabilities().modelChain;
  });
  async function openCapabilities() {
    const details = screen.getByText('bots.capabilities.title').parentElement as HTMLDetailsElement;
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

  it.each(['provider', 'runtime', 'global chain'] as const)(
    'refreshes capability availability with the displayed default after %s changes', async (source) => {
      mocks.listCustomMcpServers.mockImplementation(async (context) =>
        sseCatalog(context?.modelChain?.[0]?.harness === 'codex' ? 'codex' : 'claude-code'));
      const view = renderSettings();
      await openCapabilities();
      expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
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
      expect(screen.getByTestId('current-model').textContent).toBe('next-default');
      expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ modelChain: next }));
      expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
      expect(mocks.listToolsets).toHaveBeenLastCalledWith('/bot/workspace', true, expect.objectContaining({ agentKind: 'codex' }));
      expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
      await act(async () => { mocks.defaultModelChain = capabilities().modelChain; publish(); });
      expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
      view.unmount();
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    },
  );

  it('keeps a local model override and pending text when defaults change during catalog loading', async () => {
    let finishOld!: (value: CustomMcpListResult) => void;
    mocks.listCustomMcpServers.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(sseCatalog('codex'));
    mocks.updateBotProfile.mockImplementation(() => new Promise(() => {}));
    renderSettings();
    await openCapabilities();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Pending name' } });
    await act(async () => { fireEvent.click(screen.getByTestId('codex-model-selector')); });
    const calls = mocks.listCustomMcpServers.mock.calls.length;
    await act(async () => {
      mocks.defaultModelChain = [{ ...capabilities().modelChain[0]!, model: 'later-default' }];
      for (const listener of mocks.modelListeners) listener();
      finishOld(sseCatalog('claude-code'));
    });
    expect(mocks.listCustomMcpServers).toHaveBeenCalledTimes(calls);
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ modelChain: [expect.objectContaining({ harness: 'codex', model: 'custom-model' })] }));
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Pending name');
  });

  it('uses the effective canonical fallback for every catalog despite a Claude primary', async () => {
    mocks.getSession.mockResolvedValue({ agentKind: 'cc', workingDir: '/bot/workspace', runtimeEffective: { agentKind: 'codex', model: 'codex-x', providerId: null, effort: 'medium', fastMode: false } });
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('codex'));
    renderSettings();
    await openCapabilities();
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ agentKind: 'codex', botSessionId: 'bot-1-chat', modelChain: capabilities().modelChain }));
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
    expect(mocks.listToolsets).toHaveBeenLastCalledWith('/bot/workspace', true, expect.objectContaining({ agentKind: 'codex' }));
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('refreshes an open panel on pending fallback and ignores unrelated session pushes', async () => {
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('claude-code'));
    renderSettings();
    await openCapabilities();
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
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
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it.each(['deleted', 'unavailable'] as const)('refreshes MCP %s while open and preserves removal of selected references', async (change) => {
    const off = vi.fn();
    mocks.onMcpChanged.mockReturnValue(off);
    renderSettings({ capabilities: capabilities({ mcpMode: 'allowlist', mcpServers: ['events'] }) });
    expect(mocks.onMcpChanged).not.toHaveBeenCalled();
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('claude-code'));
    await openCapabilities();
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).checked).toBe(true);
    let finishRefresh!: (result: CustomMcpListResult) => void;
    mocks.listCustomMcpServers.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    await act(async () => { mocks.onMcpChanged.mock.calls[0]![0](); });
    // The old available catalog is invalidated immediately, while the selected ref stays removable.
    expect((screen.getByRole('checkbox', { name: /events/ }) as HTMLInputElement).disabled).toBe(false);
    await act(async () => { finishRefresh(change === 'deleted' ? { agentKind: 'claude-code', servers: [] }
      : { ...sseCatalog('claude-code'), servers: sseCatalog('claude-code').servers.map((entry) => ({ ...entry, available: false })) }); });
    const checkbox = screen.getByRole('checkbox', { name: change === 'deleted' ? /events/ : /SSE Events/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { capabilities: { mcpServers: [] }, capabilityBaseline: { mcpServers: ['events'] } }));
    if (change === 'unavailable') expect(checkbox.disabled).toBe(true);
    else expect(screen.queryByRole('checkbox', { name: /events/ })).toBeNull();
    const details = screen.getByText('bots.capabilities.title').parentElement as HTMLDetailsElement;
    await act(async () => { details.open = false; fireEvent(details, new Event('toggle')); });
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
    expect(screen.getByRole('checkbox', { name: 'old-skill' })).toBeTruthy();
    const details = screen.getByText('bots.capabilities.title').parentElement as HTMLDetailsElement;
    await act(async () => { details.open = false; fireEvent(details, new Event('toggle')); });
    disk = ['new-skill'];
    await openCapabilities();
    expect(screen.queryByRole('checkbox', { name: 'old-skill' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'new-skill' })).toBeTruthy();
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
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
    let finishOld!: (result: CustomMcpListResult) => void;
    mocks.listCustomMcpServers.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ agentKind: 'claude-code', servers: [] });
    await act(async () => { mocks.onMcpChanged.mock.calls[0]![0](); });
    expect(screen.queryByRole('checkbox', { name: /SSE Events/ })).toBeNull();
    await act(async () => { mocks.onMcpChanged.mock.calls[0]![0](); });
    expect(mocks.listCustomMcpServers).toHaveBeenCalledTimes(3);
    await act(async () => { finishOld(sseCatalog('claude-code')); });
    expect(screen.queryByRole('checkbox', { name: /SSE Events/ })).toBeNull();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    view.unmount();
    expect(off).toHaveBeenCalledOnce();
  });

  it('refreshes on a local model-chain edit and discards the preceding catalog response', async () => {
    let finishOld!: (value: CustomMcpListResult) => void;
    mocks.listCustomMcpServers.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(sseCatalog('codex'));
    mocks.updateBotProfile.mockImplementationOnce(() => new Promise(() => {}));
    renderSettings();
    await openCapabilities();
    await act(async () => { fireEvent.click(screen.getByTestId('codex-model-selector')); });
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ modelChain: [expect.objectContaining({ harness: 'codex' })] }));
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => { finishOld(sseCatalog('claude-code')); });
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
    expect(mocks.listAgentSkills).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
  });

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
    const unavailable = screen.getByRole('checkbox', { name: /Legacy MCP/ }) as HTMLInputElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.checked).toBe(false);
    unavailable.click();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox', { name: 'Shared Docs' }) as HTMLInputElement).disabled).toBe(false);

    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: { ...profile, mcpServers: ['bad-headers'] } })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect(unavailable.disabled).toBe(false);
    expect(unavailable.checked).toBe(true);
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
    expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', patch);
    // Restore externally, then remove externally: re-adding must also be dirty.
    rerender({ ...selected, currentVersion: 3 });
    rerender({ ...empty, currentVersion: 4 });
    expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', addPatch);
    expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true);
  });

  it('preserves pending text and per-item choices while incorporating external additions', async () => {
    vi.useFakeTimers();
    const view = renderSettings({ capabilities: capabilities({ toolsetMode: 'allowlist' }) });
    await openCapabilities();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Local name' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Scheduler' }));
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['docs'] }) })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Local name');
    expect((screen.getByRole('checkbox', { name: 'Documents' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Scheduler' }) as HTMLInputElement).checked).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { name: 'Local name', capabilities: { toolsets: ['docs', 'scheduler'] }, capabilityBaseline: { toolsets: ['docs'] } });
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
    expect((screen.getByRole('checkbox', { name: /release-check/ }) as HTMLInputElement).checked).toBe(true);
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
    expect((screen.getByRole('checkbox', { name: /Contacts/ }) as HTMLInputElement).disabled).toBe(true);
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['contacts'] }) })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect((screen.getByRole('checkbox', { name: /Contacts/ }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Contacts/ }));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { capabilities: { toolsets: [] }, capabilityBaseline: { toolsets: ['contacts'] } }));
  });
});
