import { inspectCollaborationSettings } from '../../maker-host/collaboration-settings-store.js';
import { inspectAgentResourceSettings } from '../../maker-host/agent-resource-settings-store.js';
import { inspectGitSafetySettings } from '../../maker-host/git-safety-settings-store.js';
import { inspectMemorySettings } from '../../maker-host/memory-settings-store.js';
import { inspectCompactionSettings, inspectPiCompactionSettings } from '../../maker-host/compaction-settings-store.js';
import { inspectSilentEncryptedRetrySettings } from '../../maker-host/silent-encrypted-retry-store.js';
import { inspectChatEmbeddingSettings } from '../../maker-host/chat-embedding-settings-store.js';
import { inspectLspModeSettings } from '../../maker-host/lsp-mode-store.js';
import { inspectSubagentModelSettings } from '../../maker-host/subagent-model-settings-store.js';
import { inspectAuxiliaryModelSettings } from '../../utility-model/auxiliary-model-settings-store.js';
import { inspectBotModelChainSettings } from '../../maker-host/bot-model-chain-settings-store.js';
import { inspectTerminalPrefs } from '../../terminal/terminalPrefsStore.js';
import { inspectWindowBehaviorSettings } from '../../window-behavior-settings-store.js';
import { inspectDeviceLinkSettings } from '../../device-link/settings-store.desktop.js';
import { inspectUpdateChannelSettings } from '../../updateChannelStore.js';
import { inspectAutoUpdateSettings } from '../../auto-update-settings-store.js';
import { inspectAnalyticsSettings } from '../../analytics-settings-store.js';
import { inspectLogUploadSettings } from '../../log-upload/logUploadSettingsStore.js';
import { getSettingsReadContext } from '../readContext.js';
import type { ReadonlySettingsInspection } from '../readTypes.js';
import { readCoreSettings, type CoreSettingsStores } from './core.js';

/** 生产适配表仅保存函数引用；模块加载时不读取设置、身份、目录或凭据。 */
const stores: CoreSettingsStores = {
  collaboration: inspectCollaborationSettings,
  agentResource: inspectAgentResourceSettings,
  gitSafety: inspectGitSafetySettings,
  memory: inspectMemorySettings,
  compaction: inspectCompactionSettings,
  piCompaction: inspectPiCompactionSettings,
  silentEncryptedRetry: inspectSilentEncryptedRetrySettings,
  chatEmbedding: inspectChatEmbeddingSettings,
  lsp: inspectLspModeSettings,
  subagentModel: inspectSubagentModelSettings,
  auxiliaryModel: inspectAuxiliaryModelSettings,
  botModelChain: inspectBotModelChainSettings,
  terminal: inspectTerminalPrefs,
  windowBehavior: inspectWindowBehaviorSettings,
  deviceLink: inspectDeviceLinkSettings,
  updateChannel: inspectUpdateChannelSettings,
  autoUpdate: inspectAutoUpdateSettings,
  analytics: inspectAnalyticsSettings,
  logUpload: inspectLogUploadSettings,
};

/** 快照聚合使用的生产入口；所有公开脱敏仍由最终 projection 负责。 */
export function inspectCoreSettingsForSnapshot(): ReadonlySettingsInspection {
  return readCoreSettings({ getContext: getSettingsReadContext, stores });
}
