import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withTaskMigrationBoundary, withTaskMigrationWrite } from '../writeBoundary';
import { withTaskMigrationInputAcceptance } from '../inputGuard';
import { setSessionRouteLockImplementation, withSessionRouteLock } from '../../localDb/sessionRouteLock';
import { withSendToSessionLock, trackSendToSessionLockRun } from '../../maker-ipc/sendToSessionLock';

const state = vi.hoisted(() => ({ migrating: false, root: '' }));
vi.mock('../journal', () => ({
  assertTaskMigrationWritable: () => {
    if (state.migrating) throw new Error('MIGRATION_TASK_BUSY');
  },
  migrationScope: () => ({ root: state.root, assertCurrent() {}, list: () => [] }),
}));
vi.mock('../../localDb/client/current', () => ({
  getDbClient: () => ({ queryOne: async () => ({ workingDir: null }) }),
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
beforeEach(async () => { state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-admission-')); });
afterEach(async () => {
  state.migrating = false;
  setSessionRouteLockImplementation(null);
  await fs.rm(state.root, { recursive: true, force: true });
});
describe('migration and final input acceptance', () => {
  it('serializes independent lock owners until input is durable, then rejects late writes', async () => {
    // A second module graph has no shared in-process mutex or async context.
    vi.resetModules();
    const other = await import('../writeBoundary');
    const accepted = barrier();
    const persist = barrier();
    let durable = false;
    const input = withTaskMigrationWrite('task', async () => {
      accepted.release();
      await persist.promise;
      durable = true;
    });
    await accepted.promise;
    const start = vi.fn(async () => {
      expect(durable).toBe(true);
      state.migrating = true;
    });
    const migration = other.withTaskMigrationBoundary(['task'], start);
    expect(start).not.toHaveBeenCalled();
    persist.release();
    await Promise.all([input, migration]);
    const clearOrGoal = vi.fn(async () => undefined);
    await expect(withTaskMigrationWrite('task', clearOrGoal)).rejects.toThrow('MIGRATION_TASK_BUSY');
    expect(clearOrGoal).not.toHaveBeenCalled();
  });

  it('fences Worker writes when a group migration wins admission', async () => {
    const started = barrier();
    const prepare = barrier();
    const migration = withTaskMigrationBoundary(['worker', 'lead'], async () => {
      started.release();
      await prepare.promise;
      state.migrating = true;
    });
    await started.promise;
    const effect = vi.fn(async () => undefined);
    const input = withTaskMigrationWrite('worker', effect);
    const rejected = expect(input).rejects.toThrow('MIGRATION_TASK_BUSY');
    prepare.release();
    await migration;
    await rejected;
    expect(effect).not.toHaveBeenCalled();
  });
  it('shares the route lock with chain-form programmatic sends', async () => {
    setSessionRouteLockImplementation(withSendToSessionLock);
    const gate = barrier();
    const sending = trackSendToSessionLockRun('task', gate.promise);
    const start = vi.fn();
    const migration = withSessionRouteLock('task', async () => { start(); });
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    gate.release();
    await Promise.all([sending, migration]);
    expect(start).toHaveBeenCalledOnce();
  });
  it('rejects prepared input when migration wins the route lock', async () => {
    setSessionRouteLockImplementation(withSendToSessionLock);
    const gate = barrier();
    const started = barrier();
    const migration = withSessionRouteLock('task', async () => {
      started.release();
      await gate.promise;
      state.migrating = true;
    });
    await started.promise;
    const accept = vi.fn(async () => undefined);
    const input = withTaskMigrationInputAcceptance('task', accept);
    const rejected = expect(input).rejects.toThrow('MIGRATION_TASK_BUSY');
    gate.release();
    await migration;
    await rejected;
    expect(accept).not.toHaveBeenCalled();
  });
  it('keeps migration behind accepted input until its queue snapshot is durable', async () => {
    setSessionRouteLockImplementation(withSendToSessionLock);
    const gate = barrier();
    const accepted = barrier();
    let durable = false;
    const input = withTaskMigrationInputAcceptance('task', async () => {
      accepted.release();
      await gate.promise;
      durable = true;
    });
    await accepted.promise;
    const observe = vi.fn(() => expect(durable).toBe(true));
    const migration = withSessionRouteLock('task', async () => { observe(); });
    await Promise.resolve();
    expect(observe).not.toHaveBeenCalled();
    gate.release();
    await Promise.all([input, migration]);
    expect(observe).toHaveBeenCalledOnce();
  });
});
