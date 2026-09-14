import { Directory, File, Paths } from 'expo-file-system';
import type { HistoryDiskIO } from './historyDiskStore';

/** Discardable private app cache: survives restarts, but the OS may reclaim low-storage caches. */
export function createHistoryDiskIO(): HistoryDiskIO {
  const directory = new Directory(Paths.cache, 'history-views-v1');
  return {
    async files() {
      directory.create({ intermediates: true, idempotent: true });
      return directory.list().filter(item => item instanceof File).map(item => item.name);
    },
    async read(name) {
      const file = new File(directory, name);
      return file.exists ? file.text() : null;
    },
    async write(name, text) {
      directory.create({ intermediates: true, idempotent: true });
      const temporary = new File(directory, `${name}.tmp`);
      try {
        // Native asynchronous write avoids a synchronous filesystem write on the UI thread.
        const fs = await import('expo-file-system/legacy');
        await fs.writeAsStringAsync(temporary.uri, text);
        temporary.moveSync(new File(directory, name), { overwrite: true });
      } finally { if (temporary.exists) temporary.delete(); }
    },
    async remove(name) { const file = new File(directory, name); if (file.exists) file.delete(); },
  };
}
