import {createProvisionalSessions} from '@cindy/runtime-db/provisionalSessions';
export type * from '@cindy/runtime-db/provisionalSessions';
import * as currentDb from './client/current.js';
import {createLogger} from '../logger.js';
export const {configureProvisionalSessions, markProvisionalSession, provisionalManagedDir, isProvisionalSession, claimOwnedProvisionalSession, forgetProvisionalSession, deleteUnsentSessionRow, removeEmptyDialogueDir, sweepLeftoverProvisionalSessions, resetProvisionalSessionsForTest}=createProvisionalSessions({currentDb:{getDbClient:()=>currentDb.getDbClient(),getCurrentDbClientSnapshot:()=>currentDb.getCurrentDbClientSnapshot()},logger:createLogger('provisional-sessions')});
