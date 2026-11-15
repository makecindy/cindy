// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSharedTasks } from '../device-link/useSharedTasks';
import { notifySharedTaskMembershipChanged } from '../device-link/sharedTaskMembershipSignal';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import type { RemoteSession } from '@/session/types';

const state = vi.hoisted(() => ({
  auth: { isAuthenticated: true, accountGeneration: 1 },
  link: { status: 'online', sharedTaskAvailable: false as boolean | undefined,
    openLink: vi.fn(), closeLink: vi.fn(), invoke: vi.fn() },
  api: { list: vi.fn<() => Promise<SharedTaskListItem[]>>(async () => []), leave: vi.fn() },
  revoked: vi.fn(),
  store: { getSessions: vi.fn<() => RemoteSession[]>(() => []), removeDevice: vi.fn(), setDeviceSessions: vi.fn() },
  appState: 'active', appStateListener: undefined as undefined | (() => void),
}));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return state.appState; },
  addEventListener: (_: string, listener: () => void) => {
    state.appStateListener = listener;
    return { remove: () => { state.appStateListener = undefined; } };
  },
} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => state.link }));
vi.mock('@/device-link/useSharedTaskApi', () => ({ useSharedTaskApi: () => state.api }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: state.store }));
vi.mock('@/device-link/accessRevoked', () => ({ markDeviceAccessRevoked: state.revoked }));
let root: Root;
let ownedTasks: readonly SharedTaskListItem[];
function Probe() { ownedTasks = useSharedTasks(); return null; }
async function render() { await act(async () => root.render(createElement(Probe))); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.resetAllMocks();
  state.api.list.mockResolvedValue([]);
  state.store.getSessions.mockReturnValue([{ id: 'owned-task', deviceLinkDeviceId: 'desktop', source: 'desktop' } as RemoteSession]);
  state.auth.isAuthenticated = true; state.auth.accountGeneration = 1;
  setMobileAuthOwner('owner');
  state.link.status = 'online'; state.link.sharedTaskAvailable = false;
  state.appState = 'active';
  root = createRoot(document.createElement('div'));
});
const owned = { sharedTaskId: 'owned', sessionId: 'owned-task', ownerAccountId: 'owner', hostDeviceId: 'desktop', title: 'My share', revision: 1 };
const confirmedOwned = { ...owned, source: 'desktop' };
it('discovers owner shares without opening guest links or requiring remote control', async () => {
  state.link.sharedTaskAvailable = true;
  state.api.list.mockResolvedValue([owned]);
  await render();
  expect(ownedTasks).toEqual([confirmedOwned]);
  expect(state.link.openLink).not.toHaveBeenCalled();
  expect(state.link.invoke).not.toHaveBeenCalled();
  state.link.status = 'connecting'; await render();
  expect(ownedTasks).toEqual([confirmedOwned]);
  state.link.status = 'online'; state.api.list.mockRejectedValue(new Error('offline')); await render();
  expect(ownedTasks).toEqual([confirmedOwned]);
  state.api.list.mockResolvedValue([]);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(ownedTasks).toEqual([]);
  expect(state.store.removeDevice).not.toHaveBeenCalled();
  expect(state.link.closeLink).not.toHaveBeenCalled();
});
it('keeps guest admission separate while listing shares owned by the same account', async () => {
  state.link.sharedTaskAvailable = true;
  const guest = { ...owned, sharedTaskId: 'joined', sessionId: 'guest-task', ownerAccountId: 'other' };
  state.api.list.mockResolvedValue([owned, guest]);
  state.link.invoke.mockResolvedValue({ id: 'guest-task' });
  await render();
  expect(ownedTasks).toEqual([confirmedOwned]);
  expect(state.link.openLink).toHaveBeenCalledExactlyOnceWith(sharedTaskHostPeer('joined', 'desktop'));
  expect(state.store.setDeviceSessions).toHaveBeenCalledExactlyOnceWith(sharedTaskHostPeer('joined', 'desktop'), guest.title, [{ id: 'guest-task' }]);
  expect(state.api.leave).not.toHaveBeenCalled();
});
it.each(['cindy-make', 'cindy-make-merge'])('revokes a restored %s membership without publishing its session', async source => {
  state.link.sharedTaskAvailable = true;
  const guest = { ...owned, sharedTaskId: 'joined', sessionId: 'guest-task', ownerAccountId: 'other' };
  state.api.list.mockResolvedValue([guest]);
  state.link.invoke.mockResolvedValue({ id: 'guest-task', source });
  await render();
  const peer = sharedTaskHostPeer('joined', 'desktop');
  expect(state.api.leave).toHaveBeenCalledExactlyOnceWith('joined');
  expect(state.revoked).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.link.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.store.removeDevice).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.store.setDeviceSessions).not.toHaveBeenCalled();
});
it('retries membership cleanup on the next restore poll after a leave failure', async () => {
  state.link.sharedTaskAvailable = true;
  const guest = { ...owned, sharedTaskId: 'joined', sessionId: 'guest-task', ownerAccountId: 'other' };
  state.api.list.mockResolvedValue([guest]); state.link.invoke.mockResolvedValue({ id: 'guest-task', source: 'cindy-make' });
  state.api.leave.mockRejectedValueOnce(new Error('offline'));
  await render();
  expect(state.api.leave).toHaveBeenCalledTimes(1);
  expect(state.store.setDeviceSessions).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(state.api.leave).toHaveBeenCalledTimes(2);
  expect(state.link.closeLink).toHaveBeenCalledWith(sharedTaskHostPeer('joined', 'desktop'));
});
it('leaves a cached hidden guest membership without contacting the offline host', async () => {
  state.link.sharedTaskAvailable = true;
  const guest = { ...owned, sharedTaskId: 'joined', sessionId: 'guest-task', ownerAccountId: 'other' };
  const peer = sharedTaskHostPeer('joined', 'desktop');
  state.api.list.mockResolvedValue([guest]);
  state.store.getSessions.mockReturnValue([{ id: 'guest-task', deviceLinkDeviceId: peer, source: 'cindy-make' } as RemoteSession]);
  state.link.invoke.mockRejectedValue(new Error('offline'));
  await render();
  expect(state.api.leave).toHaveBeenCalledExactlyOnceWith('joined');
  expect(state.link.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.link.openLink).not.toHaveBeenCalled();
  expect(state.link.invoke).not.toHaveBeenCalled();
});
it('keeps an ordinary shared peer on the same host unaffected by Make withdrawal', async () => {
  state.link.sharedTaskAvailable = true;
  const hidden = { ...owned, sharedTaskId: 'hidden-share', sessionId: 'hidden-task', ownerAccountId: 'other' };
  const ordinary = { ...hidden, sharedTaskId: 'ordinary-share', sessionId: 'ordinary-task' };
  state.api.list.mockResolvedValue([hidden, ordinary]);
  state.link.invoke.mockImplementation(async (_peer, _channel, [sessionId]) => ({ id: sessionId, source: sessionId === hidden.sessionId ? 'cindy-make' : 'desktop' }));
  await render();
  const peer = sharedTaskHostPeer(hidden.sharedTaskId, hidden.hostDeviceId);
  expect(state.api.leave).toHaveBeenCalledExactlyOnceWith(hidden.sharedTaskId);
  expect(state.link.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.store.removeDevice).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.store.setDeviceSessions).toHaveBeenCalledExactlyOnceWith(sharedTaskHostPeer(ordinary.sharedTaskId, ordinary.hostDeviceId), ordinary.title, [{ id: ordinary.sessionId, source: 'desktop' }]);
});
it('hides the previous account shares and ignores its late list response', async () => {
  state.link.sharedTaskAvailable = true; state.api.list.mockResolvedValue([owned]);
  await render(); expect(ownedTasks).toEqual([confirmedOwned]);
  let finish!: (value: SharedTaskListItem[]) => void;
  state.api.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  setMobileAuthOwner('other'); state.auth.accountGeneration++;
  state.api.list.mockResolvedValue([]); await render();
  expect(ownedTasks).toEqual([]);
  await act(async () => finish([owned]));
  expect(ownedTasks).toEqual([]);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it.each(['cindy-make', 'cindy-make-merge'])('hides an account-owned legacy %s share without a visible mirror', async source => {
  state.link.sharedTaskAvailable = true; state.api.list.mockResolvedValue([owned]);
  state.store.getSessions.mockReturnValue([{ id: owned.sessionId, deviceLinkDeviceId: 'unrelated-host', source: 'desktop' } as RemoteSession]);
  state.link.invoke.mockResolvedValue({ id: owned.sessionId, source });
  await render();
  expect(ownedTasks).toEqual([]);
  expect(state.link.invoke).toHaveBeenCalledExactlyOnceWith(owned.hostDeviceId, 'local-db:sessions:get', [owned.sessionId]);
  expect(state.link.openLink).not.toHaveBeenCalled();
});
it('uses raw hidden metadata without contacting the offline owner host', async () => {
  state.link.sharedTaskAvailable = true; state.api.list.mockResolvedValue([owned]);
  state.store.getSessions.mockReturnValue([{ id: owned.sessionId, deviceLinkDeviceId: owned.hostDeviceId, source: 'cindy-make' } as RemoteSession]);
  await render();
  expect(ownedTasks).toEqual([]);
  expect(state.link.invoke).not.toHaveBeenCalled();
  expect(state.link.openLink).not.toHaveBeenCalled();
});
it('keeps an offline unknown share hidden and resumes ordinary discovery after source recovery', async () => {
  state.link.sharedTaskAvailable = true; state.api.list.mockResolvedValue([owned]); state.store.getSessions.mockReturnValue([]);
  state.link.invoke.mockRejectedValueOnce(new Error('offline'));
  await render(); expect(ownedTasks).toEqual([]);
  state.link.invoke.mockResolvedValue({ id: owned.sessionId });
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(ownedTasks).toEqual([{ ...owned, source: null }]);
  expect(state.link.openLink).not.toHaveBeenCalled();
});
it('ignores metadata confirmed after switching accounts', async () => {
  state.link.sharedTaskAvailable = true; state.api.list.mockResolvedValue([owned]); state.store.getSessions.mockReturnValue([]);
  let finish!: (session: { id: string; source: string }) => void;
  state.link.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); expect(ownedTasks).toEqual([]);
  setMobileAuthOwner('other'); state.auth.accountGeneration++; state.api.list.mockResolvedValue([]);
  await render(); await act(async () => finish({ id: owned.sessionId, source: 'desktop' }));
  expect(ownedTasks).toEqual([]);
});
it('does not poll an old relay, resumes after upgrade, and pauses without deleting history on disconnect', async () => {
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(state.api.list).not.toHaveBeenCalled();
  state.link.sharedTaskAvailable = true; await render();
  expect(state.api.list).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(state.api.list).toHaveBeenCalledTimes(2);
  state.link.status = 'connecting'; state.link.sharedTaskAvailable = undefined; await render();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(state.api.list).toHaveBeenCalledTimes(2);
  expect(state.store.removeDevice).not.toHaveBeenCalled();
  expect(state.link.closeLink).not.toHaveBeenCalled();
});
it('pauses in the background and rereads on return or after joining, not every 5 s', async () => {
  state.link.sharedTaskAvailable = true;
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(59_999));
  expect(state.api.list).toHaveBeenCalledTimes(1);
  await act(async () => { notifySharedTaskMembershipChanged(); });
  expect(state.api.list).toHaveBeenCalledTimes(2);
  state.appState = 'background'; state.appStateListener?.();
  await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(state.api.list).toHaveBeenCalledTimes(2);
  state.appState = 'active';
  await act(async () => { state.appStateListener?.(); });
  expect(state.api.list).toHaveBeenCalledTimes(3);
});
