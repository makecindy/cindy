// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSharedTasks } from '../device-link/useSharedTasks';

const state = vi.hoisted(() => ({
  auth: { isAuthenticated: true, accountGeneration: 1 },
  link: { status: 'online', sessionMeetingAvailable: false as boolean | undefined,
    openLink: vi.fn(), closeLink: vi.fn(), invoke: vi.fn() },
  api: { list: vi.fn(async () => []) },
  store: { getSessions: vi.fn(() => []), removeDevice: vi.fn(), setDeviceSessions: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => state.link }));
vi.mock('@/device-link/useSessionMeetingApi', () => ({ useSessionMeetingApi: () => state.api }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: state.store }));
let root: Root;
function Probe() { useSharedTasks(); return null; }
async function render() { await act(async () => root.render(createElement(Probe))); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks();
  state.link.status = 'online'; state.link.sessionMeetingAvailable = false;
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it('does not poll an old relay, resumes after upgrade, and pauses without deleting history on disconnect', async () => {
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(state.api.list).not.toHaveBeenCalled();
  state.link.sessionMeetingAvailable = true; await render();
  expect(state.api.list).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(state.api.list).toHaveBeenCalledTimes(2);
  state.link.status = 'connecting'; state.link.sessionMeetingAvailable = undefined; await render();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(state.api.list).toHaveBeenCalledTimes(2);
  expect(state.store.removeDevice).not.toHaveBeenCalled();
  expect(state.link.closeLink).not.toHaveBeenCalled();
});
