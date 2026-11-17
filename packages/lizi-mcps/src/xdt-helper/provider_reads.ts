import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface ProviderReadRequest {
  action: 'usage-history' | 'group';
  providerId: string;
  device?: string;
}
export interface ProviderReadCallbacks {
  call(input: ProviderReadRequest & { callerSessionId?: string }): Promise<Record<string, unknown>>;
}

export const providerReadInputSchema = z.strictObject({ providerId: z.string().trim().min(1).max(128),
  device: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional() });

export function projectProviderReadError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : '';
  const code = /^\[([A-Z_]+)\]/.exec(message)?.[1] ?? message;
  const publicCodes = ['UNSUPPORTED_CAPABILITY', 'NOT_FOUND', 'PRECONDITION_FAILED', 'PERMISSION_DENIED',
    'DEVICE_LINK_NOT_CONNECTED', 'DEVICE_LINK_DEVICE_OFFLINE', 'DEVICE_LINK_TIMEOUT', 'REMOTE_AGENT_UNAVAILABLE'];
  return { code: publicCodes.includes(code) ? code : 'PROVIDER_READ_FAILED',
    message: '读取未完成；请核对目标电脑、连接和账号。缺失或截断的数据不能当作零。' };
}

export function registerProviderReadTools(registry: XdtHelperToolRegistry, callbacks: ProviderReadCallbacks,
  context: () => LiziMcpSessionContext): void {
  const inputShape = providerReadInputSchema.shape;
  const invoke = async (request: ProviderReadRequest) => {
    const caller = context();
    if ((!caller.sessionId && caller.hostCaller?.kind !== 'plugin') || caller.remoteHostId)
      return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在目标电脑调用；同账号另一台已授权电脑用 device 指定。');
    try { return okPayload(await callbacks.call({ ...request, callerSessionId: caller.sessionId })); }
    catch (error) {
      const failure = projectProviderReadError(error);
      return errorPayload(failure.code, failure.message);
    }
  };
  registry.register({ name: 'get_provider_usage_history', category: 'usage', inputShape,
    description: '读取指定供应商所在电脑已记录的原 usage-history，含自己、转来的与当前分享成员的按天原始行、模型及各类 token、原估算金额。todayKey 是那台电脑的今天；coverageStart 非空表示回包裁剪，边界日也可能不完整，空值不证明源账本完整。当天仍累积，缺失不是零。筛选汇总由调用方做；不返回凭据。device 默认本机，可显式指定同账号已授权电脑。',
    handler: input => invoke({ action: 'usage-history', ...input }) });
  registry.register({ name: 'get_provider_group', category: 'usage', inputShape,
    description: '只读指定供应商的现有供应组视图：组设置、成员状态、运行数、冷却和已知额度窗口。复用设置页/选机状态；缺少 quota 表示未知，不是零，分享来的电脑不会因此暴露他人账号额度。device 默认本机，可指定同账号已授权的组所在电脑。不改组、不登录、不新取其它账号来源的额度。',
    handler: input => invoke({ action: 'group', ...input }) });
}
