import path from 'node:path';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import type { DialogueWorkspaceSettingsState } from '../shared/dialogueWorkspaceSettings.js';

interface Settings {
  directory: string | null;
  /** Retained on reset: existing tasks still live in previously selected locations. */
  previousDirectories: string[];
}

function validDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value);
}

const store = createOverrideSettingsFile<Settings>({
  filePath: () => ownerScopedUserDataPath('dialogue-workspace-settings.json'),
  defaults: { directory: null, previousDirectories: [] },
  normalize: (raw) => {
    const value = raw as Partial<Settings>;
    return {
      directory: validDirectory(value.directory) ? path.normalize(value.directory) : null,
      previousDirectories: Array.isArray(value.previousDirectories)
        ? [...new Set(value.previousDirectories.filter(validDirectory).map((dir) => path.normalize(dir)))]
        : [],
    };
  },
  scopeKey: () => activeOwnerScopeKey(),
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 1024 * 1024,
  log: createLogger('dialogue-workspace-settings'),
  label: 'dialogue-workspace',
});

export function readDialogueWorkspaceSettings(): DialogueWorkspaceSettingsState {
  store.invalidateIfChanged();
  const { directory } = store.read();
  return { directory: directory ?? ownerScopedUserDataPath('dialogues'), isCustomized: directory !== null };
}

export function dialogueWorkspaceRoots(): string[] {
  store.invalidateIfChanged();
  const { directory, previousDirectories } = store.read();
  return [...new Set([ownerScopedUserDataPath('dialogues'), ...previousDirectories, ...(directory ? [directory] : [])])];
}

/** Only Main's native folder picker calls this; no arbitrary Renderer path input. */
export async function writeDialogueWorkspaceDirectory(directory: string | null): Promise<void> {
  if (directory !== null && !validDirectory(directory)) throw new Error('Invalid dialogue directory');
  await store.updateAtomic(({ value }) => ({
    directory,
    previousDirectories: [...new Set([
      ...value.previousDirectories,
      ...(value.directory ? [value.directory] : []),
      ...(directory ? [directory] : []),
    ])],
  }));
}
