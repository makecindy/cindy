/**
 * before-link 可靠帧触发的控制链路重开队列(控制端,Desktop main)。
 *
 * 触发源:client 的 onReliableFrameBeforeLink —— 对端仍按可靠流给本机发帧,但
 * 本机侧 peer link 未就绪。沉默丢弃会让两边互等(发送端等 ACK、接收端等 link),
 * 因此本机主动 openRemoteLink 让双方 stream 重新对齐。
 *
 * 与 transportTimeoutReopen(有界退避、次数耗尽即止)的分工:那条循环的触发源是
 * 对端**主动通知**(link-close transport-timeout,best-effort 可能丢);本队列的
 * 触发源是本机**从入站帧自行推断**,只要对端还在发帧就会被反复触发,所以这里不设
 * 次数上限而是固定间隔重排 —— 出队条件是成功 / 显式取消(关闭、撤权)/ dispose。
 *
 * 队列按 deviceId 隔离:某个 peer 的 reopen 反复失败只让它自己留队重排,不影响其它
 * peer 的链路与在途请求 —— 本层自带 per-device in-flight 去重(见 inFlight 注释),
 * 邻居的新触发不会给在途 peer 再发一次重开。
 */

type Timer = ReturnType<typeof setTimeout>;

export interface PeerLinkReopenQueueDeps {
  /** 重开链路(通常是 openRemoteLink;自带同 device in-flight 去重)。 */
  reopen(deviceId: string): Promise<unknown>;
  /**
   * 该设备当前是否允许重开(授权 + 方向)。**入队时与每次执行前都会复查** ——
   * 等待重排期间授权可能变化,失格即出队。判据见 shouldEnqueuePeerLinkReopen。
   */
  canReopen(deviceId: string): boolean;
  /**
   * 本轮是否可以执行(relay 持有权 / teardown)。返回 false 时**保留** pending
   * 集合、只跳过本轮执行 —— 恢复持有权后由下一次触发或重排继续。
   */
  canRun(): boolean;
  retryMs?: number;
  log?: { debug(msg: string, ...args: unknown[]): void };
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export interface PeerLinkReopenQueue {
  /** 收到 before-link 帧:过门禁后入队并立即尝试一次。 */
  trigger(deviceId: string): void;
  /** 显式出队(链路被关闭 / 撤权 / 用户断开)。 */
  cancel(deviceId: string): void;
  /**
   * 立即重试当前排队项(不新增设备)。用于 ownership 接管等「本轮之前 canRun 为
   * false、pending 已攒下」的时点补发一次,不必等固定间隔重排。
   */
  retryPending(): void;
  /** 清空全部(relay teardown / 停机)。 */
  dispose(): void;
  /** 测试观察点:当前排队中的设备数。 */
  pendingCount(): number;
  /** 测试观察点:该设备是否在排队中。 */
  isPending(deviceId: string): boolean;
}

const DEFAULT_RETRY_MS = 5_000;

/**
 * 入队授权判据(纯函数,供 index.ts 接线 + 单测固化契约)。
 *
 * `hasOutboundSubscriptions` 是**方向判据**:openRemoteLink 语义是「本机去控制
 * 对方」,只有本机确实在控制该设备时才重开。否则纯被控端方向的入站可靠帧会触发
 * 反向建链 —— 对端接受则凭空多出一条非用户发起的控制链与受控横幅,拒绝则队列
 * 持续空转。
 *
 * 判据里**刻意没有** client 的 `peer.explicitlyClosed`:那是 peer 级双向共享位,
 * 互控时对端仅关闭「它控制本机」的方向也会置位,据此抑制会把本机仍然有效的出站
 * 方向一起掐死。用户显式关闭本机对该设备的控制时,setDeviceControlEnabled 同时
 * 清订阅 + 写 disabledControl,下面两项都会拦住。
 */
export interface PeerLinkReopenAuthorizationInputs {
  /** 本机持有该设备的出站订阅(= 本机确实在控制它)。 */
  hasOutboundSubscriptions: boolean;
  /** 本机已在本地关闭对该设备的控制(与 openRemoteLink 的 fail-closed 门同源)。 */
  controlDisabledLocally: boolean;
}

export function shouldEnqueuePeerLinkReopen(
  inputs: PeerLinkReopenAuthorizationInputs,
): boolean {
  if (!inputs.hasOutboundSubscriptions) return false;
  if (inputs.controlDisabledLocally) return false;
  return true;
}

export function createPeerLinkReopenQueue(
  deps: PeerLinkReopenQueueDeps,
): PeerLinkReopenQueue {
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const log = deps.log ?? { debug: () => {} };
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));

  const pending = new Set<string>();
  /**
   * 已发出但未落定的重开。flush 会遍历整个 pending 集合(任一 peer 的新触发都会
   * 带动一轮),没有这层去重时,邻居的触发会给在途 peer 再发一次重开 —— 虽然
   * reopen(openRemoteLink)自己也去重,但让隔离性在本层就成立,重排也不会叠加。
   */
  const inFlight = new Set<string>();
  let retryTimer: Timer | null = null;

  const clearRetryTimer = (): void => {
    if (retryTimer === null) return;
    clearTimer(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = (): void => {
    if (retryTimer !== null || pending.size === 0 || !deps.canRun()) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      flush();
    }, retryMs);
    (retryTimer as unknown as { unref?: () => void }).unref?.();
  };

  const flush = (): void => {
    if (!deps.canRun()) return;
    // 快照迭代:reopen 的 then/catch 会改动 pending,直接迭代 Set 有并发修改风险。
    for (const deviceId of [...pending]) {
      if (inFlight.has(deviceId)) continue;
      // 门禁必须在**每次执行前**复查,不能只在入队时过一次:首次重开失败后、
      // 等待重排的这段时间里,用户可能关掉最后一个控制窗口 / 退订最后一个 topic /
      // 关闭对该设备的控制。那之后再 reopen 会在本机毫无出站订阅的情况下建起控制链,
      // 并让对端显示非用户发起的受控横幅(review P1)。失格即出队。
      if (!deps.canReopen(deviceId)) {
        pending.delete(deviceId);
        if (pending.size === 0) clearRetryTimer();
        continue;
      }
      log.debug(`peer link stale-frame recovery for ${deviceId.slice(0, 8)}`);
      // 同步发起;只有同步抛出的实现才需要转成 rejected promise,避免异常逃出
      // flush 打断其它 peer 的这一轮。
      let attempt: Promise<unknown>;
      try {
        attempt = Promise.resolve(deps.reopen(deviceId));
      } catch (err) {
        attempt = Promise.reject(err);
      }
      inFlight.add(deviceId);
      void attempt.then(
        () => {
          inFlight.delete(deviceId);
          pending.delete(deviceId);
          if (pending.size === 0) clearRetryTimer();
        },
        (err) => {
          inFlight.delete(deviceId);
          log.debug(`peer link stale-frame recovery failed for ${deviceId.slice(0, 8)}`, err);
          scheduleRetry();
        },
      );
    }
  };

  return {
    trigger(deviceId: string): void {
      if (!deps.canRun()) return;
      if (!deps.canReopen(deviceId)) return;
      pending.add(deviceId);
      flush();
    },
    retryPending(): void {
      flush();
    },
    cancel(deviceId: string): void {
      pending.delete(deviceId);
      inFlight.delete(deviceId);
      if (pending.size === 0) clearRetryTimer();
    },
    dispose(): void {
      clearRetryTimer();
      pending.clear();
      inFlight.clear();
    },
    pendingCount: () => pending.size,
    isPending: (deviceId: string) => pending.has(deviceId),
  };
}
