import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type ProviderSharingRequest = { device?: string } & (
  | { action: 'members'; providerId?: string }
  | { action: 'status'; memberId: string; status: 'pause' | 'resume' }
  | { action: 'get-models'; providerId: string; memberId: string }
  | { action: 'set-models'; providerId: string; memberId: string; models: string[] | null }
);
export interface ProviderSharingCallbacks {
  call(input: ProviderSharingRequest & { callerSessionId?: string }): Promise<Record<string, unknown>>;
}

const id = z.string().trim().min(1).max(128);
const device = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional();
export const providerShareMembersInputSchema = z.strictObject({ device, providerId: id.optional() });
export const providerShareModelAccessInputSchema = z.strictObject({ device, providerId: id, memberId: id });

export function projectProviderSharingError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : '';
  const code = /^\[([A-Z_]+)\]/.exec(message)?.[1] ?? message;
  const publicCodes = new Set(['NOT_FOUND', 'HOST_NOT_READY', 'PERMISSION_DENIED', 'UNSUPPORTED_CAPABILITY',
    'PRECONDITION_FAILED', 'DEVICE_LINK_NOT_CONNECTED', 'DEVICE_LINK_DEVICE_OFFLINE', 'DEVICE_LINK_TIMEOUT']);
  return { code: publicCodes.has(code) ? code : 'PROVIDER_SHARE_OPERATION_FAILED',
    message: '读取或修改未确认完成。请重新读取该电脑的成员状态；写操作可能已生效，不要自动重发。' };
}

export function registerProviderSharingTools(registry: XdtHelperToolRegistry,
  callbacks: ProviderSharingCallbacks, context: () => LiziMcpSessionContext): void {
  const member = providerShareModelAccessInputSchema.shape;
  const invoke = async (request: ProviderSharingRequest) => {
    const caller = context();
    if ((!caller.sessionId && caller.hostCaller?.kind !== 'plugin') || caller.remoteHostId)
      return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在任务所在电脑调用；另一台同账号电脑用 device 指定。');
    try {
      return okPayload(await callbacks.call({ ...request, callerSessionId: caller.sessionId }));
    } catch (error) {
      const failure = projectProviderSharingError(error);
      return errorPayload(failure.code, failure.message);
    }
  };
  registry.register({ name: 'list_provider_share_members', category: 'settings',
    description: '只读列出当前账号在本机拥有的供应商分享成员（shareId、providerId、memberId、name、status）。providerId 可筛选；device 可显式选择同账号已授权的另一台电脑。不包括分享给我的供应商，不赋予受邀者管理权。',
    inputShape: providerShareMembersInputSchema.shape, handler: input => invoke({ action: 'members', ...input }) });
  registry.register({ name: 'set_provider_share_member_status', category: 'settings',
    description: '暂停或恢复自己分享的指定成员；先查询精确 memberId。暂停立即打断此人运行中的任务，成功回执不等待全部实例关停完成；恢复只允许后续消息，不自动续跑。默认本机，device 可指定同账号已授权电脑。',
    inputShape: { device, memberId: id, status: z.enum(['pause', 'resume']) }, handler: input => invoke({ action: 'status', ...input }) });
  registry.register({ name: 'get_provider_share_model_access', category: 'settings',
    description: '读取自己分享的指定成员可用模型、供应商模型范围和当前型号目录。默认本机，device 可指定同账号已授权电脑；null 跟随全部，空数组不允许任何模型。',
    inputShape: member, handler: input => invoke({ action: 'get-models', ...input }) });
  registry.register({ name: 'set_provider_share_model_access', category: 'settings',
    description: '修改自己分享的指定成员可用模型，复用设置页生效流程。先 get 取准确模型 id，再提交完整名单；models=null 跟随供应商范围，[] 全部禁止。保留未指定的成员预算等配置。默认本机，device 可指定同账号已授权电脑。',
    inputShape: { ...member, models: z.array(z.string().trim().min(1).max(512)).max(4096)
      .refine(values => new Set(values).size === values.length).nullable() },
    handler: input => invoke({ action: 'set-models', ...input }) });
}
