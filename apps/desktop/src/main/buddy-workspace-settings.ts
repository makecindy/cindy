import { promises as fs } from 'node:fs';
import path from 'node:path';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from './appSessionState.js';
import { checkDialogueDirectoryWritable } from './dialogue-workspace-ipc.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { inside } from './workspace-migration/tree.js';
import type { BuddyWorkspaceSettingsState } from '../shared/buddyWorkspaceSettings.js';

export const BUDDY_WORKSPACE_SETTINGS_FILENAME = 'buddy-workspace-settings.json';

interface Settings {
  directory: string | null;
  /** Retained on reset for auditability; existing buddies remain in their prior locations. */
  previousDirectories: string[];
}

function validDirectory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    path.isAbsolute(value)
  );
}

const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath(BUDDY_WORKSPACE_SETTINGS_FILENAME),
  defaults: { directory: null, previousDirectories: [] },
  normalize: (raw) => {
    const value = raw as Partial<Settings>;
    return {
      directory: validDirectory(value.directory) ? path.normalize(value.directory) : null,
      previousDirectories: Array.isArray(value.previousDirectories)
        ? [
            ...new Set(
              value.previousDirectories.filter(validDirectory).map((dir) => path.normalize(dir)),
            ),
          ]
        : [],
    };
  },
  scopeKey: () => activeOwnerScopeKey(),
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('buddy-workspace-settings'),
  label: 'buddy-workspace',
});

export function customBuddyWorkspaceRoot(
  selected: string,
  ownerKey: string,
  paths: Pick<typeof path, 'join'> = path,
): string {
  return paths.join(selected, 'buddy-workspaces', ownerKey);
}

/**
 * Pure owner-scoped reader usable by `ensureBotWorkspaceDir` in both Desktop and headless hosts.
 * Returns null when no custom buddy workspace root is configured (or the file is absent/invalid).
 */
export async function readBuddyWorkspaceRootForOwner(ownerRoot: string): Promise<string | null> {
  const filePath = path.join(ownerRoot, BUDDY_WORKSPACE_SETTINGS_FILENAME);
  const bytes = await readBoundedFileNoFollow(filePath, 1024 * 1024).catch(() => null);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<Settings>;
    return validDirectory(parsed.directory) ? path.normalize(parsed.directory) : null;
  } catch {
    return null;
  }
}

export function readBuddyWorkspaceSettings(): BuddyWorkspaceSettingsState {
  store.invalidateIfChanged();
  const { directory } = store.read();
  return {
    directory: directory ?? ownerScopedUserDataPath('bots'),
    isCustomized: directory !== null,
  };
}

/** Validate a user-selected custom buddy workspace root before persisting it. */
export async function checkBuddyWorkspaceDirectoryWritable(
  ownerRoot: string,
  directory: string,
): Promise<void> {
  if (!validDirectory(directory)) {
    throwIpcError('INVALID_PARAMS', 'ABSOLUTE_TARGET_REQUIRED');
  }
  if (process.platform === 'win32' && (directory.startsWith('\\\\') || directory.includes(':', 2))) {
    throwIpcError('PRECONDITION_FAILED', 'LOCAL_DISK_REQUIRED');
  }
  const physicalOwner = await fs.realpath(ownerRoot).catch(() => path.resolve(ownerRoot));
  const resolvedTarget = path.resolve(directory);
  if (inside(physicalOwner, resolvedTarget) || inside(resolvedTarget, physicalOwner)) {
    throwIpcError('PRECONDITION_FAILED', 'TARGET_OVERLAPS_CINDY_DATA');
  }
  await checkDialogueDirectoryWritable(directory);
  const physicalTarget = await fs.realpath(directory);
  if (inside(physicalOwner, physicalTarget) || inside(physicalTarget, physicalOwner)) {
    throwIpcError('PRECONDITION_FAILED', 'TARGET_OVERLAPS_CINDY_DATA');
  }
}

/** Only Main's native folder picker calls this; no arbitrary Renderer path input. */
export async function writeBuddyWorkspaceDirectory(directory: string | null): Promise<void> {
  if (directory !== null && !validDirectory(directory)) {
    throw new Error('Invalid buddy workspace directory');
  }
  await store.updateAtomic(({ value }) => ({
    directory,
    previousDirectories: [
      ...new Set([
        ...value.previousDirectories,
        ...(value.directory ? [value.directory] : []),
        ...(directory ? [directory] : []),
      ]),
    ],
  }));
}
