// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import '../../preload/preload';
import { setDataOwnerGeneration, __testing as dataOwnerTesting } from '@/contexts/dataOwnerGeneration';
import { useCCSessions } from '@/hooks/useCCSessions';
import type { Session } from '@/lib/ccAgent.types';
import { emitRefresh } from '@/lib/sessionsBus';
import { sessionsStore } from '@/lib/sessionsStore';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => Object.assign(window, { [name]: value }),
  },
  ipcRenderer: {
    invoke: ipc.invoke,
    sendSync: (channel: string) => channel === 'get-app-display-version-info' ? { display: 'test', detail: 'test' } : null,
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      ipc.listeners.set(channel, listener);
    },
    removeListener: (channel: string) => ipc.listeners.delete(channel),
  },
}));

const owner = { dataOwnerId: 'synthetic-owner', ownerGeneration: 1 };

function announce(index: number): void {
  const sessionId = `created-${index}`;
  if (index % 3 === 2) emitRefresh();
  else if (index % 3 === 1) {
    ipc.listeners.get('local-db:sessions:created')!({}, { sessionId }, owner);
  } else {
    ipc.listeners.get('maker:schedule:event')!({}, { type: 'session-bound', sessionId }, owner);
  }
}

async function loadOpenTask() {
  setDataOwnerGeneration(owner.dataOwnerId, owner.ownerGeneration);
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    id: `initial-${index}`, status: 'active',
  }) as Session);
  ipc.invoke.mockResolvedValueOnce(rows);
  await sessionsStore.ensureByFilter('active');

  const reads: {
    finish: (error?: Error) => void;
  }[] = [];
  let snapshot = rows;
  let pending = 0;
  let peak = 0;
  ipc.invoke.mockImplementation((channel, limit, filter, options) => {
    expect([channel, limit, filter, options]).toEqual([
      'local-db:sessions:list', 1000, 'active', { fresh: true },
    ]);
    const captured = snapshot;
    peak = Math.max(peak, ++pending);
    return new Promise<Session[]>((resolve, reject) => {
      reads.push({ finish: (error) => {
        pending--;
        if (error) reject(error);
        else resolve(captured);
      } });
    });
  });

  return {
    reads,
    get peak() { return peak; },
    get pending() { return pending; },
    create(index: number) {
      snapshot = [{ id: `created-${index}`, status: 'active' } as Session, ...snapshot.slice(0, -1)];
      announce(index);
    },
  };
}

afterEach(() => {
  cleanup();
  sessionsStore.reset();
  dataOwnerTesting.reset();
  ipc.invoke.mockReset();
});

// Unit, #12460: real bus and preload push -> store -> IPC invoke. Existing
// single-notification tests miss concurrent full reads. Two notifications during
// one slow read suffice to reproduce the overlap. Repeat through all three inputs.
it('bounds warm-list IPC while retaining the open task and the last creation', async () => {
  const fixture = await loadOpenTask();
  const visible = sessionsStore.getByFilter('active');
  for (let index = 0; index < 9; index++) fixture.create(index);
  expect(sessionsStore.getByFilter('active')).toBe(visible);
  expect(sessionsStore.findById('initial-0')).toBe(visible?.[0]);

  const firstWave = [...fixture.reads];
  await act(async () => {
    for (const read of firstWave.reverse()) read.finish();
  });
  // A schedule push during the tail read must schedule another tail on its own.
  fixture.create(9);
  await act(async () => {
    for (const read of fixture.reads.slice(firstWave.length)) read.finish();
  });
  await act(async () => {
    if (fixture.pending) fixture.reads.at(-1)!.finish();
  });

  expect(sessionsStore.getByFilter('active')?.slice(0, 10).map(row => row.id)).toEqual(
    Array.from({ length: 10 }, (_, index) => `created-${9 - index}`),
  );
  expect(fixture.pending).toBe(0);
  expect({ peak: fixture.peak, requests: fixture.reads.length }).toEqual({ peak: 1, requests: 3 });
});

// Unit: a failed refresh must still drain a queued notification, but reset
// must discard both the old response and its queued read.
it.each(['failure', 'account switch'])('handles a queued creation after %s', async (boundary) => {
  const fixture = await loadOpenTask();
  fixture.create(0);
  fixture.create(1);
  if (boundary === 'account switch') {
    setDataOwnerGeneration('other-owner', 2);
    sessionsStore.reset();
    ipc.invoke.mockResolvedValueOnce([{ id: 'other-task' }]);
    await sessionsStore.ensureByFilter('active');
    await act(async () => { fixture.reads[0]!.finish(); });
    expect(sessionsStore.getByFilter('active')?.map(row => row.id)).toEqual(['other-task']);
    expect(fixture.reads).toHaveLength(1);
  } else {
    await act(async () => { fixture.reads[0]!.finish(new Error('list failed')); });
    expect(sessionsStore.getByFilter('active')?.[0]?.id).toBe('initial-0');
    await act(async () => { fixture.reads[1]!.finish(); });
    expect(sessionsStore.getByFilter('active')?.[0]?.id).toBe('created-1');
    expect(fixture.reads).toHaveLength(2);
  }
  expect(fixture.peak).toBe(1);
  expect(fixture.pending).toBe(0);
});

it('lets an explicit refresh supersede a pending notification and consume its queued read', async () => {
  const fixture = await loadOpenTask();
  fixture.create(0);
  fixture.create(1);
  const explicit = sessionsStore.forceRefresh('active');
  expect(fixture.reads).toHaveLength(2);
  await act(async () => { fixture.reads[1]!.finish(); });
  expect((await explicit)[0]?.id).toBe('created-1');
  await act(async () => { fixture.reads[0]!.finish(); });
  expect(sessionsStore.getByFilter('active')?.[0]?.id).toBe('created-1');
  expect(fixture.reads).toHaveLength(2);
  expect(fixture.pending).toBe(0);
});

// Unit, #12471 review: an old snapshot captured before prependCreated must
// preserve the visible row through a failed tail. A later snapshot still owns it.
it('keeps a locally opened creation through stale reads and a failed tail', async () => {
  const fixture = await loadOpenTask();
  const task = { id: 'local-new', status: 'active', title: 'Local' } as Session;
  const view = renderHook(() => useCCSessions());
  const visibleTask = () => view.result.current.sessions.find(row => row.id === task.id);
  emitRefresh();
  act(() => sessionsStore.prependCreated(task));
  expect(visibleTask()).toEqual(task);
  announce(1);

  await act(async () => { fixture.reads[0]!.finish(); });
  const duringTail = visibleTask();
  await act(async () => { fixture.reads[1]!.finish(new Error('tail failed')); });
  const afterFailure = visibleTask();

  ipc.invoke.mockResolvedValueOnce([{ ...task, title: 'Authoritative' }]);
  await act(async () => { await sessionsStore.forceRefresh('active'); });
  expect(visibleTask()?.title).toBe('Authoritative');
  announce(3);
  await act(async () => { fixture.reads[2]!.finish(); });
  expect(visibleTask()).toBeUndefined();
  expect({ duringTail, afterFailure }).toEqual({ duringTail: task, afterFailure: task });
  expect(fixture.peak).toBe(1);
});

it.each<Partial<Session>>([{ status: 'deleted' }, { status: 'archived' }, { hiddenAt: 'hidden' }])(
  'does not restore a prepended row removed from the active bucket by %j',
  async (patch) => {
    const fixture = await loadOpenTask();
    const task = { id: 'local-new', status: 'active' } as Session;
    emitRefresh();
    sessionsStore.prependCreated(task);
    ipc.listeners.get('local-db:sessions:patched')!({}, { sessionId: task.id, patch }, owner);
    expect(sessionsStore.findById(task.id)).toBeNull();

    const firstWave = [...fixture.reads];
    await act(async () => {
      for (const read of firstWave.reverse()) read.finish();
    });
    await act(async () => {
      for (const read of fixture.reads.slice(firstWave.length)) read.finish();
    });
    expect(sessionsStore.getByFilter('active')?.some(row => row.id === task.id)).toBe(false);
    expect(fixture.pending).toBe(0);
  },
);

// Unit, #12471 review: two failed notification reads with another queued
// invalidate must keep both initial waiters pending for the fourth read.
it.each(['success', 'failure'])('keeps cold waiters on the final read (%s)', async (outcome) => {
  setDataOwnerGeneration(owner.dataOwnerId, owner.ownerGeneration);
  const reads: { resolve: (rows: Session[]) => void; reject: (error: Error) => void }[] = [];
  ipc.invoke.mockImplementation(() => new Promise<Session[]>((resolve, reject) => {
    reads.push({ resolve, reject });
  }));
  const observe = vi.fn();
  const load = () => sessionsStore.ensureByFilter('active').then(() => observe('success'), observe);
  const first = load();
  announce(1);
  const second = load();
  announce(2);
  expect(reads).toHaveLength(2);
  await act(async () => { reads[1]!.reject(new Error('first fresh read failed')); });
  expect(reads).toHaveLength(3);
  announce(3);
  await act(async () => { reads[2]!.reject(new Error('second fresh read failed')); });
  expect(reads).toHaveLength(4);
  const whileFinalPending = observe.mock.calls.length;

  const failure = new Error('final read failed');
  const task = { id: 'final', status: 'active' } as Session;
  if (outcome === 'success') reads[3]!.resolve([task]);
  else reads[3]!.reject(failure);
  await Promise.all([first, second]);
  expect(reads).toHaveLength(4);

  await act(async () => { reads[0]!.resolve([{ ...task, id: 'superseded' }]); });
  expect(sessionsStore.findById('superseded')).toBeNull();
  expect(whileFinalPending).toBe(0);
  expect(observe.mock.calls).toEqual(Array.from({ length: 2 }, () => [
    outcome === 'success' ? 'success' : expect.objectContaining({ message: failure.message }),
  ]));
  expect(sessionsStore.findById(task.id)).toEqual(outcome === 'success' ? task : null);
});
