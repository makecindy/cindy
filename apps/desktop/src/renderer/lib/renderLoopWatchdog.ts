import { createLogger } from '@/lib/logger';

const log = createLogger('render-watchdog');

/**
 * 渲染循环看门狗 —— 专为「睡醒白屏/黑屏」取证(2026-07-12/13 连续复现):
 * 窗口可见、renderer 进程活着,却长时间画不出一帧,现有日志(render-process-gone /
 * ErrorBoundary / foreground-recovery)全部沉默,无法区分「主线程卡死」还是
 * 「帧管线停摆」。本模块用两种互补手段把停顿变成日志:
 *
 * 1. 定时器漂移检测 —— setInterval 每 tick 对比期望与实际触发时刻,漂移超阈值
 *    说明这段时间 renderer 主线程被同步阻塞过(事后追认,卡死自愈的场景)。
 *    系统睡眠也会产生大漂移,靠 main 侧 power-diagnostics 的 suspend/resume
 *    日志时间戳交叉排除。
 * 2. rAF 探针 —— 页面可见时每 tick 发一个 requestAnimationFrame,超时未回调
 *    且页面与原生窗口均未报告隐藏时记告警。它只证明回调超时,不能证明画面
 *    全黑或 GPU 故障。每个 episode 只记一次,回调恢复时再记一条。
 *
 * 性能:仅一个 5s 间隔的 timer + 可见时每 5s 一个一次性 rAF,无常驻动画、
 * 无每帧回调,不违反设计规范规则 7。
 */
const CHECK_INTERVAL_MS = 5_000;
/** interval 实际触发晚于期望超过该值,视为主线程曾被阻塞,记一条日志。 */
const TIMER_STALL_THRESHOLD_MS = 3_000;
/** 可见状态下 rAF 超过该时长未回调,记录探针超时。 */
const FRAME_PROBE_TIMEOUT_MS = 2_000;

const RENDER_LOOP_WATCHDOG_DISPOSER_KEY = '__xdtRenderLoopWatchdogDisposer';

/** 注入面,让单测能用假 timer / 假 rAF / 假 visibilityState 驱动。 */
export interface RenderLoopWatchdogTarget {
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  window: Pick<Window, 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'> & {
    requestAnimationFrame: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame: (id: number) => void;
    __xdtRenderLoopWatchdogDisposer?: () => void;
    // HMR 不会触发 main 的 did-finish-load 基线补发,保留最近一次原生状态。
    __xdtRenderLoopWatchdogNativeState?: { hidden: boolean; receivedAt: number };
    electronAPI?: {
      onWindowHiddenChange?: (callback: (hidden: boolean) => void) => () => void;
    };
  };
  now: () => number;
}

function defaultTarget(): RenderLoopWatchdogTarget {
  return { document, window, now: () => Date.now() };
}

export function installRenderLoopWatchdog(
  target: RenderLoopWatchdogTarget = defaultTarget(),
): () => void {
  target.window[RENDER_LOOP_WATCHDOG_DISPOSER_KEY]?.();

  let lastTickAt = target.now();
  const isVisible = (): boolean =>
    target.document.visibilityState === 'visible' &&
    target.window.__xdtRenderLoopWatchdogNativeState?.hidden !== true;
  const diagnosticContext = () => ({
    observedAt: target.now(),
    documentVisibility: target.document.visibilityState,
    nativeHidden: target.window.__xdtRenderLoopWatchdogNativeState?.hidden ?? null,
    nativeStateReceivedAt: target.window.__xdtRenderLoopWatchdogNativeState?.receivedAt ?? null,
  });
  // 转入可见后的第一个 tick 不判漂移:该 tick 的实际触发时刻仍由隐藏期节流
  // 调度决定,漂移不反映可见期主线程状态。
  let skipNextDriftCheck = false;
  // 帧探针状态机:idle → probing → (回调→idle | 超时→stalled)。stalled 期间
  // 不再重复报警,直到某次探针成功回调才记恢复并回 idle。
  let probeState: 'idle' | 'probing' | 'stalled' = 'idle';
  let stalledSinceMs: number | null = null;
  let probeRafId: number | null = null;
  let probeTimeoutId: number | null = null;

  const clearProbe = (): void => {
    if (probeRafId !== null) {
      target.window.cancelAnimationFrame(probeRafId);
      probeRafId = null;
    }
    if (probeTimeoutId !== null) {
      target.window.clearTimeout(probeTimeoutId);
      probeTimeoutId = null;
    }
  };

  const onProbeFrame = (): void => {
    probeRafId = null;
    if (probeTimeoutId !== null) {
      target.window.clearTimeout(probeTimeoutId);
      probeTimeoutId = null;
    }
    if (probeState === 'stalled' && stalledSinceMs !== null) {
      log.warn('动画帧回调恢复', {
        ...diagnosticContext(),
        probeStartedAt: stalledSinceMs,
        stalledDurationMs: Math.max(0, Math.round(target.now() - stalledSinceMs)),
      });
    }
    probeState = 'idle';
    stalledSinceMs = null;
  };

  const onProbeTimeout = (probeStartedAt: number): void => {
    probeTimeoutId = null;
    // 超时瞬间页面已隐藏的话不算停摆 —— 隐藏页 rAF 本来就不触发。
    if (!isVisible()) {
      clearProbe();
      probeState = 'idle';
      stalledSinceMs = null;
      return;
    }
    if (probeState === 'probing') {
      probeState = 'stalled';
      stalledSinceMs = probeStartedAt;
      log.warn('可见状态下动画帧探针超时', {
        ...diagnosticContext(),
        probeStartedAt,
        probeTimeoutMs: FRAME_PROBE_TIMEOUT_MS,
      });
    }
  };

  const startProbe = (): void => {
    // 已有在途探针(含 stalled 后留下的 rAF,它一回调就是恢复信号)就不再叠加。
    if (probeRafId !== null || !isVisible()) return;
    const startedAt = target.now();
    if (probeState === 'idle') probeState = 'probing';
    probeRafId = target.window.requestAnimationFrame(onProbeFrame);
    if (probeState === 'probing') {
      probeTimeoutId = target.window.setTimeout(
        () => onProbeTimeout(startedAt),
        FRAME_PROBE_TIMEOUT_MS,
      );
    }
  };

  const onTick = (): void => {
    const now = target.now();
    const driftMs = now - lastTickAt - CHECK_INTERVAL_MS;
    lastTickAt = now;
    // 隐藏期不判漂移 —— 主窗 backgroundThrottling 开着,页面隐藏超 5 分钟后
    // Chromium intensive throttling 会把 interval 压到每分钟一次,漂移是预期
    // 行为,判了就是整夜刷屏的假告警。可见期的漂移才是「主线程曾被阻塞」信号。
    const shouldCheckDrift = !skipNextDriftCheck && isVisible();
    skipNextDriftCheck = false;
    if (driftMs >= TIMER_STALL_THRESHOLD_MS && shouldCheckDrift) {
      // 事后追认:这段时间要么主线程被同步阻塞,要么系统在睡眠(与 main 侧
      // power-diagnostics 的 resume 时间戳对照区分)。
      log.warn('renderer 定时器漂移(主线程曾阻塞或系统睡眠)', {
        ...diagnosticContext(),
        driftMs: Math.round(driftMs),
      });
    }
    startProbe();
  };

  const onVisibilityChange = (): void => {
    if (isVisible()) {
      // 隐藏期的节流漂移不能记到下个可见 tick 头上,重置漂移基准并跳过下个
      // tick 的漂移判定(它的触发时刻仍是节流期排的)。
      lastTickAt = target.now();
      skipNextDriftCheck = true;
      // 切回前台立即探一次,不等下个 tick —— 睡醒白屏窗口期通常远短于 5s tick。
      startProbe();
    } else {
      clearProbe();
      probeState = 'idle';
      stalledSinceMs = null;
    }
  };

  const intervalId = target.window.setInterval(onTick, CHECK_INTERVAL_MS);
  target.document.addEventListener('visibilitychange', onVisibilityChange);
  const unsubscribeWindowHidden = target.window.electronAPI?.onWindowHiddenChange?.((hidden) => {
    target.window.__xdtRenderLoopWatchdogNativeState = { hidden, receivedAt: target.now() };
    onVisibilityChange();
  });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    target.window.clearInterval(intervalId);
    target.document.removeEventListener('visibilitychange', onVisibilityChange);
    unsubscribeWindowHidden?.();
    clearProbe();
    if (target.window[RENDER_LOOP_WATCHDOG_DISPOSER_KEY] === dispose) {
      delete target.window[RENDER_LOOP_WATCHDOG_DISPOSER_KEY];
    }
  };
  target.window[RENDER_LOOP_WATCHDOG_DISPOSER_KEY] = dispose;
  return dispose;
}
