import { beforeEach, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient';
import type { PluginUsageIdentity } from '../../../shared/pluginUsage';
import { currentPluginUsageService, flushPluginUsageLifecycle } from '../current';
const state = vi.hoisted(() => ({
  snapshot: null as { client: DbClient; userId: string; clientEpoch: number } | null,
  owner: 'owner1',
  key: 'owner1:1',
  boundary: false,
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientSnapshot: () => state.snapshot,
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => state.key,
  getActiveAppSession: () => ({ dataOwnerId: state.owner }),
  isAppSessionBoundaryPending: () => state.boundary,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../reporting', () => ({ createPluginUsageReporting: () => undefined }));
const identity: PluginUsageIdentity = {
  ghostId: 'plugin',
  displayName: 'Plugin',
  revision: 'revision',
  sourceKind: 'manual',
  stableKey: null,
  pluginId: null,
  organizationId: null,
  sourceKey: null,
  serverRoot: null,
  version: '1',
  releaseId: null,
};
beforeEach(async () => {
  state.owner = 'owner1';
  state.key = 'owner1:1';
  state.boundary = false;
  state.snapshot = null;
  await flushPluginUsageLifecycle();
});
function client() {
  return {
    tx: vi.fn(async (_name, body) =>
      body.action === 'bind'
        ? { subjectId: body.newId, historyGeneration: 0, identity: body.identity }
        : null,
    ),
  } as unknown as DbClient;
}
it('never treats a retained inproc client reference as proof of owner/epoch continuity', async () => {
  const db = client();
  state.snapshot = { client: db, userId: state.owner, clientEpoch: 1 };
  const old = currentPluginUsageService()!;
  await old.bind(identity);
  const h = old.captureBound('plugin', 'revision')!;
  state.owner = 'owner2';
  state.key = 'owner2:2';
  state.snapshot = { client: db, userId: 'owner2', clientEpoch: 2 };
  const next = currentPluginUsageService();
  expect(next).not.toBe(old);
  old.accept(h, 'late', 'tool', null, 1);
  await old.close();
  expect(db.tx).toHaveBeenCalledTimes(1);
  await next!.close();
});
it('blocks recreation throughout DB teardown/quit and only reopens for a newly attached epoch', async () => {
  const db = client();
  state.snapshot = { client: db, userId: state.owner, clientEpoch: 1 };
  expect(currentPluginUsageService()).not.toBeNull();
  await flushPluginUsageLifecycle();
  expect(currentPluginUsageService()).toBeNull();
  state.snapshot = { client: db, userId: state.owner, clientEpoch: 2 };
  expect(currentPluginUsageService()).not.toBeNull();
  await flushPluginUsageLifecycle();
});
it('does not bind a DB during a boundary or to a different account', async () => {
  state.snapshot = { client: client(), userId: 'other', clientEpoch: 1 };
  expect(currentPluginUsageService()).toBeNull();
  state.snapshot.userId = state.owner;
  state.boundary = true;
  expect(currentPluginUsageService()).toBeNull();
});
