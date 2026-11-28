import { z } from 'zod';
import { BROWSER_BACKEND_KINDS } from './browserBackend.js';

/** 只读公开目录，不是 mutation 协议；元数据只供 Host 投影与 CIS 排版，不随报告上传。 */
export const SETTINGS_READ_TABS = [
  'general', 'appearance', 'personalization', 'providers', 'billing', 'usage', 'model-groups', 'voice-input', 'im-bot',
  'shortcuts', 'agent-island', 'import', 'remote-control', 'shared-tasks', 'ghosts', 'builtin-tools',
  'computer-use', 'storage', 'help', 'about',
] as const;
export type SettingsReadTab = typeof SETTINGS_READ_TABS[number];
export type SettingsReadScope = 'owner' | 'profile' | 'workspace' | 'cloudDesktop';
export type SettingsReadBoundary = 'immediate' | 'nextTask' | 'nextAgentStart' | 'nextWindow' | 'nextConnection' | 'idleRestart';
export type SettingsReadPrivacy = 'value' | 'configured' | 'publicReference' | 'safeProjection';
export const SETTINGS_READ_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export const SETTINGS_READ_HARNESSES = ['claude-code', 'codex', 'pi'] as const;
export const SETTINGS_READ_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
/** Native IM default channels. `imessage` is newer than the frozen v2 wire and stays native-only. */
export const SETTINGS_READ_IM_CHANNELS = ['global', 'feishu', 'slack', 'discord', 'wechat', 'telegram', 'dingtalk', 'wecom', 'imessage'] as const;
export const SETTINGS_READ_SHORTCUT_IDS = [
  'copy-session-link', 'session-history-back', 'session-history-forward', 'region-screenshot',
  'toggle-sidebar', 'open-settings', 'new-maker', 'close-tab-or-window', 'right-tab-prev', 'right-tab-next',
  'find-in-page', 'search-in-project', 'save-file', 'open-terminal', 'zoom-in', 'zoom-out', 'zoom-reset',
  'browser-focus-url', 'browser-back', 'browser-forward', 'browser-reload', 'cycle-permission-mode',
  'switch-session-1', 'switch-session-2', 'switch-session-3', 'switch-session-4', 'switch-session-5',
  'switch-session-6', 'switch-session-7', 'switch-session-8', 'switch-session-9',
] as const;
export const SETTINGS_READ_WORKLOUDER_MODELS = ['codex-micro', 'creator-micro-2'] as const;
export const SETTINGS_READ_GAMEPAD_FAMILIES = ['xbox', 'playstation', 'nintendo', 'generic'] as const;
export const SETTINGS_READ_ISLAND_EVENTS = ['start', 'attention', 'complete', 'error', 'select'] as const;
export const SETTINGS_READ_ISLAND_SOUNDS = ['none', 'startup-chime', 'ring-chime', 'item-found', 'gem-collect', 'item-fanfare', 'victory-fanfare', 'error-buzz', 'secret-chime'] as const;
export const SETTINGS_READ_COMMAND_IDS = [
  'composer.toggleFastMode', 'approval.approve', 'approval.decline', 'forkTask', 'composer.submit', 'feedback',
  'toggleTerminal', 'copyConversationMarkdown', 'archiveTask', 'newTask', 'openBrowserTab', 'toggleTaskPin',
  'toggleReviewTab', 'composer.addPhotos', 'settings', 'manageTasks', 'composer.increaseReasoningEffort',
  'composer.decreaseReasoningEffort', 'openFolder', 'composer.addFiles', 'openSkills', 'composer.togglePlanMode',
  'navigateForward', 'toggleSidebar', 'toggleRightSidebar', 'navigateBack', 'toggleFullscreen', 'composer.focus',
  'conversation.scrollUp', 'conversation.scrollDown', 'conversation.scrollBottom', 'session.selectPrevious', 'session.selectNext',
] as const;
export const SETTINGS_READ_WORKLOUDER_KEYS = ['AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05', 'ACT06', 'ACT07', 'ACT08', 'ACT09', 'ACT10', 'ACT11', 'ACT12'] as const;
export const SETTINGS_READ_WORKLOUDER_SLOTS = [...SETTINGS_READ_WORKLOUDER_KEYS, 'ACT10_ACT11'] as const;
export const SETTINGS_READ_WORKLOUDER_KEYCAPS = [
  'FAST', 'APPR', 'REJ', 'SPLIT', 'MIC', 'MIC1', 'CODEX', 'BUG', 'OAI', 'TERM', 'DWN', 'DEL', 'NEW', 'NAV',
  'MAGIC', 'DIFF', 'PLAY', 'GIT', 'BRCH', 'BRANCH', 'MRG', 'PR', 'PAINT', 'LAB', 'PARTY', 'TIME', 'MIND+',
  'MIND-', 'EMPT1', 'EMPT2', 'EMPT3', 'EMPT4', 'EMPT5', 'SETUP', 'FOLD', 'UPL', 'APPS', 'YOLO', 'YEET',
] as const;
export const SETTINGS_READ_GAMEPAD_BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'xbox', 'ls', 'rs', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'] as const;
export const SETTINGS_READ_DIRECTIONS = ['up', 'right', 'down', 'left'] as const;
export const SETTINGS_READ_BUILTIN_TOOL_IDS = ['android', 'browser', 'computer', 'feishu_bot', 'wechat', 'slack', 'scheduler', 'ssh', 'memory', 'docs', 'xdt_helper', 'collab', 'lsp'] as const;
export const SETTINGS_READ_CAPABILITIES = ['image.generate', 'image.edit', 'video.generate', 'video.edit', 'text.oneshot', 'embed.text'] as const;

const bool = z.boolean();
const integer = (min: number, max: number) => z.number().finite().int().min(min).max(max);
const number = (min: number, max: number) => z.number().finite().min(min).max(max);
const harness = z.enum(SETTINGS_READ_HARNESSES);
const effort = z.enum(SETTINGS_READ_EFFORTS);
const permission = z.enum(['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
/** 语法只是第二道防线。Host 必须先以受信公共目录的精确成员关系证明公开性。 */
export const settingsReadPublicIdentifierSchema = z.string().min(1).max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/u)
  .refine(value => !value.split('/').some(part => /^(?:sk-|Bearer|cpca_|cpcr_|eyJ|https?|localhost$)/iu.test(part)));
export const settingsReadReferenceSchema = z.union([
  z.strictObject({ configured: z.literal(false) }),
  z.strictObject({ configured: z.literal(true), publicId: settingsReadPublicIdentifierSchema.optional() }),
]);
const sound = z.union([
  z.strictObject({ type: z.literal('builtin'), id: z.enum(SETTINGS_READ_ISLAND_SOUNDS) }),
  z.strictObject({ type: z.literal('custom'), configured: z.literal(true) }),
]);
/** 不传 key 显示兜底；键码是封闭物理键词表，绝不接受任意按键文字。 */
export const SETTINGS_READ_KEY_CODES = [
  'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyM',
  'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24',
  'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9',
  'Comma', 'Period', 'Semicolon', 'Quote', 'Slash', 'Backslash', 'BracketLeft', 'BracketRight',
  'Backquote', 'Minus', 'Equal', 'Space', 'Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
] as const;
export const settingsReadShortcutComboSchema = z.strictObject({
  code: z.enum(SETTINGS_READ_KEY_CODES), meta: bool, ctrl: bool, alt: bool, shift: bool,
});
export const settingsReadHardwareActionSchema = z.union([
  z.strictObject({ type: z.literal('command'), commandId: z.enum(SETTINGS_READ_COMMAND_IDS) }),
  z.strictObject({ type: z.literal('keycap'), keycapId: z.enum(SETTINGS_READ_WORKLOUDER_KEYCAPS) }),
  z.strictObject({ type: z.literal('voice') }),
  z.strictObject({ type: z.enum(['task', 'skill', 'composer-text', 'external-url']), configured: z.literal(true) }),
  z.null(),
]);
const gamepadAction = z.union([
  z.strictObject({ type: z.literal('command'), commandId: z.enum(SETTINGS_READ_COMMAND_IDS) }),
  z.strictObject({ type: z.literal('voice') }),
  z.strictObject({ type: z.literal('skill'), configured: z.literal(true) }),
  z.null(),
]);
const route = z.strictObject({
  harness, model: settingsReadReferenceSchema, provider: settingsReadReferenceSchema,
  effort: effort.nullable(), fastMode: bool,
});
const modelRoute = z.strictObject({ model: settingsReadReferenceSchema, provider: settingsReadReferenceSchema });

/** 字段来源及排版元数据。reader 是纯 inspection 域，不是可调用的写入口。 */
export interface SettingsReadFieldDefinition<T extends z.core.$ZodType = z.core.$ZodType> {
  tab: SettingsReadTab;
  group: string;
  labelKey: string;
  control: string;
  controlAncestors: readonly string[];
  sourcePath: string;
  reader: string;
  scope: SettingsReadScope;
  surface: 'host' | 'hostDesktop';
  platforms: readonly (typeof SETTINGS_READ_PLATFORMS[number])[];
  boundary: SettingsReadBoundary;
  privacy: SettingsReadPrivacy;
  projection: 'savedValue' | 'configuredOnly' | 'publicCatalogOrConfigured' | 'sanitizedStructure';
  valueSchema: T;
}
function definition<T extends z.core.$ZodType>(
  valueSchema: T, tab: SettingsReadTab, group: string, control: string, sourcePath: string,
  scope: SettingsReadScope = 'profile', boundary: SettingsReadBoundary = 'immediate',
  privacy: SettingsReadPrivacy = 'value', platforms: SettingsReadFieldDefinition['platforms'] = SETTINGS_READ_PLATFORMS,
): SettingsReadFieldDefinition<T> {
  return { valueSchema, tab, group, labelKey: `settingsRead.${group}`, control, sourcePath,
    controlAncestors: ['LspBetaCell', 'BetaChannelCell'].includes(control) ? ['ExperimentalSection']
      : ['SilentEncryptedRetryCell', 'ChatEmbeddingCell', 'MessageNavRailCell'].includes(control) ? ['TipsSection'] : [],
    reader: group, scope: group.startsWith('worklouder.') || group.startsWith('gamepad.') ? 'owner' : scope === 'cloudDesktop' ? 'profile' : scope,
    surface: scope === 'cloudDesktop' ? 'hostDesktop' : 'host', boundary, privacy, platforms,
    projection: privacy === 'configured' ? 'configuredOnly' : privacy === 'publicReference' ? 'publicCatalogOrConfigured' : privacy === 'safeProjection' ? 'sanitizedStructure' : 'savedValue' };
}
function group<const P extends string, const S extends Record<string, z.core.$ZodType>>(
  prefix: P, shape: S, tab: SettingsReadTab, control: string, sourcePath: string,
  scope: SettingsReadScope = 'profile', boundary: SettingsReadBoundary = 'immediate',
  privacy: SettingsReadPrivacy = 'value', platforms: SettingsReadFieldDefinition['platforms'] = SETTINGS_READ_PLATFORMS,
): { [K in keyof S & string as `${P}.${K}`]: SettingsReadFieldDefinition<S[K]> } {
  return Object.fromEntries(Object.entries(shape).map(([leaf, schema]) => {
    const id = `${prefix}.${leaf}`;
    const leafPrivacy = leaf.endsWith('Configured') || leaf.endsWith('Customized') || leaf === 'customized'
      ? 'configured' : privacy === 'publicReference' && schema !== settingsReadReferenceSchema ? 'value' : privacy;
    const desktopControl: Partial<Record<string, string>> = {
      theme: 'AppearanceSection', themeFamilyIdConfigured: 'AppearanceSection', locale: 'LanguageSection',
      sidebarPinnedMode: 'AppearanceSection', sidebarMainMode: 'AppearanceSection', ghostPanelRestoreMode: 'AppearanceSection',
      notificationsEnabled: 'NotificationSection', feishuNotificationsEnabled: 'FeishuBotNotificationSection',
      swallowActivationClick: 'WindowBehaviorSection', composerSendShortcut: 'ComposerSendShortcutSection',
      webLinkOpenPreference: 'LinkOpenSection', localLinkOpenPreference: 'LinkOpenSection', streamFadePreference: 'StreamFadeSection',
      promptRecommendationEnabled: 'TipsSection', messageNavRailEnabled: 'MessageNavRailCell', networkDebugEnabled: 'AboutSection',
    };
    const actualControl = prefix === 'desktop' ? desktopControl[leaf] ?? control : control;
    const actualTab = ['LinkOpenSection', 'StreamFadeSection', 'TipsSection', 'SilentEncryptedRetryCell', 'ChatEmbeddingCell', 'MessageNavRailCell'].includes(actualControl)
      ? 'personalization' : actualControl === 'AboutSection' ? 'about' : actualControl === 'BetaChannelCell' ? 'general' : tab;
    return [id, { ...definition(schema, actualTab, prefix, actualControl, sourcePath, scope, boundary, leafPrivacy, platforms), labelKey: `settingsRead.${id}` }];
  })) as { [K in keyof S & string as `${P}.${K}`]: SettingsReadFieldDefinition<S[K]> };
}
function family<const K extends readonly string[], T extends Record<string, SettingsReadFieldDefinition>>(
  keys: K, make: (key: K[number]) => T,
): T {
  return Object.assign({}, ...keys.map(make));
}

const core = {
  ...group('newTaskDefaults', { harness, modelId: settingsReadReferenceSchema, providerId: settingsReadReferenceSchema,
    effort: effort.nullable(), fast: bool, thinking: bool, worktree: bool, plan: bool }, 'general', 'NewMakerDraftRoute', 'shared/hostSettings.ts#NewTaskDefaultSettings', 'owner', 'nextTask', 'publicReference'),
  ...group('personalization', { customized: bool }, 'personalization', 'UserPromptSection', 'shared/hostSettings.ts#PersonalizationSettings', 'owner', 'nextAgentStart'),
  ...group('databaseWarning', { thresholdGiB: number(1, 1024), disabled: bool }, 'storage', 'StorageManagementCard', 'shared/hostSettings.ts#DatabaseWarningSettings'),
  ...group('appearance', { uiFontSize: integer(12, 24), codeFontSize: integer(10, 24), zoomFactor: number(0.5, 3),
    uiFontCustomized: bool, codeFontCustomized: bool }, 'appearance', 'AppearanceSection', 'shared/appearanceSettings.ts#APPEARANCE_LIMITS', 'cloudDesktop'),
  ...group('collaboration', { workerSoftLimit: number(1, 20), workerHardLimit: number(1, 20), workerIdleReleaseMinutes: number(0, 120) }, 'general', 'CollaborationSection', 'main/maker-host/collaboration-settings-store.ts'),
  ...group('agentResource', { maxConcurrentCommands: integer(0, 64), processPriority: z.enum(['normal', 'low', 'lowest']), capToolchainThreads: bool }, 'general', 'AgentResourceSection', 'main/maker-host/agent-resource-settings-store.ts', 'profile', 'nextAgentStart'),
  ...group('gitSafety', { mode: z.enum(['off', 'existing-git', 'all-projects']), autoSnapshotEnabled: bool, autoInitProjectGit: bool }, 'general', 'GitSafetySection', 'main/maker-host/git-safety-settings-store.ts', 'profile', 'nextTask'),
  ...group('memory', { maker: bool, claudeCode: bool, codex: bool, pi: bool }, 'personalization', 'MemorySection', 'main/maker-host/memory-settings-store.ts', 'owner', 'nextAgentStart'),
  ...group('compaction', { claudeCodeAutoCompactPct: integer(50, 95), piAutoCompactPct: integer(50, 95) }, 'personalization', 'CompactionSection', 'main/maker-host/compaction-settings-store.ts', 'owner', 'nextAgentStart'),
  ...group('subagentModel', { claudeCode: settingsReadReferenceSchema, claudeCodeProviderId: settingsReadReferenceSchema,
    codexSmartSubagentRouting: bool }, 'personalization', 'SubagentModelSection', 'shared/subagentModelSettings.ts#SUBAGENT_MODEL_CARD_KEYS', 'owner', 'nextAgentStart', 'publicReference'),
  ...group('auxiliaryModel', { models: z.array(modelRoute).max(3) }, 'personalization', 'AuxiliaryModelSection', 'shared/auxiliaryModelSettings.ts#AuxiliaryModelSettings', 'owner', 'nextTask', 'safeProjection'),
  ...group('botModelChain', { modelChain: z.array(route).max(5) }, 'general', 'BotsGlobalSettingsSection', 'shared/botModelChain.ts#BotModelRoute', 'owner', 'nextTask', 'safeProjection'),
  // The app has no vision bridge; the frozen v2 fields always read unsupported.
  ...group('visionBridge', { enabled: bool, primary: modelRoute.nullable(), fallback: modelRoute.nullable() }, 'personalization', 'VisionBridgeSection', 'main/host-settings/readers/core.ts', 'profile', 'nextTask', 'safeProjection'),
  // Smart Contacts lives in the cindy-contacts plugin; the frozen v2 fields always read unsupported.
  ...group('contacts', { enabled: bool, deviceSyncEnabled: bool }, 'personalization', 'ContactsSection', 'main/host-settings/readers/core.ts', 'owner'),
  ...group('silentEncryptedRetry', { enabled: bool }, 'general', 'SilentEncryptedRetryCell', 'main/maker-host/silent-encrypted-retry-store.ts'),
  ...group('chatEmbedding', { enabled: bool }, 'general', 'ChatEmbeddingCell', 'main/maker-host/chat-embedding-settings-store.ts', 'owner'),
  ...group('lsp', { enabled: bool }, 'general', 'LspBetaCell', 'main/maker-host/lsp-mode-store.ts', 'profile', 'nextAgentStart'),
  ...group('terminal', { defaultShellPref: z.enum(['auto', 'zsh', 'bash', 'fish', 'sh', 'pwsh', 'powershell', 'cmd', 'gitbash', 'wsl']) }, 'personalization', 'TerminalShellSection', 'main/terminal/terminalPrefsStore.ts', 'profile', 'nextConnection'),
  ...group('windowBehavior', { windowsCloseBehavior: z.enum(['quit', 'tray']).nullable() }, 'general', 'WindowBehaviorSection', 'shared/windowBehavior.ts#WindowsCloseBehavior', 'cloudDesktop', 'immediate', 'value', ['win32']),
  ...group('windowBehavior', { linuxCloseBehavior: z.enum(['quit', 'minimize']).nullable() }, 'general', 'WindowBehaviorSection', 'shared/windowBehavior.ts#LinuxCloseBehavior', 'cloudDesktop', 'immediate', 'value', ['linux']),
  ...group('deviceLink', { remoteDesktopEnabled: bool, remoteControlEnabled: bool, keepAwake: bool }, 'remote-control', 'RemoteControlSection', 'main/device-link/settings-store.ts', 'profile', 'nextConnection'),
  ...group('updateChannel', { enableBeta: bool }, 'about', 'BetaChannelCell', 'shared/updateChannelCapability.ts', 'profile', 'nextConnection'),
  ...group('autoUpdate', { autoRelaunchOnIdle: bool }, 'about', 'AboutSection', 'main/auto-update-settings-store.ts'),
  ...group('analytics', { analyticsEnabled: bool }, 'about', 'AboutSection', 'shared/analyticsSettings.ts'),
  ...group('logUpload', { crashAutoUploadEnabled: bool }, 'about', 'AboutSection', 'shared/logUpload.ts'),
  // Retired; the field id stays in the snapshot wire and always reads as unsupported.
  ...group('iosSimulator', { autoOpenEmbeddedPanel: bool }, 'computer-use', 'ComputerUseSection', 'shared/featureRetirements.ts', 'owner', 'immediate', 'value', ['darwin']),
  ...group('browser', { backend: z.enum(BROWSER_BACKEND_KINDS), useRealProfile: bool }, 'computer-use', 'BrowserBackendSubsection', 'main/browser-backend-settings-store.ts', 'profile', 'nextConnection'),
  ...group('browser', { enabled: bool }, 'computer-use', 'ComputerUseSection', 'main/maker-host/plugins/settings-reader.ts', 'owner', 'nextTask'),
  ...group('android', { adbPathOverrideConfigured: bool, defaultDeviceSerialConfigured: bool }, 'computer-use', 'ComputerUseSection', 'main/android-automation-settings-store.ts', 'profile', 'nextConnection'),
  ...group('android', { enabled: bool }, 'computer-use', 'ComputerUseSection', 'main/maker-host/plugins/settings-reader.ts', 'owner', 'nextTask'),
  ...group('computer', { enabled: bool }, 'computer-use', 'ComputerUseSection', 'main/maker-host/plugins/settings-reader.ts', 'owner', 'nextTask'),
};
/**
 * Display languages on the CIS wire, including `system`. Every Host understands the first six; a Host
 * lists the newer ones in its `desktopGeneral` locale choices before a cloud page offers them.
 */
export const SETTINGS_DISPLAY_LOCALES = [
  'system', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt-PT', 'pt-BR', 'zh-Hant-x-lzh', 'zh-Hans-x-lzh',
] as const;
const desktop = {
  ...group('desktop', {
    theme: z.enum(['system', 'light', 'dark']), themeFamilyIdConfigured: bool,
    locale: z.enum(SETTINGS_DISPLAY_LOCALES),
    sidebarPinnedMode: z.enum(['text', 'card', 'list']), sidebarMainMode: z.enum(['text', 'list']),
    ghostPanelRestoreMode: z.enum(['bubble', 'sidebar']), notificationsEnabled: bool, swallowActivationClick: bool,
    composerSendShortcut: z.enum(['enter', 'modifier-enter']), webLinkOpenPreference: z.enum(['external', 'sidebar']),
    localLinkOpenPreference: z.enum(['external', 'sidebar']), streamFadePreference: z.enum(['on', 'off']),
    promptRecommendationEnabled: bool, messageNavRailEnabled: bool, feishuNotificationsEnabled: bool,
    networkDebugEnabled: bool,
  }, 'general', 'DesktopPreferences', 'renderer/components/AppPreferenceControl.tsx', 'cloudDesktop'),
  ...group('desktop', { agentIslandEnabled: bool, agentIslandMascotSkin: z.enum(['cindy', 'blackcat', 'pululu', 'tarara', 'boli', 'whitesnow', 'annie', 'chaku', 'muffin', 'erika']),
    agentIslandDisplayTargetConfigured: bool }, 'agent-island', 'AgentIslandSection', 'shared/agentIsland.ts', 'cloudDesktop', 'immediate', 'value', ['darwin']),
  ...group('desktop.agentIslandSoundSettings', { enabled: bool }, 'agent-island', 'AgentIslandSection', 'shared/agentIsland.ts#AgentIslandSoundSettings', 'cloudDesktop', 'immediate', 'value', ['darwin']),
  ...family(SETTINGS_READ_ISLAND_EVENTS, event => group(`desktop.agentIslandSoundSettings.sounds`, { [event]: sound } as Record<typeof event, typeof sound>,
    'agent-island', 'AgentIslandSection', 'shared/agentIsland.ts#AGENT_ISLAND_SOUND_EVENTS', 'cloudDesktop', 'immediate', 'safeProjection', ['darwin'])),
};
export const SETTINGS_READ_ASR_PROVIDERS = ['custom-realtime-asr', 'elevenlabs-scribe-realtime', 'elevenlabs-scribe-v3-live', 'openai-realtime-whisper', 'litellm-gpt-realtime-whisper', 'litellm-qwen3-asr-flash-realtime', 'litellm-volcengine-sauc-asr', 'litellm-batch', 'local-sherpa-onnx'] as const;
const voice = {
  ...group('voice', { language: z.enum(['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko']), microphoneDeviceIdConfigured: bool,
    muteSystemAudio: bool, playInteractionSound: bool, fastActivationEnabled: bool, composerLongPressEnabled: bool, refinementEnabled: bool,
    refinementInstructionsConfigured: bool, autoDictionaryEnabled: bool, dictionarySyncEnabled: bool, shortcutConfigured: bool,
    serviceMode: z.enum(['cindy', 'byok']), customAsrConfigured: bool,
    asrProvider: z.enum(SETTINGS_READ_ASR_PROVIDERS), asrProviderChain: z.array(z.enum(SETTINGS_READ_ASR_PROVIDERS)).max(SETTINGS_READ_ASR_PROVIDERS.length),
    refinerChain: z.array(modelRoute).max(3),
  }, 'voice-input', 'VoiceInputSection', 'shared/voiceInputData.ts#VoiceInputSettings', 'owner', 'nextConnection'),
  ...group('voice.customAsr', { protocol: z.enum(['openai-realtime', 'qwen-realtime']).nullable(), endpointConfigured: bool, modelConfigured: bool }, 'voice-input', 'VoiceInputSection', 'shared/voiceInputCustomAsr.ts', 'owner', 'nextConnection'),
};
const imPreferences = {
  ...group('im.localTelegram', { emojiReactions: z.enum(['off', 'minimal', 'expressive']),
    replyQuoteGroup: z.enum(['off', 'first', 'all']), replyQuoteDm: z.enum(['off', 'first']), botNameConfigured: bool, soulConfigured: bool,
  }, 'im-bot', 'TelegramBehaviorSettings', 'main/im/telegram/behaviorStore.ts', 'owner', 'nextConnection'),
  ...group('im.official', { slackEnabled: bool, telegramEnabled: bool, xEnabled: bool, slackLifecycleAnnouncement: bool,
    telegramDefaultWorkspaceConfigured: bool, xDefaultWorkspaceConfigured: bool, urlOverrideConfigured: bool,
  }, 'im-bot', 'HookConnectionsSection', 'main/hook-control/store.ts', 'owner', 'nextConnection'),
  ...group('im.wecom', { notificationsEnabled: bool }, 'im-bot', 'WecomBotSection', 'renderer/components/settings/WecomBotSection.tsx', 'profile', 'nextConnection'),
};
const im = family(SETTINGS_READ_IM_CHANNELS, channel => ({
  ...group(`im.${channel}`, { agentKind: harness, permissionMode: permission, groupPermissionMode: permission }, 'im-bot', 'ImDefaultSettingsSection', 'shared/imDefaultSettings.ts#ImDefaultSettings', 'owner', 'nextTask'),
  ...family(SETTINGS_READ_HARNESSES, agent => group(`im.${channel}.agents.${agent}`, {
    providerId: settingsReadReferenceSchema, model: settingsReadReferenceSchema, effort,
  }, 'im-bot', 'ImDefaultSettingsSection', 'shared/imDefaultSettings.ts#ImDefaultAgentSettings', 'owner', 'nextTask', 'publicReference')),
}));
const shortcuts = family(SETTINGS_READ_SHORTCUT_IDS, id => ({
  [`shortcuts.${id}`]: { ...definition(z.array(settingsReadShortcutComboSchema).max(3), 'shortcuts', 'shortcuts',
    'KeyboardShortcutsSection', `shared/appShortcuts.ts#${id}`, 'profile', 'immediate', 'safeProjection',
    id === 'region-screenshot' ? ['darwin', 'win32'] : id === 'open-settings' ? ['darwin'] : id.startsWith('zoom-') ? ['win32', 'linux'] : SETTINGS_READ_PLATFORMS), labelKey: `settings.shortcuts.items.${id}.label` },
})) as { [K in typeof SETTINGS_READ_SHORTCUT_IDS[number] as `shortcuts.${K}`]: SettingsReadFieldDefinition<z.ZodArray<typeof settingsReadShortcutComboSchema>> };
const worklouder = family(SETTINGS_READ_WORKLOUDER_MODELS, model => ({
  ...group(`worklouder.${model}`, { deviceEnabled: bool, lightingBrightness: integer(0, 100),
    lightingAutoDim: z.enum(['off', '30-seconds', '1-minute', '3-minutes', '10-minutes', '30-minutes', '1-hour']),
    agentSource: z.enum(['sidebar', 'last-sent', 'priority', 'custom']), singleTapAgentKeys: bool,
  }, 'shortcuts', 'WorkLouderCodexSettings', 'shared/workLouderCodex.ts#WorkLouderCodexSettings'),
  ...family(['0', '1', '2', '3', '4', '5'] as const, slot => group(`worklouder.${model}.customAgentKeys`, { [slot]: settingsReadHardwareActionSchema } as Record<typeof slot, typeof settingsReadHardwareActionSchema>,
    'shortcuts', 'WorkLouderCodexSettings', 'shared/workLouderCodex.ts#WORKLOUDER_CODEX_AGENT_SLOT_COUNT', 'profile', 'immediate', 'safeProjection')),
  ...group(`worklouder.${model}.layout`, { encoderMode: z.enum(['session-switch', 'composer-navigation', 'reasoning', 'conversation-scroll', 'custom']), separateMicrophoneKeys: bool,
    taskKeys: z.array(z.enum(SETTINGS_READ_WORKLOUDER_KEYS)).max(13),
    merges: z.array(z.strictObject({ origin: z.enum(SETTINGS_READ_WORKLOUDER_KEYS), cover: z.enum(SETTINGS_READ_WORKLOUDER_KEYS) })).max(6),
  }, 'shortcuts', 'WorkLouderCodexSettings', 'shared/workLouderCodex.ts#WorkLouderCodexLayout', 'profile', 'immediate', 'safeProjection'),
  ...family(SETTINGS_READ_WORKLOUDER_SLOTS, slot => group(`worklouder.${model}.layout.slots.${slot}`, {
    keycapId: z.enum(SETTINGS_READ_WORKLOUDER_KEYCAPS), action: settingsReadHardwareActionSchema,
  }, 'shortcuts', 'WorkLouderCodexSettings', 'shared/workLouderCodex.ts#WorkLouderCodexKeyAssignment', 'profile', 'immediate', 'safeProjection')),
  ...family(SETTINGS_READ_DIRECTIONS, direction => group(`worklouder.${model}.layout.analogStick`, { [direction]: settingsReadHardwareActionSchema } as Record<typeof direction, typeof settingsReadHardwareActionSchema>,
    'shortcuts', 'WorkLouderCodexSettings', 'shared/workLouderCodex.ts#WorkLouderCodexLayout', 'profile', 'immediate', 'safeProjection')),
  ...family(['left', 'right', 'click', 'longPress'] as const, action => group(`worklouder.${model}.layout.encoder`, { [action]: settingsReadHardwareActionSchema } as Record<typeof action, typeof settingsReadHardwareActionSchema>,
    'shortcuts', 'WorkLouderCodexSettings', 'shared/workLouderCodex.ts#WorkLouderCodexLayout', 'profile', 'immediate', 'safeProjection')),
}));
const gamepad = family(SETTINGS_READ_GAMEPAD_FAMILIES, model => ({
  ...group(`gamepad.${model}`, { deviceEnabled: bool }, 'shortcuts', 'XboxGamepadSettings', 'shared/xboxGamepad.ts#XboxGamepadSettings'),
  ...family(SETTINGS_READ_GAMEPAD_BUTTONS, button => group(`gamepad.${model}.layout.buttons`, { [button]: gamepadAction } as Record<typeof button, typeof gamepadAction>,
    'shortcuts', 'XboxGamepadSettings', 'shared/xboxGamepad.ts#XBOX_GAMEPAD_BUTTON_IDS', 'profile', 'immediate', 'safeProjection')),
  ...family(['left', 'right'] as const, stick => ({
    ...group(`gamepad.${model}.layout.sticks.${stick}`, { mode: z.enum(['conversation-scroll', 'custom']) }, 'shortcuts', 'XboxGamepadSettings', 'shared/xboxGamepad.ts#XboxGamepadStickBinding'),
    ...family(SETTINGS_READ_DIRECTIONS, direction => group(`gamepad.${model}.layout.sticks.${stick}.directions`, { [direction]: gamepadAction } as Record<typeof direction, typeof gamepadAction>,
      'shortcuts', 'XboxGamepadSettings', 'shared/xboxGamepad.ts#XboxGamepadStickBinding', 'profile', 'immediate', 'safeProjection')),
  })),
}));

/** 固定叶子全部必报，包括不适用平台的明确状态；不能为预算丢弃任何一个叶子。 */
export const SETTINGS_READ_CATALOG = { ...core, ...desktop, ...voice, ...im, ...imPreferences, ...shortcuts, ...worklouder, ...gamepad };
export type SettingsSnapshotFieldId = keyof typeof SETTINGS_READ_CATALOG;
export const SETTINGS_READ_FIELD_IDS = Object.keys(SETTINGS_READ_CATALOG) as SettingsSnapshotFieldId[];

/** 动态列表只读已知持久项，序号仅在这一份快照内有效，不是用户配置身份。 */
const ordinal = integer(1, Number.MAX_SAFE_INTEGER);
const entrySource = z.enum(['default', 'override', 'unknown']);
const entryBase = { ordinal, source: entrySource };
const collectionDefinition = <T extends z.core.$ZodType>(entrySchema: T, tab: SettingsReadTab, control: string, sourcePath: string, scope: SettingsReadScope = 'owner') => ({
  entrySchema, tab, control, sourcePath, scope, boundary: 'nextTask' as const,
  privacy: 'safeProjection' as const, labelKey: `settingsRead.collections.${control}`,
});
export const SETTINGS_READ_COLLECTION_CATALOG = {
  modelVisibility: collectionDefinition(z.strictObject({ ...entryBase, enabled: bool }), 'providers', 'UnifiedModelList', 'main/maker-host/model-visibility-mirror.ts'),
  modelEngines: collectionDefinition(z.strictObject({ ...entryBase, agent: harness }), 'providers', 'UnifiedModelList', 'main/maker-host/model-visibility-mirror.ts'),
  modelFavorites: collectionDefinition(z.strictObject({ ...entryBase, agent: harness, effort: effort.nullable(), fast: bool }), 'providers', 'UnifiedModelList', 'main/maker-host/model-visibility-mirror.ts'),
  modelDisable: collectionDefinition(z.strictObject({ ...entryBase, kind: z.enum(['model', 'provider']), disabled: z.literal(true) }), 'providers', 'UnifiedModelList', 'main/maker-host/model-disable-store.ts'),
  providerPresentation: collectionDefinition(z.strictObject({ ...entryBase, nameConfigured: bool, removed: bool.nullable() }), 'providers', 'ProvidersSection', 'main/maker-host/provider-presentation-store.ts'),
  modelContextBudget: collectionDefinition(z.strictObject({ ...entryBase, contextLimit: integer(1000, 100_000_000) }), 'providers', 'ModelAdvancedDrawer', 'shared/modelContextLimit.ts'),
  modelPrices: collectionDefinition(z.strictObject({ ...entryBase, currency: z.enum(['USD', 'CNY']).optional(),
    inputPerMtok: number(0, Number.MAX_VALUE).optional(), outputPerMtok: number(0, Number.MAX_VALUE).optional(),
    cacheReadPerMtok: number(0, Number.MAX_VALUE).nullable().optional(), cacheCreatePerMtok: number(0, Number.MAX_VALUE).nullable().optional(),
  }), 'providers', 'ModelPriceOverrideDialog', 'shared/modelPriceOverride.ts'),
  modelParameterHistory: collectionDefinition(z.strictObject({ ...entryBase, effort: effort.optional(), fast: bool.optional(), thinking: bool.optional(), lastSelected: bool }), 'providers', 'UnifiedModelList', 'shared/newTaskPreferenceHistory.ts'),
  visionBridgeTargets: collectionDefinition(z.strictObject({ ...entryBase, model: settingsReadReferenceSchema }), 'personalization', 'VisionBridgeSection', 'main/host-settings/readers/core.ts', 'profile'),
  imWorkspacePrefs: collectionDefinition(z.strictObject({ ...entryBase, channel: z.enum(['slack', 'telegram', 'x']), harness: harness.nullable(), modelConfigured: bool,
    effort: effort.nullable(), permissionMode: permission.nullable(), dirty: bool }), 'im-bot', 'HookWorkspacePrefsEditor', 'main/hook-control/workspacePrefsStore.ts'),
  telegramGroupActivation: collectionDefinition(z.strictObject({ ...entryBase, mode: z.enum(['mention', 'always']) }), 'im-bot', 'TelegramBehaviorSettings', 'main/im/telegram/behaviorStore.ts'),
  builtinToolOverrides: collectionDefinition(z.strictObject({ ...entryBase, scope: z.enum(['user', 'project']), tool: z.enum(SETTINGS_READ_BUILTIN_TOOL_IDS), enabled: bool }), 'builtin-tools', 'BuiltinToolsSection', 'main/maker-host/plugins/settings-reader.ts', 'workspace'),
  pluginSidebar: collectionDefinition(z.strictObject({ ...entryBase, hidden: bool, order: integer(0, Number.MAX_SAFE_INTEGER).nullable() }), 'ghosts', 'SettingsCatalogPanel', 'main/sidebarSettingsStore.ts'),
  pluginCindyPrefs: collectionDefinition(z.strictObject({ ...entryBase, capability: z.enum(SETTINGS_READ_CAPABILITIES).nullable(), modelConfigured: bool,
    inflightLimit: integer(1, Number.MAX_SAFE_INTEGER).nullable() }), 'ghosts', 'SettingsCatalogPanel', 'main/cindy-brain/cindyPrefsStore.ts'),
  pluginErrandPrefs: collectionDefinition(z.strictObject({ ...entryBase, harness: harness.nullable(), modelConfigured: bool, providerConfigured: bool,
    effort: effort.nullable(), fastMode: bool.nullable(), permissionMode: z.enum(['plan', 'acceptEdits', 'auto']).nullable(), workingDirConfigured: bool,
  }), 'ghosts', 'SettingsCatalogPanel', 'main/cindy-brain/errandPrefsStore.ts'),
};
export type SettingsSnapshotCollectionId = keyof typeof SETTINGS_READ_COLLECTION_CATALOG;
export const SETTINGS_READ_COLLECTION_IDS = Object.keys(SETTINGS_READ_COLLECTION_CATALOG) as SettingsSnapshotCollectionId[];

/** 资源、操作和远端归属不伪装成已读取 Host 设置值，也不进入快照字段。 */
export const SETTINGS_READ_EXTERNAL_CATALOG = [
  { id: 'localAgent.applications', tab: 'remote-control', control: 'LocalAgentSection', kind: 'authorization', entry: 'local-agent' },
  { id: 'account.profile', tab: 'general', control: 'UserProfileCard', kind: 'external', entry: 'account' },
  { id: 'account.logout', tab: 'general', control: 'LogoutSection', kind: 'action', entry: 'account' },
  // The new-task default permission is renderer-local and not part of the deployed v2 snapshot.
  { id: 'general.newChatDefaultPermission', tab: 'general', control: 'NewChatDefaultPermissionSection', kind: 'external', entry: 'newTask' },
  // The default new-task folder is renderer-local per data owner; not a v2 snapshot field.
  { id: 'general.defaultNewTaskWorkingDir', tab: 'general', control: 'DefaultNewTaskWorkingDirSection', kind: 'external', entry: 'newTask' },
  // Setup migration from another computer is an action on that computer's own window, not a v2 snapshot field.
  { id: 'general.setupMigration', tab: 'general', control: 'SetupMigrationSection', kind: 'action', entry: 'setupMigration' },
  // The get-started guide is reopened on the window itself; it holds no setting.
  { id: 'general.firstRunGuide', tab: 'general', control: 'FirstRunGuideSection', kind: 'action', entry: 'help' },
  { id: 'billing.account', tab: 'billing', control: 'BillingSettingsSection', kind: 'external', entry: 'billing' },
  { id: 'usage.history', tab: 'usage', control: 'UsageHistorySection', kind: 'resource', entry: 'usage' },
  // Model groups are a provider resource, not a v2 snapshot field.
  { id: 'modelGroups.groups', tab: 'model-groups', control: 'ModelGroupsSection', kind: 'resource', entry: 'providers' },
  { id: 'personalization.memoryContent', tab: 'personalization', control: 'MemorySection', kind: 'resource', entry: 'memory' },
  { id: 'providers.connections', tab: 'providers', control: 'ProvidersSection', kind: 'authorization', entry: 'providers' },
  { id: 'voice.dictionary', tab: 'voice-input', control: 'VoiceInputSection', kind: 'resource', entry: 'voice' },
  // Local microphone filtering is not part of the deployed v2 snapshot contract.
  { id: 'voice.speakerFilter', tab: 'voice-input', control: 'VoiceInputSection', kind: 'external', entry: 'voice' },
  { id: 'voice.conversation', tab: 'voice-input', control: 'VoiceInputSection', kind: 'external', entry: 'voice' },
  { id: 'voice.history', tab: 'voice-input', control: 'VoiceInputSection', kind: 'resource', entry: 'voice' },
  { id: 'voice.credentials', tab: 'voice-input', control: 'VoiceInputSection', kind: 'authorization', entry: 'voice' },
  { id: 'im.connections', tab: 'im-bot', control: 'ImBotSection', kind: 'authorization', entry: 'im' },
  { id: 'im.officialTelegramBehavior', tab: 'im-bot', control: 'TelegramBehaviorSettings', kind: 'external', entry: 'im' },
  { id: 'import.sessions', tab: 'import', control: 'SessionImportSection', kind: 'action', entry: 'import' },
  { id: 'sharedTasks.sharing', tab: 'shared-tasks', control: 'SharedTaskDialog', kind: 'resource', entry: 'sharedTasks' },
  { id: 'cloud.instances', tab: 'remote-control', control: 'CloudDeviceDirectory', kind: 'external', entry: 'remote' },
  { id: 'remote.connections', tab: 'remote-control', control: 'RemoteControlSection', kind: 'authorization', entry: 'remote' },
  // The away-from-computer section guards this computer's own display: keep awake is
  // deviceLink.keepAwake, and the privacy screen is not a v2 snapshot field.
  { id: 'remote.awayFromComputer', tab: 'general', control: 'AwayFromComputerSection', kind: 'external', entry: 'remote' },
  { id: 'plugins.settingsHtml', tab: 'ghosts', control: 'SettingsCatalogPanel', kind: 'external', entry: 'plugin' },
  { id: 'plugins.resources', tab: 'ghosts', control: 'SettingsCatalogPanel', kind: 'resource', entry: 'plugin' },
  { id: 'tools.customMcp', tab: 'builtin-tools', control: 'McpServersSection', kind: 'resource', entry: 'tools' },
  { id: 'computer.systemPermissions', tab: 'computer-use', control: 'ComputerPermissionRow', kind: 'authorization', entry: 'computer' },
  { id: 'computer.driverInstall', tab: 'computer-use', control: 'ComputerUseSection', kind: 'action', entry: 'computer' },
  { id: 'storage.worktrees', tab: 'storage', control: 'WorktreeRecycleCard', kind: 'action', entry: 'storage' },
  { id: 'storage.cleanup', tab: 'storage', control: 'StorageManagementCard', kind: 'action', entry: 'storage' },
  { id: 'storage.backup', tab: 'storage', control: 'StorageManagementCard', kind: 'action', entry: 'storage' },
  { id: 'help.support', tab: 'help', control: 'HelpSection', kind: 'external', entry: 'help' },
  { id: 'about.update', tab: 'about', control: 'AboutSection', kind: 'action', entry: 'about' },
  { id: 'about.logUpload', tab: 'about', control: 'AboutSection', kind: 'action', entry: 'about' },
  { id: 'general.piExtensions', tab: 'general', control: 'PiPackagesSection', kind: 'resource', entry: 'piExtensions' },
] as const;
