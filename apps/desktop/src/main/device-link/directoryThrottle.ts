/**
 * 设备目录(`/api/device-link/devices`)的限流期限共享账本。
 *
 * 为什么单独成模块:这个端点不止 IPC 那一条读路径 —— `runControllerDisplayNamesFromDirectory`
 * (每次 relay 上线)与 `remoteLocalAgentModels`(远程模型目录)都直接打同一个端点。期限只记在
 * `handleListDevices` 的私有 map 里时,这两条路径既看不到冷却(照发物理读,把限流窗口越推越
 * 远),它们收到的 429 也无人记账(Codex review #9360「Share the directory cooldown across
 * all /devices readers」)。所以账本与 `deviceLinkApiFetch` 共用同一份。
 *
 * 期限按桶身份 + 中转身份**分桶**记:
 * - 桶身份是**账号成员**(`activeOwnerScopeKey()` 去掉末尾的代次段,见
 *   `directoryThrottleMembershipOf`):限流窗口在服务端按账号算,不按客户端的会话代次 ——
 *   同 owner 的 projection 修复 / 同账号重登只 bump `generation`,账号与端点都没变,窗口
 *   还是同一个。按代次分桶会让未过期的 `Retry-After` 在 recovery 之后变得**不可达**,另一个
 *   `/devices` 读者直接撞进同一个窗口(Codex review #9360「Keep cooldown keys stable across
 *   same-owner generations」)。代次只用来圈住在途结果(`activeOwnerScopeKey` 的既有用途)。
 * - 中转身份也要算进去:官方中转与自建中转是各自独立的限流桶,同一账号从官方切到自建
 *   (或反过来)之后,上一个中转给的期限不该拦住新中转上的第一次读;
 * - 每个桶的期限要各自留着:只留最后一个桶的话,中转 A -> B -> A 来回切时,A 的期限会被 B
 *   覆盖,切回 A 之后就在 A 仍然有效的限流窗口里又发了一次物理读。
 *
 * 每条期限还带一个**记账序号**(逻辑时钟,不用墙钟):一次成功只证明「服务端处理我这次请求
 * 时没有在限流」,不证明它之后没有。所以成功只清掉序号不晚于自己发起时刻的期限 —— 在途请求
 * 完成时不会抹掉并发请求刚记下的新期限(Codex review #9360「Preserve cooldowns newer than
 * the completing request」)。用序号而不是 `Date.now()`,既避开同一毫秒内的先后歧义,也不会
 * 和测试里对 `Date.now` 的打桩抢调用。
 */

interface DirectoryRetryEntry {
  /** 服务端给的重试时刻(墙钟 ms)。 */
  retryAtMs: number;
  /** 记下这条期限时的账本序号。 */
  recordedSeq: number;
}

const directoryRetryByScope = new Map<string, DirectoryRetryEntry>();

/** 账本序号:每次真正写入一条期限 +1。只增不减,跨用例也保持单调。 */
let retryRecordSequence = 0;

/**
 * 当前账号的 `activeOwnerScopeKey()` 来源(桶身份由 `currentDirectoryThrottleOwner`
 * 收敛成账号成员,见 `directoryThrottleMembershipOf`)。
 *
 * 不在这里直接 import `appSessionState`:那会把 electron 的 `app` 拉进 `deviceLinkApi`
 * 的模块图,而 `deviceLinkApi` 有只 mock 了 `net.fetch` 的轻量测试。由真正持有
 * `activeOwnerScopeKey` 的模块(device-link 的 ipc 与 index)在加载时登记,没登记时用
 * 空串当身份 —— 同一个进程里只要登记过一次,检查与记账就用同一个身份。
 */
let ownerSource: () => string = () => '';

/** 登记当前账号的桶身份来源(device-link 加载时调用)。 */
export function setDirectoryThrottleOwnerSource(source: () => string): void {
  ownerSource = source;
}

/**
 * 把 `activeOwnerScopeKey()` 收敛成**账号成员**身份(限流桶的 owner)。
 *
 * `activeOwnerScopeKey` 的格式是 `${mode}:${dataOwnerId}:${generation}`,代次恒为最后一段
 * (见 appSessionState 的文档):同 owner 的 projection 修复 / 同账号重登只 bump 代次,
 * 账号与端点都没变,服务端的限流窗口也还是同一个 —— 桶身份必须跨这些修复保持稳定,
 * 代次只用来圈住在途结果。从最后一个冒号切掉代次段;没有冒号的身份(测试替身的整串
 * owner)原样返回。
 */
export function directoryThrottleMembershipOf(scopeKey: string): string {
  const cut = scopeKey.lastIndexOf(':');
  return cut === -1 ? scopeKey : scopeKey.slice(0, cut);
}

/** 当前账号的桶身份:检查与记账都用它,保证两边落在同一个桶里。 */
export function currentDirectoryThrottleOwner(): string {
  return directoryThrottleMembershipOf(ownerSource());
}

/**
 * 读一次账本序号,作为「我这次请求发起」的标记。发起目录读之前取一次,成功时把
 * `clearDirectoryRetryDeadline` 的第三个参数交给它。
 */
export function currentDirectoryRetrySequence(): number {
  return retryRecordSequence;
}

/**
 * 限流桶的键:owner + 中转身份。
 *
 * `owner` 必须来自 `currentDirectoryThrottleOwner()`(账号成员身份)—— 直接传
 * `activeOwnerScopeKey()` 会把代次编进桶键,同账号 recovery 之后旧期限就找不到了。
 */
function directoryScopeKey(owner: string, relay: string): string {
  return JSON.stringify([owner, relay]);
}

/** 取某个桶当前有效的期限(过期的顺手丢掉);没有则返回 0。 */
export function directoryRetryDeadline(owner: string, relay: string): number {
  const key = directoryScopeKey(owner, relay);
  const entry = directoryRetryByScope.get(key);
  if (!entry) return 0;
  if (entry.retryAtMs <= Date.now()) {
    directoryRetryByScope.delete(key);
    return 0;
  }
  return entry.retryAtMs;
}

/**
 * 记下某个桶的期限。同一个桶里只往前走:已有更晚的期限时不改写(连序号也不改),否则
 * 重复记同一条 429 会让这条期限看起来比并发请求的成功还新,再也清不掉。
 */
export function recordDirectoryRetryDeadline(owner: string, relay: string, retryAtMs: number): void {
  const key = directoryScopeKey(owner, relay);
  const known = directoryRetryByScope.get(key);
  if (known && known.retryAtMs >= retryAtMs) return;
  retryRecordSequence += 1;
  directoryRetryByScope.set(key, { retryAtMs, recordedSeq: retryRecordSequence });
  pruneExpiredDirectoryRetryDeadlines();
}

/**
 * 桶的期限作废:拿到权威目录 = 服务端没有在限流。
 *
 * `issuedSeq` 是**发起这次成功读取**时的账本序号。只清掉 `recordedSeq <= issuedSeq` 的
 * 期限 —— 序号更大的那条来自在途期间另一次 429,那次观察比这次成功更新,抹掉它会让下一次
 * 读直接撞进限流窗口。不传序号时无条件作废(仅测试与账号切换这类整桶丢弃的场景)。
 */
export function clearDirectoryRetryDeadline(owner: string, relay: string, issuedSeq?: number): void {
  const key = directoryScopeKey(owner, relay);
  if (issuedSeq === undefined) {
    directoryRetryByScope.delete(key);
    return;
  }
  const entry = directoryRetryByScope.get(key);
  if (!entry) return;
  if (entry.recordedSeq <= issuedSeq) directoryRetryByScope.delete(key);
}

/** 桶会随账号 / 中转增多,过期的那几个顺手清掉,别让它一直长。 */
function pruneExpiredDirectoryRetryDeadlines(): void {
  if (directoryRetryByScope.size <= 16) return;
  const now = Date.now();
  for (const [key, entry] of directoryRetryByScope) {
    if (entry.retryAtMs <= now) directoryRetryByScope.delete(key);
  }
}

/** 仅测试:清空共享账本,避免跨用例共用期限(账本序号保持单调,不清零)。 */
export function __resetDirectoryThrottleForTests(): void {
  directoryRetryByScope.clear();
}
