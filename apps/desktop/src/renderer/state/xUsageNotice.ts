/**
 * xUsageNotice —— X 连接的「用法与公开风险」确认门的已知晓状态,localStorage 持久化,
 * 按**绑定的 X 账号**(principalId)分别记账。
 *
 * 为什么需要它:X 的回复是一条公开推文,而且所有 X 任务都落在用户设的默认工作目录里 ——
 * 这两条后果只写在设置卡的常驻小节里是不够的,很多人不会主动展开设置去读。所以绑定成功
 * 的那一刻要拦一次,让用户明确点过「我明白」。而这种告知只该拦一次,不能每次开设置都弹。
 *
 * 按 principalId 而不是按设备记账:换绑到另一个 X 账号 = 换了一个公开面(不同的粉丝、
 * 不同的可见范围),值得再确认一次;同一个账号解绑后重新绑定则不重复打扰。
 *
 * 与 providerOnboardingDismissal 刻意分开(同 inheritedSubscriptionNotice 的理由):
 * 那条是「零来源 → 去连接」的引导,可以在再次归零时重新出现;这条是**一次性告知**,
 * 确认过就不再打扰,不随连接状态回弹。
 *
 * 形状取自 inheritedSubscriptionNotice(同一类状态,那几个坑已经踩过),但**没有做
 * 订阅**:确认门只在绑定态转入 confirmed 的那一沿读一次,没有任何组件需要跟随本状态
 * 重渲染 —— 加一份 useSyncExternalStore 只会多一条没人用的通路。
 */

const STORAGE_KEY = 'xUsageNotice.acknowledgedPrincipals';

/** localStorage 不可用(隐私模式/配额)时的进程内兜底:至少本次会话内别重复弹。 */
let memoryAcknowledged = new Set<string>();

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // 坏数据(手改 / 旧 schema)按「没确认过」处理 —— 宁可多弹一次告知,
    // 也绝不因此抛错让整个设置页白屏。
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** 这个 X 账号是否已经确认过告知。 */
export function isXUsageAcknowledged(principalId: string): boolean {
  if (principalId.length === 0) return false;
  return readStored().includes(principalId) || memoryAcknowledged.has(principalId);
}

/** 标记这个 X 账号的告知为已确认(一次性,不再出现)。 */
export function acknowledgeXUsage(principalId: string): void {
  if (principalId.length === 0) return;
  // **必须把 memoryAcknowledged 一起并进来**: localStorage 持续不可写时(隐私模式 /
  // 配额, 本模块明确支持的场景)readStored() 恒为空, 只并 readStored 的话第二个账号
  // 会把第一个从内存兜底里覆盖掉 —— 用户切回第一个账号时又被拦一次, 而那次确认本该
  // 在本会话内一直有效(#1347 review 由 codex 指出)。读侧本来就是两者取并集
  // (isXUsageAcknowledged), 写侧漏了同一个并集才出的错。
  //
  // 顺带一层收益: storage 从坏转好时, 第一次写成功会把内存里攒下的账号一并落盘。
  const next = new Set([...readStored(), ...memoryAcknowledged, principalId]);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    // 写成功则 storage 是唯一真值源,不置内存态 —— 否则跨窗口清 key 后本窗口会
    // 因内存态永远判定已确认(inheritedSubscriptionNotice / providerOnboardingDismissal
    // 的既有教训)。此时 storage 已含内存那批, 清空不丢东西。
    memoryAcknowledged = new Set();
  } catch {
    memoryAcknowledged = next;
  }
}

/** 测试用:清空本模块的进程内兜底状态。 */
export function resetXUsageNoticeMemoryState(): void {
  memoryAcknowledged = new Set();
}
