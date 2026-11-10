// @vitest-environment jsdom
import { useBotUnreadSync } from '../useBotUnreadSync';

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => mocks.running } }));

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterAll(() => { HTMLElement.prototype.scrollIntoView = originalScrollIntoView; });

vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: false }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => null,
}));

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'fixture-owner' }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  observeSession: vi.fn(),
  profiles: [] as unknown[],
  running: new Map<string, { isRunning: boolean }>(),
  remoteBots: [] as import('../remoteBotRoster').RemoteBot[],
  devices: [] as Array<{ deviceId: string; name: string; isSelf: boolean }>,
  health: new Map<string, string>(),
  unread: {} as Record<string, number>,
  groupMessages: new Map<string, unknown[]>(),
  params: {} as { botId?: string; deviceId?: string },
  refreshBotProfiles: vi.fn(),
  setBotHidden: vi.fn(async () => undefined),
  setBotPinned: vi.fn(async () => undefined),
  duplicateBotProfile: vi.fn(async () => ({ id: 'copy' })),
  /** 灵动岛活动镜像:sessionId -> phase。侧栏据此显示「正在输入…」。 */
  islandActivity: new Map<string, { sessionId: string; phase: string; compactDetail?: string }>(),
  cloud: { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] } as import('../../../../shared/companionCloud').CompanionCloudSnapshot,
}));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => mocks.cloud }));

vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => mocks.remoteBots }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => mocks.devices,
}));

vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivityMap: () => mocks.islandActivity,
}));
// The section must never observe session transitions: the task sidebar is the only
// notification owner (CCAgentSidebarUpper), also on /bots routes.
vi.mock('@/hooks/useSessionRunningStatus', () => ({
  useSessionRunningStatus: (sessionId: string | undefined) => {
    mocks.observeSession(sessionId);
    return ({
    runningSessionIds: new Set<string>(),
    notifications: new Set<string>(),
    clearNotification: vi.fn(),
    });
  },
}));

vi.mock('react-router-dom', async importOriginal => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: mocks.params.deviceId
    ? `/bots/remote/${mocks.params.deviceId}/${mocks.params.botId}`
    : mocks.params.botId ? `/bots/${mocks.params.botId}` : '/bots', search: '', hash: '' }),
}));
vi.mock('../botStore', () => ({
  getBotProfiles: () => mocks.profiles,
  useBotProfiles: () => mocks.profiles,
  useBotUnreadCounts: () => mocks.unread,
  refreshBotProfiles: mocks.refreshBotProfiles,
  setBotHidden: mocks.setBotHidden,
  setBotPinned: mocks.setBotPinned,
  duplicateBotProfile: mocks.duplicateBotProfile,
  canonicalBotSessionId: (bot: {
    sessions?: Array<{ id: string; role?: string; kind?: string }>;
  }) =>
    bot.sessions?.find((session) => session.role === 'canonical' || session.kind === 'chat')?.id,
}));
vi.mock('../BotDeleteDialog', () => ({
  BotDeleteDialog: ({ bot }: { bot: { name: string } | null }) =>
    bot ? <div data-testid="bot-delete-dialog">{bot.name}</div> : null,
}));

import { TeammatesSection } from '../TeammatesSection';
import { BotConnectionStatus } from '../BotConnectionStatus';
import { markBotRead, resetBotReadStateForTests } from '../botReadState';
import { readTeammatesSectionCollapsed } from '../teammatesSectionPrefs';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

interface BotFixture {
  id: string;
  name: string;
  description?: string;
  lastMessagePreview?: string | null;
  lastMessageAt?: number | null;
  needsAttention?: boolean;
}

function bot(fixture: BotFixture) {
  return {
    channel: 'local',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {},
    createdAt: 0,
    sessions: [{ id: `${fixture.id}-chat`, kind: 'chat' }],
    canonicalSessionId: `${fixture.id}-chat`,
    description: '',
    ...fixture,
  };
}

let messageListeners: Array<(payload: unknown) => void> = [];

async function renderSidebar() {
  const view = render(<TeammatesSection />);
  await waitFor(() => expect(view.container.querySelector('button')).not.toBeNull());
  return view;
}

beforeEach(() => {
  messageListeners = [];
  window.localStorage.clear();
  resetBotReadStateForTests();
  setDataOwnerGeneration('fixture-owner', 1);
  mocks.navigate.mockReset();
  mocks.observeSession.mockReset();
  mocks.refreshBotProfiles.mockReset();
  mocks.setBotHidden.mockReset();
  mocks.setBotPinned.mockReset();
  mocks.duplicateBotProfile.mockReset();
  mocks.setBotHidden.mockResolvedValue(undefined);
  mocks.setBotPinned.mockResolvedValue(undefined);
  mocks.duplicateBotProfile.mockResolvedValue({ id: 'copy' });
  mocks.health = new Map();
  mocks.unread = {};
  mocks.groupMessages = new Map();
  mocks.params = {};
  mocks.profiles = [];
  mocks.running = new Map();
  mocks.remoteBots = [];
  mocks.devices = [];
  mocks.islandActivity = new Map();
  mocks.cloud = { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        messages: {
          list: vi.fn(async (sessionId: string) => mocks.groupMessages.get(sessionId) ?? []),
          onCreated: (cb: (payload: unknown) => void) => {
            messageListeners.push(cb);
            return () => {
              messageListeners = messageListeners.filter((entry) => entry !== cb);
            };
          },
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('one Cindy entry across devices', () => {
  const remote = (deviceId: string, deviceName: string, extra = {}) => ({
    id: 'cindy-default', deviceId, deviceName, name: 'Cindy', avatar: '🤖', avatarColor: 'violet',
    description: '', preview: `${deviceName} preview`, activityAt: 1, sessionId: `${deviceId}-chat`, online: true, ...extra,
  });

  it('keeps the original local row and only offers switching while another Cindy exists', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    const view = await renderSidebar();
    expect(screen.queryByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.queryByText('bots.devicePicker.local')).toBeNull();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    fireEvent.click(screen.getByText('Local preview').closest('button')!);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');

    mocks.remoteBots = [remote('cloud', 'Cloud', { online: false })];
    view.rerender(<TeammatesSection />);
    expect(screen.getAllByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toHaveLength(1);
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.getByText('Local preview')).toBeTruthy();

    mocks.remoteBots = [];
    view.rerender(<TeammatesSection />);
    expect(screen.queryByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.queryByText('bots.devicePicker.local')).toBeNull();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(screen.getByText('Local preview')).toBeTruthy();
  });

  it('keeps the original remote row when it is the only Cindy', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud', { online: false })];
    await renderSidebar();
    expect(screen.queryByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.getByText('bots.remote.offline · Cloud')).toBeTruthy();
    fireEvent.click(screen.getByText('Cloud preview').closest('button')!);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
  });

  it('defaults to local Cindy while leaving custom same-name teammates separate', async () => {
    mocks.profiles = [{ ...bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' }), templateId: 'cindy' }];
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac'), { ...remote('other', 'Office'), id: 'custom', preview: 'Custom preview' }];
    await renderSidebar();
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.getByText('Custom preview')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    expect(screen.queryByText('Mac preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy · bots.devicePicker.local' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');
  });

  it('follows the selected remote chat and returns to local when visiting another teammate', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Renamed Cindy', lastMessagePreview: 'Local preview' }), bot({ id: 'writer', name: 'Writer' })];
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    const view = await renderSidebar();
    const trigger = screen.getByRole('combobox', { name: /bots.devicePicker.switchDevice/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const cloud = await screen.findByRole('option', { name: /Cloud/ });
    fireEvent.click(cloud);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
    mocks.params = { deviceId: 'cloud', botId: 'cindy-default' };
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Cloud preview')).toBeTruthy();
    expect(screen.queryByText('Local preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cindy · Cloud' }).getAttribute('aria-current')).toBe('page');
    mocks.params = { botId: 'writer' };
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    const localEntry = screen.getByRole('button', { name: 'Renamed Cindy · bots.devicePicker.local' });
    expect(localEntry.hasAttribute('aria-current')).toBe(false);
    fireEvent.click(localEntry);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/cindy-default');
  });

  it.each([
    { generation: { phase: 'processing' as const, startedAt: 1 } },
    { teammateActivity: { phase: 'running' as const } },
  ])('shows another computer working without a duplicate running dot: %j', async (running) => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', running)];
    const view = await renderSidebar();
    const row = screen.getByTestId('cindy-device-row');
    expect(row.textContent).toContain('Cloud · ');
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('Local preview')).toBeNull();
    expect(row.querySelector('[data-teammate-status="running"]')).toBeNull();
    expect(row.querySelector('[data-teammate-running-preview] .session-status-breathing')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy · bots.devicePicker.local' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');

    mocks.remoteBots = [remote('cloud', 'Cloud')];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.queryByText('ccAgent.agentStatus.processing')).toBeNull();
    expect(row.querySelector('[data-teammate-running-preview]')).toBeNull();
  });

  // The selected remote Cindy can retain only its running snapshot after refresh.
  // Other-computer coverage does not exercise this current-row fallback (unit).
  it('keeps selected remote work visible with only a running snapshot', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { teammateActivity: { phase: 'running' } })];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    const view = await renderSidebar();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    expect(screen.getByTestId('cindy-device-row').querySelector('[data-teammate-status="running"]')).toBeNull();
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Cloud preview')).toBeTruthy();
  });

  it('shows local work while the selected remote computer is idle', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    mocks.islandActivity.set('cindy-default-chat', { sessionId: 'cindy-default-chat', phase: 'running' });
    await renderSidebar();
    expect(screen.getByTestId('cindy-device-row').textContent).toContain('bots.devicePicker.local · ');
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy · Cloud' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
  });

  it('keeps the current computer summary when both computers are working', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { generation: { phase: 'thinking', startedAt: 1 } })];
    mocks.islandActivity.set('cindy-default-chat', { sessionId: 'cindy-default-chat', phase: 'running' });
    await renderSidebar();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.getByTestId('cindy-device-row').textContent).not.toContain('Cloud · ');
    expect(screen.queryByText('ccAgent.agentStatus.thinking')).toBeNull();
  });

  it('keeps remote unread discoverable without opening the chat or switching away from local', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { lastReplyAt: 20, readAt: 10, online: false })];
    await renderSidebar();
    expect(screen.getByLabelText('bots.devicePicker.otherUnread')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox', { name: /bots.devicePicker.switchDevice/ }), { key: 'ArrowDown' });
    const cloud = await screen.findByRole('option', { name: /Cloud/ });
    expect(cloud.textContent).toContain('bots.remote.offline');
    expect(cloud.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByLabelText('bots.devicePicker.unread')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('prefers local Cindy when local profiles arrive after the remote roster', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    const view = await renderSidebar();
    expect(screen.getByText('Cloud preview')).toBeTruthy();

    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cindy · bots.devicePicker.local' })).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('follows a remote deep link and falls back to local if that device is removed', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    const view = await renderSidebar();
    expect(screen.getByText('Cloud preview')).toBeTruthy();
    mocks.remoteBots = [];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('offers a remote-only group without recreating a deleted local Cindy', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    await renderSidebar();
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.queryByText('bots.devicePicker.local')).toBeNull();
    expect(screen.getByText('Cloud preview')).toBeTruthy();
  });
});

describe('teammate host labels', () => {
  // PR #8714: after a resource refresh fails, the remote activity snapshot remains
  // running without generation details. The real row must still show work, then
  // restore its message after completion (unit; prior cases only cover merged Cindy).
  it('keeps standalone remote work visible when only the running snapshot remains', async () => {
    mocks.remoteBots = [{ id: 'remote-bot', deviceId: 'studio', deviceName: 'Studio',
      name: 'Writer', avatar: '🤖', avatarColor: 'violet', description: '', preview: 'Previous reply',
      activityAt: 1, sessionId: 'remote-session', online: true,
      teammateActivity: { phase: 'running' } }];
    const view = await renderSidebar();
    const working = screen.getByText('ccAgent.agentStatus.processing');
    const row = working.closest('button')!;
    expect(screen.queryByText('Previous reply')).toBeNull();
    expect(row.querySelector('[data-teammate-status="running"]')).toBeNull();
    expect(row.querySelector('[data-teammate-running-preview] .session-status-breathing')).not.toBeNull();
    fireEvent.click(row);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/studio/remote-bot');
    mocks.remoteBots = mocks.remoteBots.map(bot => ({ ...bot, teammateActivity: { phase: 'idle' } }));
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Previous reply')).toBeTruthy();
    expect(screen.queryByText('ccAgent.agentStatus.processing')).toBeNull();
  });

  it('shows only the remote device for same-name teammates and preserves remote routing', async () => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.devices = [{ deviceId: 'local-device', name: 'MBP-M5', isSelf: true }];
    mocks.remoteBots = [{ id: 'remote-bot', deviceId: 'remote-device', deviceName: 'Mac-Studio',
      name: 'Cindy', avatar: '🤖', avatarColor: 'violet', description: '', preview: 'Remote preview',
      activityAt: 1, sessionId: 'remote-session', online: true }];
    const view = await renderSidebar();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('MBP-M5');
    expect(screen.queryByRole('img', { name: /bots.remote.online/ })).toBeNull();
    expect(screen.getByText('Mac-Studio')).toBeTruthy();
    expect(screen.getByText('Local preview')).toBeTruthy();
    const remoteRow = screen.getByText('Remote preview').closest('button')!;
    fireEvent.click(remoteRow);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/remote-device/remote-bot');

    mocks.remoteBots = mocks.remoteBots.map((bot) => ({ ...bot, online: false, deviceName: ' ' }));
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('bots.remote.offline · another computer')).toBeTruthy();
    expect(screen.queryByText('bots.remote.offline · bots.remote.thisDevice')).toBeNull();
  });

  it('keeps local status free of device labels before and after directory updates', async () => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy' })];
    const view = await renderSidebar();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('bots.remote.thisDevice');
    expect(view.container.textContent).not.toContain(' · ');
    mocks.devices = [{ deviceId: 'local-device', name: 'Renamed Mac', isSelf: true }];
    view.rerender(<TeammatesSection />);
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('Renamed Mac');
    expect(view.container.textContent).not.toContain(' · ');
  });

  it('disambiguates remote devices and updates their names without exposing the local host', async () => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy' })];
    mocks.devices = [{ deviceId: 'local-device', name: 'Shared Mac', isSelf: true }];
    mocks.remoteBots = ['host-a', 'host-b'].map((deviceId) => ({
      id: 'remote-bot', deviceId, deviceName: 'Shared Mac', name: 'Cindy',
      avatar: '🤖', avatarColor: 'violet', description: '', preview: '',
      activityAt: 1, sessionId: 'remote-session', online: true,
    }));
    const view = await renderSidebar();
    expect(screen.getByText('Shared Mac (1)')).toBeTruthy();
    expect(screen.getByText('Shared Mac (2)')).toBeTruthy();
    expect(view.container.innerHTML).not.toContain('local-device');
    mocks.remoteBots = mocks.remoteBots.map((entry) => ({ ...entry, deviceName: entry.deviceId === 'host-a' ? 'Studio' : 'Mini' }));
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Studio')).toBeTruthy();
    expect(screen.getByText('Mini')).toBeTruthy();
  });

  it.each(['Thinking', 'Generating'])('preserves %s while hiding the local host and idle status', async (compactDetail) => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy', lastMessagePreview: 'Previous reply' })];
    mocks.devices = [{ deviceId: 'local-device', name: 'MBP-M5', isSelf: true }];
    mocks.islandActivity.set('local-bot-chat', { sessionId: 'local-bot-chat', phase: 'running', compactDetail });
    const view = await renderSidebar();
    expect(screen.queryByText(compactDetail)).toBeNull();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('MBP-M5');
    expect(view.container.innerHTML).not.toContain('bots.remote.thisDevice');
    expect(view.container.textContent).not.toContain(' · ');
    expect(screen.queryByText('Previous reply')).toBeNull();
    mocks.islandActivity.clear();
    view.rerender(<TeammatesSection />);
    expect(screen.queryByText(compactDetail)).toBeNull();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(screen.getByText('Previous reply')).toBeTruthy();
  });

  it('retains delegated work and the existing typing fallback when detail is absent', async () => {
    mocks.profiles = [{ ...bot({ id: 'local-bot', name: 'Cindy' }), sessions: [
      { id: 'local-bot-chat', kind: 'chat' }, { id: 'delegated', kind: 'task' },
    ] }];
    mocks.islandActivity.set('delegated', { sessionId: 'delegated', phase: 'running', compactDetail: ' ' });
    await renderSidebar();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
  });

  it('keeps offline status without a device name or a dangling separator', () => {
    render(<BotConnectionStatus inline online={false} deviceName=" " />);
    expect(screen.getByText('bots.remote.offline').getAttribute('title')).toBe('bots.remote.offline');
  });

});

describe('TeammatesSection header', () => {
  const header = () => screen.getByRole('button', { name: 'bots.title' });

  // #6444: six rows used to shrink to five before SectionCollapse could animate.
  // Existing tests cover the avatar end state, not the closing interval. Unit tier:
  // render the real section with six entries and advance fake time (no real wait).
  it('keeps the full list mounted until the section collapse finishes', () => {
    vi.useFakeTimers();
    mocks.profiles = Array.from({ length: 6 }, (_, index) => bot({
      id: `mate-${index}`, name: `Mate ${index}`, lastMessagePreview: 'Ready',
    }));
    render(<TeammatesSection />);
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.showAllSessions:{"count":6}' }));
    expect(screen.getAllByText('Ready')).toHaveLength(6);
    fireEvent.click(header());
    expect(screen.getAllByText('Ready')).toHaveLength(6);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('Ready')).toBeNull();
    fireEvent.click(header());
    expect(screen.getAllByText('Ready')).toHaveLength(5);
  });

  it('starts expanded and collapses into a row of avatars that is remembered per account', async () => {
    mocks.profiles = [
      bot({ id: 'bot-1', name: 'PR steward', lastMessagePreview: 'Two checks are still red' }),
      bot({ id: 'bot-2', name: 'Writer' }),
    ];
    mocks.unread = { 'bot-2': 1 };
    await renderSidebar();
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Two checks are still red')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'PR steward' })).toBeNull();
    expect(readTeammatesSectionCollapsed('fixture-owner')).toBe(false);

    fireEvent.click(header());
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(readTeammatesSectionCollapsed('fixture-owner')).toBe(true);
    // Collapsed: one avatar per chat; an unread teammate says so in its label.
    fireEvent.click(screen.getByRole('button', { name: 'PR steward' }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/bot-1');
    expect(screen.getByRole('button', { name: 'Writer · bots.avatarStatus.unread' })).toBeTruthy();
    // The full rows leave once the collapse animation has finished.
    await waitFor(() => expect(screen.queryByText('Two checks are still red')).toBeNull());

    // A fresh mount (another route, a relaunch) restores the saved choice.
    cleanup();
    await renderSidebar();
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Two checks are still red')).toBeNull();
    expect(screen.getByRole('button', { name: 'PR steward' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bots.list.sectionExpand' }));
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Two checks are still red')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'PR steward' })).toBeNull();
    expect(readTeammatesSectionCollapsed('fixture-owner')).toBe(false);
    expect(window.localStorage.getItem('sidebar.teammatesSection.v1.owner.fixture-owner')).toBe('expanded');
  });

  it('keeps the collapsed row on one line and folds the rest into +N', async () => {
    const original = globalThis.ResizeObserver;
    // 5 slots: 4 avatars + the +N chip (40px target, 4px gap).
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 216 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      mocks.profiles = Array.from({ length: 6 }, (_, index) => bot({ id: `bot-${index}`, name: `Mate ${index}` }));
      mocks.unread = { 'bot-5': 1 };
      mocks.params = { botId: 'bot-4' };
      await renderSidebar();
      fireEvent.click(header());
      const avatars = screen.getAllByRole('button', { name: /^Mate \d$/ });
      expect(avatars).toHaveLength(4);
      // The open chat keeps a slot even when it sorts past the cut.
      expect(screen.getByRole('button', { name: 'Mate 4' }).getAttribute('aria-current')).toBe('page');
      const more = screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' });
      fireEvent.click(more);
      expect(header().getAttribute('aria-expanded')).toBe('true');
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('marks the open chat in the collapsed avatar row', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' }), bot({ id: 'bot-2', name: 'Writer' })];
    mocks.unread = { 'bot-1': 2 };
    mocks.params = { botId: 'bot-1' };
    await renderSidebar();
    fireEvent.click(header());
    // Routing alone does not acknowledge a reply; the existing read receipt owns clearing.
    expect(screen.getByRole('button', { name: 'PR steward · bots.avatarStatus.unread' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Writer' }).hasAttribute('aria-current')).toBe(false);
  });

  it('keeps a completed unread reply green after the live snapshot is removed, then clears on read', async () => {
    mocks.profiles = [{ ...bot({ id: 'bot-1', name: 'Writer' }), lastMessageRole: 'assistant' }];
    mocks.unread = { 'bot-1': 1 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'completed' }]]);
    const view = await renderSidebar();
    expect(view.container.querySelector('[data-teammate-status="done"]')).not.toBeNull();
    // Idle is represented by no activity entry, not an AgentIslandSessionPhase.
    mocks.islandActivity = new Map();
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status="done"]')).not.toBeNull();
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status]')).toBeNull();
  });

  it('keeps a pending decision ahead of an error like the shared resolver, even after read acknowledgement', async () => {
    mocks.profiles = [{ ...bot({ id: 'bot-1', name: 'Writer' }), needsAttention: true }];
    mocks.unread = { 'bot-1': 1 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'needs-interaction' }]]);
    const view = await renderSidebar();
    expect(view.container.querySelector('[data-teammate-status="awaiting"]')).not.toBeNull();
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status="awaiting"]')).not.toBeNull();
    expect(view.container.querySelector('[data-teammate-status="error"]')).toBeNull();
  });

  it('keeps pending attention ahead of errors in the collapsed overflow', async () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 48 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      mocks.profiles = [bot({ id: 'waiting', name: 'Waiting' }), bot({ id: 'failed', name: 'Failed', needsAttention: true })];
      mocks.islandActivity = new Map([['waiting-chat', { sessionId: 'waiting-chat', phase: 'needs-interaction' }]]);
      await renderSidebar();
      fireEvent.click(screen.getByRole('button', { name: 'bots.title' }));
      const overflow = screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' });
      expect(overflow.querySelector('[data-teammate-status="awaiting"]')).not.toBeNull();
      expect(overflow.querySelector('[data-teammate-status="error"]')).toBeNull();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('leaves session notifications to the task sidebar', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.params = { botId: 'bot-1' };
    await renderSidebar();
    expect(mocks.observeSession).not.toHaveBeenCalled();
  });
});

describe('TeammatesSection 「正在输入…」', () => {
  it('回合进行中时第二行让位给「正在输入…」', async () => {
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: Date.now(),
      }),
    ];
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    const view = await renderSidebar();

    expect(view.container.textContent).toContain('ccAgent.agentStatus.processing');
    // 进行中时不再同时挂上一句说过什么 —— 这一行只回答「TA 现在怎么样」。
    expect(view.container.textContent).not.toContain('Two checks are still red');
  });

  it('回合结束后落回最新消息预览,不留痕', async () => {
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: Date.now(),
      }),
    ];
    // completed 不是 running:同一份镜像里的终态不该继续显示「正在输入…」。
    mocks.islandActivity = new Map([
      ['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'completed' }],
    ]);
    const view = await renderSidebar();

    expect(view.container.textContent).not.toContain('ccAgent.agentStatus.processing');
    expect(view.container.textContent).toContain('Two checks are still red on #2829');
  });

  it('只认这个伙伴自己的主任务 —— 别人的会话在跑不该点亮这一行', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward', description: 'Delivery steward' })];
    mocks.islandActivity = new Map([
      ['someone-else', { sessionId: 'someone-else', phase: 'running' }],
    ]);
    const view = await renderSidebar();

    expect(view.container.textContent).not.toContain('ccAgent.agentStatus.processing');
    expect(view.container.textContent).toContain('Delivery steward');
  });

  it('uses the same orange breathing indicator as groups while running', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.unread = { 'bot-1': 4 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    await renderSidebar();

    const line = screen.getByText('ccAgent.agentStatus.processing').closest('[data-teammate-running-preview]') as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.className).toContain('text-[var(--status-bar-accent)]');
    expect(line.querySelector('.session-status-breathing svg')).not.toBeNull();
    expect(line.closest('.italic')).toBeNull();
  });
});

function UnreadSync() { useBotUnreadSync(); return null; }

describe('TeammatesSection rows', () => {
  it('shows durable Hermes attention without reviving the permissions badge', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Needs help', needsAttention: true })];

    await renderSidebar();

    expect(screen.getByLabelText('bots.avatarStatus.error')).toBeTruthy();
  });
  it('does not duplicate recent Bots in a separate Active now area', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Active steward', lastMessageAt: Date.now() })];

    await renderSidebar();

    expect(screen.queryByLabelText('bots.list.activeNow')).toBeNull();
    expect(screen.getAllByText('Active steward')).toHaveLength(1);
  });

  it('keeps hidden Bots out of the list without a section search box', async () => {
    mocks.profiles = [
      bot({ id: 'visible', name: 'Visible' }),
      { ...bot({ id: 'hidden', name: 'Hidden release steward' }), hiddenAt: 2 },
      { ...bot({ id: 'other', name: 'Other hidden' }), hiddenAt: 3 },
      bot({ id: 'v2', name: 'V2' }),
      bot({ id: 'v3', name: 'V3' }),
      bot({ id: 'v4', name: 'V4' }),
      bot({ id: 'v5', name: 'V5' }),
      bot({ id: 'v6', name: 'V6' }),
    ];

    await renderSidebar();
    // Search moved to the sidebar-wide search (teammateSearchResults.test); the section
    // keeps hidden teammates out of the list and offers no search box of its own.
    expect(screen.queryByText('Hidden release steward')).toBeNull();
    expect(screen.queryByLabelText('bots.list.search')).toBeNull();
  });

  it('shows the latest message and its time instead of a channel label', async () => {
    const at = new Date(Date.now() - 5 * 60_000);
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        description: 'Delivery steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: at.getTime(),
      }),
    ];

    const view = await renderSidebar();

    expect(screen.getByText('Two checks are still red on #2829')).toBeTruthy();
    expect(screen.getByText(translate('ccAgent.time.relative.minute', { count: 5 }))).toBeTruthy();
    expect(view.container.textContent).not.toContain('Local');
    expect(screen.queryByText('Delivery steward')).toBeNull();
  });

  it('falls back to the description and then to the start-chat prompt', async () => {
    mocks.profiles = [
      bot({ id: 'bot-1', name: 'With description', description: 'Delivery steward' }),
      bot({ id: 'bot-2', name: 'Brand new' }),
    ];

    await renderSidebar();

    expect(screen.getByText('Delivery steward')).toBeTruthy();
    expect(screen.getByText('bots.list.startChat')).toBeTruthy();
  });

  it('never marks a row with the hands-on ⚠ badge', async () => {
    mocks.profiles = [
      bot({ id: 'bot-asks', name: 'Asks first' }),
      { ...bot({ id: 'bot-trusted', name: 'Hands on' }), capabilities: { permissions: 'trusted' } },
    ];

    await renderSidebar();

    // 产品裁决 2026-08-18:伙伴列表是聊天列表,不是权限看板。
    // 2026-08-19:BotTrustedBadge 与 bots.trustedBadge.* 已删除,所以改查 ⚠
    // 图标本身 —— 按已不存在的 i18n key 断言等于没有守卫。
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
  });

  it('carries no health icon column at all — a chat row answers "any new messages", nothing else', async () => {
    mocks.profiles = [
      bot({ id: 'bot-healthy', name: 'Healthy' }),
      bot({ id: 'bot-attention', name: 'Attention' }),
    ];
    mocks.health.set('bot-attention', 'attention');

    await renderSidebar();

    // 一行右侧同时挂「未读数 + 待办点 + 状态图标」时三处右对齐元素互相抢注意力。
    // 异常态另有出口:待办点(收件箱)与 TA 的设置页「健康与历史」。
    await waitFor(() => expect(screen.getByText('Attention')).toBeTruthy());
    for (const status of ['attention', 'recovering', 'paused', 'healthy']) {
      expect(screen.queryByLabelText(`bots.lifecycle.healthStatus.${status}`)).toBeNull();
    }
  });

  it('uses a green unread point without an inverse selection color', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Busy' })];
    mocks.unread = { 'bot-1': 2 };
    const view = await renderSidebar();
    const point = view.container.querySelector('[data-teammate-status="unread"] > span') as HTMLElement;
    expect(point.style.backgroundColor).toBe('var(--card-status-done)');
    expect(point.closest('[data-teammate-row-status]')).not.toBeNull();
    expect(view.container.querySelector('[data-teammate-status]')?.textContent).toBe('');
  });

  it('keeps settings and import out of each row while the row itself opens chat', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();

    // 进设置的入口收敛到对话顶栏;导入下沉到创建面板与「设置 › 伙伴」。
    expect(screen.queryByRole('button', { name: 'bots.settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.portability.import' })).toBeNull();

    fireEvent.click(screen.getByText('PR steward'));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1');
  });

  it('keeps legacy stopped Bots reachable for deletion without presenting archive or restore', async () => {
    mocks.profiles = [
      { ...bot({ id: 'legacy-stopped', name: 'Legacy stopped' }), status: 'archived' },
    ];

    await renderSidebar();

    expect(screen.getByText('bots.lifecycle.stoppedBots')).toBeTruthy();
    expect(screen.queryByText('bots.lifecycle.archivedBots')).toBeNull();
    fireEvent.click(screen.getByText('Legacy stopped'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/legacy-stopped?settings=1');
  });

  it('keeps the row management menu open after a right click', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeNull();
    fireEvent.mouseOver(screen.getByText('PR steward'));
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeNull();
    expect(screen.queryByTestId('bot-delete-dialog')).toBeNull();

    fireEvent.contextMenu(screen.getAllByText('PR steward')[0]);

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.hide' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.duplicate' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' }));
    expect(screen.getByTestId('bot-delete-dialog').textContent).toBe('PR steward');
  });

  it('shows a single unread point for unread Bots regardless of count', async () => {
    mocks.profiles = [
      bot({ id: 'bot-read', name: 'Read', lastMessagePreview: 'Nothing new' }),
      bot({ id: 'bot-unread', name: 'Unread', lastMessagePreview: 'Fresh reply' }),
      bot({ id: 'bot-flooded', name: 'Flooded', lastMessagePreview: 'Many replies' }),
    ];
    mocks.unread = { 'bot-unread': 3, 'bot-flooded': 100 };

    await renderSidebar();

    expect(screen.getAllByLabelText('bots.avatarStatus.unread')).toHaveLength(2);
    expect(screen.queryByText('99+')).toBeNull();
    // A read Bot carries no badge at all — zero must never render as "0".
    expect(screen.queryByLabelText('bots.list.unread:{"count":0}')).toBeNull();
    expect(screen.getByText('Nothing new').className).not.toContain('font-medium');
    expect(screen.getByText('Fresh reply').className).not.toContain('font-medium');
    expect(screen.getAllByLabelText('bots.avatarStatus.unread').every(point => point.textContent === '')).toBe(true);
    expect(screen.getByText('Read').className).not.toContain('font-medium');
    expect(screen.getByText('Unread').className).toContain('font-medium');
  });

  it.each([
    { button: 2, ctrlKey: false },
    { button: 0, ctrlKey: true },
    { button: 0, ctrlKey: false },
  ])('does not select Pin on the opening release ($button / ctrl=$ctrlKey)', async (pointer) => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    await renderSidebar();
    fireEvent.contextMenu(screen.getByText('PR steward'), { clientX: 120, clientY: 180 });
    const pin = await screen.findByRole('menuitem', { name: 'bots.list.pin' });

    // On macOS the context menu can open before the original button is released.
    fireEvent(pin, new MouseEvent('pointerup', { bubbles: true, cancelable: true, ...pointer }));
    if (pointer.button !== 0 || pointer.ctrlKey) fireEvent.click(pin, pointer);
    expect(mocks.setBotPinned).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();

    fireEvent(pin, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fireEvent(pin, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(pin);
    expect(mocks.setBotPinned).toHaveBeenCalledExactlyOnceWith('bot-1', true);
  });

  it('supports keyboard selection and restores row focus when dismissed', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    await renderSidebar();
    const row = screen.getByText('PR steward').closest('button')!;
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    const pin = await screen.findByRole('menuitem', { name: 'bots.list.pin' });
    expect(mocks.setBotPinned).not.toHaveBeenCalled();
    fireEvent.keyDown(pin, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.keyDown(row, { key: 'ContextMenu' });
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'bots.list.pin' }), { key: 'Enter' });
    expect(mocks.setBotPinned).toHaveBeenCalledExactlyOnceWith('bot-1', true);
  });

  it('re-reads the list when a Bot conversation is marked read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    render(<><UnreadSync /><TeammatesSection /></>);
    await vi.waitFor(() => expect(messageListeners.length).toBe(1));
    mocks.refreshBotProfiles.mockClear();

    act(() => {
      markBotRead('bot-1', 1_000);
      markBotRead('bot-1', 2_000);
      vi.advanceTimersByTime(2000);
    });
    // Debounced the same way as the message feed: one refresh per burst.
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });

  // Regression / unit: the real sync hook must publish the new preview even if
  // an older list read replaces profiles during the 120 ms refresh window.
  // The ordinary message test below never replaced the profile array mid-burst.
  it('keeps a pending message refresh when an older list response replaces profiles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const old = bot({ id: 'bot-1', name: 'PR steward', lastMessagePreview: 'Old reply' });
    mocks.profiles = [old];
    const view = render(<><UnreadSync /><TeammatesSection /></>);
    mocks.refreshBotProfiles.mockImplementation(() => {
      mocks.profiles = [{ ...old, lastMessagePreview: 'New reply' }];
    });

    act(() => { for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' }); });
    mocks.profiles = [{ ...old }];
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    expect(screen.getByText('Old reply')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(120); });
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    expect(screen.getByText('New reply')).toBeTruthy();
    expect(screen.queryByText('Old reply')).toBeNull();
  });

  // Regression / unit: message + read receipts previously owned separate timers,
  // so one visible update caused two list reads. Internal tool rows need neither.
  it('coalesces read and message updates and ignores tool activity', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.running = new Map([['bot-1-chat', { isRunning: true }]]);
    render(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const role of ['tool_use', 'tool_result', 'thinking']) {
        for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role } });
      }
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role: 'assistant' } });
      markBotRead('bot-1', 2_000);
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });

  it('refreshes a sealed reply when the turn stops and still accepts late tool rows', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const old = bot({ id: 'bot-1', name: 'PR steward', lastMessagePreview: 'Old reply' });
    mocks.profiles = [old];
    mocks.running = new Map([['bot-1-chat', { isRunning: true }]]);
    const view = render(<><UnreadSync /><TeammatesSection /></>);
    mocks.refreshBotProfiles.mockImplementation(() => {
      mocks.profiles = [{ ...old, lastMessagePreview: 'Sealed reply' }];
    });
    mocks.running = new Map();
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    expect(screen.getByText('Sealed reply')).toBeTruthy();

    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role: 'tool_result' } });
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });

  it('uses current session membership and drops pending refreshes after an owner change or unmount', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    const view = render(<UnreadSync />);
    mocks.profiles = [bot({ id: 'bot-2', name: 'New teammate' })];
    view.rerender(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-2-chat' });
      // Owner publication precedes React's render/cleanup during account switches.
      setDataOwnerGeneration('next-owner', 2);
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    view.rerender(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();
    act(() => { for (const listener of messageListeners) listener({ sessionId: 'bot-2-chat' }); });
    view.unmount();
    act(() => { vi.advanceTimersByTime(120); });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    expect(messageListeners).toHaveLength(0);
  });

  it('refreshes the list when a message lands in a Bot task, and ignores other tasks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    render(<><UnreadSync /><TeammatesSection /></>);
    await vi.waitFor(() => expect(messageListeners.length).toBe(1));

    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'some-other-session' });
      vi.advanceTimersByTime(2000);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();

    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      vi.advanceTimersByTime(2000);
    });
    // Debounced: a burst of rows from one turn triggers a single refresh.
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });
});

describe('cloud companions in the roster', () => {
  it('hides demoted local copies and lists companions homed on a computer never seen here', async () => {
    mocks.profiles = [bot({ id: 'mia', name: 'Mia' }), bot({ id: 'ada', name: 'Ada' })];
    mocks.cloud = {
      enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: ['mia'],
      actors: [
        { id: 'a-mia', externalId: 'mia', name: 'Mia', avatar: null, homeDeviceId: 'laptop',
          homeDevice: { deviceId: 'laptop', name: 'Laptop', online: false, isSelf: false } },
        { id: 'a-ada', externalId: 'ada', name: 'Ada', avatar: null, homeDeviceId: 'desk' },
      ],
    };
    await renderSidebar();
    expect(screen.getByText('Ada')).toBeTruthy();
    const rows = screen.getAllByText('Mia');
    expect(rows).toHaveLength(1);
    const row = rows[0]!.closest('button')!;
    expect(row.textContent).not.toContain('bots.remote.offline');
    fireEvent.click(row);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia');
  });

  it('does not offer a demoted local Cindy as the local option', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.remoteBots = [{ id: 'cindy-default', deviceId: 'laptop', deviceName: 'Laptop', name: 'Cindy', avatar: '🤖',
      avatarColor: 'violet', description: '', preview: 'Laptop preview', activityAt: 1, sessionId: 'laptop-chat', online: true }];
    mocks.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: ['cindy-default'],
      actors: [{ id: 'a-cindy', externalId: 'cindy-default', name: 'Cindy', avatar: null, homeDeviceId: 'laptop' }] };
    await renderSidebar();
    expect(screen.queryByText('Local preview')).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.getByText('Laptop preview')).toBeTruthy();
  });
});
