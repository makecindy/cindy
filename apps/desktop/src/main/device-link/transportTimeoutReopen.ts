/**
 * transport-timeout 重开的有界退避循环(控制端,Desktop main)。
 *
 * 被控端对本机控制链路做 peer 级瞬时重置后,relay 与 presence 都保持在线——
 * 没有任何既有事件会再次触发 replay/重建。若一次 openRemoteLink 失败(被控端
 * 瞬时繁忙 / relay 抖动)就放弃,发送方保留的在途回包与实时订阅会长期挂起。
 * 这里提供与 Mobile rehydrate 同精神的恢复循环:退避重试、per-device in-flight
 * 去重、显式终止条件(成功 / 中止判定 / 次数耗尽)。
 *
 * 次数耗尽后不再本地重试:对端若持续不可达,由 presence(转 offline 清理)或
 * 用户下一次打开远程视图(openRemoteLink 惰性重建)兜底——两者都不拆共享
 * relay 连接,也不会丢被控端保留的可靠 pending(它等到下一次 link-accept 续传)。
 */

type Timer = ReturnType<typeof setTimeout>;

export interface TransportTimeoutReopenDeps {
  /** 重开链路(通常是 openRemoteLink;自带同 device in-flight 去重)。 */
  reopen(deviceId: string): Promise<unknown>;
  /** 返回 true 则终止该设备的循环(撤权 / client 不在 / 待命态 / relay 离线)。 */
  shouldAbort(deviceId: string): boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  log?: { info(msg: string): void; warn(msg: string): void };
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

interface ReopenEntry {
  timer: Timer | null;
  running: boolean;
}

export interface TransportTimeoutReopenLoop {
  /** 触发一轮恢复;该设备已有循环在跑(含等待退避)时为 no-op。 */
  trigger(deviceId: string): void;
  /** 终止并清理某设备的循环(撤权 / 显式关闭时调用)。 */
  cancel(deviceId: string): void;
  /** 终止全部循环(relay 断开 / 停机)。 */
  dispose(): void;
  /** 测试观察点:该设备是否有循环在跑。 */
  isActive(deviceId: string): boolean;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;

export function createTransportTimeoutReopenLoop(
  deps: TransportTimeoutReopenDeps,
): TransportTimeoutReopenLoop {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(0, deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const entries = new Map<string, ReopenEntry>();

  const finish = (deviceId: string): void => {
    const entry = entries.get(deviceId);
    if (entry?.timer) clearTimer(entry.timer);
    entries.delete(deviceId);
  };

  const attempt = (deviceId: string, n: number): void => {
    const entry = entries.get(deviceId);
    if (!entry) return;
    entry.timer = null;
    if (deps.shouldAbort(deviceId)) {
      finish(deviceId);
      return;
    }
    entry.running = true;
    deps.reopen(deviceId).then(
      () => {
        // link-accept 已达成:被控端 sendLinkAccept 会清扫陈旧前缀并重放 live
        // pending,双向续传由传输层接管,循环使命完成。
        finish(deviceId);
      },
      (err) => {
        entry.running = false;
        if (!entries.has(deviceId)) return; // 期间被 cancel/dispose
        if (n >= maxAttempts) {
          deps.log?.warn(
            `transport-timeout reopen gave up for ${deviceId.slice(0, 8)} after ${n} attempts: ${String(err)}`,
          );
          finish(deviceId);
          return;
        }
        const delay = baseDelayMs * 2 ** (n - 1);
        entry.timer = setTimer(() => attempt(deviceId, n + 1), delay);
      },
    );
  };

  return {
    trigger(deviceId: string): void {
      if (entries.has(deviceId)) return;
      entries.set(deviceId, { timer: null, running: false });
      attempt(deviceId, 1);
    },
    cancel(deviceId: string): void {
      finish(deviceId);
    },
    dispose(): void {
      for (const deviceId of [...entries.keys()]) finish(deviceId);
    },
    isActive(deviceId: string): boolean {
      return entries.has(deviceId);
    },
  };
}
