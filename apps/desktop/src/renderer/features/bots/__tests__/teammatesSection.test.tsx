// @vitest-environment jsdom
import { useBotUnreadSync } from '../useBotUnreadSync';

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'fixture-owner' }), useOptionalAuthDeviceId: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  realStore: false,
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
  toastError: vi.fn(),
  /** 灵动岛活动镜像:sessionId -> phase。侧栏据此显示「正在输入…」。 */
  islandActivity: new Map<string, { sessionId: string; phase: string; compactDetail?: string }>(),
  cloud: { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] } as import('../../../../shared/companionCloud').CompanionCloudSnapshot,
}));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => mocks.cloud }));
vi.mock('@/lib/toast', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, error: mocks.toastError } };
});

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
vi.mock('../botStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../botStore')>();
  return ({
  ...actual,
  getBotProfiles: () => mocks.realStore ? actual.getBotProfiles() : mocks.profiles,
  useBotProfiles: () => mocks.realStore ? actual.useBotProfiles() : mocks.profiles,
  useBotProfilesLoadState: () => mocks.realStore ? actual.useBotProfilesLoadState() : 'ready',
  hasLoadedBotProfiles: () => mocks.realStore ? actual.hasLoadedBotProfiles() : true,
  useBotUnreadCounts: () => mocks.unread,
  refreshBotProfiles: () => mocks.realStore ? actual.refreshBotProfiles() : mocks.refreshBotProfiles(),
  setBotHidden: mocks.setBotHidden,
  setBotPinned: mocks.setBotPinned,
  duplicateBotProfile: mocks.duplicateBotProfile,
  canonicalBotSessionId: (bot: {
    sessions?: Array<{ id: string; role?: string; kind?: string }>;
  }) =>
    bot.sessions?.find((session) => session.role === 'canonical' || session.kind === 'chat')?.id,
});
});
vi.mock('../BotDeleteDialog', () => ({
  BotDeleteDialog: ({ bot }: { bot: { name: string } | null }) =>
    bot ? <div data-testid="bot-delete-dialog">{bot.name}</div> : null,
}));

import { TeammatesSection } from '../TeammatesSection';
import { BotModelSelectionRequiredError } from '../botStore';
import { markBotRead, resetBotReadStateForTests } from '../botReadState';
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
  mocks.realStore = false;
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
  mocks.toastError.mockReset();
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

// Each text row is one overlay button (aria-label "name" or "name · status")
// inside the element carrying data-teammate-row / data-teammate-status.
const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowButton = (name: string) => screen.getByRole('button', { name: new RegExp(`^${escapeName(name)}(?: · |$)`) });
const rowOf = (button: HTMLElement) => button.closest('[data-teammate-row]') as HTMLElement;
const statusOf = (name: string) => rowOf(rowButton(name)).getAttribute('data-teammate-status');
const hasSpinner = (row: HTMLElement) => row.querySelector('[data-sidebar-right-status="running"]') !== null;
const isBold = (row: HTMLElement) => row.querySelector('span[title]')!.className.includes('font-semibold');
const cindyRow = () => screen.getByTestId('cindy-device-row');
const cindyRowButton = () => cindyRow().querySelector(':scope > button') as HTMLButtonElement;
const devicePicker = () => screen.queryByRole('combobox', { name: /bots.devicePicker.switchDevice/ });
const pickerDevice = (device: string) => `bots.devicePicker.switchDevice:${JSON.stringify({ device })}`;

// Unit regression: dragging a companion row must carry that chat to the
// split/window receiver without producing a bogus task link.
it('starts a task-style window drag from the companion row', async () => {
  mocks.profiles = [bot({ id: 'mate', name: 'Mate' })];
  await renderSidebar();
  const data = new Map<string, string>();
  const row = rowButton('Mate');
  expect(row.draggable).toBe(true);
  fireEvent.dragStart(row, { dataTransfer: { setData: (key: string, value: string) => data.set(key, value) } });
  expect([...data.values()]).toEqual(['/bots/mate']);
  fireEvent.dragEnd(row);
});

describe('one Cindy entry across devices', () => {
  // #8585, unit: two legacy Cindy choices must not absorb the newly reachable
  // same-home cloud recovery row, which is intentionally outside their picker.
  it('keeps cloud recovery separate from the legacy Cindy picker', async () => {
    mocks.profiles = [{ ...bot({ id: 'legacy-local', name: 'Legacy local' }), templateId: 'cindy' },
      bot({ id: 'cindy-default', name: 'Recovered Cindy' })];
    mocks.remoteBots = [{ ...remote('legacy-desk', 'Legacy desk'), id: 'legacy-remote', templateId: 'cindy' }];
    mocks.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: ['cindy-default'], actors: [
      { id: 'actor-cindy', externalId: 'cindy-default', name: 'Recovered Cindy', avatar: null, homeDeviceId: 'desk' }] };
    await renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /Recovered Cindy/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/desk/cindy-default');
  });
  const remote = (deviceId: string, deviceName: string, extra = {}) => ({
    id: 'cindy-default', deviceId, deviceName, name: 'Cindy', avatar: '🤖', avatarColor: 'violet',
    description: '', preview: `${deviceName} preview`, activityAt: 1, sessionId: `${deviceId}-chat`, online: true, ...extra,
  });

  it('keeps the original local row and only offers switching while another Cindy exists', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    const view = await renderSidebar();
    expect(devicePicker()).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    fireEvent.click(rowButton('Cindy'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');

    mocks.remoteBots = [remote('cloud', 'Cloud', { online: false })];
    view.rerender(<TeammatesSection />);
    expect(screen.getAllByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toHaveLength(1);
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: pickerDevice('bots.devicePicker.local') })).toBeTruthy();

    mocks.remoteBots = [];
    view.rerender(<TeammatesSection />);
    expect(devicePicker()).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(rowButton('Cindy')).toBeTruthy();
  });

  it('keeps the original remote row when it is the only Cindy', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud', { online: false })];
    await renderSidebar();
    expect(devicePicker()).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    fireEvent.click(rowButton('Cindy'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
  });

  it('defaults to local Cindy while leaving custom same-name teammates separate', async () => {
    mocks.profiles = [{ ...bot({ id: 'cindy-default', name: 'Cindy' }), templateId: 'cindy' }];
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac'), { ...remote('other', 'Office'), id: 'custom' }];
    await renderSidebar();
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: pickerDevice('bots.devicePicker.local') })).toBeTruthy();
    // The merged entry plus the custom same-name teammate.
    expect(screen.getAllByRole('button', { name: /^Cindy(?: · |$)/ })).toHaveLength(2);
    fireEvent.click(cindyRowButton());
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/cindy-default');
    const custom = screen.getAllByRole('button', { name: /^Cindy(?: · |$)/ }).find(button => button !== cindyRowButton())!;
    fireEvent.click(custom);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/remote/other/custom');
  });

  it('follows the selected remote chat and returns to local when visiting another teammate', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Renamed Cindy' }), bot({ id: 'writer', name: 'Writer' })];
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    const view = await renderSidebar();
    fireEvent.keyDown(devicePicker()!, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Cloud/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
    mocks.params = { deviceId: 'cloud', botId: 'cindy-default' };
    view.rerender(<TeammatesSection />);
    expect(screen.getByRole('combobox', { name: pickerDevice('Cloud') })).toBeTruthy();
    expect(cindyRowButton().getAttribute('aria-current')).toBe('page');
    mocks.params = { botId: 'writer' };
    view.rerender(<TeammatesSection />);
    expect(screen.getByRole('combobox', { name: pickerDevice('bots.devicePicker.local') })).toBeTruthy();
    expect(cindyRowButton().getAttribute('aria-label')).toBe('Renamed Cindy');
    expect(cindyRowButton().hasAttribute('aria-current')).toBe(false);
    expect(rowButton('Writer').getAttribute('aria-current')).toBe('page');
    fireEvent.click(cindyRowButton());
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/cindy-default');
  });

  it.each([
    { generation: { phase: 'processing' as const, startedAt: 1 } },
    { teammateActivity: { phase: 'running' as const } },
  ])('shows another computer working on the merged row without switching devices: %j', async (running) => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', running)];
    const view = await renderSidebar();
    expect(cindyRow().getAttribute('data-teammate-status')).toBe('running');
    expect(hasSpinner(cindyRow())).toBe(true);
    expect(screen.getByRole('combobox', { name: pickerDevice('bots.devicePicker.local') })).toBeTruthy();
    fireEvent.click(cindyRowButton());
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');

    mocks.remoteBots = [remote('cloud', 'Cloud')];
    view.rerender(<TeammatesSection />);
    expect(cindyRow().getAttribute('data-teammate-status')).toBe('idle');
    expect(hasSpinner(cindyRow())).toBe(false);
  });

  // The selected remote Cindy can retain only its running snapshot after refresh.
  it('keeps selected remote work visible with only a running snapshot', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { teammateActivity: { phase: 'running' } })];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    const view = await renderSidebar();
    expect(cindyRow().getAttribute('data-teammate-status')).toBe('running');
    expect(cindyRowButton().getAttribute('aria-current')).toBe('page');
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    view.rerender(<TeammatesSection />);
    expect(hasSpinner(cindyRow())).toBe(false);
  });

  it('shows local work while the selected remote computer is idle', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    mocks.islandActivity.set('cindy-default-chat', { sessionId: 'cindy-default-chat', phase: 'running' });
    await renderSidebar();
    expect(cindyRow().getAttribute('data-teammate-status')).toBe('running');
    expect(screen.getByRole('combobox', { name: pickerDevice('Cloud') })).toBeTruthy();
    fireEvent.click(cindyRowButton());
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
  });

  it('keeps remote unread discoverable without opening the chat or switching away from local', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { lastReplyAt: 20, readAt: 10, online: false })];
    await renderSidebar();
    expect(screen.getByLabelText('bots.devicePicker.otherUnread')).toBeTruthy();
    fireEvent.keyDown(devicePicker()!, { key: 'ArrowDown' });
    const cloud = await screen.findByRole('option', { name: /Cloud/ });
    expect(cloud.textContent).toContain('bots.remote.offline');
    expect(cloud.getAttribute('aria-selected')).toBe('false');
    expect(within(cloud).getByLabelText('bots.devicePicker.unread')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('prefers local Cindy when local profiles arrive after the remote roster', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    const view = await renderSidebar();
    expect(screen.getByRole('combobox', { name: pickerDevice('Cloud') })).toBeTruthy();

    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    view.rerender(<TeammatesSection />);
    expect(screen.getByRole('combobox', { name: pickerDevice('bots.devicePicker.local') })).toBeTruthy();
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('follows a remote deep link and falls back to local if that device is removed', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    const view = await renderSidebar();
    expect(screen.getByRole('combobox', { name: pickerDevice('Cloud') })).toBeTruthy();
    expect(cindyRowButton().getAttribute('aria-current')).toBe('page');
    mocks.remoteBots = [];
    view.rerender(<TeammatesSection />);
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(rowButton('Cindy').hasAttribute('aria-current')).toBe(false);
    fireEvent.click(rowButton('Cindy'));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/bots/cindy-default');
  });

  it('offers a remote-only group without recreating a deleted local Cindy', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    await renderSidebar();
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: pickerDevice('Cloud') })).toBeTruthy();
    fireEvent.keyDown(devicePicker()!, { key: 'ArrowDown' });
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent)).not.toContain('bots.devicePicker.local');
    expect(options).toHaveLength(2);
  });
});

describe('remote and local teammate rows', () => {
  // PR #8714: after a resource refresh fails, the remote activity snapshot remains
  // running without generation details. The real row must still show work.
  it('keeps standalone remote work visible when only the running snapshot remains', async () => {
    mocks.remoteBots = [{ id: 'remote-bot', deviceId: 'studio', deviceName: 'Studio',
      name: 'Writer', avatar: '🤖', avatarColor: 'violet', description: '', preview: 'Previous reply',
      activityAt: 1, sessionId: 'remote-session', online: true,
      teammateActivity: { phase: 'running' } }];
    const view = await renderSidebar();
    expect(statusOf('Writer')).toBe('running');
    expect(hasSpinner(rowOf(rowButton('Writer')))).toBe(true);
    fireEvent.click(rowButton('Writer'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/studio/remote-bot');
    mocks.remoteBots = mocks.remoteBots.map(bot => ({ ...bot, teammateActivity: { phase: 'idle' } }));
    view.rerender(<TeammatesSection />);
    expect(statusOf('Writer')).toBe('idle');
    expect(hasSpinner(rowOf(rowButton('Writer')))).toBe(false);
  });

  it('keeps same-name local and remote teammates as separate rows with their own routes', async () => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy' })];
    mocks.devices = [{ deviceId: 'local-device', name: 'MBP-M5', isSelf: true }];
    mocks.remoteBots = [{ id: 'remote-bot', deviceId: 'remote-device', deviceName: 'Mac-Studio',
      name: 'Cindy', avatar: '🤖', avatarColor: 'violet', description: '', preview: 'Remote preview',
      activityAt: 1, sessionId: 'remote-session', online: true }];
    const view = await renderSidebar();
    expect(view.container.innerHTML).not.toContain('MBP-M5');
    const rows = screen.getAllByRole('button', { name: /^Cindy(?: · |$)/ });
    expect(rows).toHaveLength(2);
    rows.forEach(row => fireEvent.click(row));
    expect(mocks.navigate.mock.calls.map(([route]) => route).sort())
      .toEqual(['/bots/local-bot', '/bots/remote/remote-device/remote-bot']);
  });

  it.each(['Thinking', 'Generating'])('shows %s work as the running spinner and drops it when idle', async (compactDetail) => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy' })];
    mocks.islandActivity.set('local-bot-chat', { sessionId: 'local-bot-chat', phase: 'running', compactDetail });
    const view = await renderSidebar();
    expect(screen.queryByText(compactDetail)).toBeNull();
    expect(statusOf('Cindy')).toBe('running');
    expect(hasSpinner(rowOf(rowButton('Cindy')))).toBe(true);
    mocks.islandActivity.clear();
    view.rerender(<TeammatesSection />);
    expect(statusOf('Cindy')).toBe('idle');
    expect(hasSpinner(rowOf(rowButton('Cindy')))).toBe(false);
  });

  it('shows delegated work on the delegating teammate row', async () => {
    mocks.profiles = [{ ...bot({ id: 'local-bot', name: 'Cindy' }), sessions: [
      { id: 'local-bot-chat', kind: 'chat' }, { id: 'delegated', kind: 'task', role: 'delegation' },
    ] }];
    mocks.islandActivity.set('delegated', { sessionId: 'delegated', phase: 'running', compactDetail: ' ' });
    await renderSidebar();
    expect(statusOf('Cindy')).toBe('running');
  });

  // Regression vs. main: the old row showed 「正在输入…」 for any visible task lane
  // running (botRunningActivity), e.g. a routine or thread run. Unit, real section.
  it('shows work running in a non-delegation task lane', async () => {
    mocks.profiles = [{ ...bot({ id: 'local-bot', name: 'Cindy' }), sessions: [
      { id: 'local-bot-chat', kind: 'chat' }, { id: 'routine-run', kind: 'task', role: 'routine' },
    ] }];
    mocks.islandActivity.set('routine-run', { sessionId: 'routine-run', phase: 'running' });
    await renderSidebar();
    expect(statusOf('Cindy')).toBe('running');
  });
});

describe('TeammatesSection status and attention', () => {
  it('marks the open chat without acknowledging its unread reply', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' }), bot({ id: 'bot-2', name: 'Writer' })];
    mocks.unread = { 'bot-1': 2 };
    mocks.params = { botId: 'bot-1' };
    await renderSidebar();
    // Routing alone does not acknowledge a reply; the existing read receipt owns clearing.
    expect(screen.getByRole('button', { name: 'PR steward · bots.avatarStatus.unread' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Writer' }).hasAttribute('aria-current')).toBe(false);
  });

  it('keeps a completed unread reply bold after the live snapshot is removed, then clears on read', async () => {
    mocks.profiles = [{ ...bot({ id: 'bot-1', name: 'Writer' }), lastMessageRole: 'assistant' }];
    mocks.unread = { 'bot-1': 1 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'completed' }]]);
    const view = await renderSidebar();
    expect(statusOf('Writer')).toBe('done');
    expect(isBold(rowOf(rowButton('Writer')))).toBe(true);
    // Idle is represented by no activity entry, not an AgentIslandSessionPhase.
    mocks.islandActivity = new Map();
    view.rerender(<TeammatesSection />);
    expect(statusOf('Writer')).toBe('done');
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(statusOf('Writer')).toBe('idle');
    expect(isBold(rowOf(rowButton('Writer')))).toBe(false);
  });

  it('keeps a pending decision ahead of an error like the shared resolver, even after read acknowledgement', async () => {
    mocks.profiles = [{ ...bot({ id: 'bot-1', name: 'Writer' }), needsAttention: true }];
    mocks.unread = { 'bot-1': 1 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'needs-interaction' }]]);
    const view = await renderSidebar();
    expect(statusOf('Writer')).toBe('awaiting');
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(statusOf('Writer')).toBe('awaiting');
    expect(isBold(rowOf(rowButton('Writer')))).toBe(true);
  });

  // The top 「伙伴」 tab bolds from this callback (unit, real section).
  it('reports attention for unread, pending and failed chats, and clears once resolved', async () => {
    const onAttentionChange = vi.fn();
    mocks.profiles = [bot({ id: 'bot-1', name: 'Writer' })];
    const view = render(<TeammatesSection onAttentionChange={onAttentionChange} />);
    expect(onAttentionChange).toHaveBeenLastCalledWith(false);
    mocks.unread = { 'bot-1': 1 };
    view.rerender(<TeammatesSection onAttentionChange={onAttentionChange} />);
    expect(onAttentionChange).toHaveBeenLastCalledWith(true);
    mocks.unread = {};
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'needs-interaction' }]]);
    view.rerender(<TeammatesSection onAttentionChange={onAttentionChange} />);
    expect(onAttentionChange).toHaveBeenLastCalledWith(true);
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    view.rerender(<TeammatesSection onAttentionChange={onAttentionChange} />);
    expect(onAttentionChange).toHaveBeenLastCalledWith(false);
    mocks.islandActivity = new Map();
    mocks.profiles = [{ ...bot({ id: 'bot-1', name: 'Writer' }), needsAttention: true }];
    view.rerender(<TeammatesSection onAttentionChange={onAttentionChange} />);
    expect(onAttentionChange).toHaveBeenLastCalledWith(true);
  });

  // Every chat is listed (no five-row preview); pinned first, then most recent.
  it('lists every chat with pinned teammates first, then by latest activity', async () => {
    mocks.profiles = [
      bot({ id: 'a', name: 'Alpha', lastMessageAt: 10 }),
      bot({ id: 'b', name: 'Bravo', lastMessageAt: 30 }),
      { ...bot({ id: 'c', name: 'Charlie', lastMessageAt: 5 }), pinnedAt: 1 },
      bot({ id: 'd', name: 'Delta', lastMessageAt: 1 }),
      bot({ id: 'e', name: 'Echo', lastMessageAt: 2 }),
      bot({ id: 'f', name: 'Foxtrot', lastMessageAt: 3 }),
    ];
    mocks.remoteBots = [{ id: 'r', deviceId: 'studio', deviceName: 'Studio', name: 'Remote', avatar: '🤖',
      avatarColor: 'violet', description: '', preview: '', activityAt: 20, sessionId: 'r-chat', online: true }];
    const view = await renderSidebar();
    const names = [...view.container.querySelectorAll('[data-teammate-row] span[title]')].map(span => span.textContent);
    expect(names).toEqual(['Charlie', 'Bravo', 'Remote', 'Alpha', 'Foxtrot', 'Echo', 'Delta']);
  });

  it('leaves session notifications to the task sidebar', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.params = { botId: 'bot-1' };
    await renderSidebar();
    expect(mocks.observeSession).not.toHaveBeenCalled();
  });
});

describe('TeammatesSection running spinner', () => {
  it('shows the gray running spinner while a turn is in progress', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward', lastMessagePreview: 'Two checks are still red on #2829' })];
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    const view = await renderSidebar();
    expect(statusOf('PR steward')).toBe('running');
    expect(hasSpinner(rowOf(rowButton('PR steward')))).toBe(true);
    expect(view.container.textContent).not.toContain('Two checks are still red');
  });

  it('drops the spinner once the turn completes', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    // completed 不是 running:同一份镜像里的终态不该继续转圈。
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'completed' }]]);
    await renderSidebar();
    expect(statusOf('PR steward')).not.toBe('running');
    expect(hasSpinner(rowOf(rowButton('PR steward')))).toBe(false);
  });

  it('只认这个伙伴自己的主任务 —— 别人的会话在跑不该点亮这一行', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.islandActivity = new Map([['someone-else', { sessionId: 'someone-else', phase: 'running' }]]);
    await renderSidebar();
    expect(statusOf('PR steward')).toBe('idle');
    expect(hasSpinner(rowOf(rowButton('PR steward')))).toBe(false);
  });

  it('lets running take precedence over unread without bolding the name', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.unread = { 'bot-1': 4 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    await renderSidebar();
    const row = rowOf(rowButton('PR steward'));
    expect(row.getAttribute('data-teammate-status')).toBe('running');
    expect(hasSpinner(row)).toBe(true);
    expect(isBold(row)).toBe(false);
  });
});

function UnreadSync() { useBotUnreadSync(); return null; }

describe('TeammatesSection rows', () => {
  it('shows durable Hermes attention without reviving the permissions badge', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Needs help', needsAttention: true })];

    await renderSidebar();

    const row = screen.getByRole('button', { name: 'Needs help · bots.avatarStatus.error' });
    expect(rowOf(row).getAttribute('data-teammate-status')).toBe('error');
    expect(isBold(rowOf(row))).toBe(true);
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

  it('reveals hidden Bots on demand and can unhide or open them', async () => {
    mocks.profiles = [bot({ id: 'visible', name: 'Visible' }), { ...bot({ id: 'hidden', name: 'Hidden' }), hiddenAt: 2 }];
    await renderSidebar();
    const toggle = screen.getByRole('button', { name: 'bots.list.hidden:{"count":1}' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByText('Hidden'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/hidden');
    fireEvent.click(screen.getByRole('button', { name: 'bots.list.unhideNamed:{"name":"Hidden"}' }));
    expect(mocks.setBotHidden).toHaveBeenCalledExactlyOnceWith('hidden', false);
  });

  it('never marks a row with the hands-on ⚠ badge', async () => {
    mocks.profiles = [
      bot({ id: 'bot-asks', name: 'Asks first' }),
      { ...bot({ id: 'bot-trusted', name: 'Hands on' }), capabilities: { permissions: 'trusted' } },
    ];

    await renderSidebar();

    // 产品裁决 2026-08-18:伙伴列表是聊天列表,不是权限看板。
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
  });

  it('carries no health icon column at all — a chat row answers "any new messages", nothing else', async () => {
    mocks.profiles = [
      bot({ id: 'bot-healthy', name: 'Healthy' }),
      bot({ id: 'bot-attention', name: 'Attention' }),
    ];
    mocks.health.set('bot-attention', 'attention');

    await renderSidebar();

    await waitFor(() => expect(screen.getByText('Attention')).toBeTruthy());
    for (const status of ['attention', 'recovering', 'paused', 'healthy']) {
      expect(screen.queryByLabelText(`bots.lifecycle.healthStatus.${status}`)).toBeNull();
    }
  });

  it('marks unread Bots with a bold name only, regardless of count', async () => {
    mocks.profiles = [
      bot({ id: 'bot-read', name: 'Read' }),
      bot({ id: 'bot-unread', name: 'Unread' }),
      bot({ id: 'bot-flooded', name: 'Flooded' }),
    ];
    mocks.unread = { 'bot-unread': 3, 'bot-flooded': 100 };

    const view = await renderSidebar();

    expect(statusOf('Unread')).toBe('unread');
    expect(statusOf('Flooded')).toBe('unread');
    expect(statusOf('Read')).toBe('idle');
    expect(isBold(rowOf(rowButton('Unread')))).toBe(true);
    expect(isBold(rowOf(rowButton('Flooded')))).toBe(true);
    expect(isBold(rowOf(rowButton('Read')))).toBe(false);
    // No counts: neither 99+ nor a zero badge on read rows.
    // Rows carry names only: no 99+, no count, no zero badge.
    expect(view.container.textContent).toBe('FloodedReadUnread');
  });

  it('keeps settings and import out of each row while the row itself opens chat', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();

    // 进设置的入口收敛到对话顶栏;导入下沉到创建面板与「设置 › 伙伴」。
    expect(screen.queryByRole('button', { name: 'bots.settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.portability.import' })).toBeNull();

    fireEvent.click(rowButton('PR steward'));
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
    fireEvent.mouseOver(rowButton('PR steward'));
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeNull();
    expect(screen.queryByTestId('bot-delete-dialog')).toBeNull();

    fireEvent.contextMenu(rowButton('PR steward'));

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.hide' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.duplicate' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' }));
    expect(screen.getByTestId('bot-delete-dialog').textContent).toBe('PR steward');
  });

  it.each([
    { button: 2, ctrlKey: false },
    { button: 0, ctrlKey: true },
    { button: 0, ctrlKey: false },
  ])('does not select Pin on the opening release ($button / ctrl=$ctrlKey)', async (pointer) => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    await renderSidebar();
    fireEvent.contextMenu(rowButton('PR steward'), { clientX: 120, clientY: 180 });
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
    const row = rowButton('PR steward');
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

  // Regression: roster writes are not optimistic, so a rejected pin / hide used to
  // leave the row unchanged with no feedback (an unhandled rejection).
  it.each([
    { item: 'bots.list.pin', write: () => mocks.setBotPinned, message: 'bots.list.pinFailed' },
    { item: 'bots.list.hide', write: () => mocks.setBotHidden, message: 'bots.list.hideFailed' },
  ])('reports a failed $item instead of silently doing nothing', async ({ item, write, message }) => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.params = { botId: 'bot-1' };
    write().mockRejectedValueOnce(new Error('ipc down'));
    await renderSidebar();
    fireEvent.contextMenu(rowButton('PR steward'));
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(message));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  // Regression: duplicating reads the avatar and waits for the new profile with no
  // progress, and a missing default model rejected silently.
  it.each([
    { error: new BotModelSelectionRequiredError(), message: 'bots.list.duplicateModelRequired' },
    { error: new Error('create failed'), message: 'bots.list.duplicateFailed' },
  ])('shows duplicate progress as running in the row, then explains $message', async ({ error, message }) => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    let reject!: (reason: unknown) => void;
    mocks.duplicateBotProfile.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await renderSidebar();
    fireEvent.contextMenu(rowButton('PR steward'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'bots.list.duplicate' }));
    await waitFor(() => expect(statusOf('PR steward')).toBe('running'));
    expect(hasSpinner(rowOf(rowButton('PR steward')))).toBe(true);

    // A second request while the first is in flight must not start another copy.
    fireEvent.contextMenu(rowButton('PR steward'));
    const again = await screen.findByRole('menuitem', { name: 'bots.list.duplicate' });
    expect(again.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(again);
    expect(mocks.duplicateBotProfile).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await act(async () => { reject(error); });
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(message);
    expect(statusOf('PR steward')).toBe('idle');
    expect(mocks.navigate).not.toHaveBeenCalled();
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

  // Regression / unit: the real sync hook must still refresh even if an older
  // list read replaces profiles during the 120 ms refresh window.
  it('keeps a pending message refresh when an older list response replaces profiles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const old = bot({ id: 'bot-1', name: 'PR steward' });
    mocks.profiles = [old];
    const view = render(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();

    act(() => { for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' }); });
    mocks.profiles = [{ ...old }];
    view.rerender(<UnreadSync />);
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(120); });
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
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

  // Unit regression: final-seal and message events previously used independent
  // refresh paths. One burst must refresh once; later tool rows still refresh.
  it('coalesces a turn stop with its final message and still accepts late tool rows', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.running = new Map([['bot-1-chat', { isRunning: true }]]);
    const view = render(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();
    mocks.running = new Map();
    view.rerender(<UnreadSync />);
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role: 'assistant' } });
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);

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
    mocks.profiles = [bot({ id: 'bot-2', name: "New buddy" })];
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
    expect(rowButton('Ada')).toBeTruthy();
    expect(screen.getAllByText('Mia')).toHaveLength(1);
    // A cloud companion on an offline home computer stays quiet, not failed.
    expect(statusOf('Mia')).toBe('idle');
    fireEvent.click(rowButton('Mia'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia');
  });

  it('does not offer a demoted local Cindy as the local option', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [{ id: 'cindy-default', deviceId: 'laptop', deviceName: 'Laptop', name: 'Cindy', avatar: '🤖',
      avatarColor: 'violet', description: '', preview: 'Laptop preview', activityAt: 1, sessionId: 'laptop-chat', online: true }];
    mocks.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: ['cindy-default'],
      actors: [{ id: 'a-cindy', externalId: 'cindy-default', name: 'Cindy', avatar: null, homeDeviceId: 'laptop' }] };
    await renderSidebar();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Cindy(?: · |$)/ })).toHaveLength(1);
    fireEvent.click(rowButton('Cindy'));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/bots/remote/laptop/cindy-default');
  });
});

// #9978 / unit: mount the production sidebar with its real store. Existing row
// fixtures replaced the store and could not distinguish a failed read from empty.
describe('startup roster read failures', () => {
  it('keeps failed startup distinct from empty and recovers through the visible retry', async () => {
    mocks.realStore = true;
    const store = await vi.importActual<typeof import('../botStore')>('../botStore');
    setDataOwnerGeneration('startup-failed');
    const list = vi.fn().mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] DbClient not ready'))
      .mockResolvedValue([bot({ id: 'existing', name: 'Existing buddy' })]);
    window.electronAPI.localDb!.bots = { list } as never;
    await store.ensureBotProfilesLoaded();
    await renderSidebar();
    expect(screen.queryByRole('button', { name: 'bots.add' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.rosterReload' }));
    await waitFor(() => expect(store.getBotProfiles().map(row => row.id)).toEqual(['existing']));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowButton('Existing buddy')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('waits for a successful empty snapshot before offering empty-roster creation', async () => {
    mocks.realStore = true;
    const store = await vi.importActual<typeof import('../botStore')>('../botStore');
    setDataOwnerGeneration('startup-empty');
    let finish!: (rows: unknown[]) => void;
    const list = vi.fn(() => new Promise<unknown[]>(resolve => { finish = resolve; }));
    window.electronAPI.localDb!.bots = { list } as never;
    const pending = store.ensureBotProfilesLoaded();
    render(<TeammatesSection />);
    try {
      expect(screen.queryByRole('button', { name: 'bots.add' })).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('ccAgent.common.loading');
    } finally {
      await act(async () => { finish([]); await pending; });
    }
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'bots.add' })).toBeTruthy();
    expect(list).toHaveBeenCalledOnce();
  });
});

// #9706 / unit-jsdom: loading must remain visible until the current-owner read
// succeeds. Execute the production store/section and settle the read in finally.
it('shows the pending roster until its current-owner read succeeds', async () => {
  mocks.realStore = true;
  const store = await vi.importActual<typeof import('../botStore')>('../botStore');
  setDataOwnerGeneration('startup-pending');
  let finish!: (rows: unknown[]) => void;
  const list = vi.fn(() => new Promise<unknown[]>(resolve => { finish = resolve; }));
  window.electronAPI.localDb!.bots = { list } as never;
  const pending = store.ensureBotProfilesLoaded();
  render(<TeammatesSection />);
  try {
    expect(screen.getByRole('status').textContent).toContain('ccAgent.common.loading');
    expect(screen.queryByRole('button', { name: 'bots.add' })).toBeNull();
  } finally {
    await act(async () => { finish([bot({ id: 'existing', name: 'Existing buddy' })]); await pending; });
  }
  expect(screen.queryByRole('status')).toBeNull();
  expect(rowButton('Existing buddy')).toBeTruthy();
  expect(store.getBotProfiles().map(row => row.id)).toEqual(['existing']);
  expect(list).toHaveBeenCalledOnce();
});
