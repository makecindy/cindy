import { localSessionHost } from './localHost.js';
import {
  patchSessionMetaInDb, renameSessionTitlesInDb, setSessionsStatusInDb, updateSessionInDb,
} from '../localDb/ipc/sessions.js';
import { createSessionController, sessionOperation } from './controller.js';
import { requireSessionCaller } from './callerContext.js';
import { listSessionsForHistory } from '../localDb/chatHistoryReader.js';

// Record operations must remain available before Maker/runtime initialization.
// Lazy port bodies avoid reading the database during module/IPC registration.
const controller = createSessionController(localSessionHost, {
  list: sessionOperation({ operation: 'listRecords',
    targets: (p: Parameters<typeof listSessionsForHistory>[0]) => p.sessionIds ?? [],
    execute: (_scope, p: Parameters<typeof listSessionsForHistory>[0]) => listSessionsForHistory(p) }),
  patchMetadata: sessionOperation({
    operation: 'updateMetadata', targets: (id: string, _patch: Parameters<typeof patchSessionMetaInDb>[1]) => [id],
    execute: (_scope, ...args: Parameters<typeof patchSessionMetaInDb>) => patchSessionMetaInDb(...args),
  }),
  updateRecordForUi: sessionOperation({
    operation: 'updateMetadata', targets: (...args: Parameters<typeof updateSessionInDb>) => [args[0]],
    execute: (_scope, ...args: Parameters<typeof updateSessionInDb>) => updateSessionInDb(...args),
  }),
  rename: sessionOperation({
    operation: 'updateMetadata', targets: (...args: Parameters<typeof renameSessionTitlesInDb>) => args[0].map(change => change.sessionId),
    execute: (_scope, ...args: Parameters<typeof renameSessionTitlesInDb>) => renameSessionTitlesInDb(...args),
  }),
  setStatus: sessionOperation({
    operation: 'setRecordStatus', targets: (...args: Parameters<typeof setSessionsStatusInDb>) => args[0],
    execute: (_scope, ...args: Parameters<typeof setSessionsStatusInDb>) => setSessionsStatusInDb(...args),
  }),
  setRecordStatus: sessionOperation({ operation: 'setRecordStatus', targets: (id: string, _status: 'active' | 'archived' | 'deleted') => [id],
    execute: (_scope, id: string, status: 'active' | 'archived' | 'deleted') => patchSessionMetaInDb(id, { status }) }),
});

export const sessionRecords = {
  setRecordStatus: (id: string, status: 'active' | 'archived' | 'deleted') => controller.invoke(controller.issueCaller(requireSessionCaller()), 'setRecordStatus', id, status),
  list: (...args: Parameters<typeof listSessionsForHistory>) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'list', ...args),
  patchMetadata: (...args: Parameters<typeof patchSessionMetaInDb>) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'patchMetadata', ...args),
  updateRecordForUi: (...args: Parameters<typeof updateSessionInDb>) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'updateRecordForUi', ...args),
  rename: (...args: Parameters<typeof renameSessionTitlesInDb>) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'rename', ...args),
  setStatus: (...args: Parameters<typeof setSessionsStatusInDb>) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'setStatus', ...args),
};
