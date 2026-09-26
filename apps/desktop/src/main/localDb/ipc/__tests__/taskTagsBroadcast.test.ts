import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withTaskMigrationBoundary } from '../../../task-migration/writeBoundary';
const h = vi.hoisted(() => ({ tx: vi.fn(), send: vi.fn(), tap: vi.fn(), session: vi.fn(), root: '', frozen: new Set<string>() }));
vi.mock('../../../task-migration/journal', () => ({
  migrationScope: () => ({ root: h.root, assertCurrent() {} }),
  assertTaskMigrationWritable: (id: string) => {
    if (h.frozen.has(id)) throw new Error('MIGRATION_TASK_MOVED');
  },
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: h.send } }] },
}));
vi.mock('../../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../client/current', () => ({ getDbClient: () => ({ tx: h.tx }) }));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: () => true,
}));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: h.tap,
  captureDataOwnerBroadcastScope: () => ({ ownerStamp: 'owner' }),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../sessions', () => ({ broadcastSessionPatched: h.session }));
import { executeTaskTags } from '../taskTags';
beforeEach(async () => {
  vi.clearAllMocks();
  h.frozen.clear();
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-tag-admission-'));
});
afterEach(async () => { await fs.rm(h.root, { recursive: true, force: true }); });
it.each(['attach', 'detach'] as const)(
  'broadcasts the revised catalog after %s to local and remote editors',
  async (action) => {
    const tags = [{ id: 'tag', name: 'Tag', color: 'red', revision: 2, favoriteOrder: null }];
    h.tx.mockResolvedValue({
      tags,
      sessions: [{ sessionId: 'task', tags: action === 'attach' ? tags : [] }],
    });
    await executeTaskTags({ action, sessionIds: ['task'], tagIds: ['tag'] });
    expect(h.tap).toHaveBeenCalledWith('local-db:task-tags:changed', { tags }, 'owner');
    expect(h.send).toHaveBeenCalledWith('local-db:task-tags:changed', { tags }, 'owner');
    expect(h.session).toHaveBeenCalledWith(
      'task',
      { tags: action === 'attach' ? tags : [] },
      { ownerStamp: 'owner' },
    );
  },
);

it.each(['attach', 'detach'] as const)('rejects a whole %s batch if any member has migrated', async action => {
  h.frozen.add('worker');
  await expect(executeTaskTags({ action, sessionIds: ['ordinary', ' worker '], tagIds: ['tag'] }))
    .rejects.toThrow('MIGRATION_TASK_MOVED');
  expect(h.tx).not.toHaveBeenCalled();
  expect(h.tap).not.toHaveBeenCalled();
});

it.each(['attach', 'detach'] as const)('keeps preparation behind %s commit and rejects later edits', async action => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const commit = new Promise<void>(resolve => { release = resolve; });
  h.tx.mockImplementationOnce(async () => {
    started();
    await commit;
    return { tags: [], sessions: [] };
  });
  const write = executeTaskTags({ action, sessionIds: ['lead', 'worker'], tagIds: ['tag'] });
  await entered;
  const preparing = vi.fn(async () => { h.frozen.add('worker'); });
  const migration = withTaskMigrationBoundary(['worker'], preparing);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(preparing).not.toHaveBeenCalled();
  release();
  await Promise.all([write, migration]);
  await expect(executeTaskTags({ action, sessionIds: ['worker'], tagIds: ['tag'] }, 'caller'))
    .rejects.toThrow('MIGRATION_TASK_MOVED');
  expect(h.tx).toHaveBeenCalledTimes(1);
});

it.each(['attach', 'detach'] as const)('rechecks %s after waiting behind preparation', async action => {
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const migration = withTaskMigrationBoundary(['worker'], async () => {
    entered();
    await gate;
    h.frozen.add('worker');
  });
  await inside;
  const rejected = expect(executeTaskTags({ action, sessionIds: ['worker'], tagIds: ['tag'] }))
    .rejects.toThrow('MIGRATION_TASK_MOVED');
  release();
  await Promise.all([migration, rejected]);
  expect(h.tx).not.toHaveBeenCalled();
});
