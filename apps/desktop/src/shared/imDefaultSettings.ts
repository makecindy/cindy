export type ImDefaultAgentKind = 'claude-code' | 'codex';
export type ImDefaultEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/** IM channel scopes that keep independent new-conversation routing preferences. */
export type ImDefaultSettingsChannel = 'feishu' | 'slack' | 'discord';

export interface ImDefaultAgentSettings {
  providerId: string | null;
  model: string;
  effort: ImDefaultEffort;
}

export type ImDefaultAgentSettingsMap = Record<ImDefaultAgentKind, ImDefaultAgentSettings>;

export interface ImDefaultSettings {
  agentKind: ImDefaultAgentKind;
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

export function isImDefaultAgentKind(value: unknown): value is ImDefaultAgentKind {
  return typeof value === 'string' && AGENT_KINDS.has(value as ImDefaultAgentKind);
}

export function isImDefaultEffort(value: unknown): value is ImDefaultEffort {
  return typeof value === 'string' && EFFORTS.has(value as ImDefaultEffort);
}

export function isImDefaultSettingsChannel(value: unknown): value is ImDefaultSettingsChannel {
  return (
    typeof value === 'string' &&
    IM_DEFAULT_SETTINGS_CHANNELS.includes(value as ImDefaultSettingsChannel)
  );
}
