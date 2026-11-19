export interface ProjectTaskCompanionSelection {
  botId: string | null;
  revision: number;
  displayName: string | null;
}

export function supportsProjectTaskCompanion(task: {
  source?: string | null;
  workspaceKind?: string | null;
  workingDir?: string | null;
  status: string;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  deviceLinkDeviceId?: string | null;
  orcaRole?: string | null;
}): boolean {
  return task.source === 'desktop' && task.workspaceKind === 'project' && !!task.workingDir
    && task.status === 'active' && !task.remoteHostId && !task.agentDeviceId
    && !task.deviceLinkDeviceId && !task.orcaRole;
}
