import { REMOTE_AGENT_READ_MAX_BYTES } from '@cindy/device-link';

type Image = { buffer: Buffer; mimeType: string };
type ReadResult =
  | { state: 'pending' | 'failed' }
  | { state: 'complete'; data: string; mimeType: string; size: number };
const GENERATION_TIMEOUT_MS = 180_000;
const RESULT_LIFETIME_MS = 300_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 4;

export function createSharedImageJobs() {
  const jobs = new Map<string, {
    controller: string;
    relay?: string;
    assertAllowed(): void;
    cancellation: AbortController;
    timer: ReturnType<typeof setTimeout>;
    state: { status: 'pending' | 'failed' | 'released' } | { status: 'complete'; image: Image };
  }>();
  const keyFor = (controller: string, requestId: string) => JSON.stringify([controller, requestId]);

  return {
    start(
      controller: string,
      requestId: string,
      assertAllowed: () => void,
      generate: (signal: AbortSignal) => Promise<Image>,
      relay?: string,
    ): void {
      assertAllowed();
      const key = keyFor(controller, requestId);
      if (jobs.has(key)) return;
      const active = [...jobs.values()].filter((job) => job.state.status !== 'released');
      if (active.length >= MAX_ACTIVE_JOBS || active.some((job) => job.controller === controller && job.relay === relay)) {
        throw new Error('SHARED_IMAGE_BUSY');
      }
      if (jobs.size >= 64) {
        const released = [...jobs].find(([, job]) => job.state.status === 'released');
        if (released) {
          clearTimeout(released[1].timer);
          jobs.delete(released[0]);
        }
      }
      const cancellation = new AbortController();
      const timer = setTimeout(() => {
        cancellation.abort();
        jobs.delete(key);
      }, RESULT_LIFETIME_MS);
      timer.unref?.();
      const job: NonNullable<ReturnType<typeof jobs.get>> = {
        controller, relay, cancellation, timer, assertAllowed, state: { status: 'pending' },
      };
      jobs.set(key, job);
      const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)]);
      void Promise.resolve().then(() => {
        signal.throwIfAborted();
        assertAllowed();
        return generate(signal);
      }).then((image) => {
        signal.throwIfAborted();
        assertAllowed();
        if (!image.buffer.length || image.buffer.length > MAX_IMAGE_BYTES) {
          throw new Error('SHARED_IMAGE_INVALID');
        }
        job.state = { status: 'complete', image };
      }).catch(() => {
        if (job.state.status !== 'released') job.state = { status: 'failed' };
      });
    },

    async read(controller: string, requestId: string, offset: number): Promise<ReadResult> {
      const job = jobs.get(keyFor(controller, requestId));
      if (!job) throw new Error('SHARED_IMAGE_NOT_FOUND');
      job.assertAllowed();
      if (job.state.status === 'released') throw new Error('SHARED_IMAGE_NOT_FOUND');
      if (job.state.status !== 'complete') return { state: job.state.status };
      const image = job.state.image;
      const size = image.buffer.length;
      if (offset >= size) throw new Error('SHARED_IMAGE_INVALID');
      const data = image.buffer.subarray(offset, offset + REMOTE_AGENT_READ_MAX_BYTES).toString('base64');
      return { state: 'complete', data, mimeType: image.mimeType, size };
    },

    release(controller: string, requestId: string): void {
      const job = jobs.get(keyFor(controller, requestId));
      if (!job) return;
      job.state = { status: 'released' };
      job.cancellation.abort();
    },

    dispose(): void {
      for (const job of jobs.values()) {
        clearTimeout(job.timer);
        job.cancellation.abort();
      }
      jobs.clear();
    },
  };
}
