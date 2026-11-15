import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface PiRuntimeCallbacks {
  call(callerSessionId: string, input: { check?: boolean; install?: { source: 'official' | 'upstream'; version: string } }): Promise<Record<string, unknown>>;
}

/** Native managed runtime, never a PATH install or a replacement Cindy app. */
export function registerPiRuntimeTools(registry: XdtHelperToolRegistry, callbacks: PiRuntimeCallbacks,
  context: () => LiziMcpSessionContext): void {
  const invoke = async (input: Parameters<PiRuntimeCallbacks['call']>[1]) => {
    const caller = context();
    if (!caller.sessionId || caller.remoteHostId) return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在目标电脑的本机任务中管理托管 Pi；手机可以继续使用该任务。');
    try {
      const result = await callbacks.call(caller.sessionId, input);
      return result.ok === false ? errorPayload(String(result.errorCode ?? 'PI_RUNTIME_FAILED'),
        String(result.message ?? '请重新读取 Pi 运行环境状态。')) : okPayload(result);
    } catch { return errorPayload('PI_RUNTIME_FAILED', '操作未确认完成，请重新读取 Pi 版本和状态。'); }
  };
  registry.register({ name: 'get_pi_runtime', category: 'settings',
    description: '读取 Cindy 托管 Pi 的当前版本、官方/上游更新信息与安装状态。check=true 检查最新版本，不安装；不读取 PATH 上的独立 Pi。',
    inputShape: { check: z.boolean().optional() }, handler: invoke });
  registry.register({ name: 'update_pi_runtime', category: 'settings',
    description: '按用户要求安装 Cindy 托管 Pi。先 get_pi_runtime({check:true}) 取得 source 对应版本，再传准确 version。复用设置页内核管理器，保留 Pi 原生安装与恢复能力；不重启 Cindy，不终止正在运行的任务。结果版本是后续启动选择，现有 Pi 进程仍使用其启动版本。',
    inputShape: { source: z.enum(['official', 'upstream']), version: z.string().regex(/^\d+\.\d+\.\d+$/) },
    handler: install => invoke({ install }) });
}
