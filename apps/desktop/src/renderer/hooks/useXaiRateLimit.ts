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

import { useEffect, useState } from 'react';

import type { XaiRateLimitSnapshot } from '../../shared/xaiRateLimit';

export type { XaiRateLimitSnapshot };

let lastXaiRateLimit: XaiRateLimitSnapshot | null = null;
const listeners = new Set<() => void>();
let globalBound = false;

/** 幂等绑定进程级订阅:无论有无 chip 挂载,快照更新/清空都落进模块缓存。 */
function ensureGlobalSubscription(): void {
  if (globalBound) return;
  const onChanged = window.electronAPI?.maker?.usage?.onXaiRateLimitChanged;
  if (!onChanged) return;
  globalBound = true;
  onChanged((payload) => {
    if (payload === null) {
      lastXaiRateLimit = null;
    } else if (payload && typeof payload === 'object') {
      lastXaiRateLimit = payload;
    } else {
      return;
    }
    for (const notify of listeners) notify();
  });
}

export function useXaiRateLimit(enabled: boolean): XaiRateLimitSnapshot | null {
  const [snapshot, setSnapshot] = useState<XaiRateLimitSnapshot | null>(() => {
    ensureGlobalSubscription();
    return enabled ? lastXaiRateLimit : null;
  });

  useEffect(() => {
    ensureGlobalSubscription();
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    setSnapshot(lastXaiRateLimit);
    const notify = () => setSnapshot(lastXaiRateLimit);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, [enabled]);

  return snapshot;
}
