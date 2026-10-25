import {createBotRemoteManagement} from '@cindy/app-runtime/botRemoteManagement';
import { getBotAutonomySettingsView, setBotAutonomySchedulerBotId } from '../../bot-autonomy/hub.js';
import { readEffectiveBotModelChain } from '../../maker-host/bot-model-chain-settings-store.js';
import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { botRemoteResourceFromSource } from './botRemoteResourceProjection.js';
import { resolveAvailableTaskModels } from '../../maker-ipc/appDefaultModelControl.js';
import type { BotModelRoute } from '../../../shared/botModelChain.js';
import { createBotRemoteSettingsResource } from './botRemoteSettingsResource.js';
import { createBotProfile, createBotCanonicalSession, getBotMemoryService, getBotRemoteResourceSource, getBotRemoteSettingsSource, setBotProfileAvatar, updateBotProfile } from './bots.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { listBotSkillsForBot, readBotSkillForBot, saveBotSkillForSession, deleteBotSkillForBot } from '../../maker-ipc/botSkillService.js';
import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { createBotRemoteEditors } from './botRemoteEditors.js';
import { decodeBotAvatarImage } from './botAvatarSelection.js';
import { runRegisteredBotLifecycleAction } from '../../maker-ipc/botLifecycleService.js';
import { listBotSettingsCapabilities, validateBotCapabilityAdditions } from '../../maker-host/index.js';
import { botLinkedProjectAccess } from '../../maker-ipc/botLinkedProjects.js';

export const botRemoteManagement=createBotRemoteManagement({
  getBotAutonomySettingsView: (...args) => getBotAutonomySettingsView(...args),
  setBotAutonomySchedulerBotId: (...args) => setBotAutonomySchedulerBotId(...args),
  readEffectiveBotModelChain: (...args) => readEffectiveBotModelChain(...args),
  resolveAvailableTaskModels: (...args) => resolveAvailableTaskModels(...args),
  createBotProfile: (...args) => createBotProfile(...args),
  createBotCanonicalSession: (...args) => createBotCanonicalSession(...args),
  getBotMemoryService: (...args) => getBotMemoryService(...args),
  getBotRemoteResourceSource: (...args) => getBotRemoteResourceSource(...args),
  getBotRemoteSettingsSource: (...args) => getBotRemoteSettingsSource(...args),
  setBotProfileAvatar: (...args) => setBotProfileAvatar(...args),
  updateBotProfile: (...args) => updateBotProfile(...args),
  activeOwnerScopeKey: (...args) => activeOwnerScopeKey(...args),
  isAppSessionBoundaryPending: (...args) => isAppSessionBoundaryPending(...args),
  listBotSkillsForBot: (...args) => listBotSkillsForBot(...args),
  readBotSkillForBot: (...args) => readBotSkillForBot(...args),
  saveBotSkillForSession: (...args) => saveBotSkillForSession(...args),
  deleteBotSkillForBot: (...args) => deleteBotSkillForBot(...args),
  requestBotRuntimeEpochRefresh: (...args) => requestBotRuntimeEpochRefresh(...args),
  runRegisteredBotLifecycleAction: (...args) => runRegisteredBotLifecycleAction(...args),
  listBotSettingsCapabilities: (...args) => listBotSettingsCapabilities(...args),
  validateBotCapabilityAdditions: (...args) => validateBotCapabilityAdditions(...args),
  botLinkedProjectAccess: (...args) => botLinkedProjectAccess(...args),
});
