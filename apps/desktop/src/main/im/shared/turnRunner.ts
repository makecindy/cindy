import { readImRemoteProviderRoute } from '../remoteProviderRoute';
import { bindRuntimeRecoveryNotice } from './runtimeRecoveryNotice';
import { eq } from 'drizzle-orm';
import { getMaker } from '../../maker-host';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import { isCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';
import { getDbClient } from '../../localDb/client/current';
import { sessions as sessionsTable } from '../../localDb/schema';
import { hydrateSessionProvider } from '../../maker-host/session-provider-store';
import { setSessionEffort, setSessionFastMode } from '../../maker-host/session-effort-store';
import { hasCustomProviderKey } from '../../maker-host/provider-route';
import { createLogger } from '../../logger';
import { resolveSafe as resolveXdtImageUrl } from '../../imageCacheStore';
import { resolveSafe as resolveCindyMediaUrl } from '../../cindy-media/blobStore';
import { beginHeadlessGhostSetupTurn } from '../../mcp-integrations/ghostSetupInteractionSurface.js';
import { persistUserMessage } from '../messagePersistence';
import { bindingStore } from '../binding';
import {
  beginTurnChangeSetAtDispatch,
  wireSessionToIpcExternal,
  takePendingInteractionsForSession,
  noteSilentStopUserSend,
  stopSessionTurnExplicitly,
  onSilentStopSettled,
} from '../../maker-ipc/register';
import { clearPendingTurnChangeSets } from '../../turn-change-set/store';
import { agentHandoffPending } from '../../maker-ipc/agentHandoffPendingSingleton';
import { peekGoalInactiveNote } from '../../goal-host/inactiveNote';
import { isSilencedSchedulerTurn } from '../../scheduler-host/silent-output';
import { listMessagesForAgentHandoff } from '../../localDb/ipc/messages';
import {
  enqueueDurableWrite,
  redactToolInputForUntrustedBoundary,
} from '../../messagePersistBroadcaster';
import { readXdGatewayApiKey } from './apiKey';
import {
  generateAndPersistFbotTitle,
  generateImSessionTitleText,
  persistGeneratedSessionTitle,
} from './fbotTitle';
import { materializeLocalMarkdownImages } from './localMarkdownImages';
import { resolveSessionErrorContext } from './sessionProviderLabel';
import {
  readPermissionMode,
  touchUserSent as repoTouchUserSent,
  updatePermissionMode,
} from './sessionRepo';
import { changeSessionPermissionMode } from './permissionModeControl';
import { adoptStagedInboundFiles } from './inboundFileStaging';
import {
  createTurnRunner as createSharedTurnRunner,
  type ImTurnRunnerDeps,
} from '@cindy/im-runtime/turnRunner';
import type { ImChannelAdapter } from './types';
import type { ImSessionRepo } from './sessionRepo';
import type { ImCardBuilders } from './cardBuilders';
export * from '@cindy/im-runtime/turnRunner';

export function createTurnRunner(
  adapter: ImChannelAdapter,
  repo: ImSessionRepo,
  cards: ImCardBuilders,
  deps: ImTurnRunnerDeps = {},
) {
  return createSharedTurnRunner(adapter, repo, cards, deps, {
    getMaker: (...args) => getMaker(...args),
    createLogger: (...args) => createLogger(...args),
    readImRemoteProviderRoute: (...args) => readImRemoteProviderRoute(...args),
    readXdGatewayApiKey: (...args) => readXdGatewayApiKey(...args),
    hasCustomProviderKey: (...args) => hasCustomProviderKey(...args),
    isCredentialModeSwitchBusyError: (error): error is Error =>
      isCredentialModeSwitchBusyError(error),
    hydrateSessionProvider: (...args) => hydrateSessionProvider(...args),
    setSessionEffort: (...args) => setSessionEffort(...args),
    setSessionFastMode: (...args) => setSessionFastMode(...args),
    wireSessionToIpcExternal: (...args) => wireSessionToIpcExternal(...args),
    repoTouchUserSent: (...args) => repoTouchUserSent(...args),
    readPermissionMode: (...args) => readPermissionMode(...args),
    updatePermissionMode: (...args) => updatePermissionMode(...args),
    bindingStore,
    persistUserMessage: (...args) => persistUserMessage(...args),
    adoptStagedInboundFiles: (...args) => adoptStagedInboundFiles(...args),
    beginTurnChangeSetAtDispatch: (...args) => beginTurnChangeSetAtDispatch(...args),
    clearPendingTurnChangeSets: (...args) => clearPendingTurnChangeSets(...args),
    takePendingInteractionsForSession: (...args) => takePendingInteractionsForSession(...args),
    noteSilentStopUserSend: (...args) => noteSilentStopUserSend(...args),
    stopSessionTurnExplicitly: (...args) => stopSessionTurnExplicitly(...args),
    onSilentStopSettled: (...args) => onSilentStopSettled(...args),
    agentHandoffPending,
    enqueueDurableWrite: (...args) => enqueueDurableWrite(...args),
    listMessagesForAgentHandoff: (...args) => listMessagesForAgentHandoff(...args),
    peekGoalInactiveNote: (...args) => peekGoalInactiveNote(...args),
    isSilencedSchedulerTurn: (...args) => isSilencedSchedulerTurn(...args),
    beginHeadlessGhostSetupTurn: (...args) => beginHeadlessGhostSetupTurn(...args),
    bindRuntimeRecoveryNotice: (...args) => bindRuntimeRecoveryNotice(...args),
    redactToolInputForUntrustedBoundary: (...args) => redactToolInputForUntrustedBoundary(...args),
    generateAndPersistFbotTitle: (...args) => generateAndPersistFbotTitle(...args),
    generateImSessionTitleText: (...args) => generateImSessionTitleText(...args),
    persistGeneratedSessionTitle: (...args) => persistGeneratedSessionTitle(...args),
    resolveSessionErrorContext: (...args) => resolveSessionErrorContext(...args),
    resolveCindyMediaUrl: (...args) => resolveCindyMediaUrl(...args),
    resolveXdtImageUrl: (...args) => resolveXdtImageUrl(...args),
    materializeLocalMarkdownImages: (...args) => materializeLocalMarkdownImages(...args),
    changeSessionPermissionMode: (...args) => changeSessionPermissionMode(...args),
    listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: true }),
    readSession: async (sessionId) => {
      const [row] = await getDbClient()
        .drizzle.select()
        .from(sessionsTable)
        .where(eq(sessionsTable.id, sessionId))
        .limit(1);
      return row ?? null;
    },
    persistSdkSessionId: async (sessionId, sdkSessionId) => {
      await getDbClient()
        .drizzle.update(sessionsTable)
        .set({ sdkSessionId, updatedAt: Date.now() })
        .where(eq(sessionsTable.id, sessionId));
    },
  });
}
