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
    // emergency launch 下没有 launchedUpdate:check 必然报「有新版」,下载完 reload 也只会
    // 回到同一个 emergency launch。不发请求、不重启,直接放行进 App。
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
