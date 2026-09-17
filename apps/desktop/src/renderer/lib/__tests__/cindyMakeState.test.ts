import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cindyMakeState } from '../cindyMakeState';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { CindyMakeGlobalState } from '../../../shared/cindyMakeDoctor';

const subscriptions: Array<() => void> = [];
let push: (state: CindyMakeGlobalState) => void;
let resolve: (state: CindyMakeGlobalState) => void;
let api: {
  getCindyMakeState: ReturnType<typeof vi.fn>;
  onCindyMakeState: ReturnType<typeof vi.fn>;
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
});
