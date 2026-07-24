/**
 * providerOnboardingDismissal — 「连接供应商」引导(首屏卡片 + 会话 banner)的
 * dismiss 状态,localStorage 持久化。
 *
 * 语义:
 *   - dismiss 跨冷启动持久:零供应商用户点过「稍后再说」后不再反复被打断。
 *   - 卡片与 banner 共享同一 key:任一处 dismiss,两处一起消失。
 *   - 当出现任一已连接供应商时由 useProviderOnboarding 调 reset 清 key——
 *     将来用户断开全部供应商再次归零时,引导会重新出现。
 *
 * 存 ISO 时间戳而非布尔,为将来的过期策略(如 N 天后重现)留位,当前只判存在性。
 */

const STORAGE_KEY = 'providerOnboarding.dismissedAt';

type Subscriber = () => void;
const subscribers = new Set<Subscriber>();

function notify(): void {
  subscribers.forEach((cb) => cb());
}

export function isProviderOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) != null;
  } catch {
    // localStorage 不可用 — 视为未 dismiss(宁可多引导,不可失联)
    return false;
  }
}

export function dismissProviderOnboarding(): void {
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    // localStorage 不可用 — 忽略,本次会话内订阅方仍会收到通知
  }
  notify();
}

export function resetProviderOnboardingDismissal(): void {
  try {
    if (localStorage.getItem(STORAGE_KEY) == null) return;
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
  notify();
}

/** 订阅变化(useSyncExternalStore 形态)。返回 unsubscribe。 */
export function subscribeProviderOnboardingDismissal(cb: Subscriber): () => void {
  subscribers.add(cb);

  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb();
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}
