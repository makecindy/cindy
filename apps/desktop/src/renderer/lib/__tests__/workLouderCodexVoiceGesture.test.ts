import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInputState } from '@cindy/voice-input-core';
import { createWorkLouderCodexVoiceGesture } from '../workLouderCodexVoiceGesture';

const press = { phase: 'press' as const };
const release = { phase: 'release' as const };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('createWorkLouderCodexVoiceGesture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps recording after a short click', async () => {
    let state: VoiceInputState = 'idle';
    const start = vi.fn(async () => {
      state = 'listening';
    });
    const stop = vi.fn(async () => {
      state = 'done';
    });
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => state,
      start,
      stop,
    });

    gesture.handle(press);
    gesture.handle(release);
    await settle();

    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(state).toBe('listening');
  });

  it('stops on the next short click', async () => {
    let state: VoiceInputState = 'listening';
    const start = vi.fn();
    const stop = vi.fn(async () => {
      state = 'done';
    });
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => state,
      start,
      stop,
    });

    gesture.handle(press);
    gesture.handle(release);
    await settle();

    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(state).toBe('done');
  });

  it('stops when a long press is released', async () => {
    let state: VoiceInputState = 'idle';
    const start = vi.fn(async () => {
      state = 'listening';
    });
    const stop = vi.fn(async () => {
      state = 'done';
    });
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => state,
      start,
      stop,
    });

    gesture.handle(press);
    await vi.advanceTimersByTimeAsync(450);
    gesture.handle(release);
    await settle();

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(state).toBe('done');
  });

  it('stops after startup resolves when a long press was already released', async () => {
    let state: VoiceInputState = 'idle';
    const startGate = deferred<void>();
    const start = vi.fn(async () => {
      await startGate.promise;
      state = 'listening';
    });
    const stop = vi.fn(async () => {
      state = 'done';
    });
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => state,
      start,
      stop,
    });

    gesture.handle(press);
    await vi.advanceTimersByTimeAsync(450);
    gesture.handle(release);
    await settle();
    expect(stop).not.toHaveBeenCalled();

    startGate.resolve();
    await settle();

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(state).toBe('done');
  });

  it('does not depend on a React state-ref update after startup resolves', async () => {
    const startGate = deferred<void>();
    const start = vi.fn(async () => startGate.promise);
    const stop = vi.fn();
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => 'idle',
      start,
      stop,
    });

    gesture.handle(press);
    await vi.advanceTimersByTimeAsync(450);
    gesture.handle(release);
    startGate.resolve();
    await settle();

    expect(stop).toHaveBeenCalledOnce();
  });

  it('turns a second click into stop even while the first start is pending', async () => {
    let state: VoiceInputState = 'idle';
    const startGate = deferred<void>();
    const start = vi.fn(async () => {
      await startGate.promise;
      state = 'listening';
    });
    const stop = vi.fn(async () => {
      state = 'done';
    });
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => state,
      start,
      stop,
    });

    gesture.handle(press);
    gesture.handle(release);
    gesture.handle(press);
    gesture.handle(release);
    startGate.resolve();
    await settle();

    expect(stop).toHaveBeenCalledOnce();
  });

  it('ignores duplicate events and clears its timer on dispose', async () => {
    let state: VoiceInputState = 'idle';
    const start = vi.fn(async () => {
      state = 'listening';
    });
    const stop = vi.fn();
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => state,
      start,
      stop,
    });

    gesture.handle(press);
    gesture.handle(press);
    gesture.dispose();
    await vi.advanceTimersByTimeAsync(450);
    gesture.handle(release);
    await settle();

    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops a held long press when the owning composer loses focus', async () => {
    let state: VoiceInputState = 'idle';
    const start = vi.fn(async () => {
      state = 'listening';
    });
    const stop = vi.fn(async () => {
      state = 'done';
    });
    const gesture = createWorkLouderCodexVoiceGesture({
      longPressMs: 450,
      getState: () => state,
      start,
      stop,
    });

    gesture.handle(press);
    await vi.advanceTimersByTimeAsync(450);
    await settle();
    gesture.cancelHeldPress();
    await settle();

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(state).toBe('done');
  });
});
