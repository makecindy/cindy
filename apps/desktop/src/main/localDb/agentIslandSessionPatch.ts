/** localDb session patch 中 Agent Island 关心的最小字段集合。 */
export interface AgentIslandSessionPatch {
  status?: unknown;
  title?: unknown;
  workingDir?: unknown;
  workspaceKind?: unknown;
  /** 插件后台隐藏时刻；非空 = 任务转入后台，灵动岛与菜单栏收起该任务。 */
  hiddenAt?: unknown;
  /** 开了「消息免打扰」；只影响灵动岛展示面与提示音，不影响事件摄取。 */
  notificationsMuted?: unknown;
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
      // 「消息免打扰」只挡岛面展示与提示音，不挡事件摄取:任务可能已经在岛上，
      // 静音后要让岛面收起它，但状态机必须继续记账——侧栏卡片的实时活动、等待
      // 交互态与远端活动镜像都长在这份状态上。
      if (patch.notificationsMuted !== undefined) {
        service.handleNotificationMuteChanged();
      }
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
