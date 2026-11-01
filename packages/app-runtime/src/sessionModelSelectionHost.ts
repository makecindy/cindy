import type { AgentKind, Logger, Maker } from '@cindy/maker-core';
import type { Catalog, ProviderView } from '@cindy/model-providers';
import type { DbClient } from '@cindy/runtime-db/client/DbClient';
import type { CurrentDbClientSnapshot } from '@cindy/runtime-db/client/current';
import type { MakerSessionAgentSwitchHandlerDeps, createPendingAgentSwitchRegistry } from '@cindy/im-runtime/sessionAgentSwitch';
import type { createContextOverflowRollover } from '@cindy/im-runtime/contextOverflowRollover';
import type { createSessionRuntimeControl, SessionRuntimeProfile, SessionRuntimeAxisPatch } from './sessionRuntimeControl.js';
import type { createSessionRuntimeAxes } from './sessionRuntimeAxes.js';
import type { createSessionProviderStore } from './sessionProviderStore.js';
import type { createRuntimeSetModel, ApplyRuntimeSetModelChangeInput } from './runtimeSetModel.js';
import type { PendingCredentialSwitchService } from './pendingCredentialSwitch.js';
import type { DataOwnerBroadcastScope } from './ownerBroadcast.js';
import type { ApplySessionRuntimeSelection, InternalRuntimeSelectionOptions } from './sessionRuntimeSelectionTypes.js';

export interface AgentDeviceRuntimeSelectionInput {
  sessionId: string;
  model: string;
  providerId: unknown;
  atomicSelection: { effort: SessionRuntimeProfile['effort']; fastMode: boolean | 'ultrafast' } | undefined;
  confirmedContextWindow?: number;
  internalOptions: InternalRuntimeSelectionOptions;
  runtimeStatus: { orcaRole: string | null; agentKind: string; providerId: string | null; effort: string | null; fastMode: boolean | 'ultrafast'; agentDeviceId: string | null };
  assertRuntimeOwnerCurrent(): void;
  assertSharedTaskCurrent: { admit(): void };
  supersededByOwnerBoundary(): boolean;
}

/** Platform ports for the existing model transaction; all route ownership,
 * window protection, rollback and persistence ordering stay in the service. */
export interface SessionModelSelectionHost extends
  Pick<ReturnType<typeof createSessionRuntimeControl>,
    'captureSessionRuntimeControlOwnerEpoch' | 'sessionRuntimeControlOwnerEpochMatches' |
    'getSessionRuntimeControlSnapshot' | 'resolveSessionRuntimeRefreshEffort' | 'resolveSessionRuntimeAxes' |
    'acceptSessionRuntimeMutation' | 'deferSessionRuntimeAxisMutation' | 'recordRecoveredSessionRuntimeMutation' |
    'recordRecoveredSessionRuntimeAxisMutation' | 'recordUserSessionRuntimeMutation' |
    'settlePendingSessionRuntimeMutation' | 'acceptSessionRuntimeAxisMutation'>,
  Pick<ReturnType<typeof createSessionProviderStore>, 'hasSessionProvider' | 'hydrateSessionProvider' |
    'getSessionProvider' | 'setSessionProvider' | 'clearSessionProvider'>,
  Pick<ReturnType<typeof createSessionRuntimeAxes>, 'getSessionEffort' | 'getSessionFastMode' |
    'setSessionEffort' | 'setSessionFastMode'>,
  Pick<ReturnType<typeof createRuntimeSetModel>, 'applyRuntimeSetModelChange'> {
  maker: Pick<Maker, 'getSession' | 'getSessionMeta' | 'listActiveSessions' | 'closeSession' |
    'forkSdkSession' | 'requiresCodexThreadHostTransfer'>;
  log: Logger;
  isDeviceLinkInvoke(): boolean;
  deviceLinkInvokeControllerSupports(capability: string): boolean;
  /** Desktop dispatch has a legacy persistence tail; Node persists directly. */
  markRemoteSettingPersistedInsideHandler?(response: object): void;
  persistsLocalModelSelection?: boolean;
  captureSharedTaskSettingGuard(id: string): (() => void) & {admit(): void};
  assertReviewSettingsUnlocked(id: string): Promise<void>;
  getDbClient(): DbClient;
  getCurrentDbClientSnapshot(): CurrentDbClientSnapshot | null;
  canApplyAutomaticRuntimeSelection(id: string, generation?: number): boolean;
  agentSwitchPending: ReturnType<typeof createPendingAgentSwitchRegistry>;
  agentSwitchDeps: MakerSessionAgentSwitchHandlerDeps;
  applyAgentDeviceRuntimeSelection(input: AgentDeviceRuntimeSelectionInput): ReturnType<ApplySessionRuntimeSelection>;
  listSshCodexProviders(hostId: string): Promise<ProviderView[]>;
  getDesktopProviderService(): {listProviders(options: {allowSideEffects: false; catalog?: Catalog}): Promise<ProviderView[]>};
  getActiveCatalog(): Catalog;
  getSessionDbAgentKind(id: string): 'cc' | 'codex' | 'pi' | null | undefined;
  assertModelRouteUsable(agent: AgentKind, model: string, providerId: string | null, remoteHostId?: string | null): Promise<string | undefined>;
  clearPendingCredentialSwitchForSession(id: string, options?: {wake?: boolean}): void;
  registerPendingCredentialSwitchForSession: NonNullable<ApplyRuntimeSetModelChangeInput['registerPendingCredentialSwitch']>;
  wakeSessionInputAfterCredentialSwitch(id: string): void;
  resolvePendingRuntimeAxisPatch(id: string, patch: SessionRuntimeAxisPatch): Promise<SessionRuntimeAxisPatch>;
  getPendingCredentialSwitchTarget: NonNullable<ApplyRuntimeSetModelChangeInput['getPendingCredentialSwitch']>;
  broadcastSessionRuntimeProjection(id: string, baselineOverride?: SessionRuntimeProfile): Promise<void>;
  isSessionInTurn(id: string): boolean;
  pendingCredentialSwitchHolder: Pick<PendingCredentialSwitchService, 'get' | 'has' | 'clear' | 'register'> | null;
  withRehydrateCloseSuppressed<T>(id: string, run: () => Promise<T>): Promise<T>;
  getSessionLastLiveUsage(id: string): {contextTokens: number; contextWindow: number; capturedAtMs: number} | undefined;
  resolveConfiguredContextWindow(catalog: Pick<Catalog, 'providers'>, agent: AgentKind, providerId: string | null | undefined, model: string, sessionBudget?: number | null): number | null;
  /** Saved task-level context budget, when the host persists this optional Desktop setting. */
  readStoredSessionContextWindowBudget?: (id: string) => Promise<number | null>;
  rehydrateColdPiRuntimeForWindowVerification(id: string): Promise<void>;
  contextOverflowRolloverHolder: Pick<ReturnType<typeof createContextOverflowRollover>, 'prepareModelWindowSwitch'> | null;
  broadcastSessionPatched(id: string, patch: Record<string, unknown>, owner?: DataOwnerBroadcastScope): void;
  captureDataOwnerBroadcastScope(): DataOwnerBroadcastScope;
  isDataOwnerBroadcastScopeCurrent(scope: DataOwnerBroadcastScope): boolean;
  getCodexProxyAuthInjectionState(sessionId: string): ApplyRuntimeSetModelChangeInput['codexAuthInjection'];
  persistSessionFields(id: string, patch: Record<string, unknown>): Promise<unknown>;
  updateScheduledPreference(id: string, preference: null): Promise<unknown>;
  recordSessionContextSnapshot(id: string, tokens: number, window: number): Promise<unknown>;
  withSendToSessionLock<T>(id: string, run: () => Promise<T>): Promise<T>;
}
