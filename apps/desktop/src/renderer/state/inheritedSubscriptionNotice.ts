/**
 * inheritedSubscriptionNotice —— 「Cindy 沿用了本机已登录的订阅」这条告知的已读状态，
 * localStorage 持久化，按 provider id 分别记账。
 *
 * 为什么需要它:本机装过并登录过 codex / claude CLI 时,Cindy 会把那份凭证认领到当前账号
 * (设计内的自动继承,见 main 侧 claimDetectedNativeProviderAuth)。自动发现本身是产品原则
 * (core-product-principles §2「常见连接、授权和运行环境应尽可能自动发现」),但认领完全静默 ——
 * 用户不知道 Cindy 正在用他机器上的哪个账号,也不知道去哪儿换掉,这一条缺的是 §4.1
 * 「用户操作的对象、影响范围…应清楚可见」。
 *
 * 与 providerOnboardingDismissal 刻意分开:那条是「零来源 → 去连接」的引导,可以在再次归零时
 * 重新出现;这条是**一次性告知**,读过就不再打扰,不随连接状态回弹。
 */

const STORAGE_KEY = 'inheritedSubscriptionNotice.acknowledgedIds';

type Subscriber = () => void;
const subscribers = new Set<Subscriber>();

/** localStorage 不可用(隐私模式/配额)时的进程内兜底:至少本次会话内关得掉。 */
let memoryAcknowledged = new Set<string>();

function notify(): void {
  subscribers.forEach((cb) => cb());
}

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // 坏数据(手改 / 旧 schema)按「没读过」处理,绝不因此抛错让首屏白屏。
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 快照:已读的 provider id 集合。
 *
 * 返回稳定字符串而不是 Set —— useSyncExternalStore 会按引用比对快照,每次新建 Set
 * 会让它认为状态一直在变(无限重渲染)。调用方用 `has` 辅助函数判定。
 */
export function getAcknowledgedInheritedSubscriptions(): string {
  const ids = new Set([...readStored(), ...memoryAcknowledged]);
  return [...ids].sort().join(',');
}

/** 判定某个 provider 是否已读(入参 = getAcknowledged… 的快照)。 */
export function isInheritedSubscriptionAcknowledged(
  snapshot: string,
  providerId: string,
): boolean {
  if (snapshot.length === 0) return false;
  return snapshot.split(',').includes(providerId);
}

/** 标记这批 provider 的告知为已读(一次性,不再出现)。 */
export function acknowledgeInheritedSubscriptions(providerIds: readonly string[]): void {
  if (providerIds.length === 0) return;
  const next = new Set([...readStored(), ...providerIds]);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    // 写成功则 storage 是唯一真值源,不置内存态 —— 否则跨窗口清 key 后本窗口会
    // 因内存态永远判定已读(同 providerOnboardingDismissal 的既有教训)。
    memoryAcknowledged = new Set();
  } catch {
    memoryAcknowledged = next;
  }
  notify();
}

/** 订阅变化(useSyncExternalStore 形态)。返回 unsubscribe。 */
export function subscribeInheritedSubscriptionNotice(cb: Subscriber): () => void {
  subscribers.add(cb);

  const storageHandler = (e: StorageEvent): void => {
    // key === null 是其它窗口 localStorage.clear();storageArea 过滤掉 sessionStorage。
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

/** 测试用:清空本模块的进程内兜底状态。 */
export function resetInheritedSubscriptionNoticeMemoryState(): void {
  memoryAcknowledged = new Set();
}
