/**
 * AgentRuntimeConfig — 部署 + 行为配置（host 注入，Agent 内部组装到 env）。
 *
 * 与 AuthAdapter 拆分原因：
 * - AuthAdapter 只管"真鉴权"（API key / OAuth credentials home 等）
 * - AgentRuntimeConfig 装"接入端点"（proxy URL）+ host 侧业务行为配置
 * - 这样 CLI host 可以一行配置切换不走 proxy；业务 flag 也能交给用户 settings 调
 */

import type { AgentCredentialMode } from './auth-adapter.js';

/** 函数形态 behaviorFlags 的入参:本次 spawn 的凭证形态(undefined = 未显式指定,走 adapter fallback)。 */
export interface BehaviorFlagsContext {
  credentialMode?: AgentCredentialMode;
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
   * Claude 当前用到：CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS
   *
   * 函数形态:flag 需要按本次 spawn 的凭证形态分叉时用(env-builder 在组装 env 时
   * 以 spawn 的 credentialMode 调用)。典型:CLAUDE_CODE_ATTRIBUTION_HEADER 只对
   * gateway-key spawn 禁用——oauth 侧禁用会让订阅直连的 Auto 分类器子请求被上游
   * 429(desktop issue #758)。静态对象形态语义不变。
   */
  behaviorFlags?: Record<string, string> | ((ctx: BehaviorFlagsContext) => Record<string, string>);

  /**
   * Host-managed default model for native subagents.
   *
   * - undefined / blank: do not override the agent's native selection logic
   * - non-blank: the agent implementation injects the vendor-supported deterministic override
   *
   * Claude maps this to `CLAUDE_CODE_SUBAGENT_MODEL`. Codex does not consume it yet because
   * its full-history fork path rejects model overrides in the currently bundled binary.
   */
  subagentModel?: string;

  /**
   * Claude Code 自动上下文压缩阈值百分比。
   *
   * - undefined: host 不接管自动压缩 (保持 agent 默认行为)
   * - 50-95: 每个 turn 结束时, maker-core 基于最新 usage 快照判断是否静默注入 `/compact`
   *
   * Host 可以用 getter 注入, Claude agent 会在每次判断时读取最新值。
   */
  autoCompactThresholdPct?: number;

  /**
   * Host-managed executable directories to prepend to the agent subprocess PATH.
   *
   * Used for bundled tools that should win over user/system installations, e.g.
   * desktop-packaged ripgrep. Agent implementations decide which subprocesses
   * consume it; paths should already be absolute and host-validated.
   */
  pathPrepends?: string[];

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
   * Electron app.getPath('userData') 绝对路径, host 注入。
   * MakerMemoryManager 用作 basePath 算 <userData>/maker-memory/<sanitized-workdir>/。
   * maker-core 自己拿不到 (没 Electron 依赖) —— 必须 host 显式传。
   * 缺省 (undefined) 时 maker memory 模块不可用, 调用 manager.getStore 会抛错。
   */
  userDataPath?: string;
}
