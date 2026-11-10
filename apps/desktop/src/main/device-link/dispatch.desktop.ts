/** Desktop wiring for the shared Device Link dispatcher. */
import type { readUsageWidgetSnapshot } from '../quota-overview/service.js';
import { configureStandbyGuestCleanup } from './providerShareAvailabilityGuests.js';
import { prepareShareAvailability } from './providerShareAvailability.js';
import { readKimiCodingAccountUsage, readOpenCodeGoAccountUsage } from '../maker-host/provider-account-usage.js';
import { executeTaskTags, TASK_TAG_CHANNEL } from '../localDb/ipc/taskTags.js';
import { requestFilePeer, stopFilePeers } from './filePeer';
import { requestTaskMigration } from '../task-migration/service';
import { delegatedProviderShareGuestAccess, delegatedProviderShareLeases, invalidateProviderShareDelegation } from './providerShareDelegatedAccess.js';
import { app } from 'electron';
import { remoteDesktop, requestRemoteDesktop } from '../remote-desktop';
import { remoteCredentialHost } from '../remote-desktop/credentialHost';
import { readDeviceLinkSettings } from './settings-store.desktop';
import { noteControllerAccessAllowed, noteControllerAccessDenied, syncRemoteControlAccessGeneration } from './remoteControlAccess.js';
import { requestPluginOauth, invalidatePluginOauth } from '../plugin-oauth/runtime.js';
import { dispatchLocalInvoke } from './invoke-registry';
import {
  assertRemoteBotInvocationAllowed, projectRemoteSessionResult, projectRemoteBotPush,
  hasRemoteBotSessionLookup, setRemoteBotSessionLookup,
} from './remoteBotSessionBoundary.js';
import { captureSharedTaskPeer, captureSharedTaskPush, assertSharedTaskInvoke, sharedTaskMetadataTopic, sharedTaskAccessFailure } from './sharedTaskDispatch.js';
import { fetchLocalMediaToOss } from './mediaFetch';
import { MAX_SHARED_TASK_TOPICS, refreshSharedTaskPeer, releaseSharedTaskWatchesOnWorkdirChange } from './sharedTaskDispatch.js';
import { admitSharedTaskFsWatchTopics } from './sharedTaskFileAccess.js';
import { transcribeRemoteVoiceInput } from './voiceTranscribe';
import { readTelegramRemoteStatus, setTelegramRemoteOnline } from './telegramRemoteControl';
import { adviseAndRecordVoiceInputDictionaryLearning } from '../voice-input/index.js';
import { buildMobileDictionarySnapshot } from '../voice-input/dictionarySyncDriver.js';
import {
  setBroadcastTapListener,
} from './broadcast-tap';
import * as broadcastTap from './broadcast-tap';
import { RECOVERY_CHECKPOINT_MARKER } from '../maker-ipc/recoveryCoordinator.js';
import {
  sanitizeBotAuthorizationMetaForRemote,
  projectInteractionDismissedForRemote,
  projectInteractionRequestForRemote,
} from '../cindy-brain/ghostSetupInteractionBridge.js';
import {
  remoteWorkingDirRejectionToIpcError,
  type RemoteWorkingDirGuard,
} from './remote-workdir-guard';
import { createInboundDispatch } from "./dispatch.js";
export type * from "./dispatch.js";

// The quota service itself uses Device Link. Bootstrap supplies this port after
// both modules load, avoiding a dispatcher → quota → Device Link startup cycle.
let usageWidgetReader: typeof readUsageWidgetSnapshot | undefined;
export function setUsageWidgetSnapshotReader(reader: typeof readUsageWidgetSnapshot): void {
  usageWidgetReader = reader;
}

export const {
  setHistoryToolNameReader,
  setRemoteWorkingDirGuard,
  setRemoteReviewInputGuard,
  setProviderShareAccess,
  notifyProviderShareCatalogChanged,
  revalidateRemoteModelAccess,
  setRemoteAgentHandler,
  setProviderGroupRemoteHandler,
  setSetupSnapshotRemoteHandler,
  setSetupTransferRemoteHandler,
  setRemoteTurnChangeAction,
  setRemoteSubscriptionPoolQuotaReader,
  setRemoteClaudeSubscriptionUsageReader,
  setRemoteXaiSubscriptionUsageReader,
  markRemoteSettingPersistedInsideHandler,
  setRemoteSettingsPersist,
  setDispatchPresenceOfflineCheck,
  setSessionTextSnapshotReader,
  setOrdinaryPeerLinkAcceptedListener,
  setControllersChangedListener,
  setRemoteInvokeBusyChangedListener,
  setSessionsSubscribedListener,
  setControllerDisplayName,
  setControllerFallbackDisplayName,
  getControllerDisplayName,
  clearControllerDisplayNames,
  getActiveControllers,
  getUpdateRelaunchControllers,
  hasInFlightRemoteInvokes,
  pushSessionActivityToController,
  pushToTopicSubscribers,
  dropAllControllers,
  deactivateController,
  deactivateAllControllers,
  handleControllerOffline,
  forgetControllerInvokeState,
  purgeRevokedController,
  wireInboundDispatch,
  hasRemoteInvokeWorkForPeer,
  flushRemoteInvokeResultOutboxOnReconnect,
  flushMakerEventBatchesOnReconnect,
  runInvoke,
  hasProviderShares,
  providerShareActiveControllers,
  revokeProviderShareControllers,
  revokeControllerModelUse,
  notifyControllerModelUseRestored,
  abortProviderShareReshareRuns,
  __testing,
  remoteAgentLimitUsage
} = createInboundDispatch({
  readUsageWidgetSnapshot: () => {
    if (!usageWidgetReader) throw new Error('Usage overview is not initialized');
    return usageWidgetReader();
  },
  configureStandbyGuestCleanup,
  prepareShareAvailability,
  readKimiCodingAccountUsage,
  readOpenCodeGoAccountUsage,
  executeTaskTags: (...args) => executeTaskTags(...args),
  TASK_TAG_CHANNEL,
  requestFilePeer: (...args) => requestFilePeer(...args),
  stopFilePeers: (...args) => stopFilePeers(...args),
  requestTaskMigration: (...args) => requestTaskMigration(...args),
  delegatedProviderShareGuestAccess,
  delegatedProviderShareLeases,
  invalidateProviderShareDelegation,
  app,
  remoteDesktop: {
    stop: (...args) => remoteDesktop.stop(...args),
    signalingLost: (...args) => remoteDesktop.signalingLost(...args),
  },
  requestRemoteDesktop: (...args) => requestRemoteDesktop(...args),
  remoteCredentialHost: {
    close: (...args) => remoteCredentialHost.close(...args),
    closeAll: (...args) => remoteCredentialHost.closeAll(...args),
    dispose: (...args) => remoteCredentialHost.dispose(...args),
  },
  readDeviceLinkSettings,
  noteControllerAccessAllowed,
  noteControllerAccessDenied,
  syncRemoteControlAccessGeneration,
  requestPluginOauth: (...args) => requestPluginOauth(...args),
  invalidatePluginOauth: (...args) => invalidatePluginOauth(...args),
  dispatchLocalInvoke,
  assertRemoteBotInvocationAllowed,
  projectRemoteSessionResult,
  projectRemoteBotPush,
  hasRemoteBotSessionLookup,
  setRemoteBotSessionLookup,
  captureSharedTaskPeer,
  captureSharedTaskPush,
  assertSharedTaskInvoke,
  sharedTaskMetadataTopic,
  sharedTaskAccessFailure,
  fetchLocalMediaToOss: (...args) => fetchLocalMediaToOss(...args),
  MAX_SHARED_TASK_TOPICS,
  refreshSharedTaskPeer,
  releaseSharedTaskWatchesOnWorkdirChange,
  admitSharedTaskFsWatchTopics: (...args) => admitSharedTaskFsWatchTopics(...args),
  transcribeRemoteVoiceInput: (...args) => transcribeRemoteVoiceInput(...args),
  readTelegramRemoteStatus: (...args) => readTelegramRemoteStatus(...args),
  setTelegramRemoteOnline: (...args) => setTelegramRemoteOnline(...args),
  adviseAndRecordVoiceInputDictionaryLearning: (...args) => adviseAndRecordVoiceInputDictionaryLearning(...args),
  buildMobileDictionarySnapshot: (...args) => buildMobileDictionarySnapshot(...args),
  setBroadcastTapListener: (...args) => setBroadcastTapListener(...args),
  broadcastTap,
  RECOVERY_CHECKPOINT_MARKER,
  sanitizeBotAuthorizationMetaForRemote: (...args) => sanitizeBotAuthorizationMetaForRemote(...args),
  projectInteractionDismissedForRemote: (...args) => projectInteractionDismissedForRemote(...args),
  projectInteractionRequestForRemote: (...args) => projectInteractionRequestForRemote(...args),
  remoteWorkingDirRejectionToIpcError: (...args) => remoteWorkingDirRejectionToIpcError(...args)
});
