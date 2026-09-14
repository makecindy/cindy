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
  /** Local view invalidation, including another reset while reopen is already pending. */
  onReset?(deviceId: string): void;
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

/**
 * 重开循环的授权边界(纯函数,供 index.ts 接线 + 单测固化契约)。
 *
 * 输入里**刻意没有**「对方是否被本机撤权」(revokedControllers):那个名单的
 * 语义是「目标设备不再允许控制**本机**」——与本机主动控制对方无关,互控
 * 且仅反向撤权时不得阻断本机控制链路的 transport-timeout 重建。目标侧
 * 撤销本机控制权的信号是入站 link-close('revoked'),由
 * routeLinkCloseForReopen 的永久关闭分支终止循环。
 */
export interface ReopenAuthorizationInputs {
  /** relay 在线且 client 存在。 */
  clientOnline: boolean;
  /** 本实例持有 device-link 所有权(非待命态)。 */
  isOwner: boolean;
  /** 本机已对该设备关闭控制(disabledControlDeviceIds,与 openRemoteLink 的
   * fail-closed 门同源)。 */
  controlDisabledLocally: boolean;
  /**
   * 本机仍在控制该设备的**方向证据**:持有出站订阅,或仍有在等它回包的出站业务
   * 请求(invoke)。openRemoteLink 语义是「本机去控制对方」,失去证据后继续重建
   * 会在本机毫无控制意图时把链路建起来,对端还会显示非用户发起的受控横幅。
   *
   * 必须在**每次尝试前**复查而非只在 trigger 时过一次:退避等待期间用户可能关掉
   * 最后一个远程会话窗口 / 退订最后一个 topic(review P1)。
   *
   * 判据里刻意不含在途 link-open:重建动作本身就是发 link-open,算进来会形成
   * 「重建在途 → 因此有权重建」的自我论证闭环。
   */
  hasOutboundControlIntent: boolean;
}

export function shouldAbortTransportTimeoutReopen(
  inputs: ReopenAuthorizationInputs,
): boolean {
  if (!inputs.clientOnline || !inputs.isOwner) return true;
  if (inputs.controlDisabledLocally) return true;
  return !inputs.hasOutboundControlIntent;
}

/**
 * 入站 link-close 的 reason → 重开循环动作路由(纯函数)。
 *
 * transport-timeout 是唯一的可恢复瞬时重置 → 触发重建;其它一切 reason
 * (user/toggle-off/shutdown/revoked 及未知新值)都是永久关闭 → 必须终止
 * 已在进行的重开循环,否则刚被(对端或本地)断开的控制链会被退避重试
 * 重新建起。
 */
export function routeLinkCloseForReopen(
  reason: string | undefined,
  loop: Pick<TransportTimeoutReopenLoop, 'trigger' | 'cancel'>,
  deviceId: string,
): void {
  if (reason === 'transport-timeout') {
    loop.trigger(deviceId);
    return;
  }
  loop.cancel(deviceId);
}

export function createTransportTimeoutReopenLoop(
  deps: TransportTimeoutReopenDeps,
): TransportTimeoutReopenLoop {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(0, deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const entries = new Map<string, ReopenEntry>();

  /** 代际身份校验:只有当前登记的仍是本代 entry 才允许改变状态。
   * cancel/dispose 后同设备可能已启动新一轮恢复——旧代 reopen Promise 的晚到
   * 回调若按 deviceId 无条件 finish,会误删新一代 entry 并清掉其退避计时器,
   * 让重建静默停止。 */
  const isCurrent = (deviceId: string, entry: ReopenEntry): boolean =>
    entries.get(deviceId) === entry;

  const finishEntry = (deviceId: string, entry: ReopenEntry): void => {
    if (!isCurrent(deviceId, entry)) return;
    if (entry.timer) clearTimer(entry.timer);
    entries.delete(deviceId);
  };

  const removeCurrent = (deviceId: string): void => {
    const entry = entries.get(deviceId);
    if (!entry) return;
    if (entry.timer) clearTimer(entry.timer);
    entries.delete(deviceId);
  };

  const attempt = (deviceId: string, entry: ReopenEntry, n: number): void => {
    if (!isCurrent(deviceId, entry)) return; // 旧代定时器晚触
    entry.timer = null;
    if (deps.shouldAbort(deviceId)) {
      finishEntry(deviceId, entry);
      return;
    }
    // 同步 throw 统一转成 rejection:deps.reopen 的契约是返 Promise,但非 async
    // 实现可能在入参校验/待命断言处同步抛——不能成为未捕获异常,应进入
    // 同一套失败退避/终止分支。
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(deps.reopen(deviceId));
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      () => {
        // link-accept 已达成:被控端 sendLinkAccept 会清扫陈旧前缀并重放 live
        // pending,双向续传由传输层接管,循环使命完成。仅限本代:晚到的
        // 旧代成功不得关掉新一代正在进行的恢复。
        finishEntry(deviceId, entry);
      },
      (err) => {
        if (!isCurrent(deviceId, entry)) return; // 被 cancel/dispose 或已换代
        if (n >= maxAttempts) {
          deps.log?.warn(
            `transport-timeout reopen gave up for ${deviceId.slice(0, 8)} after ${n} attempts: ${String(err)}`,
          );
          finishEntry(deviceId, entry);
          return;
        }
        const delay = baseDelayMs * 2 ** (n - 1);
        entry.timer = setTimer(() => attempt(deviceId, entry, n + 1), delay);
      },
    );
  };

  return {
    trigger(deviceId: string): void {
      deps.onReset?.(deviceId);
      if (entries.has(deviceId)) return;
      const entry: ReopenEntry = { timer: null };
      entries.set(deviceId, entry);
      attempt(deviceId, entry, 1);
    },
    cancel(deviceId: string): void {
      removeCurrent(deviceId);
    },
    dispose(): void {
      for (const deviceId of [...entries.keys()]) removeCurrent(deviceId);
    },
    isActive(deviceId: string): boolean {
      return entries.has(deviceId);
    },
  };
}
