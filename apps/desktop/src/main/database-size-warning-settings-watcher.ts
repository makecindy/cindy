import fs from 'node:fs';

interface WatchDeps {
  watchFile(
    file: string,
    options: { persistent: boolean; interval: number },
    listener: () => void,
  ): void;
  unwatchFile(file: string, listener: () => void): void;
}

export interface DatabaseSizeWarningSettingsWatcher {
  rebind(file: string): void;
  dispose(): void;
}

const productionDeps: WatchDeps = {
  watchFile: (file, options, listener) => fs.watchFile(file, options, listener),
  unwatchFile: (file, listener) => fs.unwatchFile(file, listener),
};

/**
 * Observe the profile-wide settings file so another Electron process sharing
 * the same userData can notify its renderer windows after a write or reset.
 */
export function createDatabaseSizeWarningSettingsWatcher(
  onChange: () => void,
  deps: WatchDeps = productionDeps,
): DatabaseSizeWarningSettingsWatcher {
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
