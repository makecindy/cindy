import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cindyMakeState } from '../cindyMakeState';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { CindyMakeGlobalState, MakeDoctorReport } from '../../../shared/cindyMakeDoctor';

const subscriptions: Array<() => void> = [];
let push: (state: CindyMakeGlobalState) => void;
let resolve: (state: CindyMakeGlobalState) => void;
let api: {
  getCindyMakeState: ReturnType<typeof vi.fn>;
  onCindyMakeState: ReturnType<typeof vi.fn>;
  manageCindyMakeTask: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  setDataOwnerGeneration('make-state-owner');
  api = {
    getCindyMakeState: vi.fn(
      () =>
        new Promise<CindyMakeGlobalState>((done) => {
          resolve = done;
        }),
    ),
    onCindyMakeState: vi.fn((listener) => {
      push = listener;
      return vi.fn();
    }),
    manageCindyMakeTask: vi.fn(async () => undefined),
  };
  vi.stubGlobal('window', { electronAPI: api });
});
afterEach(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  vi.unstubAllGlobals();
});
function subscribe() {
  const listener = vi.fn();
  subscriptions.push(cindyMakeState.subscribe(listener));
  return listener;
}

function taskReport(sessionId: string): MakeDoctorReport {
  return {
    runId: sessionId + '-run',
    platform: 'win32',
    arch: 'x64',
    checks: [],
    status: 'completed',
    task: { sessionId, phase: 'completed', sessionStatus: 'active' },
  };
}

describe('read-only Main Cindy Make state', () => {
  it('shares one subscription between Settings, task cards and the sidebar', () => {
    const first = subscribe();
    const second = subscribe();
    const state: CindyMakeGlobalState = {
      source: { status: 'preparing', path: '/source', phase: 'installing' },
    };
    push(state);
    expect(api.onCindyMakeState).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(cindyMakeState.getSnapshot()).toBe(state);
  });

  it('never replaces newer progress with a stale initial read', async () => {
    subscribe();
    const state: CindyMakeGlobalState = { source: { status: 'ready', path: '/source' } };
    push(state);
    resolve({ source: { status: 'preparing', path: '/source' } });
    await Promise.resolve();
    expect(cindyMakeState.getSnapshot()).toBe(state);
    expect(cindyMakeState.isLoaded()).toBe(true);
  });

  it('rejects late responses from a disconnected view', async () => {
    subscribe();
    const oldResolve = resolve;
    subscriptions.pop()!();
    subscribe();
    const state: CindyMakeGlobalState = { source: { status: 'ready', path: '/source' } };
    push(state);
    oldResolve({ source: { status: 'missing', path: '/old' } });
    await Promise.resolve();
    expect(cindyMakeState.getSnapshot()).toBe(state);
  });

  it('rejects stale account pushes and reconnects with an empty account snapshot', async () => {
    subscribe();
    const oldPush = push;
    const oldOwner = getDataOwnerGeneration();
    setDataOwnerGeneration('other-owner');
    subscribe();
    expect(cindyMakeState.getSnapshot()).toEqual({});
    oldPush({ source: { status: 'ready', path: '/old' } });
    push({
      source: { status: 'ready', path: '/old' },
      ownerStamp: { dataOwnerId: oldOwner.dataOwnerId, ownerGeneration: oldOwner.generation },
    });
    expect(cindyMakeState.getSnapshot()).toEqual({});
    resolve({ source: { status: 'missing', path: '/current' } });
    await Promise.resolve();
    expect(cindyMakeState.getSnapshot().source?.path).toBe('/current');
  });

  it.each(['delete', 'finish'] as const)(
    'applies a successful %s to all subscribers only after Main acknowledges it',
    async (action) => {
      const listener = subscribe();
      const otherTask = taskReport('other');
      const source: CindyMakeGlobalState['source'] = { status: 'ready', path: '/source' };
      const otherAction = { action: 'delete' as const, status: 'running' as const };
      const state: CindyMakeGlobalState = {
        tasks: { target: taskReport('target'), other: otherTask },
        taskActions: { target: { action, status: 'running' }, other: otherAction },
        source,
      };
      push(state);
      let complete!: () => void;
      api.manageCindyMakeTask.mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            complete = done;
          }),
      );
      const operation = cindyMakeState.manageTask('target', action);
      expect(api.manageCindyMakeTask).toHaveBeenCalledWith('target', action);
      expect(cindyMakeState.getSnapshot()).toBe(state);
      listener.mockClear();
      complete();
      await operation;
      expect(cindyMakeState.getSnapshot()).toEqual({
        tasks: { other: otherTask },
        taskActions: { other: otherAction },
        source,
      });
      expect(listener).toHaveBeenCalledOnce();
    },
  );

  it.each(['refresh', 'reconnect'] as const)(
    'does not restore a completed task from a late %s read',
    async (read) => {
      subscribe();
      const stale: CindyMakeGlobalState = {
        tasks: { target: taskReport('target') },
        taskActions: { target: { action: 'delete', status: 'running' } },
      };
      push(stale);
      let refresh: Promise<void> | undefined;
      if (read === 'reconnect') {
        subscriptions.pop()!();
        subscribe();
      } else {
        refresh = cindyMakeState.refresh();
      }
      await cindyMakeState.manageTask('target', 'delete');
      resolve(stale);
      await refresh;
      expect(cindyMakeState.getSnapshot().tasks).toBeUndefined();
      expect(cindyMakeState.getSnapshot().taskActions).toEqual({});
    },
  );

  it('keeps a failed cleanup in the list for retry', async () => {
    subscribe();
    const state: CindyMakeGlobalState = { tasks: { target: taskReport('target') } };
    push(state);
    api.manageCindyMakeTask.mockRejectedValueOnce(new Error('directoryBusy'));
    await expect(cindyMakeState.manageTask('target', 'delete')).rejects.toThrow('directoryBusy');
    expect(cindyMakeState.getSnapshot()).toBe(state);
  });

  it('ignores an old account cleanup acknowledgement after reconnecting', async () => {
    subscribe();
    let complete!: () => void;
    api.manageCindyMakeTask.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          complete = done;
        }),
    );
    const operation = cindyMakeState.manageTask('target', 'delete');
    setDataOwnerGeneration('another-owner');
    subscribe();
    const next: CindyMakeGlobalState = { tasks: { target: taskReport('target') } };
    push(next);
    complete();
    await operation;
    expect(cindyMakeState.getSnapshot()).toBe(next);
  });
});
