import type { VoiceInputState } from '@cindy/voice-input-core';

/** 在输入框里按住鼠标左键多久才开始语音输入。 */
export const COMPOSER_LONG_PRESS_VOICE_INPUT_MS = 600;
/** 等待期间指针移动超过这个距离即视为在拖选文字，放弃本次长按。 */
export const COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX = 4;

export type ComposerLongPressPoint = { x: number; y: number };

export type ComposerLongPressVoiceGestureOptions = {
  holdMs?: number;
  moveTolerancePx?: number;
  getState: () => VoiceInputState;
  /**
   * 开始录音。返回 `false` 表示这次没有占用录音（已在录音、被取消等），
   * 调用方不得再对当前会话执行 `stop()`。
   */
  start: () => boolean | void | Promise<boolean | void>;
  stop: () => void | Promise<void>;
  /** 已过时长、真正开始按住录音时。用来补指针捕获，好在窗口外松开。 */
  onHoldStart?: () => void;
  /** 松开、放弃或销毁时。用来释放指针捕获。 */
  onHoldEnd?: () => void;
};

export type ComposerLongPressVoiceGesture = {
  /** 左键按下：开始计时。按键、修饰键与命中目标由调用方过滤。 */
  press(point: ComposerLongPressPoint): void;
  move(point: ComposerLongPressPoint): void;
  /**
   * 松开、失焦、开始拖拽都走这里：没到时长就当普通点击放弃；已经开始录音则结束
   * 录音，文字照常填回输入框。
   */
  release(): void;
  /** 是否正按住录音（已过时长、还没松开）。 */
  isHolding(): boolean;
  dispose(): void;
};

type PendingPress = {
  origin: ComposerLongPressPoint;
  timer: ReturnType<typeof setTimeout>;
};

const isIdleLike = (state: VoiceInputState): boolean =>
  state === 'idle' || state === 'done' || state === 'error';

/**
 * 输入框长按语音输入手势（微信式「按住说话」）：
 *
 * - 按住不动达到 `holdMs` 才开始录音，之前松开或移动都不影响普通点击与选字；
 * - 开始后松开即结束录音。
 *
 * `start` 可能先走授权确认再占用麦克风：松开时若已经在 listening 就立刻停；
 * 若还在确认中，等这次 start 确认占用成功后再停，避免误停别人后来开的录音。
 * 独立于 React，按住期间的重渲染不会打断它。
 */
export function createComposerLongPressVoiceGesture(
  options: ComposerLongPressVoiceGestureOptions,
): ComposerLongPressVoiceGesture {
  const holdMs = options.holdMs ?? COMPOSER_LONG_PRESS_VOICE_INPUT_MS;
  const moveTolerancePx = options.moveTolerancePx ?? COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX;
  let pending: PendingPress | null = null;
  let holding = false;
  let startPromise: Promise<boolean> | null = null;
  let stopAfterStart = false;
  let ownedSession = false;
  let stopInFlight = false;
  let disposed = false;
  let startGeneration = 0;

  const clearPending = (): void => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  const endHold = (): void => {
    if (!holding) return;
    holding = false;
    options.onHoldEnd?.();
  };

  const runStop = (): void => {
    if (stopInFlight) return;
    stopInFlight = true;
    ownedSession = false;
    void Promise.resolve()
      .then(() => options.stop())
      .catch(() => undefined)
      .finally(() => {
        stopInFlight = false;
      });
  };

  const requestStop = (): void => {
    if (startPromise) {
      // 授权确认还没结束：记下，等这次 start 占用成功后再停。
      // 占用成功后（stateRef 已是 listening、bootstrap 可能还在跑）由
      // useVoiceInput.stop() 立刻进入停止流程，不必等麦克风 / WebSocket 就绪。
      stopAfterStart = true;
      return;
    }
    // start 已结束：只停这次长按占用、且现在仍在听的录音。Esc 取消后
    // getState 已不是 listening，不能再 stop。
    if (!ownedSession || options.getState() !== 'listening') return;
    runStop();
  };

  const beginVoiceInput = (): void => {
    pending = null;
    if (disposed || !isIdleLike(options.getState())) return;
    holding = true;
    options.onHoldStart?.();
    const generation = ++startGeneration;
    const currentStart = Promise.resolve()
      .then(() => options.start())
      .then((claimed) => claimed !== false)
      .catch(() => false);
    startPromise = currentStart;
    void currentStart.then((claimed) => {
      if (startPromise !== currentStart) return;
      startPromise = null;
      if (generation !== startGeneration) return;
      ownedSession = claimed;
      if (!stopAfterStart) return;
      stopAfterStart = false;
      if (claimed) runStop();
    });
  };

  const release = (): void => {
    clearPending();
    if (!holding) return;
    endHold();
    requestStop();
  };

  return {
    press(point) {
      if (disposed || pending || holding || startPromise) return;
      if (!isIdleLike(options.getState())) return;
      pending = {
        origin: point,
        timer: setTimeout(beginVoiceInput, holdMs),
      };
    },
    move(point) {
      if (!pending) return;
      const dx = point.x - pending.origin.x;
      const dy = point.y - pending.origin.y;
      if (dx * dx + dy * dy > moveTolerancePx * moveTolerancePx) clearPending();
    },
    release,
    isHolding: () => holding,
    dispose() {
      // 关掉开关或卸载时如果正按住录音，按松开处理，麦克风不能一直开着。
      release();
      disposed = true;
    },
  };
}
