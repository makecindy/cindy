/**
 * BaseAgent — Claude Code / Codex 等具体 agent 的统一抽象。
 *
 * 设计要点：
 * - 接口面与现有 vendor/types.ts:VendorSession 对齐，desktop adapter 层只做 thin wrapper
 * - 不支持的能力默认抛 NotSupportedError，子类按 capabilities 覆盖
 * - 持有依赖注入的 deps，但具体使用由子类决定
 */

import type {
  AgentEvent,
  InteractionDecision,
  InteractionResolver,
  UsageSnapshot,
  RewindFilesResult,
  RewindCommitOptions,
  RewindCommitResult,
  ForkSdkSessionOptions,
  ForkSdkSessionResult,
  SendOrigin,
} from '../types/events.js';
import type { ContextUsageData } from '../types/context-usage.js';
import {
  coerceSessionPermissionUpdates,
  createSessionPermissionUpdate,
  hasSessionPermissionUpdates,
  type SessionPermissionUpdate,
} from '../types/permissions.js';
import type { AgentKind, Effort, PermissionMode, ReasoningDisplay, UserMessage, WorkspaceKind } from '../types/common.js';
import type { Capabilities, EffortDescriptor, ModelDescriptor } from '../types/capabilities.js';
import { NotSupportedError } from '../types/capabilities.js';
import type { AgentCredentialMode, AuthLoginOptions } from '../interfaces/auth-adapter.js';
import type {
  MemoryStatus,
  MemorySetResult,
  MemoryResetResult,
} from '../types/memory.js';
import type {
  AccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
} from '../types/account-rate-limits.js';
import type { HookEvent, HookCallbackMatcher, Query } from '@anthropic-ai/claude-agent-sdk';

import type { AuthAdapter } from '../interfaces/auth-adapter.js';
import type { AgentRuntimeConfig } from '../interfaces/runtime-config.js';
import type { Logger } from '../interfaces/logger.js';
import type { McpProvider } from '../interfaces/mcp-provider.js';
import type { MakerMemoryManager } from '../memory/manager.js';
import type { CodexModelListItem } from './codex/app-server/protocol.js';
import type {
  ScanAtResourcesOptions,
  ScanAtResourcesResult,
  AgentBuiltinCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from '../types/palette.js';
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../types/customizations.js';
import { scanWorkspaceFileResources } from './shared/palette-scanner.js';

export interface AgentCapabilityAdditions {
  /** Extra models exposed by the host for this agent. Existing built-in ids are ignored. */
  availableModels?: readonly ModelDescriptor[];
  /** Extra effort labels exposed by the host. Existing built-in ids are ignored. */
  effortLevels?: readonly EffortDescriptor[];
}

export interface CodexMcpThreadContextArgs {
  threadId: string;
  sessionId: string;
  workingDir: string;
  /**
   * SSH remote 会话的 host id。cindy_memory 的 store 定位键要靠它区分
   * 「远端路径」与「本地同名路径」(buildMemoryScopeKey), 缺省 = 本地会话。
   */
  remoteHostId?: string;
  vendorOptions: Record<string, unknown>;
}

export interface CodexReviewerRouteContextArgs {
  threadId: string;
  sessionId: string;
  model: string;
}

/**
 * Metadata for an MCP tool approval decision.
 *
 * Codex fills it from the elicitation `_meta`; Claude fills it by splitting the
 * SDK tool name (`mcp__<server>__<tool>`) and passing the tool input verbatim.
 * Both therefore hand the host the same shape, so one policy answers for both.
 */
export interface McpToolApprovalContext {
  serverName: string;
  /** Top-level MCP tool name, for example `list_tools` or `call_tool`. */
  toolName?: string;
  /** Top-level MCP arguments. Progressive servers carry the inner name/args here. */
  toolParams?: unknown;
}

export type McpToolApprovalPolicy =
  | 'auto-approve'
  | 'prompt'
  | 'prompt-each-time';

export interface CodexExtraSpawnConfig {
  extraArgs: string[];
  extraEnv: Record<string, string>;
  codexProxyActive?: boolean;
  /**
   * spawn args 中定义的「OpenAI 身份」provider id(name 逐字为 "OpenAI",
   * codex 据 name 判定 supports_remote_compaction)。仅 oauth-bearer spawn 下发。
   * CodexAgent 只对 ChatGPT 订阅直连路由的 thread 在 thread/start|resume 传
   * modelProvider=该 id,启用 OpenAI 远端压缩;其余 thread 保持默认 provider
   * (本地压缩)—— 网关 / xAI / 自定义供应商上游不实现远端压缩,错配是硬失败。
   */
  codexRemoteCompactionProviderId?: string;
}

export interface CodexLocalCredentialModeSwitchContext {
  fromMode?: AgentCredentialMode;
  /**
   * 当前 host 的归一化生效形态(createHost 时按 auth fallback 推出并登记)。
   * fromMode 是原始登记值(隐式来源时为 undefined → 宿主显示成 fallback),
   * 排查"为什么要切"时只有归一化形态能说明 host 实际拿的是哪种钥匙。
   */
  fromModeEffective?: AgentCredentialMode;
  toMode?: AgentCredentialMode;
  activeSubscriptions: number;
}

export interface RefreshLocalModelsOptions {
  /**
   * Bind model discovery to a specific local credential route.
   * Codex serves explicit routes from an isolated control-plane host so live
   * session hosts never need a credential-mode switch.
   */
  credentialMode?: AgentCredentialMode;
}

export interface ClaudeSubagentTaskRegistration {
  taskId: string;
  parentToolUseId: string;
  prompt: string;
  model?: string;
}

export interface ClaudeSubagentTaskUsage {
  totalTokens: number;
}

export interface AgentDeps {
  auth: AuthAdapter;
  runtimeConfig: AgentRuntimeConfig;
  /**
   * Agent CLI 二进制绝对路径。host 在构造 agent 前必须已经把二进制 provisioned 好
   * (splash 阶段下载/解压); maker-core 自己不下载、不解析 manifest, 拿到就用。
   * 缺省 / 空串 → BaseAgent 构造期立即抛错, 不让 session 进半就绪状态。
   */
  binaryPath: string;
  logger: Logger;

  /**
   * 解析某 session 的 cc-debug raw 文件落盘路径 (host 注入)。host 用 logger 的 logDir 拼
   * sessions/<sessionId>/cc-debug.raw.log 并 mkdir, 返回绝对路径; ClaudeCodeAgent 在开
   * debug 时把它作为 SDK debugFile 传给 cc 子进程, 让每个 session 的网络 debug 落到各自
   * 的 session 目录 (cc 外部进程只控制内容格式, 写哪个路径由我们决定)。
   * 缺省 / 返回 undefined → 回退到全局 process.env.XDT_CC_DEBUG_FILE。
   */
  resolveCcDebugFile?: (sessionId?: string) => string | undefined;

  /**
   * MCP server 提供者列表（host 注入）。agent 在 startSession 时按上下文挑选
   * provider，并转换成底层 SDK 接受的 MCP 配置。
   */
  mcpProviders?: McpProvider[];

  /**
   * Host-provided capability descriptor additions.
   *
   * This is append-only: additions with ids already present in the agent's built-in
   * capability lists are ignored. Use a future explicit override path if a host
   * needs to replace built-in behavior.
   */
  capabilityAdditions?: AgentCapabilityAdditions;

  /**
   * Agent 起 session 时追加到 system prompt 末尾的字符串（host 注入）。
   * **本轮一阶段不消费**，仅占位。后续接通后 desktop 可以传项目级 prompt。
   */
  // (host-product layer removed — desktop 端只通过 runtimeConfig.systemPrompt
  // 走 host runtime 一段;不再单独维护 deps.appendSystemPrompt 注入路径。)

  /**
   * Codex 专用钩子：把 mcpProviders 转成 codex spawn 时用的 extraArgs (-c flags)
   * + extraEnv (bearer token)。CodexAgent.getHost() 调用，desktop host 实现。
   *
   * 为什么 codex 单独走一条路 (而不是复用 mcpProviders.toClaudeSdkConfig)：
   * codex 是独立 Rust 子进程，没法消费 in-process JS McpServer instance — 必须
   * 通过 streamable-HTTP bridge 把 instance 暴露到 localhost，再用 codex 的
   * `-c mcp_servers.x.url=...` 注入。这层桥接逻辑在 desktop host (用 Electron
   * 内置 http 模块 + @modelcontextprotocol/sdk 的 StreamableHTTPServerTransport)，
   * 不属于 maker-core 范畴。
   *
   * 缺省 / providers 为空 → CodexAgent 不传 extraArgs/extraEnv，跑没 lizi MCP 的
   * codex (仍能基础对话)。
   */
  prepareCodexExtraSpawnConfig?: (
    providers: McpProvider[],
    ctx: {
      remoteHostId?: string;
      credentialMode?: AgentCredentialMode;
      /** Marks one-off app-server work (e.g. model/list) that must not alter session routing. */
      hostPurpose?: 'control-plane';
    },
  ) => Promise<CodexExtraSpawnConfig>;

  /**
   * Codex 本地 shared app-server 凭证形态要切换前的宿主协调点。
   *
   * maker-core 不知道 desktop 的 active session / worktree / attachment 生命周期；
   * 这里给宿主先 soft-close 或拒绝 busy session 的机会。回调返回后若旧 host 仍有
   * active subscription，CodexAgent 会 fail closed，不会静默 retire 正在被使用的 host。
   */
  prepareCodexLocalCredentialModeSwitch?: (
    ctx: CodexLocalCredentialModeSwitchContext,
  ) => Promise<void>;

  /**
   * Codex 专用：本地 app-server `model/list` 返回完整分页快照后通知宿主。
   * maker-core 只负责拿官方运行时清单；如何映射、存入产品目录及广播由 host 决定。
   * 远端 SSH host 不触发，避免把远端账号的模型清单覆盖本机账号目录。
   */
  onCodexLocalModelsListed?: (
    models: readonly CodexModelListItem[],
  ) => void | Promise<void>;

  /**
   * Host-owned Auto permission fallback. A vendor reviewer timeout/unavailable
   * result has already blocked the current action; the host persists this session
   * from Auto to Ask and broadcasts the selector/toast update. Fire-and-forget:
   * classifier failure handling must never hold the vendor notification loop.
   */
  onAutoPermissionClassifierUnavailable?: (args: {
    sessionId: string;
    agentKind: 'claude-code' | 'codex';
    /** HTTP status when available; Codex reviewer timeout/failure use synthetic 408/500. */
    status: number;
  }) => void;

  /**
   * Codex-only: bind app-server thread ids back to xdt-maker session context
   * for host-owned HTTP MCP bridges. Missing hooks keep the old no-session
   * behavior; implementations should be in-memory and best-effort.
   */
  registerCodexMcpThreadContext?: (args: CodexMcpThreadContextArgs) => void;
  unregisterCodexMcpThreadContext?: (threadId: string) => void;

  /**
   * Codex 专用:为远端机器构造一个 codex app-server transport。
   *
   * 当 session 标了 remoteHostId (新建 maker 时选了远端目录), CodexAgent 会调这个
   * 钩子拿一个连远端 daemon 的 transport (替代本地 spawn)。host 层实现 — 通常用
   * `createSshDaemonTransport({ remoteHost: pool.get(remoteHostId), ... })`。
   *
   * 返回的 transport 必须实现 codex app-server 的 NDJSON 协议 transport 接口
   * (writeLine / onLine / onClose / close)。CodexAgent 拿到就当 stdio 用, 完全
   * 不感知背后是 SSH + WebSocket 桥接。
   *
   * 缺省 / undefined → 不支持远端, 任何带 remoteHostId 的 session 会被拒。
   */
  getRemoteCodexTransport?: (remoteHostId: string) => import('./codex/app-server/transport.js').Transport;

  /**
   * Codex 专用:读**这个 thread 本次实际出口**的出站代理路径判定,用于把「后端不可达」
   * 的通用猜测换成实测事实(走了哪个代理 / 确认直连 / 配了但用不了 / 判定没问出来)。
   *
   * 必须传 threadId:codex 的出口随会话选定的 provider 变(订阅直连、网关、xAI、
   * 自定义供应商),host 侧要靠它定位本次请求真正打的上游。拿不到对应记录时**必须**
   * 返回 null(例:本次请求没经过 loopback proxy),而不是回退到「最近一条」——
   * 报一条本次没走过的路径比不报更糟。
   *
   * 只在**本地** session 的 retry-loop 终局升级时读一次,不进任何热路径;实现必须是
   * 同步、只读、不抛的内存快照读取(desktop 侧 = outbound-proxy-resolver 的快照 +
   * codex-proxy-host 的 thread→上游映射)。返回的 proxy 字段必须已脱敏 —— 它会进
   * 用户可见的错误消息。
   *
   * 缺省 / undefined / 返回 null → 保留原有的通用排查文案,不降级任何行为。
   */
  getOutboundPathFact?: (
    ctx: { threadId?: string },
  ) => import('./codex/retry-escalation.js').OutboundPathFact | null;

  /**
   * Maker Memory 顶层单例 (host 注入). 当 runtimeConfig.makerMemoryEnabled === true 时,
   * agent.startSession 会从这里拉当前 workdir 的 MEMORY.md 索引拼进 system prompt;
   * cindy_memory MCP server 也通过 host 端的 createDesktopMcpProviders({ memory: { getManager } })
   * 拿到同一个引用。
   *
   * 缺省 / undefined → 即使 runtimeConfig.makerMemoryEnabled=true 也不注入 (host 没接好 manager,
   * 视为禁用), agent 走原 system prompt 拼接路径。
   */
  makerMemory?: MakerMemoryManager;

  /**
   * Host-side MCP approval policy, shared by **both** agents. `auto-approve`
   * skips the permission prompt; `prompt` preserves the normal approval UI and
   * its optional session grant; `prompt-each-time` always asks and never
   * persists a server/tool grant.
   *
   * 背景:
   *  - Codex CLI 对 raw `mcp_servers.*` 的 write 类 tool call 弹 user approval 是 known
   *    limitation (openai/codex Issues #15437 / #19430 / #13476, 未修)。raw mcp_servers
   *    没有像 `apps.*.default_tools_approval_mode=approve` 那样的 auto-approve 配置。
   *  - host 自家可信的 MCP server (e.g. lizi_*) 每次写都弹严重影响 UX, 这里给一个
   *    宿主策略短路。渐进式 server 还可利用 toolName/toolParams 区分 inner action,
   *    让查询保持无打扰而删除/外部写入逐次确认。
   *  - 同一个第一方 MCP 在两个 agent 下必须给出同一个答案。历史上 Claude 只有一份
   *    静态 allowedTools 白名单、不查这个 hook, 结果 `cindy_browser` 之类高频 server
   *    的 `call_tool` 在 Codex 侧静默执行、在 Claude 侧每调用一次弹一次窗。
   *
   * 实现位置:
   *  - codex/index.ts mcpServerElicitation handler 在 dispatchInteraction 之前查这里;
   *  - claude-code/index.ts canUseTool 对 `mcp__<server>__<tool>` 形态的工具查这里。
   * 两侧同义: auto-approve 直接放行, prompt-each-time 禁掉 session persistence。
   *
   * 缺省 / undefined → 走原 dispatchInteraction (弹 UI), 行为与改动前一致。
   */
  getMcpToolApprovalPolicy?: (context: McpToolApprovalContext) => McpToolApprovalPolicy;

  /**
   * Codex 专用钩子：resume / fork 外部本地 thread 前由 host 准备底层 session state。
   *
   * maker-core 只知道 "即将读取某个 Codex threadId" 这个生命周期点；
   * 具体如何从本机 Codex CLI / App 的 CODEX_HOME 发现并同步 state_*.sqlite / rollout
   * 文件，是 desktop host 的文件系统适配职责。
   *
   * 缺省 / no-op → 行为与改动前一致。
   */
  prepareCodexResumeSession?: (threadId: string) => Promise<string | void>;

  /**
   * Codex 专用:把已拼好的产品级 system prompt 同步登记到 host 的 codex proxy registry。
   *
   * 约束:
   *   - 同步、内存 Map 写入,不可做 IO / 网络
   *   - 不可失败;若实现抛错,CodexAgent 会中止当前 start/resume,避免 thread 已创建但
   *     prompt 既没进 developerInstructions、也没进 proxy registry 的裸奔状态
   *
   * 缺省 / undefined → CodexAgent 不启用 proxy prompt 通道,继续走老 developerInstructions。
   */
  registerCodexSystemPromptForThread?: (args: {
    sessionId: string;
    threadId: string;
    text: string;
  }) => void;

  /**
   * Codex 专用：登记 Guardian 子线程回到父业务 session 时应使用的主模型。
   *
   * Codex app-server 的模型目录由共享进程持有，不能代表单个 session 的实际
   * Provider。host/proxy 通过 Guardian 请求的 x-codex-parent-thread-id 找回
   * 此上下文，在非 OpenAI 路由把隐藏 codex-auto-review 改写为当前主模型。
   *
   * 只有明确返回 true 才表示路由已就绪；缺省、false 或抛错都必须继续使用
   * user reviewer，不能让未知路由进入无人值守审批。
   */
  registerCodexReviewerRouteContext?: (args: CodexReviewerRouteContextArgs) => boolean;

  /**
   * Claude 专用: host 明确认定可无提示执行的只读工具名, 透传到 SDK
   * `options.allowedTools`。maker-core 不维护任何产品工具名, 也不做 wildcard /
   * 前缀推断; 远端 cc-manager 分支必须透传同一份列表, 避免本地与 SSH 会话权限
   * 语义分叉。
   *
   * 缺省 / undefined → 不传 allowedTools, 行为与改动前一致。Codex 不消费此字段。
   */
  claudeAllowedTools?: readonly string[];

  /**
   * Claude 专用 SDK hook 注入点。host 在构造 ClaudeCodeAgent 时按 HookEvent
   * (PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / ...) 注册一组
   * in-process JS 回调; ClaudeCodeAgent.startSession 透传给 SDK options.hooks。
   *
   * 设计说明:
   *  - maker-core 自己**不持有任何 hook 实现** —— 这里只是注入点, 具体业务逻辑
   *    (例: 图片 read 检测、Bash 命令白名单、敏感路径拦截) 都在 host 层。
   *  - 类型直接复用 Claude SDK 的 HookCallbackMatcher (含 matcher / hooks / timeout),
   *    host 直接 import @anthropic-ai/claude-agent-sdk 的类型即可, 与 mcpProviders
   *    用 McpServerConfig 同模式。
   *  - 与 canUseTool 的关系: PreToolUse 比 canUseTool 更早, 返回 'allow' / 'deny'
   *    会跳过 canUseTool; 返回 'defer' 或不给 permissionDecision 才继续走原 permission
   *    流程。host 注入时要先想清楚拦截顺序, 避免打穿 Orca / 协同模式那套 permission UI。
   *  - 闭包语义: hooks 在 startSession 时被传给 SDK 一次, 之后无法再换 (与 vendorOptions
   *    同坑). 如果要做运行时可替换, host 应自己包一层 `(input) => current(input)` 走可变引用。
   *
   * 缺省 / undefined → 不传 hooks 字段, 行为与改动前一致。
   * Codex 不消费此字段。
   */
  claudeHooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

  /** Host bridge for repairing Claude Code subagent usage when provider usage is zero. */
  registerClaudeSubagentTask?: (task: ClaudeSubagentTaskRegistration) => void;
  getClaudeSubagentTaskUsage?: (taskId: string) => ClaudeSubagentTaskUsage | undefined;

  /**
   * Claude Code 专用:为远端机器构造一个 SDK `Query` (实际是 cc-mgr daemon 端
   * SDK Query 的 RPC wrapper, 在 maker-core 看就是 Query interface)。
   *
   * 跟 `getRemoteCodexTransport` 同模式但走更高抽象:codex 是字节级 transport
   * 桥, cc remote 是 NDJSON RPC + RemoteQuery 包装 (因 cc 没 daemon 协议, 我们
   * 自造 manager + SDK wrap, 见 packages/maker-cc-manager)。
   *
   * 当 session 标了 remoteHostId 且 host 注入了这个 factory, ClaudeCodeAgent
   * 在 buildQuery 时会调它拿一个连远端 cc-mgr daemon 的 Query 实例 (替代本地
   * `sdkQuery` 起 cc subprocess); host 层实现里通常 unique key=remoteHostId
   * 复用同一个 daemon (一 daemon 多 session)。
   *
   * 返回的 Query 必须满足 SDK Query interface 的子集 — ClaudeCodeAgent 实际只
   * 调:`for await of` (event 流) / `interrupt` / `setModel` /
   * `setPermissionMode` / `applyFlagSettings` / `stopTask`(可选 — 缺失时用户
   * Stop 退化为 interrupt-only,后台 wake 任务不被连带停止)。`RemoteQuery`
   * (`@cindy/maker-cc-manager`) 全部已实现, host 直接 cast as Query 即可。
   *
   * **MVP 不支持**:rewind / fork 等需要 SDK 内部重建 Query 的操作 — 远端
   * cc-mgr daemon 协议没暴露, ClaudeCodeAgent 撞到会 throw。
   *
   * 缺省 / undefined → 不支持远端 cc, 任何带 remoteHostId 的 cc session 会被拒。
   * Codex 不消费此字段 (Codex 走 `getRemoteCodexTransport`)。
   */
  remoteCcQueryFactory?: (opts: {
    remoteHostId: string;
    sessionId: string;
    /**
     * 给 cc-mgr daemon 起 SDK Query 时用的全部 options
     * (cwd / model / env / mcpServers / systemPrompt / additionalDirectories /
     *  permissionMode / extraOptions)。结构参见
     *  `import('@cindy/maker-cc-manager').QueryStartParams`。
     *
     * 用 `unknown` 是为了避免 maker-core 顶层 import @cindy/maker-cc-manager
     * (那是 host-only 包, maker-core 不该耦合)。host 层实现时 cast 进去即可。
     */
    startParams: Record<string, unknown>;
    /**
     * session 自己的 vendorOptions (startSession 入参透传)。远端 cc 的协同
     * MCP ctx 必须以它为准:worker 首次创建时 DB 的 orca 标记/markOrcaRole
     * 发生在 bootstrap 之后, host 侧现场查 DB 会拿到空角色 (fail-closed
     * "not an orca worker session");opts 里的 vendorOptions 才是创建方
     * 显式声明的身份。host 实现可在缺失时回退 DB 合成。
     */
    vendorOptions?: Record<string, unknown>;
    /**
     * Callback for daemon-side approval requests (canUseTool / AskUserQuestion /
     * ExitPlanMode). Host layer registers this on the RPC client; maker-core wires
     * it to the session's interactionResolver.
     *
     * Params/Result shapes follow `@cindy/maker-cc-manager` ApprovalRequestParams/Result
     * but typed as unknown here to avoid cross-package dependency.
     */
    onApprovalRequest?: (params: unknown) => Promise<unknown>;
    /**
     * 本 session 的 Maker Memory 注入开关 (startSession 时已按 per-session flag
     * + manager 就绪归一)。host 据此决定是否把 cindy_memory 以 http 形态经
     * bridge 注进远端 startParams.mcpServers — prompt 段 (rules + MEMORY.md
     * index) 由 maker-core 自己拼, 两侧必须同源同值, 否则模型被 rules 引导去
     * 调不存在的工具。缺省视为 false。
     */
    makerMemoryEnabled?: boolean;
  }) => Promise<Query>;
}

export interface OneShotOptions {
  /** 输出 token 上限。默认 100 (起标题用); skillReview 这种大 prompt 应传 4096。 */
  maxTokens?: number;
  /**
   * 模型 ID。不传时 agent 内部用各自默认 (Claude → claude-haiku-4-5, Codex → gpt-5.4-mini)。
   * 仅当调用方对模型敏感时才传 (例如 skillReview 锁定 haiku 控制成本)。
   */
  model?: string;
  /** 整体超时 (ms)。默认 30_000;skillReview 大 prompt 应放宽到 120_000。 */
  timeoutMs?: number;
  /**
   * 外部 abort signal —— 跟内部 timeout controller 合并。
   * 用于 skillReview "用户主动取消发布" 等场景。
   */
  signal?: AbortSignal;
}

/**
 * oneShot 失败抛此 error,reason 跟 skillReview ReviewServiceUnavailableError 对齐
 * (timeout / auth / network / malformed),便于上层一对一映射 errorCode。
 *
 * - timeout:  自家 timeoutMs 触发 / SDK 408/504
 * - auth:     缺 API key / SDK 401/403
 * - network:  fetch 网络层失败 / SDK 5xx / 429
 * - malformed:模型空响应 / 协议层异常 (Codex 端 error notification 也归这)
 *
 * "宽容"调用方 (起标题) 自己 try/catch 返空串即可,不要在 agent 里做 swallow。
 */
export type OneShotErrorReason = 'timeout' | 'auth' | 'network' | 'malformed';

export class OneShotError extends Error {
  constructor(
    public readonly reason: OneShotErrorReason,
    msg?: string,
  ) {
    super(msg ?? `oneshot-failed:${reason}`);
    this.name = 'OneShotError';
  }
}

/**
 * Agent 未授权 — 由 agent 实现在 lazy spawn / RPC 入口处自检 AuthAdapter.getState()
 * 后抛出。语义:用户从来没在本机授权过这个 agent(或刚登出),不要 spawn 子进程 / 发请求。
 *
 * 调用方处理约定:
 * - listSlashCommands / listCustomizations 这种 ChatInput mount 时无条件预扫的入口 →
 *   catch 这个 error 并返回空结果(不污染 UI、不打 error 日志)
 * - startSession / oneShot / forkSdkSession 这种用户显式触发的入口 → 让它冒上去,
 *   renderer 据此引导用户去 settings 完成授权
 *
 * 用 instanceof 判断;不要靠 message 文本。
 */
export class AgentNotAuthenticatedError extends Error {
  constructor(public readonly agentKind: string, msg?: string) {
    super(msg ?? `agent-not-authenticated:${agentKind}`);
    this.name = 'AgentNotAuthenticatedError';
  }
}

export interface StartSessionOptions {
  /**
   * Business 层 session id (host 调用 maker.createSession 时传的 opts.id, 由
   * maker.ts 透传到这里)。agent 把它放到 McpProviderContext.sessionId, 让 MCP
   * server 工厂能闭包绑定 "当前 session 是谁", 工具 handler 据此回调到 host 的
   * session 级业务函数 (例如 start_team / create_worker 需要传 leadSessionId)。
   *
   * 与 AgentSessionHandle.id (sdkSessionId, SDK 自己生成) 不是同一个值。
   * 未提供时, MCP ctx.sessionId 为 undefined, 标准范式是工具返业务错误码
   * (如 LEAD_NOT_SUPPORTED) 让 LLM 知道当前调用无法绑定到具体 session。
   */
  sessionId?: string;
  workingDir: string;
  /**
   * Product workspace classification. `dialogue` sessions may still receive an
   * app-managed cwd, but must stay out of project grouping when persisted.
   */
  workspaceKind?: WorkspaceKind;
  /**
   * 远端目标 host id (`@cindy/maker-remote-ssh` ConnectionPool 里的 host alias)。
   * 设置后, agent 不在本机 spawn 进程, 改成通过 deps.getRemoteCodexTransport(id) 拿到
   * SSH-bridged transport 跟远端 codex daemon 通信。
   * workingDir 在 remote 场景下是 *远端机器上的绝对路径* (本地 fs 不存在也行)。
   *
   * 缺省 / undefined → 本地 spawn (历史行为)。
   * 目前仅 Codex 支持; Claude 不消费此字段 (会被忽略)。
   */
  remoteHostId?: string;
  model: string;
  /**
   * 本次会话显式选择的供应商来源。maker-core 只用它推导子进程凭证形态;
   * 具体上游路由仍由 host 的 proxy / provider catalog 负责。
   */
  providerId?: string | null;
  effort?: Effort;
  /**
   * Codex Fast mode: true → app-server ServiceTier.Fast, false → explicit standard tier.
   * Undefined means do not override the agent/server default.
   */
  fastMode?: boolean;
  /**
   * 用户级 system prompt 追加段，跨 agent (claude-code / codex) 公用，
   * 拼接顺序最末（优先级最高），覆盖 engine 与 host 段。空串 / undefined 跳过。
   *
   * 来源：renderer 的 lib/userPromptStore（本地 localStorage，不上服务器）。
   * 每次 startSession 由 ChatInput 透传当前最新值，达成「实时跟随」语义 ——
   * 用户改 prompt 后，下一次新 session 立即生效，老 session 维持启动时快照。
   */
  userPrompt?: string;
  /**
   * 是否启用 Maker Memory (本次 session 内). 跟 userPrompt 同模式 — renderer 启 session
   * 时透传当前 memoryMode='maker' → true, 'native' / 'off' → false。main 不持久化。
   *
   * 缺省 / undefined → fallback 到 runtimeConfig.makerMemoryEnabled (host 静态配置, 一般为
   * undefined / false), 实际效果就是不启用 maker memory。
   *
   * 启用时 agent.startSession 会:
   *   1. 拼 system prompt 时注入 memory rules + MEMORY.md 索引
   *   2. 创建 MemoryFlushController 监听 token usage
   * 共享 manager 的 enablement 由 host setting 控制，不由 session flag 改写。
   */
  makerMemoryEnabled?: boolean;
  permissionMode?: PermissionMode;
  /**
   * 计划模式开关（与 permissionMode 正交，见 Capabilities.planMode）。
   * true → Claude 以 SDK plan mode 启动 / Codex turn 携带 collaborationMode plan。
   * 缺省 / undefined → 关闭。
   */
  planMode?: boolean;
  displayReasoning?: ReasoningDisplay;
  resumeSessionId?: string;
  /**
   * Maker 内部注入的 invalid-resume CAS 回调。Agent 只有在供应商明确报告
   * resumeSessionId 不存在时才调用；返回 false 表示持久化值已被并发更新，
   * 此时不得 fresh fallback 覆盖新会话。
   */
  onInvalidResumeSession?: (expectedSdkSessionId: string) => Promise<boolean>;
  /**
   * Codex-only: whether the resumed thread history already contains xdt-maker's
   * product developer prompt. `false` / `undefined` lets non-proxy resume restore
   * it once; `true` keeps Option A and avoids repeated developer messages.
   */
  codexHistoryHasProductPrompt?: boolean;
  /**
   * 附加只读引用目录列表(绝对路径)。Claude 透传到 SDK options.additionalDirectories；
   * Codex 透传到 app-server runtimeWorkspaceRoots，并用 permission profile 保持只读。
   * 跟 model/effort 同语义: 启动时快照 + 由 setExtraDirs 热更新 closure。
   */
  extraDirs?: string[];
  /**
   * vendor-specific 透传字段。等价于现有 VendorSessionOptions.vendorOptions。
   * 例如：Claude 的 forkSession / resumeSessionAt / source / onStderrLine ...
   */
  vendorOptions?: Record<string, unknown>;
}

/**
 * Session.send / handle.send 的可选附加项。
 * 缺省 / 不识别字段必须安全忽略。
 */
export interface SendOptions {
  /**
   * 当前 session 的展示 title (renderer / IPC 层在调 send 前查到的最新值)。
   * 仅用于在 SDK ▷ token usage 等诊断日志里多一行可读上下文,
   * 不参与任何业务逻辑; 长 session 跨 turn 之间允许变化 (auto-rename / 用户手改)。
   */
  logTitle?: string;
  /**
   * 调用方为这条 user 消息预先生成的 uuid。Claude SDK 会把它当作 file checkpoint
   * 的 snapshot messageId, rewind preview 反查 user uuid 调 rewindFiles dryRun
   * 也用同一个值。调用方应当**同时**:
   *   1. 落库时写进 messages.agent_meta.uuid (rewind preview/commit 反查锚点)
   *   2. 透传到这里 (本字段) 让 SDK 按这个 uuid 标 checkpoint
   * 缺省时 SDK 自己生成一个 (但调用方不知道, rewind 拿不到 → 走"老消息"兜底)。
   * Claude 端: agent 实现把它注入 inputQueue.push 的 SDKUserMessage.uuid;
   * Codex 端: 当前不消费 (Codex 无 file checkpointing 概念)。
   */
  messageUuid?: string;
  /**
   * 当前用户的展示名 (host / renderer 在调 send 时提供)。仅用于 turn-start 时
   * push status event 的文案 — agent 拼成 "<userName> Just Wait ..." 让 UI 个人化;
   * 缺省时 fallback "Just Wait ..."。不参与任何业务逻辑。
   */
  userName?: string;
  /**
   * 本条消息的计划模式意图快照(点击发送瞬间的勾选状态,随排队行透传)。
   *  - true  → 本 turn 以计划模式执行;若 agent 武装态仍在则一并消耗(emit
   *            plan_mode_changed),否则(排队后用户已改勾选)不动武装态。
   *  - false → 本 turn 显式普通执行,且**不**消耗武装态(用户可能是排队普通消息
   *            之后才重新勾选,意图留给未来消息)。
   *  - undefined → 旧语义:消耗 agent 当前武装态(IM / scheduler / goal 等
   *            不走 composer 的调用方)。
   * 背景:排队行的 createOpts 快照对已存活会话曾被忽略,drain 时按 agent 当时
   * 的武装态执行 —— 排队期间改勾选会丢失/误用计划意图(PR #494 review)。
   */
  planMode?: boolean;
  /**
   * 调用方要求 Codex turn/start 失败时 reject。普通 send 的历史契约是通过事件流
   * 上报失败,不 reject；但 desktop renderer 队列路径需要“agent 已接受才落库”的
   * 确定性语义,Codex 插话也需要知道 follow-up turn 是否真正启动。未知 agent 必须
   * 安全忽略。
   */
  throwOnStartFailure?: boolean;
  /**
   * Optional cancellation boundary for caller-owned transactions.
   *
   * This is not a user-facing "abort the model" primitive. It exists so main's
   * queue coordinator can cancel a pre-accept transaction (notably Codex
   * interrupt-then-follow-up steer) when Stop/close wins the race. Agent
   * implementations that cannot observe it must ignore it safely; callers still
   * rely on the agent's normal close/abort checks as the final guard.
   */
  signal?: AbortSignal;
  /**
   * 本次 send 的发起来源(产品层 turn origin)。Session 会记住它并打到这一轮
   * 的每个 AgentEvent.turnOrigin 上(见 session.ts 的 currentTurnOrigin),供
   * 共享 session 下区分自动任务 turn 与用户 turn。agent 子类不消费,透传无害。
   */
  origin?: SendOrigin;
  /**
   * Host-owned, per-turn permission policy. This is deliberately a callback
   * rather than prompt text: providers must enforce it at their pre-execution
   * approval boundary, before MCP auto-approval or permission-mode bypasses.
   */
  turnPermissionPolicy?: TurnPermissionPolicy;
}

export type TurnPermissionOrigin =
  | { kind: 'desktop' }
  | { kind: 'im'; channel: 'feishu' | 'discord' | 'slack' | 'wechat'; taskId?: string }
  | { kind: 'scheduler' }
  | { kind: 'hook'; source: string };

export interface TurnPermissionPolicy {
  readonly origin: TurnPermissionOrigin;
  readonly confirmationSurface: 'desktop' | 'channel';
  readonly confirmationTimeoutMs?: number;
  readonly onInteractionStateChange?: (
    state: 'waiting' | 'resolved' | 'cancelled',
  ) => void;
  forceConfirmToolCall(toolName: string, input: unknown): boolean;
}

export class TurnPermissionPolicyUnsupportedError extends Error {
  readonly code = 'TURN_PERMISSION_POLICY_UNSUPPORTED';

  constructor(
    readonly agentKind: AgentKind,
    readonly permissionMode: PermissionMode,
  ) {
    super(
      `Turn permission policy is not supported by ${agentKind} in permission mode ${permissionMode}`,
    );
    this.name = 'TurnPermissionPolicyUnsupportedError';
  }
}

/**
 * 会话内仍在运行的单个后台任务快照(listBackgroundTasks 的元素)。字段与
 * agent_task_update 事件同源:taskId 是 SDK task_id;toolUseId 是派生该任务的
 * 工具调用 id(renderer 用它对回消息流里的工具行);title 是 SDK description。
 */
export interface BackgroundTaskSnapshot {
  taskId: string;
  /** SDK task_type(local_bash / local_agent / local_workflow 等),缺失表示未知。 */
  taskType?: string;
  toolUseId?: string;
  title?: string;
}

/**
 * 一个已启动的 agent 会话句柄。
 * 上层 Session 类持有此句柄并对外暴露 UI 友好的 API。
 */
export interface AgentSessionHandle {
  /** SDK 内部 sessionId，session.started 后会回填 */
  readonly id: string;
  readonly agentKind: AgentKind;
  readonly model: string;
  /** Codex-only: 当前会话绑定的 app-server host 是否经 loopback proxy 出口。 */
  readonly codexProxyActive?: boolean;
  /**
   * Codex-only: start/resume 成功后,产品 prompt 这一次到底有没有进入
   * codex thread history。Maker 用这个事实更新 host 持久化 bit,避免再从
   * 全局 proxy 状态反推。其它 agent 不设置。
   */
  readonly codexProductPromptDelivery?: {
    readonly threadId: string;
    readonly historyHasProductPrompt: boolean;
  };

  /** 推送一条用户消息（流式输入） */
  send(message: UserMessage, opts?: SendOptions): Promise<void>;

  /**
   * Synchronous provider preflight called by Session after reserving the turn
   * but before any product `beforeProviderStart` / `onAccepted` side effect.
   * Direct handle callers are still validated again inside send().
   */
  validateSendOptions?(opts: SendOptions): void;

  /**
   * 把用户消息追加到当前 in-flight turn。
   *
   * 与 send() 的差别不是参数形态，而是状态语义：send() 开启新 turn 并重置
   * usage/status/tool-loop；steer() 只进入已有 turn 的输入通道，不能刷新这些
   * per-turn 状态。这里保留独立方法，避免调用方用 boolean 改写 send() 后踩到
   * 缓存率、计费和 UI 状态错乱的问题。
   */
  steer(message: UserMessage, opts?: SendOptions): Promise<void>;

  /** 中断当前 turn */
  abort(): Promise<void>;

  /** Provider turn identity when the adapter exposes one (currently Codex). */
  getCurrentTurnId?(): string | null;

  /**
   * 停止会话内单个后台任务(SDK Query.stopTask 透传)。
   * 与 abort() 的区别:abort 是"用户 Stop"的全停语义(只连带 wake 型任务、并
   * 中断当前 turn);本方法精确停一个后台任务(含 local_bash —— 用户在 UI 上
   * 对着具体任务点停,不存在 abort 那种误杀 dev server 的顾虑),不碰当前 turn。
   * 幂等:任务已到终态时静默成功。不支持的 agent 留空(Session 层抛
   * NotSupportedError)。
   */
  stopBackgroundTask?(taskId: string): Promise<void>;

  /**
   * 当前仍在运行的后台任务快照(含 local_bash)。事件流(agent_task_update)是
   * 唯一实时源;本方法只服务「订阅者挂载/重载晚于任务启动」的存量补齐场景。
   * 不支持的 agent 留空(Session 层回退为空数组)。
   */
  listBackgroundTasks?(): BackgroundTaskSnapshot[];

  /** 关闭会话，清理子进程 */
  close(): Promise<void>;

  /**
   * Detach from a long-lived remote session without terminating the upstream
   * process. Agents without detach semantics leave this undefined.
   */
  detach?(): Promise<void>;

  /** 事件流（streaming + 翻译后的统一事件） */
  events(): AsyncIterable<AgentEvent>;

  /** 当前 usage 快照 */
  getUsageSnapshot(): UsageSnapshot;

  /** Structured context usage breakdown. Only Claude Code implements this today. */
  getContextUsage?(): Promise<ContextUsageData>;

  /**
   * 设置统一的用户交互回调 —— permission/ask_user_question/plan_review 三种 kind
   * 通过同一个 resolver dispatch。host 侧根据 req.kind 弹不同 UI。
   */
  setInteractionResolver(resolver: InteractionResolver): void;

  /** 运行时切换模型 —— 不支持时抛 NotSupportedError */
  setModel?(model: string): Promise<void>;

  /** 运行时切换 effort */
  setEffort?(effort: Effort): Promise<void>;

  /** 运行时切换 permission mode */
  setPermissionMode?(mode: PermissionMode): Promise<void>;

  /**
   * 运行时开关计划模式（Capabilities.planMode 支持时实现）。
   * 开启：Claude 把 SDK 切到 plan mode；Codex 下一 turn 携带 collaborationMode plan。
   * 关闭：切回当前 permissionMode 对应的底层权限档 / collaborationMode default。
   * 计划批准后 agent 自行关闭时会 emit 'plan_mode_changed' 事件（host 负责持久化回写）。
   */
  setPlanMode?(enabled: boolean): Promise<void>;

  /** 当前 maker 进程内记录的计划模式状态；不支持的 agent 不实现。 */
  getPlanMode?(): boolean;

  /** 运行时切换 Fast mode；不支持的 agent 不实现。 */
  setFastMode?(enabled: boolean): Promise<void>;

  /**
   * 运行时增删 extraDirs(覆盖式)。Claude 与 Codex 都更新 closure，在下一 turn 生效。
   */
  setExtraDirs?(dirs: string[]): Promise<void>;

  /**
   * 运行时合并 vendorOptions(浅合并到内部闭包)。
   * 用于中途切换 session-specific 配置(例如 orcaRole='lead' 让 MCP provider
   * 的 isEnabled(ctx) 在下一 turn 立即返回 true / false)。
   * SDK 的 system prompt 不支持中途修改,这是唯一干净的"中途切换能力集"机制。
   * 不发起任何 SDK 调用,只改 closure;下一次 buildQuery / turn/start 自动用新值。
   */
  setVendorOptions?(patch: Record<string, unknown>): Promise<void>;

  /** 当前 maker 进程内记录的 Fast mode 状态；不支持的 agent 不实现。 */
  getFastMode?(): boolean;

  // ── Rewind ────────────────────────────────────────────────────────────────
  // Claude 走 SDK message uuid + file checkpoint；Codex 走 app-server thread/rollback
  // 裁剪完整 turn，不做文件回滚。

  /**
   * dryRun: 问 SDK "如果回滚到这个 user 消息那一刻, 会动哪些文件"。
   * 不改任何状态, 调用方 (Dialog) 拿来给用户看 diff 列表。
   * SDK 软拒绝 (老 session 没开 checkpointing 等) 包成 {canRewind:false, error}。
   */
  previewRewindFiles?(userUuid: string): Promise<RewindFilesResult>;

  /**
   * 真执行 rewind:
   *   1. 立即把文件回滚到 target 时点 (q.rewindFiles dryRun:false)
   *   2. close 当前 SDK Query (释放 CLI 子进程)
   *   3. 内部标记 pendingRewindTo = priorAssistantUuid; 下一次 send 自动用
   *      resume + resumeSessionAt + forkSession 三件套重启 sdkQuery
   *
   * 失败语义: 文件回滚抛错 → warn + 继续 (forkSession=true 兜底); close 抛错 → warn。
   * DB 操作 (软删 messages / reset tokens) 由调用方负责, 不在 maker-core 范围。
   */
  commitRewindFiles?(
    userUuid: string,
    priorAssistantUuid: string,
    opts?: RewindCommitOptions,
  ): Promise<undefined | RewindCommitResult>;

  /**
   * 当前 turn 是否在跑 (rewind preview/commit 前置守卫用)。
   * true = SDK 在处理上一条 user 消息, false = 空闲。
   * 默认实现为 false (capability 缺失时 host 不该问)。
   */
  isTurnRunning?(): boolean;
}

export abstract class BaseAgent {
  abstract readonly kind: AgentKind;
  abstract readonly capabilities: Capabilities;

  /**
   * 当前 host 对 memory 通道的覆盖意图。
   *  - undefined : 没人改过, 走 agent 自带默认
   *  - true/false: runtimeConfig.memoryEnabled 注入或被 setMemory 改过
   *
   * 子类的 startSession (CC: buildQuery options.settings; Codex: experimentalFeature/enablement/set)
   * 都从这里读, 保证 "构造期 runtimeConfig.memoryEnabled" 与 "运行时 setMemory" 是同一份事实。
   */
  protected memoryOverride: boolean | undefined;

  constructor(protected deps: AgentDeps) {
    if (!deps.binaryPath) {
      throw new Error(
        `${this.constructor.name}: binaryPath is required at construction (host must provision binary before instantiating agent)`,
      );
    }
    this.memoryOverride = deps.runtimeConfig.memoryEnabled;
  }

  /**
   * Build instance-level capabilities from an agent's built-in declaration plus
   * host additions. Agents keep ownership of their defaults; BaseAgent only owns
   * the shared append/merge mechanics.
   */
  protected buildCapabilities(base: Capabilities): Capabilities {
    const additions = this.deps.capabilityAdditions;
    return {
      ...base,
      availableModels: this.mergeCapabilityList(
        'availableModels',
        base.availableModels,
        additions?.availableModels,
      ),
      effortLevels: this.mergeCapabilityList(
        'effortLevels',
        base.effortLevels,
        additions?.effortLevels,
      ),
    };
  }

  private mergeCapabilityList<T extends { id: string }>(
    listName: 'availableModels' | 'effortLevels',
    builtIn: readonly T[],
    additions: readonly T[] | undefined,
  ): T[] {
    const merged = [...builtIn];
    if (!additions || additions.length === 0) return merged;

    const ids = new Set(merged.map((item) => item.id));
    for (const item of additions) {
      if (ids.has(item.id)) {
        this.deps.logger.warn('capability addition ignored duplicate id', {
          agentKind: this.kind,
          listName,
          id: item.id,
        });
        continue;
      }
      ids.add(item.id);
      merged.push(item);
    }
    return merged;
  }

  /**
   * Shared "allow for this session" semantics for permission prompts. Concrete
   * agents still translate the resulting decision into their vendor protocol.
   */
  protected createSessionPermissionUpdates(
    fields: Record<string, unknown> = {},
  ): SessionPermissionUpdate[] {
    return [createSessionPermissionUpdate(fields)];
  }

  /**
   * Vendor SDKs may suggest persistent updates. Maker's UI action is explicitly
   * session-scoped, so agents normalize those suggestions before exposing them.
   */
  protected normalizeSessionPermissionSuggestions(
    suggestions?: readonly unknown[] | null,
  ): SessionPermissionUpdate[] | undefined {
    const updates = coerceSessionPermissionUpdates(suggestions);
    return updates.length > 0 ? updates : undefined;
  }

  protected permissionDecisionRequestsSessionApproval(
    decision: Extract<InteractionDecision, { kind: 'permission' }>,
  ): boolean {
    return hasSessionPermissionUpdates(decision);
  }

  /**
   * 启动一个新会话或恢复已有会话。
   * 子类负责用 deps.binaryPath / auth / runtimeConfig 组装 env / spawn / 包装 SDK。
   */
  abstract startSession(opts: StartSessionOptions): Promise<AgentSessionHandle>;

  /**
   * Agent 内置 command 白名单 —— ChatInput `/` palette 的 'agent-builtin' 类目。
   *
   * 同步、半静态: 子类返回硬编码常量数组(见 claude-code/commands.ts)。
   * 不从 SDK 自动派生 —— 由开发者显式选择想暴露给用户的子集, SDK 支持
   * 但白名单未列出的命令不会进 palette。
   *
   * 执行方式: desktop 把 `/<name> [args]` 当 prompt 前缀直接 send 给当前会话,
   * 由 agent 自己识别处理。
   */
  listAgentCommands(): AgentBuiltinCommand[] {
    return [];
  }

  /**
   * Agent 用户/项目目录扫描出的 skill 列表 —— ChatInput `/` palette 的
   * 'agent-skill' 类目。
   *
   * 异步、有 IO: Claude Code 扫 ~/.claude/{commands,skills}, Codex 走
   * app-server skills/list。子类自己负责缓存策略与未授权静默处理。
   * 默认无实现, 不暴露任何 skill。
   */
  async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    void opts;
    return { skills: [] };
  }

  /**
   * ChatInput `@` palette entries for this agent kind.
   *
   * Default: workspace files/directories only. Agents can extend or replace this
   * when their native UX exposes additional @ resources.
   */
  async scanAtResources(opts: ScanAtResourcesOptions): Promise<ScanAtResourcesResult> {
    return scanWorkspaceFileResources(opts.workingDir, opts.cap, { query: opts.query });
  }

  /**
   * 列出本 agent 认识的所有本地 customization (skill / command / agent / ...)。
   *
   * 与 listSlashCommands 的关系:
   * - listSlashCommands 是 ChatInput `/` 菜单视图: 只取 enabled 的、扁平化、按 name 去重
   * - listCustomizations 是"原始全集": SkillHub 这类外部消费者要看到 disabled 的
   *   skill / 区分 command 和 skill / 拿 frontmatter 等元数据
   *
   * 实现约定:
   * - Claude Code 返回 kind ∈ {skill, command, agent}
   * - Codex 返回 kind = 'skill' (协议本身只有 skill 概念)
   * - 单个 source 失败 (目录读不了 / RPC 报错) 收集进 errors, 不整体抛
   *
   * 默认实现: 空数组 + 空 errors。子类按自家发现方式覆盖。
   */
  async listCustomizations(opts: ListCustomizationsOptions): Promise<ListCustomizationsResult> {
    void opts;
    return { items: [], errors: [] };
  }

  /**
   * 一次性 LLM 调用 —— 跑完即结束, 不开 session、不进事件流, 没有 turn 概念。
   *
   * 用途: 给会话起标题 / 合成 prompt 摘要 / commit msg 命名 等
   * "agent 自己说一句话" 类的辅助任务。
   *
   * 各 agent 选自家最便宜的可用模型实现, 鉴权 / API 路径与 startSession 同源
   * (确保 OAuth-only 用户也能用):
   *   - Claude → sdkQuery + haiku-4-5 + maxTurns:1
   *   - Codex  → Codex SDK startThread + gpt-5.4-mini
   * 调用方不关心用哪个模型, 只拿一个 string。
   *
   * 子类可选实现; 不实现时调到这里, 抛 NotSupportedError。
   */
  async oneShot(prompt: string, opts?: OneShotOptions): Promise<string> {
    void prompt; void opts;
    return this.throwNotSupported('oneShot', 'not-implemented');
  }

  /**
   * Fork 一条已有的 SDK session, 不依赖 live session。
   *
   * 调用语义:
   *   - 输入 sourceSdkSessionId + agent-specific 截断信息
   *   - 子类按各自协议 fork; Claude 额外返回 oldUuid → newUuid 映射
   *     (调用方拿来 remap agentMeta, 见 ForkSdkSessionResult)
   *   - 不动 maker 这边的 sessions / 不开 live session
   *
   * Claude / Codex 端各自实现；不支持的 agent 默认抛 NotSupportedError。
   */
  async forkSdkSession(opts: ForkSdkSessionOptions): Promise<ForkSdkSessionResult> {
    void opts;
    return this.throwNotSupported('forkSdkSession', 'sdk-missing');
  }

  // ── Auth 透传到 deps.auth ────────────────────────────────────────────────
  // Maker 不直接访问 agent.deps (protected), 通过这层 thin façade 暴露给 host
  // 的 maker:auth:* IPC handler。BaseAgent 把"agent 的鉴权"作为一等公民,
  // 跟 startSession / oneShot / fork 同级 —— 调用方不需要知道底层 AuthAdapter。

  getAuthState() {
    return this.deps.auth.getState();
  }

  triggerLogin(opts?: AuthLoginOptions) {
    return this.deps.auth.triggerLogin(opts);
  }

  logout() {
    return this.deps.auth.logout();
  }

  /**
   * 刷新 agent 本机运行时暴露的模型清单。
   *
   * 默认无运行时发现能力，返回 false；Codex 覆盖后通过 app-server `model/list`
   * 拉完整分页快照。返回值表示快照是否仍属于当前 host 且已由宿主成功应用。
   */
  async refreshLocalModels(_options?: RefreshLocalModelsOptions): Promise<boolean> {
    return false;
  }

  /**
   * Read provider account rate limits without starting a model turn.
   * Codex implements this through the app-server control plane.
   */
  async readAccountRateLimits(): Promise<AccountRateLimitsResponse> {
    return this.throwNotSupported('account:rate-limits:read', 'not-implemented');
  }

  /** Consume one banked provider reset credit without starting a model turn. */
  async consumeAccountRateLimitResetCredit(
    params: ConsumeAccountRateLimitResetCreditParams,
  ): Promise<ConsumeAccountRateLimitResetCreditResponse> {
    void params;
    return this.throwNotSupported('account:rate-limit-reset:consume', 'not-implemented');
  }

  /**
   * 取消正在进行的登录。
   * AuthAdapter 不实现 cancelLogin (Claude 是同步弹窗, 没东西可 cancel) 时此方法 no-op。
   */
  cancelLogin(): void {
    this.deps.auth.cancelLogin?.();
  }

  /** 同步取 binary path (host 注入时已存在, 构造期校验过)。供 maker:agent:status 用。 */
  getBinaryPath(): string {
    return this.deps.binaryPath;
  }

  // ── Memory 控制 (子类实现) ─────────────────────────────────────────────
  // 范围: 仅 agent "自动记忆" (Claude auto-memory / Codex experimental memories),
  // 不含手写的 CLAUDE.md / AGENTS.md 文档 (那些走 settingSources / project_doc_max_bytes)。
  // 详见 packages/maker-core/src/types/memory.ts。

  /**
   * 当前 memory 状态 + (可选) 用量元数据。
   *
   * 子类实现要点:
   *  - Claude: enabled = this.memoryOverride ?? true (SDK 默认 true);
   *            stats 可选, 扫 ~/.claude/projects/<sanitized-cwd>/memory/
   *  - Codex:  调 config/read 读 effective config 的 features.memories
   *
   * 默认实现抛 NotSupportedError, 让 capabilities.memory.supported 与方法实现保持一致 —
   * 不实现 = 不支持。
   */
  async getMemoryStatus(): Promise<MemoryStatus> {
    return this.throwNotSupported('memory:get', 'not-implemented');
  }

  /**
   * 改 memory 启用状态。
   *
   * 子类实现要点:
   *  - 必须更新 this.memoryOverride, 让后续 startSession 拿到一致的值
   *  - Claude: 当前实现只更新 memoryOverride, 不向 live SDK Query 传 applyFlagSettings
   *            (BaseAgent 不追踪 active sessions), 返 effective:'next-session'
   *  - Codex:  调 experimentalFeature/enablement/set { memories } RPC,
   *            server 端 in-memory enablement 覆盖 config.toml + 热重载所有 live thread,
   *            返 effective:'immediate'
   *
   * UI 看到 effective:'next-session' 应给用户提示 "需新会话生效"。
   */
  async setMemory(enabled: boolean): Promise<MemorySetResult> {
    void enabled;
    return this.throwNotSupported('memory:set', 'not-implemented');
  }

  /**
   * 清空 agent 已积累的所有自动记忆。**全局**, 不限当前 cwd
   * (跟 setMemory 的全局 toggle 语义对称)。
   *
   * 子类实现要点:
   *  - Claude: 遍历 ~/.claude/projects/*\/memory/ 全删 (per-cwd 子目录, 不动 *.jsonl 历史)
   *  - Codex:  调 memory/reset RPC, server 端清 <CODEX_HOME>/memories/ + sqlite stage 数据
   *
   * 失败抛错; 调用方决定 UI 怎么处理 (toast / dialog)。
   */
  async resetMemory(): Promise<MemoryResetResult> {
    return this.throwNotSupported('memory:reset', 'not-implemented');
  }

  /**
   * Agent 进程级资源回收 — app.before-quit 时由 Maker.shutdown() 调一次。
   *
   * Claude: SDK 自带 per-session lifecycle, 没 agent 级共享子进程, 默认 no-op。
   * Codex (路线 A shared app-server): 需要在这里 shutdown AppServerHost,
   *   否则 codex app-server 子进程在 Windows 上不会随父进程死, 成孤儿。
   *
   * 子类可选实现; 不实现 = no-op。**幂等**: 多次调用安全。
   */
  async dispose(): Promise<void> {
    // 默认 no-op
  }

  /**
   * 默认的"不支持"抛错助手。子类不实现某能力时调此方法。
   */
  protected throwNotSupported(capability: string, reason: 'sdk-missing' | 'not-implemented' | 'platform-limited' = 'sdk-missing', upstreamRef?: string): never {
    throw new NotSupportedError(capability, { supported: false, reason, upstreamRef });
  }
}
