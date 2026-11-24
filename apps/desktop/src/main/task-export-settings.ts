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
 * approval for exports to land there without asking each time. `realPath` is
 * the canonical location at the moment of approval: exports go only there,
 * so a later symlink or junction swap cannot redirect them.
 */
interface Settings {
  directory: string | null;
  realPath: string | null;
}

function validDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value);
}

const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath('task-export-settings.json'),
  defaults: { directory: null, realPath: null },
  normalize: (raw) => {
    const value = raw as Partial<Settings>;
    // Both are written together; a half entry is treated as not set rather than trusted.
    return validDirectory(value.directory) && validDirectory(value.realPath)
      ? { directory: path.normalize(value.directory), realPath: path.normalize(value.realPath) }
      : { directory: null, realPath: null };
  },
  scopeKey: () => activeOwnerScopeKey(),
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('task-export-settings'),
  label: 'task-export',
});

/** For exports: null = not set; 'unreadable' = a settings file exists but cannot be read (fail, do not ask). */
export function readTaskExportDirectory(): { realPath: string } | null | 'unreadable' {
  store.invalidateIfChanged();
  if (store.isUnreadable()) return 'unreadable';
  const { realPath } = store.read();
  return realPath ? { realPath } : null;
}

function assertScope(scope: string): void {
  if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) {
    throwIpcError('PRECONDITION_FAILED', 'task export directory owner changed');
  }
}

/** Never returns one owner's path after the active owner changed while it was being read. */
async function readState(): Promise<TaskExportDirectoryState> {
  const scope = activeOwnerScopeKey();
  assertScope(scope);
  store.invalidateIfChanged();
  if (store.isUnreadable()) return { path: null, exists: false, unreadable: true };
  const { directory } = store.read();
  if (!directory) return { path: null, exists: false, unreadable: false };
  const exists = await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false);
  assertScope(scope);
  return { path: directory, exists, unreadable: false };
}

/** Settings IPC: get / choose (native folder picker) / reset. Local only, not exposed via device-link. */
export function createTaskExportDirectoryHandlers(deps: { chooseDirectory(): Promise<string | null> }) {
  const choose = async () => {
    const scope = activeOwnerScopeKey();
    const directory = await deps.chooseDirectory();
    if (directory === null) return readState();
    assertScope(scope);
    if (!validDirectory(directory)) throwIpcError('INVALID_PARAMS', 'invalid task export directory');
    const realPath = await fs.promises.realpath(directory).catch(() => null);
    if (!realPath) throwIpcError('NOT_FOUND', 'task export directory is not available');
    assertScope(scope);
    // A fresh choice from the native picker replaces an unreadable file; nothing else is stored in it.
    if (store.isUnreadable()) await store.resetAtomic();
    await store.updateAtomic(() => ({ directory, realPath }));
    return readState();
  };
  const reset = async () => {
    assertScope(activeOwnerScopeKey());
    // resetAtomic removes the file, so this is also the recovery path for an unreadable one.
    await store.resetAtomic();
    return readState();
  };
  return { get: readState, choose, reset };
}
