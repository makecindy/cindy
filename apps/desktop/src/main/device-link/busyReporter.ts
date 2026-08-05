/**
 * busyReporter —— 被控端「本机是否有 turn 在跑」的 busy presence 状态(纯逻辑,无 client 依赖)。
 * ---------------------------------------------------------------------------
 * 被控端把 busy 上报给 server presence,供控制端设备列表显示「忙/闲」。两条上报路径共用同一
 * dedupe 基线 `lastReportedBusy`(只在翻转时上报,省 presence 写):
 *  - hello(连接 / **重连**握手):`helloBusy()` 返回当前真实 busy 并把它设成 dedupe 基线
 *    —— hello 帧会把 server presence 覆盖成这个值,基线必须同步,否则重连发生在 turn 进行中时
 *    (旧基线 busy=true、hello 报 busy=false)轮询的 dedupe 会把「补正回 true」压掉,其它设备
 *    整轮把本机看成空闲(PR #166 review New-F)。
 *  - 轮询(每 5s):`pollBusyChange()` 仅在与基线不同的时刻返回新值。
 * 登出 / 断连时 `resetBusyDedupe()` 把基线清回 false。
 *
 * probe 由 register.ts 在 maker 就绪后注入(返回本机当前是否有任意 session 在 turn 中)。
 */

let busyProbe: (() => boolean) | null = null;
let lastReportedBusy = false;

/** register.ts 注入:返回本机当前是否有任意 session 在 turn 中。传 null 解绑。 */
export function setBusyProbe(probe: (() => boolean) | null): void {
  busyProbe = probe;
}

/** 当前真实 busy(无 probe 时按 false)。 */
export function currentBusy(): boolean {
  return busyProbe?.() ?? false;
}

/**
 * hello 握手用:返回当前 busy,并把它设为 dedupe 基线。
 * hello 帧本身会把 server presence 设成该值,故基线同步后轮询不会把它当「未变化」漏掉后续翻转。
 */
export function helloBusy(): boolean {
  const busy = currentBusy();
  lastReportedBusy = busy;
  return busy;
}

/**
 * 轮询用:当前 busy 与基线不同 → 更新基线并返回新值(需上报);相同 → 返回 null(无需上报)。
 */
export function pollBusyChange(): boolean | null {
  const busy = currentBusy();
  if (busy === lastReportedBusy) return null;
  lastReportedBusy = busy;
  return busy;
}

/** 登出 / 断连:重置 dedupe 基线,避免重连后首个真实 busy 状态被旧值压掉。 */
export function resetBusyDedupe(): void {
  lastReportedBusy = false;
}

export const __testing = {
  reset(): void {
    busyProbe = null;
    lastReportedBusy = false;
  },
  getLastReported: (): boolean => lastReportedBusy,
};
