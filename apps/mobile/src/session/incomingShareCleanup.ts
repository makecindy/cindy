import { Directory, Paths } from 'expo-file-system';
import { deleteAsync } from 'expo-file-system/legacy';

const SHARE_COPY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SHARE_DIRECTORY = /^cindy-share-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Reclaim copies orphaned by native-slot replacement or process termination.
 * Only our direct UUID directories expire, never the user's original files.
 * Age is the directory's creation time, not the imported file's timestamp.
 * An expired pending share must be shared again; normal uploads clean up sooner.
 */
export async function cleanupExpiredIncomingShares(now = Date.now()): Promise<void> {
  try {
    for (const root of Object.values(Paths.appleSharedContainers)) {
      let entries;
      try { entries = root.list(); } catch { continue; }
      for (const entry of entries) {
        if (!(entry instanceof Directory) || !SHARE_DIRECTORY.test(entry.name)) continue;
        try {
          const created = entry.info().creationTime;
          if (typeof created !== 'number' || !Number.isFinite(created) || created <= 0
            || now - created < SHARE_COPY_RETENTION_MS) continue;
          await deleteAsync(entry.uri, { idempotent: true });
        } catch {
          // Best effort: inaccessible or concurrently removed entries retry on foreground.
        }
      }
    }
  } catch {
    // Older native binaries may not expose App Group containers.
  }
}
