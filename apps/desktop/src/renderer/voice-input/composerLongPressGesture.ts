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
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
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
 * `start` 是异步的：开始流程还没走完就松开时，先记下，等开始结束后再停，避免录音
 * 在没有按住的情况下一直开着。独立于 React，按住期间的重渲染不会打断它。
 */
export function createComposerLongPressVoiceGesture(
  options: ComposerLongPressVoiceGestureOptions,
): ComposerLongPressVoiceGesture {
  const holdMs = options.holdMs ?? COMPOSER_LONG_PRESS_VOICE_INPUT_MS;
  const moveTolerancePx = options.moveTolerancePx ?? COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX;
  let pending: PendingPress | null = null;
  let holding = false;
  let startPromise: Promise<void> | null = null;
  let stopAfterStart = false;
  let stopInFlight = false;
  let disposed = false;

  const clearPending = (): void => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  const runStop = (): void => {
    if (stopInFlight) return;
    stopInFlight = true;
    void Promise.resolve()
      .then(() => options.stop())
      .catch(() => undefined)
      .finally(() => {
        stopInFlight = false;
      });
  };

  const requestStop = (): void => {
    // ChatInput 的状态 ref 要等下一次渲染才变成 listening；开始流程还在跑时
    // 直接 stop 会被当成空操作，所以挂到开始结束之后。
    if (startPromise) {
      stopAfterStart = true;
      return;
    }
    if (options.getState() !== 'listening') return;
    runStop();
  };

  const beginVoiceInput = (): void => {
    pending = null;
    if (disposed || !isIdleLike(options.getState())) return;
    holding = true;
    const currentStart = Promise.resolve().then(() => options.start());
    startPromise = currentStart;
    void currentStart
      .catch(() => undefined)
      .finally(() => {
        if (startPromise !== currentStart) return;
        startPromise = null;
        if (!stopAfterStart) return;
        stopAfterStart = false;
        runStop();
      });
  };

  const release = (): void => {
    clearPending();
    if (!holding) return;
    holding = false;
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
