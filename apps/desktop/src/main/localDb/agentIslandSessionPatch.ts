/** localDb session patch 中 Agent Island 关心的最小字段集合。 */
export interface AgentIslandSessionPatch {
  status?: unknown;
  title?: unknown;
  workingDir?: unknown;
  projectDir?: unknown;
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
        Object.prototype.hasOwnProperty.call(patch, 'projectDir') ||
        Object.prototype.hasOwnProperty.call(patch, 'workspaceKind');
      if (!hasMetadataPatch) return;
      service.handleSessionMetadataPatch(sessionId, {
        title: toNullableString(patch.title),
        workingDir: toNullableString(patch.workingDir),
        projectDir: toNullableString(patch.projectDir),
        workspaceKind: toNullableString(patch.workspaceKind),
      });
    })
    .catch(() => undefined);
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === null || typeof value === 'string') return value;
  return undefined;
}

/**
 * 伙伴身份变化的接收方由灵动岛服务在初始化时登记：localDb 与灵动岛服务互相依赖，
 * 这里用登记回调解开循环，而不是运行时动态 import（见 architecture-invariants.md §2）。
 */
export interface AgentIslandCompanionChangeSink {
  companionChanged: (botId: string) => void;
  groupChanged: (groupId: string) => void;
}

let companionChangeSink: AgentIslandCompanionChangeSink | null = null;

export function setAgentIslandCompanionChangeSink(sink: AgentIslandCompanionChangeSink | null): void {
  companionChangeSink = sink;
}

/** 伙伴群改名或解散后，让灵动岛重读以该群群专线说话的任务。 */
export function notifyAgentIslandBotGroupChanged(groupId: string): void {
  companionChangeSink?.groupChanged(groupId);
}

/** 伙伴改名或换头像后，让灵动岛重画以它身份说话的任务。 */
export function notifyAgentIslandCompanionChanged(botId: string): void {
  companionChangeSink?.companionChanged(botId);
}
