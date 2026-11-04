// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer, type TaskMigrationView } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { TaskMigrationStatus, useTaskMigrationStatus } from '../TaskMigrationStatus';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: {} }));

type LinkStatus = 'stopped' | 'connecting' | 'online';
type Listener = (event: { status: LinkStatus }) => void;
const listeners = new Set<Listener>();
const getState = vi.fn();
const taskMigration = vi.fn();
const session = { id: 'task', status: 'active' } as Session;
const complete: TaskMigrationView = { supported: true, deviceId: 'self', stage: 'complete' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function push(status: LinkStatus) {
  await act(async () => {
    for (const listener of listeners) listener({ status });
  });
}

async function advance(ms = 10_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  getState.mockReset().mockResolvedValue({ linkStatus: 'online' });
  taskMigration.mockReset().mockResolvedValue(complete);
  setDataOwnerGeneration('owner');
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        getState,
        taskMigration,
        listDevices: async () => ({ devices: [] }),
        onStatusChanged: (listener: Listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// #5546: the mounted task header queried task-copy every 10s even in local mode.
// No previous test covered this observer; fake timers expose IPC traffic and stale results.
it.each(['stopped', 'connecting'] as const)(
  'does not query task-copy while the relay is %s',
  async (linkStatus) => {
    getState.mockResolvedValue({ linkStatus });
    const { result } = renderHook(() => useTaskMigrationStatus(session));
    await advance(30_000);
    expect(taskMigration).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    await push('online');
    expect(taskMigration).toHaveBeenCalledExactlyOnceWith(null, {
      action: 'status',
      sessionId: 'task',
    });
    expect(result.current).toEqual(complete);
    await advance();
    expect(taskMigration).toHaveBeenCalledTimes(2);
  },
);

it.each([
  { pushed: 'online', snapshot: 'stopped', calls: 2 },
  { pushed: 'stopped', snapshot: 'online', calls: 0 },
] as const)(
  'keeps a $pushed push authoritative over a late $snapshot snapshot',
  async ({ pushed, snapshot, calls }) => {
    const initial = deferred<{ linkStatus: LinkStatus }>();
    getState.mockReturnValue(initial.promise);
    renderHook(() => useTaskMigrationStatus(session));
    await push(pushed);
    await act(async () => {
      initial.resolve({ linkStatus: snapshot });
    });
    await advance();
    expect(taskMigration).toHaveBeenCalledTimes(calls);
  },
);

it('resumes after reconnect without waiting for an obsolete request or accepting its result', async () => {
  const old = deferred<TaskMigrationView>();
  taskMigration.mockReturnValueOnce(old.promise);
  const { result, unmount } = renderHook(() => useTaskMigrationStatus(session));
  await advance(0);
  expect(taskMigration).toHaveBeenCalledTimes(1);
  await push('connecting');
  await advance(30_000);
  expect(taskMigration).toHaveBeenCalledTimes(1);
  await push('online');
  expect(taskMigration).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual(complete);
  await act(async () => {
    old.resolve({ ...complete, stage: 'preparing' });
  });
  await push('online');
  expect(result.current).toEqual(complete);
  await advance();
  expect(taskMigration).toHaveBeenCalledTimes(3);
  unmount();
  await push('online');
  await advance(30_000);
  expect(taskMigration).toHaveBeenCalledTimes(3);
  expect(listeners.size).toBe(0);
});

it('retries a failed connection snapshot and preserves recovery from a transient query error', async () => {
  getState.mockRejectedValueOnce(new Error('snapshot unavailable'));
  taskMigration.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] MIGRATION_FAILED'));
  const { result } = renderHook(() => useTaskMigrationStatus(session));
  await advance(0);
  expect(taskMigration).not.toHaveBeenCalled();
  await advance();
  expect(taskMigration).toHaveBeenCalledTimes(1);
  expect(result.current).toBeNull();
  await advance();
  expect(result.current).toEqual(complete);
});

it('pauses only the disconnected remote task while another target keeps polling', async () => {
  const remote = (id: string, connection: 'connected' | 'disconnected'): Session => ({
    ...session,
    id,
    deviceLinkDeviceId: id,
    deviceLinkConnectionStatus: connection,
  });
  const first = renderHook(({ task }) => useTaskMigrationStatus(task), {
    initialProps: { task: remote('A', 'connected') },
  });
  const second = renderHook(() => useTaskMigrationStatus(remote('B', 'connected')));
  await advance(0);
  first.rerender({ task: remote('A', 'disconnected') });
  expect(first.result.current).toEqual(complete);
  taskMigration.mockClear();
  await advance();
  expect(taskMigration).toHaveBeenCalledExactlyOnceWith('B', { action: 'status', sessionId: 'B' });
  expect(second.result.current).toEqual(complete);
  first.rerender({ task: remote('A', 'connected') });
  await advance(0);
  expect(taskMigration).toHaveBeenLastCalledWith('A', { action: 'status', sessionId: 'A' });
  expect(first.result.current).toEqual(complete);
});

// #6362 review: hook-only tests missed the open dialog being unmounted on disconnect.
// Unit: open the real header/dialog, interrupt either connection, and retain its DOM/focus/scroll.
it.each(['relay', 'remote task'] as const)(
  'keeps the open progress dialog mounted across a %s disconnect and reconnect',
  async (connection) => {
    const task: Session =
      connection === 'relay'
        ? session
        : {
            ...session,
            deviceLinkDeviceId: 'A',
            deviceLinkConnectionStatus: 'connected',
          };
    const view = (currentTask: Session) => (
      <MemoryRouter>
        <TaskMigrationStatus session={currentTask} />
      </MemoryRouter>
    );
    const { rerender } = render(view(task));
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: 'taskMigration.stages.complete' }));
    await advance(0);
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'taskMigration.close' });
    close.focus();
    dialog.scrollTop = 42;

    if (connection === 'relay') await push('connecting');
    else rerender(view({ ...task, deviceLinkConnectionStatus: 'disconnected' }));
    expect(screen.queryByRole('dialog')).toBe(dialog);
    expect(document.activeElement).toBe(close);
    expect(dialog.scrollTop).toBe(42);

    if (connection === 'relay') await push('online');
    else rerender(view(task));
    await advance(0);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(document.activeElement).toBe(close);
    expect(dialog.scrollTop).toBe(42);
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);

it.each([
  { remoteHostId: 'ssh-host' },
  { deviceLinkDeviceId: sharedTaskHostPeer('shared-task', 'host') },
])('keeps unsupported tasks out of the observer: %j', async (fields) => {
  renderHook(() => useTaskMigrationStatus({ ...session, ...fields }));
  await advance(30_000);
  expect(taskMigration).not.toHaveBeenCalled();
  expect(getState).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});

it('does not let a previous task response overwrite the newly selected task', async () => {
  const old = deferred<TaskMigrationView>();
  taskMigration.mockReturnValueOnce(old.promise);
  const { result, rerender } = renderHook(({ task }) => useTaskMigrationStatus(task), {
    initialProps: { task: session },
  });
  await advance(0);
  rerender({ task: { ...session, id: 'next' } });
  await advance(0);
  await act(async () => {
    old.resolve({ ...complete, stage: 'preparing' });
  });
  expect(result.current).toEqual(complete);
  taskMigration.mockClear();
  await advance();
  expect(taskMigration).toHaveBeenCalledExactlyOnceWith(null, {
    action: 'status',
    sessionId: 'next',
  });
  taskMigration.mockReturnValue(new Promise(() => {}));
  rerender({ task: { ...session, id: 'another' } });
  expect(result.current).toBeNull();
});

it('does not dispatch a queued poll after the data owner changes', async () => {
  renderHook(() => useTaskMigrationStatus(session));
  await advance(0);
  setDataOwnerGeneration('different-owner');
  await advance(30_000);
  expect(taskMigration).toHaveBeenCalledTimes(1);
});
