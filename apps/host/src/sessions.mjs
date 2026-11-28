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
export function listRunningSessions(maker, options, getSessionActivityMap, listProvisioningSnapshots) {
  const activityMap = getSessionActivityMap ? getSessionActivityMap() : null;
  const provisioningList = listProvisioningSnapshots ? listProvisioningSnapshots() : [];
  const provisioningById = new Map(provisioningList.map((snap) => [snap.sessionId, snap]));
  const activeIds = new Set();
  const sessions = (maker?.listActiveSessions() ?? []).map(session => {
    activeIds.add(session.id);
    const activity = activityMap ? activityMap.get(session.id) : undefined;
    const prov = provisioningById.get(session.id);
    return {
      sessionId: session.id,
      agentKind: session.agentKind,
      workDir: session.workDir,
      capabilities: session.capabilities,
      isTurnRunning: session.isTurnRunning(),
      ...(activityMap ? {
        activityPhase: prov
          ? (prov.status === 'provisioning' ? 'running' : 'error')
          : (activity?.phase ?? 'idle'),
        activityAttention: prov ? prov.status === 'failed' : (activity?.attention ?? false),
      } : {}),
      ...(prov ? {
        worktreeProvisioningStatus: prov.status,
        ...(prov.stage ? { worktreeProvisioningStage: prov.stage } : {}),
        worktreeProvisioningStartedAt: prov.startedAt,
        ...(prov.error ? { worktreeProvisioningError: prov.error } : {}),
      } : {}),
    };
  });
  for (const [sessionId, prov] of provisioningById) {
    if (activeIds.has(sessionId)) continue;
    sessions.push({
      sessionId,
      agentKind: 'claude-code',
      workDir: '',
      capabilities: undefined,
      isTurnRunning: false,
      activityPhase: prov.status === 'provisioning' ? 'running' : 'error',
      activityAttention: prov.status === 'failed',
      worktreeProvisioningStatus: prov.status,
      ...(prov.stage ? { worktreeProvisioningStage: prov.stage } : {}),
      worktreeProvisioningStartedAt: prov.startedAt,
      ...(prov.error ? { worktreeProvisioningError: prov.error } : {}),
    });
  }
  return options?.summary === true && options?.snapshotVersion === 2
    ? { format: 'active-sessions-v2', sessions }
    : sessions;
}
