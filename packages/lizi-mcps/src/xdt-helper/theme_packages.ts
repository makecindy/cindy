import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface ThemePackageCallbacks {
  import(context: LiziMcpSessionContext, filePath: string): Promise<Record<string, unknown>>;
}

export function registerThemePackageTool(registry: XdtHelperToolRegistry,
  callbacks: ThemePackageCallbacks, context: () => LiziMcpSessionContext): void {
  registry.register({ name: 'import_theme_package', category: 'settings',
    description: '把 .cindy 主题包导入当前任务所在电脑的 Cindy，复用拖入文件的安装器。同 ID 默认更新，导入后刷新列表并返回主题家族 ID；不会安装插件或自动切换主题。需要应用时用 preferences 设置的 themeFamily 字段，并回读结果。filePath 为绝对路径或相对本任务工作目录的路径，目录外文件沿用任务文件授权。',
    inputShape: { filePath: z.string().min(1).max(4096).regex(/\.cindy$/i) },
    handler: async ({ filePath }) => {
      const caller = context();
      if (!caller.sessionId || !caller.workingDir || caller.remoteHostId)
        return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在目标电脑的本机任务中导入主题包；手机可以继续使用该任务。');
      try {
        const result = await callbacks.import(caller, filePath);
        return result.ok === false ? errorPayload(String(result.errorCode ?? 'THEME_IMPORT_FAILED'),
          String(result.message ?? '主题导入未确认完成。'), result) : okPayload(result);
      } catch {
        return errorPayload('THEME_IMPORT_FAILED', '主题导入未确认完成。请先读取当前主题列表；不要假定安装或切换已完成。');
      }
    },
  });
}
