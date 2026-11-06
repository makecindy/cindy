import path from 'node:path';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';

interface Settings {
  /** null = no explicit choice; the location is inferred when read. */
  directory: string | null;
}

function validDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value);
}

const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath('projects-root-settings.json'),
  defaults: { directory: null },
  normalize: (raw) => {
    const value = raw as Partial<Settings>;
    return { directory: validDirectory(value.directory) ? path.normalize(value.directory) : null };
  },
  scopeKey: () => activeOwnerScopeKey(),
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('projects-root-settings'),
  label: 'projects-root',
});

export function readProjectsRootDirectory(): string | null {
  store.invalidateIfChanged();
  return store.read().directory;
}

/** Only Main's native folder picker or a picker-approved dialog choice calls this. */
export async function writeProjectsRootDirectory(directory: string | null): Promise<void> {
  if (directory !== null && !validDirectory(directory)) throw new Error('Invalid projects root directory');
  await store.updateAtomic(() => ({ directory }));
}
