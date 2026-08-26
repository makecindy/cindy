import fs from 'node:fs';

interface WatchDeps {
  watchFile(
    file: string,
    options: { persistent: boolean; interval: number },
    listener: () => void,
  ): void;
  unwatchFile(file: string, listener: () => void): void;
}

export interface ChatEmbeddingSettingsWatcher {
  rebind(file: string): void;
  dispose(): void;
}

const productionDeps: WatchDeps = {
  watchFile: (file, options, listener) => fs.watchFile(file, options, listener),
  unwatchFile: (file, listener) => fs.unwatchFile(file, listener),
};

/**
 * Watch the active owner's tiny override file so another Cindy process sharing userData can make
 * this process reconcile its enqueue/query runtime. `watchFile` also observes create/delete, which
 * is required because reset removes the override file rather than writing the default.
 */
export function createChatEmbeddingSettingsWatcher(
  onChange: () => void,
  deps: WatchDeps = productionDeps,
): ChatEmbeddingSettingsWatcher {
  let watchedFile: string | null = null;
  const listener = () => onChange();

  return {
    rebind(file: string) {
      if (watchedFile === file) return;
      if (watchedFile) deps.unwatchFile(watchedFile, listener);
      watchedFile = file;
      deps.watchFile(file, { persistent: false, interval: 750 }, listener);
    },
    dispose() {
      if (!watchedFile) return;
      deps.unwatchFile(watchedFile, listener);
      watchedFile = null;
    },
  };
}
