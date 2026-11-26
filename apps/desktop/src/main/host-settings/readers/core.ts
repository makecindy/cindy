import type { SettingsSnapshotFieldId } from '../../../shared/settingsReadCatalog.js';
import { supportsBetaUpdateChannel } from '../../../shared/updateChannelCapability.js';
import type { AppSessionMode } from '../../appSessionState.js';
import type { SettingsFileInspection } from '../../maker-host/settings-inspection.js';
import { inspectedValue, type ReadonlySettingsInspection, type ReadonlySettingInspection } from '../readTypes.js';

/** 仅捕获已提交会话；不得调用鉴权、凭据或 ensureLoaded getter 来填充上下文。 */
export interface CoreSettingsReadContext {
  mode: AppSessionMode;
  dataOwnerId: string;
  generation: number;
  ownerRoot: string;
  userDataPath: string;
  isAuthenticated: boolean;
  membershipKind: 'personal' | 'org' | null;
  platform: NodeJS.Platform;
  arch: string;
}

/** 显式注入适配器，使聚合器不依赖 runtime、provider 与 Electron 启动模块。 */
export interface CoreSettingsStores {
  collaboration: typeof import('../../maker-host/collaboration-settings-store.js').inspectCollaborationSettings;
  agentResource: typeof import('../../maker-host/agent-resource-settings-store.js').inspectAgentResourceSettings;
  gitSafety: typeof import('../../maker-host/git-safety-settings-store.js').inspectGitSafetySettings;
  memory: typeof import('../../maker-host/memory-settings-store.js').inspectMemorySettings;
  compaction: typeof import('../../maker-host/compaction-settings-store.js').inspectCompactionSettings;
  piCompaction: typeof import('../../maker-host/compaction-settings-store.js').inspectPiCompactionSettings;
  silentEncryptedRetry: typeof import('../../maker-host/silent-encrypted-retry-store.js').inspectSilentEncryptedRetrySettings;
  chatEmbedding: typeof import('../../maker-host/chat-embedding-settings-store.js').inspectChatEmbeddingSettings;
  lsp: typeof import('../../maker-host/lsp-mode-store.js').inspectLspModeSettings;
  subagentModel: typeof import('../../maker-host/subagent-model-settings-store.js').inspectSubagentModelSettings;
  auxiliaryModel: typeof import('../../utility-model/auxiliary-model-settings-store.js').inspectAuxiliaryModelSettings;
  botModelChain: typeof import('../../maker-host/bot-model-chain-settings-store.js').inspectBotModelChainSettings;
  terminal: typeof import('../../terminal/terminalPrefsStore.js').inspectTerminalPrefs;
  windowBehavior: typeof import('../../window-behavior-settings-store.js').inspectWindowBehaviorSettings;
  deviceLink: typeof import('../../device-link/settings-store.desktop.js').inspectDeviceLinkSettings;
  updateChannel: typeof import('../../updateChannelStore.js').inspectUpdateChannelSettings;
  autoUpdate: typeof import('../../auto-update-settings-store.js').inspectAutoUpdateSettings;
  analytics: typeof import('../../analytics-settings-store.js').inspectAnalyticsSettings;
  logUpload: typeof import('../../log-upload/logUploadSettingsStore.js').inspectLogUploadSettings;
}

export const CORE_SETTINGS_FIELD_IDS = [
  'collaboration.workerSoftLimit', 'collaboration.workerHardLimit', 'collaboration.workerIdleReleaseMinutes',
  'agentResource.maxConcurrentCommands', 'agentResource.processPriority', 'agentResource.capToolchainThreads',
  'gitSafety.mode', 'gitSafety.autoInitProjectGit', 'gitSafety.autoSnapshotEnabled', 'memory.maker', 'memory.claudeCode', 'memory.codex', 'memory.pi',
  'compaction.claudeCodeAutoCompactPct', 'compaction.piAutoCompactPct', 'contacts.enabled', 'contacts.deviceSyncEnabled',
  'silentEncryptedRetry.enabled', 'chatEmbedding.enabled', 'lsp.enabled',
  'subagentModel.claudeCode', 'subagentModel.claudeCodeProviderId', 'subagentModel.codexSmartSubagentRouting',
  'auxiliaryModel.models', 'voice.refinerChain', 'botModelChain.modelChain', 'visionBridge.enabled', 'visionBridge.primary', 'visionBridge.fallback',
  'terminal.defaultShellPref', 'windowBehavior.windowsCloseBehavior', 'windowBehavior.linuxCloseBehavior',
  'deviceLink.remoteDesktopEnabled', 'deviceLink.remoteControlEnabled', 'deviceLink.keepAwake',
  'updateChannel.enableBeta', 'autoUpdate.autoRelaunchOnIdle', 'analytics.analyticsEnabled', 'logUpload.crashAutoUploadEnabled',
  'iosSimulator.autoOpenEmbeddedPanel',
] as const satisfies readonly SettingsSnapshotFieldId[];

function sameContext(a: CoreSettingsReadContext, b: CoreSettingsReadContext | null): boolean {
  return b !== null && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation && a.mode === b.mode
    && a.ownerRoot === b.ownerRoot && a.userDataPath === b.userDataPath
    && a.isAuthenticated === b.isAuthenticated && a.membershipKind === b.membershipKind
    && a.platform === b.platform && a.arch === b.arch;
}

function unavailable(): ReadonlySettingsInspection {
  return {
    fields: Object.fromEntries(CORE_SETTINGS_FIELD_IDS.map((id) => [id, { status: 'unavailable' } as const])),
    collections: { visionBridgeTargets: { status: 'unavailable' } },
  };
}

/**
 * 这里只收集本地事实，不是上传 DTO。模型/供应商标识与模型链必须经最终白名单投影证明公开性。
 * 不求解运行时默认链、不探测权限、不触发迁移或修复；owner 变化时丢弃整次采样。
 */
export function readCoreSettings(deps: {
  getContext(): CoreSettingsReadContext | null;
  stores: CoreSettingsStores;
}): ReadonlySettingsInspection {
  const first = deps.getContext();
  if (!first || !first.dataOwnerId || first.mode === 'signed-out') return unavailable();
  const context = { ...first };
  const fields: Record<string, ReadonlySettingInspection> = {};
  const collections: NonNullable<ReadonlySettingsInspection['collections']> = {};
  let changed = false;
  const current = () => {
    if (!sameContext(context, deps.getContext())) changed = true;
    return !changed;
  };
  function inspect<T extends object>(read: () => SettingsFileInspection<T>): SettingsFileInspection<T> {
    if (!current()) return { status: 'unavailable' };
    try {
      const result = read();
      return current() ? result : { status: 'unavailable' };
    } catch {
      current();
      return { status: 'unreadable' };
    }
  }
  function publish<T extends object>(domain: string, keys: readonly (keyof T & string)[], state: SettingsFileInspection<T>): void {
    for (const key of keys) {
      fields[`${domain}.${key}`] = state.status === 'ready'
        ? inspectedValue(state.value[key], state.sources[key])
        : { status: state.status };
    }
  }
  function read<T extends object>(domain: string, keys: readonly (keyof T & string)[], reader: () => SettingsFileInspection<T>): void {
    publish(domain, keys, inspect(reader));
  }
  const s = deps.stores;
  read('collaboration', ['workerSoftLimit', 'workerHardLimit', 'workerIdleReleaseMinutes'], () => s.collaboration());
  read('agentResource', ['maxConcurrentCommands', 'processPriority', 'capToolchainThreads'], () => s.agentResource());
  read('gitSafety', ['mode', 'autoSnapshotEnabled', 'autoInitProjectGit'], () => s.gitSafety());
  read('memory', ['maker', 'claudeCode', 'codex', 'pi'], () => s.memory(context.ownerRoot));
  read('compaction', ['claudeCodeAutoCompactPct'], () => s.compaction(context.ownerRoot));
  read('compaction', ['piAutoCompactPct'], () => s.piCompaction(context.ownerRoot));
  // Smart Contacts live in the cindy-contacts plugin; the frozen field IDs remain.
  fields['contacts.enabled'] = { status: 'unsupported' };
  fields['contacts.deviceSyncEnabled'] = { status: 'unsupported' };
  read('silentEncryptedRetry', ['enabled'], () => s.silentEncryptedRetry());
  read('chatEmbedding', ['enabled'], () => s.chatEmbedding({
    ownerRoot: context.ownerRoot, userDataPath: context.userDataPath,
    context: { mode: context.mode, isAuthenticated: context.isAuthenticated,
      userId: context.dataOwnerId, membershipKind: context.membershipKind },
  }));
  read('lsp', ['enabled'], () => s.lsp());
  read('subagentModel', ['claudeCode', 'claudeCodeProviderId', 'codexSmartSubagentRouting'], () => s.subagentModel(context.ownerRoot));
  read('auxiliaryModel', ['models'], () => s.auxiliaryModel({
    ownerRoot: context.ownerRoot, userDataPath: context.userDataPath, ownerId: context.dataOwnerId,
  }));
  // 语音润色共用辅助模型链；复用同一次观察，不能二次读出另一份事实。
  fields['voice.refinerChain'] = fields['auxiliaryModel.models']!;
  read('botModelChain', ['modelChain'], () => s.botModelChain(context.ownerRoot));
  // The app has no vision bridge; the snapshot contract keeps its fields, now unsupported.
  fields['visionBridge.enabled'] = { status: 'unsupported' };
  fields['visionBridge.primary'] = { status: 'unsupported' };
  fields['visionBridge.fallback'] = { status: 'unsupported' };
  collections.visionBridgeTargets = { status: 'unsupported' };
  read('terminal', ['defaultShellPref'], () => s.terminal());
  fields['windowBehavior.windowsCloseBehavior'] = { status: 'unsupported' };
  fields['windowBehavior.linuxCloseBehavior'] = { status: 'unsupported' };
  if (context.platform === 'win32') read('windowBehavior', ['windowsCloseBehavior'], () => s.windowBehavior());
  if (context.platform === 'linux') read('windowBehavior', ['linuxCloseBehavior'], () => s.windowBehavior());
  read('deviceLink', ['remoteDesktopEnabled', 'remoteControlEnabled', 'keepAwake'], () => s.deviceLink());
  if (supportsBetaUpdateChannel(context.platform, context.arch)) read('updateChannel', ['enableBeta'], () => s.updateChannel());
  else fields['updateChannel.enableBeta'] = { status: 'unsupported' };
  read('autoUpdate', ['autoRelaunchOnIdle'], () => s.autoUpdate());
  read('analytics', ['analyticsEnabled'], () => s.analytics());
  read('logUpload', ['crashAutoUploadEnabled'], () => s.logUpload());
  // There is no embedded iOS simulator; the field stays in the wire catalog.
  fields['iosSimulator.autoOpenEmbeddedPanel'] = { status: 'unsupported' };
  return current() ? { fields, collections } : unavailable();
}
