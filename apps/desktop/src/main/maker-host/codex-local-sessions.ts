import { createCodexLocalSessions } from '@cindy/app-runtime/codexLocalSessions';
import { projectNativeSessionMetadata } from './native-session-metadata.js';
import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { recordPrRefsForImportedMessages } from '../git-context/prRefsStore.js';
import { commitMessageMediaRefs } from '../cindy-media/chatAttachments.js';
import * as importedUserContent from './imported-user-content.js';
import { app } from 'electron';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
export type * from '@cindy/app-runtime/codexLocalSessions';
export const { scanExternalCodexSessions, importExternalCodexSessions, readCodexThreadStorageForArchive, prepareExternalCodexSessionForResume, dumpCodexThreadStateRows, reserveCodexForkCleanup, importSharedCodexThread, removeSharedCodexThread, classifyCodexHistoryOversized, importExternalCodexMessagesForSession, parseCodexRolloutMessageLine } = createCodexLocalSessions({
  projectNativeSessionMetadata: (...args) => projectNativeSessionMetadata(...args), getCurrentDbClientUserId: () => getCurrentDbClientUserId(), getDbClient: () => getDbClient(), recordPrRefsForImportedMessages: (...args) => recordPrRefsForImportedMessages(...args), commitMessageMediaRefs: (...args) => commitMessageMediaRefs(...args), importedUserContent, logger: createLogger('codex-local-sessions'),
  userDataDirectory: () => app?.getPath?.('userData'), get region() { return CURRENT_CINDY_REGION; }, createBetterSqliteDatabase,
});
