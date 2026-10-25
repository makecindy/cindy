import path from "node:path";
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from "./overrideSettingsFile.js";
import type { DbLogger } from "@cindy/runtime-db/logging";

export type GitSafetyMode = "off" | "existing-git" | "all-projects";

export interface GitSafetySettings {
  mode: GitSafetyMode;
  /** Derived compatibility field for existing snapshot consumers. */
  autoSnapshotEnabled: boolean;
  /** Whether an empty local non-Git project may be bootstrapped. */
  autoInitProjectGit: boolean;
}

interface PersistedGitSafetySettings {
  mode: GitSafetyMode;
}
export function createGitSafetySettingsStore(host: {
  userDataDirectory(): string;
  logger: DbLogger;
}) {
  const log = host.logger;

  const DEFAULTS: PersistedGitSafetySettings = {
    mode: "existing-git",
  };

  function settingsFilePath(): string {
    return path.join(host.userDataDirectory(), "git-safety-settings.json");
  }

  function normalize(raw: unknown): PersistedGitSafetySettings {
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    const r = raw as Record<string, unknown>;
    const legacyMode =
      typeof r.autoSnapshotEnabled === "boolean"
        ? r.autoSnapshotEnabled
          ? "all-projects"
          : "off"
        : undefined;
    const mode: GitSafetyMode =
      legacyMode !== undefined &&
      (r.mode === undefined || r.mode === DEFAULTS.mode)
        ? legacyMode
        : r.mode === "off" ||
            r.mode === "existing-git" ||
            r.mode === "all-projects"
          ? r.mode
          : DEFAULTS.mode;
    return {
      mode,
    };
  }

  function derive(persisted: PersistedGitSafetySettings): GitSafetySettings {
    return {
      mode: persisted.mode,
      autoSnapshotEnabled: persisted.mode !== "off",
      autoInitProjectGit: persisted.mode === "all-projects",
    };
  }

  function mergeOverrides({
    patch,
    next,
    overrides,
  }: {
    patch: Partial<PersistedGitSafetySettings>;
    next: PersistedGitSafetySettings;
    overrides: Record<string, unknown>;
  }): Record<string, unknown> {
    const updated = { ...overrides };
    if (Object.prototype.hasOwnProperty.call(patch, "mode")) {
      // Keep an explicit selection even when it matches today's default. This
      // preserves the user's choice if the default changes in a later release.
      updated.mode = next.mode;
      delete updated.autoSnapshotEnabled;
    }
    return updated;
  }

  const store = createOverrideSettingsFile<PersistedGitSafetySettings>({
    filePath: settingsFilePath,
    defaults: DEFAULTS,
    normalize,
    mergeOverrides,
    log,
    label: "git safety",
  });

  function readGitSafetySettings(): GitSafetySettings {
    return derive(store.read());
  }

  function readGitSafetySettingsState(): OverrideSettingsState<GitSafetySettings> {
    const state = store.readState();
    return {
      ...state,
      value: derive(state.value),
      defaults: derive(state.defaults),
    };
  }

  function writeGitSafetyMode(
    mode: GitSafetyMode,
  ): OverrideSettingsState<GitSafetySettings> {
    store.writePatch({ mode });
    log.info("git safety setting written", { mode });
    return readGitSafetySettingsState();
  }

  /** Compatibility for callers still sending the old boolean during migration. */
  function writeGitSafetyAutoSnapshotEnabled(
    autoSnapshotEnabled: boolean,
  ): OverrideSettingsState<GitSafetySettings> {
    return writeGitSafetyMode(autoSnapshotEnabled ? "all-projects" : "off");
  }

  function resetGitSafetySettings(): GitSafetySettings {
    return derive(store.reset());
  }

  const __testing = { mergeOverrides, normalize };
  return {
    readGitSafetySettings,
    readGitSafetySettingsState,
    writeGitSafetyMode,
    writeGitSafetyAutoSnapshotEnabled,
    resetGitSafetySettings,
    __testing,
  };
}
