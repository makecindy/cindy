import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CindyMakeGlobalState } from '../../../shared/cindyMakeDoctor';

const h = vi.hoisted(() => ({
  scope: { ownerScopeKey: 'owner-a', ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 } },
  current: true,
  tap: vi.fn(),
}));
const windows = [{ isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } }];

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => windows } }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => h.scope,
  isDataOwnerBroadcastScopeCurrent: () => h.current,
  tapWindowBroadcast: h.tap,
}));

let broadcastCindyMakeState: typeof import('../stateBroadcast').broadcastCindyMakeState;
const collectionEvents = () => h.tap.mock.calls.filter(([, event]) => !event.resourceRefs);

beforeEach(async () => {
  vi.resetModules();
  ({ broadcastCindyMakeState } = await import('../stateBroadcast'));
  h.scope = {
    ownerScopeKey: 'owner-a',
    ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
  };
  h.current = true;
  h.tap.mockClear();
  windows[0].webContents.send.mockClear();
});

describe('Cindy Make state broadcast', () => {
  it('invalidates the collection for global personal state without a live task entry', () => {
    const state: CindyMakeGlobalState = {
      personalSync: { running: true, step: 'official' },
    };
    broadcastCindyMakeState(state);
    expect(h.tap).toHaveBeenCalledExactlyOnceWith(
      'maker:remote-resources:changed',
      { collectionId: 'cindy-make' },
      h.scope.ownerStamp,
    );
    for (const personalSync of [
      { running: false, waiting: { kind: 'official', reason: 'input' } },
      { running: false, error: 'network' },
      { running: false, done: { at: 1 } },
    ] satisfies NonNullable<CindyMakeGlobalState['personalSync']>[])
      broadcastCindyMakeState({ personalSync });
    expect(collectionEvents()).toHaveLength(4);
  });

  it('does not repeat the collection invalidation for task-only changes', () => {
    broadcastCindyMakeState({
      personalSync: { running: true, step: 'official' },
      tasks: {
        run: {
          runId: 'run',
          platform: 'win32',
          arch: 'x64',
          status: 'running',
          checks: [],
          task: { sessionId: 'session', phase: 'source' },
        },
      },
    });
    h.tap.mockClear();
    broadcastCindyMakeState({
      personalSync: { running: true, step: 'official' },
      tasks: {
        run: {
          runId: 'run',
          platform: 'win32',
          arch: 'x64',
          status: 'running',
          checks: [],
          task: { sessionId: 'session', phase: 'workspace' },
        },
      },
    });
    expect(h.tap).toHaveBeenCalledExactlyOnceWith(
      'maker:remote-resources:changed',
      {
        collectionId: 'cindy-make',
        resourceRefs: [{ collectionId: 'cindy-make', kind: 'session', id: 'session' }],
      },
      h.scope.ownerStamp,
    );
    expect(collectionEvents()).toHaveLength(0);
  });

  it('invalidates finished resources when the global GitHub state changes', () => {
    const personalRemote: NonNullable<CindyMakeGlobalState['personalRemote']> = {
      github: 'connected',
      offerMigration: false,
      sync: 'pending',
    };
    broadcastCindyMakeState({ personalRemote });
    broadcastCindyMakeState({ personalRemote: { ...personalRemote, sync: 'synced' } });
    expect(collectionEvents()).toHaveLength(2);
  });

  it('invalidates the same global projection for a new owner generation', () => {
    const state: CindyMakeGlobalState = { personalSync: { running: false } };
    broadcastCindyMakeState(state);
    h.scope = { ...h.scope, ownerStamp: { ...h.scope.ownerStamp, ownerGeneration: 2 } };
    broadcastCindyMakeState(state);
    expect(collectionEvents()).toHaveLength(2);
    expect(h.tap).toHaveBeenLastCalledWith(
      'maker:remote-resources:changed',
      { collectionId: 'cindy-make' },
      h.scope.ownerStamp,
    );
  });

  it('does not invalidate resources for a stale captured owner', () => {
    h.current = false;
    broadcastCindyMakeState({ personalSync: { running: true, step: 'official' } });
    expect(h.tap).not.toHaveBeenCalled();
  });
});
