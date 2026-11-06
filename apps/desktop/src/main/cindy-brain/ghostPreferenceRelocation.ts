import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('ghost-preference-relocation');
const relocatingFiles = new Set<string>();

export function assertGhostPrefsWritable(fileName: string): void {
  if (relocatingFiles.has(ownerScopedUserDataPath(fileName))) {
    throw new Error(fileName + ' preferences are relocating');
  }
}

export async function updateGhostPrefsForRelocation(
  fileName: string,
  updater: (raw: Record<string, unknown>) => Record<string, unknown>,
  onSettled?: () => void,
): Promise<void> {
  if (isAppSessionBoundaryPending()) throw new Error('ghost preferences owner scope is changing');
  assertGhostPrefsWritable(fileName);
  const file = ownerScopedUserDataPath(fileName);
  relocatingFiles.add(file);
  try {
    const relocationStore = createOverrideSettingsFile<Record<string, unknown>>({
      filePath: () => ownerScopedUserDataPath(fileName),
      scopeKey: activeOwnerScopeKey,
      defaults: {},
      normalize: (raw) => raw as Record<string, unknown>,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: false,
      log,
      label: fileName,
    });
    await relocationStore.updateAtomic(({ value }) => {
      if (isAppSessionBoundaryPending()) throw new Error('ghost preferences owner scope is changing');
      return updater(value);
    }, { preserveDefaults: true });
  } finally {
    try {
      onSettled?.();
    } finally {
      relocatingFiles.delete(file);
    }
  }
}

export async function relocateGhostPreferenceMaps(
  fileName: string,
  mapNames: readonly string[],
  from: string,
  to: string,
  onSettled?: () => void,
): Promise<void> {
  if (from === to) return;
  await updateGhostPrefsForRelocation(fileName, (raw) => {
    const maps = mapNames.map((name) => {
      const value = raw[name];
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        throw new Error(`${fileName} ${name} is unreadable`);
      }
      return { name, value: (value ?? {}) as Record<string, unknown> };
    });
    const matches = (name: string, key: string, id: string) =>
      key === id || (name === 'sessions' && key.startsWith(`${id}#`));
    if (!maps.some(({ name, value }) => Object.keys(value).some((key) => matches(name, key, from)))) {
      return {};
    }
    if (maps.some(({ name, value }) => Object.keys(value).some((key) => matches(name, key, to)))) {
      throw new Error(`${fileName} relocation destination collision`);
    }
    const patch: Record<string, unknown> = {};
    for (const { name, value } of maps) {
      const next = { ...value };
      for (const key of Object.keys(value)) {
        if (!matches(name, key, from)) continue;
        next[`${to}${key.slice(from.length)}`] = value[key];
        delete next[key];
      }
      if (Object.keys(value).some((key) => matches(name, key, from))) patch[name] = next;
    }
    return patch;
  }, onSettled);
}
