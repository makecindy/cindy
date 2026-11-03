/** Native archive owns both the rollout move and SQLite update. Never edit either here. */
export async function syncCodexArchiveState(
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>,
  threadId: string,
  archived: boolean,
  assertCurrent: () => void,
): Promise<string> {
  type ThreadResult = { thread: { id: string; path?: string | null; status?: { type: string } } };
  const read = () => request<ThreadResult>('thread/read', { threadId, includeTurns: false });
  const isArchived = (result: ThreadResult): boolean => {
    if (result.thread.id !== threadId || !result.thread.path) throw new Error('Codex archive history is unavailable');
    // Native SSH paths use the remote platform's separators.
    const bucket = result.thread.path.split(/[\\/]/).slice(0, -1).reverse()
      .find(part => part === 'sessions' || part === 'archived_sessions');
    if (!bucket) throw new Error('Codex archive history storage is unavailable');
    return bucket === 'archived_sessions';
  };
  let result = await read();
  assertCurrent();
  if (isArchived(result) !== archived) {
    if (result.thread.status?.type === 'active') throw new Error('Codex thread is busy; archive sync deferred');
    await request(archived ? 'thread/archive' : 'thread/unarchive', { threadId });
    result = await read();
    assertCurrent();
    if (isArchived(result) !== archived) throw new Error('Codex archive state did not converge');
  }
  return result.thread.path!;
}
