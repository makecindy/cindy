import { createBotProfileRuntime } from '@cindy/app-runtime/botProfileRuntime';
import { getDbClient } from '../localDb/client/current.js';
import { clearBotAttention, noteBotAttention } from './botAttentionService.js';
import { createLogger } from '../logger.js';
import { PROVIDER_NAME_TO_PLUGIN_ID } from '../maker-host/plugins/builtin-plugins.js';
import { BOT_BASELINE_PLUGIN_IDS } from '../maker-host/plugins/types.js';
import { buildTeammateGuide } from './teammateGuide.js';
export type { BotProfileRuntimeSnapshot, BotMemoryRuntimeRef, BotRuntimeFailureStage, BotProfileRuntimeDeps } from '@cindy/app-runtime/botProfileRuntime';
export const { markBotProfileRuntimeApplied, markBotProfileRuntimeFailed, buildBotProfilePrompt, buildBotProfileContextPrompt, withBotHomeAccess, buildBotUserProfilePrompt, resolveBotSkillReferences, resolveBotMcpReferences, resolveBotToolsetReferences, hydrateBotProfileRuntime, buildBotCapabilityContextPrompt } = createBotProfileRuntime({
  getDbClient, clearBotAttention, noteBotAttention,
  logger: createLogger('maker-ipc:bot-profile-runtime'),
  providerNameToPluginId: PROVIDER_NAME_TO_PLUGIN_ID,
  baselinePluginIds: BOT_BASELINE_PLUGIN_IDS,
  buildBotCapabilityContextPrompt: buildTeammateGuide,
});
