import { AuthApiError } from '@cindy/auth-client';

import { LOGIN_PREPARING_UNLOCK_TIMEOUT_MS, loginPreparingErrorState } from '../shared/authIpc';

/**
 * 冷启动 auth 流程的「限时等待」编排 —— 与 Electron / 网络层解耦的纯逻辑,
 * 供 authManager 的 `initialize()`(splash)与 `loadLoginProviders()`(登录准备态)
 * 使用,并可独立单测(authManager 本身依赖 Electron,无法在 node 测试环境直接
 * import,同 authRefreshFailure.ts 的拆分理由)。
 *
 * 背景:冷启动 refresh 是 token-rotating 端点,**禁止 abort**(服务端已轮换而客户端
 * abort 后,重试旧 token 会命中 INVALID_REFRESH_TOKEN 永久登出)。因此在黑洞 / captive
 * portal 网络(连着 WiFi 但请求永远无响应)下,`net.fetch` 会无限挂起 → `initialize()`
 * 永不 resolve → renderer 的 splash 永不淡出,用户看到的是「卡死在启动画面」。
 *
 * 解法:不 abort 请求,只是不让启动流程无限等它——超时后先以兜底值(未登录)返回
 * 解锁 splash,原 promise 继续在后台跑到底;迟到 settle 时通过回调交还结果(成功则由
 * 调用方广播登录态,renderer 自动从登录页跳回主界面),reject 一律被消化,不产生
 * unhandled rejection。
 */

export interface StartupTimeoutOpts<T> {
  /** 超时毫秒数;<= 0 表示不设限(退化为直接 await flow)。 */
  timeoutMs: number;
  /** 超时触发时生成兜底返回值(典型:未登录 AuthState)。 */
  onTimeout: () => T | PromiseLike<T>;
  /** 超时后原 flow 迟到 resolve 时回调(不会在未超时时调用)。 */
  onLateResult?: (result: T) => void;
  /** 超时后原 flow 迟到 reject 时回调;不注册也会消化 rejection。 */
  onLateError?: (err: unknown) => void;
}

/**
 * 限时等待 `flow`:
 * - 在 `timeoutMs` 内 settle → 结果 / 异常原样透传,行为与直接 await 完全一致;
 * - 超时 → 返回 `onTimeout()` 的兜底值,flow 继续后台运行,迟到 settle 走
 *   `onLateResult` / `onLateError`(后者兜底消化,防 unhandled rejection)。
 */
export async function awaitWithStartupTimeout<T>(
  flow: Promise<T>,
  opts: StartupTimeoutOpts<T>,
): Promise<T> {
  if (opts.timeoutMs <= 0) return flow;

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        // Promise resolution assimilates an async recovery fallback while
        // keeping synchronous fallback callbacks backwards-compatible.
        resolve(opts.onTimeout());
      } catch (error) {
        reject(error);
      }
    }, opts.timeoutMs);
  });

  // 无论 flow 先 settle 还是超时先到,都要挂上迟到回调 + rejection 消化;
  // 未超时路径下这两个回调不触发(timedOut === false)。
  flow.then(
    (result) => {
      if (timedOut) opts.onLateResult?.(result);
    },
    (err) => {
      if (timedOut) opts.onLateError?.(err);
      // 未超时时 rejection 由下方 race 的调用方处理,这里仅防迟到场景 unhandled。
    },
  );

  try {
    return await Promise.race([flow, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function resolveColdStartTimeoutRecovery<TCurrent, TPending, TRecovered>(input: {
  ownerTransitionPending: boolean;
  authChangedSinceInitialize: boolean;
  loginCommitPending: boolean;
  loginCommittedSinceInitialize: boolean;
  isStartupFallbackEpoch: (epoch: number) => boolean;
  timeoutStartEpoch: number;
  currentEpoch: number;
  currentState: TCurrent;
  pendingState: TPending;
  recover: () => Promise<TRecovered>;
}): Promise<TCurrent | TPending | TRecovered> {
  // A pending owner transition owns the user-data boundary. A login also reserves
  // the auth epoch before its async vault/owner transaction commits. Neither may
  // race a timeout recovery; their own commit/rollback publishes the settled state.
  if (input.ownerTransitionPending || input.loginCommitPending) return input.pendingState;
  // A login transaction that settled after this initialize() entered reuses the
  // epoch snapshotted at entry, so it is invisible to the epoch guards below.
  // Preserve the authenticated state it published instead of recovering.
  if (input.loginCommittedSinceInitialize) return input.currentState;
  // Sibling renderers share one refresh but own independent startup timers. A
  // user may complete login after one timeout exposes the login page and before
  // another timer fires; that later timeout must preserve the authenticated state.
  if (input.authChangedSinceInitialize || input.currentEpoch !== input.timeoutStartEpoch) {
    if (
      input.currentEpoch === input.timeoutStartEpoch ||
      !input.isStartupFallbackEpoch(input.currentEpoch)
    ) {
      return input.currentState;
    }
  }
  return input.recover();
}

/**
 * 判断冷启动 refresh 流程的迟到结果是否「只被它自己的启动闸超时兜底」超越。
 *
 * 背景(2026-10-17 实机):splash 的启动闸超时后,兜底路径会把 owner 收敛回
 * signed-out —— 那是流程自己的安全网,不是用户手动登录/登出。但它同样推进了
 * authStateEpoch,于是流程稍后**成功**(token 已轮换并落盘)时,`epochChanged`
 * 把它误判为「用户改过登录态」而整体丢弃:进程停在未登录,每次启动都重现。
 *
 * 豁免必须绑定到「这次兜底造成的那一次代际推进」,因此比对的是
 * `startupFallback` 的 from/to 转换,而不是「当前代际恰好等于某个记录值」:
 *
 * - 多窗口连续兜底 → 每次同步记录一条代际转换。即使 refresh 尚未观察第一条转换,
 *   也能沿连续的兜底链识别到当前代际。
 *
 * 任何用户登录/登出造成的转换没有兜底记录,会截断这条链,流程仍被正常作废。
 */
export class ColdStartAuthFallbackRegistry {
  private readonly fallbacks = new Map<number, number>();

  /** Called synchronously with the auth epoch increment in clearAuth. */
  record(fromEpoch: number, toEpoch: number): void {
    if (toEpoch > fromEpoch) this.fallbacks.set(fromEpoch, toEpoch);
  }

  /** A late refresh is valid only if every intervening epoch came from startup fallback. */
  containsOnlyFallbacks(fromEpoch: number, toEpoch: number): boolean {
    let epoch = fromEpoch;
    while (epoch < toEpoch) {
      const nextEpoch = this.fallbacks.get(epoch);
      if (nextEpoch === undefined || nextEpoch <= epoch || nextEpoch > toEpoch) return false;
      epoch = nextEpoch;
    }
    return epoch === toEpoch;
  }

  /** Apply a refresh commit only while no explicit auth change interrupted its flow. */
  commitIfCurrent<T>(input: {
    flowEpoch: number;
    currentEpoch: number;
    commit: () => T;
  }): { committed: true; value: T } | { committed: false } {
    if (!this.containsOnlyFallbacks(input.flowEpoch, input.currentEpoch)) {
      return { committed: false };
    }
    return { committed: true, value: input.commit() };
  }

  clear(): void {
    this.fallbacks.clear();
  }
}

export function commitColdStartRefreshIfCurrent<T>(input: {
  registry: ColdStartAuthFallbackRegistry;
  flowEpoch: number;
  currentEpoch: number;
  commit: () => T;
}):
  | { superseded: true }
  | { superseded: false; flowEpoch: number; value: T } {
  const result = input.registry.commitIfCurrent({
    flowEpoch: input.flowEpoch,
    currentEpoch: input.currentEpoch,
    commit: input.commit,
  });
  if (!result.committed) return { superseded: true };
  return { superseded: false, flowEpoch: input.currentEpoch, value: result.value };
}

/**
 * 登录准备态(「正在连接登录服务」)最多阻塞 UI 的时长。getProviders 走
 * CindyAuthClient 默认 15s AbortController,但黑洞 / captive-portal 下 Electron
 * `net.fetch` 可能无视 abort,请求永不 settle → renderer 的 preparing 转圈永不
 * 结束。冷启动 splash 的 `awaitWithStartupTimeout` 闸只包 initialize();登录页是
 * initialize 完成、GuestRoute 放行之后才出现的。这里复用同一把闸,时限更保守
 * (30s),超时后走既有 error 步(「暂时无法登录」+ 重试);不 abort 在途 getProviders。
 */
export const LOGIN_PREPARING_GATE_TIMEOUT_MS = LOGIN_PREPARING_UNLOCK_TIMEOUT_MS;

export interface PreparingGateLog {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export type LoginProvidersLoadFailure = {
  success: false;
  code: string;
  retryAt?: number;
  state: ReturnType<typeof loginPreparingErrorState>;
};

/** 把 getProviders 失败(含准备态超时)映射成既有可重试错误步。 */
export function mapLoginProvidersLoadFailure(error: unknown): LoginProvidersLoadFailure {
  const code = error instanceof AuthApiError ? error.code : 'AUTH_SERVICE_UNAVAILABLE';
  const state = loginPreparingErrorState(
    code,
    error instanceof AuthApiError ? error.retryAt : undefined,
  );
  return {
    success: false,
    code,
    state,
    ...(state.retryAt !== undefined ? { retryAt: state.retryAt } : {}),
  };
}

/**
 * 限时等待登录 providers。超时抛 AUTH_SERVICE_UNAVAILABLE,不 abort 在途请求;
 * 迟到 settle 只打日志。`getProviders` 由调用方注入,单测可挂起 Promise + 假计时器。
 */
export async function awaitLoginProvidersWithPreparingGate<T>(
  getProviders: Promise<T>,
  log: PreparingGateLog,
): Promise<T> {
  return awaitWithStartupTimeout(getProviders, {
    timeoutMs: LOGIN_PREPARING_GATE_TIMEOUT_MS,
    onTimeout: () => {
      log.warn(
        `login providers still pending after ${LOGIN_PREPARING_GATE_TIMEOUT_MS}ms — unlocking the preparing UI`,
      );
      throw new AuthApiError(
        'AUTH_SERVICE_UNAVAILABLE',
        0,
        'Authentication server did not respond in time',
      );
    },
    onLateResult: () => log.info('login providers settled after preparing gate timeout'),
    onLateError: (err) =>
      log.warn('login providers request failed after preparing gate timeout', err),
  });
}
