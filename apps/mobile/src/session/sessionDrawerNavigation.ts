export interface SessionDrawerRouteTarget {
  deviceId: string;
  deviceName: string;
  sessionId: string;
  focusClientId?: string;
}

export interface SessionRouteParamsNavigation {
  replaceParams(params: SessionDrawerRouteTarget): void;
}

/**
 * 在当前 Session 原生 Screen 内切换任务。
 *
 * `router.replace('/sessions/[sessionId]')` 会派发 NativeStack REPLACE，Android 上既会
 * 创建新的 route key，也会触发原生 Screen 的替换生命周期；宽屏抽屉的真实崩溃/白屏
 * 都发生在这条路径上。SessionScreen 本身已经按 sessionId 做换代与异步结果隔离，因此
 * 这里只替换当前 route 的完整 params：不创建新 Screen，也不会把旧任务的 draft / goal /
 * focus 等一次性参数合并进目标任务。
 */
export function switchDrawerSessionInPlace(
  navigation: SessionRouteParamsNavigation,
  target: SessionDrawerRouteTarget,
): void {
  navigation.replaceParams({
    deviceId: target.deviceId,
    deviceName: target.deviceName,
    sessionId: target.sessionId,
    ...(target.focusClientId ? { focusClientId: target.focusClientId } : {}),
  });
}
