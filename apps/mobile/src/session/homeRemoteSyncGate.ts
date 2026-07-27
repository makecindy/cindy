/**
 * 首页远程同步闸门(「跳过登录」无账号态兜底,产品拍板 2026-07-27)。
 *
 * 无账号态下手机端没有 access token:首页的设备清单 REST(`/api/device-link/devices`)
 * 走 `apiFetch` 必然抛 `UNAUTHENTICATED`,首屏会固定落到「同步失败」且任何重试都不可能
 * 成功。本模块把「该不该发远程请求」「首屏定态了没有」两个判断抽成纯函数,让 HomeScreen
 * 在无账号态一次请求都不发、直接呈现既有的「无可控制电脑」引导空态(不造假数据、不显示
 * 错误条);有账号路径(`hasAccount`)逐条走原判定,行为零变化。
 */

/** 远程同步闸门输入(HomeScreen 的 loadHome 三入口共用同一组判据)。 */
export interface HomeRemoteSyncGateInput {
  /** 无账号本地态(isNoAccountHomeMode 的结果):一个鉴权请求都不许发 */
  noAccountMode: boolean;
  /** 设备身份缓存是否已就绪:未就绪时 REST 拿不到自身 deviceId,原样不发请求 */
  deviceIdentityCacheReady: boolean;
}

/**
 * 远程同步的**唯一执行闸门**:满足闸门才调用注入的 `sync`,否则一次都不调用。
 *
 * 抽成「闸门 + 注入 sync」而不是留在 HomeScreen 里裸写两行 early return,是为了让
 * 「无账号态零鉴权请求」变成**可 spy 的行为断言**(node vitest 挂不起 expo-router /
 * RN 运行时的 HomeScreen,源码字符串断言拦不住换语法或新增旁路调用)。
 * 语义与原 early return 逐条等价:短路时返回 `undefined`,放行时原样返回 `sync()` 结果
 * (调用方靠这个返回值把 in-flight promise 交回给下拉刷新)。
 */
export function runHomeRemoteSync<T>(
  gate: HomeRemoteSyncGateInput,
  sync: () => T,
): T | undefined {
  if (gate.noAccountMode) return undefined;
  if (!gate.deviceIdentityCacheReady) return undefined;
  return sync();
}

/** 首屏相位:ready = 已定态可渲染空态/列表;loading = 首轮同步中;error = 首轮同步失败。 */
export type HomeInitialPhase = 'loading' | 'error' | 'ready';

/**
 * 是否处于「无账号本地态」——只有跳过登录且确实没有账号时才算。
 *
 * 与 `isLocalMode` 单独判定的区别:`AuthContext` 拿到真实身份后会清 localMode 标记,
 * 但清除是异步落盘的一次 state 更新;`hasAccount` 优先保证「有账号就照常同步」,
 * 避免任何交叠瞬间误把已登录用户的首页同步掐掉。
 */
export function isNoAccountHomeMode(input: {
  hasAccount: boolean;
  isLocalMode: boolean;
}): boolean {
  return input.isLocalMode && !input.hasAccount;
}

/**
 * 首屏相位判定。
 *
 * - 已完成过一轮同步(缓存就绪 + lastSyncedAt 落地)→ ready(原语义);
 * - 无账号态永远不会发起同步(lastSyncedAt 恒为 null)→ 直接 ready,否则首页会卡在
 *   永久 spinner;
 * - 否则按有无连接错误分 error / loading(原语义)。
 */
export function resolveHomeInitialPhase(input: {
  deviceIdentityCacheReady: boolean;
  hasConnectionError: boolean;
  lastSyncedAt: number | null;
  noAccountMode: boolean;
}): HomeInitialPhase {
  if (input.deviceIdentityCacheReady && input.lastSyncedAt !== null) return 'ready';
  if (input.noAccountMode) return 'ready';
  return input.hasConnectionError ? 'error' : 'loading';
}
