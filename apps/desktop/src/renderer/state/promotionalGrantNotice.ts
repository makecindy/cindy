/**
 * promotionalGrantNotice —— 「赠送余额已到账」这条一次性告知的已读状态，
 * localStorage 持久化，按「账号 + grant」分别记账。
 *
 * 为什么需要它:开通 Cindy AI 后服务端会发一笔限期赠送余额,而客户端此前完全静默 ——
 * 用户可能到过期都不知道账上有钱(赠送金额与有效期的唯一展示位是计费页,而用户走不到它)。
 * 这是产品原则 §4.1「用户操作的对象、影响范围…应清楚可见」缺的一半:钱已经到账,是「已经
 * 发生的事」,用户需要被告知一次,而不是被派一个待办。
 *
 * 与 inheritedSubscriptionNotice 同形态但**刻意不共用一个 key**:那条按 provider 记账,
 * 这条按账号 + grantId 记账。多记一层账号是硬要求 —— 同一台机器上换账号登录后,新账号自己
 * 那笔赠送必须还能告知一次;只按 grantId 记账在 grantId 服务端全局唯一时也不串号,但一旦
 * 服务端改成按账号分配序号就会静默漏掉新账号的告知,而漏告知是查不出来的 bug。
 *
 * 一次性语义:读过(或点过「查看用量」)就永不再出,不随余额变化回弹。
 */

const STORAGE_KEY = 'promotionalGrantNotice.acknowledgedKeys';

type Subscriber = () => void;
const subscribers = new Set<Subscriber>();

/** localStorage 不可用(隐私模式/配额)时的进程内兜底:至少本次会话内关得掉。 */
let memoryAcknowledged = new Set<string>();

function notify(): void {
  subscribers.forEach((cb) => cb());
}

/**
 * 记账键 = 账号 + grant。两段都 encodeURIComponent 后再拼,免得 accountId 或 grantId
 * 里出现 `:` / `,` 时两段边界错位(快照本身是逗号分隔的字符串,见 getAcknowledged…)。
 */
export function promotionalGrantNoticeKey(accountId: string, grantId: string): string {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(grantId)}`;
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
 * 快照:已读的「账号:grant」键集合。
 *
 * 返回稳定字符串而不是 Set —— useSyncExternalStore 会按引用比对快照,每次新建 Set
 * 会让它认为状态一直在变(无限重渲染)。调用方用 `isPromotionalGrantAcknowledged` 判定。
 */
export function getAcknowledgedPromotionalGrants(): string {
  const keys = new Set([...readStored(), ...memoryAcknowledged]);
  return [...keys].sort().join(',');
}

/** 判定某个账号的某笔 grant 是否已读(入参 = getAcknowledged… 的快照)。 */
export function isPromotionalGrantAcknowledged(
  snapshot: string,
  accountId: string,
  grantId: string,
): boolean {
  if (snapshot.length === 0) return false;
  return snapshot.split(',').includes(promotionalGrantNoticeKey(accountId, grantId));
}

/** 标记这笔赠送的告知为已读(一次性,不再出现)。 */
export function acknowledgePromotionalGrant(accountId: string, grantId: string): void {
  // 三路合并:storage 里已有的 + 本会话内存兜底里已有的 + 本次新读的。少了中间那份,
  // localStorage 持续不可用时(隐私模式/配额)同会话第二次 acknowledge 会把第一次的
  // 内存记录整份覆盖掉 —— 切账号后前一个账号的已读也一并丢失,告知条复活。
  const next = new Set([
    ...readStored(),
    ...memoryAcknowledged,
    promotionalGrantNoticeKey(accountId, grantId),
  ]);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    // 写成功则 storage 是唯一真值源,不置内存态 —— 否则跨窗口清 key 后本窗口会
    // 因内存态永远判定已读(同 inheritedSubscriptionNotice 的既有教训)。
    memoryAcknowledged = new Set();
  } catch {
    memoryAcknowledged = next;
  }
  notify();
}

/** 订阅变化(useSyncExternalStore 形态)。返回 unsubscribe。 */
export function subscribePromotionalGrantNotice(cb: Subscriber): () => void {
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
export function resetPromotionalGrantNoticeMemoryState(): void {
  memoryAcknowledged = new Set();
}
