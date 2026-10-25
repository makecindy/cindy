import {createSessionRuntimeCleanup} from '@cindy/app-runtime/sessionRuntimeCleanup';
export type * from '@cindy/app-runtime/sessionRuntimeCleanup';
import {requestSessionArchiveSync} from './sessionArchiveSync.js';
export const {setSessionRuntimeCleanup, cleanupSessionRuntimeForTerminalStatus}=createSessionRuntimeCleanup(requestSessionArchiveSync);
