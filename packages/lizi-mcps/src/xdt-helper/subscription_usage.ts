import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface SubscriptionUsageCallbacks {
  read(context: LiziMcpSessionContext, providerId?: string): Promise<Record<string, unknown>>;
  readSession?(context: LiziMcpSessionContext, sessionId: string): Promise<Record<string, unknown>>;
}

export const subscriptionUsageInputSchema = z.strictObject({ providerId: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional() });

export function projectSubscriptionUsageError(): { code: string; message: string } {
  return { code: 'SUBSCRIPTION_USAGE_UNAVAILABLE', message: '订阅用量未能读取；账号或插件授权可能已变化。' };
}

export function registerSubscriptionUsageTools(registry: XdtHelperToolRegistry, callbacks: SubscriptionUsageCallbacks,
  current: () => LiziMcpSessionContext): void {
  registry.register({ name: 'get_subscription_usage', category: 'usage',
    description: '只读查询执行电脑上当前 Cindy 账号已连接的 Claude/Codex 订阅用量。返回每个账号的本地标识、供应商、套餐、额度窗口、更新时间和数据状态；省略 providerId 读取全部本机订阅账号。与界面共用缓存，不强制刷新。没有数据不是零用量；不含邮箱、凭证、目录、内部身份指纹或其他电脑/分享供应商的账号。插件需声明 agent.hostTools:["usage"]。',
    inputShape: subscriptionUsageInputSchema.shape,
    handler: async ({ providerId }) => {
      const context = current();
      if (context.remoteHostId || (!context.sessionId && !context.hostCaller))
        return errorPayload('CAPABILITY_NOT_AVAILABLE', '此用量接口只支持执行电脑上的本机任务或已获准插件。');
      try { return okPayload(await callbacks.read(context, providerId)); }
      catch {
        const failure = projectSubscriptionUsageError();
        return errorPayload(failure.code, failure.message);
      }
    },
  });
  const readSession = callbacks.readSession;
  if (readSession) registry.register({ name: 'get_session_quota', category: 'usage',
    description: '只读查询指定任务实际执行来源的额度。支持本机、同账号已授权电脑和获准查看额度的分享供应商。没有可确认读数时返回 unavailable。插件需声明 usage。不返回任务内容、设备或账号标识。',
    inputShape: { sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) },
    handler: async ({ sessionId }) => {
      const context = current();
      if (context.remoteHostId || (!context.sessionId && !context.hostCaller))
        return errorPayload('CAPABILITY_NOT_AVAILABLE', '此额度接口需要当前用户的本机任务或已获准插件。');
      try { return okPayload(await readSession(context, sessionId)); }
      catch {
        const failure = projectSubscriptionUsageError();
        return errorPayload(failure.code, failure.message);
      }
    },
  });
}
