/** A Worker can commit before the independent-task projection is written. */
export const COMMITTED_SIDE_CHAT_WORKER_SQL = `EXISTS (
  SELECT 1 FROM orca_teams AS team JOIN orca_workers AS worker ON worker.team_id = team.id
  WHERE team.lead_session_id = sessions.id AND team.status IN ('active', 'completed', 'cancelled')
)`;

/** Used inside both SQLite transaction implementations and before cleanup side effects. */
export function assertSessionDeleteTarget(
  row: { source: string; sideChatPromoted: number | boolean; hasCommittedWorker?: number | boolean },
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
