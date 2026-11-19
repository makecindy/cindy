/** Used inside both SQLite transaction implementations and before cleanup side effects. */
export function assertSessionDeleteTarget(
  row: { source: string; sideChatPromoted: number | boolean },
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
  if (target === 'side-chat' && row.source !== 'side-chat') {
    throw Object.assign(new Error('The session is no longer a follow-up'), { code: 'PRECONDITION_FAILED' });
  }
  if (target === 'task' && row.source === 'side-chat' && !row.sideChatPromoted) {
    throw Object.assign(new Error('The follow-up is still attached to its parent task'), { code: 'PRECONDITION_FAILED' });
  }
}
