import { app } from 'electron';
import { activeOwnerScopeKey, getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { getMakerIfReady } from './index.js';
import { getDesktopProviderService } from './createDesktopProviderService.js';
import { getModelVisibilityOverride, waitForModelVisibilityMirror } from './model-visibility-mirror.js';
import { createBotModelChainSettings } from '@cindy/app-runtime/botModelChainSettings';
export type * from '@cindy/app-runtime/botModelChainSettings';
export const { readBotModelChainSettings, readBotModelChainSettingsState, writeBotModelChainSettings, resetBotModelChainSettings, readExplicitBotModelChain, readEffectiveBotModelSelection, readEffectiveBotModelChain } = createBotModelChainSettings({
  userDataPath: () => app.getPath('userData'), hasDataOwner: () => !!getActiveAppSession().dataOwnerId,
  ownerScopedUserDataPath, activeOwnerScopeKey, listAvailableAgents: () => getMakerIfReady()?.listAvailableAgents(),
  getDesktopProviderService, getModelVisibilityOverride, waitForModelVisibilityMirror,
  log: desktopMakerLogger.child('bot-model-chain-settings-store'),
});
