import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readBoundedFileNoFollowSync } from "@cindy/remote-agent/readBoundedFile";
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from "./overrideSettingsFile.js";
import type { DbLogger } from "@cindy/runtime-db/logging";
type AppSessionMode = "signed-out" | "local" | "cloud";
export interface ChatEmbeddingSettingsHost {
  userDataDirectory(): string;
  createLogger(name: string): DbLogger;
  activeOwnerScopeKey(): string;
  dataOwnerStorageKey(id: string): string;
  getActiveAppSession(): { mode: AppSessionMode; dataOwnerId: string | null };
  isAppSessionBoundaryPending(): boolean;
  ownerScopedUserDataPath(...parts: string[]): string;
  hasExclusiveSharedLegacyUserDataAccess(): boolean;
}

export interface ChatEmbeddingSettings {
  enabled: boolean;
}

export interface ChatEmbeddingDefaultContext {
  mode: AppSessionMode;
  isAuthenticated: boolean;
  userId: string | null;
  membershipKind: "personal" | "org" | null;
}

interface LegacyClaimMarker {
  version: 1;
  ownerKey: string;
  complete: boolean;
}

type LegacyClaimRead =
  | { kind: "valid"; marker: LegacyClaimMarker }
  | { kind: "missing" }
  | { kind: "blocked" };

type LegacyChoiceRead = "missing" | "disabled" | "not-disabled" | "blocked";
export function createChatEmbeddingSettingsStore(
  host: ChatEmbeddingSettingsHost,
) {
  const {
    activeOwnerScopeKey,
    dataOwnerStorageKey,
    getActiveAppSession,
    isAppSessionBoundaryPending,
    ownerScopedUserDataPath,
    hasExclusiveSharedLegacyUserDataAccess,
  } = host;

  const log = host.createLogger("chat-embedding-settings-store");
  const SETTINGS_FILE = "chat-embedding-settings.json";
  const LEGACY_CLAIM_FILE = ".chat-embedding-settings-owner-claim-v1.json";
  const MAX_SETTINGS_BYTES = 1_024;
  const STORAGE_DEFAULTS: ChatEmbeddingSettings = { enabled: false };

  function resolveChatEmbeddingDefault(
    context: ChatEmbeddingDefaultContext,
  ): boolean {
    return (
      context.mode === "cloud" &&
      context.isAuthenticated &&
      context.membershipKind === "org"
    );
  }

  function settingsFilePath(): string {
    return ownerScopedUserDataPath(SETTINGS_FILE);
  }

  function legacySettingsFilePath(): string {
    return path.join(host.userDataDirectory(), SETTINGS_FILE);
  }

  function legacyClaimFilePath(): string {
    return path.join(host.userDataDirectory(), LEGACY_CLAIM_FILE);
  }

  function normalize(raw: unknown): ChatEmbeddingSettings {
    if (!raw || typeof raw !== "object") return { ...STORAGE_DEFAULTS };
    return {
      enabled:
        typeof (raw as { enabled?: unknown }).enabled === "boolean"
          ? (raw as { enabled: boolean }).enabled
          : STORAGE_DEFAULTS.enabled,
    };
  }

  const store = createOverrideSettingsFile<ChatEmbeddingSettings>({
    filePath: settingsFilePath,
    defaults: STORAGE_DEFAULTS,
    normalize,
    log,
    label: "chat embedding",
    scopeKey: activeOwnerScopeKey,
    maxBytes: MAX_SETTINGS_BYTES,
    preserveUnreadableFile: true,
  });

  function readLegacyClaim(): LegacyClaimRead {
    try {
      const bytes = readBoundedFileNoFollowSync(
        legacyClaimFilePath(),
        MAX_SETTINGS_BYTES,
      );
      if (bytes === null) return { kind: "blocked" };
      const parsed: unknown = JSON.parse(bytes.toString("utf-8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { version?: unknown }).version === 1 &&
        typeof (parsed as { ownerKey?: unknown }).ownerKey === "string" &&
        typeof (parsed as { complete?: unknown }).complete === "boolean"
      ) {
        return { kind: "valid", marker: parsed as LegacyClaimMarker };
      }
      return { kind: "blocked" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { kind: "missing" }
        : { kind: "blocked" };
    }
  }

  function readLegacyChoice(): LegacyChoiceRead {
    try {
      const bytes = readBoundedFileNoFollowSync(
        legacySettingsFilePath(),
        MAX_SETTINGS_BYTES,
      );
      if (bytes === null) return "blocked";
      const parsed: unknown = JSON.parse(bytes.toString("utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return "blocked";
      return (parsed as { enabled?: unknown }).enabled === false
        ? "disabled"
        : "not-disabled";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing"
        : "blocked";
    }
  }

  function tryCreateLegacyClaim(ownerKey: string): LegacyClaimRead {
    const markerPath = legacyClaimFilePath();
    const temporaryPath = `${markerPath}.init-${process.pid}-${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify({
          version: 1,
          ownerKey,
          complete: false,
        } satisfies LegacyClaimMarker),
        { encoding: "utf-8", flag: "wx", mode: 0o600 },
      );
      fs.linkSync(temporaryPath, markerPath);
      log.info("legacy chat embedding owner claimed", { ownerKey });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        log.warn("failed to claim legacy chat embedding setting", {
          ownerKey,
          errorCode: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
        });
      }
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file is not authoritative until the hard link exists.
      }
    }
    return readLegacyClaim();
  }

  function completeLegacyClaim(ownerKey: string): boolean {
    const markerPath = legacyClaimFilePath();
    const temporaryPath = `${markerPath}.complete-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify({
          version: 1,
          ownerKey,
          complete: true,
        } satisfies LegacyClaimMarker),
        { encoding: "utf-8", flag: "wx", mode: 0o600 },
      );
      fs.renameSync(temporaryPath, markerPath);
      return true;
    } catch (error) {
      log.warn("failed to complete legacy chat embedding owner claim", {
        ownerKey,
        errorCode: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
      });
      return false;
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // rename already consumed the temporary file, or creation failed.
      }
    }
  }

  /**
   * Returns true while a recognizable legacy opt-out still needs to be honored for this owner.
   * The synchronous migration is safe because it only runs for a stable owner while this process
   * has exclusive access to the shared legacy userData root.
   */
  function migrateLegacyOptOut(context: ChatEmbeddingDefaultContext): boolean {
    const session = getActiveAppSession();
    if (
      context.mode !== "cloud" ||
      !context.isAuthenticated ||
      !context.membershipKind ||
      session.mode !== "cloud" ||
      !session.dataOwnerId ||
      context.userId !== session.dataOwnerId ||
      isAppSessionBoundaryPending()
    ) {
      return false;
    }

    const ownerKey = dataOwnerStorageKey(session.dataOwnerId);
    let claim = readLegacyClaim();
    if (claim.kind === "valid" && claim.marker.ownerKey !== ownerKey)
      return false;
    if (claim.kind === "valid" && claim.marker.complete) return false;

    const legacyChoice = readLegacyChoice();
    if (legacyChoice === "blocked") return true;
    if (legacyChoice !== "disabled") return false;

    if (claim.kind === "missing") {
      if (!hasExclusiveSharedLegacyUserDataAccess()) return true;
      claim = tryCreateLegacyClaim(ownerKey);
    }

    if (claim.kind !== "valid") return true;
    if (claim.marker.ownerKey !== ownerKey) return false;
    if (claim.marker.complete) return false;
    if (!hasExclusiveSharedLegacyUserDataAccess()) return true;

    store.invalidateIfChanged();
    const current = store.readState();
    if (!current.customizedKeys.includes("enabled")) {
      try {
        store.writePatch({ enabled: false }, { preserveDefaults: true });
      } catch (error) {
        log.warn("failed to preserve legacy chat embedding opt-out", {
          ownerKey,
          errorCode: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
        });
        return true;
      }
    }

    if (!completeLegacyClaim(ownerKey)) return true;
    try {
      fs.unlinkSync(legacySettingsFilePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("failed to remove migrated legacy chat embedding setting", {
          ownerKey,
          errorCode: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
        });
      }
    }
    return false;
  }

  function acknowledgePendingLegacyForReset(
    context: ChatEmbeddingDefaultContext,
  ): boolean {
    const session = getActiveAppSession();
    if (
      context.mode !== "cloud" ||
      !context.isAuthenticated ||
      !session.dataOwnerId ||
      context.userId !== session.dataOwnerId ||
      isAppSessionBoundaryPending() ||
      !hasExclusiveSharedLegacyUserDataAccess()
    ) {
      return false;
    }

    const ownerKey = dataOwnerStorageKey(session.dataOwnerId);
    let claim = readLegacyClaim();
    if (claim.kind === "missing") claim = tryCreateLegacyClaim(ownerKey);
    if (claim.kind === "blocked") return completeLegacyClaim(ownerKey);
    if (claim.kind !== "valid" || claim.marker.ownerKey !== ownerKey)
      return false;
    return claim.marker.complete || completeLegacyClaim(ownerKey);
  }

  function assertActiveOwner(context: ChatEmbeddingDefaultContext): void {
    const session = getActiveAppSession();
    if (
      !session.dataOwnerId ||
      isAppSessionBoundaryPending() ||
      (context.mode === "cloud" && context.userId !== session.dataOwnerId)
    ) {
      throw new Error("chat embedding settings require a stable data owner");
    }
  }

  function projectState(
    context: ChatEmbeddingDefaultContext,
  ): OverrideSettingsState<ChatEmbeddingSettings> {
    store.invalidateIfChanged();
    const defaultEnabled = resolveChatEmbeddingDefault(context);
    const pendingLegacyOptOut = migrateLegacyOptOut(context);
    const state = store.readState();
    const hasEnabledOverride = state.customizedKeys.includes("enabled");
    // A preserved but unreadable owner file may contain an opt-out. Because a valid empty override
    // file is never emitted by createOverrideSettingsFile, file-present + no enabled key fails closed.
    // Project it as customized so Settings exposes the explicit Reset recovery path.
    const unreadableOrUnknownOwnerOverride =
      !hasEnabledOverride && fs.existsSync(settingsFilePath());
    const enabled = hasEnabledOverride
      ? state.value.enabled
      : pendingLegacyOptOut || unreadableOrUnknownOwnerOverride
        ? false
        : defaultEnabled;
    const isCustomized =
      hasEnabledOverride ||
      pendingLegacyOptOut ||
      unreadableOrUnknownOwnerOverride;
    return {
      value: { enabled },
      defaults: { enabled: defaultEnabled },
      isCustomized,
      customizedKeys: isCustomized ? ["enabled"] : [],
    };
  }

  function readChatEmbeddingSettings(
    context: ChatEmbeddingDefaultContext,
  ): ChatEmbeddingSettings {
    return projectState(context).value;
  }

  function readChatEmbeddingSettingsState(
    context: ChatEmbeddingDefaultContext,
  ): OverrideSettingsState<ChatEmbeddingSettings> {
    return projectState(context);
  }

  async function writeChatEmbeddingEnabled(
    enabled: boolean,
    context: ChatEmbeddingDefaultContext,
  ): Promise<OverrideSettingsState<ChatEmbeddingSettings>> {
    assertActiveOwner(context);
    await store.writePatchAtomic({ enabled }, { preserveDefaults: true });
    log.info("chat embedding setting written", { enabled });
    return projectState(context);
  }

  async function resetChatEmbeddingSettings(
    context: ChatEmbeddingDefaultContext,
  ): Promise<OverrideSettingsState<ChatEmbeddingSettings>> {
    assertActiveOwner(context);
    const pendingLegacyOptOut = migrateLegacyOptOut(context);
    if (pendingLegacyOptOut && !acknowledgePendingLegacyForReset(context)) {
      throw new Error(
        "legacy chat embedding setting migration is still pending",
      );
    }
    await store.resetAtomic();
    return projectState(context);
  }

  const __testing = {
    normalize,
    readLegacyChoice,
    resolveChatEmbeddingDefault,
  };
  return {
    resolveChatEmbeddingDefault,
    readChatEmbeddingSettings,
    readChatEmbeddingSettingsState,
    writeChatEmbeddingEnabled,
    resetChatEmbeddingSettings,
    __testing,
  };
}
