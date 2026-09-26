import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTaskMigrationInputAcceptance } from '../inputGuard';
import { setSessionRouteLockImplementation, withSessionRouteLock } from '../../localDb/sessionRouteLock';
import { withSendToSessionLock } from '../../maker-ipc/sendToSessionLock';

const state = vi.hoisted(() => ({ migrating: false }));
vi.mock('../journal', () => ({
  assertTaskMigrationWritable: () => {
    if (state.migrating) throw new Error('MIGRATION_TASK_BUSY');
  },
  migrationScope: () => ({ assertCurrent() {}, list: () => [] }),
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
afterEach(() => {
  state.migrating = false;
  setSessionRouteLockImplementation(null);
});
describe('migration and final input acceptance', () => {
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
