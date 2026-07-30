export type ImDefaultAgentKind = 'claude-code' | 'codex';
export type ImDefaultPermissionMode =
  'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export type ImDefaultEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/**
 * IM channel scopes that keep independent new-conversation routing preferences.
 * 'telegram' 指个人 Telegram bot(main/im/telegram);官方 Telegram hook 通道
 * 刻意读 global(channel=undefined, 见 hook-control/session-runner.ts), 不落
 * 在这个键上 — 两者互不影响。
 */
export type ImDefaultSettingsChannel = 'feishu' | 'slack' | 'discord' | 'wechat' | 'telegram';

export interface ImDefaultAgentSettings {
  providerId: string | null;
  model: string;
  effort: ImDefaultEffort;
}

export type ImDefaultAgentSettingsMap = Record<ImDefaultAgentKind, ImDefaultAgentSettings>;

export interface ImDefaultSettings {
  agentKind: ImDefaultAgentKind;
  permissionMode: ImDefaultPermissionMode;
  agents: ImDefaultAgentSettingsMap;
}

export type ImDefaultSettingsPatch = Omit<Partial<ImDefaultSettings>, 'agents'> & {
  agents?: Partial<ImDefaultAgentSettingsMap>;
};

export interface ImDefaultSettingsState extends ImDefaultSettings {
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: ImDefaultSettings;
}

export const IM_DEFAULT_SETTINGS: ImDefaultSettings = {
  agentKind: 'claude-code',
  permissionMode: 'auto',
  agents: {
    'claude-code': {
      providerId: null,
      model: 'claude-opus-4-8',
      effort: 'xhigh',
    },
    codex: {
      providerId: null,
      model: 'codex/gpt-5.5',
      effort: 'high',
    },
  },
};

export const IM_DEFAULT_SETTINGS_CHANNELS: readonly ImDefaultSettingsChannel[] = [
  'feishu',
  'slack',
  'discord',
  'wechat',
  'telegram',
];

export const IM_DEFAULT_EFFORT_OVERRIDES: Readonly<Partial<Record<string, ImDefaultEffort>>> = {
  'claude-opus-4-8': 'xhigh',
  'codex/gpt-5.5': 'high',
};

const AGENT_KINDS = new Set<ImDefaultAgentKind>(['claude-code', 'codex']);
const EFFORTS = new Set<ImDefaultEffort>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const PERMISSION_MODES = new Set<ImDefaultPermissionMode>([
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

export const WECHAT_UNSUPPORTED_PERMISSION_MODES: readonly ImDefaultPermissionMode[] = [
  'acceptEdits',
  'bypassPermissions',
];

export function isImDefaultAgentKind(value: unknown): value is ImDefaultAgentKind {
  return typeof value === 'string' && AGENT_KINDS.has(value as ImDefaultAgentKind);
}

export function isImDefaultEffort(value: unknown): value is ImDefaultEffort {
  return typeof value === 'string' && EFFORTS.has(value as ImDefaultEffort);
}

export function isImDefaultPermissionMode(value: unknown): value is ImDefaultPermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as ImDefaultPermissionMode);
}

export function isWechatUnsupportedPermissionMode(
  value: unknown,
): value is ImDefaultPermissionMode {
  return isImDefaultPermissionMode(value) && WECHAT_UNSUPPORTED_PERMISSION_MODES.includes(value);
}

export function isImDefaultSettingsChannel(value: unknown): value is ImDefaultSettingsChannel {
  return (
    typeof value === 'string' &&
    IM_DEFAULT_SETTINGS_CHANNELS.includes(value as ImDefaultSettingsChannel)
  );
}
