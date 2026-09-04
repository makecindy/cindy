// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotProfile } from '../botStore';

Element.prototype.scrollTo = vi.fn();

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  initialSearch: '' as string,
  updateBotProfile: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  })),
  openPath: vi.fn(
    async (): Promise<{ success: boolean; error?: string }> => ({ success: true }),
  ),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const { useCallback, useState } = await import('react');
  return {
    ...actual,
    useParams: () => ({}),
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
  setCanonicalBotSession: vi.fn(),
  useBotProfiles: () => [],
  getEffectiveBotModelChain: () => [
    { harness: 'claude', model: 'claude-x', providerId: null, effort: 'medium', fastMode: false },
  ],
}));
vi.mock('../BotLifecycleSettings', () => ({
  BotLifecycleSettings: () => <div data-testid="bot-lifecycle-settings" />,
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock('@/hooks/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ availableVendors: new Set(['cc', 'codex', 'pi']), loaded: true }),
}));
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

import { BotSettings } from '../BotsHomeView';

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
    channel: 'local',
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
        channel: 'local',
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

function openTab(tab: 'profile' | 'model' | 'maintenance') {
  fireEvent.click(screen.getByRole('tab', { name: `bots.settingsTabs.${tab}` }));
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.updateBotProfile.mockReset();
  mocks.updateBotProfile.mockImplementation(async (_id, patch) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  }));
  mocks.openPath.mockReset();
  mocks.openPath.mockResolvedValue({ success: true });
  mocks.initialSearch = '';
  (window as unknown as { electronAPI: unknown }).electronAPI = { openPath: mocks.openPath };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Bot settings profile consolidation', () => {
  it('shows one inline basic-information editor and no legacy profile/persona/growth editors', () => {
    renderSettings();

    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(
      screen.getByRole('tab', { name: 'bots.settingsTabs.profile' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
    expect(screen.getByLabelText('bots.profile.summary')).toBeTruthy();
    expect(screen.getByText('bots.profile.avatar')).toBeTruthy();
    expect(screen.getByText('bots.homeFolder.title')).toBeTruthy();
    expect(screen.queryByText('bots.settingsTabs.growth')).toBeNull();
    expect(screen.queryByText('bots.persona.adjustButton')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the summary column bounded even with long unbroken text', () => {
    const long = 'x'.repeat(500);
    renderSettings({ description: long });
    const summary = screen.getAllByText(long).find((item) => item.tagName === 'P');
    expect(summary?.className).toContain('[overflow-wrap:anywhere]');
    expect(summary?.className).toContain('max-w-full');
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

  it('maps retired growth and identity deep links to basic information', () => {
    renderSettings({}, 'settings=1&tab=growth');
    expect(
      screen.getByRole('tab', { name: 'bots.settingsTabs.profile' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
  });

  it('keeps model and maintenance as separate focused tabs', () => {
    renderSettings();
    openTab('model');
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.queryByLabelText('bots.nameLabel')).toBeNull();
    openTab('maintenance');
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByTestId('model-selector')).toBeNull();
  });

  it('opens the canonical task from the Message action', () => {
    const { onOpenSession } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.actions.message' }));
    expect(onOpenSession).toHaveBeenCalledWith('bot-1-chat');
  });

  it('keeps archived teammates read-only', () => {
    renderSettings({ status: 'archived' });
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByLabelText('bots.nameLabel')).toBeNull();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });
});

describe('Bot settings unified autosave', () => {
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

  it('saves avatar and hue changes through the same profile channel', async () => {
    vi.useFakeTimers();
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.chooseAvatar:{"avatar":"🤖"}' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({ avatar: '🤖' });

    fireEvent.click(
      screen.getByRole('button', { name: 'bots.chooseAvatarColor:{"color":"teal"}' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.updateBotProfile.mock.calls.at(-1)?.[1]).toMatchObject({
      avatar: '🤖',
      avatarColor: 'teal',
    });
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
