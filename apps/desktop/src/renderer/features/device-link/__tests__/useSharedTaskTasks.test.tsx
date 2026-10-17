// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useSharedTaskTasks } from '../useSharedTaskTasks';

const state = vi.hoisted(() => ({
  account: vi.fn(), openLink: vi.fn(), closeLink: vi.fn(), invoke: vi.fn(),
  subscribe: vi.fn(), unsubscribe: vi.fn(), setSessions: vi.fn(), removeDevice: vi.fn(),
  disconnected: vi.fn(), bind: vi.fn(), reset: vi.fn(),
  rawSessions: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, dataOwnerId: 'guest', dataOwnerRecoveryEpoch: 0 }) }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { findById: vi.fn() } }));
vi.mock('@/lib/sessionService', () => ({ get: vi.fn() }));
vi.mock('../remoteProjectsStore', () => ({ remoteProjectsStore: {
  getAllDeviceIds: () => [], getDeviceSessions: state.rawSessions, setDeviceSessions: state.setSessions,
  removeDevice: state.removeDevice, markDeviceDisconnected: state.disconnected,
} }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ bindSharedTaskPushOwner: state.bind, resetRemoteDataOwnerPushFence: state.reset }));

const task = { sharedTaskId: 'share', sessionId: 'task', ownerAccountId: 'host', hostDeviceId: 'desktop', title: 'Shared task', revision: 1 };
const peer = sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
let root: Root;
function Probe() { useSharedTaskTasks(); return null; }
async function render() { await act(async () => root.render(createElement(Probe))); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.resetAllMocks(); setDataOwnerGeneration('guest');
  state.account.mockImplementation(async command => command.action === 'list' ? [task] : {});
  state.openLink.mockResolvedValue(undefined); state.closeLink.mockResolvedValue(undefined);
  state.subscribe.mockResolvedValue(undefined); state.unsubscribe.mockResolvedValue(undefined);
  state.rawSessions.mockReturnValue([]);
  Object.assign(window, { electronAPI: { sharedTask: { account: state.account }, deviceLink: {
    openLink: state.openLink, closeLink: state.closeLink, invoke: state.invoke,
    subscribe: state.subscribe, unsubscribe: state.unsubscribe,
  } } });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

it.each(['cindy-make', 'cindy-make-merge'])('leaves a restored %s membership before publishing its session', async source => {
  state.invoke.mockResolvedValue({ id: task.sessionId, source });
  await render();
  expect(state.account).toHaveBeenCalledWith({ action: 'leave', sharedTaskId: task.sharedTaskId });
  expect(state.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.removeDevice).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.reset).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.setSessions).not.toHaveBeenCalled();
});

it('keeps ordinary shared task restoration unchanged', async () => {
  const session = { id: task.sessionId, source: 'desktop' };
  state.invoke.mockResolvedValue(session);
  await render();
  expect(state.setSessions).toHaveBeenCalledExactlyOnceWith(peer, task.title, [session]);
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'leave' }));
  expect(state.closeLink).not.toHaveBeenCalled();
});

it('leaves a known hidden membership without waiting for its offline host', async () => {
  state.rawSessions.mockReturnValue([{ id: task.sessionId, source: 'cindy-make' }]);
  state.invoke.mockRejectedValue(new Error('offline'));
  await render();
  expect(state.account).toHaveBeenCalledWith({ action: 'leave', sharedTaskId: task.sharedTaskId });
  expect(state.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.openLink).not.toHaveBeenCalled();
  expect(state.invoke).not.toHaveBeenCalled();
});

it('does not revoke a membership using mismatched task metadata', async () => {
  state.invoke.mockResolvedValue({ id: 'another-task', source: 'cindy-make' });
  await render();
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'leave' }));
  expect(state.setSessions).not.toHaveBeenCalled();
  expect(state.disconnected).toHaveBeenCalledWith(peer);
});

it('keeps another shared task on the same host connected while leaving Make', async () => {
  const ordinary = { ...task, sharedTaskId: 'ordinary-share', sessionId: 'ordinary-task' };
  state.account.mockImplementation(async command => command.action === 'list' ? [task, ordinary] : {});
  state.invoke.mockImplementation(async (_peer, _channel, [sessionId]) => ({ id: sessionId, source: sessionId === task.sessionId ? 'cindy-make' : 'desktop' }));
  await render();
  expect(state.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.removeDevice).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.setSessions).toHaveBeenCalledExactlyOnceWith(sharedTaskHostPeer(ordinary.sharedTaskId, ordinary.hostDeviceId), ordinary.title, [{ id: ordinary.sessionId, source: 'desktop' }]);
  expect(state.account.mock.calls.filter(([command]) => command.action === 'leave')).toEqual([[{ action: 'leave', sharedTaskId: task.sharedTaskId }]]);
});

it('retries a failed disabled membership leave on the next authority poll', async () => {
  const account = state.account.getMockImplementation()!;
  let failed = false;
  state.account.mockImplementation(async command => {
    if (command.action === 'leave' && !failed) { failed = true; throw new Error('offline'); }
    return account(command);
  });
  state.invoke.mockResolvedValue({ id: task.sessionId, source: 'cindy-make' });
  await render();
  expect(state.closeLink).not.toHaveBeenCalled();
  expect(state.setSessions).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(state.account.mock.calls.filter(([command]) => command.action === 'leave')).toHaveLength(2);
  expect(state.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(state.setSessions).not.toHaveBeenCalled();
});

it('does not revoke a membership using an old account metadata response', async () => {
  let finish!: (session: unknown) => void;
  state.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => { setDataOwnerGeneration('other'); finish({ id: task.sessionId, source: 'cindy-make' }); });
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'leave' }));
  expect(state.closeLink).not.toHaveBeenCalled();
  expect(state.setSessions).not.toHaveBeenCalled();
});

it('does not clean up a new account after a late disabled membership leave response', async () => {
  const account = state.account.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  state.account.mockImplementation(command => command.action === 'leave' ? new Promise(resolve => { finish = resolve; }) : account(command));
  state.invoke.mockResolvedValue({ id: task.sessionId, source: 'cindy-make' });
  await render();
  await act(async () => { setDataOwnerGeneration('other'); finish({}); });
  expect(state.closeLink).not.toHaveBeenCalled();
  expect(state.removeDevice).not.toHaveBeenCalled();
  expect(state.setSessions).not.toHaveBeenCalled();
});
