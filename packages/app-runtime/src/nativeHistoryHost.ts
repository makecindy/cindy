import type { DbClient } from '@cindy/runtime-db';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { createNativeSessionMetadata } from '@cindy/runtime-db/nativeSessionMetadata';
import type { createPrRefsStore } from '@cindy/runtime-db/prRefsStore';
import type { createImportedUserContent } from './importedUserContent.js';
import type { createChatAttachments } from './chatAttachments.js';

export interface NativeHistoryHost {
  getDbClient(): DbClient;
  getCurrentDbClientUserId(): string | null;
  logger: DbLogger;
  projectNativeSessionMetadata: ReturnType<typeof createNativeSessionMetadata>['projectNativeSessionMetadata'];
  recordPrRefsForImportedMessages: ReturnType<typeof createPrRefsStore>['recordPrRefsForImportedMessages'];
  commitMessageMediaRefs: ReturnType<typeof createChatAttachments>['commitMessageMediaRefs'];
  importedUserContent: ReturnType<typeof createImportedUserContent>;
}
