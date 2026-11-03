// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveBotChatIdentity, type BotChatBinding } from '../botChatPresentation';
import { remoteProjectsStore, useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';

const h = vi.hoisted(() => ({
  params: { botId: 'bot', sessionId: 'chat', deviceId: undefined as string | undefined },
  redirect: vi.fn(),
  get: vi.fn(), list: vi.fn(), history: vi.fn(), invoke: vi.fn(),
  profiles: [] as Array<{ id: string; name: string; avatar: string; avatarColor: string; invitation?: { stage: string } }>,
  profileListeners: new Set<() => void>(),
  cloud: null as null | import('../../../../shared/companionCloud').CompanionCloudSnapshot,
}));
vi.mock('../companionCloudStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../companionCloudStore')>();
  return { ...original, useCompanionCloud: () => h.cloud ?? original.useCompanionCloud() };
});
// 工作台在右侧栏里有自己的数据订阅，这里只验证伙伴对话的挂载与读位。
vi.mock('../botStore', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    getBotProfiles: () => h.profiles,
    useBotProfiles: () => useSyncExternalStore((listener) => {
      h.profileListeners.add(listener);
      return () => h.profileListeners.delete(listener);
    }, () => h.profiles),
  };
});
vi.mock('react-router-dom', () => ({
  useParams: () => h.params,
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
  Navigate: (props: unknown) => { h.redirect(props); return <div>unavailable</div>; },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useBotIslandVisibleSession', () => ({ useBotIslandVisibleSession: () => {} }));
// The private-chat topic host belongs to the chat surface these tests isolate.
vi.mock('../BotDmThreadHost', () => ({ BotDmThreadHost: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ botIdentity, botInvitationStage, readOnly, botMentions }: { botIdentity?: BotChatBinding; botInvitationStage?: string; readOnly?: boolean; botMentions?: Array<{ id: string }> }) => {
    const sessions = useRemoteProjectSessions();
    const identity = resolveBotChatIdentity(botIdentity, h.params.sessionId);
    // The real chat header requires session metadata from this mirror. Keep the
    // production gate/store path; omit the unrelated editor and transcript tree.
    if (h.params.deviceId && !sessions.some(row => row.id === h.params.sessionId)) return <div>metadata-loading</div>;
    return <div data-name={identity?.name} data-avatar={identity?.avatar} data-device-id={identity?.deviceId} data-read-only={readOnly} data-invitation-stage={botInvitationStage ?? ''} data-mentions={(botMentions ?? []).map(item => item.id).join(',')}>{identity ? `companion:${identity.id}` : 'task controls'}</div>;
  },
}));
import { BotSessionView } from '../BotSessionView';
import { BotHistorySessionView } from '../BotHistorySessionView';

beforeEach(() => {
  h.params = { botId: 'bot', sessionId: 'chat', deviceId: undefined };
  h.redirect.mockClear();
  h.get.mockReset(); h.list.mockReset().mockResolvedValue([]); h.history.mockReset();
  h.invoke.mockReset(); remoteProjectsStore.clear(); remoteProjectsStore.__resetPinnedOriginsForTest();
  h.profiles = []; h.profileListeners.clear(); h.cloud = null;
  window.electronAPI = { localDb: { bots: { get: h.get, list: h.list, history: h.history } }, deviceLink: { invoke: h.invoke } } as unknown as Window['electronAPI'];
});
afterEach(() => { cleanup(); remoteProjectsStore.clear(); remoteProjectsStore.__resetPinnedOriginsForTest(); });
it('mounts the simplified chat only after verifying the durable link, without another session GET', async () => {
  let resolve!: (value: unknown) => void;
  h.get.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<BotSessionView />);
  expect(screen.queryByText('task controls')).toBeNull();
  await act(async () => resolve({ id: 'bot', name: 'Melody', status: 'active', sessions: [
    { id: 'chat', kind: 'chat', status: 'active', role: 'canonical' },
  ] }));
  expect(screen.getByText('companion:bot')).toBeTruthy();
});
it('does not accept an arbitrary task id from a Bot URL', async () => {
  h.get.mockResolvedValue({ id: 'bot', status: 'active', sessions: [
    { id: 'different', kind: 'chat', status: 'active' },
  ] });
  await act(async () => { render(<BotSessionView />); });
  expect(screen.queryByText('companion:bot')).toBeNull();
  expect(screen.queryByText('task controls')).toBeNull();
});

it('drops the previous binding synchronously when navigating to a different Bot task', async () => {
  h.get.mockResolvedValue({ id: 'bot', status: 'active', sessions: [
    { id: 'chat', kind: 'chat', status: 'active', role: 'canonical' },
  ] });
  const view = render(<BotSessionView />);
  await screen.findByText('companion:bot');
  h.get.mockReturnValue(new Promise(() => {}));
  h.params = { botId: 'other', sessionId: 'other-chat', deviceId: undefined };
  view.rerender(<BotSessionView />);
  expect(screen.queryByText('companion:bot')).toBeNull();
  expect(screen.queryByText('task controls')).toBeNull();
});
it('opens the original task when a stale bot URL rejects with NOT_FOUND, without adopting a bot', async () => {
  h.get.mockRejectedValue(new Error('[NOT_FOUND] Bot 不存在'));
  render(<BotSessionView />);
  await act(async () => {});
  expect(h.redirect).toHaveBeenCalledWith({ to: '/cc-agent/chat', state: null, replace: true });
  expect(screen.queryByText('companion:bot')).toBeNull();
});
it('follows a rename saved from settings while the chat stays open', async () => {
  h.get.mockResolvedValue({ id: 'bot', name: 'Melody', status: 'active', sessions: [
    { id: 'chat', kind: 'chat', status: 'active', role: 'canonical' },
  ] });
  render(<BotSessionView />);
  const chat = await screen.findByText('companion:bot');
  expect(chat.getAttribute('data-name')).toBe('Melody');
  await act(async () => {
    h.profiles = [{ id: 'bot', name: 'Melody Two', avatar: '🎵', avatarColor: 'violet' }];
    for (const listener of h.profileListeners) listener();
  });
  expect(screen.getByText('companion:bot').getAttribute('data-name')).toBe('Melody Two');
});
it('hands the live invitation stage to the canonical chat only, and follows it until the opening is stored', async () => {
  h.get.mockResolvedValue({ id: 'bot', name: 'Melody', status: 'active', sessions: [
    { id: 'chat', kind: 'chat', status: 'active', role: 'canonical' },
  ] });
  h.profiles = [{ id: 'bot', name: 'Melody', avatar: '🎵', avatarColor: 'violet', invitation: { stage: 'welcome' } }];
  render(<BotSessionView />);
  expect((await screen.findByText('companion:bot')).getAttribute('data-invitation-stage')).toBe('welcome');
  await act(async () => {
    h.profiles = [{ ...h.profiles[0]!, invitation: { stage: 'ready' } }];
    for (const listener of h.profileListeners) listener();
  });
  expect(screen.getByText('companion:bot').getAttribute('data-invitation-stage')).toBe('ready');
});
it('never shows the first-hello wait in a channel-routed (non-canonical) task of the same teammate', async () => {
  h.get.mockResolvedValue({ id: 'bot', name: 'Melody', status: 'active', sessions: [
    { id: 'chat', kind: 'chat', status: 'active', role: 'channel' },
  ] });
  h.profiles = [{ id: 'bot', name: 'Melody', avatar: '🎵', avatarColor: 'violet', invitation: { stage: 'welcome' } }];
  render(<BotSessionView />);
  await act(async () => {});
  expect(h.redirect).toHaveBeenCalledWith({ to: '/cc-agent/chat', state: null, replace: true });
  expect(screen.queryByText('companion:bot')).toBeNull();
});

// Legacy URLs retain the exact task and host; the ordinary page owns access and recovery.
it.each([undefined, 'remote computer'])('redirects history to the ordinary task page (%s)', async deviceId => {
  h.params = { botId: 'bot', sessionId: 'old/task', deviceId };
  await act(async () => { render(<BotHistorySessionView />); });
  expect(h.redirect).toHaveBeenCalledWith({ to: `/cc-agent/old%2Ftask${deviceId ? '?device=remote+computer' : ''}`, state: null, replace: true });
  expect(h.get).not.toHaveBeenCalled();
  expect(h.history).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});
it('offers only teammates that run here to send to or delegate to, not copies that run elsewhere or were retired there', async () => {
  h.get.mockResolvedValue({ id: 'bot', name: 'Melody', status: 'active', sessions: [{ id: 'chat', kind: 'chat', status: 'active', role: 'canonical' }] });
  h.list.mockResolvedValue([{ id: 'bot', name: 'Melody' }, { id: 'kept', name: 'Kept' }, { id: 'retired', name: 'Retired' }, { id: 'away', name: 'Away' }]);
  h.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: ['retired'], actors: [
    { id: 'a-away', externalId: 'away', name: 'Away', avatar: null, homeDeviceId: 'laptop' }] };
  render(<BotSessionView />);
  const chat = await screen.findByText('companion:bot');
  expect(chat.getAttribute('data-mentions')).toBe('kept');
});
