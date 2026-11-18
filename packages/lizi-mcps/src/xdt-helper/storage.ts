import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface StorageToolCallbacks {
  call(context: LiziMcpSessionContext, request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export function registerStorageTools(registry: XdtHelperToolRegistry, callbacks: StorageToolCallbacks,
  current: () => LiziMcpSessionContext): void {
  registry.register({ name: 'storage_request', category: 'storage',
    description: '查询宿主实际提供的插件存储接口，或在当前插件自身数据范围内调用。providers 返回可用 provider/operations；call 传 provider 和 request。share 把本插件已有文件或指定 KV 数据的快照交给 targetPluginId，经宿主每次确认后进入目标插件的文件交接列表；不建立实时共享挂载，不得跨账号、电脑或组织。SHARE_RESULT_UNKNOWN 须先核对交接列表，不重发。普通任务没有插件存储身份，不能代报 pluginId。',
    inputShape: { op: z.enum(['providers', 'targets', 'call', 'share']), provider: z.string().min(1).max(64).optional(),
      request: z.record(z.string(), z.unknown()).optional(), targetPluginId: z.string().min(1).max(256).optional(),
      source: z.object({ provider: z.string().min(1).max(64), path: z.string().max(512).optional(),
        ref: z.string().max(512).optional(), key: z.string().max(128).optional() }).strict().optional(),
    },
    handler: async (args, signal) => {
      if ((args.op === 'call' && (!args.provider || !args.request)) ||
          (args.op === 'share' && (!args.targetPluginId || !args.source))) return errorPayload('INVALID_ARGS', 'call 需要 provider/request；share 需要 targetPluginId/source。');
      try {
        const result = await callbacks.call(current(), args, signal);
        if (result.ok !== false) return okPayload(result);
        const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
        return { ...okPayload({ ...result, data: { ...data,
          hint: '存储操作未完成。核对授权及目标状态；交付结果未知时按返回的目标、名称和摘要先查询，勿重发。' } }), isError: true };
      } catch { return errorPayload('PLUGIN_CONTEXT_REQUIRED', '此接口需要宿主核验的插件调用方。'); }
    },
  });
}
