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

/**
 * localStorage 不可用(隐私模式/配额)时的进程内兜底:dismiss 至少在本次会话内
 * 生效,否则订阅方收到通知后 snapshot 仍是 false,UI 永远关不掉(review 反馈)。
 */
let memoryDismissed = false;

function notify(): void {
  subscribers.forEach((cb) => cb());
}

export function isProviderOnboardingDismissed(): boolean {
  if (memoryDismissed) return true;
  try {
    return localStorage.getItem(STORAGE_KEY) != null;
  } catch {
    // localStorage 不可用 — 只剩内存兜底(上面已判)
    return false;
  }
}

export function dismissProviderOnboarding(): void {
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    // 写成功则 storage 是唯一真值源,不置内存态——否则跨窗口 storage 事件
    // 清掉 key 后,本窗口会因内存态永远判定 dismissed(review 反馈)。
    memoryDismissed = false;
  } catch {
    // localStorage 不可用 — 内存兜底,本次会话内仍视为 dismissed
    memoryDismissed = true;
  }
  notify();
}

export function resetProviderOnboardingDismissal(): void {
  let had = memoryDismissed;
  memoryDismissed = false;
  try {
    if (localStorage.getItem(STORAGE_KEY) != null) {
      localStorage.removeItem(STORAGE_KEY);
      had = true;
    }
  } catch {
    // localStorage 不可用 — 只清内存态
  }
  if (!had) return;
  notify();
}

/** 订阅变化(useSyncExternalStore 形态)。返回 unsubscribe。 */
export function subscribeProviderOnboardingDismissal(cb: Subscriber): () => void {
  subscribers.add(cb);

  const storageHandler = (e: StorageEvent) => {
    // key === null 是其他窗口 localStorage.clear(),同样可能清掉本 key;
    // storageArea 过滤掉 sessionStorage 事件。
    if (e.storageArea !== localStorage) return;
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    cb();
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}
