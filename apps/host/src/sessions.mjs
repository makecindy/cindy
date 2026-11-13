/**
 * Session projection for the host API.
 *
 * `SessionStorage.list()` is the maker-core contract and intentionally carries no
 * product lifecycle status, so the host asks for the status per row and keeps
 * only active tasks — archived/deleted rows must not appear as open work.
 */

/**
 * @param {{list(): Promise<Array<any>>, getStatus?(id: string): Promise<string | null>}} storage
 * @returns {Promise<Array<{id: string, title: string, agentKind: string, model: string, workDir: string, updatedAt: number}>>}
 */
export async function listActiveSessions(storage) {
  const rows = await storage.list();
  const withStatus = await Promise.all(rows.map(async (session) => ({
    session,
    status: storage.getStatus ? await storage.getStatus(session.id) : 'active',
  })));
  return withStatus
    .filter((entry) => entry.status === 'active')
    .map(({ session }) => ({
      id: session.id,
      title: session.title,
      agentKind: session.agentKind,
      model: session.model,
      workDir: session.workDir,
      updatedAt: session.updatedAt,
    }));
}

/** Match maker:list-active: persisted task status is not a live turn status. */
export function listRunningSessions(maker, options) {
  const sessions = (maker?.listActiveSessions() ?? []).map(session => ({
    sessionId: session.id,
    agentKind: session.agentKind,
    workDir: session.workDir,
    capabilities: session.capabilities,
    isTurnRunning: session.isTurnRunning(),
  }));
  return options?.summary === true && options?.snapshotVersion === 2
    ? { format: 'active-sessions-v2', sessions }
    : sessions;
}
