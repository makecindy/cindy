import { throwIpcError } from '../utils/ipcValidate.js';

export interface CollabProjectPolicyContext {
  workingDir?: string | null;
  workspaceKind?: string | null;
  remoteHostId?: string | null;
}

/**
 * 协同 Team 只能由启用 collab 插件的本地项目会话创建。
 *
 * 这是主进程的最终授权边界；Renderer 的入口状态只是用户体验层，
 * 不能替代这里的校验。
 */
export function assertCollabProjectEnabled(
  context: CollabProjectPolicyContext,
  isPluginEnabled: (pluginId: 'collab', workingDir: string) => boolean,
): void {
  const workingDir = typeof context.workingDir === 'string' ? context.workingDir.trim() : null;
  if (
    context.workspaceKind !== 'project' ||
    context.remoteHostId != null ||
    workingDir === null ||
    workingDir === ''
  ) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'collaboration requires an enabled local project session',
    );
  }

  if (!isPluginEnabled('collab', workingDir)) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'collaboration is disabled for this project',
    );
  }
}
