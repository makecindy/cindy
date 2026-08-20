import { BRAND_NAME } from './branding.js';

export const DEVICE_LINK_SUBSCRIBE_CHANNEL = 'device-link:subscribe';
export const DEVICE_LINK_UNSUBSCRIBE_CHANNEL = 'device-link:unsubscribe';
/** Marker passed as sessions:get arg[1] only by background list reconciliation probes. */
export const DEVICE_LINK_RECONCILIATION_PROBE_MARKER =
  'device-link:sessions-reconciliation-probe';
export const DEVICE_LINK_MEDIA_FETCH_CHANNEL = 'device-link:media:fetch';
export const DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL = 'device-link:voice:transcribe';
export const DEVICE_LINK_VOICE_CREDENTIAL_SYNC_CHANNEL = 'device-link:voice:credential-sync';
export const DEVICE_LINK_VOICE_DICTIONARY_LEARNING_CHANNEL = 'device-link:voice:dictionary-learning';
export const DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL = 'device-link:voice:dictionary:get';

export type MobileVoiceCredentialSyncAsr = {
  provider: string;
  model: string;
  auth: 'api-key' | 'codex';
  mode: string;
  endpointPath?: string;
  pcmSampleRate?: number;
  protocolProfile?: string;
  resourceId?: string;
  litellmHeaderModel?: string;
};

export type MobileVoiceCredentialSyncRefiner = {
  provider: string;
  model: string;
  auth: 'api-key' | 'codex';
  transport: 'litellm-chat-completions' | 'codex-responses';
  endpointPath?: '/v1/chat/completions';
};

export type MobileVoiceCredentialSyncDictionaryEntry = {
  text: string;
  frequency?: number;
  aliases?: Array<{
    text: string;
    count?: number;
  }>;
};

export type MobileVoiceCredentialSyncSettings = {
  language: string;
  refinementEnabled: boolean;
  playInteractionSound: boolean;
  refinementInstructions?: string;
  dictionaryEntries?: MobileVoiceCredentialSyncDictionaryEntry[];
  voiceInputHistory?: string[];
};

/**
 * Legacy mobile voice credential shape.
 *
 * The current mobile runtime builds this shape from the LiteLLM key saved in the
 * mobile app settings. The old controlled-desktop key sync channel is kept out
 * of the mobile remote invoke allowlist.
 */
export type MobileVoiceCredentialSyncResult = {
  temporary: true;
  credentialVersion: 1;
  issuedAt: string;
  proxyBaseUrl: string;
  proxyApiKey: string;
  asr: MobileVoiceCredentialSyncAsr;
  asrProviderChain?: MobileVoiceCredentialSyncAsr[];
  refiner: MobileVoiceCredentialSyncRefiner;
  refinerProviderChain?: MobileVoiceCredentialSyncRefiner[];
  settings?: MobileVoiceCredentialSyncSettings;
};

/**
 * 手机拉取被控桌面词典的只读快照。
 *
 * 手机不参与 CRDT 合并 —— 它在后台不维持 WebSocket,拿不到对等同步的 push 帧,
 * 也不该持有一份会分叉的可写词典。这里只投影 refine 真正用得上的字段。
 */
export type MobileVoiceDictionarySnapshotResult =
  | {
      ok: true;
      entries: MobileVoiceCredentialSyncDictionaryEntry[];
      /**
       * 该桌面同步状态的版本向量:`{ nodeId: 该节点的最大 HLC }`。
       *
       * 手机同时拉多台电脑时用它判断哪一份**包含**了另一份。不能用响应到达时间
       * (并发请求里慢的那个反而显得"更新"),也不能只比最大 HLC —— 两台电脑各自
       * 新增了不同的词、还没来得及互相同步时,最大 HLC 大的那份并不包含另一份,
       * 拿它当完整答案会漏词。老版本被控端不带这个字段,手机退回按到达时间比较。
       */
      stateVector?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

export type MobileVoiceDictionaryLearningRequest = {
  source: 'mobile';
  rawTranscriptText?: string;
  beforeText: string;
  afterText: string;
  context?: {
    uiLanguage?: string;
    sourceLanguage?: string;
    selectionBefore?: string;
    selectionAfter?: string;
  };
};

export type MobileVoiceDictionaryLearningAction = {
  action: 'add_candidate' | 'add_entry' | 'update_entry';
  term: string;
  aliases: string[];
  type:
    | 'product_name'
    | 'project_name'
    | 'technical_term'
    | 'person_name'
    | 'team_name'
    | 'code_name'
    | 'phrase'
    | 'other';
  confidence: 'high' | 'medium' | 'low';
  reason?: string;
};

export type MobileVoiceDictionaryLearningResult =
  | {
      ok: true;
      actions: MobileVoiceDictionaryLearningAction[];
      elapsedMs: number;
      ignoreReason?: string | null;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * goal 状态(目标模式)跨端契约 —— 镜像被控端 goal-host/types.ts 的 GoalStatusPayload。
 * 控制端(手机)经 `maker:goal:get-status` 拉取、经 `maker:goal:status-changed` push 增量刷新;
 * goal 状态机只在被控端 GoalController 执行,这里只是显示投影。
 */
export type MobileGoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';

export interface MobileGoalStatusPayload {
  sessionId: string;
  status: MobileGoalStatus;
  objective: string;
  turnsUsed: number;
  tokensUsed: number;
  maxTurns: number | null;
  noProgressLimit: number | null;
  budgetTokens: number | null;
  usageResetAt: number | null;
  startedAt: number;
  lastReason: string | null;
}

/** goal 状态变化 push 的 payload(goal=null 表示已清除)。 */
export interface MobileGoalStatusUpdate {
  sessionId: string;
  goal: MobileGoalStatusPayload | null;
}

/** `maker:goal:set` / `maker:goal:update` 的 limits 入参(null = 不设该上限)。 */
export interface MobileGoalLimitsInput {
  maxTurns: number | null;
  budgetTokens: number | null;
  noProgressLimit: number | null;
}

/** One Codex subscription quota window sent from the controlled desktop. */
export interface MobileCodexRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}

/** One Codex subscription quota bucket sent to a control-only client. */
export interface MobileCodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: MobileCodexRateLimitWindow | null;
  secondary?: MobileCodexRateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

/** Display-safe identity for the exact ChatGPT account/workspace used by desktop Codex. */
export interface MobileCodexRateLimitAccount {
  email: string | null;
  accountId: string | null;
  planType: string | null;
}

/** Display-safe metadata for one banked reset credit; its opaque backend id stays on desktop. */
export interface MobileCodexRateLimitResetCredit {
  status: 'available' | 'redeeming' | 'redeemed' | 'unknown';
  resetType: 'codexRateLimits' | 'unknown';
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

/** Desktop-issued, account-bound reset offer used as the idempotency key for one attempt. */
export interface MobileCodexRateLimitResetOffer {
  idempotencyKey: string;
  /** Unix epoch seconds for the selected banked credit, when details are available. */
  expiresAt: number | null;
  /** Unix epoch milliseconds after which desktop discards this retry key. */
  validUntil: number;
}

/** Full read-only Codex quota view plus an optional manually redeemable reset offer. */
export interface MobileCodexRateLimitsResult {
  account: MobileCodexRateLimitAccount;
  rateLimits: MobileCodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, MobileCodexRateLimitSnapshot> | null;
  rateLimitResetCredits: {
    availableCount: number;
    credits: MobileCodexRateLimitResetCredit[] | null;
  } | null;
  resetOffer: MobileCodexRateLimitResetOffer | null;
}

/** Stable terminal result for one desktop-issued reset offer. */
export interface MobileCodexRateLimitResetResult {
  outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
  /** Fresh snapshot when the post-consume read succeeded. */
  rateLimits: MobileCodexRateLimitsResult | null;
}

/** 下一条消息发送时才会应用的跨 Agent 切换意图。 */
export interface MobileSessionAgentSwitchIntent {
  targetAgentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean;
}

/** desktop 登记 / 取消跨 Agent 意图后的稳定结果。 */
export interface MobileSessionAgentSwitchResult {
  switched: boolean;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  engineReady: boolean;
  deferred?: boolean;
}

export const MOBILE_REMOTE_INVOKE_CHANNELS = [
  'maker:create-session',
  'maker:get-capabilities',
  'maker:provider:list',
  'local-db:sessions:get',
  'local-db:sessions:patch-meta',
  // error-tail / interrupted 收尾入口(对齐桌面 error-tail banner / InterruptedTurnBanner):
  // 「忽略」错误尾行 → 被控端持久化 merge dismissed:true;「忽略」中断提示 → 被控端写
  // ended 时间戳。老被控端 CHANNEL_NOT_ALLOWED → 手机端吞掉降级为本视图内存隐藏。
  'local-db:messages:dismiss-error',
  'local-db:sessions:ack-interrupted',
  // 会话菜单重命名的「自动起名」:被控端读该会话素材重新生成标题(与桌面 Magic 按钮
  // 同一 handler;老被控端 CHANNEL_NOT_ALLOWED → 手机端展示失败提示,不阻塞手动改名)。
  'maker:regenerate-title',
  'local-db:messages:list',
  'local-db:messages:around',
  'local-db:messages:around-client-id',
  'maker:send',
  'maker:list-active',
  'maker:set-model',
  'maker:switch-session-agent',
  'maker:get-session-agent-switch-intent',
  'maker:set-effort',
  'maker:set-permission-mode',
  'maker:set-fast-mode',
  'maker:set-thinking-enabled',
  'maker:set-extra-dirs',
  // 模型列表「非选中行」effort/fast 写穿(会话镜像 + 草稿默认双写;老被控端
  // CHANNEL_NOT_ALLOWED → 手机端吞掉降级,见 sessionModelMirror)。
  'maker:set-session-model-pref',
  'maker:apply-new-maker-draft-pref',
  // 工作端「新建会话默认启用 worktree」勾选记忆的读 / 写:
  //  - get-new-maker-defaults(只读):工作端草稿默认值镜像,手机新建页据 worktreeEnabled
  //    播种 worktree 开关(桌面控制端早已消费同通道)。老被控端 CHANNEL_NOT_ALLOWED →
  //    播种回落默认不勾选。
  //  - apply-new-maker-worktree-pref:用户在手机上显式切换开关时写穿工作端 newMakerDraft
  //    根字段。老被控端 CHANNEL_NOT_ALLOWED → 吞掉降级(勾选仅本次草稿生效)。
  'maker:get-new-maker-defaults',
  'maker:apply-new-maker-worktree-pref',
  // 工作端 canonical baseRepo scoped 的 worktree 源分支 live 镜像。GET 未命中返回 null；
  // APPLY 返回并广播 { baseRepo, sourceBranch, revision }，同值写也推进 revision。
  'maker:get-new-maker-worktree-branch-pref',
  'maker:apply-new-maker-worktree-branch-pref',
  // 模型选择列表元信息:被控端视角的模型单价表(只读;拉不到 → 隐藏价格)。
  'maker:usage:model-pricing',
  // Codex app-server 官方控制面:只读额度/reset 次数 + 人工确认后的单次 reset。
  // reset 使用 desktop 预签发、账号绑定的幂等 offer,手机不能自行指定 creditId。
  'maker:usage:codex-rate-limits',
  'maker:usage:codex-rate-limit-reset',
  // 网关 API key presence-only 探测(只回 boolean;拉不到 → unknown,折扣版不置灰)。
  'maker:api-key:present',
  'maker:list-agent-commands',
  'maker:list-agent-skills',
  'maker:scan-at-resources',
  DEVICE_LINK_MEDIA_FETCH_CHANNEL,
  DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL,
  DEVICE_LINK_VOICE_DICTIONARY_LEARNING_CHANNEL,
  DEVICE_LINK_VOICE_DICTIONARY_GET_CHANNEL,
  'maker:get-pending-interactions',
  'maker:resolve-interaction',
  'maker:get-context-usage',
  'maker:goal:set',
  'maker:goal:clear',
  'maker:goal:get-status',
  'maker:goal:pause',
  'maker:goal:resume',
  'maker:goal:update',
  'maker:fork',
  'maker:get-session-tree',
  'maker:navigate-session-tree',
  'maker:rewind:preview',
  'maker:rewind:commit',
  'maker:message:delete',
  'maker:close-session',
  'maker:schedule:list',
  'maker:schedule:get',
  'maker:schedule:list-templates',
  'maker:schedule:create-from-template',
  'maker:schedule:create',
  'maker:schedule:update',
  'maker:schedule:list-runs',
  'maker:schedule:run-now',
  'maker:schedule:pause',
  'maker:schedule:resume',
  'maker:schedule:delete',
  'maker:schedule:get-inflight-count',
  'maker:schedule:mark-run-read',
  'maker:schedule:mark-schedule-runs-read',
  'maker:schedule:delete-run',
  // 会话未读已读回执:手机端真实展示会话内容后,清掉被控端的会话未读
  // (灵动岛 / Dock 角标 / 侧栏红绿点)。老被控端 CHANNEL_NOT_ALLOWED → 吞掉降级。
  'notification:clear-session-attention',
  'maker:project-automation:remove-schedule',
  'maker:input:get-projection',
  'maker:input:enqueue',
  'maker:input:compact',
  // 手动压缩(pi 原生 compact,capability-aware):移动端控制远程 pi 会话同样隧道到
  // 被控端执行;长 LLM 摘要请求的超时覆盖见 INVOKE_TIMEOUT_OVERRIDES_MS。
  'maker:compact-session',
  'maker:input:steer',
  'maker:input:stop',
  'maker:input:resume',
  'maker:input:retry-last-error',
  'maker:input:clear-error',
  'maker:input:remove',
  'maker:input:update-text',
  'maker:input:update-content',
  'maker:input:move',
  'maker:input:set-expanded',
  'maker:input:set-interaction-lock',
  'maker:input:set-edit-lock',
  'maker:input:clear-session',
  'fs:list-dir',
  'fs:stat-path',
  'fs:mkdir-p',
  // —— Worktree(新建会话前在工作端预建隔离 worktree;git/fs 全在被控端执行)——
  //  - detect-cwd:资格探测(git 已装 / 是 git 仓库 / 未在 worktree 内)+ repoRoot/currentBranch;
  //  - list-branches:工作端返回本地分支列表 + 当前分支,供控制端选择 sourceBranch;
  //  - suggest-name:工作端按仓库上下文生成 worktree 名;
  //  - create:两步建会话第一步——同预生成 sessionId 先建 worktree 拿路径,再以该路径调
  //    maker:create-session(与桌面控制端 NewMakerDraftRoute 的远程流程同构)；
  //  - discard-precreated:第二步确定失败且用户放弃时，按 sessionId + 精确 path 补偿回收。
  // 四者均已在被控端 REMOTE_INVOKE_ALLOWLIST(create / discard 的 60s 超时见
  // INVOKE_TIMEOUT_OVERRIDES_MS,移动端 invoke 必须带同一映射)。
  // 老被控端无这些 channel → CHANNEL_NOT_ALLOWED → 手机端按「worktree 不可用」降级。
  'worktree:detect-cwd',
  'worktree:list-branches',
  'worktree:suggest-name',
  'worktree:create',
  'worktree:discard-precreated',
  'text-file:read-preview',
  // 完整文件浏览(网格/预览/缩略图/大文件导出)走桌面同款聚合通道,
  // op 分发与响应形状见 apps/desktop/src/main/file-browser/device-op.ts。
  'file-browser:remote-op',
] as const;

export type MobileRemoteInvokeChannel = (typeof MOBILE_REMOTE_INVOKE_CHANNELS)[number];
export type DeviceLinkRelayStatus = 'online' | 'connecting' | 'stopped';

const PERMANENT_REMOTE_ERROR_MARKERS = [
  'REMOTE_DISABLED',
  'CHANNEL_NOT_ALLOWED',
  // 控制端「目标设备无响应」熔断器的快速失败(见 apps/mobile 的
  // unresponsiveDevicesStore):被控端连续 INVOKE_TIMEOUT 后熔断 open,新请求
  // 本地直拒。必须归为 permanent——否则 withTransientRemoteRetry 会把熔断
  // 快速失败再原地重试 6 次,熔断等于白做。
  'DEVICE_UNRESPONSIVE',
] as const;

const TRANSIENT_REMOTE_ERROR_MARKERS = [
  'DbClient not ready',
  'NOT_CONNECTED',
  'LINK_NOT_OPEN',
  'BACKPRESSURE',
  'DEVICE_OFFLINE',
  'DEVICE_LINK_TIMEOUT',
  'INVOKE_TIMEOUT',
  // HTTP 层(apps/mobile src/api/client.ts 的 ApiError)的弱网错误码:
  // 超时与离线同属典型瞬时故障,必须能被 withTransientRemoteRetry 识别重试。
  'REQUEST_TIMEOUT',
  'NETWORK_UNAVAILABLE',
  // RN 原生 fetch 离线原文(绕过 api client 的直连路径,如 OSS 直传 PUT):
  // 同样是瞬时故障,且中文兜底文案好过把英文原文透传给用户。
  'Network request failed',
] as const;

const DEFAULT_MAX_ATTEMPTS = 6;

export interface RemoteRetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function isMobileRemoteInvokeChannel(channel: string): channel is MobileRemoteInvokeChannel {
  return (MOBILE_REMOTE_INVOKE_CHANNELS as readonly string[]).includes(channel);
}

export function relayStatusLabel(status: DeviceLinkRelayStatus): string {
  switch (status) {
    case 'online':
      return 'Relay 已连接';
    case 'connecting':
      return '正在连接 Relay';
    case 'stopped':
      return 'Relay 未连接';
  }
}

export function relayStatusHint(status: DeviceLinkRelayStatus, lastSyncedAt: number | null): string {
  if (status === 'online') {
    return lastSyncedAt ? `上次同步 ${formatClock(lastSyncedAt)}` : '可以同步远程任务。';
  }
  if (status === 'connecting') return '网络恢复后会自动重新订阅远程任务。';
  return '回到前台或重新登录后会恢复连接。';
}

/**
 * 镜像 @cindy/device-link 的 DeviceLinkConnectionIssueKind。
 * maker-shared 保持零运行时依赖(与 DeviceLinkRelayStatus 同款处理),两边字面量
 * 必须一致;drift 会被 desktop/mobile 消费处的 TS 赋值检查拦下。
 */
export type DeviceLinkConnectionIssueKind =
  | 'auth-failed'
  | 'replaced'
  | 'too-many-connections'
  | 'version-mismatch'
  | 'unstable';

/** 连接问题标题(手机端直出文案;桌面端走 i18n,不用这组)。 */
export function connectionIssueTitle(kind: DeviceLinkConnectionIssueKind): string {
  switch (kind) {
    case 'auth-failed':
      return '登录已失效';
    case 'replaced':
      return '连接被顶替';
    case 'too-many-connections':
      return '连接数已达上限';
    case 'version-mismatch':
      return '版本不匹配';
    case 'unstable':
      return '连接反复断开';
  }
}

/** 连接问题说明与建议动作(手机端直出文案)。 */
export function connectionIssueHint(kind: DeviceLinkConnectionIssueKind): string {
  switch (kind) {
    case 'auth-failed':
      return '登录状态已过期，请退出后重新登录。';
    case 'replaced':
      return '本设备的连接被另一处相同设备顶替，正在重新连接。';
    case 'too-many-connections':
      return '当前账号同时在线的设备过多，请断开其它设备后重试。';
    case 'version-mismatch':
      return '当前 App 版本与服务端协议不一致，请升级到最新版本。';
    case 'unstable':
      return '本机连接反复断开又重连，远程操作可能一直超时。请检查网络；若持续如此，重启 App 后重试。';
  }
}

/**
 * agent 鉴权失败 message 的固定模板。maker-core 的 claude-code / codex 在
 * startSession / 首次 send 的鉴权门禁抛 AgentNotAuthenticatedError 时统一用
 * `<agentKind> not authenticated: <reason>` 这个格式;reason(no_key 等)目前只
 * 存在于 message 字符串里,不随事件结构化下发,relay 又是哑中继原样透传——手机端
 * 要给出可读提示只能按模板识别。formatRemoteError / throwIpcError 会给部分链路的
 * message 加 `[CODE] ` 头,识别时一并容忍。
 */
const AGENT_NOT_AUTHENTICATED_RE = /^(?:\[[A-Z_]+\] )?(claude-code|codex|pi) not authenticated: ?(.*)$/;

/**
 * agent 未鉴权错误 → 手机端直出文案(桌面端走 i18n,不用这组)。
 *
 * 密钥 / OAuth 都存在被控电脑的 Cindy 里(safeStorage),手机端改不了,文案统一
 * 引导用户回电脑端「设置 → 模型供应商」处理。识别不了的输入返回 null,由调用方
 * 展示原文,不误伤其它错误。
 */
export function describeAgentAuthError(error: string | null | undefined): string | null {
  if (!error) return null;
  const matched = AGENT_NOT_AUTHENTICATED_RE.exec(error.trim());
  if (!matched) return null;
  const agentLabel = matched[1] === 'claude-code' ? 'Claude' : matched[1] === 'pi' ? 'Pi' : 'Codex';
  const goSettings = `请在电脑端 ${BRAND_NAME} 的「设置 → 模型供应商」`;
  switch (matched[2]) {
    case 'no_key':
      return `${agentLabel} 无法使用：电脑端还没有配置可用的 API Key。${goSettings}完成配置后再试。`;
    case 'no_oauth':
      return `${agentLabel} 无法使用：电脑端尚未完成账号授权。${goSettings}重新连接账号后再试。`;
    case 'no_credentials':
      return `${agentLabel} 无法使用：电脑端尚未登录 ${agentLabel}。${goSettings}完成登录后再试。`;
    case 'no_encryption':
      return `${agentLabel} 无法使用：电脑端系统安全存储不可用，读取不到已保存的密钥。请在电脑端检查系统钥匙串（macOS）或系统账户加密（Windows）后重启 ${BRAND_NAME}。`;
    case 'proxy_not_ready':
      return `${agentLabel} 暂时无法使用：电脑端组件尚未就绪。请稍候重试；若持续出现，请重启电脑端 ${BRAND_NAME}。`;
    default:
      // 动态 reason(如 OAuth 被服务端作废的具体原因):不逐一枚举,统一按登录失效引导,
      // 原始 reason 附在句尾便于反馈排查。
      return `${agentLabel} 无法使用：电脑端登录凭证不可用。${goSettings}重新登录后再试。（${matched[2] || 'unknown'}）`;
  }
}

export function describeRemoteError(error: string | null): string | null {
  if (!error) return null;
  const agentAuth = describeAgentAuthError(error);
  if (agentAuth) return agentAuth;
  if (error.includes('REMOTE_DISABLED')) return '被控电脑已关闭允许远程控制。';
  if (error.includes('CHANNEL_NOT_ALLOWED')) return '当前电脑端版本不支持这个远程能力。';
  if (error.includes('ACCESS_REVOKED')) return '这台电脑已撤销手机访问权限。';
  if (error.includes('DEVICE_UNRESPONSIVE')) return '电脑端未响应，正在自动重试，请稍后再试。';
  if (error.includes('VERSION_MISMATCH')) return '与服务端协议版本不一致，请升级 App 后重试。';
  if (error.includes('PAYLOAD_TOO_LARGE')) return '这次传输的内容过大，请拆分后重试。';
  if (error.includes('MEDIA_FETCH_FAILED')) return '获取电脑端文件失败，可以稍后重试。';
  if (error.includes('VOICE_TRANSCRIBE_FAILED')) return '语音转写失败，可以重试或改用键盘输入。';
  if (error.includes('LINK_NOT_OPEN')) return '与被控电脑的控制链路已断开，正在重新建立。';
  if (error.includes('PRECONDITION_FAILED')) {
    if (error.includes('ACCOUNT_CHANGED')) return 'Codex 账号或工作区已变化，请刷新额度后重新确认。';
    if (error.includes('OFFER_EXPIRED')) return 'Codex 重置凭证已失效，请刷新额度后重新确认。';
    return '操作条件已变化，请刷新后重新确认。';
  }
  if (TRANSIENT_REMOTE_ERROR_MARKERS.some((marker) => error.includes(marker))) {
    return '网络或被控端暂时不可用，可以稍后重新同步。';
  }
  // BAD_REQUEST / INTERNAL / 未识别错误:给可理解的兜底句,把原始信息放在后面便于反馈排查。
  if (error.includes('BAD_REQUEST') || error.includes('INTERNAL')) {
    return `远程调用失败，可以稍后重试。（${error}）`;
  }
  return error;
}

export function formatRemoteError(error: unknown): string {
  const code = readStringField(error, 'code');
  const message = error instanceof Error ? error.message : String(error);
  if (!code || message.includes(code)) return message;
  return `[${code}] ${message}`;
}

/**
 * unknown 错误 → 直接给用户看的文案:先 formatRemoteError 展平成 `[CODE] message`,
 * 再过 describeRemoteError 的人话映射;识别不了的原文透出,便于用户反馈时排查。
 * Alert / toast 等直面用户的出口用这个,不要裸用 formatRemoteError——那会把
 * `[NOT_CONNECTED] not online within 1500ms` 这类原始错误直接怼给用户。
 */
export function humanizeRemoteError(error: unknown): string {
  const text = formatRemoteError(error);
  return describeRemoteError(text) ?? text;
}

export function isAccessRevokedRemoteError(error: unknown): boolean {
  const code = readStringField(error, 'code');
  if (code === 'ACCESS_REVOKED') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('ACCESS_REVOKED') || message.includes('DEVICE_LINK_ACCESS_REVOKED');
}

/** 控制端熔断器快速失败(目标设备无响应)的识别;code 与 message 两种形态都认。 */
export function isDeviceUnresponsiveRemoteError(error: unknown): boolean {
  const code = readStringField(error, 'code');
  if (code === 'DEVICE_UNRESPONSIVE') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('DEVICE_UNRESPONSIVE');
}

export function isPreconditionFailedRemoteError(error: unknown): boolean {
  const code = readStringField(error, 'code');
  if (code === 'PRECONDITION_FAILED') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('PRECONDITION_FAILED');
}

export function isTransientRemoteError(error: unknown): boolean {
  const text = formatRemoteError(error);
  if (PERMANENT_REMOTE_ERROR_MARKERS.some((marker) => text.includes(marker))) return false;
  return TRANSIENT_REMOTE_ERROR_MARKERS.some((marker) => text.includes(marker));
}

export async function withTransientRemoteRetry<T>(
  operation: () => Promise<T>,
  opts: RemoteRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const canRetry = attempt < maxAttempts - 1 && isTransientRemoteError(err);
      if (!canRetry) throw err;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError;
}

function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 3000);
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0'),
  ].join(':');
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : null;
}
