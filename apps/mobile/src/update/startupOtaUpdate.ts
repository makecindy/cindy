// 启动即生效的 JS 热更新。
//
// 默认 expo-updates 是「后台下载、下次启动生效」;这里在冷启动早期主动 check → fetch → reload,
// 让本次启动就跑上最新 JS。判定逻辑抽成纯函数(依赖可注入),便于单测;真实 API 由 hook 传入。
//
// 硬约束:任何异常 / 超时 / 离线一律 fail-open(返回 error,调用方直接放行进 App),绝不卡启动;
// 只有真正 fetch 到新 bundle(isNew)才 reload,避免无意义重启 / 循环。
//
// reload 之前还有三道防循环判定(某台设备实测被同一个 update 反复重启 33 次、永久卡在启动页,
// 且不会自愈,只能清应用数据):
//  1. emergency launch —— expo-updates 没能启动任何已下载 update、回落到包内 bundle。
//     这种状态下 check 拿不到「当前 update」做比较,永远报有新版,reload 也回不到正常态,
//     整道门直接跳过(热更不生效 好于 进不去 App)。
//  2. fetch 到的 update 就是当前正在跑的那一个 → 没有任何理由重启。
//  3. 跨 reload 的持久化闸门(otaReloadGuard):同一个 update 试满次数仍没装上就放弃。

export type StartupOtaOutcome =
  | 'skipped'
  | 'up-to-date'
  | 'reloading'
  | 'error'
  /** expo-updates 处于 emergency launch:本次启动完全不走热更。 */
  | 'emergency-launch'
  /** fetch 回来的就是当前运行的 update:不重启。 */
  | 'already-running'
  /** 同一个 update 反复装不上,被跨 reload 闸门拦下。 */
  | 'reload-blocked';

export interface StartupOtaDeps {
  /** 是否启用(自建变体 + 非 dev + expo-updates 可用);false 直接 skipped、不阻塞。 */
  enabled: boolean;
  /** 把 endpoint 清单解析出的 /manifest URL 写入 expo-updates;必须先于 check。 */
  configureUpdateUrl: () => void;
  checkForUpdateAsync: () => Promise<{
    isAvailable: boolean;
    /** isAvailable=true 时 expo-updates 必带;用它在下载前就判定要不要走这一轮。 */
    manifest?: { id?: string };
  }>;
  fetchUpdateAsync: () => Promise<{ isNew: boolean; manifest?: { id?: string } }>;
  /** 正常不返回(app 重启);测试里用 spy 断言被调用。 */
  reloadAsync: () => Promise<void>;
  /**
   * `Updates.isEmergencyLaunch`:expo-updates 初始化失败、回落到包内 bundle 启动。
   * 这是「下载的 update 装不上」这类本机坏状态最直接的信号。
   */
  isEmergencyLaunch: () => boolean;
  /** `Updates.updateId`:当前正在运行的 update id(跑包内 bundle 时可能为 null)。 */
  currentUpdateId: () => string | null;
  /** 读跨 reload 闸门状态(实现见 otaReloadGuard)。 */
  isReloadBlocked: (targetUpdateId: string) => Promise<boolean>;
  /** reload 前记一次尝试;抛错即视为闸门不可用,本次不 reload。 */
  recordReload: (targetUpdateId: string) => Promise<void>;
}

export interface StartupOtaOptions {
  /** check 阶段超时;拉不到线上状态就放行(默认 2.5s)。 */
  checkTimeoutMs?: number;
  /** fetch(下载 bundle)阶段超时;慢网就放行、下载留给后台下次启动(默认 8s)。 */
  fetchTimeoutMs?: number;
}

// check 是个小 manifest 请求:2.5s 内完不成说明网络已差到 bundle 也拉不完,
// 早点放行进 App(弱网冷启动全屏「正在检查更新」的等待成本直接砍掉一半以上);
// fetch 只有在 check 快速成功(网络可用)后才会进入,8s 预算维持不变。
const DEFAULT_CHECK_TIMEOUT_MS = 2500;
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

/** Promise 超时包装:超时 reject(由上层 catch 成 fail-open)。 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup-ota-timeout(${ms}ms)`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * 冷启动的 JS 热更闸门。
 * - enabled=false → 'skipped'
 * - emergency launch → 'emergency-launch'(不联网、不 reload)
 * - 无可用更新 / fetch 非新 → 'up-to-date'
 * - fetch 到的就是当前 update → 'already-running'
 * - 同一 update 反复装不上 → 'reload-blocked'
 * - fetch 到新 bundle → reloadAsync()(正常不返回)→ 'reloading'
 * - 任何异常 / 超时 → 'error'(fail-open)
 */
export async function runStartupOtaUpdate(
  deps: StartupOtaDeps,
  { checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS }: StartupOtaOptions = {},
): Promise<StartupOtaOutcome> {
  if (!deps.enabled) return 'skipped';
  try {
    // emergency launch 下没有 launchedUpdate:check 必然报「有新版」,此时 reload 只会
    // 回到同一个 emergency launch。这道**阻塞式**门直接放行进 App,不在这里联网——
    // 后续的修复版下载由 runEmergencyOtaRecovery 在后台做(不 reload),见该函数。
    // 放在 try 内:本函数对调用方承诺永不 reject,依赖自身抛错也必须落到 'error'。
    if (deps.isEmergencyLaunch()) return 'emergency-launch';
    deps.configureUpdateUrl();
    const check = await withTimeout(deps.checkForUpdateAsync(), checkTimeoutMs);
    if (!check.isAvailable) return 'up-to-date';
    // check 就带回了目标 manifest,所以「同 id」「已被闸门拦下」都能在**下载之前**判掉。
    // 否则正是需要被闸门救的那些设备,每次冷启动都要白等一次 fetch(最多 8s)才放行。
    const decided = await decideByTargetId(deps, check.manifest?.id);
    if (decided) return decided;
    const fetched = await withTimeout(deps.fetchUpdateAsync(), fetchTimeoutMs);
    if (!fetched.isNew) return 'up-to-date';
    // 再判一次:check 与 fetch 之间服务端指针可能已经变,拿到手的未必是刚才那个 id。
    // isNew=true 的 fetch 结果按 expo-updates 的类型必定带 manifest;真拿不到 id 时无从
    // 计数,只能保持原行为(重启一次),不为这条理论上不可达的分支编造一个共享计数键。
    const targetUpdateId = fetched.manifest?.id;
    const decidedAfterFetch = await decideByTargetId(deps, targetUpdateId);
    if (decidedAfterFetch) return decidedAfterFetch;
    if (targetUpdateId) {
      // 必须先落盘再 reload:反过来的话 reload 会打断写入,闸门永远合不上。
      await deps.recordReload(targetUpdateId);
    }
    await deps.reloadAsync(); // 正常不返回:app 重启进新 bundle
    return 'reloading';
  } catch {
    return 'error'; // fail-open:超时/离线/服务异常 → 放行,后台下载留给下次启动
  }
}

/** 后台恢复下载的结果(纯观测用;调用方不据此改变启动流程)。 */
export type EmergencyOtaRecoveryOutcome =
  | 'up-to-date'
  /** check 没带回 id:无从判断是不是那个已知坏掉的包,不下载。 */
  | 'unknown-id'
  /** 线上指针还是那个已经证明装不上的 update:不重复下载。 */
  | 'known-bad'
  /** 已下载,等下次冷启动由原生层启动它(本函数绝不 reload)。 */
  | 'fetched'
  | 'error';

/** 后台下载不阻塞启动,所以给足预算:整包 JS bundle 在移动网络下 8s 往往不够。 */
const DEFAULT_RECOVERY_FETCH_TIMEOUT_MS = 60_000;

/**
 * emergency launch 后的**后台**恢复下载。
 *
 * 自建线 `checkAutomatically: 'NEVER'`,原生层不会自己检查更新;而 emergency launch 的
 * 设备一直跑包内 bundle。若不做这件事,即使之后发了修复版热更,这些设备也永远拿不到,
 * 只能靠用户清应用数据——普通用户不会知道要这么做。
 *
 * 安全边界(这三条共同保证它不可能变成第二个死循环):
 *  1. **绝不 reload**——所以 deps 里没有 reloadAsync。下载完只是变成 pending update,
 *     由下一次冷启动的原生层去选,本次启动的 UI 不受任何影响。
 *  2. 已被闸门判定装不上的 id 不再下载(拦的是「已知坏掉的那一份」,不是「所有 emergency
 *     launch」);拿不到 id 时同样不下载,避免每次冷启动白下十几 MB。
 *  3. 下载成功后计一次尝试,与正常路径共用同一个计数器:同一个 id 最多试
 *     MAX_OTA_RELOAD_ATTEMPTS 次就彻底不再碰它。
 *
 * 与 runStartupOtaUpdate 一样永不 reject。
 */
export async function runEmergencyOtaRecovery(
  deps: Pick<
    StartupOtaDeps,
    'configureUpdateUrl' | 'checkForUpdateAsync' | 'fetchUpdateAsync' | 'isReloadBlocked' | 'recordReload'
  >,
  {
    checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    fetchTimeoutMs = DEFAULT_RECOVERY_FETCH_TIMEOUT_MS,
  }: StartupOtaOptions = {},
): Promise<EmergencyOtaRecoveryOutcome> {
  try {
    deps.configureUpdateUrl();
    const check = await withTimeout(deps.checkForUpdateAsync(), checkTimeoutMs);
    if (!check.isAvailable) return 'up-to-date';
    const candidateId = check.manifest?.id;
    if (!candidateId) return 'unknown-id';
    if (await deps.isReloadBlocked(candidateId)) return 'known-bad';
    const fetched = await withTimeout(deps.fetchUpdateAsync(), fetchTimeoutMs);
    if (!fetched.isNew) return 'up-to-date'; // 什么都没落盘,不该记一次尝试
    // 记账必须按**真正拿到手的** id:指针可能在 check 与 fetch 之间变过,记在过期的
    // candidateId 上会让已经试满的那个坏包在下次冷启动又被放行一次(正常路径同样
    // 在 fetch 之后重判,见 runStartupOtaUpdate)。
    const fetchedId = fetched.manifest?.id ?? candidateId;
    if (await deps.isReloadBlocked(fetchedId)) return 'known-bad';
    // 计数放在下载成功之后:这里没有 reload 会打断落盘,而「下载到了」才算真的试过一次。
    // 写失败只吞掉——后果仅是下次冷启动可能重下一次,不影响启动也不会循环。
    await deps.recordReload(fetchedId).catch(() => undefined);
    return 'fetched';
  } catch {
    return 'error';
  }
}

/**
 * 按目标 update id 判定本轮是否该直接结束(不下载、不重启)。返回 null 表示可以继续。
 * 拿不到 id 时不做判定——无从比较也无从计数。
 */
async function decideByTargetId(
  deps: StartupOtaDeps,
  targetUpdateId: string | undefined,
): Promise<StartupOtaOutcome | null> {
  if (!targetUpdateId) return null;
  // 服务端说「有新版」只代表相对它的认知是新的。真正决定要不要重启的是 id:与当前
  // 运行的 update 同 id 却仍在重启,就是那台设备上观察到的死循环。
  if (targetUpdateId === deps.currentUpdateId()) return 'already-running';
  if (await deps.isReloadBlocked(targetUpdateId)) return 'reload-blocked';
  return null;
}
