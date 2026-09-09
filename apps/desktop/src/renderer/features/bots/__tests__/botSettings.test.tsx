// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotModelRoute, BotProfile } from '../botStore';
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

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  onboarding: false,
  readSession: vi.fn(),
  initialSearch: '' as string,
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
}));

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
  (window as unknown as { electronAPI: unknown }).electronAPI = { openPath: mocks.openPath };
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
      capabilities: { modelChainOverride: null, modelOverride: null, modelChain: [], model: '' },
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
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      name: 'Release buddy',
      description: 'Own releases',
      identitySource: 'Persistent role',
      userContextSource: 'Call me Chris',
    });
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
