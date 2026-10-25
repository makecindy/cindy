import { createClaudeLocalSessions } from '@cindy/app-runtime/claudeLocalSessions';
import { projectNativeSessionMetadata } from './native-session-metadata.js';
import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { recordPrRefsForImportedMessages } from '../git-context/prRefsStore.js';
import { commitMessageMediaRefs } from '../cindy-media/chatAttachments.js';
import * as importedUserContent from './imported-user-content.js';
export type * from '@cindy/app-runtime/claudeLocalSessions';
export const { scanExternalClaudeCodeSessions, importExternalClaudeCodeSessions, importExternalClaudeCodeMessagesForSession, readClaudeCodeSessionScanSummary, readClaudeCodeSessionSummary, parseClaudeCodeMessageLine } = createClaudeLocalSessions({
  projectNativeSessionMetadata: (...args) => projectNativeSessionMetadata(...args), getCurrentDbClientUserId: () => getCurrentDbClientUserId(), getDbClient: () => getDbClient(), recordPrRefsForImportedMessages: (...args) => recordPrRefsForImportedMessages(...args), commitMessageMediaRefs: (...args) => commitMessageMediaRefs(...args), importedUserContent, logger: createLogger('claude-local-sessions'),
});
