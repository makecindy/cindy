import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Foreign SQLite reads run off the Electron main thread.
import { Worker } from 'node:worker_threads';
import { resolveBetterSqliteNativeBinding } from '../../localDb/betterSqliteFactory';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

export function archiveDirectory(connection: string, origin: string): string {
  if (!/^[a-f0-9]{12}$/.test(connection)) throw Error('IMESSAGE_ARCHIVE_UNAVAILABLE');
  return ownerScopedImUserDataPath('imessage', 'archives', connection, createHash('sha256').update(origin).digest('hex'));
}

export async function readArchive(directory: string, chat: string, query: string | undefined, before: number | undefined, limit: number): Promise<unknown> {
  const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  const worker = new Worker(path.join(__dirname, 'archiveWorker.js'), { workerData: {
    directory, chat, query, before, limit, modulePath: require.resolve('better-sqlite3'), nativeBinding: resolveBetterSqliteNativeBinding(),
  } });
  try {
    return await new Promise((resolve, reject) => {
      const failed = () => reject(new Error('IMESSAGE_ARCHIVE_UNAVAILABLE'));
      const timeout = setTimeout(failed, 15_000);
      worker.once('message', result => { clearTimeout(timeout); if (result.error) failed(); else resolve(result); });
      worker.once('exit', () => { clearTimeout(timeout); failed(); });
      worker.once('error', () => { clearTimeout(timeout); failed(); });
    });
  } finally { await worker.terminate(); }
}
