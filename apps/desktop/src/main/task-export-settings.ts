import fs from 'node:fs';
import path from 'node:path';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from './appSessionState.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
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

const SETTINGS_FILE = 'task-export-settings.json';
const SETTINGS_MAX_BYTES = 1024 * 1024;
const NOT_SET: Settings = { directory: null, realPath: null };

function normalizeSettings(raw: unknown): Settings {
  const value = raw as Partial<Settings>;
  // Both are written together; a half entry is treated as not set rather than trusted.
  return validDirectory(value.directory) && validDirectory(value.realPath)
    ? { directory: path.normalize(value.directory), realPath: path.normalize(value.realPath) }
    : NOT_SET;
}

/** Writes keep the shared store's cross-process lock and atomic replace (user clicks only). */
const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath(SETTINGS_FILE),
  defaults: NOT_SET,
  normalize: normalizeSettings,
  scopeKey: () => activeOwnerScopeKey(),
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('task-export-settings'),
  label: 'task-export',
});

/**
 * Reads use async I/O so the settings page and Agent exports never block Main on the user-data
 * volume. Same file and normalisation as the store: missing = not set; a file that exists but
 * cannot be read or parsed as an object is 'unreadable' (the store would refuse to overwrite it).
 */
async function readSettings(): Promise<Settings | 'unreadable'> {
  let bytes: Buffer | null;
  try {
    bytes = await readBoundedFileNoFollow(ownerScopedUserDataPath(SETTINGS_FILE), SETTINGS_MAX_BYTES);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? NOT_SET : 'unreadable';
  }
  if (!bytes) return 'unreadable';
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? normalizeSettings(raw) : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** For exports: null = not set; 'unreadable' = a settings file exists but cannot be read (fail, do not ask). */
export async function readTaskExportDirectory(): Promise<{ realPath: string } | null | 'unreadable'> {
  const settings = await readSettings();
  if (settings === 'unreadable') return 'unreadable';
  return settings.realPath ? { realPath: settings.realPath } : null;
}

function assertScope(scope: string): void {
  if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) {
    throwIpcError('PRECONDITION_FAILED', 'task export directory owner changed');
  }
}

/**
 * Never returns another owner's path: every read is fenced to `scope`, the owner the IPC request
 * started under, so a request outlived by an account switch fails instead of answering for B.
 */
async function readState(scope = activeOwnerScopeKey()): Promise<TaskExportDirectoryState> {
  assertScope(scope);
  const settings = await readSettings();
  assertScope(scope);
  if (settings === 'unreadable') return { path: null, exists: false, unreadable: true };
  const { directory } = settings;
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
    if (directory === null) return readState(scope);
    assertScope(scope);
    if (!validDirectory(directory)) throwIpcError('INVALID_PARAMS', 'invalid task export directory');
    const realPath = await fs.promises.realpath(directory).catch(() => null);
    if (!realPath) throwIpcError('NOT_FOUND', 'task export directory is not available');
    assertScope(scope);
    // A fresh choice from the native picker replaces an unreadable file; nothing else is stored in it.
    if (await readSettings() === 'unreadable') await store.resetAtomic();
    assertScope(scope);
    await store.updateAtomic(() => ({ directory, realPath }));
    return readState(scope);
  };
  const reset = async () => {
    const scope = activeOwnerScopeKey();
    assertScope(scope);
    // resetAtomic removes the file, so this is also the recovery path for an unreadable one.
    await store.resetAtomic();
    return readState(scope);
  };
  return { get: () => readState(), choose, reset };
}
