import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type GrokLoginState =
  | { status: 'connected' }
  | {
      status: 'pending';
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
    }
  | { status: 'failed'; reason: 'expired' | 'denied' | 'cancelled' | 'error' }
  | { status: 'idle' };

export interface GrokLoginCallbacks {
  start(context: LiziMcpSessionContext): Promise<GrokLoginState>;
  status(context: LiziMcpSessionContext): Promise<GrokLoginState>;
  cancel(context: LiziMcpSessionContext): Promise<GrokLoginState>;
}

export function registerGrokLoginTools(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  callbacks: GrokLoginCallbacks,
): void {
  const invoke = (action: 'start' | 'status' | 'cancel') => async () => {
    const context = getContext();
    if (!context.sessionId || !context.sessionInstanceId)
      return errorPayload('NO_SESSION_CONTEXT', '当前调用没有可验证的 Cindy 任务身份。');
    try {
      return okPayload(await callbacks[action](context));
    } catch {
      return errorPayload('AUTH_FAILED', '无法完成 Grok 授权，请稍后重试。');
    }
  };
  registry.register({
    name: 'start_grok_device_login',
    category: 'auth',
    description:
      '用户要求连接 Grok / SuperGrok 时启动设备码登录。返回 xAI 授权页和短码；请把两者展示给用户，让用户在授权页输入短码。浏览器自动回调是设置页中的另一种登录方式。短码由 Cindy 发给用户，不要求用户把它贴回聊天，也不返回长期凭证。随后可用 get_grok_login_status 查询结果。',
    inputShape: {},
    handler: invoke('start'),
  });
  registry.register({
    name: 'get_grok_login_status',
    category: 'auth',
    description:
      '查询当前 Grok 设备码登录是否完成；只在已经启动设备码登录后调用。pending 时用户仍需在 xAI 授权页输入短码，connected 表示凭证已由 Cindy 安全保存。',
    inputShape: {},
    handler: invoke('status'),
  });
  registry.register({
    name: 'cancel_grok_device_login',
    category: 'auth',
    description: '用户要停止本次 Grok 设备码授权时取消等待；已连接的凭证不会因此登出。',
    inputShape: {},
    handler: invoke('cancel'),
  });
}
