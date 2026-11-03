import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ binding: '/fixture/electron/better_sqlite3.node', data: {} as Record<string, unknown> }));
vi.mock('../../localDb/betterSqliteFactory.js', () => ({ resolveBetterSqliteNativeBinding: () => h.binding }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  constructor(_file: string, options: { workerData: Record<string, unknown> }) {
    super(); h.data = options.workerData;
    queueMicrotask(() => this.emit('message', { ok: true, jobs: [{ id: 'job' }] }));
  }
  terminate = vi.fn(async () => 0);
} }));
import { readOpenClawCronDatabase } from '../openclawCron.js';
it('forwards the same native binding selected by Main to the readonly foreign-database worker', async () => {
  await expect(readOpenClawCronDatabase({ database: 'source.sqlite', storeKey: 'store', agentId: 'agent', defaultAgent: false })).resolves.toEqual([{ id: 'job' }]);
  expect(h.data).toMatchObject({ nativeBinding: h.binding, database: 'source.sqlite', agentId: 'agent', defaultAgent: false });
  expect(h.data.modulePath).toMatch(/better-sqlite3/);
});
