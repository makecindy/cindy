import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface AppSettingsCallbacks {
  call(input: { callerSessionId?: string; operation: 'list' | 'get' | 'update' | 'reset';
    section?: string; query?: string; patch?: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

/** Discover schemas on demand; never expose arbitrary files, IPC channels or credentials. */
export function registerAppSettingsTools(registry: XdtHelperToolRegistry,
  callbacks: AppSettingsCallbacks, context: () => LiziMcpSessionContext): void {
  const invoke = async (operation: 'list' | 'get' | 'update' | 'reset', input: {
    section?: string; query?: string; patch?: Record<string, unknown>;
  }) => {
    const caller = context();
    const callerSessionId = caller.sessionId;
    if ((!callerSessionId && !caller.hostCaller) || caller.remoteHostId) return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在目标电脑上的本机任务中管理设置。手机可以继续使用该任务。');
    try {
      const result = await callbacks.call({ callerSessionId, operation, ...input });
      return result.ok === false ? errorPayload(String(result.errorCode ?? 'SETTINGS_OPERATION_FAILED'),
        String(result.message ?? '请重新查询设置。'), result) : okPayload(result);
    }
    catch { return errorPayload('SETTINGS_OPERATION_FAILED', '设置操作未确认完成。请重新读取当前值；不要假定修改已保存。'); }
  };
  registry.register({ name: 'list_app_settings', category: 'settings',
    description: '发现这台电脑上 Cindy 可直接管理的设置。返回分类、用途、生效范围和读改/恢复能力；用 get_app_settings 查看当前值与修改字段。配置 Cindy 先用此入口，无需操作桌面。',
    inputShape: { query: z.string().max(200).optional() }, handler: input => invoke('list', input), });
  registry.register({ name: 'get_app_settings', category: 'settings',
    description: '读取 list_app_settings 返回的设置分类：当前有效值、默认值、自定义字段与严格修改 schema。秘密值不返回。',
    inputShape: { section: z.string().min(1).max(100) }, handler: input => invoke('get', input), });
  registry.register({ name: 'update_app_settings', category: 'settings',
    description: '按用户要求修改 Cindy 设置。先 get_app_settings 获取字段与取值，patch 只包含要改的字段，未指定的偏好保持。复用设置页的保存与生效路径，结果返回保存后的状态。不能用来修改当前任务权限或提交密码密钥。',
    inputShape: { section: z.string().min(1).max(100), patch: z.record(z.string(), z.unknown()) }, handler: input => invoke('update', input), });
  registry.register({ name: 'reset_app_settings', category: 'settings',
    description: '按用户要求恢复某个设置分类的默认值，删除该分类的自定义覆盖，让它跟随当前版本默认值。不影响其它分类。先 get_app_settings 核对范围。',
    inputShape: { section: z.string().min(1).max(100) }, handler: input => invoke('reset', input), });
}
