import type { DbClient } from '@cindy/runtime-db/client/DbClient';
import type { WorktreeManagerPorts, WorktreeTransferRow } from '@cindy/worktree-core/managerPorts';

/** Read the same committed delegation/session transaction during recovery on
 * either host. An absent row remains an unknown outcome to the shared manager. */
export function createWorktreeSessionTransferReader(getDbClient: () => DbClient): WorktreeManagerPorts['readSessionTransfer'] {
  return (transfer) => getDbClient().queryOne<WorktreeTransferRow>(
    `SELECT d.child_session_id AS childSessionId, d.requesting_bot_id AS requestingBotId,
    s.worktree_path AS worktreePath, s.id AS persistedSessionId,
    EXISTS(SELECT 1 FROM sessions WHERE id = ?) AS targetExists
    FROM bot_delegations d LEFT JOIN sessions s ON s.id = d.child_session_id WHERE d.id = ?`,
    [transfer.sessionId, transfer.delegationId],
  );
}
