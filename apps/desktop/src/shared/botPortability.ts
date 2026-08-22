/** Cindy Bot 可分发行为配置包。
 *
 * 这不是运行态备份：不包含凭证、IM 账号绑定、Session/消息历史、Memory、
 * worktree/项目绝对路径、Route 所有权或 Scheduler 运行记录。导入后所有外部
 * Channel 与 Automation 都保持禁用，必须由用户在本机重新绑定并确认。
 */

export const CINDY_BOT_BUNDLE_FORMAT = 'cindy-bot-profile' as const;
export const CINDY_BOT_BUNDLE_VERSION = 1 as const;
export const CINDY_BOT_BUNDLE_EXTENSION = '.cindybot' as const;

export const BOT_BUNDLE_MAX_FILES = 256;
export const BOT_BUNDLE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const BOT_BUNDLE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export type PortableBotChannelKind =
  | 'local'
  | 'telegram'
  | 'feishu'
  | 'slack'
  | 'discord'
  | 'wechat'
  | 'dingtalk'
  | 'wecom'
  | 'x';

export interface PortableBotChannelRequirement {
  kind: PortableBotChannelKind;
  /** local 可直接启用；外部 Channel 导入后一律 false。 */
  enabled: boolean;
}

export interface PortableBotAutomationDefinition {
  name: string;
  prompt: string;
  executionMode: 'agent' | 'script';
  /** 脱敏后的脚本定义；导入后仍保持 paused。 */
  scriptConfig?: string;
  cronExpr: string;
  timezone: string;
  recurring: boolean;
  manual: boolean;
  intervalMs?: number;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model?: string;
  providerId?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  fastMode: boolean;
  persistentSession: boolean;
  silentWhenIdle: boolean;
  notifyDesktop: boolean;
  /** 外部通知目标不随包迁移，导入后一律 false。 */
  notifyFeishu: false;
  notifyWecomGroup: false;
  executionPolicy: Record<string, unknown>;
  /** 导入后一律 paused，不能因包来源自动执行。 */
  enabled: false;
}

export interface CindyBotBundleManifest {
  format: typeof CINDY_BOT_BUNDLE_FORMAT;
  version: typeof CINDY_BOT_BUNDLE_VERSION;
  exportedAt: string;
  bot: {
    name: string;
    description: string;
    avatar: string;
    avatarColor: string;
  };
  profile: {
    /** 相对包根目录的文本文件路径。 */
    soul: 'SOUL.md';
    user: 'USER.md';
    capabilities: Record<string, unknown>;
  };
  channels: PortableBotChannelRequirement[];
  automations: PortableBotAutomationDefinition[];
  exclusions: readonly [
    'credentials',
    'channel-bindings',
    'sessions',
    'history',
    'memory',
    'worktrees',
    'local-paths',
    'runtime-state',
  ];
}

export interface BotBundleExportResult {
  canceled: boolean;
  filePath?: string;
  redactionCount?: number;
  warnings?: string[];
}

export interface BotBundleImportResult {
  canceled: boolean;
  botId?: string;
  botName?: string;
  disabledChannels?: PortableBotChannelKind[];
  pausedAutomations?: number;
  warnings?: string[];
}

export function isCindyBotBundleManifest(value: unknown): value is CindyBotBundleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CindyBotBundleManifest>;
  if (
    candidate.format !== CINDY_BOT_BUNDLE_FORMAT ||
    candidate.version !== CINDY_BOT_BUNDLE_VERSION ||
    typeof candidate.exportedAt !== 'string' ||
    !candidate.bot ||
    !candidate.profile ||
    !Array.isArray(candidate.channels) ||
    !Array.isArray(candidate.automations)
  ) {
    return false;
  }
  const validChannels = candidate.channels.every(
    (channel) =>
      !!channel &&
      typeof channel === 'object' &&
      typeof channel.kind === 'string' &&
      ['local', 'telegram', 'feishu', 'slack', 'discord', 'wechat', 'dingtalk', 'wecom', 'x'].includes(
        channel.kind,
      ) &&
      typeof channel.enabled === 'boolean',
  );
  const validAutomations = candidate.automations.every(
    (automation) =>
      !!automation &&
      typeof automation === 'object' &&
      typeof automation.name === 'string' &&
      typeof automation.prompt === 'string' &&
      (automation.executionMode === 'agent' || automation.executionMode === 'script') &&
      typeof automation.cronExpr === 'string' &&
      typeof automation.timezone === 'string' &&
      automation.enabled === false,
  );
  return (
    typeof candidate.bot.name === 'string' &&
    typeof candidate.bot.description === 'string' &&
    typeof candidate.bot.avatar === 'string' &&
    typeof candidate.bot.avatarColor === 'string' &&
    candidate.profile.soul === 'SOUL.md' &&
    candidate.profile.user === 'USER.md' &&
    !!candidate.profile.capabilities &&
    typeof candidate.profile.capabilities === 'object' &&
    !Array.isArray(candidate.profile.capabilities) &&
    validChannels &&
    validAutomations
  );
}
