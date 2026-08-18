// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotProfile } from '../botStore';

// jsdom doesn't implement Element.scrollTo (real browsers/Electron do); the
// settings content pane calls it to reset scroll position on tab switch.
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = vi.fn();
}

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  initialSearch: '' as string,
  /** Mirrors whatever the nav last wrote, so tests can assert on the deep-link value. */
  currentSearch: '' as string,
  updateBotProfile: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  })),
}));

// The Bot settings nav owns its own URL state via useSearchParams. A real
// Router is unnecessary here: this stub keeps genuine React state (so the
// functional `setSearchParams((current) => ...)` form used by the nav
// actually re-renders the consumer, same as react-router-dom does) while
// letting each test seed the starting `?settings=1&tab=<id>` deep link and
// read back whatever the nav wrote via `mocks.currentSearch`.
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
        (
          next:
            | URLSearchParams
            | Record<string, string>
            | ((current: URLSearchParams) => URLSearchParams),
        ) => {
          setParams((current) => {
            const resolved = typeof next === 'function' ? next(new URLSearchParams(current)) : next;
            const resolvedParams =
              resolved instanceof URLSearchParams ? resolved : new URLSearchParams(resolved);
            mocks.currentSearch = resolvedParams.toString();
            return resolvedParams;
          });
        },
        [],
      );
      return [params, setSearchParams] as const;
    },
  };
});

vi.mock('../botStore', () => ({
  updateBotProfile: mocks.updateBotProfile,
  listBotChannelConnections: vi.fn(async () => []),
  listBotImMigrations: vi.fn(async () => []),
  planBotImMigration: vi.fn(),
  rollbackBotImMigration: vi.fn(),
  applyBotImMigration: vi.fn(),
  setCanonicalBotSession: vi.fn(),
  upsertBotChannel: vi.fn(),
  exportBotBundle: vi.fn(async () => ({ canceled: true })),
  importBotBundle: vi.fn(async () => ({ canceled: true })),
  useBotProfiles: () => [],
}));
vi.mock('../AddBotDialog', () => ({ AddBotDialog: () => null }));
vi.mock('../BotAvatar', () => ({
  BotAvatar: () => <div data-testid="bot-avatar" />,
  BotAvatarPicker: () => <div data-testid="bot-avatar-picker" />,
}));
vi.mock('../BotCapabilitySettings', () => ({
  BotCapabilitySettings: () => <div data-testid="bot-capability-settings" />,
}));
vi.mock('../BotProjectSettings', () => ({
  BotProjectSettings: () => <div data-testid="bot-project-settings" />,
}));
vi.mock('../BotAutomationSettings', () => ({
  BotAutomationSettings: () => <div data-testid="bot-automation-settings" />,
}));
vi.mock('../BotRouteSettings', () => ({
  BotRouteSettings: () => <div data-testid="bot-route-settings" />,
}));
vi.mock('../BotLifecycleSettings', () => ({
  BotLifecycleSettings: () => <div data-testid="bot-lifecycle-settings" />,
}));
vi.mock('../BotEventInboxSettings', () => ({
  BotEventInboxSettings: () => <div data-testid="bot-event-inbox-settings" />,
}));
vi.mock('../BotChannelCapabilitySummary', () => ({
  BotChannelCapabilitySummary: () => <div data-testid="bot-channel-capability-summary" />,
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock('@/components/new-chat/VendorSegmentedSwitcher', () => ({
  VendorSegmentedSwitcher: () => <div data-testid="vendor-switcher" />,
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
    skillMode: 'inherit',
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    automation: false,
    permissions: 'ask',
    sessionControlMode: 'none',
    ...overrides,
  };
}

function bot(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: 'bot-1',
    name: 'PR steward',
    channel: 'local',
    description: 'Delivery steward',
    identitySource: '',
    userContextSource: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    currentVersion: 1,
    skills: [],
    capabilities: capabilities(),
    canonicalSessionId: 'bot-1-chat',
    createdAt: 0,
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
    channels: [],
    projectBindings: [],
    routes: [],
    ...overrides,
  };
}

function renderSettings(overrides: Partial<BotProfile> = {}, initialSearch = 'settings=1') {
  mocks.initialSearch = initialSearch;
  const onBack = vi.fn();
  const view = render(
    <BotSettings
      bot={bot(overrides)}
      onBack={onBack}
      onRenew={vi.fn(async () => false)}
      onOpenSession={vi.fn()}
      renewing={false}
    />,
  );
  return { ...view, onBack };
}

const defaultUpdateBotProfile = async (_id: string, patch: Record<string, unknown>) => ({
  id: 'bot-1',
  currentVersion: 1,
  ...patch,
});

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.updateBotProfile.mockReset();
  // mockImplementation(Once) in the autosave suite must not leak into other tests.
  mocks.updateBotProfile.mockImplementation(defaultUpdateBotProfile as never);
  mocks.initialSearch = '';
  mocks.currentSearch = '';
});

afterEach(() => {
  cleanup();
});

describe('Bot settings nav grouping', () => {
  it('defaults to the Basic info (identity) tab with no ?tab= param', () => {
    renderSettings();

    expect(
      screen.getByRole('tab', { name: 'bots.settingsNav.identity' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByTestId('bot-avatar-picker')).toBeTruthy();
    // Other groups' unique content must not be mounted on the default tab.
    expect(screen.queryByTestId('bot-route-settings')).toBeNull();
    expect(screen.queryByTestId('bot-event-inbox-settings')).toBeNull();
    expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();
  });

  it('renders all seven groups in the canonical order', () => {
    renderSettings();
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent);
    expect(tabs).toEqual([
      'bots.settingsNav.identity',
      'bots.settingsNav.channels',
      'bots.settingsNav.capabilities',
      'bots.settingsNav.automation',
      'bots.settingsNav.notifications',
      'bots.settingsNav.projects',
      'bots.settingsNav.advanced',
    ]);
  });

  it('moves the Renew card and BotLifecycleSettings out of the first screen and into Advanced', () => {
    renderSettings();
    expect(screen.queryByText('bots.sessionLifecycleTitle')).toBeNull();
    expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.advanced' }));

    expect(screen.getByText('bots.sessionLifecycleTitle')).toBeTruthy();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
  });

  it('switches panels on click without any per-tab save affordance', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.channels' }));
    expect(screen.getByTestId('bot-route-settings')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.capabilities' }));
    // 能力 tab 现在是人话芯片墙,技术明细面已经搬去高级。
    expect(screen.getByText('bots.capabilityChips.title')).toBeTruthy();
    expect(screen.queryByTestId('bot-capability-settings')).toBeNull();
    expect(screen.queryByTestId('bot-route-settings')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.automation' }));
    expect(screen.getByTestId('bot-automation-settings')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.notifications' }));
    expect(screen.getByTestId('bot-event-inbox-settings')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.projects' }));
    expect(screen.getByTestId('bot-project-settings')).toBeTruthy();
  });

  it('has no bottom save bar at all — settings persist on their own', () => {
    renderSettings();

    // Chris's report: "I had no idea I needed to save." The fix is that there is
    // nothing to press, on any tab — so the bar must not come back.
    expect(screen.queryByRole('button', { name: 'bots.save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.cancel' })).toBeNull();
    for (const tab of ['channels', 'capabilities', 'automation', 'projects', 'advanced']) {
      fireEvent.click(screen.getByRole('tab', { name: `bots.settingsNav.${tab}` }));
      expect(screen.queryByRole('button', { name: 'bots.save' })).toBeNull();
    }
  });

  it('updates the ?tab= URL param when a nav item is selected, for deep-linkability', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.projects' }));
    expect(new URLSearchParams(mocks.currentSearch).get('tab')).toBe('projects');

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.advanced' }));
    expect(new URLSearchParams(mocks.currentSearch).get('tab')).toBe('advanced');
  });

  it('honors an initial ?settings=1&tab=capabilities deep link', () => {
    renderSettings({}, 'settings=1&tab=capabilities');

    expect(
      screen.getByRole('tab', { name: 'bots.settingsNav.capabilities' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('bots.capabilityChips.title')).toBeTruthy();
    // harness / model / 明细勾选是专家逃生口,不再出现在能力页。
    expect(screen.queryByTestId('model-selector')).toBeNull();
    expect(screen.queryByTestId('vendor-switcher')).toBeNull();
  });

  it('moves harness, model and the raw capability pickers into Advanced', () => {
    renderSettings({}, 'settings=1&tab=advanced');

    expect(screen.getByText('bots.advancedCapabilities.title')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.getByTestId('vendor-switcher')).toBeTruthy();
    expect(screen.getByTestId('bot-capability-settings')).toBeTruthy();
  });

  it('falls back to identity for an unknown ?tab= value instead of a blank panel', () => {
    renderSettings({}, 'settings=1&tab=not-a-real-tab');

    expect(
      screen.getByRole('tab', { name: 'bots.settingsNav.identity' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByTestId('bot-avatar-picker')).toBeTruthy();
  });

  it('resets the content scroll position when switching tabs', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.channels' }));
    // No throw: the scrollTo effect runs against the (jsdom, no-op) content ref.
    expect(screen.getByTestId('bot-route-settings')).toBeTruthy();
  });
});

describe('Bot capability chip wall', () => {
  it('shows plain-language chips and no long-term memory switch at all', () => {
    renderSettings({}, 'settings=1&tab=capabilities');

    expect(screen.getByRole('switch', { name: 'bots.capabilityChips.act.name' })).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'bots.capabilityChips.automation.name' }),
    ).toBeTruthy();
    // 长期记忆是伙伴的底层能力,不再有任何关闭入口。
    expect(screen.queryByText('bots.memoryLabel')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'bots.memoryLabel' })).toBeNull();
  });

  it('greys out a channel with no connected account and says where to connect it', () => {
    renderSettings({}, 'settings=1&tab=capabilities');

    const feishu = screen.getByRole('switch', { name: 'Feishu' }) as HTMLButtonElement;
    expect(feishu.disabled).toBe(true);
    expect(screen.getByText('bots.capabilityChips.channel.connectHint:{"channel":"Feishu"}'))
      .toBeTruthy();
  });

  it('writes the automation capability straight through the chip', async () => {
    renderSettings({}, 'settings=1&tab=capabilities');

    fireEvent.click(screen.getByRole('switch', { name: 'bots.capabilityChips.automation.name' }));

    // instant 档的防抖是 0ms,但仍走一次 setTimeout。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ automation: true }),
    });
  });
});

describe('Hands-on ⚠ badge', () => {
  it('stays hidden while the teammate still asks before acting', () => {
    renderSettings();
    expect(screen.queryByRole('button', { name: 'bots.trustedBadge.label' })).toBeNull();
  });

  it('marks a trusted teammate and jumps to the hands-on chip when clicked', () => {
    renderSettings({ capabilities: capabilities({ permissions: 'trusted' }) });

    const badge = screen.getByRole('button', { name: 'bots.trustedBadge.label' });
    fireEvent.click(badge);

    expect(new URLSearchParams(mocks.currentSearch).get('tab')).toBe('capabilities');
    const chip = screen.getByRole('switch', { name: 'bots.capabilityChips.act.name' });
    expect(chip.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(chip);
  });
});

describe('Bot settings archived-bot reachability', () => {
  it('keeps the pre-existing archived-bot settings page untouched by the tab rework', () => {
    renderSettings({ status: 'archived' });

    // The archived branch renders its own minimal page and never mounts the tab nav.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.getByTestId('bot-event-inbox-settings')).toBeTruthy();
  });

  it('never writes a profile update for an archived (read-only) Bot', () => {
    const view = renderSettings({ status: 'archived' });
    view.unmount();

    // Autosave must not turn a read-only surface into a writer.
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });
});

describe('Bot settings autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('merges a typing burst into one profile update after the debounce window', async () => {
    renderSettings();
    const input = screen.getByDisplayValue('PR steward');

    for (const value of ['PR stewar', 'PR stewa', 'PR stew', 'PR crew']) {
      fireEvent.change(input, { target: { value } });
      await advance(300);
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    }

    await advance(1300);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({ name: 'PR crew' });
  });

  it('saves a chip toggle without waiting out the text debounce', async () => {
    renderSettings({}, 'settings=1&tab=capabilities');

    fireEvent.click(screen.getByRole('switch', { name: 'bots.capabilityChips.act.name' }));
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ permissions: 'trusted' }),
    });
  });

  it('sends nothing when the page is only opened, or when an edit is reverted', async () => {
    renderSettings();
    await advance(3000);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();

    const input = screen.getByDisplayValue('PR steward');
    fireEvent.change(input, { target: { value: 'PR stewardz' } });
    fireEvent.change(input, { target: { value: 'PR steward' } });
    await advance(3000);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it('flushes a still-pending edit when the settings view unmounts', async () => {
    const view = renderSettings();
    fireEvent.change(screen.getByDisplayValue('Delivery steward'), {
      target: { value: 'Reviews and merges' },
    });

    // Well inside the debounce window — the old UI would have dropped this.
    view.unmount();

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      description: 'Reviews and merges',
    });
  });

  it('flushes on blur so long identity prompts do not wait for the debounce', async () => {
    renderSettings();
    const textarea = screen.getByPlaceholderText('bots.identitySourcePlaceholder');
    fireEvent.change(textarea, { target: { value: 'You review delivery PRs.' } });
    fireEvent.blur(textarea);
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      identitySource: 'You review delivery PRs.',
    });
  });

  it('shows a saving indicator and then a transient saved mark', async () => {
    let release: (() => void) | null = null;
    mocks.updateBotProfile.mockImplementationOnce(async (_id, patch) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { id: 'bot-1', currentVersion: 1, ...patch } as never;
    });

    renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    await advance(1300);
    expect(screen.getByText('bots.autosave.saving')).toBeTruthy();

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('bots.autosave.saved')).toBeTruthy();

    // "Saved" is a confirmation, not a permanent badge.
    await advance(2500);
    expect(screen.queryByText('bots.autosave.saved')).toBeNull();
  });

  it('surfaces a failure with a retry that re-sends the same change', async () => {
    mocks.updateBotProfile.mockRejectedValueOnce(new Error('ipc down'));

    renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    await advance(1300);

    expect(screen.getByRole('alert').textContent).toContain('bots.profileApply.saveFailed');
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'bots.autosave.retry' }));
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(mocks.updateBotProfile.mock.calls[1]?.[1]).toMatchObject({ name: 'PR crew' });
    expect(screen.queryByRole('button', { name: 'bots.autosave.retry' })).toBeNull();
  });

  it('flushes before leaving for the chat, and stays put when that save fails', async () => {
    mocks.updateBotProfile.mockRejectedValueOnce(new Error('ipc down'));
    const view = renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });

    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(view.onBack).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('bots.profileApply.saveFailed');

    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(view.onBack).toHaveBeenCalledTimes(1);
  });

  it('defers the "apply to current task" prompt to the moment the user leaves', async () => {
    // The canonical chat is on v1 while the save produces v2: the pre-existing
    // renew prompt still fires — but only at the exit boundary, so a background
    // autosave never throws a modal over someone who is mid-sentence.
    mocks.updateBotProfile.mockImplementationOnce(async (_id, patch) => ({
      id: 'bot-1',
      currentVersion: 2,
      ...patch,
    }));

    const view = renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    await advance(1300);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('bots.profileApply.title')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);

    expect(screen.getByText('bots.profileApply.title')).toBeTruthy();
    expect(view.onBack).not.toHaveBeenCalled();
  });
});
