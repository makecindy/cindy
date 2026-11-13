import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface HostServicesToolCallbacks {
  list(context: LiziMcpSessionContext): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export function registerHostServiceTools(registry: XdtHelperToolRegistry, callbacks: HostServicesToolCallbacks,
  current: () => LiziMcpSessionContext): void {
  registry.register({ name: 'host_services', category: 'discovery',
    description: '只读发现执行宿主实际提供的服务（本机）。返回工具组、server、示例入口及 available；缺失或已关闭的服务明确标记不可用。插件调用还显示本插件声明与显式批准事实，不读取其他插件数据、凭证或宿主路径，也不安装、启停或撤权。available 只表示服务已接入且开关允许，不保证外部连接在线或系统权限已授予。',
    inputShape: {},
    handler: async () => {
      try { return okPayload(await callbacks.list(current())); }
      catch { return errorPayload('CAPABILITY_NOT_AVAILABLE', '当前执行环境无法提供此宿主服务目录。'); }
    },
  });
}
