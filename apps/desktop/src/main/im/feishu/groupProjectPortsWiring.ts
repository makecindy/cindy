/**
 * 把「项目与模型」（官方机器人与 IM 插件共用的按项目设置，hook-control）接给个人飞书机器人的
 * 按群设置。只在 bootstrap 装配时调用一次：groupOverrides 经端口取用，不直接引用 hook-control，
 * hook-control 又引用了 IM 共用代码，直接引用会形成循环依赖。
 */

import { createLogger } from '../../logger.js';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService.js';
import { currentPluginImProjectWorkspaces, readPluginImProjectCatalog } from '../../hook-control/ipc.js';
import {
  resolveSharedImProjectConfig,
  sharedImProjectDefaultsFingerprint,
} from '../../hook-control/session-runner.js';
import { getSharedProjectPref } from '../../hook-control/sharedProjectPrefs.js';
import { setFeishuGroupProjectPorts } from './groupOverrides.js';

const log = createLogger('im/feishu/group-project');

export function wireFeishuGroupProjectPorts(): void {
  setFeishuGroupProjectPorts({
    projectWorkspaces: () => currentPluginImProjectWorkspaces(),
    syncProjectWorkspaces: async () => {
      await readPluginImProjectCatalog();
    },
    projectPermissionMode: (alias) => getSharedProjectPref(alias).permissionMode,
    projectFingerprint: (alias) => sharedImProjectDefaultsFingerprint(alias),
    resolveProject: (alias, providers, options) => resolveSharedImProjectConfig(alias, log, providers, options),
    listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: true }),
  });
}
