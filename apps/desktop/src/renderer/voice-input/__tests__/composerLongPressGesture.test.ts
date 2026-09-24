import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInputState } from '@cindy/voice-input-core';
import {
  COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX,
  COMPOSER_LONG_PRESS_VOICE_INPUT_MS,
  createComposerLongPressVoiceGesture,
} from '../composerLongPressGesture';

const origin = { x: 100, y: 40 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function setup(initialState: VoiceInputState = 'idle') {
  let state: VoiceInputState = initialState;
  const start = vi.fn(async () => {
    state = 'listening';
  });
  const stop = vi.fn(async () => {
    state = 'done';
  });
  const gesture = createComposerLongPressVoiceGesture({
    getState: () => state,
    start,
    stop,
  });
  return {
    gesture,
    start,
    stop,
    getState: () => state,
    setState: (next: VoiceInputState) => {
      state = next;
    },
  };
}

describe('createComposerLongPressVoiceGesture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('按住不动到时长才开始录音，松开结束', async () => {
    const { gesture, start, stop, getState } = setup();

    gesture.press(origin);
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS - 1);
    await settle();
    expect(start).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await settle();
    expect(start).toHaveBeenCalledOnce();
    expect(getState()).toBe('listening');
    expect(gesture.isHolding()).toBe(true);

    gesture.release();
    await settle();
    expect(stop).toHaveBeenCalledOnce();
    expect(gesture.isHolding()).toBe(false);
  });

  it('没到时长就松开是普通点击，不录音', async () => {
    const { gesture, start, stop } = setup();

    gesture.press(origin);
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS / 2);
    gesture.release();
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();

    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('等待期间拖动超出容差视为选字，放弃长按', async () => {
    const { gesture, start } = setup();

    gesture.press(origin);
    gesture.move({ x: origin.x + COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX, y: origin.y });
    gesture.move({ x: origin.x + COMPOSER_LONG_PRESS_MOVE_TOLERANCE_PX + 1, y: origin.y });
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();

    expect(start).not.toHaveBeenCalled();
  });

  it('容差内的手抖不影响长按', async () => {
    const { gesture, start } = setup();

    gesture.press(origin);
    gesture.move({ x: origin.x + 2, y: origin.y - 2 });
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();

    expect(start).toHaveBeenCalledOnce();
  });

  it('语音输入已在进行时不接管按下', async () => {
    const { gesture, start } = setup('submitting');

    gesture.press(origin);
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();

    expect(start).not.toHaveBeenCalled();
  });

  it('开始流程还没走完就松开，等开始结束后再停', async () => {
    let state: VoiceInputState = 'idle';
    const startGate = deferred();
    const start = vi.fn(async () => {
      await startGate.promise;
      state = 'listening';
    });
    const stop = vi.fn(async () => {
      state = 'done';
    });
    const gesture = createComposerLongPressVoiceGesture({
      getState: () => state,
      start,
      stop,
    });

    gesture.press(origin);
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();
    expect(start).toHaveBeenCalledOnce();

    gesture.release();
    await settle();
    expect(stop).not.toHaveBeenCalled();

    startGate.resolve();
    await settle();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('录音被 Esc 取消后再松开不会重复停止', async () => {
    const { gesture, stop, setState } = setup();

    gesture.press(origin);
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();
    setState('idle');

    gesture.release();
    await settle();
    expect(stop).not.toHaveBeenCalled();
  });

  it('按住录音时销毁（关掉开关或卸载）会结束录音，之后不再响应', async () => {
    const { gesture, start, stop } = setup();

    gesture.press(origin);
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();
    gesture.dispose();
    await settle();
    expect(stop).toHaveBeenCalledOnce();

    gesture.press(origin);
    vi.advanceTimersByTime(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    await settle();
    expect(start).toHaveBeenCalledOnce();
  });
});
