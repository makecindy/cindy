import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface FileToolCallbacks {
  call(context: LiziMcpSessionContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/** Agent tools and plugin calls enter the same Host filesystem service. */
export function registerFileTools(registry: XdtHelperToolRegistry, callbacks: FileToolCallbacks,
  current: () => LiziMcpSessionContext): void {
  registry.register({ name: 'file_request', category: 'files',
    description: '读写、列举、删除或监听执行电脑的授权目录。普通任务使用其真实工作目录；插件必须传由系统目录选择器签发的 directoryRef，不能传绝对路径。watch 返回 watchId，changes 用独立 cursor 续读，resetRequired 表示存在缺口；不用时 unwatch。SSH 目录不在控制端本机代操作。',
    inputShape: {
      op: z.enum(['read', 'write', 'list', 'delete', 'watch', 'changes', 'unwatch']),
      directoryRef: z.string().min(1).max(128).optional(), path: z.string().min(1).max(256).optional(),
      content: z.string().max(24 * 1024 * 1024).optional(), encoding: z.enum(['utf8', 'base64']).optional(),
      watchId: z.string().min(1).max(128).optional(), cursor: z.number().int().nonnegative().safe().optional(),
    },
    handler: async (args, signal) => {
      try {
        const result = await callbacks.call(current(), args, signal);
        return result.ok === false ? errorPayload(String(result.errorCode ?? 'FILE_OPERATION_FAILED'), String(result.message ?? '文件操作未完成')) : okPayload(result);
      } catch { return errorPayload('FILE_OPERATION_FAILED', '文件操作未完成；请核对执行电脑、目录引用与当前授权。'); }
    },
  });
}
