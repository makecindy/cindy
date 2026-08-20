export * from './base-agent.js';
// toSdkModelString: host 侧标题 oneShot 需要把 catalog model id 还原成 Anthropic wire 串
// (claude-haiku-4-5 → claude-haiku-4-5-20251001),复用 SSoT 映射,避免在 host 硬编码 dated id。
export { ClaudeCodeAgent, toSdkModelString, setClaudeSupportedModelsListener } from './claude-code/index.js';
export type {
  ClaudeSubagentModelAccessResult,
  ClaudeSubagentModelAccessStatus,
} from './claude-code/subagent-model-access.js';
export { CodexAgent } from './codex/index.js';
// host 导入本地 Codex rollout 历史时也要做 citation 归一化(流式路径在 translator
// 内部做,导入路径拿到的是 rollout 原文),复用同一实现避免口径分叉。
// finalizeCodexCitationText = 剥截断残尾 + 归一化(与流式 completed 完全同口径)。
export { finalizeCodexCitationText, normalizeCodexFileCitations } from './codex/translator.js';
export { PiAgent } from './pi/index.js';
export {
  canReuseCodexHostForCredentialMode,
  canReuseHostForCredentialMode,
  resolveAgentCredentialMode,
} from './credential-mode.js';
// host 在 boot 阶段需要的 env 守卫(详见 claude-code/env-builder.ts 注释)
export {
  SENSITIVE_ANTHROPIC_ENV_KEYS,
  stripSensitiveAnthropicEnv,
} from './claude-code/env-builder.js';
// host 配置 LLM-context 图片预缩 resizer (注入 logger / 调阈值)
export {
  ImageResizer,
  getDefaultImageResizer,
  configureDefaultImageResizer,
  type ImageResizerConfig,
  type ImageResizerLogger,
} from './shared/image-resizer.js';
export {
  parseReconnectAttemptMessage,
  type ReconnectAttempt,
} from './shared/network-error.js';
// host 侧会话移动(workingDir 变更)时迁移 CLI 转录,防 resume 报
// "No conversation found"(详见 claude-code/transcript-relocation.ts 注释)
export {
  relocateClaudeSessionTranscripts,
  type RelocateClaudeTranscriptsOptions,
  type RelocateClaudeTranscriptsResult,
} from './claude-code/transcript-relocation.js';
// host 侧 IM / hook 渠道的进度区要把「上游过载, 正在自动重试」透成一行状态说明
// (renderer 因跨 bundle 才另存一份镜像; main 与 maker-core 同 bundle, 直接复用
// 同一份判定, 不再造第三份)。详见 shared/overload-error.ts 的模块注释。
export {
  UPSTREAM_OVERLOAD_REASON,
  parseOverloadError,
  parseOverloadRetryProgress,
  isOverloadErrorMessage,
  type OverloadError,
  type OverloadErrorKind,
} from './shared/overload-error.js';
// Desktop main 的 IM / hook 渠道与 maker-core 同 bundle，直接复用终态 429 的
// reason + marker 解析契约，避免渠道侧再维护一份正则。
export {
  TERMINAL_RATE_LIMIT_RETRY_REASON,
  parseTerminalRateLimitRetryProgress,
} from './codex/terminal-rate-limit-retry.js';
// 同上理由(同 bundle 直接复用): desktop main 的错误投影 / IM 渠道要认「上下文超限」
// 这一类 —— 原样重试必败, 恢复动作是压缩上下文或新开会话, 与过载 / 网络类的自动
// 重试语义相反。详见 shared/context-overflow-error.ts 的模块注释(#1429)。
export {
  CONTEXT_OVERFLOW_REASON,
  isContextOverflowErrorMessage,
} from './shared/context-overflow-error.js';
// ErrorBanner 用人话替换 LiteLLM / Responses 空壳流中断,不驱动自动续跑。
export {
  UPSTREAM_STREAM_INTERRUPTED_REASON,
  isStreamInterruptedErrorMessage,
} from './shared/stream-interrupt-error.js';
// 同上理由(同 bundle 直接复用,不造第三份):desktop 的中断自愈判据要认「网络到不了
// 上游」这一类 —— 那类同样是"连不上"而不是"请求有问题",续跑一次就能过去。
export { isNetworkishErrorMessage } from './shared/network-error.js';
export {
  AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE,
  AUTO_REVIEW_UNAVAILABLE_CODE,
  AUTO_REVIEW_UNAVAILABLE_METADATA_KEY,
  AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT,
  AUTO_REVIEW_MAX_REQUEST_TIMEOUT_MS,
  AUTO_REVIEW_RETRY_ATTEMPTS,
  AUTO_REVIEW_RETRY_BACKOFF_MS,
  AUTO_REVIEW_RETRY_SCHEDULING_SLACK_MS,
  autoReviewRetryBudgetMs,
  DEFAULT_AUTO_REVIEW_TIMEOUT_POLICY,
  getAutoReviewActionTextLength,
  getAutoReviewDelegateHardCeilingMs,
  isAutoReviewConfirmUndeliveredNotice,
  isAutoReviewUnavailableMetadata,
  isAutoReviewUnavailableNotice,
  isSystemPermissionDenialReason,
  MAX_AUTO_REVIEW_ACTION_TEXT_CHARS,
  type AutoReviewDecision,
  type AutoReviewDelegate,
  type AutoReviewRequest,
  type AutoReviewTimeoutPolicy,
} from './shared/auto-review-decision.js';
export type { ReviewableAction } from './shared/auto-review.js';
export {
  ORCA_NESTED_REPORT_DENIAL_REASON,
  ORCA_NESTED_REPORT_ERROR_CODE,
  ORCA_NESTED_REPORT_ERROR_MESSAGE,
} from './shared/orca-report-policy.js';
// host 侧会话分享(导出/导入 .xdtshare)需要按 cwd 复算 CLI 转录目录、
// 定位/落位 jsonl。规则单点维护在 claude-projects-fs.ts,这里仅 re-export。
export {
  sanitizeClaudeProjectKey,
  isClaudeProjectKeyExact,
  findClaudeSessionJsonl,
} from './claude-code/claude-projects-fs.js';
