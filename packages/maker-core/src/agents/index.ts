export * from './base-agent.js';
// toSdkModelString: host 侧标题 oneShot 需要把 catalog model id 还原成 Anthropic wire 串
// (claude-haiku-4-5 → claude-haiku-4-5-20251001),复用 SSoT 映射,避免在 host 硬编码 dated id。
export { ClaudeCodeAgent, toSdkModelString, setClaudeSupportedModelsListener } from './claude-code/index.js';
export { CodexAgent } from './codex/index.js';
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
// host 侧会话分享(导出/导入 .xdtshare)需要按 cwd 复算 CLI 转录目录、
// 定位/落位 jsonl。规则单点维护在 claude-projects-fs.ts,这里仅 re-export。
export {
  sanitizeClaudeProjectKey,
  isClaudeProjectKeyExact,
  findClaudeSessionJsonl,
} from './claude-code/claude-projects-fs.js';
