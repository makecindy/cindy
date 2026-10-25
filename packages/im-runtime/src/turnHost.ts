import type { IdentityKey, IMAttachment } from "@cindy/im";
import type {
  AgentKind,
  Effort,
  InteractionDecision,
  InteractionRequest,
  Logger,
  Maker,
  PermissionMode,
  PermissionModeDescriptor,
  SendOrigin,
  Session,
} from "@cindy/maker-core";
import type { ImMessageSource } from "@cindy/companion-core/imMessageSource";
import type { ProviderView } from "@cindy/model-providers";
import type { ImAuthCheckDeps } from "./authCheck";
import type { AgentHandoffPendingRegistry } from "./agentHandoff";
import type { summarizeOpenPlan } from "./planReconcile";
import type { ImSessionRow } from "./sessionRepo";
import type { SharedPermission } from "./sharedPermission";
import type { PermissionModeChangeResult } from "./permissionModeTypes";

/** Storage and process services owned by the current signed-in host. The same
 * channel runner owns routing, queueing, permissions and final delivery on both
 * Desktop and the terminal; these ports must not reimplement that state machine. */
export interface ImTurnHost {
  getMaker(): Pick<
    Maker,
    | "on"
    | "getSession"
    | "createSession"
    | "getAgentAuthState"
    | "getCapabilities"
  >;
  readSession(sessionId: string): Promise<ImTurnSessionRecord | null>;
  persistSdkSessionId(sessionId: string, sdkSessionId: string): Promise<void>;
  createLogger(
    scope: string,
  ): Pick<Logger, "debug" | "info" | "warn" | "error">;
  listProviders(): Promise<ProviderView[]>;
  readImRemoteProviderRoute: NonNullable<ImAuthCheckDeps["checkRemoteRoute"]>;
  readXdGatewayApiKey: ImAuthCheckDeps["readXdGatewayApiKey"];
  hasCustomProviderKey: ImAuthCheckDeps["hasCustomProviderKey"];
  isCredentialModeSwitchBusyError(error: unknown): error is Error;
  hydrateSessionProvider(sessionId: string, providerId: string | null): void;
  setSessionEffort(sessionId: string, effort: Effort): void;
  setSessionFastMode(sessionId: string, fastMode: boolean | "ultrafast"): void;
  wireSessionToIpcExternal(session: Session): void;
  repoTouchUserSent(sessionId: string): Promise<void>;
  readPermissionMode(sessionId: string): Promise<PermissionMode | null>;
  updatePermissionMode(sessionId: string, mode: PermissionMode): Promise<void>;
  bindingStore: {
    get(identity: IdentityKey): string | null;
    getAttachCardMessageId(identity: IdentityKey): string | null;
    detach(identity: IdentityKey): Promise<void>;
  };
  persistUserMessage(args: {
    sessionId: string;
    text: string;
    attachments?: readonly IMAttachment[];
    source?: ImMessageSource;
    existingClientId?: string;
  }): Promise<{ clientId: string } | null>;
  adoptStagedInboundFiles(
    sessionId: string,
    attachments: readonly IMAttachment[],
  ): Promise<void>;
  beginTurnChangeSetAtDispatch(
    session: Session,
    anchorClientId: string,
  ): Promise<void>;
  clearPendingTurnChangeSets(sessionId: string): void;
  takePendingInteractionsForSession(sessionId: string): Array<{
    sharedPermission?: SharedPermission;
    requestId: string;
    request: InteractionRequest;
    resolve(decision: InteractionDecision): void;
  }>;
  noteSilentStopUserSend(sessionId: string): void;
  stopSessionTurnExplicitly(sessionId: string): Promise<void>;
  onSilentStopSettled(
    sessionId: string,
    callback: (
      sessionId: string,
      reason: "exhausted" | "skip" | "send-failed",
    ) => void,
  ): () => void;
  agentHandoffPending: Pick<AgentHandoffPendingRegistry, "peek" | "consume">;
  enqueueDurableWrite<T>(
    label: string,
    write: () => Promise<T> | T,
  ): Promise<T>;
  listMessagesForAgentHandoff(
    sessionId: string,
    limit: number,
  ): Promise<Parameters<typeof summarizeOpenPlan>[0]>;
  peekGoalInactiveNote(sessionId: string): Promise<string | null>;
  isSilencedSchedulerTurn(origin: SendOrigin | undefined): boolean;
  beginHeadlessGhostSetupTurn(sessionId: string): () => void;
  bindRuntimeRecoveryNotice(
    session: Session,
    deliver: (text: string) => Promise<unknown>,
    log: { warn(message: string): void },
  ): void;
  redactToolInputForUntrustedBoundary(
    toolName: string,
    input: unknown,
  ): unknown;
  generateAndPersistFbotTitle(
    sessionId: string,
    seedText: string,
    prefix?: string,
  ): Promise<string | null>;
  generateImSessionTitleText(
    sessionId: string,
    seedText: string,
  ): Promise<string | null>;
  persistGeneratedSessionTitle(sessionId: string, title: string): Promise<void>;
  resolveSessionErrorContext(
    sessionId: string,
  ): Promise<{
    providerLabel?: string;
    modelLabel?: string;
    taskLabel?: string;
  }>;
  resolveCindyMediaUrl(url: string): { absPath: string };
  resolveXdtImageUrl(url: string): { absPath: string };
  materializeLocalMarkdownImages(params: {
    text: string;
    workingDir: string;
    sessionId: string;
    maxImages?: number;
    maxImageBytes?: number;
    existingAbsPaths?: string[];
  }): Promise<{ absPaths: string[]; text: string }>;
  changeSessionPermissionMode(args: {
    sessionId: string;
    mode: PermissionMode;
    modes: readonly PermissionModeDescriptor[];
    confirmedFullAccess?: boolean;
    readPreviousMode(): Promise<PermissionMode | null>;
    getLiveSession(): {
      setPermissionMode(mode: PermissionMode): Promise<void>;
    } | null;
    persist(mode: PermissionMode): Promise<void>;
  }): Promise<PermissionModeChangeResult>;
}

export interface ImTurnSessionRecord extends Omit<
  ImSessionRow,
  "agentKind" | "workingDir"
> {
  agentKind: string;
  workingDir: string | null;
  title: string;
  status: string;
  orcaRole: string | null;
}
