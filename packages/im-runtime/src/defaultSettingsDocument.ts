import {
  IM_DEFAULT_SETTINGS,
  IM_DEFAULT_SETTINGS_CHANNELS,
  type ImDefaultAgentKind,
  type ImDefaultAgentSettings,
  type ImDefaultPermissionMode,
  type ImDefaultSettingsChannel,
  type ImDefaultSettingsPatch,
  type ImDefaultSettings,
  isImDefaultAgentKind,
  isImDefaultEffort,
  isImDefaultPermissionMode,
} from './imDefaultSettings';

const SETTINGS_SCHEMA_VERSION = 3;

export interface ImDefaultSettingsDocument {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  global: ImDefaultSettings;
  channels: Record<ImDefaultSettingsChannel, ImDefaultSettings>;
}

export const IM_DEFAULT_SETTINGS_DOCUMENT: ImDefaultSettingsDocument = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  global: cloneSettings(IM_DEFAULT_SETTINGS),
  channels: Object.fromEntries(
    IM_DEFAULT_SETTINGS_CHANNELS.map((channel) => [channel, cloneSettings(IM_DEFAULT_SETTINGS)]),
  ) as Record<ImDefaultSettingsChannel, ImDefaultSettings>,
};

export function normalizeSettings(raw: unknown): ImDefaultSettings {
  if (!raw || typeof raw !== 'object') return { ...IM_DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const agentKind = isImDefaultAgentKind(r.agentKind) ? r.agentKind : IM_DEFAULT_SETTINGS.agentKind;
  const rawAgents = isRecord(r.agents) ? r.agents : {};
  const legacySettings = legacyAgentSettings(r);
  return {
    agentKind,
    permissionMode: isImDefaultPermissionMode(r.permissionMode)
      ? r.permissionMode
      : IM_DEFAULT_SETTINGS.permissionMode,
    // 旧键 `groupCtrPermissionMode` 只在「群 /ctr」时期存在过, 读侧回落一次 ——
    // 已经存过该键的用户升级后必须保持原选择, 不能静默回默认(存量兼容)。
    groupPermissionMode: readGroupPermissionMode(r),
    agents: {
      'claude-code': normalizeAgentSettings(
        'claude-code',
        rawAgentOrLegacy(rawAgents, 'claude-code', agentKind, legacySettings),
      ),
      codex: normalizeAgentSettings(
        'codex',
        rawAgentOrLegacy(rawAgents, 'codex', agentKind, legacySettings),
      ),
      // 键序必须与 IM_DEFAULT_SETTINGS.agents 一致:legacy 检测(信号 4)靠
      // JSON.stringify 与系统默认整体比对,键序漂移会让检测失灵。
      pi: normalizeAgentSettings(
        'pi',
        rawAgentOrLegacy(rawAgents, 'pi', agentKind, legacySettings),
      ),
    },
  };
}

/**
 * 群聊新建会话权限档的读取:新键优先, 回落旧键 `groupCtrPermissionMode`。
 *
 * 该设置最初叫「群聊 /ctr 新建任务权限档」, 作用域扩到「群里新建的所有会话」后
 * 键名改成 `groupPermissionMode`。写侧只写新键, 但已经存了旧键的配置文件必须继续
 * 生效 —— 用户升级后什么都不做, 原来选的档位照旧。
 */
function readGroupPermissionMode(r: Record<string, unknown>): ImDefaultPermissionMode {
  if (isImDefaultPermissionMode(r.groupPermissionMode)) return r.groupPermissionMode;
  if (isImDefaultPermissionMode(r.groupCtrPermissionMode)) return r.groupCtrPermissionMode;
  return IM_DEFAULT_SETTINGS.groupPermissionMode;
}

function normalizeChannelSettings(raw: unknown): ImDefaultSettings {
  return normalizeSettings(raw);
}

export function normalizeDocument(raw: unknown): ImDefaultSettingsDocument {
  const record = isRecord(raw) ? raw : {};

  // Detect legacy v1 overrides even after createOverrideSettingsFile merges
  // them with v2 defaults (which injects schemaVersion/global/channels).
  //
  // Signals that root-level fields came from a v1 persisted file:
  //   1. providerId/model/effort at root — v2 never writes these at root.
  //   2. Root agentKind disagrees with global.agentKind — in v2 backward-compat
  //      the root mirror always matches global; a v1 override diverges.
  //   3. Root agentKind/agents present without any global — pure v1 input.
  //   4. Root agents present without root agentKind, and global.agents equals
  //      system defaults — a v1 agents-only override (user changed model/provider
  //      without switching agent) merged over v2 defaults. In a real v2 file the
  //      global.agents would reflect the user's customization, not defaults.
  const hasLegacyScalarOverrides =
    'providerId' in record || 'model' in record || 'effort' in record;
  const globalRecord = isRecord(record.global) ? record.global : null;
  const normalizedGlobal = globalRecord ? normalizeSettings(globalRecord) : null;
  // In v2, the root agentKind mirror always equals normalizedGlobal.agentKind.
  // A divergence means a v1 override's agentKind sits at root while global
  // retains the defaults value. Normalize global before comparing so a partial
  // v2 global (with agents but no agentKind) falls back to the default agentKind
  // and doesn't spuriously diverge.
  const rootAgentKindDiverges =
    'agentKind' in record && normalizedGlobal !== null &&
    record.agentKind !== normalizedGlobal.agentKind;
  const rootAgentsOnlyWithDefaultGlobal =
    'agents' in record && isRecord(record.agents) &&
    !('agentKind' in record) && normalizedGlobal !== null &&
    JSON.stringify(normalizedGlobal.agents) ===
      JSON.stringify(IM_DEFAULT_SETTINGS.agents);
  const hasLegacyAgentFields =
    ('agentKind' in record || 'agents' in record) &&
    (globalRecord === null || rootAgentKindDiverges || rootAgentsOnlyWithDefaultGlobal);
  const hasLegacyRootSettings = hasLegacyScalarOverrides || hasLegacyAgentFields;

  // Before schema v2 there was one flat route shared by every IM channel.
  // A legacy file is unambiguous user customization, so seed every channel
  // from it once. The next write serializes a v2 document and ends inheritance.
  if (hasLegacyRootSettings) {
    const legacy = normalizeSettings(record);
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      global: cloneSettings(legacy),
      channels: Object.fromEntries(
        IM_DEFAULT_SETTINGS_CHANNELS.map((channel) => [
          channel,
          normalizeChannelSettings(legacy),
        ]),
      ) as Record<ImDefaultSettingsChannel, ImDefaultSettings>,
    };
  }

  const rawChannels = isRecord(record.channels) ? record.channels : {};
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    global: normalizeSettings(record.global),
    channels: Object.fromEntries(
      IM_DEFAULT_SETTINGS_CHANNELS.map((channel) => [
        channel,
        normalizeChannelSettings(rawChannels[channel]),
      ]),
    ) as Record<ImDefaultSettingsChannel, ImDefaultSettings>,
  };
}

function rawAgentOrLegacy(
  rawAgents: Record<string, unknown>,
  target: ImDefaultAgentKind,
  selected: ImDefaultAgentKind,
  legacySettings: Partial<ImDefaultAgentSettings> | null,
): unknown {
  const raw = rawAgents[target];
  if (target !== selected || !legacySettings) return raw ?? null;
  if (!isRecord(raw)) return legacySettings;
  return agentSettingsMatchesDefaults(target, raw) ? legacySettings : raw;
}

function agentSettingsMatchesDefaults(
  agentKind: ImDefaultAgentKind,
  raw: Record<string, unknown>,
): boolean {
  const normalized = normalizeAgentSettings(agentKind, raw);
  return JSON.stringify(normalized) === JSON.stringify(IM_DEFAULT_SETTINGS.agents[agentKind]);
}

function normalizeAgentSettings(
  agentKind: ImDefaultAgentKind,
  raw: unknown,
): ImDefaultAgentSettings {
  const defaults = IM_DEFAULT_SETTINGS.agents[agentKind];
  if (!isRecord(raw)) return { ...defaults };
  return {
    ...(typeof raw.agentDeviceId === 'string' && raw.agentDeviceId.trim()
      ? { agentDeviceId: raw.agentDeviceId.trim() } : {}),
    providerId:
      typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : defaults.model,
    effort: isImDefaultEffort(raw.effort) ? raw.effort : defaults.effort,
  };
}

function legacyAgentSettings(raw: Record<string, unknown>): Partial<ImDefaultAgentSettings> | null {
  if (!('providerId' in raw) && !('model' in raw) && !('effort' in raw)) return null;
  return {
    providerId:
      typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    effort: isImDefaultEffort(raw.effort) ? raw.effort : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function mergeSettingsPatch(
  current: ImDefaultSettings,
  patch: ImDefaultSettingsPatch,
): ImDefaultSettings {
  return normalizeSettings({
    ...current,
    ...patch,
    agents: patch.agents ? { ...current.agents, ...patch.agents } : current.agents,
  });
}

export function documentOverrides(
  next: ImDefaultSettingsDocument,
  defaults: ImDefaultSettingsDocument,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const global = settingsOverrides(next.global, defaults.global);
  if (Object.keys(global).length > 0) overrides.global = global;

  const channels: Partial<Record<ImDefaultSettingsChannel, Record<string, unknown>>> = {};
  for (const channel of IM_DEFAULT_SETTINGS_CHANNELS) {
    const channelOverrides = settingsOverrides(next.channels[channel], defaults.channels[channel]);
    if (Object.keys(channelOverrides).length > 0) channels[channel] = channelOverrides;
  }
  if (Object.keys(channels).length > 0) overrides.channels = channels;

  if (Object.keys(overrides).length === 0) return overrides;

  // Write schemaVersion only when there are actual overrides, so that the
  // "empty overrides → reset()" cleanup path in createOverrideSettingsFile works.
  overrides.schemaVersion = SETTINGS_SCHEMA_VERSION;

  // Preserve flat legacy fields so that an older app version (pre-v2) reading
  // this file still picks up the global route instead of falling back to
  // system defaults.
  overrides.agentKind = next.global.agentKind;
  overrides.agents = next.global.agents;

  return overrides;
}

function settingsOverrides(
  value: ImDefaultSettings,
  defaults: ImDefaultSettings,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (value.agentKind !== defaults.agentKind) overrides.agentKind = value.agentKind;
  if (value.permissionMode !== defaults.permissionMode) {
    overrides.permissionMode = value.permissionMode;
  }
  if (value.groupPermissionMode !== defaults.groupPermissionMode) {
    overrides.groupPermissionMode = value.groupPermissionMode;
  }
  const agents: Partial<Record<ImDefaultAgentKind, ImDefaultAgentSettings>> = {};
  for (const agentKind of ['claude-code', 'codex', 'pi'] as const) {
    if (!agentSettingsEqual(value.agents[agentKind], defaults.agents[agentKind])) {
      agents[agentKind] = value.agents[agentKind];
    }
  }
  if (Object.keys(agents).length > 0) overrides.agents = agents;
  return overrides;
}

export function settingsCustomizedKeys(value: ImDefaultSettings, defaults: ImDefaultSettings): string[] {
  const keys: string[] = [];
  if (value.agentKind !== defaults.agentKind) keys.push('agentKind');
  if (value.permissionMode !== defaults.permissionMode) keys.push('permissionMode');
  if (value.groupPermissionMode !== defaults.groupPermissionMode) {
    keys.push('groupPermissionMode');
  }
  for (const agentKind of ['claude-code', 'codex', 'pi'] as const) {
    if (!agentSettingsEqual(value.agents[agentKind], defaults.agents[agentKind])) {
      keys.push(`agents.${agentKind}`);
    }
  }
  return keys;
}

function agentSettingsEqual(a: ImDefaultAgentSettings, b: ImDefaultAgentSettings): boolean {
  return (a.agentDeviceId ?? null) === (b.agentDeviceId ?? null)
    && a.providerId === b.providerId && a.model === b.model && a.effort === b.effort;
}

export function cloneSettings(settings: ImDefaultSettings): ImDefaultSettings {
  return {
    agentKind: settings.agentKind,
    permissionMode: settings.permissionMode,
    groupPermissionMode: settings.groupPermissionMode,
    agents: {
      'claude-code': { ...settings.agents['claude-code'] },
      codex: { ...settings.agents.codex },
      pi: { ...settings.agents.pi },
    },
  };
}
