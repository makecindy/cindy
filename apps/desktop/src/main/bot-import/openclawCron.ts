import { createRequire } from 'node:module';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Foreign database access belongs in an isolated read-only worker.
import { Worker } from 'node:worker_threads';
import { CompanionImportError } from './types.js';

export function readOpenClawCronDatabase(input: {
  database: string; storeKey: string; agentId: string; defaultAgent: boolean;
}): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    const worker = new Worker(path.join(__dirname, 'openclawCronWorker.js'), {
      workerData: { ...input, modulePath: require.resolve('better-sqlite3') },
    });
    let settled = false;
    const finish = (jobs?: Record<string, unknown>[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => {
        if (jobs) resolve(jobs);
        else reject(new CompanionImportError('SOURCE_DATABASE_UNAVAILABLE'));
      }, () => reject(new CompanionImportError('SOURCE_DATABASE_UNAVAILABLE')));
    };
    const timer = setTimeout(() => finish(), 15_000);
    worker.once('message', (message: { ok?: boolean; jobs?: Record<string, unknown>[] }) => finish(message.ok ? message.jobs : undefined));
    worker.on('error', () => finish());
    worker.once('exit', () => finish());
  });
}
