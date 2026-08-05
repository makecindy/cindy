// 启动即生效的 JS 热更新。
//
// 默认 expo-updates 是「后台下载、下次启动生效」;这里在冷启动早期主动 check → fetch → reload,
// 让本次启动就跑上最新 JS。判定逻辑抽成纯函数(依赖可注入),便于单测;真实 API 由 hook 传入。
//
// 硬约束:任何异常 / 超时 / 离线一律 fail-open(返回 error,调用方直接放行进 App),绝不卡启动;
// 只有真正 fetch 到新 bundle(isNew)才 reload,避免无意义重启 / 循环。

export type StartupOtaOutcome = 'skipped' | 'up-to-date' | 'reloading' | 'error';

export interface StartupOtaDeps {
  /** 是否启用(自建变体 + 非 dev + expo-updates 可用);false 直接 skipped、不阻塞。 */
  enabled: boolean;
  /** 把 endpoint 清单解析出的 /manifest URL 写入 expo-updates;必须先于 check。 */
  configureUpdateUrl: () => void;
  checkForUpdateAsync: () => Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync: () => Promise<{ isNew: boolean }>;
  /** 正常不返回(app 重启);测试里用 spy 断言被调用。 */
  reloadAsync: () => Promise<void>;
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
 * - 无可用更新 / fetch 非新 → 'up-to-date'
 * - fetch 到新 bundle → reloadAsync()(正常不返回)→ 'reloading'
 * - 任何异常 / 超时 → 'error'(fail-open)
 */
export async function runStartupOtaUpdate(
  deps: StartupOtaDeps,
  { checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS }: StartupOtaOptions = {},
): Promise<StartupOtaOutcome> {
  if (!deps.enabled) return 'skipped';
  try {
    deps.configureUpdateUrl();
    const check = await withTimeout(deps.checkForUpdateAsync(), checkTimeoutMs);
    if (!check.isAvailable) return 'up-to-date';
    const fetched = await withTimeout(deps.fetchUpdateAsync(), fetchTimeoutMs);
    if (!fetched.isNew) return 'up-to-date';
    await deps.reloadAsync(); // 正常不返回:app 重启进新 bundle
    return 'reloading';
  } catch {
    return 'error'; // fail-open:超时/离线/服务异常 → 放行,后台下载留给下次启动
  }
}
