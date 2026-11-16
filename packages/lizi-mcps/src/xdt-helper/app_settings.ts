import { z } from 'zod';
import { TAB_IDS } from '@cindy/maker-shared/settings-tabs';
import { buildSettingsNavigationUrl } from '@cindy/maker-shared/settings-navigation';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface AppSettingsCallbacks {
  navigationDeviceId?(): string;
  navigationDeviceName?(): string;
  call(input: { callerSessionId?: string; operation: 'list' | 'get' | 'update' | 'reset';
    section?: string; query?: string; patch?: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

/** Discover schemas on demand; never expose arbitrary files, IPC channels or credentials. */
export function registerAppSettingsTools(registry: XdtHelperToolRegistry,
  callbacks: AppSettingsCallbacks, context: () => LiziMcpSessionContext): void {
  if (callbacks.navigationDeviceId) registry.register({ name: 'get_settings_link', category: 'settings',
    description: '为需要用户操作的 Cindy 内部设置生成可点击入口。省略 page 列出真实设置页；传 page 和可选 query 定位设置搜索。返回的 Markdown 必须原样展示，不只说“设置→某页”，不编造菜单或连接器。链接绑定这台任务电脑，桌面直接打开，手机或另一台电脑通过已有远控权限打开目标电脑设置。仅导航，不修改设置，不表示连接完成。插件缺少或失效的授权应先用已发现的真实插件身份调用 connect_account，直接展示原生连接按钮；仅宿主确认没有支持的配置动作时才退回设置链接。',
    inputShape: { page: z.enum(TAB_IDS).optional(), query: z.string().trim().min(1).max(200).optional() },
    handler: async ({ page, query }) => {
      const caller = context();
      if (caller.remoteHostId) return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在目标电脑的任务中生成设置入口。');
      if (!page) return okPayload({ pages: TAB_IDS, instruction: '选择真实 page，再调用本工具生成带目标电脑的入口；具体设置可用 query 搜索。' });
      const deviceId = callbacks.navigationDeviceId!();
      if (!deviceId) return errorPayload('CAPABILITY_NOT_AVAILABLE', '暂时无法确认目标电脑，请重试。');
      const url = buildSettingsNavigationUrl({ tab: page, deviceId, ...(query ? { query } : {}) });
      const deviceName = callbacks.navigationDeviceName?.().replace(/[\[\]\r\n\\]/g, ' ').slice(0, 120);
      return okPayload({ url, deviceId, deviceName, page, markdown: `[打开设置${deviceName ? ` · ${deviceName}` : ''}](${url})`,
        instruction: '在回复中展示 markdown。当前仅生成导航入口，用户尚未点击，也未修改设置或完成登录。' });
    },
  });
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
