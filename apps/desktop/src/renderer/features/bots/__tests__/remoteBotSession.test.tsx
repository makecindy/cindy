// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseRemoteResourceGetRequest } from '@cindy/device-link';
import { resolveBotChatIdentity } from '../botChatPresentation';
import type { BotChatBinding } from '../botChatPresentation';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  markRead: vi.fn(),
  retryRoster: vi.fn(),
  pin: vi.fn(),
  merge: vi.fn(),
  view: vi.fn(),
  navigate: vi.fn(),
  requestedSessionId: undefined as string | undefined,
  online: true,
  connectionKnown: undefined as boolean | undefined,
  listed: true,
  cached: false,
  lastReplyAt: 0,
  devices: null as Array<{ deviceId: string; online: boolean; remoteControlEnabled: boolean; controlEnabled?: boolean }> | null,
  deviceListStatus: 'ready' as 'loading' | 'ready' | 'error',
  deviceListAuthoritative: true,
  profileLoadState: 'ready' as 'pending' | 'ready' | 'error',
  cloud: { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] } as import('../../../../shared/companionCloud').CompanionCloudSnapshot,
  cloudView: vi.fn(),
  relayStatus: null as ((state: { status: 'stopped' | 'connecting' | 'online' }) => void) | null,
}));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => h.cloud }));
vi.mock('../botStore', () => ({ useBotProfilesLoadState: () => h.profileLoadState }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => h.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: h.deviceListStatus, error: null }),
  useDeviceLinkDeviceListAuthoritative: () => h.deviceListAuthoritative,
}));
vi.mock('../CloudCompanionOfflineView', () => ({
  CloudCompanionOfflineView: (props: unknown) => { h.cloudView(props); return <div>cloud-offline-view</div>; },
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ search: '?keep=1', state: { searchJump: { messageClientId: 'reply' } } }),
  Navigate: (props: unknown) => { h.navigate(props); return <div>original-task</div>; },
  useParams: () => ({ deviceId: 'home', botId: 'writer', sessionId: h.requestedSessionId }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useRemoteBots', () => ({
  markRemoteBotRead: h.markRead,
  retryRemoteBotRoster: h.retryRoster,
  useRemoteBots: () => !h.listed ? [] : [
    {
      id: 'writer',
      deviceId: 'home',
      deviceName: 'Home',
      name: 'Writer',
      avatar: '',
      avatarColor: '',
      sessionId: 'old-canonical',
      online: h.online,
      connectionKnown: h.connectionKnown,
      lastReplyAt: h.lastReplyAt,
    },
  ],
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    pinSessionOrigin: h.pin,
    getSessionDeviceId: (id: string) => h.cached && id === 'old-canonical' ? 'home' : undefined,
    mergeDeviceSessions: h.merge,
    getDeviceSessions: () => h.cached ? [{ id: 'old-canonical', source: 'bot', status: 'active' }] : [],
    captureSessionRead: () => Object.assign(() => true, { mergeActivity: <T,>(detail: T) => detail }),
  },
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: (props: unknown) => {
    h.view(props);
    return <div>remote-conversation</div>;
  },
}));
import { CLOUD_HOME_GRACE_MS, RemoteBotSessionView } from '../RemoteBotSessionView';
import { FIRST_CONNECTION_WINDOW_MS, startDeviceLinkFirstConnectionWatch, useDeviceLinkFirstConnectionPending } from '@/features/device-link/deviceLinkFirstConnection';
beforeEach(() => {
  h.markRead.mockClear();
  h.retryRoster.mockClear();
  h.navigate.mockReset();
  h.requestedSessionId = undefined;
  h.online = true;
  h.connectionKnown = undefined;
  h.listed = true;
  h.cached = false;
  h.lastReplyAt = 0;
  h.cloud = { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] };
  h.devices = null;
  h.deviceListStatus = 'ready';
  h.deviceListAuthoritative = true;
  h.profileLoadState = 'ready';
  h.cloudView.mockReset();
  h.pin.mockReset();
  h.merge.mockReset();
  h.view.mockReset();
  h.invoke.mockReset().mockImplementation(async (_device, channel, args) => {
    if (channel === 'maker:remote-resources:get') {
      expect(parseRemoteResourceGetRequest(args[0])).not.toBeNull();
      return {
        ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' },
        display: { title: 'Writer' },
        links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'new-canonical' } }],
      };
    }
    expect(h.pin).toHaveBeenCalledWith('home', 'new-canonical');
    expect(args).toEqual(['new-canonical']);
    return { id: 'new-canonical', source: 'bot', status: 'active' };
  });
  window.electronAPI = { deviceLink: {
    invoke: h.invoke,
    getState: async () => ({ linkStatus: 'online' }),
    onStatusChanged: (fn: NonNullable<typeof h.relayStatus>) => { h.relayStatus = fn; return () => undefined; },
  } } as unknown as Window['electronAPI'];
  // The relay is online and the directory settled unless a test drops it, so every test starts
  // past the first-connection window regardless of order.
  startDeviceLinkFirstConnectionWatch();
  act(() => h.relayStatus?.({ status: 'online' }));
  renderHook(() => useDeviceLinkFirstConnectionPending()).unmount();
});
afterEach(cleanup);
// #9629, unit tier: the real route component must follow a confirmed remote
// home despite a cached former row (or no row), without adopting a pinned task.
// Existing offline tests keep the same home; they did not cover home changes.
it.each([true, false])('follows the current remote home with a former roster row: %s', async listed => {
  h.listed = listed;
  h.online = false;
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'next-home' }] };
  render(<RemoteBotSessionView />);
  expect(h.navigate).toHaveBeenLastCalledWith({
    to: '/bots/remote/next-home/writer?keep=1', state: { searchJump: { messageClientId: 'reply' } }, replace: true,
  });
  expect(h.cloudView).not.toHaveBeenCalled();
  expect(h.view).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(['disabled', 'unknown', 'same', 'local-pending'] as const)('does not guess a different remote home when %s', condition => {
  h.online = false;
  const home = condition === 'unknown' ? null : condition === 'same' ? 'home' : condition === 'local-pending' ? 'desk' : 'next-home';
  h.cloud = { enabled: condition !== 'disabled', selfDeviceId: 'desk', humanActorId: 'human',
    demotedBotIds: condition === 'local-pending' ? ['writer'] : [], actors: [
      { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: home }] };
  render(<RemoteBotSessionView />);
  expect(h.navigate).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});

it('disposes a former-home lookup when the confirmed home changes while it is in flight', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RemoteBotSessionView />);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'next-home' }] };
  view.rerender(<RemoteBotSessionView />);
  expect(h.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: '/bots/remote/next-home/writer?keep=1' }));
  await act(async () => finish({
    ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' }, display: { title: 'Writer' },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'old-canonical' } }],
  }));
  expect(h.pin).not.toHaveBeenCalled();
  expect(h.merge).not.toHaveBeenCalled();
  expect(h.view).not.toHaveBeenCalled();
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it('keeps a pinned task on its original computer after its companion moves', async () => {
  h.requestedSessionId = 'old-canonical';
  h.online = false;
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'next-home' }] };
  render(<RemoteBotSessionView />);
  expect(h.navigate).toHaveBeenLastCalledWith({ to: '/cc-agent/old-canonical?keep=1&device=home',
    state: { searchJump: { messageClientId: 'reply' } }, replace: true });
  expect(h.invoke).not.toHaveBeenCalled();
});

// #10112, unit tier: the former-home route must show the local failure rather
// than spin forever; automatic recovery follows the completed home projection.
// #8585, unit: a same-home install shadow without a validation failure must be
// reachable from both its cloud row and a former-home link, even with stale rows.
it.each([true, false])('opens read-only local installation recovery with a stale listed row: %s', async listed => {
  h.listed = listed;
  h.cached = listed;
  h.cloud = { enabled: true, selfDeviceId: 'home', humanActorId: 'human', demotedBotIds: ['writer'], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  const view = render(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ botId: 'writer', deviceId: 'home' }));
  expect(h.view).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.navigate).not.toHaveBeenCalled();
  h.cloud = { ...h.cloud, demotedBotIds: [] };
  view.rerender(<RemoteBotSessionView />);
  expect(h.navigate).toHaveBeenLastCalledWith({ to: '/bots/writer', replace: true });
});

it('keeps the recovered buddy mounted until local profiles are hydrated', async () => {
  h.profileLoadState = 'pending';
  h.cloud = { enabled: true, selfDeviceId: 'home', humanActorId: 'human', demotedBotIds: ['writer'], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  const view = render(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');

  h.cloud = { ...h.cloud, demotedBotIds: [] };
  view.rerender(<RemoteBotSessionView />);
  expect(h.navigate).not.toHaveBeenCalled();
  expect(screen.getByText('cloud-offline-view')).toBeTruthy();

  h.profileLoadState = 'ready';
  view.rerender(<RemoteBotSessionView />);
  expect(h.navigate).toHaveBeenLastCalledWith({ to: '/bots/writer', replace: true });
});

it.each([true, false])('keeps rejected local source editing open until recovery (demoted: %s)', async demoted => {
  h.listed = false;
  const failure = { field: 'identitySource' as const, maxLength: 12000 };
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: demoted ? ['writer'] : [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'desk', profileFailure: failure }] };
  const view = render(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ botId: 'writer', profileFailure: failure }));
  expect(h.view).not.toHaveBeenCalled();
  expect(h.navigate).not.toHaveBeenCalled();
  h.cloud = { ...h.cloud, demotedBotIds: [], actors: h.cloud.actors.map(({ profileFailure: _, ...actor }) => actor) };
  view.rerender(<RemoteBotSessionView />);
  expect(h.navigate).toHaveBeenLastCalledWith({ to: '/bots/writer', replace: true });
});
// Unit regression: an exact notification link must retain its task, host and anchor
// when the canonical link changed, its host is offline, or the companion lookup fails.
it.each(['changed', 'offline', 'failed'] as const)('preserves the original task when the companion is %s', async (reason) => {
  h.requestedSessionId = 'old-canonical';
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  if (reason === 'offline') h.online = false;
  if (reason === 'failed') h.invoke.mockRejectedValue(new Error('Unavailable'));
  render(<RemoteBotSessionView />);
  await screen.findByText('original-task');
  expect(h.navigate).toHaveBeenLastCalledWith({
    to: '/cc-agent/old-canonical?keep=1&device=home',
    state: { searchJump: { messageClientId: 'reply' } }, replace: true,
  });
  expect(h.view).not.toHaveBeenCalled();
  expect(h.cloudView).not.toHaveBeenCalled();
  expect(h.markRead).not.toHaveBeenCalled();
});
// Unit regression: a host conversation link + active bot session must reach the shared
// parent chat as canonical, or its post-send follow-up invitation can never appear.
it('resolves the latest canonical task and passes its verified identity to writable chat', async () => {
  const { rerender } = render(<RemoteBotSessionView />);
  await screen.findByText('remote-conversation');
  expect(h.merge).toHaveBeenCalledWith('home', 'Home', [
    expect.objectContaining({ id: 'new-canonical' }),
  ]);
  expect(h.view).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionIdProp: 'new-canonical', routeOwner: true, readOnly: false,
      botIdentity: expect.objectContaining({ id: 'writer', sessionId: 'new-canonical', canonicalChat: true }),
    }),
  );
  expect(h.markRead).not.toHaveBeenCalled();
  const identity = h.view.mock.lastCall![0].botIdentity;
  expect(resolveBotChatIdentity(identity as BotChatBinding, 'new-canonical')?.canonicalChat).toBe(true);
  const requestCount = h.invoke.mock.calls.length;
  h.lastReplyAt = 123;
  rerender(<RemoteBotSessionView />);
  expect(h.view.mock.lastCall![0].botIdentity).toBe(identity);
  expect(h.invoke).toHaveBeenCalledTimes(requestCount);
  act(() => h.view.mock.lastCall![0].onBotReadThrough(100));
  expect(h.markRead).toHaveBeenLastCalledWith('home', 'writer', 100);
  h.online = false;
  rerender(<RemoteBotSessionView />);
  await waitFor(() =>
    expect(h.view).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true })),
  );
  expect(h.view.mock.lastCall![0].botIdentity).toBe(identity);
});
it('never mounts a task with a mismatched authoritative source', async () => {
  h.invoke
    .mockImplementationOnce(async () => ({
      ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' },
      display: { title: 'Writer' },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'new-canonical' } }],
    }))
    .mockResolvedValueOnce({ id: 'new-canonical', source: 'desktop' });
  await act(async () => {
    render(<RemoteBotSessionView />);
  });
  await screen.findByText('bots.sessionLoadFailedDescription');
  expect(h.view).not.toHaveBeenCalled();
});
it('keeps the open chat through a brief drop, then shows the cloud conversation when the main computer stays offline', async () => {
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  const { rerender } = render(<RemoteBotSessionView />);
  await screen.findByText('remote-conversation');
  vi.useFakeTimers();
  try {
    h.online = false;
    rerender(<RemoteBotSessionView />);
    act(() => { vi.advanceTimersByTime(CLOUD_HOME_GRACE_MS - 1); });
    expect(screen.queryByText('cloud-offline-view')).toBeNull();
    expect(screen.getByText('remote-conversation')).toBeTruthy();
    // Back before the grace ends: nothing changed for the reader.
    h.online = true;
    rerender(<RemoteBotSessionView />);
    h.online = false;
    rerender(<RemoteBotSessionView />);
    act(() => { vi.advanceTimersByTime(CLOUD_HOME_GRACE_MS - 1); });
    expect(screen.queryByText('cloud-offline-view')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
  } finally {
    vi.useRealTimers();
  }
  expect(await screen.findByText('cloud-offline-view')).toBeTruthy();
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ botId: 'writer', deviceId: 'home', name: 'Writer', deviceName: 'Home' }));
  // A confirmed different home leaves the former computer's chat altogether.
  h.cloud = { ...h.cloud, actors: [{ ...h.cloud.actors[0]!, homeDeviceId: 'elsewhere' }] };
  rerender(<RemoteBotSessionView />);
  expect(h.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: '/bots/remote/elsewhere/writer?keep=1' }));
});

// Unit, cloud-companions.md §3.1: right after launch or waking, the relay reports `stopped`
// (no client yet) or `connecting`, and a stale directory row may say the home is offline. Before,
// that opened the cloud view with "continue on this computer" at once and one click moved the
// companion off its always-on home. Minimal input: relay drops, home offline (with or without a
// roster row); until the window ends (or the relay is back and the directory settles) it reads
// "connecting" with a spinner.
const homeOfflineActor = () => {
  h.online = false;
  h.devices = [{ deviceId: 'home', online: false, remoteControlEnabled: true }];
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
};
it.each([['stopped', true], ['connecting', true], ['connecting', false]] as const)(
  'shows connecting, not offline or takeover, while the relay is %s right after a drop (row listed: %s)', async (status, listed) => {
    homeOfflineActor();
    h.listed = listed;
    vi.useFakeTimers();
    try {
      act(() => h.relayStatus?.({ status }));
      const view = render(<RemoteBotSessionView />);
      expect(screen.getByText('ccAgent.sidebar.machineSwitcher.connecting')).toBeTruthy();
      expect(view.container.querySelector('.animate-spinner')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(FIRST_CONNECTION_WINDOW_MS - 1); });
      expect(h.cloudView).not.toHaveBeenCalled();
      expect(screen.queryByText('bots.remote.offlineDescription')).toBeNull();
      // The window always ends: a home that stays unreachable reads as offline as before.
      act(() => { vi.advanceTimersByTime(1); });
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByText('cloud-offline-view')).toBeTruthy();
  });

// The client goes `connecting` at suspend and waking sends no new status, so the window opened
// before sleep. A timer that fires long after its deadline slept through it; the connection
// after waking gets its own window instead of an immediate offline/takeover.
it.each([['one minute', 60_000], ['a night', 8 * 60 * 60_000]] as const)('gives the connection after waking its own window when the computer slept for %s during one', async (_label, sleptMs) => {
  homeOfflineActor();
  vi.useFakeTimers();
  try {
    act(() => h.relayStatus?.({ status: 'connecting' }));
    render(<RemoteBotSessionView />);
    act(() => { vi.setSystemTime(Date.now() + sleptMs); });
    act(() => { vi.advanceTimersByTime(FIRST_CONNECTION_WINDOW_MS); });
    expect(screen.getByText('ccAgent.sidebar.machineSwitcher.connecting')).toBeTruthy();
    expect(h.cloudView).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(FIRST_CONNECTION_WINDOW_MS); });
  } finally {
    vi.useRealTimers();
  }
  expect(await screen.findByText('cloud-offline-view')).toBeTruthy();
});

// PR #11991 review: right after waking the relay can be online while the directory read timed
// out and fell back to a stale snapshot. It is `ready`, but unverified homes read offline, so it
// must not settle the window early; only a complete read does.
it('keeps connecting while the relay is online but the directory is only a stale fallback', async () => {
  homeOfflineActor();
  h.deviceListAuthoritative = false;
  act(() => h.relayStatus?.({ status: 'connecting' }));
  const view = render(<RemoteBotSessionView />);
  act(() => h.relayStatus?.({ status: 'online' }));
  expect(screen.getByText('ccAgent.sidebar.machineSwitcher.connecting')).toBeTruthy();
  expect(h.cloudView).not.toHaveBeenCalled();
  h.deviceListAuthoritative = true;
  view.rerender(<RemoteBotSessionView />);
  expect(await screen.findByText('cloud-offline-view')).toBeTruthy();
});

// Acceptance (issue #12014): the window counts from the drop, not from opening the chat, and
// its end restores the original judgment; it never declares an unknown home offline by itself.
it('counts the window from the drop, not from opening the chat', async () => {
  homeOfflineActor();
  vi.useFakeTimers();
  try {
    act(() => h.relayStatus?.({ status: 'connecting' }));
    act(() => { vi.advanceTimersByTime(FIRST_CONNECTION_WINDOW_MS - 1); });
    render(<RemoteBotSessionView />);
    expect(screen.getByText('ccAgent.sidebar.machineSwitcher.connecting')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
  } finally {
    vi.useRealTimers();
  }
  expect(await screen.findByText('cloud-offline-view')).toBeTruthy();
});

it('restores the original judgment when the window ends, so an unknown home is still not offline', () => {
  homeOfflineActor();
  h.connectionKnown = false;
  vi.useFakeTimers();
  try {
    act(() => h.relayStatus?.({ status: 'connecting' }));
    render(<RemoteBotSessionView />);
    act(() => { vi.advanceTimersByTime(FIRST_CONNECTION_WINDOW_MS); });
    expect(h.cloudView).not.toHaveBeenCalled();
    expect(screen.queryByText('ccAgent.sidebar.machineSwitcher.connecting')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// Decision in issue #12014: the window protects only a chat opened inside it. An open chat keeps
// #6257's 15 s grace even when this computer's relay drops at the same moment (that drop opens a
// new window); before, it waited for the 30 s window instead.
it('moves an open chat to the cloud conversation after 15 s when the home and this relay drop together', async () => {
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  const { rerender } = render(<RemoteBotSessionView />);
  await screen.findByText('remote-conversation');
  vi.useFakeTimers();
  try {
    h.online = false;
    act(() => h.relayStatus?.({ status: 'connecting' }));
    rerender(<RemoteBotSessionView />);
    act(() => { vi.advanceTimersByTime(CLOUD_HOME_GRACE_MS - 1); });
    expect(screen.getByText('remote-conversation')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
  } finally {
    vi.useRealTimers();
  }
  expect(await screen.findByText('cloud-offline-view')).toBeTruthy();
});

it('shows a confirmed offline home once the relay is back and the directory settles, and keeps it through later refreshes', async () => {
  homeOfflineActor();
  act(() => h.relayStatus?.({ status: 'connecting' }));
  const view = render(<RemoteBotSessionView />);
  expect(screen.getByText('ccAgent.sidebar.machineSwitcher.connecting')).toBeTruthy();
  act(() => h.relayStatus?.({ status: 'online' }));
  expect(await screen.findByText('cloud-offline-view')).toBeTruthy();
  // Another device's presence or a rename re-reads the directory: still settled, still offline.
  h.deviceListStatus = 'loading';
  view.rerender(<RemoteBotSessionView />);
  expect(screen.getByText('cloud-offline-view')).toBeTruthy();
});

it('calls a main computer that is not listed offline, and "control off" only when it reports remote control off', async () => {
  h.listed = false;
  const home = { deviceId: 'home', name: 'Home', online: true, isSelf: false };
  h.devices = [{ deviceId: 'home', online: false, remoteControlEnabled: true }];
  const actor = { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home', homeDevice: home };
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [actor] };
  const { rerender } = render(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');
  // Online in the device list but not answering (a stale presence): same as offline.
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
  h.cloud = { ...h.cloud, actors: [{ ...actor, homeDevice: { ...home, remoteControlEnabled: true } }] };
  rerender(<RemoteBotSessionView />);
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
  h.devices = [{ deviceId: 'home', online: true, remoteControlEnabled: false }];
  h.cloud = { ...h.cloud, actors: [{ ...actor, homeDevice: { ...home, remoteControlEnabled: false } }] };
  rerender(<RemoteBotSessionView />);
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: true }));
});

it.each(['loading', 'error'] as const)('does not confirm offline when the target row is missing and the device directory is %s', async status => {
  h.listed = false;
  h.deviceListStatus = status;
  const home = { deviceId: 'home', name: 'Home', online: true, isSelf: false, remoteControlEnabled: true };
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home', homeDevice: home }] };
  render(<RemoteBotSessionView />);
  await waitFor(() => expect(h.cloudView).not.toHaveBeenCalled());
  expect(screen.queryByText('cloud-offline-view')).toBeNull();
  expect(screen.getByText('bots.remote.preparing')).toBeTruthy();
});

it('does not confirm offline when an online home is missing its target row', async () => {
  h.listed = false;
  h.deviceListStatus = 'ready';
  const home = { deviceId: 'home', name: 'Home', online: true, isSelf: false, remoteControlEnabled: true };
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home', homeDevice: home }] };
  render(<RemoteBotSessionView />);
  await waitFor(() => expect(h.cloudView).not.toHaveBeenCalled());
  expect(screen.queryByText('cloud-offline-view')).toBeNull();
});

// #10758, unit tier: the ordinary remote entry can render a retained offline row
// alongside an already settled online device. Missing-row tests never hit this branch.
it('shows preparation instead of offline recovery for an online home with a stale roster row', async () => {
  h.online = false;
  h.devices = [{ deviceId: 'home', online: true, remoteControlEnabled: true, controlEnabled: true }];
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  const { rerender } = render(<RemoteBotSessionView />);
  expect(screen.getByText('bots.remote.preparing')).toBeTruthy();
  expect(h.cloudView).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();

  h.devices = [{ deviceId: 'home', online: false, remoteControlEnabled: true, controlEnabled: true }];
  rerender(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');
});

// #13372, unit tier: the directory stays online but the roster never settles.
// The brief preparation checks above do not exercise timeout, retry or late recovery.
it.each([true, false])('recovers from a roster timeout with a retained row: %s', async listed => {
  h.listed = listed;
  h.online = false;
  h.devices = [{ deviceId: 'home', online: true, remoteControlEnabled: true, controlEnabled: true }];
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  vi.useFakeTimers();
  try {
    const view = render(<RemoteBotSessionView />);
    act(() => { vi.advanceTimersByTime(29_999); });
    expect(screen.getByText('bots.remote.preparing')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText('bots.sessionLoadFailedDescription')).toBeTruthy();
    expect(h.cloudView).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: 'bots.retry' }).click());
    expect(h.retryRoster.mock.calls).toEqual([['home']]);
    expect(screen.getByText('bots.remote.preparing')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole('button', { name: 'bots.retry' })).toBeTruthy();
    h.listed = h.online = true;
    await act(async () => view.rerender(<RemoteBotSessionView />));
    expect(screen.getByText('remote-conversation')).toBeTruthy();
    expect(h.view.mock.lastCall?.[0]).toMatchObject({ sessionIdProp: 'new-canonical', readOnly: false });
  } finally {
    vi.useRealTimers();
  }
});

// Merge with #10758 (be8107dd42): inside the first-connection window, a directory that already
// confirms the home online keeps main's preparation copy instead of "connecting"; neither path
// offers the offline takeover.
it('keeps the preparation copy inside the window when the directory already confirms the home online', () => {
  h.online = false;
  h.devices = [{ deviceId: 'home', online: true, remoteControlEnabled: true, controlEnabled: true }];
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  act(() => h.relayStatus?.({ status: 'connecting' }));
  render(<RemoteBotSessionView />);
  expect(screen.getByText('bots.remote.preparing')).toBeTruthy();
  expect(screen.queryByText('ccAgent.sidebar.machineSwitcher.connecting')).toBeNull();
  expect(h.cloudView).not.toHaveBeenCalled();
});

it('returns to canonical remote chat when the missing target row recovers', async () => {
  h.listed = false;
  h.deviceListStatus = 'ready';
  h.devices = [{ deviceId: 'home', online: true, remoteControlEnabled: true }];
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home',
      homeDevice: { deviceId: 'home', name: 'Home', online: true, isSelf: false, remoteControlEnabled: true } }] };
  const view = render(<RemoteBotSessionView />);
  expect(screen.queryByText('cloud-offline-view')).toBeNull();
  h.listed = true;
  view.rerender(<RemoteBotSessionView />);
  await screen.findByText('remote-conversation');
  expect(h.view).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false,
    sessionIdProp: 'new-canonical', botIdentity: expect.objectContaining({ canonicalChat: true }) }));
});

it('shows the cloud conversation when the missing target row is explicitly offline', async () => {
  h.listed = false;
  h.deviceListStatus = 'ready';
  h.devices = [{ deviceId: 'home', online: false, remoteControlEnabled: true }];
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [
    { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home' }] };
  render(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
});

it('reads "control off" from the live device list, so a stale snapshot neither hides it nor invents it', async () => {
  h.listed = false;
  const home = { deviceId: 'home', name: 'Home', online: false, isSelf: false };
  const actor = { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home', homeDevice: home };
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [actor] };
  const { rerender } = render(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');
  // The snapshot still says offline, but the device list shows it online with remote control off.
  h.devices = [{ deviceId: 'home', online: true, remoteControlEnabled: false }];
  rerender(<RemoteBotSessionView />);
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: true }));
  // Switched on again, and a computer that is simply offline (it reports off too) stays "offline".
  h.devices = [{ deviceId: 'home', online: true, remoteControlEnabled: true }];
  rerender(<RemoteBotSessionView />);
  expect(screen.queryByText('cloud-offline-view')).toBeNull();
  h.devices = [{ deviceId: 'home', online: false, remoteControlEnabled: false }];
  rerender(<RemoteBotSessionView />);
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
});

// Unit: saved host identity opens its existing history before an unresolved RPC;
// a later definitive removal must still close it. Covers the former two-RPC entry gate.
it.each(['missing', 'ACCESS_REVOKED'])('mounts the cached remote task read-only and closes it on %s', async rejection => {
  h.cached = true;
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  h.invoke.mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  render(<RemoteBotSessionView />);
  expect(screen.getByText('remote-conversation')).toBeTruthy();
  expect(h.view).toHaveBeenLastCalledWith(expect.objectContaining({ sessionIdProp: 'old-canonical', readOnly: true,
    botIdentity: expect.objectContaining({ canonicalChat: false }) }));
  await act(async () => {
    if (rejection === 'missing') finish(null);
    else fail(Object.assign(new Error('revoked'), { code: rejection }));
  });
  expect(screen.queryByText('remote-conversation')).toBeNull();
});
