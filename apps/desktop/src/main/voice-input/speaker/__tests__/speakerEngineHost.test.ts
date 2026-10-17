import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const workers: FakeWorker[] = [];
class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; op: string }> = [];
  terminate = vi.fn(async () => 0);
  unref = vi.fn();
  postMessage = vi.fn((request: { id: number; op: string }) => { this.sent.push(request); });
  constructor() { super(); workers.push(this); }
  reply() { this.emit('message', { id: this.sent.at(-1)!.id, ok: true }); }
}
vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));
const { SpeakerEngineHost } = await import('../speakerEngineHost');

afterEach(() => { vi.useRealTimers(); workers.length = 0; });

describe('speaker worker request lifecycle', () => {
  it('times out a stalled model load and allows a fresh worker to retry', async () => {
    vi.useFakeTimers();
    const host = new SpeakerEngineHost(() => ({ vadModel: 'vad', embeddingModel: 'embedding' }), 'worker', 100);
    const pending = host.warm();
    const failure = expect(pending).rejects.toThrow('request_timeout');
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const retry = host.warm();
    expect(workers).toHaveLength(2);
    workers[1].reply();
    await retry;
    host.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out enrollment inference after a successful model load', async () => {
    vi.useFakeTimers();
    const host = new SpeakerEngineHost(() => ({ vadModel: 'vad', embeddingModel: 'embedding' }), 'worker', 100);
    const ready = host.warm();
    workers[0].reply();
    await ready;
    const pending = host.createEnrollmentEngine().embed(new Float32Array(160));
    const failure = expect(pending).rejects.toThrow('request_timeout');
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    host.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
