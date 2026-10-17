/** localDb session patch 中 Agent Island 关心的最小字段集合。 */
export interface AgentIslandSessionPatch {
  status?: unknown;
  title?: unknown;
  workingDir?: unknown;
  workspaceKind?: unknown;
  /** 插件后台隐藏时刻；非空 = 任务转入后台，灵动岛与菜单栏收起该任务。 */
  hiddenAt?: unknown;
}

/** 把本地 session 归档/删除/转入后台和 metadata 更新同步给 Agent Island。 */
export function notifyAgentIslandSessionPatch(
  sessionId: string,
  patch: AgentIslandSessionPatch,
): void {
  void import('../agent-island/service.js')
    .then(({ getAgentIslandService }) => {
      const service = getAgentIslandService();
      if (!service) return;
      if (
        patch.status === 'archived' ||
        patch.status === 'deleted' ||
        (patch.hiddenAt !== undefined && patch.hiddenAt !== null)
      ) {
        service.handleSessionClosed(sessionId);
        return;
      }
      const hasMetadataPatch =
        Object.prototype.hasOwnProperty.call(patch, 'title') ||
        Object.prototype.hasOwnProperty.call(patch, 'workingDir') ||
        Object.prototype.hasOwnProperty.call(patch, 'workspaceKind');
      if (!hasMetadataPatch) return;
      service.handleSessionMetadataPatch(sessionId, {
        title: toNullableString(patch.title),
        workingDir: toNullableString(patch.workingDir),
        workspaceKind: toNullableString(patch.workspaceKind),
      });
    })
    .catch(() => undefined);
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === null || typeof value === 'string') return value;
  return undefined;
}
