// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert } from 'react-native';
import { withNewSessionCreationRemoval } from '@/session/newSessionCreation';
import { useSessionListActions } from '@/session/useSessionListActions';
import { loadSharedSessionScheduleIndex, resetScheduleIndexThrottleForTesting } from '@/session/scheduleIndex';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import type { RemoteSession } from '@/session/types';
import { remoteSessionStore } from '@/session/remoteSessionStore';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('react-i18next', async (original) => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: mocks.invoke }) }));
vi.mock('@/device-link/remoteStatus', () => ({ humanizeRemoteError: (error: Error) => error.message }));
vi.mock('@/session/newSessionCreation', () => ({ withNewSessionCreationRemoval: vi.fn() }));

// Unit, PR #6980 review: invoke the real hook, transport, device resolver and
// schedule-read orchestration. Gesture tests stub the callback and cannot catch
// old-host alerts or requests sent to a stale shard. Minimum regression: a Host
// rejects clear-attention with CHANNEL_NOT_ALLOWED; no failure alert is shown.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let actions: ReturnType<typeof useSessionListActions>;
const task = { id: 'task', deviceLinkDeviceId: 'old-shard', canonicalDeviceId: 'host' } as RemoteSession;
function mount(preferredRpcDeviceId?: string) {
  function Probe() {
    actions = useSessionListActions({ preferredRpcDeviceId });
    return null;
  }
  act(() => root.render(createElement(Probe)));
}
async function markRead(session = task) {
  await act(async () => { actions.sessionSwipeControls.onMarkRead(session); });
}
beforeEach(() => {
  vi.clearAllMocks();
  resetScheduleIndexThrottleForTesting();
  remoteSessionStore.clear();
  mocks.invoke.mockImplementation(async (_device: string, channel: string) => {
    if (channel === 'maker:schedule:list') return [];
    if (channel === 'maker:schedule:list-sidebar-index-runs') return { runs: [] };
    return undefined;
  });
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

describe('task list mark-read', () => {
  it.each(['unchanged', 'error', 'completed', 'restart-and-complete'])('checks queued attention against the swipe snapshot (%s)', async (change) => {
    remoteSessionStore.applySessionActivity('host', { sessionId: 'task', phase: 'completed', attention: true, compactDetail: 'original' });
    const send = vi.fn();
    let flush!: () => void;
    mocks.invoke.mockImplementation((_device: string, channel: string, _args: unknown[], options?: { preSend?: () => void }) => {
      if (channel !== 'notification:clear-session-attention') {
        return Promise.resolve(channel === 'maker:schedule:list-sidebar-index-runs' ? { runs: [] } : []);
      }
      return new Promise<void>((resolve, reject) => {
        flush = () => {
          try { options?.preSend?.(); send(); resolve(); } catch (error) { reject(error); }
        };
      });
    });
    mount();
    await markRead();
    if (change === 'restart-and-complete') {
      remoteSessionStore.applySessionActivity('host', { sessionId: 'task', phase: 'running' });
      // Same final label and phase: the newer run must still invalidate the old receipt.
      remoteSessionStore.applySessionActivity('host', { sessionId: 'task', phase: 'completed', attention: true, compactDetail: 'original' });
    } else if (change !== 'unchanged') {
      remoteSessionStore.applySessionActivity('host', { sessionId: 'task', phase: change, attention: true, compactDetail: 'new' });
    }
    const latest = remoteSessionStore.getSessionLiveActivity('task');
    await act(async () => flush());
    expect(send).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
    expect(remoteSessionStore.getSessionLiveActivity('task')).toBe(latest);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  // Same receipt invariant across both writes: late index data and queued run
  // writes cannot consume a completion produced after the gesture. A normal
  // attention-clear broadcast must not prevent reading the original run.
  it.each(['index', 'run-write', 'unchanged'])('fences automation reads across %s settling', async (stage) => {
    remoteSessionStore.applySessionActivity('host', { sessionId: 'task', phase: 'completed', attention: true, compactDetail: 'old' });
    const sentRunIds: string[] = [];
    let settle!: () => void;
    mocks.invoke.mockImplementation(async (_device: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => {
      if (channel === 'notification:clear-session-attention') {
        options?.preSend?.();
        remoteSessionStore.applySessionActivity('host', { sessionId: 'task', phase: 'completed', attention: false });
      }
      if (channel === 'maker:schedule:list') return [{ id: 'schedule', name: 'Daily', status: 'active' }];
      if (channel === 'maker:schedule:list-sidebar-index-runs') throw new Error('[CHANNEL_NOT_ALLOWED] legacy index');
      if (channel === 'maker:schedule:list-runs') {
        if (stage === 'index') await new Promise<void>((resolve) => { settle = resolve; });
        return [{ id: 'run', scheduleId: 'schedule', sessionId: 'task', status: 'success', firedAt: 1 }];
      }
      if (channel === 'maker:schedule:mark-run-read') {
        if (stage === 'run-write') await new Promise<void>((resolve) => { settle = resolve; });
        options?.preSend?.();
        sentRunIds.push(args[0] as string);
      }
    });
    mount();
    await markRead({ ...task, source: 'scheduler' });
    if (stage !== 'unchanged') {
      remoteSessionStore.applySessionActivity('host', { sessionId: 'task', phase: 'error', attention: true, compactDetail: 'new' });
      await act(async () => settle());
      expect(remoteSessionStore.getSessionLiveActivity('task')).toMatchObject({ phase: 'error', attention: true });
    }
    expect(sentRunIds).toEqual(stage === 'unchanged' ? ['run'] : []);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it.each([undefined, 'route-host'])('writes ordinary task attention to the resolved Host (%s)', async (preferred) => {
    const host = preferred ?? 'host';
    await loadSharedSessionScheduleIndex(host, createMobileMakerTransport({ deviceId: host, invoke: mocks.invoke as RemoteInvoke }));
    mocks.invoke.mockClear();
    mount(preferred);
    await markRead();
    expect(mocks.invoke.mock.calls).toEqual([[host, 'notification:clear-session-attention', ['task', 'explicit'], { preSend: expect.any(Function) }]]);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it.each([false, true])('also marks only the task’s unread automation runs (legacy attention: %s)', async (legacyAttention) => {
    mocks.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (legacyAttention && channel === 'notification:clear-session-attention') {
        throw Object.assign(new Error('old Host'), { code: 'CHANNEL_NOT_ALLOWED' });
      }
      if (channel === 'maker:schedule:list') return [{ id: 'schedule', name: 'Daily', status: 'active' }];
      if (channel === 'maker:schedule:list-sidebar-index-runs') throw new Error('[CHANNEL_NOT_ALLOWED] old index');
      if (channel === 'maker:schedule:list-runs') return [
        { id: 'unread', scheduleId: 'schedule', sessionId: 'task', status: 'success', firedAt: 1 },
        { id: 'other', scheduleId: 'schedule', sessionId: 'another', status: 'success', firedAt: 2 },
      ];
    });
    mount();
    await markRead({ ...task, source: 'scheduler' });
    expect(mocks.invoke).toHaveBeenCalledWith('host', 'notification:clear-session-attention', ['task', 'explicit'], { preSend: expect.any(Function) });
    expect(mocks.invoke.mock.calls.filter((call) => call[1] === 'maker:schedule:mark-run-read'))
      .toEqual([['host', 'maker:schedule:mark-run-read', ['unread'], { preSend: expect.any(Function) }]]);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error('channel unavailable'), { code: 'CHANNEL_NOT_ALLOWED' }),
    new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old Host'),
  ])('downgrades an unsupported attention channel without an alert (%s)', async (error) => {
    mocks.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === 'notification:clear-session-attention') throw error;
      if (channel === 'maker:schedule:list-sidebar-index-runs') return { runs: [] };
      return [];
    });
    mount();
    await markRead();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('host', 'maker:schedule:list', []);
  });

  it('reports a missing Host before sending any request', async () => {
    mount();
    await markRead({ id: 'unknown' } as RemoteSession);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('devices.list.alert.actionFailed', 'devices.list.error.sessionDeviceNotFound');
  });

  it('still reports real attention write failures', async () => {
    mocks.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === 'notification:clear-session-attention') throw new Error('permission denied');
      if (channel === 'maker:schedule:list-sidebar-index-runs') return { runs: [] };
      return [];
    });
    mount();
    await markRead();
    expect(Alert.alert).toHaveBeenCalledWith('devices.list.alert.actionFailed', 'permission denied');
  });

  it('reports schedule lookup failure while still clearing the unchanged attention', async () => {
    mocks.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === 'maker:schedule:list') throw new Error('schedule unavailable');
    });
    mount();
    await markRead({ ...task, source: 'scheduler' });
    expect(mocks.invoke).toHaveBeenCalledWith('host', 'notification:clear-session-attention', ['task', 'explicit'], { preSend: expect.any(Function) });
    expect(Alert.alert).toHaveBeenCalledExactlyOnceWith('devices.list.alert.actionFailed', 'schedule unavailable');
  });
});

// #7402, unit: use the real metadata writer/store/queue. Mark-read tests never
// write pin fields; one globally pinned task distinguishes field rollback.
it('writes and rolls back project pins independently of the global pin', async () => {
  const row = { ...task, status: 'active', workspaceKind: 'project', workingDir: '/repo',
    title: 'Task', pinnedAt: '2026-01-01T00:00:00Z', projectPinnedAt: null } as RemoteSession;
  remoteSessionStore.setDeviceSessions('old-shard', 'Computer', [row]);
  vi.mocked(withNewSessionCreationRemoval).mockImplementation(async (_id, _device, _status, mutate) => mutate());
  mocks.invoke.mockImplementation(async (_device: string, _channel: string, args: unknown[]) =>
    ({ ...row, ...(args[1] as object) }));
  mount('host');
  const at = '2026-10-27T00:00:00Z';
  await act(async () => { await actions.patchSession(row, { projectPinnedAt: at }); });
  expect(remoteSessionStore.getSessions().find(s => s.id === row.id))
    .toMatchObject({ projectPinnedAt: at, pinnedAt: row.pinnedAt });
  const pinned = remoteSessionStore.getSessions().find(s => s.id === row.id)!;
  mocks.invoke.mockRejectedValue(new Error('PERMISSION_DENIED'));
  await act(async () => {
    await expect(actions.patchSession(pinned, { projectPinnedAt: null })).rejects.toThrow('PERMISSION_DENIED');
  });
  expect(remoteSessionStore.getSessions().find(s => s.id === row.id))
    .toMatchObject({ projectPinnedAt: at, pinnedAt: row.pinnedAt });
});
