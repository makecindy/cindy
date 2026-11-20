/** A Worker can commit before the independent-task projection is written. */
export const COMMITTED_SIDE_CHAT_WORKER_SQL = `EXISTS (
  SELECT 1 FROM orca_teams AS team JOIN orca_workers AS worker ON worker.team_id = team.id
  WHERE team.lead_session_id = sessions.id AND team.status IN ('active', 'completed', 'cancelled')
)`;

/** A normal archive preserves an established team. The Worker must belong to this generation. */
export const ORCA_WORKER_LINK_TEAM_SQL = `
  SELECT 1 FROM orca_teams AS team WHERE team.id = ? AND team.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM sessions AS lead WHERE lead.id = team.lead_session_id AND lead.source = 'side-chat'
        AND (
          lead.side_chat_close_pending = 1 OR lead.status = 'deleted'
          OR (lead.status = 'archived' AND NOT EXISTS (
            SELECT 1 FROM orca_workers AS worker WHERE worker.team_id = team.id
          ))
        )
    )
  LIMIT 1
`;

export const SIDE_CHAT_CLOSE_TARGET_SQL = `
  SELECT 1 FROM sessions WHERE id = ? AND parent_session_id = ? AND source = 'side-chat'
    AND side_chat_promoted = 1 AND (
      status = 'active' OR (status = 'archived' AND (
        side_chat_close_pending = 1 OR EXISTS (
          SELECT 1 FROM orca_teams WHERE lead_session_id = sessions.id AND status = 'active'
        )
      ))
    )
`;

/** Used inside both SQLite transaction implementations and before cleanup side effects. */
export function assertSessionDeleteTarget(
  row: { source: string; sideChatPromoted: number | boolean; sideChatClosePending?: number | boolean; hasCommittedWorker?: number | boolean },
  target: unknown,
): void {
  if (target !== undefined && target !== 'side-chat' && target !== 'task') {
    throw Object.assign(new Error('Invalid session deletion target'), { code: 'INVALID_PARAMS' });
  }
  if (row.source === 'side-chat' && row.sideChatPromoted && target !== 'task') {
    throw Object.assign(new Error('This follow-up is now an independent task. Reopen it from the task list to delete it.'), {
      code: 'PRECONDITION_FAILED',
    });
  }
  if (row.sideChatClosePending) {
    throw Object.assign(new Error('Finish closing the follow-up before deleting it.'), { code: 'PRECONDITION_FAILED' });
  }
  if (row.source === 'side-chat' && !row.sideChatPromoted && row.hasCommittedWorker) {
    throw Object.assign(new Error('Follow-up collaboration is being linked. Try again after it appears.'), {
      code: 'PRECONDITION_FAILED',
    });
  }
  if (target === 'side-chat' && row.source !== 'side-chat') {
    throw Object.assign(new Error('The session is no longer a follow-up'), { code: 'PRECONDITION_FAILED' });
  }
  if (target === 'task' && row.source === 'side-chat' && !row.sideChatPromoted) {
    throw Object.assign(new Error('The follow-up is still attached to its parent task'), { code: 'PRECONDITION_FAILED' });
  }
}
