// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import '../../preload/preload';
import { setDataOwnerGeneration, __testing as dataOwnerTesting } from '@/contexts/dataOwnerGeneration';
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
