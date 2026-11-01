/**
 * @cindy/maker-core — Cindy agent 核心抽象层
 *
 * 严格约束：本包零 Electron 依赖。所有 IO（safeStorage / userData / spawn 路径）
 * 由 host 层（apps/desktop/src/main/maker-host/）实现并通过依赖注入传入。
 */

export const VERSION = '0.0.0';
export { standardSpeedRequest, withFastModePolicy } from './agents/shared/fast-mode-policy.js';

// types
export * from './types/index.js';

// interfaces
export * from './interfaces/index.js';

// agents
export * from './agents/index.js';
export * from './agents/pi/managed-command.js';
export { evaluatePiProjectTrust, piProjectKey } from './agents/pi/project-trust.js';
export {
  assertReviewMessageContentPaths,
  buildReviewReadGrants,
  pathIsWithinReviewGrant,
  reviewFileLinkLayoutIsSafe,
  resolveReviewReadPath,
  type ReviewReadGrant,
} from './agents/shared/review-read-scope.js';
export { isReviewSensitiveCredentialPath, isSensitiveCredentialPath } from './agents/shared/sensitive-credential-paths.js';

// codex app-server transport interface — host 实现自定义 transport (e.g. SSH-bridged
// for remote codex) 时需要这个接口形状。
export type {
  Transport as CodexAppServerTransport,
  LineHandler as CodexAppServerLineHandler,
  StderrHandler as CodexAppServerStderrHandler,
  CloseHandler as CodexAppServerCloseHandler,
  TransportCloseInfo as CodexAppServerCloseInfo,
} from './agents/codex/app-server/transport.js';
export type {
  CodexModelListItem,
  DynamicToolCallResponse,
} from './agents/codex/app-server/protocol.js';

// pi transport interface — host 实现自定义 transport (SSH-bridged remote pi) 时需要。
export type {
  PiTransport,
  PiTransportCloseInfo,
  PiLineHandler,
  PiCloseHandler,
  PiOversizedFrameHandler,
} from './agents/pi/transport.js';
// pi 远端 agentHome 文件操作原语(host 经 SSH 实现)。
export type { PiRemoteFileOps } from './agents/base-agent.js';
// 设备托管会话的链路往来快照(host 的任务隧道记录)。
export type { DeviceHostedLinkActivity } from './agents/base-agent.js';

// core
export * from './session.js';
export * from './session-send-outcome.js';
export * from './maker.js';
export * from './types/context-usage.js';

// maker memory (cross-agent shared workdir-scoped memory)
export * from './memory/types.js';
export {
  MemoryStorage,
  sanitizeWorkdir,
  buildMemoryScopeKey,
  buildBotMemoryScopeKey,
  parseBotMemoryScopeKey,
  buildBotGuestMemoryScopeKey,
  parseBotMemoryScope,
  memoryScopeDirName,
  buildFilename,
  parseFilename,
  validateSlug,
  SSH_SCOPE_KEY_PREFIX,
  type MemoryStorageMeta,
  type BotMemoryScope,
} from './memory/storage.js';
export {
  resolveMemoryScopeKey,
  __clearMemoryScopeKeyCacheForTests,
  type GitProbe,
  type ResolveMemoryScopeKeyDeps,
} from './memory/scope-resolver.js';
export { MemoryFts } from './memory/fts.js';
export {
  MakerMemoryStore,
  type MakerMemoryStoreDeps,
  type ConsolidateOptions,
  type ConsolidateResult,
} from './memory/store.js';
export {
  MakerMemoryManager,
  type MakerMemoryManagerDeps,
  type MakerMemoryState,
  type SetEnabledResult,
  type SqliteFactory,
} from './memory/manager.js';
export { isBotMcpServerAllowed } from './agents/shared/bot-runtime-policy.js';
export {
  MemoryFlushController,
  DEFAULT_FLUSH_THRESHOLDS,
  type MemoryFlushControllerDeps,
} from './memory/flush-controller.js';
export { MAKER_MEMORY_RULES } from './memory/system-prompt.js';

export { LIBRARY_READ_ROOT, parseLibraryAssetRef, resolveLibraryAssetPath } from './agents/shared/library-native-read.js';
export { VoiceCallContext, type VoiceCallRecord, type VoiceCallTurn, type VoiceCallHandoff } from './voice-call.js';
