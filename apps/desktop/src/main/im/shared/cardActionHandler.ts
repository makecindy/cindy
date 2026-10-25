/**
 * main/im/shared/cardActionHandler.ts
 * ---------------------------------------------------------------------------
 * Subscribe to ChannelIM.onCardAction and dispatch the press to whatever
 * pending InteractionRequest matches `payload.requestId`. Build the
 * InteractionDecision from the buttonId + payload, then resolve the pending
 * promise so the agent's interaction resolver returns.
 *
 * We also patch the card to show "resolved" so the user can see their choice
 * stuck.
 *
 * 渠道无关(原 im/feishu/cardActionHandler.ts 工厂化): 渠道差异经 adapter 注入。
 * payload 里的 `botAppId` key 语义 = IdentityKey.botContextId(历史 key 名,
 * 兼容已发出的旧卡片, 见 cardBuilders 头注释)。
 */

import type { ChannelIM } from '@cindy/im';
import { createLogger } from '../../logger';
import { readImRemoteProviderRoute } from '../remoteProviderRoute';
import { getMaker } from '../../maker-host';
import {
  resolveLenientSessionRoute,
  resolveNewTaskDefaultModelRoute,
} from '../../maker-host/model-route-guard-live';
import {
  getSessionProvider,
  normalizeSessionProviderId,
  setSessionProvider,
} from '../../maker-host/session-provider-store';
import {
  applyPiImModelSelectionUnderLock,
  cancelPendingAgentSwitchForSession,
  clearPendingCredentialSwitchForSession,
  getPendingCredentialSwitchTarget,
  isSessionInTurn,
  registerPendingCredentialSwitchForSession,
  withSendToSessionLock,
  wakeSessionInputAfterCredentialSwitch,
} from '../../maker-ipc/register';
import { applyRuntimeSetModelChange } from '../../maker-ipc/runtimeSetModel';
import { cancelPendingSessionRuntimeMutation } from '../../maker-ipc/sessionRuntimeControl';
import { getDesktopCcPrefs } from '../index';
import {
  captureImAccountGeneration,
  isImAccountScopeClosedError,
  runInImAccountGeneration,
} from '../accountBoundary';
import { resolvePending, lookupPending } from './pendingInteractions';
import {
  listProjectsForControl,
  listSessionsForWorkspace,
  readSessionTitle,
} from './controlProjects';
import { exitControl } from './controlState';
import { startThreadControlFlow } from './controlFlow';
import { bindingStore, executeDetach } from '../binding';
import { generateTakeoverSummary } from './sessionSummary';
import { broadcastSessionCreated } from './sessionBroadcast';
import { readImDefaultSettings } from '../defaultSettingsStore';
import {
  readModelRouteSnapshot,
  readPermissionMode,
  switchSessionWorkingDir,
  touchUserSent,
  updateModelEffort,
  updatePermissionMode,
} from './sessionRepo';
import { markImSessionManualRouteOverride } from './manualRouteOverride';
import { changeSessionPermissionMode } from './permissionModeControl';
import type { ImCardBuilders } from './cardBuilders';
import type { ImTurnRunner } from './turnRunner';
import type { ImChannelAdapter } from './types';

import { createCardActionHandler as createSharedCardActionHandler } from '@cindy/im-runtime/cardActionHandler';
export function createCardActionHandler(
  adapter: ImChannelAdapter,
  cards: ImCardBuilders,
  turnRunner: ImTurnRunner,
): (im: ChannelIM) => () => void {
  return createSharedCardActionHandler(adapter, cards, turnRunner, {
    createLogger: (...args) => createLogger(...args),
    readImRemoteProviderRoute: (...args) => readImRemoteProviderRoute(...args),
    getMaker: (...args) => getMaker(...args),
    resolveLenientSessionRoute: (...args) => resolveLenientSessionRoute(...args),
    resolveNewTaskDefaultModelRoute: (...args) => resolveNewTaskDefaultModelRoute(...args),
    getSessionProvider: (...args) => getSessionProvider(...args),
    normalizeSessionProviderId: (...args) => normalizeSessionProviderId(...args),
    setSessionProvider: (...args) => setSessionProvider(...args),
    applyPiImModelSelectionUnderLock: (...args) => applyPiImModelSelectionUnderLock(...args),
    cancelPendingAgentSwitchForSession: (...args) => cancelPendingAgentSwitchForSession(...args),
    clearPendingCredentialSwitchForSession: (...args) =>
      clearPendingCredentialSwitchForSession(...args),
    withSendToSessionLock: (...args) => withSendToSessionLock(...args),
    cancelPendingSessionRuntimeMutation: (...args) => cancelPendingSessionRuntimeMutation(...args),
    getTaskDefaults: (...args) => getDesktopCcPrefs(...args),
    captureImAccountGeneration: (...args) => captureImAccountGeneration(...args),
    isImAccountScopeClosedError: (...args) => isImAccountScopeClosedError(...args),
    runInImAccountGeneration: (...args) => runInImAccountGeneration(...args),
    resolvePending: (...args) => resolvePending(...args),
    lookupPending: (...args) => lookupPending(...args),
    listProjectsForControl: (...args) => listProjectsForControl(...args),
    listSessionsForWorkspace: (...args) => listSessionsForWorkspace(...args),
    readSessionTitle: (...args) => readSessionTitle(...args),
    exitControl: (...args) => exitControl(...args),
    startThreadControlFlow: (...args) => startThreadControlFlow(...args),
    bindingStore: {
      get: (...args) => bindingStore.get(...args),
      attach: (...args) => bindingStore.attach(...args),
      attachWithResult: (...args) => bindingStore.attachWithResult(...args),
    },
    executeDetach: (...args) => executeDetach(...args),
    generateTakeoverSummary: (...args) => generateTakeoverSummary(...args),
    broadcastSessionCreated: (...args) => broadcastSessionCreated(...args),
    readImDefaultSettings: (...args) => readImDefaultSettings(...args),
    readModelRouteSnapshot: (...args) => readModelRouteSnapshot(...args),
    readPermissionMode: (...args) => readPermissionMode(...args),
    switchSessionWorkingDir: (...args) => switchSessionWorkingDir(...args),
    touchUserSent: (...args) => touchUserSent(...args),
    updateModelEffort: (...args) => updateModelEffort(...args),
    updatePermissionMode: (...args) => updatePermissionMode(...args),
    markImSessionManualRouteOverride: (...args) => markImSessionManualRouteOverride(...args),
    changeSessionPermissionMode: (...args) => changeSessionPermissionMode(...args),
    applyRuntimeModelChange: (sessionId, model, providerId, logger) =>
      applyRuntimeSetModelChange({
        maker: getMaker(),
        sessionId,
        model,
        providerId,
        logger,
        isSessionInTurn,
        registerPendingCredentialSwitch: registerPendingCredentialSwitchForSession,
        clearPendingCredentialSwitch: clearPendingCredentialSwitchForSession,
        wakeSessionInputQueue: wakeSessionInputAfterCredentialSwitch,
        getPendingCredentialSwitch: getPendingCredentialSwitchTarget,
      }),
  });
}
