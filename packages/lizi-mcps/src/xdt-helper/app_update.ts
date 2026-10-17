import { z } from 'zod';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

/** The bound task instance that issued the call; Host checks it, never the model. */
export interface AppUpdateCaller {
  sessionId: string;
  sessionInstanceId: string;
}

type HostResult = Record<string, unknown>;

export interface AppUpdateCallbacks {
  isCurrentSession(sessionId: string, sessionInstanceId: string): boolean;
  check(caller: AppUpdateCaller): Promise<{ status: string; currentVersion: string; targetVersion?: string; reason?: string }>;
  /** Host shows the owner a confirmation card, then runs the built-in updater. */
  install?(caller: AppUpdateCaller): Promise<HostResult>;
  /** Host confirmation card, then the Settings → About idle auto-install switch. */
  setAutoUpdate?(caller: AppUpdateCaller, enabled: boolean): Promise<HostResult>;
}

function hostPayload(result: HostResult) {
  if (result.ok === false && typeof result.errorCode === 'string') {
    return errorPayload(result.errorCode, typeof result.message === 'string' ? result.message : result.errorCode);
  }
  return okPayload(result);
}

export function registerAppUpdateTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => { sessionId?: string; sessionInstanceId?: string; remoteHostId?: string };
    callbacks: AppUpdateCallbacks;
  },
): void {
  const resolveCaller = (): { error: ReturnType<typeof errorPayload> } | { caller: AppUpdateCaller } => {
    const context = deps.getSessionContext();
    if (!context.sessionId) return { error: errorPayload('NO_SESSION_CONTEXT', '当前调用没有绑定 Cindy 任务。') };
    if (context.remoteHostId) return { error: errorPayload('REMOTE_SESSION', '远程任务不能更新本机 Cindy；请在本机任务中操作。') };
    if (!context.sessionInstanceId || !deps.callbacks.isCurrentSession(context.sessionId, context.sessionInstanceId)) {
      return { error: errorPayload('STALE_SESSION', '当前任务实例已结束或不再有效，不能更新 Cindy。') };
    }
    return { caller: { sessionId: context.sessionId, sessionInstanceId: context.sessionInstanceId } };
  };

  registry.register({
    name: 'check_app_update',
    category: 'app_update',
    description: `仅读取当前渠道更新版本信息，检查当前运行的 ${BRAND_NAME} 是否有可通过应用内更新器安装的新版本，不会下载、安装或重启应用。用户要更新时调用 install_app_update。结果含 autoUpdateHint=true 时，可顺带提醒一句可以开启空闲时自动安装更新（set_app_auto_update）。不要用 GitHub Release 文件替换正在运行的应用。`,
    inputShape: {},
    handler: async () => {
      const resolved = resolveCaller();
      if ('error' in resolved) return resolved.error;
      try {
        return okPayload(await deps.callbacks.check(resolved.caller));
      } catch (cause) {
        return errorPayload('UPDATE_CHECK_FAILED', String(cause));
      }
    },
  });

  const install = deps.callbacks.install;
  if (install) {
    registry.register({
      name: 'install_app_update',
      category: 'app_update',
      description: `用户要求更新 ${BRAND_NAME} 时调用。宿主会向用户弹出确认卡（目标版本、会重启、会中断哪些任务），用户确认后才由内置更新器下载、安装并重启；拒绝或超时则不做任何更改。确认由宿主完成，不要先用文字向用户确认。不要用 shell 下载、替换应用或创建重启任务。`,
      inputShape: {},
      handler: async () => {
        const resolved = resolveCaller();
        if ('error' in resolved) return resolved.error;
        try {
          return hostPayload(await install(resolved.caller));
        } catch (cause) {
          return errorPayload('UPDATE_INSTALL_FAILED', String(cause));
        }
      },
    });
  }

  const setAutoUpdate = deps.callbacks.setAutoUpdate;
  if (setAutoUpdate) {
    registry.register({
      name: 'set_app_auto_update',
      category: 'app_update',
      description: `用户要求开启或关闭 ${BRAND_NAME}「空闲时自动安装更新」时调用。宿主会向用户弹出确认卡，确认后写入「设置 → 关于」中的同一开关。`,
      inputShape: {
        enabled: z.boolean().describe('true = 开启空闲时自动安装更新；false = 关闭'),
      },
      handler: async ({ enabled }) => {
        const resolved = resolveCaller();
        if ('error' in resolved) return resolved.error;
        try {
          return hostPayload(await setAutoUpdate(resolved.caller, enabled));
        } catch (cause) {
          return errorPayload('AUTO_UPDATE_SETTING_FAILED', String(cause));
        }
      },
    });
  }
}
