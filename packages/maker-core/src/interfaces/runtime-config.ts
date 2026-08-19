/**
 * AgentRuntimeConfig — 部署 + 行为配置（host 注入，Agent 内部组装到 env）。
 *
 * 与 AuthAdapter 拆分原因：
 * - AuthAdapter 只管"真鉴权"（API key / OAuth credentials home 等）
 * - AgentRuntimeConfig 装"接入端点"（proxy URL）+ host 侧业务行为配置
 * - 这样 CLI host 可以一行配置切换不走 proxy；业务 flag 也能交给用户 settings 调
 */

import type { SubagentModelDiagnostic } from '../agents/claude-code/subagent-model-default.js';
import type { AgentCredentialMode } from './auth-adapter.js';

/** 函数形态 behaviorFlags 的入参:本次 spawn 的凭证形态、来源与执行位置。 */
export interface BehaviorFlagsContext {
  credentialMode?: AgentCredentialMode;
  /** 本次 spawn 的会话来源。null/undefined = 隐式默认路由。 */
  sessionProviderId?: string | null;
  /**
   * 本次 spawn 落在哪台机器:'local' = 本机子进程,'remote' = 远端 daemon。
   * host 据此决定"只对本机有意义"的 flag(如按本机核数算的工具链限核 env)
   * 要不要注入 —— 本机核数注到远端机器纯属错误值。undefined 视同 'local'
   * (未接入该字段的调用方保持旧行为)。
   */
  spawnMode?: 'local' | 'remote';
}

export interface AgentRuntimeConfig {
  /**
   * 接入端点。设为 undefined 表示走 SDK 默认（如 api.anthropic.com）。
   * Claude: 翻译为 ANTHROPIC_BASE_URL env。
   * Codex: 当前不支持 endpoint 覆盖（SDK 没暴露），传了也忽略。
   */
  endpoint?: string;

  /**
   * 远端（cc-mgr daemon）会话专用接入端点。
   *
   * 背景：`endpoint` 在 desktop 上是本地 loopback compat-proxy 的 URL
   * （`127.0.0.1:<port>`），远端机器**够不到**。远端 cc 必须直连真上游（公司网关），
   * 鉴权 / 字段适配走网关侧 —— per-model 的 OAuth↔gateway 拆分只在本地 loopback proxy 里
   * 才有意义，远端恒用网关 key + 网关 endpoint。
   *
   * - 设了：`buildClaudeEnv(mode:'remote')` 用它写 ANTHROPIC_BASE_URL（绝不用 loopback）。
   * - undefined：回落到 `endpoint`（保持旧行为；host 不区分远端时无需设）。
   *
   * Claude: 仅 remote 模式生效。Codex: 不支持，忽略。
   */
  remoteEndpoint?: string;

  /**
   * 业务行为 flag。Agent 内部决定哪些 key 有意义。
   * Claude 当前用到：CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS、
   * CLAUDE_CODE_ATTRIBUTION_HEADER、ENABLE_TOOL_SEARCH
   *
   * 函数形态:flag 需要按本次 spawn 的凭证形态或来源分叉时用(env-builder 在组装 env
   * 时传入 route context)。典型:CLAUDE_CODE_ATTRIBUTION_HEADER 只对 gateway-key
   * spawn 禁用(issue #758);ENABLE_TOOL_SEARCH 只对确认兼容 deferred tools 的来源
   * 开启(issue #2929)。静态对象形态语义不变。
   */
  behaviorFlags?: Record<string, string> | ((ctx: BehaviorFlagsContext) => Record<string, string>);

  /**
   * Host-managed default model for native subagents.
   *
   * - undefined / blank: do not override the agent's native selection logic
   * - non-blank: the agent implementation injects the vendor-supported deterministic override
   *
   * Claude maps this to `CLAUDE_CODE_SUBAGENT_MODEL`. Codex does not consume this field. Desktop's
   * personalized Codex Subagent route is enforced by its loopback proxy after native child-thread
   * creation, so maker-core must not reinterpret it as a Codex spawn-time model override.
   *
   * ⚠️ 该 env 在 cc 的解析顺序里是**最高优先级**,不仅压过 agent frontmatter 的 `model:`,
   * 也压过每次 Task/Agent 调用传入的 `model` 参数,而平台不提供更低优先级的槽位。
   * Claude agent 因此只在「本会话没有任何手写 agent 声明 model」时才注入它 —— 取舍与实测
   * 依据见 agents/claude-code/subagent-model-default.ts 的模块头。
   */
  subagentModel?: string;

  /**
   * 路由感知版 subagent 覆写(优先于 subagentModel):env-builder 传入本次 spawn 的
   * 会话来源(显式 providerId,null = 隐式默认),host 据此判定覆写在**该来源**下是否
   * 仍可路由(子代理跑在父会话来源上;停用轴按 (来源, 模型) 记账,只看「任一来源可用」
   * 会让父会话来源下被停用的拷贝继续被子代理付费使用,PR #744 review 第十九轮)。
   * `credentialMode` 是本次 spawn 已解析的凭证形态:providerId 为 null(隐式默认)
   * 时 host 据它映射实际落点(gateway-key = XD 网关 / oauth-bearer = Anthropic 直连),
   * 不再静态猜测(PR #744 review 第二十轮)。
   * 返回 undefined = 不注入覆写,回退 CLI 原生 subagent 选择。缺席时退回 subagentModel。
   */
  subagentModelForRoute?: (
    providerId: string | null,
    credentialMode?: string,
  ) => string | undefined;

  /**
   * Host 管的自动上下文压缩阈值百分比。Claude Code 与 Pi 共用同一份设置；Codex 仍由上游自己压。
   *
   * - undefined: host 不接管自动压缩 (保持 agent 默认行为)
   * - 50-95: 每个 turn 结束时, maker-core 基于最新 usage 快照判断。
   *   Claude Code 静默注入 `/compact`；Pi 调已有 compact RPC。
   *   Pi 原生 `window - reserveTokens` 仍作顶满抢救。
   *
   * Host 可以用 getter 注入, agent 会在每次判断时读取最新值。
   */
  autoCompactThresholdPct?: number;

  /**
   * Host-managed executable directories to prepend to agent subprocess PATH.
   *
   * Only agents whose executable lookup is safe for PATH-based discovery should consume this.
   * PI intentionally does not: Windows may resolve an executable from cwd before PATH.
   */
  pathPrepends?: string[];

  /**
   * Host-validated executable paths that an agent may stage into its private runtime.
   *
   * These are explicit paths rather than PATH entries: read-only tools can otherwise
   * execute a same-named program from an untrusted working directory on Windows.
   */
  managedExecutablePaths?: Readonly<{
    ripgrep?: string;
  }>;

  /**
   * 宿主产品级 system prompt 注入（host 层）。
   * 与 engine 内置 (agents/{vendor}/system-prompt-append.ts) 和 per-call 外部
   * (StartSessionOptions.systemPrompt) 区分：本字段表达"装载本引擎的产品自身的设定"，
   * 例如 desktop "xdt-maker" 限定的引导语。
   * 最终拼接顺序：CLI preset → engine 内置 → 本字段 → per-call 外部。
   * Claude: 翻译为 systemPrompt.append。
   * Codex: SDK 不支持，传了也忽略。
   */
  systemPrompt?: string;

  /**
   * 是否启用 agent 的自动记忆 (Claude auto-memory / Codex experimental memories)。
   * - undefined : 走 agent 自带默认 (Claude=true, Codex=false)
   * - true/false: host 强制覆盖
   *
   * 落地:
   *  - Claude → 注入到 buildQuery options.settings.autoMemoryEnabled (+ autoDream 联动)
   *  - Codex  → startSession 时调 experimentalFeature/enablement/set { memories: ... }
   *
   * 运行时可通过 BaseAgent.setMemory(enabled) 改, 不必重启 host。
   */
  memoryEnabled?: boolean;

  /**
   * 是否启用 Maker Memory (跨 agent 共享、host 接管的 workdir-scoped 记忆系统)。
   * - undefined / false : 不启用, 走 agent 各自的原生 memory
   * - true              : 启用 — agent 端在 startSession 时拼 prompt 注入 memory 段 +
   *                        MakerMemoryManager.enable() 联动调各 agent.setMemory(false) 关原生
   *
   * 由 ChatInput 启 session 时透传当前最新值 (跟 userPrompt 同模式), main 不持久化,
   * renderer localStorage 是 source of truth (memorySettingsStore.getMemoryMode())。
   *
   * 跟 memoryEnabled 强制互斥 — 启用时 maker memory 会调 agent.setMemory(false) 关原生,
   * 不允许 (true, true) 共存 (双写会污染 LLM 上下文)。
   */
  makerMemoryEnabled?: boolean;

  /**
   * 「Subagent 模型」相关诊断的回调(见 agents/claude-code/subagent-model-default.ts)。
   *
   * 会话启动时扫描用户手写 subagent 定义,对每条问题逐一回调。当前的种类见
   * `SubagentModelDiagnosticKind`:声明的模型不在可用清单里(`unknown-model`),或用了会随
   * 二进制升级漂移的裸别名(`alias-model`)。
   *
   * host 据此落日志、在会话内提示用户、或交给 AI 查询。缺省 = 只落 agent 层日志。
   * 回调抛错被吞(诊断不能影响会话启动)。
   */
  onSubagentModelDiagnostics?: (diagnostics: readonly SubagentModelDiagnostic[]) => void;

  /**
   * Electron app.getPath('userData') 绝对路径, host 注入。
   * MakerMemoryManager 用作 basePath 算 <userData>/maker-memory/<sanitized-workdir>/。
   * maker-core 自己拿不到 (没 Electron 依赖) —— 必须 host 显式传。
   * 缺省 (undefined) 时 maker memory 模块不可用, 调用 manager.getStore 会抛错。
   */
  userDataPath?: string;
}
