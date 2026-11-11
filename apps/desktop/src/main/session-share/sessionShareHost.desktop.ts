import { BrowserWindow, dialog } from 'electron';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { clearSessionAttention } from '../appBadgeService.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { notifyGhostSessionEvent } from '../cindy-brain/index.js';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal.desktop.js';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { compactSessionToolResultsBestEffort } from '../localDb/toolResultCompaction.js';
import { broadcastSessionPatched, captureSessionRecycleScope, requestSessionWorktreeRecycle,
  recycleSessionWorktreeForStatusChange } from '../localDb/ipc/sessions.js';
import { cleanupReplacedSessionMediaRefs, commitShareImport, type CommitShareImportOptions,
  type CommitShareImportResult } from './sessionShareImport.js';
import { SHARE_FILE_EXT } from './xdtshareFormat.pure.js';

/** Existing native save location and filename, shared by the UI and Agent tools. */
export async function chooseSessionShareExportPath(sessionId: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return null;
  const row = await getDbClient().queryOne<{ title: string | null }>('SELECT title FROM sessions WHERE id = ? LIMIT 1', [sessionId]);
  const name = (row?.title || 'session')
    // eslint-disable-next-line no-control-regex -- Windows filename characters.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || 'session';
  const result = await dialog.showSaveDialog(win, { defaultPath: `${name}${SHARE_FILE_EXT}`,
    filters: [{ name: `${BRAND_NAME} Session Share`, extensions: [SHARE_FILE_EXT.slice(1)] }] });
  return result.canceled ? null : result.filePath ?? null;
}

/** One owner-bound transaction and lifecycle cleanup for UI, Agent and plugin imports. */
export async function commitSessionShareOnHost(options: CommitShareImportOptions,
  assertCallerCurrent: () => void = () => {}): Promise<CommitShareImportResult> {
  const ownerScopeKey = activeOwnerScopeKey();
  const importDbClient = getDbClient();
  const recycleScope = captureSessionRecycleScope(importDbClient);
  const refCompensationScope = captureMediaRefCompensationScope(ownerScopeKey);
  const isStillCurrent = (): boolean => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === ownerScopeKey && tryGetDbClient() === importDbClient;
  const assertStillValid = (): void => {
    assertCallerCurrent();
    if (!isStillCurrent()) throw new Error('Session share import owner changed during import');
    refCompensationScope.assertStillValid();
  };
  assertStillValid();
  const result = await commitShareImport(options, {
    dbClient: importDbClient, assertStillValid, refCompensationScope,
    requestWorktreeRecycle: sessionId => requestSessionWorktreeRecycle(importDbClient.drizzle, sessionId),
  });
  // Only the committed replacement graph may clean up runtime/UI and media references.
  for (const replaced of result.replacedSessions) {
    if (!isStillCurrent()) break;
    clearSessionAttention(replaced.id, 'explicit');
    broadcastSessionPatched(replaced.id, { status: 'deleted' }, recycleScope.ownerScope);
    void compactSessionToolResultsBestEffort({ client: importDbClient, sessionId: replaced.id });
    await recycleSessionWorktreeForStatusChange(replaced.id, 'deleted', recycleScope);
  }
  if (isStillCurrent()) await cleanupReplacedSessionMediaRefs(result.replacedSessions, importDbClient.drizzle);
  assertStillValid();
  notifyGhostSessionEvent('created', { sessionId: result.sessionId });
  return { sessionId: result.sessionId, fidelity: result.fidelity, notes: result.notes, orcaWorkers: result.orcaWorkers };
}
