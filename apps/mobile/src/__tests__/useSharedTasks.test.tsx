// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSharedTasks } from '../device-link/useSharedTasks';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';

const state = vi.hoisted(() => ({
  auth: { isAuthenticated: true, accountGeneration: 1 },
  link: { status: 'online', sharedTaskAvailable: false as boolean | undefined,
    openLink: vi.fn(), closeLink: vi.fn(), invoke: vi.fn() },
  api: { list: vi.fn<() => Promise<SharedTaskListItem[]>>(async () => []) },
  store: { getSessions: vi.fn(() => []), removeDevice: vi.fn(), setDeviceSessions: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => state.link }));
vi.mock('@/device-link/useSharedTaskApi', () => ({ useSharedTaskApi: () => state.api }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: state.store }));
let root: Root;
let ownedTasks: readonly SharedTaskListItem[];
function Probe() { ownedTasks = useSharedTasks(); return null; }
async function render() { await act(async () => root.render(createElement(Probe))); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.resetAllMocks();
  state.api.list.mockResolvedValue([]); state.store.getSessions.mockReturnValue([]);
  state.auth.isAuthenticated = true; state.auth.accountGeneration = 1;
  setMobileAuthOwner('owner');
  state.link.status = 'online'; state.link.sharedTaskAvailable = false;
  root = createRoot(document.createElement('div'));
});
const owned = { sharedTaskId: 'owned', sessionId: 'owned-task', ownerAccountId: 'owner', hostDeviceId: 'desktop', title: 'My share', revision: 1 };
it('discovers owner shares without opening guest links or requiring remote control', async () => {
  state.link.sharedTaskAvailable = true;
  state.api.list.mockResolvedValue([owned]);
  await render();
  expect(ownedTasks).toEqual([owned]);
  expect(state.link.openLink).not.toHaveBeenCalled();
  expect(state.link.invoke).not.toHaveBeenCalled();
  state.link.status = 'connecting'; await render();
  expect(ownedTasks).toEqual([owned]);
  state.link.status = 'online'; state.api.list.mockRejectedValue(new Error('offline')); await render();
  expect(ownedTasks).toEqual([owned]);
  state.api.list.mockResolvedValue([]);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
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
  expect(ownedTasks).toEqual([owned]);
  expect(state.link.openLink).toHaveBeenCalledExactlyOnceWith(sharedTaskHostPeer('joined', 'desktop'));
  expect(state.store.setDeviceSessions).toHaveBeenCalledExactlyOnceWith(sharedTaskHostPeer('joined', 'desktop'), guest.title, [{ id: 'guest-task' }]);
});
it('hides the previous account shares and ignores its late list response', async () => {
  state.link.sharedTaskAvailable = true; state.api.list.mockResolvedValue([owned]);
  await render(); expect(ownedTasks).toEqual([owned]);
  let finish!: (value: SharedTaskListItem[]) => void;
  state.api.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  setMobileAuthOwner('other'); state.auth.accountGeneration++;
  state.api.list.mockResolvedValue([]); await render();
  expect(ownedTasks).toEqual([]);
  await act(async () => finish([owned]));
  expect(ownedTasks).toEqual([]);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it('does not poll an old relay, resumes after upgrade, and pauses without deleting history on disconnect', async () => {
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(state.api.list).not.toHaveBeenCalled();
  state.link.sharedTaskAvailable = true; await render();
  expect(state.api.list).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(state.api.list).toHaveBeenCalledTimes(2);
  state.link.status = 'connecting'; state.link.sharedTaskAvailable = undefined; await render();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(state.api.list).toHaveBeenCalledTimes(2);
  expect(state.store.removeDevice).not.toHaveBeenCalled();
  expect(state.link.closeLink).not.toHaveBeenCalled();
});
