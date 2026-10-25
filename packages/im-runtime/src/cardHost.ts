import type { AgentKind, Effort, Logger, Maker } from "@cindy/maker-core";
import type { ImCommandHost } from "./commandHost";
import type { ImTurnHost } from "./turnHost";
import type { PersistentImBindingStore } from "./binding";
import type { ControlSession } from "./controlProjects";
import type { SessionModelRouteSnapshot } from "./sessionRepo";
import type {
  ImDefaultSettings,
  ImDefaultSettingsChannel,
} from "./imDefaultSettings";
import type { createImAccountBoundary } from "./accountBoundary";
import type { lookupPending, resolvePending } from "./pendingInteractions";

export interface ImTaskDefaults {
  model: string;
  providerId?: string | null;
  effort: string;
  permissionMode: string;
  fastMode: boolean | "ultrafast";
}
type ModelChange = {
  status: "applied" | "deferred";
  generation?: number;
  effectiveProviderId?: string | null;
};
type AccountBoundary = ReturnType<typeof createImAccountBoundary>;

/** Host-owned model transactions and task storage. Card routing, takeover,
 * rollback, stale-card admission and interaction decisions remain shared. */
export interface ImCardHost
  extends
    Pick<
      ImCommandHost,
      | "createLogger"
      | "getSessionProvider"
      | "listProjectsForControl"
      | "readSessionTitle"
      | "startThreadControlFlow"
      | "executeDetach"
    >,
    Pick<
      ImTurnHost,
      | "readImRemoteProviderRoute"
      | "readPermissionMode"
      | "updatePermissionMode"
      | "changeSessionPermissionMode"
    >,
    Pick<
      AccountBoundary,
      | "captureImAccountGeneration"
      | "runInImAccountGeneration"
      | "isImAccountScopeClosedError"
    > {
  createLogger(
    scope: string,
  ): Pick<Logger, "debug" | "info" | "warn" | "error">;
  getMaker(): Pick<
    Maker,
    "getSessionMeta" | "getCapabilities" | "createSession" | "closeSession"
  >;
  bindingStore: Pick<
    PersistentImBindingStore,
    "get" | "attach" | "attachWithResult"
  >;
  normalizeSessionProviderId(
    value: string | null | undefined,
  ): string | null | undefined;
  setSessionProvider(sessionId: string, providerId: string | null): void;
  withSendToSessionLock<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T>;
  /** Hosts with a unified route transaction use it for the whole card choice,
   * including effort, deferred delivery and the manual-default override. */
  selectModelUnderLock?(
    sessionId: string, model: string, providerId: string | null | undefined, effort: Effort,
  ): Promise<void>;
  applyPiImModelSelectionUnderLock?(
    sessionId: string,
    model: string,
    providerId: string | null | undefined,
    previous: { model: string; providerId: string | null } | null,
  ): Promise<ModelChange>;
  applyRuntimeModelChange?(
    sessionId: string,
    model: string,
    providerId: string | null | undefined,
    logger: Pick<Logger, "debug" | "info">,
  ): Promise<ModelChange>;
  clearPendingCredentialSwitchForSession?(sessionId: string): void;
  cancelPendingAgentSwitchForSession(sessionId: string): void;
  cancelPendingSessionRuntimeMutation?(
    sessionId: string,
    generation: number,
  ): void;
  getTaskDefaults(): ImTaskDefaults | null;
  resolveNewTaskDefaultModelRoute(
    agent: AgentKind,
  ): Promise<{ model: string; providerId: string } | null>;
  resolveLenientSessionRoute(
    agent: AgentKind,
    model: string | undefined,
    providerId: string | null,
    options: {
      fallbackModel?: string;
      desiredEffort?: string;
      desiredFastMode?: boolean | "ultrafast";
    },
  ): Promise<{
    model?: string;
    providerId: string | null;
    degraded: boolean;
    effort?: string;
    fastMode?: boolean | "ultrafast";
  }>;
  listSessionsForWorkspace(workingDir: string): Promise<ControlSession[]>;
  exitControl(botContextId: string, userId: string): void;
  generateTakeoverSummary(sessionId: string): Promise<string | null>;
  broadcastSessionCreated(sessionId: string): void;
  readImDefaultSettings(channel: ImDefaultSettingsChannel): ImDefaultSettings;
  readModelRouteSnapshot(
    sessionId: string,
  ): Promise<SessionModelRouteSnapshot | null>;
  switchSessionWorkingDir(
    sessionId: string,
    workingDir: string,
    kind: "project" | "dialogue",
  ): Promise<void>;
  touchUserSent(sessionId: string): Promise<void>;
  updateModelEffort(
    sessionId: string,
    model: string,
    effort: Effort,
    providerId?: string | null,
  ): Promise<void>;
  markImSessionManualRouteOverride(sessionId: string): Promise<void>;
  lookupPending: typeof lookupPending;
  resolvePending: typeof resolvePending;
}
