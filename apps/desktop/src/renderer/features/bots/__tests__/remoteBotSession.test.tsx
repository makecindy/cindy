// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseRemoteResourceGetRequest } from '@cindy/device-link';
import { resolveBotChatIdentity } from '../botChatPresentation';
import type { BotChatBinding } from '../botChatPresentation';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  markRead: vi.fn(),
  pin: vi.fn(),
  merge: vi.fn(),
  view: vi.fn(),
  online: true,
  listed: true,
  lastReplyAt: 0,
  devices: null as Array<{ deviceId: string; online: boolean; remoteControlEnabled: boolean }> | null,
  cloud: { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] } as import('../../../../shared/companionCloud').CompanionCloudSnapshot,
  cloudView: vi.fn(),
}));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => h.cloud }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => h.devices }));
vi.mock('../CloudCompanionOfflineView', () => ({
  CloudCompanionOfflineView: (props: unknown) => { h.cloudView(props); return <div>cloud-offline-view</div>; },
}));
vi.mock('react-router-dom', () => ({ useParams: () => ({ deviceId: 'home', botId: 'writer' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useRemoteBots', () => ({
  markRemoteBotRead: h.markRead,
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
      lastReplyAt: h.lastReplyAt,
    },
  ],
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    pinSessionOrigin: h.pin,
    getSessionDeviceId: () => undefined,
    mergeDeviceSessions: h.merge,
    getDeviceSessions: () => [],
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
beforeEach(() => {
  h.markRead.mockClear();
  h.online = true;
  h.listed = true;
  h.lastReplyAt = 0;
  h.cloud = { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] };
  h.devices = null;
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
  window.electronAPI = { deviceLink: { invoke: h.invoke } } as unknown as Window['electronAPI'];
});
afterEach(cleanup);
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
  // Another computer as the cloud home keeps the existing offline behaviour.
  h.cloud = { ...h.cloud, actors: [{ ...h.cloud.actors[0]!, homeDeviceId: 'elsewhere' }] };
  rerender(<RemoteBotSessionView />);
  await waitFor(() => expect(h.view).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true })));
});

it('calls a main computer that is not listed offline, and "control off" only when it reports remote control off', async () => {
  h.listed = false;
  const home = { deviceId: 'home', name: 'Home', online: true, isSelf: false };
  const actor = { id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'home', homeDevice: home };
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [], actors: [actor] };
  const { rerender } = render(<RemoteBotSessionView />);
  await screen.findByText('cloud-offline-view');
  // Online in the device list but not answering (a stale presence): same as offline.
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
  h.cloud = { ...h.cloud, actors: [{ ...actor, homeDevice: { ...home, remoteControlEnabled: true } }] };
  rerender(<RemoteBotSessionView />);
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
  h.cloud = { ...h.cloud, actors: [{ ...actor, homeDevice: { ...home, remoteControlEnabled: false } }] };
  rerender(<RemoteBotSessionView />);
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: true }));
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
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
  h.devices = [{ deviceId: 'home', online: false, remoteControlEnabled: false }];
  rerender(<RemoteBotSessionView />);
  expect(h.cloudView).toHaveBeenLastCalledWith(expect.objectContaining({ controlOff: false }));
});
