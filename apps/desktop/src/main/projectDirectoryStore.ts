import {
  parseProjectDirectories,
  type ProjectDirectory,
} from '@cindy/maker-shared/project-alias-sync';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import { normalizeProjectKey, projectKeyComparisonKey } from '../shared/projectKeys.js';

/** Account-owned project defaults, independent of legacy per-task grants. */
const store = createOverrideSettingsFile<{ directories: Record<string, ProjectDirectory[]> }>({
  filePath: () => ownerScopedUserDataPath('project-directories.json'),
  defaults: { directories: {} },
  normalize: (raw) => {
    const directories: Record<string, ProjectDirectory[]> = {};
    const source = (raw as { directories?: unknown })?.directories;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [key, value] of Object.entries(source)) {
        const parsed = parseProjectDirectories(value);
        if (normalizeProjectKey(key) && parsed) directories[key] = parsed;
      }
    }
    return { directories };
  },
  scopeKey: activeOwnerScopeKey,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('project-directories'),
  label: 'project-directories',
});

export function readProjectDirectories(): Record<string, ProjectDirectory[]> {
  store.invalidateIfChanged();
  return store.read().directories;
}

export async function setProjectDirectories(
  projectKey: string,
  value: readonly ProjectDirectory[] | undefined,
  assertCurrent: () => void,
): Promise<void> {
  await store.updateAtomic((current) => {
    assertCurrent();
    const directories = { ...current.value.directories };
    const identity = projectKeyComparisonKey(projectKey, process.platform);
    for (const key of Object.keys(directories)) {
      if (projectKeyComparisonKey(key, process.platform) === identity) delete directories[key];
    }
    if (value !== undefined) directories[projectKey] = [...value];
    return { directories };
  });
}
