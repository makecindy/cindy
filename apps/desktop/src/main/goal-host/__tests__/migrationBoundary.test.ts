import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GoalControllerDeps } from '../types';

const state = vi.hoisted(() => ({
  root: '',
  blocked: false,
  deps: null as GoalControllerDeps | null,
  effect: vi.fn(async () => undefined),
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../../task-migration/journal', () => ({
  migrationScope: () => ({ root: state.root, assertCurrent() {} }),
  assertTaskMigrationWritable: () => {
    if (state.blocked) throw new Error('MIGRATION_READ_ONLY');
  },
}));
vi.mock('../../maker-ipc/register.js', () => ({
  acquirePendingAgentSwitchForDirectSend: vi.fn(),
  isSessionInTurn: vi.fn(),
  stopActiveGoalTurnForClear: vi.fn(),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: () => state.effect(),
}));
vi.mock('../../maker-host/goal-settings-store.js', () => ({
  readGoalSettings: vi.fn(),
  writeGoalSettings: vi.fn(),
}));
vi.mock('../../usage/claudeAccountUsage.js', () => ({ readClaudeAccountUsageSnapshot: vi.fn() }));
vi.mock('../../usageBroadcaster.js', () => ({ readCodexAccountUsageSnapshot: vi.fn() }));
vi.mock('../sessionRestore.js', () => ({ restoreSessionForGoal: () => state.effect() }));
vi.mock('../storage', () => ({
  GoalStorage: class {
    get = vi.fn();
    listActive = vi.fn();
    listUsageLimited = vi.fn();
    upsert = () => state.effect();
    update = () => state.effect();
    clear = () => state.effect();
  },
}));
vi.mock('../controller', () => ({
  GoalController: class {
    constructor(deps: GoalControllerDeps) {
      state.deps = deps;
    }
    resumeActiveGoals = async () => {};
    dispose = async () => {};
  },
}));

import { resetGoalController, startGoalController } from '../index';
import { withTaskMigrationBoundary } from '../../task-migration/writeBoundary';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-migration-'));
  state.blocked = false;
  state.effect.mockReset().mockResolvedValue(undefined);
  startGoalController({ maker: {} as never, getDb: vi.fn(), broadcastStatus: vi.fn() });
});
afterEach(async () => {
  await resetGoalController();
  await fs.rm(state.root, { recursive: true, force: true });
});

it('guards all production Goal side effects after migration', async () => {
  state.blocked = true;
  const d = state.deps!;
  const writes = [
    () => d.ensureSession('task'),
    () => d.storage.upsert({ sessionId: 'task' } as never),
    () => d.storage.update('task', { status: 'active' }),
    () => d.storage.clear('task'),
    () => d.persistUserMessage!('task', 'new objective'),
    () => d.persistGoalCompletion!('task', {} as never),
    () => d.persistGoalNotice!('task', 'usage-resumed'),
  ];
  for (const write of writes) await expect(write()).rejects.toThrow('MIGRATION_READ_ONLY');
  expect(state.effect).not.toHaveBeenCalled();
});

it('keeps migration behind Goal restore until the effect settles, including rejection', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.effect.mockImplementationOnce(async () => {
    entered();
    await gate;
    throw new Error('restore failed');
  });
  const restore = expect(state.deps!.ensureSession('task')).rejects.toThrow('restore failed');
  await started;
  const migrate = vi.fn(async () => {
    state.blocked = true;
  });
  const migration = withTaskMigrationBoundary(['task'], migrate);
  expect(migrate).not.toHaveBeenCalled();
  release();
  await Promise.all([restore, migration]);
  expect(migrate).toHaveBeenCalledOnce();
  await expect(state.deps!.storage.update('task', { status: 'active' })).rejects.toThrow(
    'MIGRATION_READ_ONLY',
  );
});
