/**
 * useXaiRateLimit — 订阅 xAI(SuperGrok bridge)上游限流快照推送。
 *
 * 数据通道:
 *   responses-bridge 每个成功上游响应解析 `x-ratelimit-*` 头 → main usageBroadcaster
 *   recordXaiRateLimitSnapshot 广播 `usage:xai-rate-limit-changed` → 本 hook。
 *   null payload = main 主动清空(xAI 登出 / 换账号,clearXaiRateLimitSnapshot)。
 *
 * 这是请求级 RPM/TPM 瞬时值,不是 SuperGrok 周用量(周用量见 useXaiSubscriptionUsage)。
 * 不落库 —— 应用重启后为 null,等下一个 xai/ 轮自然补上。
 *
 * 模块缓存用**全局订阅**维护(首个 hook 挂载时绑定一次、进程内常驻),与组件的 enabled 解耦:
 * 若订阅跟随 enabled 挂/卸,chip 卸载期间(切走了 xAI 模型 / 无会话)到达的清空广播会没有
 * 接收者,旧账号快照在模块缓存里存活、chip 重挂载时被复活 —— 全局订阅保证清空必达。
 */

import type { XaiRateLimitSnapshot } from '../../shared/xaiRateLimit';
import { createSubscriptionUsageCache } from './subscriptionUsageCache';
export type { XaiRateLimitSnapshot };

// Push-only, scoped exactly like the subscription quota cache; no polling or persistence.
const caches = new Map<
  string,
  ReturnType<typeof createSubscriptionUsageCache<XaiRateLimitSnapshot>>
>();
export function useXaiRateLimit(enabled: boolean, providerId = 'xai'): XaiRateLimitSnapshot | null {
  let cache = caches.get(providerId);
  if (!cache) {
    cache = createSubscriptionUsageCache<XaiRateLimitSnapshot>(() => ({
      subscribe: window.electronAPI?.maker?.usage?.onXaiRateLimitChanged
        ? (cb) => window.electronAPI.maker.usage.onXaiRateLimitChanged(cb, providerId)
        : undefined,
    }));
    caches.set(providerId, cache);
  }
  return cache.useSnapshot(enabled);
}
