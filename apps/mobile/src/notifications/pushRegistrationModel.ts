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

function parseNotificationPayloadDeepLink(data: unknown): string | null {
  const direct = parseNotificationDeepLink(data);
  if (direct) return direct;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  // APNs relay implementations may wrap custom fields under `body` or `data`.
  // Keep the fallback explicit rather than recursively walking untrusted payloads.
  return parseNotificationDeepLink(record.body) ?? parseNotificationDeepLink(record.data);
}

/**
 * 从 expo-notifications 的点击响应中解析任务深链。
 *
 * iOS 远程通知在 Expo 56 有两条数据出口：`content.data` 通常来自 APNs
 * userInfo 的 `body` 字段，而完整的 APNs userInfo 保存在
 * `request.trigger.payload`。两者都支持，避免 relay 的 payload 包装方式
 * 让点击事件静默失效。
 */
export function parseNotificationResponseDeepLink(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const notification = (response as Record<string, unknown>).notification;
  if (!notification || typeof notification !== 'object') return null;
  const request = (notification as Record<string, unknown>).request;
  if (!request || typeof request !== 'object') return null;
  const requestRecord = request as Record<string, unknown>;
  const content = requestRecord.content;
  if (content && typeof content === 'object') {
    const contentData = (content as Record<string, unknown>).data;
    const fromContent = parseNotificationPayloadDeepLink(contentData);
    if (fromContent) return fromContent;
  }
  const trigger = requestRecord.trigger;
  if (!trigger || typeof trigger !== 'object') return null;
  return parseNotificationPayloadDeepLink((trigger as Record<string, unknown>).payload);
}
