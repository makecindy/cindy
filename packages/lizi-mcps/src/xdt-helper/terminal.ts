import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface TerminalToolCallbacks {
  call(context: LiziMcpSessionContext, method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

const id = z.string().min(1).max(128);
const size = z.number().int().min(1).max(1000);
const shell = z.enum(['auto', 'zsh', 'bash', 'fish', 'sh', 'pwsh', 'powershell', 'cmd', 'gitbash', 'wsl']);

/** Native MCP and plugin Host calls use this one schema and dispatch path. */
export function registerTerminalTools(registry: XdtHelperToolRegistry, callbacks: TerminalToolCallbacks,
  current: () => LiziMcpSessionContext): void {
  function register(name: string, description: string, inputShape: z.ZodRawShape) {
    registry.register({ name, category: 'terminal', description, inputShape,
      handler: async (args, signal) => {
        try { return okPayload(await callbacks.call(current(), name, args, signal)); }
        catch (error) {
          const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : 'TERMINAL_OPERATION_FAILED';
          const capacity = code === 'TERMINAL_JOB_LIMIT' && error instanceof Error &&
            'current' in error && typeof error.current === 'number' && 'limit' in error && typeof error.limit === 'number'
            ? { current: error.current, limit: error.limit } : {};
          return errorPayload(code, '终端操作未完成；请核对进程状态、执行位置与当前授权。', capacity);
        }
      },
    });
  }
  register('terminal_start', '在运行工具的本机启动宿主管理的交互终端或程序，立即返回作业 id；输出用 terminal_read。程序的 command 与 args 直接传给进程，不做 shell 拼接。省略 program 为交互 shell；命令字符串请显式指定 shell 程序及其 -c 参数。作业不随本次读取结束，断开后可按 id 续读。本工具不在 SSH 工作区对应的本机代跑远程命令。', {
    cwd: z.string().min(1).max(4096).optional(), cols: size.optional(), rows: size.optional(), shell: shell.optional(),
    program: z.object({ command: z.string().min(1).max(4096), args: z.array(z.string().max(16384)).max(256) }).strict().optional(),
  });
  register('terminal_list', '列出当前宿主调用方创建的终端和后台作业，包括退出状态。仅执行电脑本机；读取不会停止进程。', {});
  register('terminal_read', '从指定作业续读有界输出。首次省略 cursor/generation，以后传返回值；游标不消费输出，可由重连客户端独立续读。resetRequired 表示代次改变或旧输出已被缓冲淘汰，hasMore 为 true 时继续读取。仅执行电脑本机。', {
    id, cursor: z.number().int().nonnegative().safe().optional(), generation: z.string().min(1).max(128).optional(),
  });
  register('terminal_write', '向当前调用方的运行中终端写入文本和控制字符；换行需显式带入 data。输入可能执行命令，遵循原任务权限或插件的逐次宿主确认。', { id, data: z.string().min(1).max(65536) });
  register('terminal_resize', '调整当前调用方终端的列数和行数。仅执行电脑本机。', { id, cols: size, rows: size });
  register('terminal_stop', '停止当前调用方的指定终端或后台作业，保留已收到的输出与退出状态供续读。只作用于该作业。', { id });
  register('terminal_forget', '移除当前调用方已退出作业的宿主记录和缓冲输出；运行中作业须先停止并收到退出状态。', { id });
}
