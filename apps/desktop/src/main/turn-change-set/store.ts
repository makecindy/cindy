import { app, BrowserWindow } from 'electron';
import { createId } from '@paralleldrive/cuid2';
import { createTurnChangeSetStore } from '@cindy/remote-agent/host/turn-change-set/store';
import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import * as broadcastTap from '../device-link/broadcast-tap.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
export { TurnChangeSetActionError, TURN_CHANGE_SET_DETAIL_ID_LIMIT } from '@cindy/remote-agent/host/turn-change-set/store';
export type { KnownFileWriteCapture, OpaqueTurnChangeCapture, BeginTurnChangeSetInput, TurnChangeSetActionErrorKind } from '@cindy/remote-agent/host/turn-change-set/store';

const log = createLogger('turn-change-set');
const store = createTurnChangeSetStore({
  userDataPath: () => app.getPath('userData'), createId, log,
  captureOwnerScope: () => broadcastTap.captureDataOwnerBroadcastScope(),
  isOwnerScopeCurrent: scope => broadcastTap.isDataOwnerBroadcastScopeCurrent(scope),
  broadcastUpdated(payload, scope) {
    broadcastTap.tapWindowBroadcast(MAKER_PUSH.TURN_CHANGE_SET_UPDATED, payload, scope.ownerStamp);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(MAKER_PUSH.TURN_CHANGE_SET_UPDATED, payload, scope.ownerStamp); }
      catch (error) { log.warn('renderer turn change-set broadcast failed', { error }); }
    }
  },
  async readWorkspace(sessionId) {
    const rows = await getDbClient().query<{ workingDir: string; remoteHostId: string | null }>(
      `SELECT working_dir AS workingDir, remote_host_id AS remoteHostId
         FROM sessions WHERE id = ? LIMIT 1`, [sessionId]);
    return rows[0] ?? null;
  },
  async validAnchorIds(sessionId, ids) {
    const sessions = await getDbClient().query<{ id: string }>('SELECT id FROM sessions WHERE id = ? LIMIT 1', [sessionId]);
    if (!sessions.length || !ids.length) return new Set<string>();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await getDbClient().query<{ clientId: string }>(
      `SELECT client_id AS clientId FROM messages
        WHERE session_id = ? AND role = 'user' AND rewind_at IS NULL
          AND client_id IN (${placeholders})`, [sessionId, ...ids]);
    return new Set(rows.map(row => row.clientId));
  },
});
export const {
  normalizeTurnChangeSetWorkspaceKey,
  waitForTurnChangeSetActions,
  waitForTurnChangeSetPersistence,
  beginTurnChangeSet,
  captureKnownFileBefore,
  noteOpaqueTurnChange,
  noteTurnDiffEvent,
  finalizeTurnChangeSet,
  waitForTurnChangeSetSeal,
  applyTurnChangeSetAction,
  clearPendingTurnChangeSets,
  listTurnChangeSets,
  getTurnChangeSets,
  removeTurnChangeSetsForSession
} = store;
