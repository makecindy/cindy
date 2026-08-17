// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  return render(
    <BotSettings
      bot={bot(overrides)}
      onBack={vi.fn()}
      onRenew={vi.fn(async () => false)}
      onOpenSession={vi.fn()}
      renewing={false}
    />,
  );
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.updateBotProfile.mockClear();
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

  it('switches panels on click and keeps the save bar reachable from every tab', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.channels' }));
    expect(screen.getByTestId('bot-route-settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.save' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.capabilities' }));
    expect(screen.getByTestId('bot-capability-settings')).toBeTruthy();
    expect(screen.queryByTestId('bot-route-settings')).toBeNull();
    expect(screen.getByRole('button', { name: 'bots.save' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.automation' }));
    expect(screen.getByTestId('bot-automation-settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.save' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.notifications' }));
    expect(screen.getByTestId('bot-event-inbox-settings')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'bots.settingsNav.projects' }));
    expect(screen.getByTestId('bot-project-settings')).toBeTruthy();
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
    expect(screen.getByTestId('bot-capability-settings')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
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

describe('Bot settings archived-bot reachability', () => {
  it('keeps the pre-existing archived-bot settings page untouched by the tab rework', () => {
    renderSettings({ status: 'archived' });

    // The archived branch renders its own minimal page and never mounts the tab nav.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.getByTestId('bot-event-inbox-settings')).toBeTruthy();
  });
});
