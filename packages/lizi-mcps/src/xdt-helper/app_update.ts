import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface AppUpdateCallbacks {
  isCurrentSession(sessionId: string, sessionInstanceId: string): boolean;
  check(): Promise<{ status: string; currentVersion: string; targetVersion?: string; reason?: string }>;
  install(): Promise<{ accepted: boolean; currentVersion: string; targetVersion?: string; reason?: string }>;
}

export function registerAppUpdateTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => { sessionId?: string; sessionInstanceId?: string; remoteHostId?: string };
    callbacks: AppUpdateCallbacks;
  },
): void {
  const callerError = () => {
    const context = deps.getSessionContext();
    if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', '当前调用没有绑定 Cindy 任务。');
    if (context.remoteHostId) return errorPayload('REMOTE_SESSION', '远程任务不能更新本机 Cindy；请在本机任务中操作。');
    if (!context.sessionInstanceId || !deps.callbacks.isCurrentSession(context.sessionId, context.sessionInstanceId)) {
      return errorPayload('STALE_SESSION', '当前任务实例已结束或不再有效，不能更新 Cindy。');
    }
    return null;
  };

  registry.register({
    name: 'check_app_update',
    category: 'app_update',
    description: `检查当前运行的 ${BRAND_NAME} 是否有可通过应用内更新器安装的新版本。不要用 GitHub Release 文件替换正在运行的应用。`,
    inputShape: {},
    handler: async () => {
      const error = callerError();
      if (error) return error;
      try {
        return okPayload(await deps.callbacks.check());
      } catch (cause) {
        return errorPayload('UPDATE_CHECK_FAILED', String(cause));
      }
    },
  });

  registry.register({
    name: 'install_app_update',
    category: 'app_update',
    description: `仅当用户明确要求安装/更新当前运行的 ${BRAND_NAME} 时使用。仅安装应用内更新器已下载的新版本；成功表示已安排重启，不代表新版本已启动。本工具会结束正在运行的 Cindy 和当前任务。不要另写重启脚本或使用 launchctl。`,
    inputShape: {},
    handler: async () => {
      const error = callerError();
      if (error) return error;
      try {
        const result = await deps.callbacks.install();
        return result.accepted
          ? okPayload(result)
          : errorPayload('UPDATE_NOT_READY', result.reason ?? '没有可安装的应用内更新；请先调用 check_app_update。', result);
      } catch (cause) {
        return errorPayload('UPDATE_INSTALL_FAILED', String(cause));
      }
    },
  });
}
