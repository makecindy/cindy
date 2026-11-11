import type { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { LogEvent, RpcRequest } from '../DbTransport';
const h = vi.hoisted(() => ({ worker: null as (EventEmitter & { sent: RpcRequest[] }) | null }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    sent: RpcRequest[] = [];
    constructor() { super(); h.worker = this; }
    postMessage(req: RpcRequest) { this.sent.push(req); }
    async terminate() { return 0; }
  } };
});
import { WorkerThreadTransport } from '../WorkerThreadTransport';
afterEach(() => vi.restoreAllMocks());
it('separates transport queue, worker wait, execution and main delivery without logging private arguments', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const transport = new WorkerThreadTransport({ useInlineWorker: true, maxInFlightRpcs: 1 });
  const logs: LogEvent[] = [];
  transport.on('log', (event) => logs.push(event));
  const first = transport.send('rawAll', { sql: 'SECRET_SQL', params: ['SECRET_PARAMETER'] });
  const second = transport.send('rawAll', { sql: 'SECRET_SQL' });
  const epoch = performance.timeOrigin;
  now = 400;
  h.worker!.emit('message', { id: 1, ok: true, result: [], timing: { startedAt: epoch + 100, finishedAt: epoch + 300 } });
  await first;
  expect(h.worker!.sent).toHaveLength(2);
  now = 600;
  h.worker!.emit('message', { id: 2, ok: false, error: { code: 'TEST', message: 'SECRET_ERROR' },
    timing: { startedAt: epoch + 450, finishedAt: epoch + 550 } });
  await expect(second).rejects.toThrow('SECRET_ERROR');
  expect(logs.map((e) => e.payload)).toEqual([
    expect.objectContaining({ totalMs: 400, queueMs: 0, workerWaitMs: 100, workerExecutionMs: 200, deliveryMs: 100 }),
    expect.objectContaining({ totalMs: 600, queueMs: 400, workerWaitMs: 50, workerExecutionMs: 100, deliveryMs: 50, ok: false }),
  ]);
  expect(JSON.stringify(logs)).not.toContain('SECRET');
  transport.on('log', () => { throw new Error('broken debug sink'); });
  const third = transport.send('rawAll', {});
  now = 900;
  expect(() => h.worker!.emit('message', { id: 3, ok: true, result: [] })).not.toThrow();
  await expect(third).resolves.toEqual([]);
  const closing = transport.close();
  h.worker!.emit('message', { id: 4, ok: true, result: undefined });
  await closing;
});
