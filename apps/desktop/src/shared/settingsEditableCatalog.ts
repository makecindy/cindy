import { z } from 'zod';
import { SETTINGS_DISPLAY_LOCALES, SETTINGS_READ_SHORTCUT_IDS, SETTINGS_READ_KEY_CODES } from './settingsReadCatalog.js';

/** Display languages every Host accepts. A cloud page offers only these unless the Host lists more. */
export const CLOUD_SETTINGS_LOCALES = SETTINGS_DISPLAY_LOCALES.slice(0, 6);

/** Fixed, reviewed settings only. This is not an arbitrary file or IPC interface. */
const bool = z.boolean();
const int = (min: number, max: number) => z.number().int().min(min).max(max);
// eslint-disable-next-line no-control-regex
const routeId = z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/u);
const backend = z.strictObject({ providerId: routeId, modelId: routeId });
export type SettingsEditableValue = string | number | boolean | null | SettingsEditableValue[] | { [key: string]: SettingsEditableValue };
export function settingsValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key)
    && settingsValuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
const scalar = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);
const structured = z.record(z.string().max(64), scalar).refine(value => Object.keys(value).length <= 8);
export const settingsEditableValueSchema: z.ZodType<SettingsEditableValue> = z.union([
  scalar, structured, z.array(z.union([scalar, structured])).max(256),
]);
export const IM_SETTINGS_DOMAINS = ['imGlobal', 'imFeishu', 'imSlack', 'imDiscord', 'imWechat', 'imTelegram', 'imDingtalk', 'imWecom'] as const;
export type ImSettingsDomain = typeof IM_SETTINGS_DOMAINS[number];
export function isImSettingsDomain(domain: string): domain is ImSettingsDomain { return IM_SETTINGS_DOMAINS.includes(domain as ImSettingsDomain); }
const permission = z.enum(['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const imRoute = backend.extend({ modelId: z.union([z.literal(''), routeId]), providerId: routeId.nullable(), effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) }).refine(route => route.modelId !== '' || route.providerId === null, 'automatic routes have no fixed provider');
const imSettings = z.strictObject({ agentKind: z.enum(['claude-code', 'codex', 'pi']), permissionMode: permission, claudeCode: imRoute, codex: imRoute, pi: imRoute, modelGroup: routeId.nullable().optional() });
export const MODEL_PREFERENCE_DOMAINS = ['modelVisibility', 'modelEngines', 'modelFavorites', 'modelContext', 'modelAccess', 'providerNames', 'modelPrices'] as const;
export type ModelPreferenceDomain = typeof MODEL_PREFERENCE_DOMAINS[number];
export function isModelPreferenceDomain(domain: string): domain is ModelPreferenceDomain { return MODEL_PREFERENCE_DOMAINS.includes(domain as ModelPreferenceDomain); }
const modelTarget = backend.extend({ harness: z.enum(['claude-code', 'codex', 'pi']) });
export const PLUGIN_CINDY_FIELDS = { imageGenerate: 'image.generate', imageEdit: 'image.edit', videoGenerate: 'video.generate', videoEdit: 'video.edit', textOneshot: 'text.oneshot', embedText: 'embed.text' } as const;
const pluginPin = z.array(z.strictObject({ ghostId: routeId, model: z.string().min(1).max(768) })).max(128);
export const MODEL_SETTINGS_DOMAINS = ['subagentModel', 'auxiliaryModel', 'visionBridge', 'botModelChain', ...IM_SETTINGS_DOMAINS, ...MODEL_PREFERENCE_DOMAINS] as const;
export type ModelSettingsDomain = typeof MODEL_SETTINGS_DOMAINS[number];
export function isModelSettingsDomain(domain: string): domain is ModelSettingsDomain {
  return MODEL_SETTINGS_DOMAINS.includes(domain as ModelSettingsDomain);
}
export const additionalSettingsSchemas = {
  imWorkspaceProviders: z.strictObject({ entries: z.array(z.strictObject({ workspaceId: routeId, providerId: routeId.max(128) })).max(256) }),
  workspaceTools: z.strictObject({ browser: bool, feishu_bot: bool, wechat: bool, slack: bool, ssh: bool, docs: bool, collab: bool }),
  imWorkspaces: z.strictObject({ entries: z.array(z.strictObject({ workspaceId: routeId, harness: z.enum(['claude-code', 'codex', 'pi']).nullable(), modelId: routeId.max(128).nullable(), effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(), permissionMode: permission.nullable() })).max(256) }),
  wecomNotifications: z.strictObject({ enabled: bool }),
  officialHooks: z.strictObject({ lifecycleAnnouncement: bool, telegramDefaultWorkspace: routeId.nullable(), xDefaultWorkspace: routeId.nullable() }),
  telegramGroups: z.strictObject({ always: z.array(z.string().regex(/^-?\d+$/).max(64)).max(256) }),
  pluginErrand: z.strictObject({ routes: z.array(z.strictObject({ ghostId: routeId, harness: z.enum(['claude-code', 'codex', 'pi']).nullable(), providerId: routeId.max(128).nullable(), modelId: routeId.max(128).nullable(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(), fastMode: bool.nullable() })).max(128), permissions: z.array(z.strictObject({ ghostId: routeId, permissionMode: z.enum(['plan', 'acceptEdits', 'auto']) })).max(128), workspaces: z.array(z.strictObject({ ghostId: routeId, workspaceId: routeId })).max(128) }),
  pluginCindy: z.strictObject({ imageGenerate: pluginPin, imageEdit: pluginPin, videoGenerate: pluginPin, videoEdit: pluginPin, textOneshot: pluginPin, embedText: pluginPin, inflightLimits: z.array(z.strictObject({ ghostId: routeId, limit: int(1, Number.MAX_SAFE_INTEGER) })).max(128) }),
  pluginSidebar: z.strictObject({ hidden: z.array(routeId).max(128) }),
  ...Object.fromEntries(IM_SETTINGS_DOMAINS.map(domain => [domain, imSettings])) as Record<ImSettingsDomain, typeof imSettings>,
  imFeishu: imSettings.extend({ groupPermissionMode: permission }).strict(),
  modelVisibility: z.strictObject({ entries: z.array(modelTarget.extend({ enabled: bool }).strict()).max(256) }),
  modelEngines: z.strictObject({ entries: z.array(modelTarget.strict()).max(256) }),
  modelFavorites: z.strictObject({ entries: z.array(modelTarget.extend({ effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(), fast: bool }).strict()).max(256) }),
  modelContext: z.strictObject({ entries: z.array(modelTarget.extend({ limit: int(1000, 100_000_000) }).strict()).max(256) }),
  modelAccess: z.strictObject({ models: z.array(backend.strict()).max(256), providers: z.array(routeId).max(256) }),
  providerNames: z.strictObject({ entries: z.array(z.strictObject({ providerId: routeId, name: z.string().trim().min(1).max(128) })).max(256) }),
  modelPrices: z.strictObject({ entries: z.array(modelTarget.extend({ currency: z.enum(['USD', 'CNY']), inputPerMtok: z.number().finite().min(0), outputPerMtok: z.number().finite().min(0), cacheReadPerMtok: z.number().finite().min(0).nullable(), cacheCreatePerMtok: z.number().finite().min(0).nullable() }).strict()).max(256) }),
  collaboration: z.strictObject({ workerSoftLimit: int(1, 20), workerHardLimit: int(1, 20), workerIdleReleaseMinutes: int(0, 120) }),
  agentResource: z.strictObject({ maxConcurrentCommands: int(0, 64), processPriority: z.enum(['normal', 'low', 'lowest']), capToolchainThreads: bool }),
  gitSafety: z.strictObject({ autoSnapshotEnabled: bool }),
  memory: z.strictObject({ maker: bool, claudeCode: bool, codex: bool, pi: bool }),
  claudeCompaction: z.strictObject({ claudeCodeAutoCompactPct: int(50, 95) }),
  piCompaction: z.strictObject({ piAutoCompactPct: int(50, 95) }),
  contacts: z.strictObject({ enabled: bool }),
  shortcuts: z.strictObject({ entries: z.array(z.strictObject({ id: z.enum(SETTINGS_READ_SHORTCUT_IDS), code: z.enum(SETTINGS_READ_KEY_CODES).nullable(), meta: bool, ctrl: bool, alt: bool, shift: bool })).max(27) }),
  contactsSync: z.strictObject({ deviceSyncEnabled: bool }),
  browserBackend: z.strictObject({ kind: z.enum(['external', 'rsb-webview']) }),
  computerTools: z.strictObject({ computer: bool }),
  androidTools: z.strictObject({ android: bool }),
  telegramPersona: z.strictObject({ botName: z.string().trim().max(64), soul: z.string().max(4000) }),
  chatEmbedding: z.strictObject({ enabled: bool }),
  silentEncryptedRetry: z.strictObject({ enabled: bool }),
  lsp: z.strictObject({ enabled: bool }),
  privacy: z.strictObject({ analyticsEnabled: bool }),
  diagnostics: z.strictObject({ crashAutoUploadEnabled: bool }),
  desktopGeneral: z.strictObject({ themeFamilyId: routeId, theme: z.enum(['system', 'light', 'dark']), locale: z.enum(SETTINGS_DISPLAY_LOCALES), sidebarPinnedMode: z.enum(['text', 'card', 'list']), sidebarMainMode: z.enum(['text', 'list']), ghostPanelRestoreMode: z.enum(['bubble', 'sidebar']) }),
  desktopChat: z.strictObject({ composerSendShortcut: z.enum(['enter', 'modifier-enter']), webLinkOpenPreference: z.enum(['external', 'sidebar']), localLinkOpenPreference: z.enum(['external', 'sidebar']), streamFadePreference: z.enum(['on', 'off']), promptRecommendationEnabled: bool, messageNavRailEnabled: bool }),
  desktopNotifications: z.strictObject({ notificationsEnabled: bool, feishuNotificationsEnabled: bool, swallowActivationClick: bool, networkDebugEnabled: bool }),
  linuxWindow: z.strictObject({ linuxCloseBehavior: z.enum(['quit', 'minimize']).nullable() }),
  telegramBehavior: z.strictObject({ emojiReactions: z.enum(['off', 'minimal', 'expressive']), replyQuoteGroup: z.enum(['off', 'first', 'all']), replyQuoteDm: z.enum(['off', 'first']) }),
  terminal: z.strictObject({ defaultShellPref: z.enum(['auto', 'zsh', 'bash', 'fish', 'sh', 'pwsh', 'powershell', 'cmd', 'gitbash', 'wsl']) }),
  builtinTools: z.strictObject({ feishu_bot: bool, wechat: bool, slack: bool, ssh: bool, docs: bool, collab: bool }),
  browserTools: z.strictObject({ browser: bool }),
  subagentModel: z.strictObject({ claudeCode: backend.extend({ providerId: routeId.nullable() }).nullable(), codexSmartSubagentRouting: bool }),
  auxiliaryModel: z.strictObject({ models: z.array(z.string().min(1).max(768)).max(3) }),
  visionBridge: z.strictObject({ enabled: bool, primary: backend.nullable(), fallback: backend.nullable(), targetModels: z.array(routeId).max(256) }),
  botModelChain: z.strictObject({ modelChain: z.array(z.strictObject({ harness: z.enum(['claude', 'codex', 'pi']), providerId: routeId.nullable(), model: routeId, effort: z.enum(['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']), fastMode: bool })).max(5) }),
} as const;
export type AdditionalSettingsDomain = keyof typeof additionalSettingsSchemas;
/** Smart Contacts live in the cindy-contacts plugin; these domains stay in the wire catalog only. */
export const RETIRED_ADDITIONAL_SETTINGS_DOMAINS = ['contacts', 'contactsSync'] as const satisfies readonly AdditionalSettingsDomain[];
export const ADDITIONAL_SETTINGS_DOMAINS = Object.keys(additionalSettingsSchemas) as AdditionalSettingsDomain[];
export const isAdditionalSettingsDomain = (value: unknown): value is AdditionalSettingsDomain =>
  typeof value === 'string' && Object.hasOwn(additionalSettingsSchemas, value);
/** A domain's schema typed only as an object schema, for code that handles any domain alike. */
export function additionalSettingsSchema(domain: AdditionalSettingsDomain): z.ZodObject {
  return additionalSettingsSchemas[domain];
}

export const additionalSettingsMetadata: Record<AdditionalSettingsDomain, {
  tab: 'general' | 'personalization' | 'providers' | 'im-bot' | 'builtin-tools' | 'computer-use' | 'about' | 'shortcuts' | 'ghosts';
  scope: 'owner' | 'profile' | 'workspace';
  applies: 'next_task' | 'next_agent_start' | 'host_desktop_only' | 'immediate' | 'next_connection';
}> = {
  imWorkspaceProviders: { tab: 'im-bot', scope: 'owner', applies: 'next_task' },
  workspaceTools: { tab: 'builtin-tools', scope: 'workspace', applies: 'next_task' },
  imWorkspaces: { tab: 'im-bot', scope: 'owner', applies: 'next_task' },
  wecomNotifications: { tab: 'im-bot', scope: 'owner', applies: 'immediate' },
  officialHooks: { tab: 'im-bot', scope: 'owner', applies: 'immediate' },
  telegramGroups: { tab: 'im-bot', scope: 'owner', applies: 'immediate' },
  pluginCindy: { tab: 'ghosts', scope: 'owner', applies: 'next_task' },
  pluginErrand: { tab: 'ghosts', scope: 'owner', applies: 'next_task' },
  pluginSidebar: { tab: 'ghosts', scope: 'owner', applies: 'host_desktop_only' },
  ...Object.fromEntries(IM_SETTINGS_DOMAINS.map(domain => [domain, { tab: 'im-bot', scope: 'owner', applies: 'next_task' }])) as Record<ImSettingsDomain, { tab: 'im-bot'; scope: 'owner'; applies: 'next_task' }>,
  ...Object.fromEntries(MODEL_PREFERENCE_DOMAINS.map(domain => [domain, { tab: 'providers', scope: 'owner', applies: 'next_task' }])) as Record<ModelPreferenceDomain, { tab: 'providers'; scope: 'owner'; applies: 'next_task' }>,
  collaboration: { tab: 'general', scope: 'profile', applies: 'next_task' },
  agentResource: { tab: 'general', scope: 'profile', applies: 'next_agent_start' },
  gitSafety: { tab: 'general', scope: 'profile', applies: 'next_task' },
  memory: { tab: 'personalization', scope: 'owner', applies: 'next_agent_start' },
  claudeCompaction: { tab: 'personalization', scope: 'owner', applies: 'next_agent_start' },
  piCompaction: { tab: 'personalization', scope: 'owner', applies: 'next_agent_start' },
  contacts: { tab: 'personalization', scope: 'owner', applies: 'immediate' },
  shortcuts: { tab: 'shortcuts', scope: 'profile', applies: 'host_desktop_only' },
  contactsSync: { tab: 'personalization', scope: 'owner', applies: 'immediate' },
  browserBackend: { tab: 'computer-use', scope: 'profile', applies: 'next_connection' },
  computerTools: { tab: 'computer-use', scope: 'owner', applies: 'next_agent_start' },
  androidTools: { tab: 'computer-use', scope: 'owner', applies: 'next_task' },
  telegramPersona: { tab: 'im-bot', scope: 'owner', applies: 'next_task' },
  chatEmbedding: { tab: 'personalization', scope: 'owner', applies: 'immediate' },
  silentEncryptedRetry: { tab: 'personalization', scope: 'profile', applies: 'next_task' },
  lsp: { tab: 'builtin-tools', scope: 'profile', applies: 'next_agent_start' },
  privacy: { tab: 'about', scope: 'profile', applies: 'host_desktop_only' },
  diagnostics: { tab: 'about', scope: 'profile', applies: 'immediate' },
  desktopGeneral: { tab: 'general', scope: 'profile', applies: 'host_desktop_only' },
  desktopChat: { tab: 'personalization', scope: 'profile', applies: 'host_desktop_only' },
  desktopNotifications: { tab: 'general', scope: 'profile', applies: 'host_desktop_only' },
  linuxWindow: { tab: 'general', scope: 'profile', applies: 'host_desktop_only' },
  telegramBehavior: { tab: 'im-bot', scope: 'owner', applies: 'immediate' },
  terminal: { tab: 'personalization', scope: 'profile', applies: 'next_connection' },
  builtinTools: { tab: 'builtin-tools', scope: 'owner', applies: 'next_task' },
  browserTools: { tab: 'computer-use', scope: 'owner', applies: 'next_task' },
  subagentModel: { tab: 'personalization', scope: 'owner', applies: 'next_agent_start' },
  auxiliaryModel: { tab: 'personalization', scope: 'owner', applies: 'next_task' },
  visionBridge: { tab: 'personalization', scope: 'profile', applies: 'next_task' },
  botModelChain: { tab: 'general', scope: 'owner', applies: 'next_task' },
};

export function normalizeAdditionalSettingsChange(domain: AdditionalSettingsDomain, set: unknown, clear: unknown) {
  const schema = additionalSettingsSchema(domain);
  const values = schema.partial().parse(set ?? {});
  const keys = Object.keys(schema.shape);
  const cleared = z.array(z.string()).max(keys.length).parse(clear ?? []);
  if (cleared.some(key => !keys.includes(key) || Object.hasOwn(values, key)) || new Set(cleared).size !== cleared.length
    || !Object.keys(values).length && !cleared.length) throw new Error('INVALID_SETTINGS_CHANGE');
  for (const value of Object.values(values)) if (Array.isArray(value)) {
    const identities = value.map(item => typeof item === 'string' ? item : ['imWorkspaces', 'imWorkspaceProviders'].includes(domain) ? item.workspaceId : domain === 'shortcuts' ? item.id : domain.startsWith('plugin') ? item.ghostId
      : JSON.stringify([domain === 'modelEngines' ? '' : item.harness, item.providerId, item.model ?? item.modelId, ...(domain === 'modelFavorites' ? [item.effort, item.fast] : [])]));
    if (new Set(identities).size !== identities.length) throw new Error('INVALID_SETTINGS_CHANGE');
  }
  return { domain, set: values, clear: cleared.sort() };
}

/** Validate known persisted leaves without dropping unrelated or future keys. */
export function validateAdditionalSettingsOverrides(domain: AdditionalSettingsDomain, raw: Record<string, unknown>): void {
  const schema = additionalSettingsSchema(domain);
  schema.partial().parse(Object.fromEntries(Object.entries(raw).filter(([key]) => Object.hasOwn(schema.shape, key))));
  if (domain === 'privacy') for (const key of ['privacyConsentAccepted', 'legacyConsentMigrationClosed']) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') throw new Error('Invalid consent record');
  }
}
