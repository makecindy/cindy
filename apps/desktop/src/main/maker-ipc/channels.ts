/**
 * maker:* IPC channel 名常量。统一收口，禁止 hardcode 字符串。
 *
 * 命名规则：'maker:' + 动作名（kebab-case）。
 * Push channel（main → renderer）以 'maker:event:' 前缀。
 */

export const MAKER_INVOKE = {
  CREATE_SESSION: 'maker:create-session',
  MARK_ORCA_ROLE: 'maker:mark-orca-role',
  /**
   * F-COLLAB: 中途开关协同模式 (Orca workflow toggle)。
   *  - SESSION_ENABLE_ORCA(leadSessionId, {workerAgent}): 在已运行的 lead session 上
   *    创建 workflow + Worker session,并调 setVendorOptions 让 Lead 下一 turn 拿到协同工具。
   *  - SESSION_DISABLE_ORCA(leadSessionId): 销毁 active workflow 下所有 Worker session,
   *    标记 workflow completed,清 Lead 的 orca vendorOptions。
   * 创建 draft 时直接以 vendor='cc' + collaboration.enabled=true 走 CREATE_SESSION
   * 不必走这两条 — Lead session 创建时 vendorOptions 一起带上即可。
   */
  SESSION_ENABLE_ORCA: 'maker:session:enable-orca',
  SESSION_DISABLE_ORCA: 'maker:session:disable-orca',
  CLOSE_SESSION: 'maker:close-session',
  /**
   * 单条 user / assistant 消息本地内容删除。保留后续可见消息，但清当前原生
   * session 绑定；下一次发送以删除后的本地历史重建上下文。
   */
  DELETE_MESSAGE: 'maker:message:delete',
  ABORT_SESSION: 'maker:abort-session',
  SEND: 'maker:send',
  STEER: 'maker:steer',
  GET_CONTEXT_USAGE: 'maker:get-context-usage',
  INPUT_GET_PROJECTION: 'maker:input:get-projection',
  INPUT_ENQUEUE: 'maker:input:enqueue',
  INPUT_COMPACT: 'maker:input:compact',
  INPUT_STEER: 'maker:input:steer',
  INPUT_STOP: 'maker:input:stop',
  INPUT_RESUME: 'maker:input:resume',
  INPUT_RETRY_LAST_ERROR: 'maker:input:retry-last-error',
  INPUT_CLEAR_ERROR: 'maker:input:clear-error',
  /**
   * Renderer 侧 auth-retry 放弃（catch 或 guard fall-through）时调用，告知 main 补落持久化。
   * main 侧在相同 isRemoteAuthRetry 条件下跳过了 onTurnErrorEvent；此 IPC 覆盖"未重试/重试失败"两路。
   */
  PERSIST_TURN_ERROR_DEFERRED: 'maker:persist-turn-error-deferred',
  INPUT_REMOVE: 'maker:input:remove',
  INPUT_UPDATE_TEXT: 'maker:input:update-text',
  /** 整条内容替换(文本+附件+mentions),排队消息复用 composer 编辑的保存入口。 */
  INPUT_UPDATE_CONTENT: 'maker:input:update-content',
  INPUT_MOVE: 'maker:input:move',
  INPUT_SET_EXPANDED: 'maker:input:set-expanded',
  INPUT_SET_INTERACTION_LOCK: 'maker:input:set-interaction-lock',
  INPUT_SET_EDIT_LOCK: 'maker:input:set-edit-lock',
  INPUT_CLEAR_SESSION: 'maker:input:clear-session',
  LIST_ACTIVE: 'maker:list-active',
  /**
   * 查询当前是否有 session 在 turn 中(SDK 子进程正在跑一轮)。
   * 用于 WindowControls 关闭按钮: 无 in-flight 时跳过确认框直接关; 有 in-flight 时弹框警示。
   * 来源: register.ts 的 SessionTurnActivityTracker (随 status:isRunning / done / close 更新)。
   * maker 未 init 时由 ipc handler 兜底返回 false (splash / login 阶段没有 session)。
   */
  ANY_SESSION_IN_TURN: 'maker:any-session-in-turn',
  /**
   * 查询**指定** session 是否正在 turn 中(per-session 版的 ANY_SESSION_IN_TURN)。只读。
   * 供控制端 stall 看门狗在「卡住 Generating 但久未收到 push」时,向被控端核实该会话的真实
   * 运行态:答 false 才安全地把控制端卡死的 turn 收尾,绝不误杀真正在跑的慢 turn。
   * 来源同 ANY_SESSION_IN_TURN:SessionTurnActivityTracker OR 该 session 的 isTurnRunning();
   * maker 未 init / 未知 session → false。
   */
  SESSION_IN_TURN: 'maker:session-in-turn',
  /**
   * 查询指定会话是否存在「turn 已结束但 CC 子进程仍在调模型」的后台活动(后台
   * 子 agent 等)。只读;来源 = claude-session-background-activity(loopback proxy
   * 的 per-session API 活动信号)。maker 未 init / 未知会话 → { active: false }。
   */
  SESSION_BACKGROUND_ACTIVITY: 'maker:session-background-activity',
  /**
   * 列出当前处于后台活动态的全部会话 id。只读;renderer 侧边栏(全局 store)挂载时
   * 的初始快照,后续靠 SESSION_BACKGROUND_ACTIVITY_CHANGED push 增量维护。
   * maker 未 init → { sessionIds: [] }。
   */
  LIST_SESSION_BACKGROUND_ACTIVITY: 'maker:session-background-activity:list',
  /**
   * 一键停止指定会话的全部任务:关闭该会话的常驻 agent 进程(maker.closeSession)，
   * 当前 turn 与进程内后台子 agent 一并终止。会话本身可续 —— 下次发消息按 resume 自动重建。
   * 这是 renderer/main 运行态不一致时仍须可用的最终止损入口，不受 isTurnRunning 限制。
   */
  STOP_SESSION_BACKGROUND_TASKS: 'maker:session-background-tasks:stop',
  /**
   * 精确停止会话内**单个**后台任务(run_in_background 的 Bash / 后台 subagent)。
   * 入参 (sessionId, taskId)。与 STOP_SESSION_BACKGROUND_TASKS(关闭整个 agent 进程)
   * 不同:只停指定 taskId,当前 turn 与其他后台任务不受影响。任务已结束 / 会话未
   * 加载(子进程不存在,后台任务必然已死)→ 幂等成功;旧 SDK / 旧远端 daemon 不支持
   * → UNSUPPORTED_CAPABILITY。
   */
  STOP_AGENT_TASK: 'maker:agent-task:stop',
  /**
   * 列出会话当前仍在运行的后台任务({taskId, taskType?, toolUseId?, title?})。只读;
   * renderer 挂载或 reloadMessages 清空 taskUpdates 后,用它补回「订阅前已启动」的
   * 存量任务(事件流仍是唯一实时源)。maker 未 init / 未知会话 → { tasks: [] }。
   */
  LIST_SESSION_BACKGROUND_TASKS: 'maker:session-background-tasks:list',
  /**
   * 读取某个 workflow(Workflow 工具的 local_workflow 任务)的逐 agent 进度树。只读。
   * 入参 (sessionId, taskId);main 从活跃会话拿 workDir + sdkSessionId,推导出 Claude Code
   * 的 workflows 记录目录、按 taskId 匹配 wf_*.json 解析。数据源是 SDK 内部产物(无公开契约),
   * 读不到 / 解析失败一律返回 null,renderer 据此回退到 workflow 级卡片。
   */
  GET_WORKFLOW_PROGRESS: 'maker:get-workflow-progress',
  GET_CAPABILITIES: 'maker:get-capabilities',
  /**
   * device-link 远程草稿镜像:控制端为被控设备新建项目草稿时,经隧道读被控端**当前
   * New Maker 草稿**在某 vendor 的完整选择(model/effort/fast/permission/source),1:1 seed
   * 控制端草稿(绝不取控制端本地)。只读、无 sender 依赖、语义在被控端执行 → 进 device-link
   * allowlist。数据源 = newMakerDefaultsCache(renderer 经 SYNC_NEW_MAKER_DRAFT 推)。
   * 旧版被控端无此 channel → 控制端收 CHANNEL_NOT_ALLOWED → 回退被控端 capabilities 默认。
   */
  GET_NEW_MAKER_DEFAULTS: 'maker:get-new-maker-defaults',
  /**
   * device-link 草稿「每个模型 effort/fast」写穿(控制端 → 被控端)。控制端是纯显示端:在远程
   * 项目草稿里改选中 / 非选中模型的 effort/fast 时,不写控制端本地草稿,改经隧道发此 invoke。
   * 被控端 handler 把它转发给**自身 renderer**,renderer 调它原来的本地 setter 写真实草稿:
   *  - 非选中(active=false):setProviderModelChoice / setProviderModelFast(providerModelMemory,
   *    被控端草稿列表行的权威读源)。
   *  - 选中(active=true):额外 patchVendorPrefs 更新 lastByVendor 的激活 effort(被控端 trigger 读源),
   *    fast 经 providerModelMemory 已覆盖 trigger。
   * 变更经既有 SYNC_* 自动 re-mirror + 广播 NEW_MAKER_DRAFT_CHANGED 回控制端镜像。
   * 入参 = { agent:'claude-code'|'codex', providerId, modelId, effort?, fast?, active? }。
   */
  APPLY_NEW_MAKER_DRAFT_PREF: 'maker:apply-new-maker-draft-pref',
  /**
   * device-link 草稿「新建会话默认启用 worktree」写穿(控制端 → 被控端)。worktree 勾选记忆
   * 是 vendor 无关的 newMakerDraft 根字段,校验形状与模型 pref 完全不同(无 modelId/providerId),
   * 硬塞进 APPLY_NEW_MAKER_DRAFT_PREF 会破坏其形状校验语义,故独立窄 channel。
   * 被控端 handler 校验布尔后转发给**自身 renderer**(WORKTREE_PREF_APPLY),renderer
   * setWorktreePreference 按字段写真实草稿;变更经既有 SYNC_NEW_MAKER_DRAFT re-mirror +
   * NEW_MAKER_DRAFT_CHANGED 广播回控制端。入参 = { worktreeEnabled: boolean }。
   * 旧被控端无此 channel → CHANNEL_NOT_ALLOWED → 控制端吞掉降级(勾选仅本次草稿生效)。
   */
  APPLY_NEW_MAKER_WORKTREE_PREF: 'maker:apply-new-maker-worktree-pref',
  LIST_AVAILABLE_AGENTS: 'maker:list-available-agents',
  /**
   * Palette `/` 命令三源 (palette refactor):
   *  - LIST_DESKTOP_COMMANDS    : main 进程 DesktopCommandRegistry 的命令(/help /clear ...)
   *  - LIST_AGENT_COMMANDS      : agent 子类硬编码白名单(/compact 等)
   *  - LIST_AGENT_SKILLS        : agent 用户/项目目录扫出的 .md skill
   *  - EXECUTE_DESKTOP_COMMAND  : 触发某个 desktop 命令的 execute(); 命令本身的 UI 副作用
   *                                通过 MAKER_PUSH.DESKTOP_COMMAND_TRIGGERED 反推 renderer
   */
  LIST_DESKTOP_COMMANDS: 'maker:list-desktop-commands',
  EXECUTE_DESKTOP_COMMAND: 'maker:execute-desktop-command',
  LIST_AGENT_COMMANDS: 'maker:list-agent-commands',
  LIST_AGENT_SKILLS: 'maker:list-agent-skills',
  SCAN_AT_RESOURCES: 'maker:scan-at-resources',
  /**
   * "agent 自己认识的本地 customization 全集"。
   * 跟 LIST_AGENT_SKILLS 不同: 这条不过滤 disabled, 不去重, 区分 kind (skill/command/agent/...)。
   * 给 SkillHub 这类外部消费者用; ChatInput 走 LIST_AGENT_{COMMANDS,SKILLS} + LIST_DESKTOP_COMMANDS。
   */
  LIST_CUSTOMIZATIONS: 'maker:list-customizations',
  /** Resolve a pending interaction (permission / ask_user_question / plan_review) */
  RESOLVE_INTERACTION: 'maker:resolve-interaction',
  /**
   * Cindy 自有顶层 Renderer 专用的插件 Secret 提交窄桥。
   * 不进入通用 interaction/device-link transport。
   */
  PLUGIN_SETUP_SUBMIT_INLINE: 'maker:plugin-setup:submit-inline',
  /** Snapshot the session's currently-pending interactions (rebuild panel on open/reconnect/refresh) */
  GET_PENDING_INTERACTIONS: 'maker:get-pending-interactions',
  // 运行时切换 (Phase B)
  SET_MODEL: 'maker:set-model',
  /**
   * session-agent-switch:同一会话切换 agent 引擎(claude-code ↔ codex)。
   * 入参 = (sessionId, targetAgentKind, model, providerId?);handler 见
   * sessionAgentSwitchHandler.ts(交接构造 + DB 提交 + 边界行 + 新引擎重建)。
   * 与 SET_MODEL 的边界:同引擎换模型走 SET_MODEL,跨引擎必须走本 channel。
   */
  SWITCH_SESSION_AGENT: 'maker:switch-session-agent',
  /**
   * 只读查询下一条消息发送时才会应用的跨 Agent 切换意图。
   * device-link 控制端用它在重连 / 重进会话后恢复权威展示。
   */
  GET_SESSION_AGENT_SWITCH_INTENT: 'maker:get-session-agent-switch-intent',
  SET_EFFORT: 'maker:set-effort',
  SET_PERMISSION_MODE: 'maker:set-permission-mode',
  SET_FAST_MODE: 'maker:set-fast-mode',
  /** 计划模式一级开关(与 permissionMode 正交), runtime-only; 持久化由 renderer sessions:update / device-link 回流负责 */
  SET_PLAN_MODE: 'maker:set-plan-mode',
  /** 会话导出 HTML(pi 原生 export_html)。主进程弹保存对话框 + 导出 + 在文件管理器中显示;返回写入路径或 null(取消)。 */
  EXPORT_SESSION_HTML: 'maker:export-session-html',
  /** 手动压缩会话上下文(pi 原生 compact,可带聚焦指令)。返回 {tokensBefore?, estimatedTokensAfter?} 或 null(会话不在/不支持)。 */
  COMPACT_SESSION: 'maker:compact-session',
  /** 读取当前 live agent 的同会话原生分支树(pi get_tree)。 */
  GET_SESSION_TREE: 'maker:get-session-tree',
  /** 切换同会话原生分支并原子重建 Cindy 可见消息时间线。 */
  NAVIGATE_SESSION_TREE: 'maker:navigate-session-tree',
  /**
   * 旧控制端的会话模型预设写穿兼容 channel。新控制端统一经 APPLY_NEW_MAKER_DRAFT_PREF 写被控端
   * providerModelMemory 全局预设;旧控制端仍发此 invoke 时,被控端 renderer 也会将其收敛到同一
   * 全局预设,并保留 session scoped 回流供旧控制端显示。入参 =
   * { sessionId, agent:'claude-code'|'codex', providerId, model, effort?, fast? }。
   */
  SET_SESSION_MODEL_PREF: 'maker:set-session-model-pref',
  /**
   * renderer → main 单向镜像「模型显示/隐藏」override(modelVisibilityPrefs)。
   * override 真源仍在 renderer localStorage;main 只缓存一份内存副本,供 IM `/model`
   * 派生模型列表时复用同一套可见性过滤(两端列表口径一致)。fire-and-forget,不落盘。
   */
  MODEL_VISIBILITY_SYNC: 'maker:model-visibility:sync',
  /**
   * 「模型 / 供应商停用」override 写入(model-disable-store,main 侧持久化真源)。
   * 入参 = { kind:'model', providerId, modelIds: string[], disabled: boolean }
   *      | { kind:'provider', providerId, disabled: boolean }。
   * 成功后广播 PROVIDER_CHANGED,renderer / device-link 经 PROVIDER_LIST 拿到烘焙了
   * suspended / model.disabled 标志的新视图。设置类写操作:仅本机主页面可调,
   * **不进 device-link allowlist**(远程改被控端全局设置越权,见 allowlist.ts 准入判据)。
   */
  MODEL_DISABLE_SET: 'maker:model-disable:set',
  /**
   * Owner-scoped provider display-order override.
   * Input = { dataOwnerId: string | null; ownerGeneration: number; providerIds: string[] }.
   * Settings mutation: local trusted renderer only; deliberately excluded from the
   * device-link allowlist.
   */
  PROVIDER_ORDER_SET: 'maker:provider:order:set',
  /** Visual Settings UI only: read/write/reset a per-provider × runtime × model price estimate. */
  MODEL_PRICE_OVERRIDE_GET: 'maker:model-price-override:get',
  MODEL_PRICE_OVERRIDE_SET: 'maker:model-price-override:set',
  MODEL_PRICE_OVERRIDE_RESET: 'maker:model-price-override:reset',
  // 附加只读引用目录 — 走 closure 推送; DB 持久化由 renderer 同步调
  // local-db:sessions:update (跟 SET_MODEL / sessionService.update 双 IPC 协调先例一致)
  SET_EXTRA_DIRS: 'maker:set-extra-dirs',
  // 未来 MetaAgent 入口（占位）
  RUN: 'maker:run',
  // Chat utility (Stage 2 C1) — 不是 session 级 API,但走 maker.* 命名空间统一管理
  GENERATE_TITLE: 'maker:generate-title',
  // 会话自动起名(权威实现在 main):立即占位 + 智能标题覆盖,条件写保证 user rename wins。
  // 本机发送由 renderer 触发;device-link 远控由被控端 enqueue 直接调同一实现。
  AUTO_TITLE: 'maker:auto-title',
  // 重命名输入框 Magic 按钮:按会话最新对话内容重新生成标题(读 DB 素材,失败返 null)
  REGENERATE_TITLE: 'maker:regenerate-title',
  HELP_ASK: 'maker:help:ask',
  /**
   * Help-assistant 反馈草稿 (Phase 1):用户对某条回答不满时,点 👎 → 弹小表单 →
   * 创建一条 draft 落本地 `<userData>/help-feedback-drafts.json`,不发任何远程。
   * Phase 2 会加一个 submit-to-GitHub 动作(同 PAT 配置 + 去重相同 open issue)。
   */
  HELP_FEEDBACK_CREATE: 'maker:help:feedback:create',
  /**
   * /issues 页面的「我的 Issue」列表。三路合并去重,主次不要记反:
   * 平台通道(按 Cindy 登录态取「我提交过的 issue」,唯一给实时状态且跨设备的来源)
   * + 本机提交账本(平台未就绪时的兜底)
   * + 用户自己的 GitHub 身份(**可选增强**,没有时列表照常工作)。
   *
   * 查询型 handler,失败时 renderer 仍要靠账本渲染,故返回 { success }
   * 风格而不是 throwIpcError(见 engineering-conventions §2 的例外)。
   */
  MY_ISSUES_LIST: 'maker:issues:list-mine',
  /**
   * /issues 的**首屏快照**(上次查询成功时落盘的列表镜像)。进页面先渲染它,
   * 避免空等远端;fresh 一到即整体接管。非权威、可重建,详见 myIssuesSnapshotStore。
   */
  MY_ISSUES_SNAPSHOT: 'maker:issues:snapshot-mine',
  WRITE_PLAN_FILE: 'maker:write-plan-file',
  // Rewind / Fork (Stage 2 C2) — 取代老 cc-agent:rewind:* + local-db:sessions:fork
  REWIND_PREVIEW: 'maker:rewind:preview',
  REWIND_COMMIT: 'maker:rewind:commit',
  FORK: 'maker:fork',
  FORK_STRIP_ENCRYPTED: 'maker:fork-strip-encrypted',
  // Agent 鉴权 (取代老 codex:auth:*) —— 走 Maker.{getAgentAuthState/triggerAgentLogin/...}
  AUTH_GET_STATE: 'maker:auth:get-state',
  AUTH_TRIGGER_LOGIN: 'maker:auth:trigger-login',
  AUTH_CANCEL_LOGIN: 'maker:auth:cancel-login',
  AUTH_LOGOUT: 'maker:auth:logout',
  // 网关 API key presence-only 探测(只回 { present: boolean },不回密钥材料)——
  // 供 device-link 控制端(手机 / 远程桌面)判断折扣版是否置灰;判定真相在被控端
  // (key 存被控端 safeStorage)。见 device-link allowlist 的窄口径例外注释。
  API_KEY_PRESENT: 'maker:api-key:present',
  // Agent 联合状态 (取代老 codex:binary:status) —— 走 Maker.getAgentStatus
  AGENT_STATUS: 'maker:agent:status',
  // Agent 二进制 --version 输出 (About 面板用) —— spawn binary, 进程内缓存
  AGENT_BINARY_VERSION: 'maker:agent:binary-version',
  // Agent 今日累计 (取代老 codex:usage:today) —— 走 host 的 readAgentTodayUsage
  USAGE_TODAY: 'maker:usage:today',
  USAGE_ACCOUNT: 'maker:usage:account',
  // Codex app-server 官方控制面:完整额度/reset 次数读取 + desktop 预签发幂等 offer 消耗。
  USAGE_CODEX_RATE_LIMITS: 'maker:usage:codex-rate-limits',
  USAGE_CODEX_RATE_LIMIT_RESET: 'maker:usage:codex-rate-limit-reset',
  // Claude 订阅账号余量 (oauth/usage 端点 + unified headers 双源, cached-first) — 状态栏 chip 用
  USAGE_CLAUDE_SUBSCRIPTION: 'maker:usage:claude-subscription',
  // device-link v1 模型单价表:保留 modelId → USD/Mtok 扁平形状,旧控制端继续可读。
  USAGE_MODEL_PRICING: 'maker:usage:model-pricing',
  // Desktop renderer v2:Cindy AI `/models` 下发的 XD 原生报价。
  USAGE_MODEL_PRICING_V2: 'maker:usage:model-pricing-v2',
  // 非 XD Provider 的 Catalog 参考价与用户覆盖；只用于 BYOK / 订阅估值。
  USAGE_REFERENCE_MODEL_PRICING: 'maker:usage:reference-model-pricing',
  // 用量历史聚合 (daily_spend + daily_model_usage, main 侧算好 streak/异常/估算) — 首页仪表盘用
  USAGE_HISTORY: 'maker:usage:history',
  // Memory 控制 — 走 Maker.{getAgentMemoryStatus/setAgentMemory/resetAgentMemory},
  // 各 agent 子类落地 (Claude 改 SDK Settings.autoMemoryEnabled, Codex 调 app-server
  // experimentalFeature/enablement/set + memory/reset RPC)。
  MEMORY_GET: 'maker:memory:get',
  MEMORY_SET: 'maker:memory:set',
  MEMORY_RESET: 'maker:memory:reset',
  // Maker Memory (跨 agent 共享, host 自己管的 workdir-scoped 记忆)
  //   - SET_ENABLED: 切开关时**立即**调 manager.enable()/disable() — 联动调
  //     agent.setMemory(false) 关原生; 跟 startSession opts.makerMemoryEnabled 双轨
  //     (后者保证 per-session 一致, 前者保证 UI toggle 瞬时生效)
  //   - RESET: 删 <userData>/maker-memory/ 全部内容 + close db pool
  MAKER_MEMORY_SET_ENABLED: 'maker:maker-memory:set-enabled',
  MAKER_MEMORY_RESET: 'maker:maker-memory:reset',
  /**
   * 启动期 renderer 同步 main 持久化的三个 memory 开关 (maker / claudeCode / codex)。
   * main 的 <userData>/memory-settings.json 是 source of truth, renderer localStorage
   * 只是 UI 即时态镜像 — 启动时拉一次 + 用户 toggle 时同步, 保证刷新/重启后 UI 跟实际对齐。
   */
  MEMORY_GET_SETTINGS: 'maker:memory:get-settings',
  MEMORY_GET_SETTINGS_STATE: 'maker:memory:get-settings-state',
  /** 把旧 renderer/native memory 的关闭意图迁移为 main 端 maker:false override。 */
  MEMORY_PRESERVE_LEGACY_MAKER_DISABLED: 'maker:memory:preserve-legacy-maker-disabled',
  MEMORY_RESET_SETTINGS: 'maker:memory:reset-settings',
  /** IM 普通会话默认 agent/model/effort/provider；仅影响新 IM session 和 Feishu `/new`。 */
  IM_DEFAULT_SETTINGS_GET: 'maker:im-default-settings:get',
  IM_DEFAULT_SETTINGS_SET: 'maker:im-default-settings:set',
  IM_DEFAULT_SETTINGS_RESET: 'maker:im-default-settings:reset',
  /** Claude / Codex 子代理模型覆盖；null 表示沿用 agent 原生逻辑。 */
  SUBAGENT_MODEL_SETTINGS_GET: 'maker:subagent-model-settings:get',
  SUBAGENT_MODEL_SETTINGS_SET: 'maker:subagent-model-settings:set',
  SUBAGENT_MODEL_SETTINGS_RESET: 'maker:subagent-model-settings:reset',
  SILENT_ENCRYPTED_RETRY_GET: 'maker:silent-encrypted-retry:get',
  SILENT_ENCRYPTED_RETRY_SET: 'maker:silent-encrypted-retry:set',
  SILENT_ENCRYPTED_RETRY_RESET: 'maker:silent-encrypted-retry:reset',
  /**
   * Claude Code 自动上下文压缩触发阈值 —— 存在 <userData>/compaction-settings.json。
   * SET 后仅对新 session 生效, 已运行的 Claude Code 子进程 env 不变。
   */
  COMPACTION_GET_PCT: 'maker:compaction:get-pct',
  COMPACTION_GET_STATE: 'maker:compaction:get-state',
  COMPACTION_SET_PCT: 'maker:compaction:set-pct',
  COMPACTION_RESET_PCT: 'maker:compaction:reset-pct',
  /**
   * LSP Beta 开关 ——
   *  - GET: renderer 启动期同步 localStorage 镜像
   *  - SET: 用户 toggle 时落 <userData>/lsp-mode-settings.json, 仅对**新 session** 生效
   *         (mcp providers isEnabled 在 session.start 时 evaluate, 已开 session 不变)
   * 默认 false (Phase 1 Beta, 新装包不自动注入 lsp_* 工具)。
   */
  LSP_MODE_GET: 'maker:lsp-mode:get',
  LSP_MODE_SET: 'maker:lsp-mode:set',
  /**
   * 聊天嵌入开关 (Phase 1.2 chat-history-embedder) ——
   *  - GET: 启动期 renderer 同步 localStorage 镜像
   *  - SET: 用户 toggle 时落 <userData>/chat-embedding-settings.json, 立即触发
   *         chat-history-embedder.setChatEmbeddingEnabled(); 第一次开启时
   *         初始化 cutoff (embedding_meta.chat_embedding_started_at)。
   * 默认 false (新装包不会自动产生 ~¥0.09/天 embedding 费用)。
   */
  CHAT_EMBEDDING_GET: 'maker:chat-embedding:get',
  CHAT_EMBEDDING_SET: 'maker:chat-embedding:set',
  CHAT_EMBEDDING_RESET: 'maker:chat-embedding:reset',
  /**
   * Git safety workflow: automatic XDT snapshot commits and the dependent
   * Codex file rewind entry. Default false; SET writes a user override.
   */
  GIT_SAFETY_GET: 'maker:git-safety:get',
  GIT_SAFETY_SET: 'maker:git-safety:set',
  GIT_SAFETY_RESET: 'maker:git-safety:reset',
  /**
   * 智能通讯录(maker-contacts) ——
   *  - SETTINGS_GET/SET: 功能开关(<userData>/contacts-settings.json), 只 gate agent 侧
   *    cindy_contacts MCP(新 session 生效); 下面的数据 CRUD 通道不受 gate, 设置页
   *    管理 UI 关着开关也能浏览/清理。
   *  - 数据通道: 实体/身份/事件/分组 CRUD + resolve/search/stats, 直达全局
   *    MakerContactsManager(maker-core), 与 session 无关。
   */
  CONTACTS_SETTINGS_GET: 'maker:contacts:settings:get',
  CONTACTS_SETTINGS_SET: 'maker:contacts:settings:set',
  CONTACTS_SYNC_STATUS_GET: 'maker:contacts:sync:status:get',
  CONTACTS_SYNC_ENABLED_SET: 'maker:contacts:sync:enabled:set',
  CONTACTS_SYNC_NOW: 'maker:contacts:sync:now',
  CONTACTS_LIST: 'maker:contacts:list',
  CONTACTS_GET: 'maker:contacts:get',
  CONTACTS_CREATE: 'maker:contacts:create',
  CONTACTS_UPDATE: 'maker:contacts:update',
  CONTACTS_DELETE: 'maker:contacts:delete',
  CONTACTS_MERGE: 'maker:contacts:merge',
  CONTACTS_RESOLVE: 'maker:contacts:resolve',
  CONTACTS_SEARCH: 'maker:contacts:search',
  CONTACTS_STATS: 'maker:contacts:stats',
  CONTACTS_ADD_IDENTITY: 'maker:contacts:add-identity',
  CONTACTS_REMOVE_IDENTITY: 'maker:contacts:remove-identity',
  CONTACTS_APPEND_EVENT: 'maker:contacts:append-event',
  CONTACTS_ADD_RELATION: 'maker:contacts:add-relation',
  CONTACTS_REMOVE_RELATION: 'maker:contacts:remove-relation',
  CONTACTS_DELETE_EVENT: 'maker:contacts:delete-event',
  CONTACTS_GROUPS_LIST: 'maker:contacts:groups:list',
  CONTACTS_GROUPS_CREATE: 'maker:contacts:groups:create',
  CONTACTS_GROUPS_UPDATE: 'maker:contacts:groups:update',
  CONTACTS_GROUPS_DELETE: 'maker:contacts:groups:delete',
  CONTACTS_GROUPS_SET_MEMBERS: 'maker:contacts:groups:set-members',
  CONTACTS_RESET_ALL: 'maker:contacts:reset-all',
  /** macOS 系统通讯录只读拉取(JXA); 非 darwin 抛 UNSUPPORTED_CAPABILITY */
  CONTACTS_SYSTEM_READ: 'maker:contacts:system-read',
  /** vCard 文本解析(renderer 禁止 runtime import maker-core, 解析必须在 main 做) */
  CONTACTS_PARSE_VCF: 'maker:contacts:parse-vcf',
  /** 批量导入(系统通讯录/vCard 共用管道: identity 撞档自动并入, 名字相似进 needsReview) */
  CONTACTS_IMPORT: 'maker:contacts:import',
  /** Codex app-server 当前进程启动时固定下来的鉴权注入方式(oauth-bearer / env-key)。 */
  CODEX_RUNTIME_ROUTE_GET: 'maker:codex-runtime-route:get',
  /**
   * cc 默认路由会话的生效计费路由(proxy transform 按请求观察, 见
   * claude-session-route-registry):'gateway' | 'subscription' | null(未观察到)。
   * 用量 chip 据此显示订阅 / 网关形态, 不用全局活性凭证状态重算。
   */
  CLAUDE_SESSION_ROUTE_GET: 'maker:claude-session-route:get',
  /**
   * Claude.ai 订阅 OAuth 登录 —— 浏览器 OAuth(移植自 cc),凭证落系统 ~/.claude 凭证库
   * (mac Keychain `Claude Code-credentials` / 其它 .credentials.json),与本地 claude 共用、
   * 自动兼容已登录态。与鉴权模式开关正交(像 Codex 的 OAuth 登录独立于 API 模式)。
   *  - STATUS: 返回 { authorized }(系统凭证库是否有 Claude.ai OAuth 登录)
   *  - LOGIN: 拉起浏览器 OAuth,成功后写凭证 + 广播;返回 { authorized }
   *  - LOGOUT: 清凭证(⚠️ 同时登出本地 claude)+ 广播
   *  - CANCEL: 取消进行中的浏览器登录流
   */
  CLAUDE_OAUTH_STATUS: 'maker:claude-oauth:status',
  CLAUDE_OAUTH_LOGIN: 'maker:claude-oauth:login',
  CLAUDE_OAUTH_LOGOUT: 'maker:claude-oauth:logout',
  CLAUDE_OAUTH_CANCEL: 'maker:claude-oauth:cancel',
  // xAI(SuperGrok 订阅)OAuth —— 与 claude-oauth 同形态(login/logout/cancel),
  // 供 responses-bridge 直连 api.x.ai;登录写 safeStorage provider secret 'xai'。
  XAI_OAUTH_LOGIN: 'maker:xai-oauth:login',
  XAI_OAUTH_LOGOUT: 'maker:xai-oauth:logout',
  XAI_OAUTH_CANCEL: 'maker:xai-oauth:cancel',
  /**
   * 模型供应商目录（@cindy/model-providers）—— 只读聚合：内置目录元数据 + 各供应商
   * 实时连接状态（XD=gateway key / Anthropic=Claude.ai OAuth / OpenAI=Codex OAuth）。
   * 供应商的「连接 / 断开」复用各 agent 已有的鉴权通道（CLAUDE_OAUTH_* / AUTH_* / 登录托管），
   * 不另立重复通道。
  */
  PROVIDER_LIST: 'maker:provider:list',
  /**
   * 内置四家模型清单手动刷新。入参仅允许 xd / anthropic / openai / xai；
   * Main 按各家既有真源分派，不接收 URL、凭证或任意执行参数。
   * 属被控端全局账号/目录操作，不进 device-link allowlist。
   */
  PROVIDER_MODELS_REFRESH: 'maker:provider:models-refresh',
  /**
   * Renderer 上报自动刷新时机；只接受 providers-open / model-selector-open，
   * Main 统一处理连接状态、冷却与 in-flight 去重。前台恢复不经 Renderer IPC。
   */
  PROVIDER_MODELS_AUTO_REFRESH: 'maker:provider:models-auto-refresh',
  /**
   * 自定义模型供应商 CRUD（配置入 localDb；update 的 runtime 密钥与配置原子排队）。
   * create/update 入参 = config + runtimeKeys；delete 入参 = providerId。
   * 成功后 main 重算 active-catalog 并广播 PROVIDER_CHANGED（见 MAKER_PUSH）。
   */
  PROVIDER_CUSTOM_CREATE: 'maker:provider:custom:create',
  PROVIDER_CUSTOM_UPDATE: 'maker:provider:custom:update',
  PROVIDER_CUSTOM_DELETE: 'maker:provider:custom:delete',
  /**
   * 自定义 MCP 服务器 CRUD（配置入 localDb，可选 bearer token 另走通用 safe-storage IPC）。
   * list 无入参；create/update 入参 = CustomMcpConfig；delete 入参 = mcpId。
   * 成功后 main 刷新两个 agent 的 mcpProviders 数组并广播 MCP_CHANGED（见 MAKER_PUSH）。
   */
  MCP_CUSTOM_LIST: 'maker:mcp:custom:list',
  MCP_CUSTOM_CREATE: 'maker:mcp:custom:create',
  MCP_CUSTOM_UPDATE: 'maker:mcp:custom:update',
  MCP_CUSTOM_DELETE: 'maker:mcp:custom:delete',
  /**
   * token-only 后置刷新：renderer 在 safeStorage write/remove 完成后调用，触发第二次
   * refreshProviders + invalidateCodex，消除「配置 IPC 完成→token 落盘」之间的竞态窗口。
   * 无入参，无实质 DB 改动。
   */
  MCP_CUSTOM_REFRESH: 'maker:mcp:custom:refresh',
  /**
   * 自定义供应商创建模板（目录 presets 段，纯 UI 模板数据，随 OSS 目录热更）。
   * 返回 { presets: ProviderPreset[] }；无预设时空数组。
   */
  PROVIDER_PRESETS_LIST: 'maker:provider:presets',
  /**
   * 供应商「测试连接」—— 与真实会话同路由口径的最小探测请求（见 maker-host/provider-diagnostics）。
   * 入参 ProviderTestInput（saved: {providerId, agent} / adhoc: 表单未保存值）；
   * 返回查询型结构化结果 ProviderTestResult（{ok, code?, status?, latencyMs}，规则 13 例外条款：
   * renderer 需要 code 渲染分类文案与修复引导）。
   */
  PROVIDER_TEST_CONNECTION: 'maker:provider:test-connection',
  /**
   * 供应商「获取模型列表」—— 用表单值（baseUrl / modelsUrl / key / headers 内存透传）GET
   * 该供应商的列模型端点（见 maker-host/provider-model-fetch）。返回查询型结构化结果
   * ProviderModelsFetchResult（{ok, models?, code?, status?}，规则 13 例外条款：renderer
   * 需要 code 渲染分类文案）。带密钥材料，不进 device-link 白名单（口径同 test-connection）。
   */
  PROVIDER_MODELS_FETCH: 'maker:provider:models-fetch',
  /**
   * 通用 OAuth 供应商（目录 auth.oauth 描述符驱动、非 bespoke 四家）的登录 / 登出 / 取消。
   * 入参 = providerId；login 走 generic-oauth Runner（PKCE 浏览器流），成功后拉动态模型
   * 发现（若描述符声明）并广播 PROVIDER_CHANGED。bespoke 供应商（anthropic/openai/xai）
   * 不走这组通道（各有既有鉴权 IPC）。
   */
  PROVIDER_OAUTH_LOGIN: 'maker:provider:oauth:login',
  PROVIDER_OAUTH_LOGOUT: 'maker:provider:oauth:logout',
  PROVIDER_OAUTH_CANCEL: 'maker:provider:oauth:cancel',
  /**
   * 本机 agent CLI 安装 / 登录态扫描(设置 → 模型供应商「检测建议」用)。
   * 只做存在性 stat、不读凭证内容(规则 23);返回查询型结构化结果
   * { detections: LocalCliDetection[] },扫描失败降级空数组(规则 13 例外条款:
   * renderer 直接按空列表继续渲染,检测建议是增强而非依赖)。只读、无密钥材料。
   */
  PROVIDER_LOCAL_CLI_SCAN: 'maker:provider:local-cli-scan',
  /**
   * 「清单唯一来源是动态发现」的供应商（当前只有 anthropic 订阅）立即重新拉一次清单。
   *
   * 发现失败时 host 只对**暂时性**归因（连不上 / 超时 / 上游 5xx）做有限次退避重试，
   * 且绝不无限轮询；地域拒绝、凭证被拒等确定性答复一次都不重试。所以自动重试停手后，
   * 用户仍需要一个「立刻再试一次」的入口：设置页在失败态下渲染「重试」，点了走这条
   * 通道，并重新开启一轮退避。返回查询型结构化结果 { ok, failure? }（规则 13 例外条款：
   * renderer 要按 failure.kind 渲染分类文案）。只读、无密钥材料。
   *
   * **本通道自身不广播**：列表刷新由发现流程内部收口——成功经 active-catalog 的
   * markChanged、失败经 setAnthropicDiscoveryFailureListener。handler 再广播一次只会让
   * renderer 白 refetch 一遍。
   */
  PROVIDER_MODELS_REDISCOVER: 'maker:provider:models-rediscover',
  // Scheduler (Phase 4) — 9 个 invoke handler，对应 Scheduler 公共 API
  SCHEDULE_LIST: 'maker:schedule:list',
  SCHEDULE_GET: 'maker:schedule:get',
  SCHEDULE_CREATE: 'maker:schedule:create',
  SCHEDULE_UPDATE: 'maker:schedule:update',
  SCHEDULE_DELETE: 'maker:schedule:delete',
  SCHEDULE_PAUSE: 'maker:schedule:pause',
  SCHEDULE_RESUME: 'maker:schedule:resume',
  SCHEDULE_RUN_NOW: 'maker:schedule:run-now',
  /** 表单「测试运行」按钮:立即执行一次前置检查脚本,返回 exit code / 输出 / 耗时。 */
  SCHEDULE_TEST_PRE_RUN_HOOK: 'maker:schedule:test-pre-run-hook',
  /** 表单「AI 生成」:按自然语言描述生成前置检查脚本并落盘,返回可填入的命令。 */
  SCHEDULE_GENERATE_PRE_RUN_HOOK: 'maker:schedule:generate-pre-run-hook',
  SCHEDULE_LIST_RUNS: 'maker:schedule:list-runs',
  /** Sidebar 聚合索引：带 sessionId 的 run + 未读终态 run，避免固定 history limit 截断。 */
  SCHEDULE_LIST_SIDEBAR_INDEX_RUNS: 'maker:schedule:list-sidebar-index-runs',
  /** Automation 列表总开销：按 schedule 去重 session 汇总 sessions.total_cost_usd。 */
  SCHEDULE_LIST_COST_SUMMARIES: 'maker:schedule:list-cost-summaries',
  SCHEDULE_DELETE_RUN: 'maker:schedule:delete-run',
  /** Renderer 在 delete/pause 前查这条 schedule 当前有多少个 in-flight run,>0 时弹二次确认。 */
  SCHEDULE_GET_INFLIGHT_COUNT: 'maker:schedule:get-inflight-count',
  SCHEDULE_GET_RUNTIME_STATE: 'maker:schedule:get-runtime-state',
  /** Sidebar 未读 badge —— 全局未读 run 数量（终态且 read_at IS NULL）。 */
  SCHEDULE_GET_UNREAD_COUNT: 'maker:schedule:get-unread-count',
  /** 用户点 history 的 "Open session" 时调，把该单条 run 标已读。 */
  SCHEDULE_MARK_RUN_READ: 'maker:schedule:mark-run-read',
  /** sidebar 右键 "Automations" → "Mark all as read"：把所有 schedule 下的未读终态 run 一次性标已读。 */
  SCHEDULE_MARK_ALL_RUNS_READ: 'maker:schedule:mark-all-runs-read',
  /** 用户选中某个 schedule 查看 run history 时，把该 schedule 下所有未读终态 run 标已读。 */
  SCHEDULE_MARK_SCHEDULE_RUNS_READ: 'maker:schedule:mark-schedule-runs-read',
  SCHEDULE_LIST_TEMPLATES: 'maker:schedule:list-templates',
  SCHEDULE_CREATE_FROM_TEMPLATE: 'maker:schedule:create-from-template',
  /** script 任务能力选择器的运行时可用性探测(意识装入/唤醒态);只做提示,不过滤清单。 */
  SCHEDULE_SCRIPT_CAPABILITY_STATUS: 'maker:schedule:script-capability-status',
  PROJECT_AUTOMATION_RECONCILE: 'maker:project-automation:reconcile',
  PROJECT_AUTOMATION_LIST_CONSENTS: 'maker:project-automation:list-consents',
  PROJECT_AUTOMATION_REVOKE_CONSENT: 'maker:project-automation:revoke-consent',
  PROJECT_AUTOMATION_UPSERT_SCHEDULE: 'maker:project-automation:upsert-schedule',
  PROJECT_AUTOMATION_REMOVE_SCHEDULE: 'maker:project-automation:remove-schedule',
  // multi-worker Phase 1
  WORKER_CREATE: 'maker:worker:create',
  WORKER_LIST: 'maker:worker:list',
  WORKER_SWITCH_FOCUS: 'maker:worker:switch-focus',
  WORKER_IDLE: 'maker:worker:idle',
  /** New wire contract for automatic done acknowledgements; old peers reject it safely. */
  WORKER_ACKNOWLEDGE_DONE: 'maker:worker:acknowledge-done',
  WORKER_ARCHIVE: 'maker:worker:archive',
  TEAM_END: 'maker:team:end',
  COLLABORATION_SETTINGS_GET: 'maker:collaboration-settings:get',
  COLLABORATION_SETTINGS_SET: 'maker:collaboration-settings:set',
  COLLABORATION_SETTINGS_RESET: 'maker:collaboration-settings:reset',
  AGENT_RESOURCE_SETTINGS_GET: 'maker:agent-resource-settings:get',
  AGENT_RESOURCE_SETTINGS_SET: 'maker:agent-resource-settings:set',
  AGENT_RESOURCE_SETTINGS_RESET: 'maker:agent-resource-settings:reset',
  // Plugin system (Phase 1)
  PLUGINS_LIST: 'maker:plugins:list',
  // Read one plugin's enable state by id — works for plugins hidden from
  // PLUGINS_LIST (HOSTED_ELSEWHERE, e.g. `browser`), which their dedicated
  // Settings sections need to read.
  PLUGINS_GET_STATE: 'maker:plugins:get-state',
  PLUGINS_SET_ENABLED: 'maker:plugins:set-enabled',
  PLUGINS_CLEAR_ENABLED: 'maker:plugins:clear-enabled',
  PLUGINS_SET_PROJECT_ENABLED: 'maker:plugins:set-project-enabled',
  PLUGINS_CLEAR_PROJECT_ENABLED: 'maker:plugins:clear-project-enabled',
  // Browser automation — local browser detection for Settings →「电脑使用」
  BROWSER_STATUS: 'maker:browser:status',
  // Open the headed automation browser so the user can log into sites once.
  BROWSER_OPEN_FOR_LOGIN: 'maker:browser:open-for-login',
  // Android adb automation for Settings -> Computer Use.
  ANDROID_STATUS: 'maker:android:status',
  ANDROID_GET_CONFIG: 'maker:android:get-config',
  ANDROID_SET_DEFAULT_DEVICE: 'maker:android:set-default-device',
  ANDROID_SET_ADB_PATH: 'maker:android:set-adb-path',
  ANDROID_PREPARE_ADB: 'maker:android:prepare-adb',
  // Local desktop computer-use driver detection for Settings →「电脑使用」
  COMPUTER_STATUS: 'maker:computer:status',
  // cua-driver installer for direct computer control.
  COMPUTER_INSTALL_DRIVER: 'maker:computer:install-driver',
  // Quiet cua-driver update check (Settings-open triggered only, never polls).
  COMPUTER_CHECK_UPDATE: 'maker:computer:check-update',
  // Run the cua-driver updater. In-flight is owned by main so it survives the
  // Settings window closing; re-invoking joins the same install promise.
  COMPUTER_UPDATE_DRIVER: 'maker:computer:update-driver',
  // macOS: launch CuaDriver permission flow (Accessibility + Screen Recording).
  COMPUTER_GRANT_PERMISSIONS: 'maker:computer:grant-permissions',
  // macOS: CuaDriver.app 的真实安装图标(授权引导弹窗里给用户当识别参照)。
  COMPUTER_DRIVER_ICON: 'maker:computer:driver-icon',
  // macOS: 当前授权引导生命周期持有的预检快照（不触发新的权限探测）。
  COMPUTER_PERMISSION_GUIDE_STATUS: 'maker:computer:permission-guide-status',
  // macOS:结束原生 app 拖拽，并等待 Main 通过实时 System Settings 行确认结果。
  COMPUTER_PERMISSION_APP_DRAG_END: 'maker:computer:permission-app-drag-end',
  // macOS: 取消在途的 CuaDriver 授权流程(引导弹窗「取消」时收割 grant 子进程)。
  COMPUTER_CANCEL_PERMISSION_GRANT: 'maker:computer:cancel-permission-grant',
  /**
   * 「在新窗口打开」会话多开 —— 新建一个完整 MainLayout 窗口并启动定位到该 session
   * (对标 Codex 多开)。每个窗口都是独立完整窗口, 消息靠 maker:event 全窗口广播
   * 自动同步。窗口生命周期见 main/secondary-windows.ts。
   */
  OPEN_SESSION_IN_NEW_WINDOW: 'maker:open-session-in-new-window',
  /**
   * 右侧栏独立子窗口(RSB window)——「侧边栏在新窗口中显示」全局偏好 + 窗口生命周期。
   * 状态机 / 窗口管理见 main/right-sidebar-window/controller.ts。
   *  - GET_STATE: renderer 启动期拉 { detached, lastOpen, open }
   *  - OPEN / CLOSE: 幂等开(已开则 focus)/ 关子窗口,写 lastOpen
   *  - SET_DETACHED(boolean): 落盘偏好;true 附带开窗,false 附带关窗;返回新 state
   *  - GET_CONTEXT: 子窗口 mount 时拉主窗上报的 { sessionId, workdir, remoteHostId, deviceLinkDeviceId, available }
   *  - READY: 子窗口根组件挂载握手(resolve main 侧 ensureOpen 等待)
   *  - SEND_COMMAND: 主窗把命令(如 open-terminal 快捷键)转发给子窗口,必要时先开窗
   */
  RSB_WINDOW_GET_STATE: 'maker:rsb-window:get-state',
  RSB_WINDOW_OPEN: 'maker:rsb-window:open',
  RSB_WINDOW_CLOSE: 'maker:rsb-window:close',
  RSB_WINDOW_SET_DETACHED: 'maker:rsb-window:set-detached',
  RSB_WINDOW_GET_CONTEXT: 'maker:rsb-window:get-context',
  RSB_WINDOW_READY: 'maker:rsb-window:ready',
  RSB_WINDOW_SEND_COMMAND: 'maker:rsb-window:send-command',
  /**
   * 插件停靠面板独立窗口(ghost panel window)——每 ghostId 一扇窗。
   * 状态机见 main/ghost-panel-window/controller.ts。
   *  - GET_STATE: 拉全量 { <ghostId>: { detached, lastOpen, open } }
   *  - OPEN(ghostId): 幂等开(已开则 focus);资格不符清条目
   *  - SET_DETACHED(ghostId, boolean): true 开窗抽离,false 关窗回停靠;返回新全量 state
   * 首帧同步读走裸 sendSync 通道 'ghost-panel-window:get-state-sync'
   * (与 layout:get / ghosts:list 同模式,规则 7 首帧无跳变)。
   */
  GHOST_PANEL_WINDOW_GET_STATE: 'maker:ghost-panel-window:get-state',
  GHOST_PANEL_WINDOW_OPEN: 'maker:ghost-panel-window:open',
  GHOST_PANEL_WINDOW_SET_DETACHED: 'maker:ghost-panel-window:set-detached',
  /**
   * 会话内 /goal 自主续跑(goal-host)——
   *  - GOAL_SET: 设/替换目标并立刻发首轮。入参 { sessionId, objective, agentKind, budgetTokens? }(budgetTokens 留空=不设预算)
   *  - GOAL_CLEAR: 用户清除目标(删行 + 停续跑 + 推 null 状态)
   *  - GOAL_GET_STATUS: 取某会话当前 goal 扁平状态(GoalStatusPayload | null)
   *  - GOAL_PAUSE: 暂停 active 目标(保留计数,停续跑;可 resume)。入参 sessionId
   *  - GOAL_RESUME: 恢复 paused/blocked 目标(保留计数,streak 归零,空闲则续轮)。入参 sessionId
   *  - GOAL_UPDATE: 更新当前 goal 的目标文本 / 上限,不改全局默认。入参 { sessionId, patch }
   */
  GOAL_SET: 'maker:goal:set',
  GOAL_CLEAR: 'maker:goal:clear',
  GOAL_GET_STATUS: 'maker:goal:get-status',
  GOAL_PAUSE: 'maker:goal:pause',
  GOAL_RESUME: 'maker:goal:resume',
  GOAL_UPDATE: 'maker:goal:update',
} as const;

/**
 * Fire-and-forget channels (renderer → main, `ipcRenderer.send` / `ipcMain.on`)。
 * 跟 MAKER_INVOKE 的区别: 无返回值、不期待 ack, 用于 renderer 把 UI 即时态
 * (typically localStorage 镜像) 推给 main, main 只更新内存缓存供后续工具调用读。
 */
export const MAKER_SEND = {
  /**
   * macOS permission coach: begin a native drag of the real Computer Use app
   * bundle into System Settings. Main validates that the sender is the
   * dedicated guide window before acting. Drag completion is an invoke above
   * because the renderer must wait for Main's live-row confirmation.
   */
  COMPUTER_PERMISSION_APP_DRAG_START: 'maker:computer:permission-app-drag-start',
  /**
   * 把 renderer `newMakerDraft` 的关键子集 (lastByVendor / fastModeByModel /
   * effortByModel) 同步给 main 缓存 (newMakerDefaultsCache)。collab mode spawn
   * worker (enableOrcaInternal / orca-bridge.create_worker) 读这份缓存决定 worker
   * 的 model / effort / fastMode, 让 worker 默认 = "用户在 New Maker 面板该 vendor
   * 当前的选择"。startup 时推一次 + draft 变化时增量推, fire-and-forget。
   */
  SYNC_NEW_MAKER_DRAFT: 'maker:sync-new-maker-draft',
  /**
   * 被控端 renderer → 自身 main:把 providerModelMemory 的全量快照(snapshotForSeed():
   * `${agent}:*` 为模型级全局预设,来源槽为旧 v2 兼容副本)镜像给 main 缓存。device-link 草稿
   * 列表行的真实读源是 providerModelMemory(非选中行 = modelMemory.getEffort/getFast),旧的
   * newMakerDraft.effortByModel 已不再写非选中 → 必须把这一层也镜像出去,控制端才能完整镜像被控端
   * 草稿模型列表(req1)。main 把它并入 getRemoteNewMakerDefaults().providerModelMemory 返回 +
   * 随 NEW_MAKER_DRAFT_CHANGED 广播。启动推一次 + 变化时增量推,fire-and-forget。
   */
  SYNC_PROVIDER_MODEL_MEMORY: 'maker:sync-provider-model-memory',
  /**
   * 被控端 renderer → 自身 main:会话「非选中模型」effort/fast 在本端变化(被控端本地用户改 /
   * 应用了控制端写穿)时镜像给 main,main 据此 tapWindowBroadcast SESSION_MODEL_PREF_CHANGED
   * 转发给订阅了 session:<id> 的控制端。无控制者订阅时 main 端 fan-out 命中 0 个、近似 no-op。
   * 入参 = { sessionId, agent, providerId, model, effort?, fast? }。fire-and-forget。
   */
  SYNC_SESSION_MODEL_PREF: 'maker:sync-session-model-pref',
  /**
   * 主窗 MainLayout → main:侧边栏渲染上下文 { sessionId, workdir, remoteHostId, deviceLinkDeviceId, available }
   * 变化时无条件推(main 只在 detached 时消费,开偏好瞬间就有 context 可转发)。
   * main 校验 sender 必须是主窗,其它窗口的推送丢弃。fire-and-forget。
   */
  RSB_WINDOW_SET_CONTEXT: 'maker:rsb-window:set-context',
} as const;

export const MAKER_PUSH = {
  EVENT: 'maker:event',
  STATUS_CHANGED: 'maker:status-changed',
  /** 用户从独立 Computer Use 授权引导浮窗主动取消。 */
  COMPUTER_PERMISSION_GUIDE_CANCELLED: 'maker:computer:permission-guide-cancelled',
  /** Native Computer Use onboarding status changed while System Settings is open. */
  COMPUTER_PERMISSION_GUIDE_STATUS_CHANGED: 'maker:computer:permission-guide-status-changed',
  INPUT_PROJECTION: 'maker:input:projection',
  /** New interaction request (permission / ask_user_question / plan_review) */
  INTERACTION_REQUEST: 'maker:interaction-request',
  /** Pending interaction was auto-resolved (e.g. permission mode changed mid-session) */
  INTERACTION_DISMISSED: 'maker:interaction-dismissed',
  /** Host-validated plugin setup action requests a trusted local settings route. */
  PLUGIN_SETUP_NAVIGATE: 'maker:plugin-setup:navigate',
  /** Agent 鉴权状态变化 (login/logout 完成时, 替代老 codex:auth:state-changed) */
  AUTH_STATE_CHANGED: 'maker:auth:state-changed',
  /**
   * 自定义供应商增删改后广播（renderer 各 useProviders 实例 refetch → 设置页列表 + 对话
   * 模型选择器 live 刷新）。无 payload；收到即重拉 listProviders。
   */
  PROVIDER_CHANGED: 'maker:provider:changed',
  /** 通用 OAuth Device Grant 的短期验证码进度（仅 renderer 展示，不落盘/不进日志）。 */
  PROVIDER_OAUTH_PROGRESS: 'maker:provider:oauth:progress',
  /**
   * 自定义 MCP 服务器增删改后广播（renderer 设置页 McpServersSection refetch）。
   * 无 payload；收到即重拉 listCustomMcpServers。
   */
  MCP_CHANGED: 'maker:mcp:changed',
  /**
   * 自定义供应商上游错误的结构化广播(payload = ProviderUpstreamErrorEvent:
   * { agent, providerId, code, retryable, status, detail? })。仅「会话显式路由到
   * user 供应商」的 status≥400 响应触发,main 侧 30s/(providerId,code) 节流。
   * renderer 据 code 显示 providerError.* i18n toast + 修复引导。
   */
  PROVIDER_UPSTREAM_ERROR: 'maker:provider:upstream-error',
  /**
   * Claude Auto 权限分类器不可用后的会话级降级通知。
   * payload = { sessionId, from:'auto', to:'ask', reason:'classifier_unavailable', status }。
   */
  AUTO_PERMISSION_FALLBACK: 'maker:auto-permission:fallback',
  /** Agent 登录子进程进度 (Codex OAuth 子进程 stdout/stderr; Claude 不发) */
  AUTH_LOGIN_PROGRESS: 'maker:auth:login-progress',
  /** Codex app-server spawn-time 路由变化 (OAuth bearer vs gateway env key)。 */
  CODEX_RUNTIME_ROUTE_CHANGED: 'maker:codex-runtime-route-changed',
  /**
   * 会话的延迟凭证切换(set-model 时会话在跑,登记 pending)已在 turn 结束兑现。
   * payload = { sessionId, model, providerId }。renderer 清"任务结束后生效"标记 /
   * 会话内轻提示。
   */
  SESSION_CREDENTIAL_SWITCH_APPLIED: 'maker:session-credential-switch-applied',
  /** cc 默认路由会话的生效计费路由变化 (payload: { sessionId, route })。 */
  CLAUDE_SESSION_ROUTE_CHANGED: 'maker:claude-session-route-changed',
  /**
   * 会话后台活动状态翻转广播(payload = { sessionId, active })。active=true 表示
   * 该会话 turn 已结束但 CC 子进程仍在调模型(后台子 agent 持续消耗用量),renderer
   * 据此显示会话内横幅 +「全部停止」入口;false = 已静默 / 已被全停,横幅熄灭。
   */
  SESSION_BACKGROUND_ACTIVITY_CHANGED: 'maker:session-background-activity-changed',
  /**
   * Scheduler (Phase 4) — 单一 channel 承载 'fired' / 'completed' / 'failed' / 'changed'
   * 4 个事件类型；renderer 按 payload.type 分支。
   */
  SCHEDULE_EVENT: 'maker:schedule:event',
  PROJECT_AUTOMATION_EVENT: 'maker:project-automation:event',
  /**
   * Desktop slash command 触发回调 (palette 重构 Step 2) ——
   * main 的 DesktopCommandRegistry 执行命令时, 通过此 channel 通知 renderer
   * 做 UI 动作 (show help card / open new draft / ...)。renderer 按 payload.command
   * 分支处理; payload 还带 ctx (sessionId / workingDir / args) 让 renderer 知道在哪触发的。
   */
  DESKTOP_COMMAND_TRIGGERED: 'maker:desktop-command-triggered',
  /** multi-worker: worker 增删改 / focus 切换时 broadcast, renderer useWorkers hook 订阅刷新。 */
  ORCA_WORKER_CHANGED: 'maker:orca:worker-changed',
  /**
   * 被控端「当前 New Maker 草稿」全量变更广播。SYNC_NEW_MAKER_DRAFT 落 main 缓存后随即发,
   * 经 device-link tap 转发给控制端(account 级 → sessions topic),控制端刷新远程草稿显示镜像。
   * payload = { claudeCode: RemoteNewMakerDefaults, codex: RemoteNewMakerDefaults }(per-vendor,
   * 控制端直接复用 resolveDeviceLinkDraftDefaults)。本地窗口不消费(被控端是真相、不自镜像)。
   */
  NEW_MAKER_DRAFT_CHANGED: 'maker:new-maker-draft:changed',
  /**
   * 被控端会话「非选中模型」effort/fast 变更广播。带 sessionId → session:<id> topic,转发给打开
   * 该远程会话的控制端,刷新其显示镜像。payload =
   * { sessionId, agent, providerId, model, effort?, fast? }。本地窗口不消费。
   */
  SESSION_MODEL_PREF_CHANGED: 'maker:session-model-pref:changed',
  /**
   * 被控端本地 main → 自身 renderer:把控制端写穿的草稿 pref 交给 renderer,renderer 调它原来的
   * 本地 setter 写真实草稿。仅本地窗口消费(**不**在 PUSH_FORWARD_ALLOWLIST,不转发回控制端);
   * 控制端进程因从不收到此 channel,带着同名监听也不会误触发。payload = APPLY_NEW_MAKER_DRAFT_PREF 入参。
   */
  DRAFT_PREF_APPLY: 'maker:draft-pref:apply',
  /**
   * 被控端本地 main → 自身 renderer:把控制端写穿的「新建会话默认启用 worktree」交给 renderer
   * 写真实草稿(patchDraft)。仅本地窗口消费(**不**在 PUSH_FORWARD_ALLOWLIST,不转发回控制端)。
   * payload = { worktreeEnabled: boolean }(APPLY_NEW_MAKER_WORKTREE_PREF 入参)。
   */
  WORKTREE_PREF_APPLY: 'maker:worktree-pref:apply',
  /**
   * 被控端本地 main → 自身 renderer:把控制端写穿的会话 pref 交给 renderer,renderer 调它原来的
   * 本地 setter 写真实会话记忆。仅本地窗口消费(不转发)。payload = SET_SESSION_MODEL_PREF 入参。
   */
  SESSION_PREF_APPLY: 'maker:session-pref:apply',
  /**
   * 会话内 /goal 状态变化广播。payload = GoalStatusUpdate { sessionId, goal: GoalStatusPayload | null }。
   * goal=null 表示该会话目标已清除(renderer 据此隐藏 GoalIndicator)。renderer 的
   * useGoalStatus hook 按 sessionId 过滤订阅。
   */
  GOAL_STATUS_CHANGED: 'maker:goal:status-changed',
  /**
   * 右侧栏子窗口状态广播 { detached, open }——发所有窗口(主窗按钮态 + 子窗口自身都消费)。
   */
  RSB_WINDOW_STATE_CHANGED: 'maker:rsb-window:state-changed',
  /** 侧边栏渲染上下文变化(主窗切会话),只发子窗口。payload = RsbWindowContext。 */
  RSB_WINDOW_CONTEXT_CHANGED: 'maker:rsb-window:context-changed',
  /** main → 子窗口命令(如 open-terminal),只发子窗口。payload = RsbWindowCommand。 */
  RSB_WINDOW_COMMAND: 'maker:rsb-window:command',
  /**
   * 插件面板独立窗口状态广播(全量 GhostPanelWindowsState)——发所有窗口
   * (主窗布局过滤 + 各子窗口自身都消费)。
   */
  GHOST_PANEL_WINDOW_STATE_CHANGED: 'maker:ghost-panel-window:state-changed',
} as const;

/**
 * 终端（RSB terminal tab）相关 IPC 通道。跟 MAKER_INVOKE 同样的 invoke 语义，
 * 但拆成独立 namespace 因为终端跟 agent 会话是正交关注点。
 *
 * 数据流：
 *   - CREATE: renderer 调 → main 起 PTY，返回 { shellId, shellDisplayName, pid }
 *   - WRITE / RESIZE / DISPOSE / RESTART: 单向命令
 *   - LIST_AVAILABLE_SHELLS: Settings 下拉打开时调，返回 AvailableShell[]
 *   - GET / SET DEFAULT_SHELL_PREF: 持久化用户默认 shell 偏好
 */
export const TERMINAL_INVOKE = {
  CREATE: 'terminal:create',
  WRITE: 'terminal:write',
  RESIZE: 'terminal:resize',
  DISPOSE: 'terminal:dispose',
  RESTART: 'terminal:restart',
  LIST_AVAILABLE_SHELLS: 'terminal:list-available-shells',
  GET_DEFAULT_SHELL_PREF: 'terminal:get-default-shell-pref',
  SET_DEFAULT_SHELL_PREF: 'terminal:set-default-shell-pref',
} as const;

/** PTY → renderer 单向推送（webContents.send）。 */
export const TERMINAL_PUSH = {
  /** payload: { id: string; chunk: string }。每次 PTY onData 一次。 */
  DATA: 'terminal:data',
  /** payload: { id: string; exit: { code: number | null; signal: string | null } }。 */
  EXIT: 'terminal:exit',
} as const;
