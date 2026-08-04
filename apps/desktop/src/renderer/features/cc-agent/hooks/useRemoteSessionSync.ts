/**
 * useRemoteSessionSync —— 打开的 device-link 远程会话:重 topic 订阅(含重连重建)+ 消息对账触发。
 * ---------------------------------------------------------------------------
 * 修「控制端丢消息」:被控端实时流走重 topic `session:<id>` 的 fire-and-forget push,
 * 断连窗口 / 被控端重启(订阅 registry 清空)/ relay 丢帧都会让某轮消息静默丢失,而打开的
 * 会话首拉后只靠 live push 增长、从不补。本 hook:
 *   1. 订阅重 topic;**WS 重连 / 被控端回在线**时重新订阅(原 effect 只在 mount 订一次,
 *      重连后订阅丢失也不重建 → 后续整轮都收不到)。
 *   2. 在以下时机对账(`makerChatStore.reconcileRemoteMessages`,重拉最近页 + 合并去重,以被控端为准):
 *      WS 重连 / 被控端回在线 / **turn 结束**(isRunning true→false)/ 窗口聚焦 / 手动。
 *   3. 暴露 `resync()` 给连接 banner 的「重新同步」按钮:重订阅 + 对账 + 重拉会话列表。
 *
 * 编排逻辑(订阅重建 / 去抖对账 / turn 结束边沿检测 / 退订)抽进**注入式纯核** RemoteSyncEngine,
 * 桌面端 vitest 是 node 环境(无 RTL),engine 可不依赖 React 直接单测;hook 仅作薄 adapter:
 * 把真实事件源(deviceLink.onStatusChanged / onPresenceChanged / makerChatStore turn 态 / window focus)
 * 接到 engine,并管理生命周期。本机会话(deviceId 为空)整体 no-op → 零回归。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { isSessionTurnRunningFor } from '@/lib/makerTransport';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';

const log = createLogger('useRemoteSessionSync');

/** 多触发源(重连/presence/turn-end/focus/手动)合并的去抖窗口。 */
const RECONCILE_DEBOUNCE_MS = 200;

// ─── 注入式纯核(可不依赖 React 单测)──────────────────────────────────────────

/** engine 当前目标(hook 每次 effect 绑定一对常量 session/device)。 */
export interface RemoteSyncTarget {
  sessionId: string | undefined;
  deviceId: string | undefined;
}

/** engine 的外部副作用依赖(测试注入 spy)。 */
export interface RemoteSyncEngineDeps {
  subscribe: (deviceId: string, topics: string[]) => void;
  unsubscribe: (deviceId: string, topics: string[]) => void;
  reconcile: (sessionId: string) => void;
  refreshList: (deviceId: string) => void;
  /** 去抖窗口(默认 200ms);测试可调小或配合 fake timers。 */
  debounceMs?: number;

  // ── stall 看门狗(全部提供才启用;现有 caller 不传 → 看门狗 dormant、零回归)──
  /** 时钟(默认 Date.now);测试注入可控时钟。 */
  now?: () => number;
  /** 读某会话最近入站事件时刻(ms);无记录 → undefined(以 startWatchdog 时刻兜底)。 */
  getLastEventAt?: (sessionId: string) => number | undefined;
  /** 控制端镜像里该会话当前是否显示「turn 在跑」(isRunning)。 */
  isRunningNow?: (sessionId: string) => boolean;
  /** 向被控端核实该会话真实运行态(权威);throw=不可达/旧端/超时。 */
  queryTurnRunning?: (sessionId: string) => Promise<boolean>;
  /** 确认被控端 not-running 后,强制收尾控制端卡死的 turn(幂等)。 */
  finalize?: (sessionId: string) => void;
  /** 强制对账(放行 isStreaming 守卫),补回 stall 期间丢失的消息帧。 */
  reconcileForce?: (sessionId: string) => void;
  /** 查询不可达 → 无法判定,弹 UI 兜底让用户手动刷新/收尾。 */
  onSuspectStall?: (sessionId: string) => void;
  /** 已恢复(新事件到达 / turn 结束 / 查询成功连上被控端)→ 清掉可能残留的 suspectStall 兜底态,
   *  避免给一个其实活着的 turn 一直挂「可能已断流 / 结束本轮」。 */
  onRecovered?: (sessionId: string) => void;
  /** 判定「卡死」的静默阈值(默认 90s):isRunning 但久未收到任何 push。 */
  stallThresholdMs?: number;
  /** 看门狗巡检基础间隔(默认 15s);未 finalize 的回合按 backoff 倍增到 4×。 */
  watchdogIntervalMs?: number;
}

export interface RemoteSyncEngine {
  /** 订阅重 topic(mount / 重连重建)。无 device/session → no-op。 */
  subscribeHeavy(): void;
  /** 用初始 turn 运行态初始化边沿检测(避免 mount-mid-run 时误判第一次 false)。 */
  primeRunning(running: boolean): void;
  /**
   * mount 时如果控制端内存显示 isRunning=true,立即向被控端核实 turn 态。
   * 解决:切走期间 done 丢失 → 切回后永久卡 Generating(需等 90s 看门狗才恢复)的问题。
   */
  reconcileOnMount(): void;
  /** WS 重连到 online:重建订阅 + 安排对账。 */
  handleOnline(): void;
  /** presence 变化:本会话设备且 online → 重建订阅 + 对账;否则忽略。 */
  handlePresence(deviceId: string, online: boolean): void;
  /**
   * 「设备无响应」熔断恢复:本会话设备 → 重建订阅 + 对账,并核实/收尾熔断期间
   * 可能已结束却丢了 done 帧的回合(见 verifyAndSettleRunningTurn)。
   */
  handleResponsivenessRecovered(deviceId: string): void;
  /** turn 运行态变化(内部边沿检测 true→false → 对账)。 */
  handleRunningChange(running: boolean): void;
  /** 窗口聚焦 → 对账。 */
  handleFocus(): void;
  /** 手动重新同步:重订阅 + 对账 + 重拉会话列表。 */
  resync(): void;
  /** 启动 stall 看门狗(需注入看门狗 deps,否则 no-op)。hook 在 mount 时调。 */
  startWatchdog(): void;
  /** 停止 stall 看门狗(dispose 内部也会调)。 */
  stopWatchdog(): void;
  /** 卸载:清去抖定时器 + 停看门狗 + 退订重 topic。 */
  dispose(): void;
}

/**
 * 远程会话同步编排纯核。getTarget 返回当前 session/device(hook 每个 effect 绑定常量)。
 * 去抖用真实 setTimeout —— 测试用 vi.useFakeTimers + advanceTimersByTime 驱动(node 环境可用)。
 */
export function createRemoteSessionSyncEngine(
  getTarget: () => RemoteSyncTarget,
  deps: RemoteSyncEngineDeps,
): RemoteSyncEngine {
  const debounceMs = deps.debounceMs ?? RECONCILE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let prevRunning = false;

  const subscribeHeavy = (): void => {
    const { sessionId, deviceId } = getTarget();
    if (!sessionId || !deviceId) return;
    deps.subscribe(deviceId, [`session:${sessionId}`]);
  };

  const scheduleReconcile = (): void => {
    const { sessionId, deviceId } = getTarget();
    if (!sessionId || !deviceId) return;
    if (timer) return; // 已有待执行 → 合并(去抖)
    timer = setTimeout(() => {
      timer = null;
      const t = getTarget();
      if (t.sessionId && t.deviceId) deps.reconcile(t.sessionId);
    }, debounceMs);
  };

  // ── stall 看门狗 ──────────────────────────────────────────────────────────
  // isRunning=true 但久未收到任何 push(终态帧丢失 / 订阅静默失效)→ 控制端会永久卡
  // "Generating"。看门狗定时核实:重订阅 + 强制对账 + 向被控端查权威 turn 态;
  // 答 not-running 才收尾(绝不误杀真在跑的慢 turn)。需注入全套看门狗 deps 才启用。
  const now = deps.now ?? (() => Date.now());
  const stallThresholdMs = deps.stallThresholdMs ?? 90_000;
  const baseIntervalMs = deps.watchdogIntervalMs ?? 15_000;
  const watchdogEnabled = !!(
    deps.getLastEventAt && deps.isRunningNow && deps.queryTurnRunning &&
    deps.finalize && deps.reconcileForce
  );
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogStartedAt = 0;
  let watchdogStopped = false;
  let backoff = 1; // 未 finalize 的回合间隔倍增(封顶 4× → 60s)
  let recovering = false; // 防 async 恢复序列重入

  const lastSeen = (sessionId: string): number =>
    deps.getLastEventAt?.(sessionId) ?? watchdogStartedAt;

  const scheduleTick = (delayMs: number): void => {
    if (!watchdogEnabled || watchdogStopped) return; // stop/dispose 后(含 await 期间)不再重排
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      void watchdogTick();
    }, delayMs);
  };

  const watchdogTick = async (): Promise<void> => {
    const { sessionId, deviceId } = getTarget();
    // 目标无效 / 恢复进行中 → 跳过本拍。
    if (!sessionId || !deviceId || recovering) { scheduleTick(baseIntervalMs); return; }
    // turn 不在跑(可能已正常收尾)/ 还没静默够久 → 已恢复:清残留兜底态 + 复位 backoff,常规巡检。
    if (!deps.isRunningNow!(sessionId) || now() - lastSeen(sessionId) < stallThresholdMs) {
      deps.onRecovered?.(sessionId);
      backoff = 1;
      scheduleTick(baseIntervalMs);
      return;
    }
    // ── 本地确认「卡死」(isRunning 但静默 ≥ 阈值)→ 恢复序列 ──
    recovering = true;
    try {
      subscribeHeavy(); // 1. 重订阅,治愈静默丢失的订阅(#5 触发)。仅此步可安全先做(不碰消息)。
      const stillRunning = await deps.queryTurnRunning!(sessionId); // 2. 核实被控端权威态
      // await 期间可能已 dispose / stop(切会话 / 卸载)→ watchdogStopped 是真正的 abort token。
      // (getTarget() 是本 effect 常量闭包,sessionId 恒等,不能用它判过期 —— 那是死代码。)
      // 迟到结果一律丢弃,绝不在已停的看门狗上 finalize / 弹兜底(否则会把 stall 态错挂到新会话)。
      if (watchdogStopped) return;
      // 查询成功本身 = 连上了被控端 → 清掉之前查询失败残留的 suspectStall 兜底态。
      deps.onRecovered?.(sessionId);
      if (!stillRunning) {
        deps.finalize!(sessionId); // 权威 not-running → 收尾卡死的 Generating(清 isStreaming)
        // host 已确认停 + finalize 已清 isStreaming → 此刻 force 对账才安全,不会打断在串的 turn。
        // (force 绝不在 query 之前做:仍在跑的慢 turn 会走 else 分支,绝不在 live stream 上强行合并 DB 行,
        //  对齐 reconcileRemoteMessages 的 isStreaming 守卫语义。)
        deps.reconcileForce!(sessionId); // 补回丢失 done 本该带来的最终消息(#6 触发,延后到确认停后)
        backoff = 1;
      } else {
        backoff = Math.min(backoff * 2, 4); // 真在跑的慢 turn → 不收尾、不 force 对账,下窗 backoff 再核
      }
    } catch {
      // 查询不可达 / 旧被控端无此 channel / 超时 / 离线 → 不 auto-finalize,弹兜底让用户处理。
      // 同样:await 期间若已 dispose,迟到的失败不应把兜底态挂到新会话。
      if (watchdogStopped) return;
      deps.onSuspectStall?.(sessionId);
      backoff = Math.min(backoff * 2, 4);
    } finally {
      recovering = false;
      scheduleTick(baseIntervalMs * backoff);
    }
  };

  const startWatchdog = (): void => {
    if (!watchdogEnabled || watchdogTimer) return;
    watchdogStopped = false;
    watchdogStartedAt = now();
    backoff = 1;
    scheduleTick(baseIntervalMs);
  };

  const stopWatchdog = (): void => {
    watchdogStopped = true; // 含 await 期间:finally 的 scheduleTick 变 no-op
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  // ── mount-time reconcile: 切回正在跑的远程 session 时立即核实 ──────────────
  // 场景:用户在 turn 执行期间切到 session B,被控端 done 推过来时控制端已退订 → done 丢了。
  // 切回时 isRunning=true(旧内存态),但被控端实际已完成。不核实就要等 90s 看门狗才恢复。
  // 修复:mount 后发现 isRunning=true → 延迟 1s(等订阅生效 + 可能有晚到的 done push)→
  // 如果仍 isRunning → queryTurnRunning 核实权威态 → not-running 就 finalize + 对账。
  const MOUNT_RECONCILE_DELAY_MS = 1_000;
  let mountReconcileTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 「本地仍 isRunning,但被控端可能早已跑完」的一次性核实与收尾。
   *
   * 两个触发时点共用(都是「本机与被控端可能已错过 done 帧」的边沿):
   *  - mount:切回一个 turn 期间被退订过的远程会话;
   *  - 熔断恢复:熔断 open 期间订阅与消息拉取全被快速失败挡掉,done 帧可能丢了。
   *
   * 先延迟一小段等晚到的 done push 落地,仍 isRunning 才向被控端核实权威态;
   * 权威 not-running 时先 finalize 清 isStreaming、再 force 对账 —— 不 force 的
   * 对账会被 store 的 streaming guard 跳过,消息补不回来(review P2)。
   * 核实不可达时不 auto-finalize,交给看门狗兜底。
   */
  const verifyAndSettleRunningTurn = (): void => {
    if (!watchdogEnabled) return; // 缺看门狗 deps → 无法核实,依赖原有 90s 路径
    const { sessionId } = getTarget();
    if (!sessionId || !deps.isRunningNow!(sessionId)) return;
    if (mountReconcileTimer !== null) return; // 已有一次核实在途,不叠加
    mountReconcileTimer = setTimeout(() => {
      mountReconcileTimer = null;
      const { sessionId: sid } = getTarget();
      if (!sid || watchdogStopped) return;
      if (!deps.isRunningNow!(sid)) {
        // 延迟期间已收到 done(正常 push 到达或边沿检测触发了 reconcile)→ 无需操作
        return;
      }
      // 仍 isRunning → 核实被控端
      void (async () => {
        try {
          const stillRunning = await deps.queryTurnRunning!(sid);
          if (watchdogStopped) return;
          // 核实**成功**本身就是「被控端可达」的证据 → 收起 suspect-stall 兜底
          // (与看门狗路径对齐)。否则此前因查询失败挂起的兜底横幅会在连接已恢复后
          // 继续要求用户手动处理,直到下一次看门狗巡检(退避后可能约 60s)才消失
          // (review P2)。turn 仍在运行也照样清 —— 它只是「无法核实」的兜底态。
          deps.onRecovered?.(sid);
          if (!stillRunning) {
            deps.finalize!(sid);
            deps.reconcileForce!(sid);
          }
        } catch {
          // 不可达 → 不 auto-finalize、不清兜底,看门狗后续会覆盖
        }
      })();
    }, MOUNT_RECONCILE_DELAY_MS);
  };

  const reconcileOnMount = (): void => {
    verifyAndSettleRunningTurn();
  };

  return {
    subscribeHeavy,
    primeRunning(running) {
      prevRunning = running;
    },
    reconcileOnMount,
    handleOnline() {
      subscribeHeavy();
      scheduleReconcile();
    },
    handleResponsivenessRecovered(deviceId) {
      if (deviceId !== getTarget().deviceId) return;
      subscribeHeavy();
      scheduleReconcile();
      // 熔断期间被控端可能已跑完而 done 帧被丢:不带 force 的对账会被 store 的
      // streaming guard 跳过,Generating 与缺失消息会一直留到看门狗核实。
      verifyAndSettleRunningTurn();
    },
    handlePresence(deviceId, online) {
      if (deviceId !== getTarget().deviceId || !online) return;
      subscribeHeavy();
      scheduleReconcile();
    },
    handleRunningChange(running) {
      if (prevRunning && !running) scheduleReconcile(); // turn 结束边沿
      prevRunning = running;
    },
    handleFocus() {
      scheduleReconcile();
    },
    resync() {
      const { deviceId } = getTarget();
      if (!deviceId) return;
      subscribeHeavy();
      scheduleReconcile();
      deps.refreshList(deviceId);
    },
    startWatchdog,
    stopWatchdog,
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (mountReconcileTimer) {
        clearTimeout(mountReconcileTimer);
        mountReconcileTimer = null;
      }
      stopWatchdog();
      const { sessionId, deviceId } = getTarget();
      if (sessionId && deviceId) deps.unsubscribe(deviceId, [`session:${sessionId}`]);
    },
  };
}

// ─── React adapter ────────────────────────────────────────────────────────────

export interface RemoteSessionSync {
  /** 手动重新同步(banner 按钮):重订阅重 topic + 对账消息 + 重拉会话列表。 */
  resync: () => void;
  /**
   * stall 看门狗本地确认卡死、但**向被控端核实失败**(不可达 / 旧端无此 channel / 超时)→ true。
   * 此时无法判定被控端是否真在跑,故不自动收尾,改由 UI 弹兜底让用户手动刷新 / 收尾。
   */
  suspectStall: boolean;
  /** 兜底:用户手动收尾卡死的远程 turn(配合 suspectStall)。 */
  forceFinalize: () => void;
}

export function useRemoteSessionSync(
  sessionId: string | undefined,
  deviceId: string | undefined,
): RemoteSessionSync {
  const engineRef = useRef<RemoteSyncEngine | null>(null);
  const [suspectStall, setSuspectStall] = useState(false);

  const resync = useCallback(() => {
    setSuspectStall(false);
    engineRef.current?.resync();
  }, []);
  const forceFinalize = useCallback(() => {
    if (sessionId) makerChatStore.finalizeStuckRemoteTurn(sessionId);
    setSuspectStall(false);
  }, [sessionId]);

  useEffect(() => {
    setSuspectStall(false); // 切会话 → 复位兜底态
    if (!sessionId || !deviceId) {
      engineRef.current = null;
      return;
    }
    // 每个 (sessionId, deviceId) 绑定一个 engine;getTarget 返回本 effect 的常量,
    // dispose 退订的就是本次订阅的 topic(不受后续 session 切换影响)。
    const engine = createRemoteSessionSyncEngine(
      () => ({ sessionId, deviceId }),
      {
        subscribe: (d, topics) => {
          return window.electronAPI.deviceLink
            .subscribe(d, topics)
            .catch((err) => log.warn('device-link subscribe(session) failed', err));
        },
        unsubscribe: (d, topics) => {
          return window.electronAPI.deviceLink.unsubscribe(d, topics).catch(() => {});
        },
        reconcile: (s) => {
          // 挂起交互(permission/ask/plan)重建已并入 reconcileRemoteMessages 的同一代
          // (远程回执的新鲜度语义需要两者同代落地),这里不再单独调用。
          void makerChatStore.reconcileRemoteMessages(s);
        },
        refreshList: (d) => void refreshRemoteDeviceSessions(d, remoteProjectsStore.getDeviceName(d) ?? d),
        // ── stall 看门狗 deps(全套提供 → 启用)──
        getLastEventAt: (s) => makerChatStore.getLastInboundEventAt(s),
        isRunningNow: (s) => makerChatStore.getSnapshot(s).agentStatus.isRunning,
        queryTurnRunning: async (s) => {
          return isSessionTurnRunningFor(s);
        },
        finalize: (s) => {
          makerChatStore.finalizeStuckRemoteTurn(s);
        },
        reconcileForce: (s) => {
          makerChatStore.reconcileRemoteMessages(s, { force: true });
        },
        onSuspectStall: (s) => {
          setSuspectStall(true);
        },
        onRecovered: () => setSuspectStall(false),
      },
    );
    engineRef.current = engine;

    // mount:订阅重 topic;首拉由 ensureInitialMessages 负责,这里不立即对账(避免与首拉竞争)。
    engine.subscribeHeavy();
    // 用当前 turn 态初始化边沿检测(mount-mid-run 时不误把第一次 false 当 turn 结束)。
    engine.primeRunning(makerChatStore.getSnapshot(sessionId).agentStatus.isRunning);
    engine.startWatchdog();
    // 切回时如果 isRunning=true → 可能是切走期间 done 丢了 → 延迟核实被控端
    engine.reconcileOnMount();

    const offStatus = window.electronAPI.deviceLink.onStatusChanged((p) => {
      if (p.status !== 'online') return;
      engine.handleOnline();
    });
    const offPresence = window.electronAPI.deviceLink.onPresenceChanged((snap) => {
      engine.handlePresence(snap.deviceId, snap.online);
    });
    // 「设备无响应」熔断恢复(main 权威)→ 与 relay 上线同处理:重订阅 + 对账。
    // 熔断 open 期间本会话的订阅与消息拉取都被快速失败挡掉了,而 presence / relay
    // 状态全程没变、窗口可能一直聚焦、turn 也可能还在跑 —— 既有的四个对账触发点
    // (relay online / presence online / focus / turn 结束)一个都不会发生,恢复后
    // 视图会继续缺消息。连接类状态的恢复必须全自动,不能靠横幅按钮兜(review P2)。
    const offResponsiveness = window.electronAPI.deviceLink.onResponsivenessChanged((p) => {
      if (p.unresponsive) return;
      engine.handleResponsivenessRecovered(p.deviceId);
    });
    const offStore = makerChatStore.subscribe(sessionId, () => {
      const running = makerChatStore.getSnapshot(sessionId).agentStatus.isRunning;
      if (!running) setSuspectStall(false); // turn 结束(含被收尾)→ 收起兜底
      engine.handleRunningChange(running);
    });
    const onFocus = () => engine.handleFocus();
    window.addEventListener('focus', onFocus);

    return () => {
      offStatus();
      offPresence();
      offResponsiveness();
      offStore();
      window.removeEventListener('focus', onFocus);
      engine.dispose();
      engineRef.current = null;
    };
  }, [sessionId, deviceId]);

  return { resync, suspectStall, forceFinalize };
}
