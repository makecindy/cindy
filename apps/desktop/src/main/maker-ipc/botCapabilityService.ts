import {inspectAppDefaultModel,changeAppDefaultModel} from './appDefaultModelControl.js';
import {getDbClient} from '../localDb/client/current.js';
import {updateBotProfile} from '../localDb/ipc/bots.js';
import {activeOwnerScopeKey,isAppSessionBoundaryPending} from '../appSessionState.js';
import {listCustomMcpServers} from '../maker-host/custom-mcp-store.js';
import {readEffectiveBotModelChain,readExplicitBotModelChain} from '../maker-host/bot-model-chain-settings-store.js';
import {authorizeGroupTool} from './botGroupToolAuthorization.js';
import {createBotCapabilityRuntime} from '@cindy/app-runtime/botCapabilityService';
export type {BotCapabilityServiceDeps,BotCapabilityUpdate} from '@cindy/app-runtime/botCapabilityService';
export const {createBotCapabilityService} = createBotCapabilityRuntime({
  inspectAppDefaultModel: (...args) => inspectAppDefaultModel(...args),
  changeAppDefaultModel: (...args) => changeAppDefaultModel(...args),
  getDbClient: (...args) => getDbClient(...args),
  updateBotProfile: (...args) => updateBotProfile(...args),
  activeOwnerScopeKey: (...args) => activeOwnerScopeKey(...args),
  isAppSessionBoundaryPending: (...args) => isAppSessionBoundaryPending(...args),
  listCustomMcpServers: (...args) => listCustomMcpServers(...args),
  readEffectiveBotModelChain: (...args) => readEffectiveBotModelChain(...args),
  readExplicitBotModelChain: (...args) => readExplicitBotModelChain(...args),
  authorizeGroupTool: (...args) => authorizeGroupTool(...args),
});
