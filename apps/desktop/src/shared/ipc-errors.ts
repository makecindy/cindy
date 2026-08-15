/** main / preload / renderer 共用的 IPC 错误类型。 */

export type IpcErrorCode =
  // 通用错误
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'INTERNAL'
  | 'ALREADY_EXISTS'
  | 'PRECONDITION_FAILED'
  | 'MAKER_MEMORY_NOT_READY'
  | 'SCHEDULER_NOT_READY'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'APP_SHORTCUTS_WRITE_FAILED'
  | 'NO_ACTIVE_TURN'
  | 'SESSION_RUNNING'
  // 共享 codex 进程要切凭证形态但有其它本地会话在忙(可能等很久)。与 SESSION_RUNNING
  // 分开:后者是"本会话在跑"的短时状态;混用会让「新建会话/切模型」场景弹出误导性的
  // "会话运行中"文案(实际是别的会话挡住了凭证切换)。
  | 'CREDENTIAL_SWITCH_BUSY'
  // 远端 Claude 路由 materialization 失败(remote-claude-route.ts):
  // 供应商凭证 mutation 窗口(稍后重试)/ 远端不可表达(换来源)/ 订阅未连接(连接 Claude.ai)。
  | 'REMOTE_PROVIDER_UPDATING'
  | 'REMOTE_PROVIDER_UNSUPPORTED'
  | 'REMOTE_NATIVE_OAUTH_UNAVAILABLE'
  // 远端切模/切来源需要不同路由(claude-code setModel 守卫):提示重建会话。
  | 'REMOTE_MODEL_SWITCH_ROUTE_CHANGE'
  | 'NO_LIVE_QUERY'
  // 智能通讯录: (platform, value) 身份已属于另一个联系人 — message 里带占用者 id
  | 'IDENTITY_CONFLICT'
  // domain-specific
  | 'STALE_DIFF'
  | 'PUSH_LEASE_EXPIRED'
  | 'PUSH_NO_REMOTE'
  | 'MARK_DONE_FAILED'
  | 'SOURCE_NEVER_RAN'
  | 'NO_PRIOR_ASSISTANT'
  | 'CODEX_FORK_STATE_UNAVAILABLE'
  | 'FORK_UNSUPPORTED_HISTORY'
  | 'REWIND_GIT_CONFLICT'
  | 'REWIND_GIT_FAILED'
  | 'REWIND_UNSUPPORTED_HISTORY'
  | 'REWIND_TARGET_NOT_LATEST'
  | 'TURN_CHANGE_GIT_UNAVAILABLE'
  // multi-worker
  | 'DUPLICATE_LABEL'
  | 'WORKER_CREATION_IN_PROGRESS'
  | 'WORKER_LIMIT_HARD_EXCEEDED'
  | 'WORKER_NOT_FOUND'
  | 'ALREADY_IDLE'
  | 'WORKER_STATE_CHANGED'
  | 'BUDGET_MODEL_REQUIRES_API_MODE'
  | 'NO_PROVIDER_FOR_AGENT'
  | 'PROVIDER_ROUTE_UNAVAILABLE'
  // AI 重新命名：仅暴露用户可以采取明确行动的失败原因。
  | 'TITLE_NO_MATERIAL'
  | 'TITLE_PROVIDER_UNSUPPORTED'
  // 会话内 /goal
  | 'GOAL_ALREADY_ACTIVE'
  | 'GOAL_NOT_FOUND'
  // /learn 蒸馏(learn-host)
  | 'LEARN_BUSY' // 已有 learn run 在进行(全局并发 1)
  | 'LEARN_INVALID_STATE' // run 状态不允许该操作(如对非 awaiting-review 调 apply)
  // remote-ssh：连接阶段
  | 'SSH_CONNECT_FAILED'
  | 'SSH_AUTH_FAILED'
  | 'SSH_CONFIG_IO_FAILED'
  | 'SSH_HOST_NOT_FOUND'
  // remote-ssh：配置的私钥文件在磁盘上不存在/不可读。与 SSH_CONNECT_FAILED 分开——
  // 这是本机路径问题（缺失 / ~ 未展开 / 路径被改写），不是网络或服务器错误，renderer
  // 据此显示明确的路径错误并允许重新选择密钥 / 编辑主机。
  | 'SSH_KEY_FILE_NOT_FOUND'
  // remote-ssh：远端 agent 阶段
  | 'SSH_NOT_CONNECTED'
  | 'SSH_INSTALL_FAILED'
  | 'SSH_EXEC_FAILED'
  | 'SSH_AGENT_NOT_INSTALLED'
  // remote-ssh：项目选择器远端目录列表
  | 'SSH_REMOTE_LS_FAILED'
  // remote-ssh:file-service(SSH 远程会话的文件浏览 daemon)不可用——
  // 连接失败 / 安装失败 / daemon 版本无法对齐 / RPC 通道断开
  | 'REMOTE_FS_UNAVAILABLE'
  // hook-control: 连接未处于 connected 状态(Slack 绑定发起/解除要求在线)
  | 'HOOK_NOT_CONNECTED'
  // hook-control: 目录偏好读写往返超时 —— server 大概率是不认识 prefs.* 帧的
  // 旧版本(丢帧不应答), 也可能是卡死; renderer 据此显示"服务器版本过旧"
  | 'HOOK_PREFS_TIMEOUT'
  // hook-control: server 未宣告 multi-team 能力(多 workspace 绑定操作不可用;
  // renderer 本就按 serverMultiTeam 隐藏入口, 本码是防御性兜底)
  | 'HOOK_MULTI_TEAM_UNSUPPORTED'
  // 本机文件系统浏览(项目选择器；device-link 经隧道在被控端执行)
  | 'FS_BROWSE_FAILED'
  // device-link(跨设备远程控制)
  | 'DEVICE_LINK_UNAVAILABLE' // relay 不可达 / server 未启用该功能
  | 'DEVICE_LINK_NOT_CONNECTED' // 本机尚未连上 relay(未登录 / 断线中)
  | 'DEVICE_LINK_STANDBY' // 本实例处于单持有者仲裁的被动态(同机另一实例持有 relay 连接)
  | 'DEVICE_LINK_DEVICE_OFFLINE' // 目标设备离线
  | 'DEVICE_LINK_REMOTE_DISABLED' // 目标设备「允许被控」开关关闭
  | 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' // channel 不在远程白名单
  | 'DEVICE_LINK_ACCESS_REVOKED' // 目标设备已撤销本机的访问权限(逐设备黑名单)
  | 'DEVICE_LINK_CONTROL_DISABLED' // 本机已关闭对该目标设备的控制(控制端本地偏好)
  | 'DEVICE_LINK_TIMEOUT' // 等待远端响应超时
  | 'DEVICE_LINK_DEVICE_UNRESPONSIVE' // 目标设备连续超时被熔断判定无响应(弱网 / 对端卡死),快速失败中
  | 'DEVICE_LINK_VERSION_MISMATCH' // 两端协议/版本不匹配
  | 'DEVICE_LINK_MEDIA_TRANSFER_FAILED' // 远程媒体经 OSS 中转失败(出方向附件上传 / 入方向取媒体)
  | 'REMOTE_WORKDIR_INVALID' // 被控端工作目录路径非法
  | 'REMOTE_WORKDIR_NOT_FOUND' // 被控端工作目录不存在
  | 'REMOTE_WORKDIR_NOT_DIRECTORY' // 被控端工作路径存在但不是目录
  | 'REMOTE_WORKDIR_UNAVAILABLE' // 被控端网络目录不可访问 / 探测超时
  | 'SESSION_REFERENCE_UNAVAILABLE' // 会话引用不存在、离线、撤权、预算/形状非法
  | 'SESSION_REFERENCE_UNSUPPORTED' // 目标端版本不能消费可信会话引用快照
  // right-sidebar tabs(对标 Codex in-app browser sidebar 多 Tab 容器)
  | 'RIGHT_SIDEBAR_TOO_MANY_TABS' // 单 session 超 20 个 tab
  | 'RIGHT_SIDEBAR_UNKNOWN_KIND' // kind 不在 plugin registry 里
  | 'RIGHT_SIDEBAR_STATE_TOO_LARGE' // 单 tab state JSON 序列化 > 16KB
  // iOS Simulator Host。code 是可跨 IPC 暴露的稳定业务分类；底层命令、路径和
  // subprocess message 必须只留在 Main 日志，不能作为 IpcError.message 返回。
  | 'INVALID_ARGUMENT'
  | 'INSTANCE_NOT_FOUND'
  | 'INSTANCE_NOT_OWNED'
  | 'SIMULATOR_ATTACHED_ELSEWHERE'
  | 'SESSION_INSTANCE_LIMIT_REACHED'
  | 'DEVICE_CONTROL_NOT_GRANTED'
  | 'DEVICE_BUSY'
  | 'AGENT_MUTATION_PAUSED'
  | 'MUTATION_CANCELLED'
  | 'LEASE_EXPIRED'
  | 'STALE_GENERATION'
  | 'STALE_UI_SNAPSHOT'
  | 'UI_WAIT_TIMEOUT'
  | 'NATIVE_INPUT_UNAVAILABLE'
  | 'INVALID_INSTANCE_STATE'
  | 'SIMULATOR_NOT_FOUND'
  | 'SIMULATOR_BOOT_FAILED'
  | 'SIMULATOR_BOOT_TIMEOUT'
  | 'SIMULATOR_SHUTDOWN_FAILED'
  | 'SIMULATOR_CONTROL_FAILED'
  | 'SIMULATOR_CREATE_FAILED'
  | 'SIMULATOR_DELETE_FORBIDDEN'
  | 'SIMULATOR_DELETE_FAILED'
  | 'PROJECT_NOT_FOUND'
  | 'AMBIGUOUS_XCODE_PROJECT'
  | 'APP_BUILD_FAILED'
  | 'APP_ARTIFACT_INVALID'
  | 'APP_INSTALL_FAILED'
  | 'APP_LAUNCH_FAILED'
  | 'METRO_NOT_READY'
  | 'APP_TERMINATE_FAILED'
  | 'OPEN_URL_FAILED'
  | 'SCREENSHOT_CAPTURE_FAILED'
  | 'RESOURCE_LIMIT_REACHED'
  | 'MEMORY_PRESSURE'
  | 'RECORDING_ALREADY_ACTIVE'
  | 'RECORDING_NOT_FOUND'
  | 'RECORDING_FAILED'
  // RSB terminal tab(PTY 后端 + xterm.js)
  | 'TERMINAL_NOT_FOUND' // 指定 ptyId 不存在(可能已 dispose / 从未创建)
  | 'TERMINAL_SPAWN_FAILED' // node-pty spawn 抛错(权限 / 路径不可达等)
  | 'TERMINAL_SHELL_NOT_FOUND' // 用户偏好的 shell 二进制不在系统上
  | 'TERMINAL_ALREADY_DISPOSED' // 在已 dispose 的 session 上调 restart 等操作
  // 意识(.cindy 装入)
  | 'GHOST_FILE_INVALID' // 不是合法 zip / 缺 ghost.json / 清单不合格 / 超限
  | 'GHOST_HOST_UNSUPPORTED' // 插件包合法，但当前 Cindy 不认识其 schema / capability slot
  | 'GHOST_COMMAND_CONFLICT' // 显式指令与已装意识撞名(装入拒绝)
  | 'GHOST_ID_RESERVED' // id 属官方保留前缀(cindy-),用户通道拒装(防抢注蹭凭证别名)
  // 自定义插件市场源(Git / 本地文件夹)
  | 'MARKET_SOURCE_INVALID' // 来源格式非法 / 本地路径不是目录 / 参数组合不允许
  | 'MARKET_GIT_UNAVAILABLE' // 未安装 Git 或版本 < 2.25(稀疏检出下限)
  | 'MARKET_CLONE_AUTH_FAILED' // 克隆被拒绝:私有仓库未配置认证
  | 'MARKET_CLONE_FAILED' // 克隆/拉取失败:网络、代理或远端其它错误
  | 'MARKET_REF_NOT_FOUND' // 指定的 Git 引用(分支/tag/commit)在远端不存在
  | 'MARKET_MANIFEST_MISSING' // 来源内找不到受支持的 marketplace.json
  // 网关凭据自动下发(model-access)
  | 'MODEL_ACCESS_FAILED' // 拉取/轮换失败(网络或服务端错误),可重试
  | 'MODEL_ACCESS_DISABLED' // 服务端灰度未启用(503)——走手填兜底
  | 'MODEL_ACCESS_UNSUPPORTED' // 企业未接入(403)——XD 网关不可用,不重试
  | 'MODEL_CATALOG_FETCH_DISABLED' // 模型目录远程拉取被禁用(dev 缺省禁网/XDT_DISABLE_MODELS_FETCH),未发起请求
  | 'PLAN_CHANGE_NOT_AVAILABLE' // 当前订阅不能切换到目标套餐，可返回候选列表重选
  // 钉钉机器人连接
  | 'DINGTALK_AUTH_FAILED' // Client ID / Client Secret 被钉钉拒绝
  | 'DINGTALK_NETWORK_FAILED' // 钉钉凭证校验接口不可达
  | 'DINGTALK_STREAM_CONNECTION_FAILED' // 凭证有效，但 Stream WebSocket 未建立
  // 个人资料自助修改(settings → 用户卡片;服务端直写)
  | 'PROFILE_AVATAR_UPLOAD_FAILED' // 头像经 oss-server 预签名直传失败(presign 或 PUT 阶段)
  | 'PROFILE_UPDATE_FAILED' // PATCH /api/me/profile 失败(网络 / 服务端拒绝)
  // 本机 HTML 页面打开到系统浏览器
  | 'BROWSER_FILE_INVALID_TARGET'
  | 'BROWSER_FILE_PATH_NOT_ALLOWED'
  | 'BROWSER_FILE_UNSUPPORTED_TYPE'
  | 'BROWSER_FILE_NOT_FOUND'
  | 'BROWSER_FILE_OPEN_FAILED'
  // 会话分享(.cshare 导出/导入)
  | 'SHARE_FILE_INVALID' // 不是 .cshare / 头或 manifest 损坏 / payload 不是 zip
  | 'SHARE_PASSWORD_REQUIRED' // 文件已加密但未提供密码
  | 'SHARE_PASSWORD_WRONG' // GCM tag 校验失败:密码错误或文件被篡改
  | 'SHARE_VERSION_UNSUPPORTED' // 包要求的 reader 版本高于本端
  | 'SHARE_CONFLICT' // 同 sdkSessionId/threadId 的会话或转录已存在
  | 'SHARE_EXPORT_FAILED' // 导出编排失败(含超出体积上限)
  | 'SHARE_IMPORT_FAILED' // 导入编排失败(已回滚)
  | 'SHARE_WORKTREE_NOT_GIT' // 导入勾选 worktree 但所选目录不在 git 仓库内
  | 'SHARE_WORKTREE_FAILED' // 导入时 worktree 创建失败(已中止导入)
  // 主题导入(local-themes:import)
  | 'THEME_NOT_A_FILE' // 选中路径不是普通文件
  | 'THEME_FILE_TOO_LARGE' // 超 4MB 上限
  | 'THEME_UNSUPPORTED_FILE' // 无法识别为 VSCode / Obsidian 主题
  | 'THEME_CONTRAST_UNSUPPORTED' // 主题色板无法满足控件对比度约束
  | 'THEME_USES_INCLUDE' // VSCode 主题含 include(需基底才能完整解析)
  | 'THEME_WRITE_ERROR' // 落盘失败(权限/磁盘)
  | 'THEME_IMPORT_INTERNAL' // 意外异常
  // 客户端日志上报(log-upload:upload-now)。四种失败要能被 renderer 区分成不同文案:
  // 「本构建没配上报目标」「还没同意隐私政策」「采到 0 条」「网络失败」是四种不同的用户处置。
  | 'LOG_UPLOAD_UNAVAILABLE' // 本构建未配置上报目标 = 功能整体关闭
  | 'PRIVACY_CONSENT_REQUIRED' // 未明示同意《隐私政策》
  | 'LOG_UPLOAD_EMPTY' // 采集后没有任何可上报的记录
  | 'LOG_UPLOAD_FAILED' // 上传失败(离线 / 被拒 / 超时)
  | 'LOG_UPLOAD_BUSY'; // 已有一次上报在进行中

export interface IpcError {
  code: IpcErrorCode;
  message: string;
}

const IPC_ERROR_CODES: ReadonlySet<IpcErrorCode> = new Set<IpcErrorCode>([
  'INVALID_PARAMS',
  'NOT_FOUND',
  'INTERNAL',
  'ALREADY_EXISTS',
  'IDENTITY_CONFLICT',
  'PRECONDITION_FAILED',
  'MAKER_MEMORY_NOT_READY',
  'SCHEDULER_NOT_READY',
  'PERMISSION_DENIED',
  'UNSUPPORTED_CAPABILITY',
  'APP_SHORTCUTS_WRITE_FAILED',
  'NO_ACTIVE_TURN',
  'SESSION_RUNNING',
  'REMOTE_PROVIDER_UPDATING',
  'REMOTE_PROVIDER_UNSUPPORTED',
  'REMOTE_NATIVE_OAUTH_UNAVAILABLE',
  'REMOTE_MODEL_SWITCH_ROUTE_CHANGE',
  'NO_LIVE_QUERY',
  'STALE_DIFF',
  'PUSH_LEASE_EXPIRED',
  'PUSH_NO_REMOTE',
  'MARK_DONE_FAILED',
  'SOURCE_NEVER_RAN',
  'NO_PRIOR_ASSISTANT',
  'CODEX_FORK_STATE_UNAVAILABLE',
  'FORK_UNSUPPORTED_HISTORY',
  'REWIND_GIT_CONFLICT',
  'REWIND_GIT_FAILED',
  'REWIND_UNSUPPORTED_HISTORY',
  'REWIND_TARGET_NOT_LATEST',
  'TURN_CHANGE_GIT_UNAVAILABLE',
  'DUPLICATE_LABEL',
  'WORKER_CREATION_IN_PROGRESS',
  'WORKER_LIMIT_HARD_EXCEEDED',
  'WORKER_NOT_FOUND',
  'ALREADY_IDLE',
  'WORKER_STATE_CHANGED',
  'BUDGET_MODEL_REQUIRES_API_MODE',
  'NO_PROVIDER_FOR_AGENT',
  'PROVIDER_ROUTE_UNAVAILABLE',
  'TITLE_NO_MATERIAL',
  'TITLE_PROVIDER_UNSUPPORTED',
  'GOAL_ALREADY_ACTIVE',
  'GOAL_NOT_FOUND',
  'LEARN_BUSY',
  'LEARN_INVALID_STATE',
  'SSH_CONNECT_FAILED',
  'SSH_AUTH_FAILED',
  'SSH_CONFIG_IO_FAILED',
  'SSH_HOST_NOT_FOUND',
  'SSH_KEY_FILE_NOT_FOUND',
  'SSH_NOT_CONNECTED',
  'SSH_INSTALL_FAILED',
  'SSH_EXEC_FAILED',
  'SSH_AGENT_NOT_INSTALLED',
  'SSH_REMOTE_LS_FAILED',
  'REMOTE_FS_UNAVAILABLE',
  'HOOK_NOT_CONNECTED',
  'HOOK_PREFS_TIMEOUT',
  'HOOK_MULTI_TEAM_UNSUPPORTED',
  'FS_BROWSE_FAILED',
  'DEVICE_LINK_UNAVAILABLE',
  'DEVICE_LINK_NOT_CONNECTED',
  'DEVICE_LINK_STANDBY',
  'DEVICE_LINK_DEVICE_OFFLINE',
  'DEVICE_LINK_REMOTE_DISABLED',
  'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
  'DEVICE_LINK_ACCESS_REVOKED',
  'DEVICE_LINK_CONTROL_DISABLED',
  'DEVICE_LINK_TIMEOUT',
  'DEVICE_LINK_DEVICE_UNRESPONSIVE',
  'DEVICE_LINK_VERSION_MISMATCH',
  'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
  'REMOTE_WORKDIR_INVALID',
  'REMOTE_WORKDIR_NOT_FOUND',
  'REMOTE_WORKDIR_NOT_DIRECTORY',
  'REMOTE_WORKDIR_UNAVAILABLE',
  'SESSION_REFERENCE_UNAVAILABLE',
  'SESSION_REFERENCE_UNSUPPORTED',
  'RIGHT_SIDEBAR_TOO_MANY_TABS',
  'RIGHT_SIDEBAR_UNKNOWN_KIND',
  'RIGHT_SIDEBAR_STATE_TOO_LARGE',
  'INVALID_ARGUMENT',
  'INSTANCE_NOT_FOUND',
  'INSTANCE_NOT_OWNED',
  'SIMULATOR_ATTACHED_ELSEWHERE',
  'SESSION_INSTANCE_LIMIT_REACHED',
  'DEVICE_CONTROL_NOT_GRANTED',
  'DEVICE_BUSY',
  'AGENT_MUTATION_PAUSED',
  'MUTATION_CANCELLED',
  'LEASE_EXPIRED',
  'STALE_GENERATION',
  'STALE_UI_SNAPSHOT',
  'UI_WAIT_TIMEOUT',
  'NATIVE_INPUT_UNAVAILABLE',
  'INVALID_INSTANCE_STATE',
  'SIMULATOR_NOT_FOUND',
  'SIMULATOR_BOOT_FAILED',
  'SIMULATOR_BOOT_TIMEOUT',
  'SIMULATOR_SHUTDOWN_FAILED',
  'SIMULATOR_CONTROL_FAILED',
  'SIMULATOR_CREATE_FAILED',
  'SIMULATOR_DELETE_FORBIDDEN',
  'SIMULATOR_DELETE_FAILED',
  'PROJECT_NOT_FOUND',
  'AMBIGUOUS_XCODE_PROJECT',
  'APP_BUILD_FAILED',
  'APP_ARTIFACT_INVALID',
  'APP_INSTALL_FAILED',
  'APP_LAUNCH_FAILED',
  'METRO_NOT_READY',
  'APP_TERMINATE_FAILED',
  'OPEN_URL_FAILED',
  'SCREENSHOT_CAPTURE_FAILED',
  'RESOURCE_LIMIT_REACHED',
  'MEMORY_PRESSURE',
  'RECORDING_ALREADY_ACTIVE',
  'RECORDING_NOT_FOUND',
  'RECORDING_FAILED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_SPAWN_FAILED',
  'TERMINAL_SHELL_NOT_FOUND',
  'TERMINAL_ALREADY_DISPOSED',
  'GHOST_FILE_INVALID',
  'GHOST_HOST_UNSUPPORTED',
  'GHOST_COMMAND_CONFLICT',
  'GHOST_ID_RESERVED',
  'MARKET_SOURCE_INVALID',
  'MARKET_GIT_UNAVAILABLE',
  'MARKET_CLONE_AUTH_FAILED',
  'MARKET_CLONE_FAILED',
  'MARKET_REF_NOT_FOUND',
  'MARKET_MANIFEST_MISSING',
  'MODEL_ACCESS_FAILED',
  'MODEL_ACCESS_DISABLED',
  'MODEL_ACCESS_UNSUPPORTED',
  'MODEL_CATALOG_FETCH_DISABLED',
  'PLAN_CHANGE_NOT_AVAILABLE',
  'DINGTALK_AUTH_FAILED',
  'DINGTALK_NETWORK_FAILED',
  'DINGTALK_STREAM_CONNECTION_FAILED',
  'PROFILE_AVATAR_UPLOAD_FAILED',
  'PROFILE_UPDATE_FAILED',
  'BROWSER_FILE_INVALID_TARGET',
  'BROWSER_FILE_PATH_NOT_ALLOWED',
  'BROWSER_FILE_UNSUPPORTED_TYPE',
  'BROWSER_FILE_NOT_FOUND',
  'BROWSER_FILE_OPEN_FAILED',
  'SHARE_FILE_INVALID',
  'SHARE_PASSWORD_REQUIRED',
  'SHARE_PASSWORD_WRONG',
  'SHARE_VERSION_UNSUPPORTED',
  'SHARE_CONFLICT',
  'SHARE_EXPORT_FAILED',
  'SHARE_IMPORT_FAILED',
  'SHARE_WORKTREE_NOT_GIT',
  'SHARE_WORKTREE_FAILED',
  'THEME_NOT_A_FILE',
  'THEME_FILE_TOO_LARGE',
  'THEME_UNSUPPORTED_FILE',
  'THEME_CONTRAST_UNSUPPORTED',
  'THEME_USES_INCLUDE',
  'THEME_WRITE_ERROR',
  'THEME_IMPORT_INTERNAL',
  'LOG_UPLOAD_UNAVAILABLE',
  'PRIVACY_CONSENT_REQUIRED',
  'LOG_UPLOAD_EMPTY',
  'LOG_UPLOAD_FAILED',
  'LOG_UPLOAD_BUSY',
]);

export function isIpcErrorCode(code: unknown): code is IpcErrorCode {
  return typeof code === 'string' && IPC_ERROR_CODES.has(code as IpcErrorCode);
}

/**
 * 标准 IpcError 构造器 —— main 的 throwIpcError 与 renderer 侧预检共用同一形状
 * (`[code] message` + err.code),避免两处手写漂移。isIpcError 按 err.code 判定,
 * 不依赖 err.name。
 */
export function createIpcError(
  code: IpcErrorCode,
  message: string,
): Error & { code: IpcErrorCode } {
  const err = new Error(`[${code}] ${message}`) as Error & { code: IpcErrorCode };
  err.code = code;
  return err;
}

export function isIpcError(err: unknown): err is Error & { code: IpcErrorCode } {
  return err instanceof Error && isIpcErrorCode((err as { code?: unknown }).code);
}
