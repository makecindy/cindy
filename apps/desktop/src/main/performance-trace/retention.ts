import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const TRACE_RETENTION_MS = 7 * 86400_000;
const REPORT_ID = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

/** Only generated report directories under the captured owner root are eligible. */
export async function cleanupTraceReports(
  root: string,
  canRemove: (id: string) => boolean,
  now = Date.now(),
): Promise<void> {
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !REPORT_ID.test(entry.name)) continue;
      const dir = path.resolve(root, entry.name);
      if (path.dirname(dir) !== path.resolve(root)) continue;
      try {
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (now - info.mtimeMs < TRACE_RETENTION_MS || !canRemove(entry.name)) continue;
        await rm(dir, { recursive: true, force: true });
      } catch {
        // A busy/missing directory must not prevent other expired reports from being removed.
      }
    }
  } catch {
    // No recordings yet, or temporarily inaccessible; retry on the next maintenance tick.
  }
}

/** Independent of recording: sweep on service startup and hourly while the app runs. */
export function startTraceRetention(sweep: () => Promise<void>): () => void {
  let pending = false;
  const run = async () => {
    if (pending) return;
    pending = true;
    try {
      await sweep();
    } finally {
      pending = false;
    }
  };
  void run().catch(() => {});
  const timer = setInterval(() => {
    void run().catch(() => {});
  }, 3600_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
