import { activeOwnerScopeKey, ownerScopedUserDataPath } from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import { validProjectIcon } from '@cindy/maker-shared/project-alias-sync';
import { normalizeProjectKey, projectKeyComparisonKey } from '../shared/projectKeys.js';
import { throwIpcError } from './utils/ipcValidate.js';

const store = createOverrideSettingsFile<{ icons: Record<string, string> }>({
  filePath: () => ownerScopedUserDataPath('project-icons.json'),
  defaults: { icons: {} },
  normalize: (raw) => {
    const icons: Record<string, string> = {};
    const source = (raw as { icons?: unknown })?.icons;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [key, icon] of Object.entries(source)) {
        if (normalizeProjectKey(key) && validProjectIcon(icon)) icons[key] = icon;
      }
    }
    return { icons };
  },
  scopeKey: activeOwnerScopeKey,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('project-icons'),
  label: 'project-icons',
});

export function readProjectIcons(): Record<string, string> {
  store.invalidateIfChanged();
  return store.read().icons;
}

export async function setProjectIcon(
  projectKey: string,
  icon: unknown,
  assertCurrent: () => void = () => {},
): Promise<void> {
  if (icon !== null && !validProjectIcon(icon))
    throwIpcError('INVALID_PARAMS', 'Invalid project icon');
  await store.updateAtomic((current) => {
    assertCurrent();
    const icons = { ...current.value.icons };
    const identity = projectKeyComparisonKey(projectKey, process.platform);
    for (const key of Object.keys(icons)) {
      if (projectKeyComparisonKey(key, process.platform) === identity) delete icons[key];
    }
    if (typeof icon === 'string') icons[projectKey] = icon;
    return { icons };
  });
}
