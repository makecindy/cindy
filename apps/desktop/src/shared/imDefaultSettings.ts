export type ImDefaultAgentKind = 'claude-code' | 'codex' | 'pi';
export type ImDefaultPermissionMode =
  'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export type ImDefaultEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/**
 * IM channel scopes that keep independent new-conversation routing preferences.
 * 'telegram' 指个人 Telegram bot(main/im/telegram);官方 Telegram hook 通道
 * 刻意读 global(channel=undefined, 见 hook-control/session-runner.ts), 不落
 * 在这个键上 — 两者互不影响。
 */
export type ImDefaultSettingsChannel =
  'feishu' | 'slack' | 'discord' | 'wechat' | 'telegram' | 'dingtalk' | 'wecom';

export interface ImDefaultAgentSettings {
  providerId: string | null;
  model: string;
  effort: ImDefaultEffort;
}

export type ImDefaultAgentSettingsMap = Record<ImDefaultAgentKind, ImDefaultAgentSettings>;

export interface ImDefaultSettings {
  agentKind: ImDefaultAgentKind;
  permissionMode: ImDefaultPermissionMode;
  /**
   * **群里新建会话**统一用的权限档(当前仅 feishu 消费) —— 群/话题里 @bot 开
   * 新话题、群里 `/new`、群里 `/ctr` 全部以它为准, 不再各自继承上面那条
   * `permissionMode`(那条只管私聊)。群 lane 判定在 feishu adapter 的
   * `sessions.permissionModeFor`, /ctr 建会话另有一处(cardActionHandler)。
   *
   * 群上下文含成员可控内容, 默认 'auto'(自动审批)保留操作确认; 用户可在渠道
   * 设置里改成 'bypassPermissions'(完全访问) → 群护栏取缔, 直接执行。选到
   * 'acceptEdits' 等与强确认策略互斥的档位时群轮次会被拒绝, 由错误路径的私聊
   * 引导卡兜底切回。
   *
   * **不看「用户有没有手动改过」**: 默认值本身就是群里的判据(产品裁决 —— 群里
   * 的事只看这一行), 私聊那条设成完全访问不会顺带放开群。
   */
  groupPermissionMode: ImDefaultPermissionMode;
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
  groupPermissionMode: 'auto',
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
    // Pi 走网关中档模型作为 IM 新会话默认值，可在各渠道设置中覆盖。
    pi: {
      providerId: null,
      model: 'claude-sonnet-5',
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
  'dingtalk',
  'wecom',
];

export const IM_DEFAULT_EFFORT_OVERRIDES: Readonly<Partial<Record<string, ImDefaultEffort>>> = {
  'claude-opus-4-8': 'xhigh',
  'codex/gpt-5.5': 'high',
};

const AGENT_KINDS = new Set<ImDefaultAgentKind>(['claude-code', 'codex', 'pi']);
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

/**
 * 渠道对**任何消息**都挂 turnPermissionPolicy 的清单(与 main 侧 adapter 的
 * turnPermissionPolicy / turnPermissionPolicyFor 事实对齐):这些渠道把
 * 工具确认渲染成渠道文本提示,要求所选 Agent 声明 turnPermissionPolicy
 * capability。Pi 未声明该 capability,在这些渠道的任何权限模式下都不可用
 * (fail-closed);Claude Code / Codex 声明了,仅在个别权限模式不可用。
 *
 * 目前只有个人微信(WechatIM.turnPermissionPolicy)对每次 dispatch
 * 无条件挂 policy;Telegram / 钉钉的 turnPermissionPolicyFor 仅在群聊
 * (event.speaker 存在)时挂载,主人私聊不挂 → Pi 在私聊可用,设置 UI 不区分
 * 群聊/私聊,不能整体警告。新增渠道时先确认其 policy 挂载是否无条件。
 */
export const UNCONDITIONAL_TURN_POLICY_CHANNELS: readonly ImDefaultSettingsChannel[] = [
  'wechat',
];

export function isUnconditionalTurnPolicyChannel(
  channel: ImDefaultSettingsChannel,
): boolean {
  return UNCONDITIONAL_TURN_POLICY_CHANNELS.includes(channel);
}

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
