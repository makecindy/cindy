/**
 * @cindy/maker-core — Cindy agent 核心抽象层
 *
 * 严格约束：本包零 Electron 依赖。所有 IO（safeStorage / userData / spawn 路径）
 * 由 host 层（apps/desktop/src/main/maker-host/）实现并通过依赖注入传入。
 */

export const VERSION = '0.0.0';

// types
export * from './types/index.js';

// interfaces
export * from './interfaces/index.js';

// agents
export * from './agents/index.js';
export { evaluatePiProjectTrust, piProjectKey } from './agents/pi/project-trust.js';

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
  memoryScopeDirName,
  buildFilename,
  parseFilename,
  validateSlug,
  type MemoryStorageMeta,
} from './memory/storage.js';
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
export {
  MemoryFlushController,
  DEFAULT_FLUSH_THRESHOLDS,
  type MemoryFlushControllerDeps,
} from './memory/flush-controller.js';
export { MAKER_MEMORY_RULES } from './memory/system-prompt.js';

// maker contacts (agent-native 智能通讯录, 全局人物实体库)
export * from './contacts/types.js';
export * from './contacts/sync/types.js';
export { createContactsSyncDelta } from './contacts/sync/merge.js';
export {
  CONTACTS_RULES_DISABLED,
  CONTACTS_RULES_ENABLED,
  type ContactsPromptState,
} from './contacts/system-prompt.js';
export { initContactsSchema, CONTACTS_SCHEMA_VERSION } from './contacts/schema.js';
export { ContactsFts, type ContactFtsDoc } from './contacts/fts.js';
export {
  namesSimilar,
  profilesNameSimilar,
  findSimilarContacts,
  scanDuplicatePairs,
  type NameFacets,
} from './contacts/dedupe.js';
export { MakerContactsStore, type MakerContactsStoreDeps } from './contacts/store.js';
export { parseVCards, serializeVCards, findEmploymentRelation } from './contacts/vcard.js';
export { importContacts } from './contacts/import.js';
export {
  MakerContactsManager,
  type MakerContactsManagerDeps,
  type ContactsSqliteFactory,
} from './contacts/manager.js';
