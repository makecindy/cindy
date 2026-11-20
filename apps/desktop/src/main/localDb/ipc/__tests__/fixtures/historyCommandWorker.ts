import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { WorkerOptions } from 'node:worker_threads';
import { afterAll } from 'vitest';

export function mockHistoryCommandWorker(actual: typeof import('node:worker_threads')) {
  const workers = new Set<InstanceType<typeof actual.Worker>>();
  let script: string | undefined;
  afterAll(async () => {
    await Promise.all([...workers].map((worker) => worker.terminate()));
  });
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const isHistoryWorker = String(filename).endsWith('historyCommandArtifactWorker.js');
        if (isHistoryWorker) {
          script ??= buildSync({
            entryPoints: [fileURLToPath(new URL('../../historyCommandArtifactWorker.ts', import.meta.url))],
            bundle: true, platform: 'node', format: 'cjs', write: false,
          }).outputFiles[0].text;
          filename = script;
          options = { ...options, eval: true };
        }
        super(filename, options);
        if (isHistoryWorker) {
          workers.add(this);
          this.once('exit', () => { workers.delete(this); });
        }
      }
    },
  };
}
