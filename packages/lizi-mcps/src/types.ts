import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';
import type { AgentKind } from '@cindy/maker-core';

import type { Recipe, SiteGuide } from './browser/recipe-loader.js';

export interface LiziMcpLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal?(...args: unknown[]): void;
}

export interface SavedImage {
  fileId: string;
  filename: string;
  originalPath: string;
  xdtImageUrl: string;
  bytes: number;
}

/**
 * Inline preview target for image blocks returned to the LLM, in raw bytes
 * (pre-base64). Why 140KB: Claude Code 的 stream-json 输出对 >256KiB 的行做
 * 分块写,分块间隙可能被同进程的其它 stdout 写入(如 ANTHROPIC_LOG=debug 的
 * 请求日志)插队,导致整行 JSON 损坏、agent-sdk 按"非 JSON 输出"静默丢弃 —
 * 表现为 tool_result echo 丢失、聊天流图片卡不渲染、tool_result 不落库。
 * 140KB 原始字节 ≈ 187KB base64,加上 JSON 摘要与消息包装后整行稳定
 * < 256KiB(单次原子写,不可插队)。原图始终全分辨率落盘、经 xdt-image://
 * 渲染,这个上限只影响给模型看的内联副本。
 */
export const INLINE_IMAGE_TARGET_BYTES = 140_000;

/**
 * Host-supplied compressor for inline (LLM-facing) image copies. Returns the
 * re-encoded buffer + mime, or null when the image should be inlined as-is
 * (already under targetBytes / not decodable / host has no codec). Must never
 * throw — degrade to null instead.
 */
export type CompressInlineImageFn = (
  buffer: Buffer,
  mime: string,
  opts: { targetBytes: number },
) => Promise<{ buffer: Buffer; mime: string } | null>;

/**
 * 带媒体(xdt_image_urls / xdt_video_urls 等)的工具结果快照,在 MCP 工具于
 * host main 进程内执行完成的瞬间同步上报。用途:tool_result 的 SDK stdout
 * echo 可能被日志污染损坏而丢失(见 INLINE_IMAGE_TARGET_BYTES 注释),host
 * 据此在 turn 结束时把未收到 echo 的媒体结果直接落库渲染,不再依赖 echo。
 * `args` 用于与对应 tool_use 的 input.args 做确定性配对(jobId / prompt 等)。
 */
export interface MediaToolResultPayload {
  /** 工具入参(与 tool_use input.args 同构),配对键。 */
  args: Record<string, unknown>;
  /** 结果的 text block 原文(内含 xdt_image_urls 等渲染契约字段)。 */
  resultText: string;
}

/** Host 注入的媒体结果上报回调。必须自吞异常,不得影响工具主流程。 */
export type OnMediaToolResultFn = (payload: MediaToolResultPayload) => void;

export interface SavedVideoRef {
  fileId: string;
  filename: string;
  originalPath: string;
  xdtVideoUrl: string;
  bytes: number;
  mime: string;
}

// Jira / Confluence 的 deps 与结果类型已随 lizi_jira / lizi_confluence 退役
// (2026-07-14,迁入内置意识 xd-atlassian)整体删除。


export interface FeishuBotSendFileResult {
  ok: boolean;
  reason?: string;
}

/**
 * Result shape for the send-message channel. Kept parallel to sendFile so the
 * MCP tool handler can branch on a single `ok` flag. `messageId` is what
 * feishu returns on success — surfaced back to the model so it can reference
 * the message in follow-ups if it needs to.
 */
export interface FeishuBotSendMessageResult {
  ok: boolean;
  /** Feishu message id on success. */
  messageId?: string;
  /** Short reason on failure (e.g. 'SEND_FAIL', 'EMPTY_TEXT'). */
  reason?: string;
}

export interface FeishuBotMcpHostDeps {
  sendFile(
    chatId: string,
    absPath: string,
    displayName?: string,
  ): Promise<FeishuBotSendFileResult>;
  /**
   * Push a markdown text message to the given chat (private DM). Backed by
   * the same feishu bot the session is already talking through — host
   * implementations should never fabricate a chatId or route to a different
   * bot instance. Returns `{ok:false, reason}` on any error (SDK/network),
   * never throws — the MCP tool handler translates the reason into an
   * errorCode without needing try/catch around the call.
   */
  sendMessage(
    chatId: string,
    markdown: string,
  ): Promise<FeishuBotSendMessageResult>;
  /**
   * Return the bot's TOFU-recorded owner openId — i.e. the person who first
   * DM'd the bot, semantically "the human this bot instance belongs to".
   * Used as a **fallback receiver** for tools that need to notify the current
   * user from sessions that were NOT triggered by a feishu message (e.g. a
   * desktop chat session where the user typed "跑完之后通过飞书通知我").
   *
   * Returns null when no owner has been bound yet — user must DM the bot once
   * first (same precondition as scheduler feishu-completion notifications).
   */
  getOwnerOpenId(): string | null;
  logger?: LiziMcpLogger;
}

// ── cindy_slack(Slack 网关工具, 2026-07 并轨 hook 通道) ──────────────────────

/** Slack 网关工具的结构化错误(hook-control manager 定义的同构形状)。 */
export interface SlackToolBridgeError {
  code: string;
  message: string;
}

/** callTool 的结构化结果(桥永不 throw)。 */
export type SlackToolBridgeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: SlackToolBridgeError };

/**
 * hook-control 的 Slack 工具桥(结构性 duck type —— 本包不 import desktop
 * 模块, host 侧实现为 hook-control/slackToolBridge 注册表里的桥对象)。
 * multiTeam / bindings: (multi-team)多 workspace 绑定信息 —— 多绑定时非
 * status 工具必须带 teamId, server 拒绝猜测(AMBIGUOUS_TEAM)。旧 host 实现
 * 可能缺这两个字段, 消费方按 undefined 宽松处理。
 */
export interface SlackToolBridgeLike {
  availability(): {
    connected: boolean;
    bound: boolean;
    serverSupportsTools: boolean;
    multiTeam?: boolean;
    bindings?: Array<{ teamId: string; teamName: string | null }>;
  };
  callTool(
    tool: string,
    args?: Record<string, unknown>,
    teamId?: string | null,
  ): Promise<SlackToolBridgeResult>;
}

/**
 * cindy_slack 的 host 依赖: getBridge 每次现取(hook-control 未初始化 / 已
 * dispose 时为 null, 工具 fail-closed); workingDir 由 provider 从 ctx 绑定
 * (大结果落盘的钳制根)。
 */
export interface SlackHookMcpDeps {
  getBridge(): SlackToolBridgeLike | null;
  /** 当前会话工作目录(out_file 泄洪根; 空 = 不落盘只截断)。 */
  workingDir?: string;
  logger?: LiziMcpLogger;
}

/**
 * Host injects a `getScheduler()` accessor — the cindy_scheduler MCP server
 * never holds a long-lived Scheduler reference because the host may
 * `resetScheduler()` on logout / 切账号. Each tool call dereferences
 * fresh; reset-window calls throw `'scheduler not started'` which the MCP
 * server translates to `SCHEDULER_NOT_READY` (see scheduler/errors.ts).
 *
 * Type imported from `@cindy/maker-scheduler` is **type-only** — runtime
 * coupling stays one-way (@cindy/mcps → @cindy/maker-scheduler types only;
 * @cindy/maker-scheduler still has zero runtime deps per Phase 1).
 */
export interface SchedulerMcpDeps {
  getScheduler(): import('@cindy/maker-scheduler').Scheduler;
  /**
   * 前置检查脚本(preRunHook)统一安装服务(host 注入,desktop 实现为
   * scheduler-host/hook-script-generator.installHookScript):落盘路径规范、
   * 命令拼装、落盘后自测全部由 host 代码保证,agent 不允许绕开它手写脚本文件。
   * 缺省 = host 未接 → schedule_set_pre_run_hook 工具不注册
   * (同 MemoryMcpDeps.searchSessions 模式)。
   */
  hookScript?: SchedulerHookScriptService;
  logger?: LiziMcpLogger;
}

/** SchedulerMcpDeps.hookScript 的服务契约。 */
export interface SchedulerHookScriptService {
  /**
   * 可选:解析绑定会话(heartbeat)的工作目录。传 scheduleId 且该任务绑定了会话
   * 时,schedule.workingDir 通常为空(或改绑后过期),脚本落盘/自测目录应以会话
   * meta.workDir 为准。未注入时回落 schedule.workingDir 旧行为。
   */
  resolveSessionWorkDir?(sessionId: string): Promise<string | undefined>;
  /**
   * 把受支持的单脚本相对命令固化为绝对路径。任意 shell 命令保持原样；相对脚本
   * 缺少原 cwd 或文件不存在时必须报错，避免改绑后以 fail-open 静默绕过 hook。
   */
  stabilizeCommand?(input: { command: string; workingDir?: string }): Promise<string>;
  install(input: {
    /** agent 写好的脚本内容(Node ESM);与 description 至少给一个,都给时 script 优先。 */
    script?: string;
    /** 自然语言需求,由 host 侧 utility model 生成脚本(与 UI「AI 生成」同通道)。 */
    description?: string;
    scheduleName?: string;
    workingDir?: string;
    /** 修改流:现有命令,host 识别出旧脚本路径时覆写同一文件。 */
    currentCommand?: string;
    /** 任务显式选择的供应商；由 MCP 从目标 schedule 透传。 */
    providerId?: string;
    /** 任务使用的 agent runtime；由 MCP 从目标 schedule 透传。 */
    agentKind?: AgentKind;
    /** 任务显式选择的模型；由 MCP 从目标 schedule 透传。 */
    model?: string;
  }): Promise<{
    command: string;
    filePath: string;
    content: string;
    /** 落盘后立即执行一次的自测结果。 */
    test: import('@cindy/maker-scheduler').PreRunHookRunResult;
  }>;
}

/**
 * cindy_memory MCP server 工厂参数。Claude 路径下 workdir 在
 * toClaudeSdkConfig(ctx) 时按 session 绑定到 closure；Codex HTTP bridge 路径下
 * server factory 初始化时 ctx 是全局空值，tool-call 阶段通过 getSessionContext()
 * 取回当前 thread 的真实 workingDir。
 *
 *  - getManager(): 跟 SchedulerMcpDeps.getScheduler 同模式 — host 注入函数, 每次
 *    tool 调用 lazy 拿 manager, 避免持长生命周期引用 (mode 切换时 manager 不会被
 *    重建, 但留余地)
 *  - workdir: 当前 session 的工作目录绝对路径 fallback, manager.getStore(workdir) 用
 *  - getSessionContext: 可选运行时 ctx accessor。Codex bridge 用它覆盖初始化期空
 *    workdir；Claude 下返回闭包 ctx，行为等价于直接读 workdir。
 *  - searchSessions: 历史对话 FTS5 检索. 数据在 desktop SQLite (messages 表 + messages_fts
 *    虚拟表), maker-core 不可达 — 必须 host 注入。可选: host 没接 messages_fts 时
 *    缺省, session_search tool 注册时跳过。
 *
 * 依赖 @cindy/maker-core 的类型与少量 runtime 实现(ContactsError / import 管道 /
 * vCard 序列化, workspace dep 已声明), 依赖方向仍单向 @cindy/mcps → maker-core。
 */
export interface MemoryMcpDeps {
  getManager(): import('@cindy/maker-core').MakerMemoryManager;
  workdir: string;
  getSessionContext?: () => LiziMcpSessionContext;
  /**
   * 搜历史对话 (Hermes 风格). 复用 desktop messages 表挂的 FTS5 索引。
   * 缺省 = host 没启用 → session_search tool 不注册 (跟 art video registry 同模式)。
   */
  searchSessions?: SessionSearchFn;
  logger?: LiziMcpLogger;
}

export interface LspMcpDeps {
  workdir: string;
  pool: import('./lsp/server/lsp-server-pool.js').LspServerPool;
  logger?: LiziMcpLogger;
}

// ── cindy_ssh MCP deps ───────────────────────────────────────────────────────
//
// 结构化鸭子类型镜像 @cindy/maker-remote-ssh 的 HostSnapshot / RemoteHost /
// ConnectionPool 子集——不 import 那个包（连 type-only 也不要）：@cindy/mcps 是纯
// 工具注册层，SSH 连接生命周期归 desktop main 管，这里只消费注入的能力面。
// 字段语义以 packages/maker-remote-ssh/src/types.ts 为准。

/** ConnectionPool.list() 返回的单主机快照子集。 */
export interface SshHostSnapshotLike {
  config: {
    /** SSH alias（= ~/.ssh/config 的 Host 指令），也是 pool 的主键。 */
    id: string;
    hostname: string;
    port: number;
    user: string;
    authMethod: 'agent' | 'key';
    source: 'ssh-config' | 'manual';
  };
  status:
    | 'disconnected'
    | 'connecting'
    | 'authenticating'
    | 'ready'
    | 'reconnecting'
    | 'failed';
  lastError?: string;
  lastAuthLabel?: string;
  statusChangedAt: number;
}

/** RemoteHost 的 exec 子集（一次性命令，收集全量输出）。 */
export interface SshRemoteHostLike {
  exec(
    cmd: string,
    opts?: {
      input?: string;
      timeoutMs?: number;
      label?: string;
      /** 边读边生效的 per-stream 字节上限，越界即终止远端命令（防无上限输出攒爆内存）。 */
      maxOutputBytes?: number;
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    /** maxOutputBytes 生效时为 true——输出不完整且命令被提前终止。 */
    truncated?: boolean;
  }>;
}

/** ConnectionPool 子集。 */
export interface SshPoolLike {
  list(): SshHostSnapshotLike[];
  get(id: string): SshRemoteHostLike | undefined;
}

/**
 * cindy_ssh MCP server 工厂参数。
 *
 *  - getPool / ensureReady 都是 async：desktop 侧必须 lazy `await import()`
 *    remote-ssh 模块（静态 import 会形成 mcp-providers → remote-ssh →
 *    maker-host → mcp-providers 的环，先例见 mcp-providers.ts 的 scheduler
 *    hookScript 注入）。
 *  - ensureReady(id)：不存在 / 连接失败时抛错；错误 message 以 `[CODE] ...`
 *    前缀编码（desktop throwIpcError 协议），tool 层用 classifySshError
 *    best-effort 提取。
 *  - 插件启用策略由 host 在 Agent runtime / Codex thread 创建时冻结；这里不得
 *    注入调用时读取设置的门控，否则工具暴露状态与执行权限会在运行中分叉。
 */
export interface SshMcpDeps {
  getPool(): Promise<SshPoolLike>;
  ensureReady(id: string): Promise<void>;
  logger?: LiziMcpLogger;
}

/**
 * cindy_contacts(智能通讯录)MCP server 工厂参数。
 *
 * 与 memory 的差异: 通讯录是全局单库(人不属于 workdir), 不需要 workdir /
 * getSessionContext。开关由 host 设置层注入 isEnabled — provider 注册门控 +
 * withContacts 工具级双重拦截(Codex host 长生命周期下 server 可能已 spawn,
 * 运行期关闭靠工具级拦截兜底, 跟 memory 的 MAKER_MEMORY_NOT_READY 同模式)。
 *
 * 依赖 @cindy/maker-core 的类型与少量 runtime 实现(ContactsError / import 管道 /
 * vCard 序列化, workspace dep 已声明), 依赖方向仍单向 @cindy/mcps → maker-core。
 */
export interface ContactsMcpDeps {
  getManager(): import('@cindy/maker-core').MakerContactsManager;
  /** host 设置层的功能开关. 缺省视为常开(测试/独立复用场景) */
  isEnabled?: () => boolean;
  /**
   * 系统通讯录只读拉取(macOS 由 host 注入 JXA 读取器; 其它平台缺省)。
   * 缺省时 contacts_import_system 工具不注册(跟 memory 的 session_search 同模式)。
   */
  readSystemContacts?: () => Promise<import('@cindy/maker-core').ImportContactRecord[]>;
  /**
   * 系统通讯录回写(macOS host 注入)。缺省时 contacts_export_system 不注册。
   * 语义: 只增/改结构化字段, 系统侧永不删除。
   */
  writeSystemContacts?: (
    items: import('@cindy/maker-core').SystemContactWriteItem[],
  ) => Promise<import('@cindy/maker-core').SystemContactWriteResult[]>;
  /**
   * write/manage 类工具成功后的变更通知(host 注入, 用于广播 renderer 刷新)。
   * MCP 直写同进程 store 不经 IPC 层, 没有这个回调 UI 就收不到 agent 侧变更。
   */
  onMutated?: () => void;
  logger?: LiziMcpLogger;
}

export interface SessionSearchOptions {
  /** 限定 sessionId */
  sessionId?: string;
  /** 限定 role */
  role?: 'user' | 'assistant' | 'system';
  /** 默认 10 */
  limit?: number;
}

export interface SessionSearchHit {
  sessionId: string;
  messageId: string;
  role: string;
  /** FTS5 snippet() 高亮片段 */
  snippet: string;
  /** 时间戳 (ms since epoch) */
  ts: number;
  /** bm25 score, 越小越相关 */
  score: number;
}

export type SessionSearchFn = (
  query: string,
  options?: SessionSearchOptions,
) => Promise<SessionSearchHit[]>;

// 'feishu' 已于 2026-07-16 摘壳(能力迁内置意识 xd-feishu;后端留任给
// scheduler capability broker,见 providers.ts 注释),不再是可注册 MCP id。
// 'lizi_slack_bot' 已于 2026-07-17 随老 SlackIM relay 渠道退役(apiBaseUrl 清理)。
// 'cindy_slack'(与老 lizi_slack_bot 无关)2026-07-19 上线: Slack 网关工具,
// 经 hook 通道由 slack-hook-server 以托管 user token 调 Slack 官方 MCP,
// 接替退役的 cindy-slack 意识。
export type LiziMcpId =
  | 'android'
  | 'browser'
  | 'computer'
  | 'cindy_feishu_bot'
  | 'cindy_slack'
  | 'cindy_scheduler'
  | 'cindy_ssh'
  | 'cindy_memory'
  | 'cindy_contacts'
  | 'cindy_helper'
  | 'cindy_orca'
  | 'cindy_lsp';

// ── Host-callback Result pattern ────────────────────────────────────────────
//
// Several MCP tools delegate to host-side business code via injected callbacks
// (e.g. cindy_helper's sendToSession, cindy_orca's team tools, history
// readers). Those callbacks return a Result variant rather than throw — host
// can use `HOST_NOT_READY` to express "service still bootstrapping" and the
// tool handler maps it to a business errorCode + LLM hint, instead of bubbling
// raw `Error` into INTERNAL.
//
// `E` parameterizes additional error codes specific to a tool (e.g.
// send_to_session adds `NOT_FOUND / ARCHIVED / BUSY / ...`); default `never`
// gives the base shape with only `HOST_NOT_READY | INTERNAL`.

export type ControlOkResult<T extends object = object> = { ok: true } & T;

export type ControlErrResult<E extends string = never> = {
  ok: false;
  errorCode: E | 'HOST_NOT_READY' | 'INTERNAL';
  /** Raw diagnostic / error message to pass through as a hint to the LLM. */
  message: string;
};

export type ControlResult<T extends object = object, E extends string = never> =
  | ControlOkResult<T>
  | ControlErrResult<E>;

/**
 * Worker agent literal — kept as a string literal union (not imported from
 * `@cindy/maker-core`) to avoid a runtime dependency from @cindy/mcps → maker-core.
 * **Keep in sync with `AgentKind` in `packages/maker-core/src/types/common.ts`** —
 * adding a new vendor (e.g. 'gemini') without updating this union will cause
 * LLM tool calls to fail zod enum validation.
 */
export type ControlWorkerAgent = 'claude-code' | 'codex';

/** Browser automation MCP host deps. Core browser execution is injected by host. */
export interface BrowserMcpDeps {
  getRuntime(): BrowserControlRuntime;
  /** Whether the active backend accepts managed resource downloads. */
  supportsResourceDownloads?(): boolean;
  /** Whether the active backend accepts semantic element queries. */
  supportsSemanticQueries?(): boolean;
  logger?: LiziMcpLogger;
  /**
   * Optional L2 (user-local) recipe layer. The host scans userData, parses with
   * the @cindy/mcps `parseRecipes`/`parseSiteGuides` pure fns, and returns the
   * resolved maps plus a `version` content fingerprint. @cindy/mcps stays free of
   * electron/fs. Absent → only the bundled L1 catalog is used (== current behavior).
   */
  getUserRecipes?(): Promise<{
    recipes: Map<string, Recipe>;
    siteGuides: Map<string, SiteGuide>;
    version: string;
  }>;
  /**
   * Optional self-grow write path: persist an agent/user-authored recipe (and
   * optional site guide) into the L2 layer. The MCP validates the draft with the
   * `RecipeSchema` before calling this; the host just writes JSON to userData.
   */
  saveUserRecipe?(input: {
    site: string;
    recipe: Recipe;
    siteGuide?: SiteGuide;
  }): Promise<{ ok: boolean; path?: string; message?: string }>;
}

export type ComputerMcpToolName =
  | 'status'
  | 'check_permissions'
  | 'get_accessibility_tree'
  | 'launch_app'
  | 'list_apps'
  | 'list_windows'
  | 'get_window_state'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'drag'
  | 'type_text'
  | 'set_value'
  | 'press_key'
  | 'hotkey'
  | 'scroll'
  | 'zoom'
  | 'get_screen_size'
  | 'get_cursor_position'
  | 'move_cursor'
  | 'get_agent_cursor_state'
  | 'start_recording'
  | 'stop_recording'
  | 'replay_trajectory'
  | 'start_session'
  | 'end_session';

export interface ComputerDriverStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  daemonRunning: boolean;
  daemonStatus?: string;
  doctor?: unknown;
  permissions?: unknown;
  permissionState?: ComputerDriverPermissionState;
  installCommand: string;
  docsUrl: string;
  error?: string;
}

export type ComputerDriverPermissionPlatform = 'macos' | 'windows' | 'linux' | 'unsupported';
export type ComputerDriverPermissionStatus = 'granted' | 'missing' | 'unknown' | 'not_required';
export type ComputerDriverPermissionGrant = 'granted' | 'missing' | 'unknown' | 'not_required';

export interface ComputerDriverPermissionState {
  platform: ComputerDriverPermissionPlatform;
  required: boolean;
  status: ComputerDriverPermissionStatus;
  accessibility?: ComputerDriverPermissionGrant;
  screenRecording?: ComputerDriverPermissionGrant;
  screenRecordingCapturable?: ComputerDriverPermissionGrant;
  source?: string;
  reason?: string;
  canGrant: boolean;
}

export interface ComputerMcpCallContext {
  sessionId?: string;
  /** Identifies the agent runtime whose MCP server dispatched this call. */
  agentKind?: string;
}

export interface ComputerMcpDeps {
  getStatus(): Promise<ComputerDriverStatus>;
  callTool(
    name: ComputerMcpToolName,
    args: Record<string, unknown>,
    context?: ComputerMcpCallContext,
  ): Promise<unknown>;
  logger?: LiziMcpLogger;
}

export const ANDROID_MCP_ERROR_CODES = [
  'ADB_NOT_FOUND',
  'NO_DEVICE',
  'MULTIPLE_DEVICES',
  'DEVICE_UNAUTHORIZED',
  'DEVICE_OFFLINE',
  'UI_DUMP_FAILED',
  'SCREENSHOT_FAILED',
  'INVALID_NODE',
  'ANDROID_DRIVER_ERROR',
] as const;

export type AndroidMcpErrorCode = (typeof ANDROID_MCP_ERROR_CODES)[number];

export type AndroidMcpToolName =
  | 'status'
  | 'list_devices'
  | 'get_device_state'
  | 'tap'
  | 'swipe'
  | 'input_text'
  | 'press_key'
  | 'launch_app';

export interface AndroidConnectedDevice {
  device_serial: string;
  state: string;
  product?: string;
  model?: string;
  device?: string;
  transport_id?: string;
  usb?: string;
}

export type AndroidAdbPathSource =
  | 'custom'
  | 'env'
  | 'prepared'
  | 'bundled'
  | 'sdk'
  | 'path'
  | 'fallback';

export interface AndroidAdbPreparationState {
  supported: boolean;
  ready: boolean;
  platform: string;
  path: string | null;
  source: AndroidAdbPathSource | null;
  error?: string;
}

export interface AndroidUiBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface AndroidUiNode {
  index: number;
  text?: string;
  content_desc?: string;
  class_name?: string;
  resource_id?: string;
  package?: string;
  bounds: AndroidUiBounds;
  clickable: boolean;
  enabled: boolean;
  focusable?: boolean;
  long_clickable?: boolean;
  scrollable?: boolean;
  checked?: boolean;
  selected?: boolean;
}

export interface AndroidScreenState {
  width: number;
  height: number;
  density: number | null;
}

export interface AndroidCurrentAppState {
  package: string | null;
  activity: string | null;
}

export interface AndroidStatusSummary {
  adb_available: boolean;
  adb_path: string | null;
  adb_path_source?: AndroidAdbPathSource | null;
  adb_preparation?: AndroidAdbPreparationState;
  version: string | null;
  devices: AndroidConnectedDevice[];
  default_device_serial?: string | null;
  configured_default_device_serial?: string | null;
  issue?: AndroidMcpErrorCode | null;
  error?: string;
}

export interface AndroidDeviceStateResult {
  device_serial: string;
  screen: AndroidScreenState;
  current_app: AndroidCurrentAppState;
  screenshot_file_path: string;
  screenshot_base64: string;
  screenshot_mime_type: 'image/png';
  nodes: AndroidUiNode[];
  nodes_truncated?: boolean;
  raw_ui_dump_file_path?: string;
  ui_dump_error?: string;
}

export interface AndroidMcpCallContext {
  sessionId?: string;
  /** Identifies the agent runtime whose MCP server dispatched this call. */
  agentKind?: string;
}

export interface AndroidMcpDeps {
  callTool(
    name: AndroidMcpToolName,
    args: Record<string, unknown>,
    context?: AndroidMcpCallContext,
  ): Promise<unknown>;
  logger?: LiziMcpLogger;
}

export interface LiziMcpSessionContext {
  agentKind: string;
  workingDir: string;
  vendorOptions?: Record<string, unknown>;
  /**
   * Business 层 session id (host 在 createSession 时通过 opts.id 注入, maker-core
   * 透传给 agent.startSession, agent 再放进 McpProviderContext)。MCP server 工厂
   * 闭包绑定本字段, 控制类工具 (如 start_workflow / create_worker) 用它把回调路由到对应
   * session 的业务函数。
   *
   * Codex HTTP MCP bridge 的 server factory 阶段走全局空 ctx；tool-call 阶段
   * 会通过 AsyncLocalStorage 恢复当前 thread 对应的 session ctx。未恢复到
   * ctx 时，标准范式是工具直接返业务错误码 (如 LEAD_NOT_SUPPORTED) 而不是抛异常。
   */
  sessionId?: string;
}

export interface CodexHttpMcpConfig {
  type: 'http';
  url: string;
  /** Env var holding the RAW bearer token (no "Bearer " prefix — Codex prepends it). */
  bearerTokenEnvVar?: string;
}

export interface LiziMcpProvider {
  name: string;
  isEnabled?(context: LiziMcpSessionContext): boolean;
  toClaudeSdkConfig(context: LiziMcpSessionContext): unknown | null;
  /** Remote MCP config for Codex app-server; SDK instance providers use the host HTTP bridge instead. */
  toCodexMcpConfig?(context: LiziMcpSessionContext): CodexHttpMcpConfig | null;
  /** Extra env required by remote MCP configs, e.g. bearer tokens. */
  getExtraEnv?(context: LiziMcpSessionContext): Promise<Record<string, string> | null> | Record<string, string> | null;
}
