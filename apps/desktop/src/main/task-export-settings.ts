import fs from 'node:fs';
import path from 'node:path';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from './appSessionState.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import type { TaskExportDirectoryState } from '../shared/taskExportDirectory.js';

/**
 * The folder the owner picked for Agent task package exports. Only Main's
 * native folder picker writes it, so a stored path is the owner's explicit
 * approval for exports to land there without asking each time.
 */
interface Settings {
  directory: string | null;
}

function validDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value);
}

const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath('task-export-settings.json'),
  defaults: { directory: null },
  normalize: (raw) => {
    const value = raw as Partial<Settings>;
    return { directory: validDirectory(value.directory) ? path.normalize(value.directory) : null };
  },
  scopeKey: () => activeOwnerScopeKey(),
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('task-export-settings'),
  label: 'task-export',
});

export function readTaskExportDirectory(): string | null {
  store.invalidateIfChanged();
  return store.read().directory;
}

async function readState(): Promise<TaskExportDirectoryState> {
  const directory = readTaskExportDirectory();
  if (!directory) return { path: null, exists: false };
  const exists = await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false);
  return { path: directory, exists };
}

/** Settings IPC: get / choose (native folder picker) / reset. Local only, not exposed via device-link. */
export function createTaskExportDirectoryHandlers(deps: { chooseDirectory(): Promise<string | null> }) {
  const mutate = async (choose: boolean) => {
    const scope = activeOwnerScopeKey();
    const directory = choose ? await deps.chooseDirectory() : null;
    if (choose && directory === null) return readState();
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) {
      throwIpcError('PRECONDITION_FAILED', 'task export directory owner changed');
    }
    if (directory !== null && !validDirectory(directory)) throwIpcError('INVALID_PARAMS', 'invalid task export directory');
    await store.updateAtomic(() => ({ directory }));
    return readState();
  };
  return {
    get: readState,
    choose: () => mutate(true),
    reset: () => mutate(false),
  };
}
