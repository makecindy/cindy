import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface AppUpdateCallbacks {
  isCurrentSession(sessionId: string, sessionInstanceId: string): boolean;
  check(): Promise<{ status: string; currentVersion: string; targetVersion?: string; reason?: string }>;
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
    description: `仅读取当前渠道更新版本信息，检查当前运行的 ${BRAND_NAME} 是否有可通过应用内更新器安装的新版本。本工具不会下载、安装或重启应用；如需安装，请用户使用内置「检查更新」界面。不要用 GitHub Release 文件替换正在运行的应用。`,
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
}
