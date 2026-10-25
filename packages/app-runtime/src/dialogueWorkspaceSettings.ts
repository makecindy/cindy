import path from "node:path";
import { createOverrideSettingsFile } from "./overrideSettingsFile.js";
import type { DbLogger } from "@cindy/runtime-db/logging";
/** Local-device setting; paths are never synchronized to other computers. */
export interface DialogueWorkspaceSettingsState {
  directory: string;
  isCustomized: boolean;
}

interface Settings {
  directory: string | null;
  /** Retained on reset: existing tasks still live in previously selected locations. */
  previousDirectories: string[];
}
export function createDialogueWorkspaceSettings(host: {
  activeOwnerScopeKey(): string;
  ownerScopedUserDataPath(...parts: string[]): string;
  createLogger(scope: string): DbLogger;
}) {
  const { activeOwnerScopeKey, ownerScopedUserDataPath, createLogger } = host;

  function validDirectory(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length <= 32768 &&
      !value.includes("\0") &&
      path.isAbsolute(value)
    );
  }

  const store = createOverrideSettingsFile<Settings>({
    filePath: () => ownerScopedUserDataPath("dialogue-workspace-settings.json"),
    defaults: { directory: null, previousDirectories: [] },
    normalize: (raw) => {
      const value = raw as Partial<Settings>;
      return {
        directory: validDirectory(value.directory)
          ? path.normalize(value.directory)
          : null,
        previousDirectories: Array.isArray(value.previousDirectories)
          ? [
              ...new Set(
                value.previousDirectories
                  .filter(validDirectory)
                  .map((dir) => path.normalize(dir)),
              ),
            ]
          : [],
      };
    },
    scopeKey: () => activeOwnerScopeKey(),
    preserveUnreadableFile: true,
    logLoadedValue: false,
    maxBytes: 1024 * 1024,
    log: createLogger("dialogue-workspace-settings"),
    label: "dialogue-workspace",
  });

  function readDialogueWorkspaceSettings(): DialogueWorkspaceSettingsState {
    store.invalidateIfChanged();
    const { directory } = store.read();
    return {
      directory: directory ?? ownerScopedUserDataPath("dialogues"),
      isCustomized: directory !== null,
    };
  }

  function dialogueWorkspaceRoots(): string[] {
    store.invalidateIfChanged();
    const { directory, previousDirectories } = store.read();
    return [
      ...new Set([
        ownerScopedUserDataPath("dialogues"),
        ...previousDirectories,
        ...(directory ? [directory] : []),
      ]),
    ];
  }

  /** Only Main's native folder picker calls this; no arbitrary Renderer path input. */
  async function writeDialogueWorkspaceDirectory(
    directory: string | null,
  ): Promise<void> {
    if (directory !== null && !validDirectory(directory))
      throw new Error("Invalid dialogue directory");
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
  return {
    readDialogueWorkspaceSettings,
    dialogueWorkspaceRoots,
    writeDialogueWorkspaceDirectory,
  };
}
