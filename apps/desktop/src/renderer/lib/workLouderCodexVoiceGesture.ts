import type { VoiceInputState } from '@cindy/voice-input-core';

export type WorkLouderPushToTalkAction = {
  phase: 'press' | 'release';
};

export type WorkLouderCodexVoiceGestureOptions = {
  longPressMs: number;
  getState: () => VoiceInputState;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
};

type Press = {
  stopOnRelease: boolean;
  longPress: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const isIdleLike = (state: VoiceInputState): boolean =>
  state === 'idle' || state === 'done' || state === 'error';

/**
 * Bridges a Work Louder press/release pair to the composer's microphone
 * semantics:
 *
 * - a short press starts and stays recording;
 * - a later short press stops;
 * - a long press stops when released.
 *
 * `start` is asynchronous. A long-release (or a click-to-stop made while
 * startup is still in flight) is therefore remembered and applied after the
 * start promise settles. This is intentionally independent from React so the
 * event stream can survive renderer rerenders while a key is held.
 */
export function createWorkLouderCodexVoiceGesture(options: WorkLouderCodexVoiceGestureOptions): {
  handle(action: WorkLouderPushToTalkAction): void;
  cancelHeldPress(): void;
  dispose(): void;
} {
  let press: Press | null = null;
  let startPromise: Promise<void> | null = null;
  let stopAfterStart = false;
  let stopInFlight = false;
  let disposed = false;

  const clearPressTimer = (current: Press | null = press): void => {
    if (current?.timer === null) return;
    if (current?.timer !== undefined) clearTimeout(current.timer);
    if (current) current.timer = null;
  };

  const requestStop = (): void => {
    if (disposed) return;
    if (options.getState() !== 'listening') {
      if (startPromise) stopAfterStart = true;
      return;
    }
    if (stopInFlight) return;
    stopInFlight = true;
    void Promise.resolve()
      .then(() => options.stop())
      .catch(() => undefined)
      .finally(() => {
        stopInFlight = false;
      });
  };

  const requestStopAfterStart = (): void => {
    if (disposed || stopInFlight) return;
    stopInFlight = true;
    void Promise.resolve()
      .then(() => options.stop())
      .catch(() => undefined)
      .finally(() => {
        stopInFlight = false;
      });
  };

  const observeStart = (currentStart: Promise<void>): void => {
    void currentStart
      .then(() => {
        if (disposed || startPromise !== currentStart || !stopAfterStart) return;
        stopAfterStart = false;
        // `useVoiceInput.start()` flips its internal state synchronously, but
        // ChatInput's mirrored state ref updates on the next React effect. Do
        // not wait for that render: `stop()` has its own authoritative ref and
        // already coordinates a stop that lands at the end of startup.
        requestStopAfterStart();
      })
      .catch(() => {
        if (startPromise === currentStart) stopAfterStart = false;
      })
      .finally(() => {
        if (startPromise === currentStart) startPromise = null;
      });
  };

  const handlePress = (): void => {
    if (disposed || press || stopAfterStart) return;

    const state = options.getState();
    if (state === 'listening') {
      press = { stopOnRelease: true, longPress: false, timer: null };
      return;
    }
    if (!isIdleLike(state)) return;

    // A second click can arrive before the first asynchronous start has
    // resolved. Treat it as the composer's click-to-stop gesture rather than
    // starting a second run.
    if (startPromise) {
      press = { stopOnRelease: true, longPress: false, timer: null };
      return;
    }

    const current: Press = { stopOnRelease: false, longPress: false, timer: null };
    current.timer = setTimeout(() => {
      current.timer = null;
      if (press === current) current.longPress = true;
    }, options.longPressMs);
    press = current;

    const currentStart = Promise.resolve().then(() => options.start());
    startPromise = currentStart;
    observeStart(currentStart);
  };

  const handleRelease = (): void => {
    if (disposed || !press) return;
    const current = press;
    clearPressTimer(current);
    press = null;
    if (current.stopOnRelease || current.longPress) requestStop();
  };

  const cancelHeldPress = (): void => {
    if (disposed || !press) return;
    const current = press;
    clearPressTimer(current);
    press = null;
    stopAfterStart = Boolean(startPromise);
    if (current.stopOnRelease || current.longPress || startPromise) requestStop();
  };

  return {
    handle(action) {
      if (action.phase === 'press') handlePress();
      else handleRelease();
    },
    cancelHeldPress,
    dispose() {
      disposed = true;
      clearPressTimer();
      press = null;
      stopAfterStart = false;
    },
  };
}
