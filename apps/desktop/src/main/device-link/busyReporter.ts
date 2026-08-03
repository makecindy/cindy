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
 *
 * **probe 抛错 = 未知,不等于 false**:注入的 probe 走 `anySessionInTurn(maker)`,而那个
 * maker 是 bootstrap 的动态 facade —— 账号/owner 边界切换期间它按契约抛
 * `PRECONDITION_FAILED: App session is switching`。此处必须把它当「这一拍问不出来」处理:
 *  - 不能让它逃出去:调用方是 5s `setInterval`,异常会成为主进程 uncaughtException 并触发
 *    beginShutdown(冷启动崩溃循环,见 issue #1358);
 *  - 也不能退化成 false:那会把 dedupe 基线推成「不忙」,turn 正在跑时其它设备整轮把本机
 *    看成空闲(本文件开头 PR #166 review New-F 记的就是这个坑)。
 * 因此 `probeBusy()` 用 null 表示未知,轮询遇到 null 直接跳过本拍、基线保持不动。
 */

import { createLogger } from '../logger';

const log = createLogger('device-link-busy');

let busyProbe: (() => boolean) | null = null;
let lastReportedBusy = false;
/** 是否已为当前这段连续 probe 失败记过日志(边界切换期每 5s 一条纯噪音)。 */
let probeFailureLogged = false;

/**
 * register.ts 注入:返回本机当前是否有任意 session 在 turn 中。传 null 解绑。
 *
 * 换 probe 一并重置失败日志抑制:抑制只应作用于**同一段**连续失败。否则解绑后再注入
 * 一个仍会抛错的 probe(账号切换后重建 maker 即走这条路),新一段的首条 warn 会被上一
 * 段的标志吃掉,排障时看不到它曾经不可用。
 */
export function setBusyProbe(probe: (() => boolean) | null): void {
  busyProbe = probe;
  probeFailureLogged = false;
}

/**
 * 探一次 busy:无 probe 按 false;probe 抛错返回 null(未知,见文件头)。
 * 同一段连续失败只记一条 warn,恢复后重新武装。
 */
function probeBusy(): boolean | null {
  if (!busyProbe) return false;
  try {
    const busy = busyProbe();
    probeFailureLogged = false;
    return busy;
  } catch (err) {
    if (!probeFailureLogged) {
      probeFailureLogged = true;
      log.warn('busy probe unavailable; skipping presence ticks until it recovers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/** 当前真实 busy(无 probe 或 probe 不可用时按 false)。 */
export function currentBusy(): boolean {
  return probeBusy() ?? false;
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
 * probe 不可用(边界切换期)同样返回 null,且**不动基线** —— 等下一拍问得出来再说。
 */
export function pollBusyChange(): boolean | null {
  const busy = probeBusy();
  if (busy === null) return null;
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
    probeFailureLogged = false;
  },
  getLastReported: (): boolean => lastReportedBusy,
};
