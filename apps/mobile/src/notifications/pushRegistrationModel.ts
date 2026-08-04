/**
 * 移动推送注册的纯逻辑模型(无 expo / RN 依赖,可直接单测)。
 *
 * 链路:手机拿 APNs device token → PUT device-link server /push-token 注册;
 * 桌面端任务终态发 notify 帧 → server 查账号 token → APNs 下发。
 * 契约见 cindy-server docs/device-link-server.md 与协议仓 device-link-protocol.md。
 */

export type PushAppVariant = 'cn' | 'global';

/**
 * 构建线 → server 侧 appVariant(决定 APNs topic/bundleId)。
 * dev 是内部开发身份且行为语义归 cn 系：开发环境用 APNS_TOPIC_CN
 * 配置 com.xd.cindydev，因此注册时复用 appVariant='cn'。
 */
export function resolvePushAppVariant(region: 'cn' | 'global' | 'dev'): PushAppVariant {
  return region === 'global' ? 'global' : 'cn';
}

export interface PushTokenRegistrationBody {
  token: string;
  platform: 'ios';
  provider: 'apns';
  appVariant: PushAppVariant;
  apnsEnv: 'prod' | 'sandbox';
}

/**
 * 组装 PUT /push-token 的 body；空 token 返回 null。
 * apnsEnv:dev client(Xcode debug 签名)走 sandbox APNs,TestFlight / App Store /
 * 自建 release 走 prod —— 与 __DEV__ 语义一致。
 */
export function buildPushTokenRegistrationBody(opts: {
  token: string;
  region: 'cn' | 'global' | 'dev';
  isDevBuild: boolean;
}): PushTokenRegistrationBody | null {
  const appVariant = resolvePushAppVariant(opts.region);
  const token = opts.token.trim();
  if (!token) return null;
  return {
    token,
    platform: 'ios',
    provider: 'apns',
    appVariant,
    apnsEnv: opts.isDevBuild ? 'sandbox' : 'prod',
  };
}

/**
 * 从通知 data 中解析深链。只接受桌面端契约内的应用内路径(/sessions/...),
 * 拒绝任意 URL / 其它路径 —— 推送 payload 经第三方通道,按不可信输入对待。
 */
export function parseNotificationDeepLink(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const deepLink = (data as Record<string, unknown>).deepLink;
  if (typeof deepLink !== 'string') return null;
  if (!deepLink.startsWith('/sessions/')) return null;
  if (deepLink.includes('://') || deepLink.startsWith('//')) return null;
  return deepLink;
}
