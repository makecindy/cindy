/**
 * shared/hookControlIpc.ts
 * ---------------------------------------------------------------------------
 * Cindy IM relay(hook-control) 的 IPC 通道名与线上类型 —— main / preload /
 * renderer 三端共享的唯一契约(模式对齐 deviceLinkIpc.ts)。
 *
 * 功能背景: desktop 主动外连公司中心部署的 IM hook 服务(WS 拨出),
 * 接收 Slack / Telegram 归一化后的任务派发。产品形态是**每 provider 一条内置连接**:
 *   - Slack / Telegram 地址分别来自运行期端点清单；
 *   - 鉴权用登录 JWT(与 device-link 同模型), 没有密钥概念, 用户零输入;
 *   - 用户可操作面 = provider 独立开关 / 账号绑定 / 工作目录清单。
 */

// 内置服务器地址来自运行期端点清单(main 侧分别读取 slackHookWsUrl 与
// telegramHookWsUrl；Slack 的本地 urlOverride 只覆盖 Slack);
// 烘焙常量 SLACK_HOOK_DEFAULT_URL 已随 2026-07 端点清单重构退役。

/**
 * 由 WS 服务器地址推导 Slack App 安装链接: wss→https / ws→http, 去尾斜杠后拼
 * bolt InstallProvider 的固定路径 /slack/install(directInstall 模式, 302 直跳
 * Slack 授权页)。安装是 workspace 级一次性动作, 与本机连接/绑定状态无关。
 */
export function slackHookInstallUrl(wsUrl: string): string {
  return `${wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '')}/slack/install`;
}

export const HOOK_CONTROL_INVOKE = {
  /** 取当前快照(配置 + 运行时状态 + 绑定状态)。 */
  GET: 'maker:hook-control:get',
  /** 总开关。 */
  SET_ENABLED: 'maker:hook-control:set-enabled',
  /** Slack Bot 是否发送本设备上下线通知。 */
  SET_LIFECYCLE_ANNOUNCEMENT: 'maker:hook-control:set-lifecycle-announcement',
  /** 覆写工作目录清单(别名 -> 本地绝对路径, 全量替换)。 */
  SET_WORKSPACES: 'maker:hook-control:set-workspaces',
  /**
   * 设置某个 provider 派发任务的默认工作目录(null / 「对话」= 内置伪目录)。
   * 进程内通道, 没有跨版本兼容问题 —— 原 set-x-default-workspace 直接改名。
   */
  SET_PROVIDER_DEFAULT_WORKSPACE: 'maker:hook-control:set-provider-default-workspace',
  /** 发起 Slack 账号绑定(bind.start; SIWS OIDC, 无参数)。 */
  BIND_START: 'maker:hook-control:bind-start',
  /** 解除 Slack 账号绑定(bind.revoke)。 */
  BIND_REVOKE: 'maker:hook-control:bind-revoke',
  /** 拉取绑定用户的全部目录偏好快照(经 WS prefs.get, 10s 超时)。 */
  PREFS_GET: 'maker:hook-control:prefs-get',
  /** 部分更新某目录偏好(经 WS prefs.set; null = 清空回默认)。 */
  PREFS_SET: 'maker:hook-control:prefs-set',
  /** (multi-team)添加新 Slack workspace 绑定(bind.start 空 teamId, 授权页自选)。 */
  ADD_BINDING: 'maker:hook-control:add-binding',
  /** (multi-team)给指定 team 重新授权(bind.start 带 teamId, pin 授权页)。 */
  REBIND_TEAM: 'maker:hook-control:rebind-team',
  /** (multi-team)解绑指定 team(bind.revoke{teamId}; displaced 行 = 仅清本地缓存)。 */
  REVOKE_TEAM: 'maker:hook-control:revoke-team',
  /** (multi-team)取消在途的添加/重绑授权(bind.revoke{pendingOnly} + 本地清 pending)。 */
  CANCEL_PENDING_BIND: 'maker:hook-control:cancel-pending-bind',
  /** 独立开关一个 Cindy IM provider；不会改动其它 provider。 */
  SET_PROVIDER_ENABLED: 'maker:hook-control:set-provider-enabled',
  /** 发起 provider-neutral(Telegram / X)一次性绑定。 */
  PROVIDER_BIND_START: 'maker:hook-control:provider-bind-start',
  /** 取消当前 provider-neutral 绑定尝试。 */
  PROVIDER_BIND_CANCEL: 'maker:hook-control:provider-bind-cancel',
  /** 解除当前 provider-neutral principal 与本设备的绑定。 */
  PROVIDER_BIND_REVOKE: 'maker:hook-control:provider-bind-revoke',
  /** 在本机安全打开 provider 的绑定链接 / bot 主页 / 加群链接。 */
  PROVIDER_OPEN_ACTION: 'maker:hook-control:provider-open-action',
  /** 读取 provider-neutral(Telegram / X)独立的 workspace 偏好。 */
  PROVIDER_PREFS_GET: 'maker:hook-control:provider-prefs-get',
  /** 更新 provider-neutral(Telegram / X)独立的 workspace 偏好。 */
  PROVIDER_PREFS_SET: 'maker:hook-control:provider-prefs-set',
  /** 读取官方 Telegram bot 的回应、引用与群激活设置。 */
  TELEGRAM_BEHAVIOR_GET: 'maker:hook-control:telegram-behavior-get',
  /** 部分更新官方 Telegram bot 的回应或引用设置。 */
  TELEGRAM_BEHAVIOR_SET: 'maker:hook-control:telegram-behavior-set',
  /** 列出官方 Telegram bot 已见过的群，并合并服务端激活设置。 */
  TELEGRAM_GROUPS_LIST: 'maker:hook-control:telegram-groups-list',
  /** 更新一个官方 Telegram 群的参与模式。 */
  TELEGRAM_GROUP_ACTIVATION_SET: 'maker:hook-control:telegram-group-activation-set',
  /** 读取工作目录模型来源偏好(纯本地, 不经 WS; 见 workspaceProviderSourceStore)。 */
  WORKSPACE_PROVIDER_SOURCE_GET: 'maker:hook-control:workspace-provider-source-get',
  /** 写/清一条工作目录模型来源偏好(纯本地)。 */
  WORKSPACE_PROVIDER_SOURCE_SET: 'maker:hook-control:workspace-provider-source-set',
} as const;

export const HOOK_CONTROL_EVENT = {
  /** 状态推送(完整快照; 连接与绑定状态变化都走这里)。 */
  STATUS_CHANGED: 'maker:hook-control:status-changed',
  /** 目录偏好快照推送(prefs.state; 含 Slack /model 卡改动的实时同步)。 */
  PREFS_CHANGED: 'maker:hook-control:prefs-changed',
  /** provider-neutral 偏好快照推送（Telegram / X 消费）。 */
  PROVIDER_PREFS_CHANGED: 'maker:hook-control:provider-prefs-changed',
  /** 官方 Telegram 行为配置快照推送（含其它客户端写入）。 */
  TELEGRAM_BEHAVIOR_CHANGED: 'maker:hook-control:telegram-behavior-changed',
  /** 目录模型来源偏好全量推送(本地写入后广播全窗口, 多窗口设置页同步)。 */
  WORKSPACE_PROVIDER_SOURCE_CHANGED: 'maker:hook-control:workspace-provider-source-changed',
} as const;

/** 目录来源偏好条目总量上限(渠道×目录×team 现实规模远小于此;防被攻破的
 * renderer 用海量唯一 teamId 无限追加撑爆本地文件)。 */
export const HOOK_WORKSPACE_PROVIDER_SOURCE_MAX_ENTRIES = 256;

/**
 * Cindy relay 当前支持的客户端 provider。协议包 HOOK_PROVIDERS 的手抄副本
 * (shared 层刻意不引协议包)——协议 bump 新增 provider 时必须手动同步。
 */
export type HookProvider = 'slack' | 'telegram' | 'x';

/** provider-neutral 状态机(非 slack legacy 线)覆盖的 provider。 */
export type NeutralHookProvider = Exclude<HookProvider, 'slack'>;

/** provider-neutral 绑定状态（与本仓 slack-hook-protocol v1 严格同形）。 */
export type ProviderBindingState =
  | 'none'
  | 'pending'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'denied'
  | 'expired'
  | 'failed'
  | 'revoked'
  | 'superseded';

/** renderer 可见的 provider-neutral 绑定快照；不含任何 token/secret。 */
export interface ProviderBindingView {
  provider: HookProvider;
  state: ProviderBindingState;
  attemptId: string | null;
  bindingId: string | null;
  principalId: string | null;
  principalName: string | null;
  scopeId: string | null;
  scopeName: string | null;
  connectUrl: string | null;
  expiresAt: number | null;
  reason: string | null;
  remediationUrl: string | null;
  actions: string[];
}

/** provider-neutral(Telegram / X)的独立设置与绑定视图。 */
export interface ProviderHookView {
  enabled: boolean;
  /** 该 provider 平级 hook 服务的运行期端点；空值表示当前环境尚未部署。 */
  url: string;
  status: HookConnectionStatus;
  lastError: string | null;
  /** 已收到 welcome，且双方成功协商完整 provider 能力。 */
  available: boolean;
  /** 尚未收到任何 welcome；用于首开时先显示入口、连接后再权威收敛。 */
  capabilityPending: boolean;
  /** Telegram 行为设置增量能力；旧 main 快照缺省时按 false。 */
  behaviorAvailable?: boolean;
  binding: ProviderBindingView | null;
  /**
   * 派发任务时使用的默认工作目录别名(null = 内置「对话」伪目录)。
   *
   * **目前只有 X 会给出非 null 值**: Slack / Telegram 能在会话里当场选目录,
   * X 一次交互只有一条公开推文, 没有承载选择面板的位置, 只能靠这个预设。
   */
  defaultWorkspace: string | null;
}

/** @deprecated 兼容别名;新代码用 ProviderHookView。 */
export type TelegramHookView = ProviderHookView;

/** 绑定卡可打开的链接类别;'add-to-group' 仅 Telegram 使用。 */
export type ProviderOpenAction = 'connect' | 'provider' | 'add-to-group';

/** @deprecated 兼容别名;新代码用 ProviderOpenAction。 */
export type TelegramOpenAction = ProviderOpenAction;

/**
 * Slack 账号绑定状态(与 hook-protocol 的 BindUpdateState 一致, 本文件为
 * renderer 侧独立声明, 避免 shared 层引协议包)。阶段 4 起绑定走 Sign in with
 * Slack(OIDC):
 *   none 未绑定 / pending 已生成授权链接·等浏览器授权(authorizeUrl 非空) /
 *   confirmed 已绑定 / denied 授权被拒 / expired 授权超时 /
 *   failed 流程失败(如老服务器、workspace 未安装) / revoked 被解除(含被新设备顶掉)
 */
export type HookBindingState =
  'none' | 'pending' | 'confirmed' | 'denied' | 'expired' | 'failed' | 'revoked';

/** Slack 绑定快照(server 经 bind.update 推送, main 缓存最新一帧)。 */
export interface HookBindingView {
  state: HookBindingState;
  slackUserId: string | null;
  slackUserName: string | null;
  message: string | null;
  /**
   * SIWS OIDC 授权链接(仅 state=pending 时非空): 桌面端用系统浏览器打开它
   * 完成 Slack 授权。远程控制场景下 openExternal 落在被控机, 故设置页同时
   * 给「复制链接」兜底(规则 26)。
   */
  authorizeUrl: string | null;
  /**
   * 结构化失败原因(仅 state=failed 时可能非空, 透传 bind.update.reason)。
   * 已知值 'not-installed': 授权的 Slack workspace 未安装 App(授权本身不要求
   * 安装, 但 bot 无 token 收发消息), 设置页据此显示「安装 Slack App」引导行
   * (判定走本字段, 不解析 message 文案, 规则 9)。
   */
  reason: string | null;
  /**
   * 按 workspace 定制的安装链接(仅 not-installed 时可能非空, 透传
   * bind.update.installUrl): 带 team 参数, 安装授权页预选到刚授权的
   * workspace。老 server 不下发时回退 slackHookInstallUrl 通用链接。
   */
  installUrl: string | null;
  /**
   * 绑定所在 Slack workspace 显示名(仅 confirmed 时可能非空, 透传
   * bind.update.teamName): 状态行展示「已绑定 @xxx(workspace)」。老 server
   * 不下发时为 null, 回退只显示用户名。
   */
  teamName: string | null;
}

/** binding.reason 已知值(与 hook-protocol 的 BIND_FAIL_REASON_NOT_INSTALLED 对齐)。 */
export const HOOK_BIND_REASON_NOT_INSTALLED = 'not-installed';

/** binding.reason 已知值(multi-team): 该 team 被同用户在另一台设备顶掉。 */
export const HOOK_BIND_REASON_SUPERSEDED = 'superseded';

/**
 * (multi-team)本地合成的终止态 reason: 「添加 workspace」授权落在已绑定的
 * 活跃 team 上(用户没在 Slack 授权页右上角切换 workspace)。仅 desktop 本地
 * 使用, 不过网线; renderer 据此显示切换指引而非通用失败文案。
 */
export const HOOK_BIND_REASON_ALREADY_BOUND = 'already-bound';

/**
 * (multi-team)单个已确认的 Slack workspace 绑定行(bind.state 快照 +
 * confirmed/revoked 事件维护; displaced 行来自本地缓存 diff 或 superseded 事件)。
 */
export interface HookTeamBindingView {
  teamId: string;
  /** workspace 显示名; 安装档案缺名时 null(回退显示 teamId)。 */
  teamName: string | null;
  slackUserId: string;
  slackUserName: string | null;
  /**
   * true = 该 team 的绑定已被同用户在另一台设备顶替(reason=superseded 实时
   * 推送, 或冷启动快照 diff 出「本地有、服务端没有」): 行保留并标注
   * 「已在另一台设备绑定」, 用户可重新绑定(rebind)或删除(仅清本地缓存)。
   */
  displaced: boolean;
}

/**
 * (multi-team)在途授权状态 —— 原单绑定状态机中「非 confirmed」的部分拆出来
 * 单独承载: 添加/重绑 workspace 的授权流(pending)与其终止态(denied/expired/
 * failed)。confirmed/revoked 只落到 bindings 列表, 不出现在这里。
 */
export interface HookPendingBindView {
  state: 'pending' | 'denied' | 'expired' | 'failed';
  message: string | null;
  /** 仅 pending 时非空(SIWS OIDC 授权链接, 复制链接兜底用)。 */
  authorizeUrl: string | null;
  /** 结构化失败原因(如 not-installed), 语义同 HookBindingView.reason。 */
  reason: string | null;
  installUrl: string | null;
  /** 重绑指定 team 时的目标 team; 添加新 workspace 时 null。 */
  teamId: string | null;
  /**
   * 本次授权流的发起意图 —— 决定终止态重试走哪个入口。add = 添加新
   * workspace(重试回 addBinding, 授权页可切换); rebind = 定向重绑指定
   * team(重试 pin 到 teamId)。不能靠 teamId 推断: add 流授权中途 server
   * 也会回显用户所选 team 的 teamId(含 denied/expired/failed 终止态)。
   */
  intent: 'add' | 'rebind';
}

/**
 * 连接运行时状态:
 *  - disabled:   开关关闭, 不建连
 *  - connecting: 正在建连 / 退避重连中(含已开 WS 但尚未收到 welcome)
 *  - connected:  握手完成(hello -> welcome), 可收派发
 *  - standby:    同机另一实例已持有 first-wins 连接, 本实例低频探测接管
 *  - error:      最近一次连接失败(仍在退避重试), lastError 给原因
 */
export type HookConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'standby' | 'error';

/** 渲染层可见的 Cindy IM 快照；顶层字段保持 Slack 兼容。 */
export interface SlackHookView {
  enabled: boolean;
  /** Slack Bot 是否发送本设备上下线私聊通知。 */
  lifecycleAnnouncement: boolean;
  /** 实际生效的服务器地址(默认内置值; 被 urlOverride 覆写时为覆写值)。 */
  url: string;
  /** 工作区别名 -> 本地绝对路径。协议里只跑别名, 路径不出本机。 */
  workspaces: Record<string, string>;
  status: HookConnectionStatus;
  lastError: string | null;
  /**
   * Slack 账号绑定状态(legacy 单绑定视图); 未连接过 / server 未推送时为
   * null(按未绑定显示)。multi-team 模式下由 bindings/pendingBind 映射而来
   * (在途授权优先, 否则首个未 displaced 绑定), 供老消费点继续读取。
   */
  binding: HookBindingView | null;
  /**
   * (multi-team)已确认绑定列表(含 displaced 行)。老 server / 未连接时来自
   * 本地缓存(冷启动「已关闭 · N 个绑定已保留」的数据源)。
   */
  bindings: HookTeamBindingView[];
  /** (multi-team)在途授权状态; 无在途流程时 null。 */
  pendingBind: HookPendingBindView | null;
  /** server 是否宣告 multi-team 能力(welcome.features; renderer 据此显示「添加」入口)。 */
  serverMultiTeam: boolean;
  /** 平级 Telegram hook 服务状态；Slack 旧字段保持原形。 */
  telegram: ProviderHookView;
  /** 平级 X (Twitter) hook 服务状态。 */
  x: ProviderHookView;
}

/** 工作区别名的合法格式(与 hook server 侧约定一致)。 */
export const HOOK_WORKSPACE_ALIAS_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 保留别名「对话」: 内置的伪工作目录, 与真实目录同级 —— 桌面端把它恒定加进
 * 上报给 server 的目录清单(排第一), Slack 侧所有目录选择卡自然多一个 chat
 * 选项; 派发到 chat 的任务不落任何仓库, 每个会话分配独立的 app 托管对话
 * 目录(userData/dialogues/..., workspaceKind='dialogue', 落侧边栏「对话」
 * 分组)。server 对别名透传不校验, 解析完全在桌面端; 用户不能用它命名真实
 * 目录(store 校验拦截)。偏好按 (用户, 'chat') 存, 与真实目录同一套体系。
 */
export const HOOK_CHAT_WORKSPACE_ALIAS = 'chat';

/**
 * 单目录会话偏好(与协议 WorkspacePrefsEntry 同形, shared 层独立声明避免
 * 引协议包)。null = 未设置, 跟随桌面端草稿默认(权限默认完全访问)。
 * 数据正本在 slack-hook-server 的 user_prefs 表, 与 Slack /model 卡同源。
 */
/**
 * 工作目录的模型来源偏好条目(纯客户端, 不进 server prefs 表)。
 * server prefs 继续只存 model/effort/agentKind/permissionMode 服务 /model 卡展示;
 * 来源是纯客户端维度(凭证/连接态/目录/派发全在客户端), 按本表与 server 显式
 * model 组合后经 effectiveSourceIdForModel 收窄派发。
 */
export interface HookWorkspaceProviderSourceEntry {
  channel: 'slack' | 'telegram' | 'x';
  /** Slack multi-team 归属; Telegram / X / 单绑定为 null。 */
  teamId: string | null;
  workspace: string;
  providerId: string;
}

export interface HookWorkspacePrefs {
  workspace: string;
  model: string | null;
  effort: string | null;
  agentKind: string | null;
  permissionMode: string | null;
  /**
   * (multi-team)偏好归属的 Slack workspace(prefs.state 条目透传)。老 server /
   * 单绑定语境下缺省 —— renderer 按 teamId 过滤显示时对缺省值宽松匹配。
   */
  teamId?: string | null;
}

/** 偏好快照(prefs.state 的 renderer 侧形态)。bound=false 时 prefs 恒空。 */
export interface HookPrefsView {
  bound: boolean;
  prefs: HookWorkspacePrefs[];
}

/** provider-neutral 偏好快照；selector 与协议帧同形。 */
export interface ProviderPrefsView extends HookPrefsView {
  provider: HookProvider;
  bindingId: string | null;
  scopeId: string | null;
}

export type TelegramHookEmojiReactions = 'off' | 'minimal' | 'expressive';
export type TelegramHookReplyQuoteDm = 'off' | 'first';
export type TelegramHookReplyQuoteGroup = 'off' | 'first' | 'all';
export type TelegramHookGroupActivationMode = 'mention' | 'always';

/** 官方 Telegram bot 的有效行为快照；数据正本在 telegram-hook-server。 */
export interface TelegramHookBehavior {
  emojiReactions: TelegramHookEmojiReactions;
  replyQuoteDm: TelegramHookReplyQuoteDm;
  replyQuoteGroup: TelegramHookReplyQuoteGroup;
}

export interface TelegramHookBehaviorState extends TelegramHookBehavior {
  bound: boolean;
  bindingId: string;
  /** 只列偏离默认值的群；缺席 = mention。 */
  groupActivation: Record<string, 'always'>;
}

export type TelegramHookBehaviorPatch = Partial<TelegramHookBehavior>;

export interface TelegramHookKnownGroup {
  chatId: string;
  chatName: string | null;
  activation: TelegramHookGroupActivationMode;
}

/** 偏好部分更新 patch(undefined 不动, null 显式清空)。 */
export interface HookPrefsPatch {
  model?: string | null;
  effort?: string | null;
  agentKind?: string | null;
  permissionMode?: string | null;
}
