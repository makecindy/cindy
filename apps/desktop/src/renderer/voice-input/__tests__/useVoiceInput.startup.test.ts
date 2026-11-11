// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PcmChunk } from '../WebMicAudioEngine';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';

const mocks = vi.hoisted(() => ({
  translate: (key: string) => key,
  settings: {
    language: 'auto',
    refinementEnabled: false,
    muteSystemAudio: true,
    fastActivationEnabled: false,
  },
  startEngine: vi.fn<() => Promise<void>>(),
  stopEngine: vi.fn(),
  drainEngine: vi.fn(),
  engines: [] as Array<{ emit: (chunk: PcmChunk) => void; keepAlive: boolean }>,
  prepareMicrophone: vi.fn(),
  releasePreparation: vi.fn(),
  promptExpired: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  useCodexSessionExpiredPrompt: () => mocks.promptExpired,
  isCodexSessionExpiredError: () => false,
}));
vi.mock('@/hooks/useVoiceInputSettings', () => ({
  useVoiceInputSettings: () => ({ settings: mocks.settings }),
  adviseAndRecordVoiceInputDictionaryLearning: vi.fn(),
}));
vi.mock('@/hooks/useVoiceInputHistory', () => ({
  recordVoiceInputHistory: () => null,
  updateVoiceInputHistoryEntry: vi.fn(),
}));
vi.mock('@/hooks/useVoiceInputUsageStats', () => ({
  recordVoiceInputUsage: vi.fn(),
  recordVoiceInputRefinementUsage: vi.fn(),
}));
vi.mock('../workletUrl', () => ({ getVoiceInputWorkletUrl: () => '' }));
vi.mock('../audioContextPool', () => ({
  prewarmVoiceInputAudio: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../WebMicAudioEngine', () => ({
  WebMicAudioEngine: class {
    emit = (_chunk: PcmChunk) => {};
    constructor(readonly options: { keepAlive: boolean }) {
      mocks.engines.push(this);
    }
    get keepAlive() {
      return this.options.keepAlive;
    }
    onPcm16k(callback: (chunk: PcmChunk) => void) {
      this.emit = callback;
    }
    start() {
      return mocks.startEngine();
    }
    async stop() {
      mocks.stopEngine();
    }
    async drainBufferedAudio() {
      mocks.drainEngine(this.emit);
    }
  },
  currentPowerReleaseGeneration: () => 0,
  isMicrophonePermissionDeniedError: (e: Error) => e.name === 'NotAllowedError',
  isPowerReleaseCancellation: () => false,
  isSelectedMicrophoneUnavailableError: () => false,
  isMicrophoneDeviceUnavailableError: () => false,
  powerReleaseCancellation: () => new Error('cancelled'),
  disposeKeepAliveVoiceInputMicrophone: vi.fn().mockResolvedValue(undefined),
  prewarmVoiceInputBenchmarkFixture: vi.fn().mockResolvedValue(undefined),
  prewarmVoiceInputMicrophoneWithAutomaticFallback: vi.fn().mockResolvedValue(undefined),
  prepareVoiceInputMicrophone: mocks.prepareMicrophone,
}));

import { useVoiceInput } from '../useVoiceInput';
import { START_CUE_CAPTURE_WAIT_MS } from '../startCue';
import {
  createComposerLongPressVoiceGesture,
  COMPOSER_LONG_PRESS_VOICE_INPUT_MS,
} from '../composerLongPressGesture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function chunk(index: number, amplitude = 512): PcmChunk {
  return {
    pcm16k: Int16Array.from({ length: 640 }, (_, i) => (i % 2 ? amplitude : -amplitude)).buffer,
    trace: {
      capturedAt: index * 40,
      convertedAt: index * 40,
      chunkIndex: index,
      sampleRate: 16000,
      durationMs: 40,
    },
  };
}

// useVoiceInput.start() 同步 claim 录音后立刻返回是否占用;启动流程(采集、授权
// 确认、连接)在后台继续,测试里捕获的 starting 是 claim 结果,启动收尾由 act
// 的刷新覆盖。
function mount() {
  const connection = deferred<{ ok: true; runId: string }>();
  const mute = deferred<{ ok: true }>();
  const permissionRequired = vi.fn();
  const api = {
    onEvent: vi.fn((_listener: (event: VoiceInputRendererEvent) => void) => vi.fn()),
    start: vi.fn(() => connection.promise),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    prewarm: vi.fn().mockResolvedValue(undefined),
    muteSystemAudio: vi.fn(() => mute.promise),
    restoreSystemAudio: vi.fn().mockResolvedValue({ ok: true }),
    appendAudio: vi.fn(),
    drainAudioQueue: vi.fn().mockResolvedValue({ ok: true }),
    setRendererMicrophonePermissionVerified: vi.fn().mockResolvedValue({ ok: true }),
    getMicrophonePermissionCached: vi.fn(() => ({ ok: false, status: 'unknown' })),
    getSystemPermissionsCached: vi.fn(() => ({ accessibility: { ok: true } })),
    getReadinessCached: vi.fn(() => ({ ok: true })),
    getReadiness: vi.fn().mockResolvedValue({ ok: true }),
  };
  vi.stubGlobal('electronAPI', { platform: 'darwin', voiceInput: api });
  const schema = new Schema({
    nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
  });
  const state = EditorState.create({ doc: schema.node('doc', null, [schema.node('paragraph')]) });
  const editor = {
    state,
    view: { state },
    isDestroyed: false,
    isEditable: true,
    commands: { focus: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
  const hook = renderHook(() =>
    useVoiceInput(editor, false, undefined, { onMicrophonePermissionRequired: permissionRequired }),
  );
  return { ...hook, api, connection, mute, permissionRequired };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.engines.length = 0;
  mocks.startEngine.mockReset().mockResolvedValue(undefined);
  mocks.stopEngine.mockReset();
  mocks.drainEngine.mockReset();
  mocks.promptExpired.mockReset();
  mocks.releasePreparation.mockReset();
  mocks.prepareMicrophone.mockReset().mockReturnValue(mocks.releasePreparation);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('local voice capture independent of startup checks and cloud', () => {
  it('keeps an authorized microphone closed through a short composer click', async () => {
    const h = mount();
    h.api.getMicrophonePermissionCached.mockReturnValue({ ok: true, status: 'granted' });
    h.api.prewarm.mockClear();
    const gesture = createComposerLongPressVoiceGesture({
      getState: () => h.result.current.state,
      prepare: () => h.result.current.prepare(),
      start: () => h.result.current.start(),
      stop: () => h.result.current.stop(),
    });
    gesture.press({ x: 0, y: 0 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPOSER_LONG_PRESS_VOICE_INPUT_MS - 1);
    });
    gesture.release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPOSER_LONG_PRESS_VOICE_INPUT_MS);
    });
    expect(h.api.prewarm).not.toHaveBeenCalled();
    // Opening even an authorized device can switch Bluetooth headphones to call audio.
    expect(mocks.prepareMicrophone).not.toHaveBeenCalled();
    expect(mocks.startEngine).not.toHaveBeenCalled();
    expect(h.api.muteSystemAudio).not.toHaveBeenCalled();
    expect(h.result.current.state).toBe('idle');
    expect(h.api.start).not.toHaveBeenCalled();
    expect(mocks.engines).toHaveLength(0);
    gesture.dispose();
  });

  it('opens the microphone only after the composer hold threshold', async () => {
    const h = mount();
    h.api.getMicrophonePermissionCached.mockReturnValue({ ok: true, status: 'granted' });
    h.api.prewarm.mockClear();
    const gesture = createComposerLongPressVoiceGesture({
      getState: () => h.result.current.state,
      prepare: () => h.result.current.prepare(),
      start: () => h.result.current.start(),
      stop: () => h.result.current.stop(),
    });
    gesture.press({ x: 0, y: 0 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPOSER_LONG_PRESS_VOICE_INPUT_MS - 1);
    });
    expect(h.api.prewarm).not.toHaveBeenCalled();
    expect(mocks.prepareMicrophone).not.toHaveBeenCalled();
    expect(mocks.startEngine).not.toHaveBeenCalled();
    expect(h.api.start).not.toHaveBeenCalled();
    await act(async () => {
      h.mute.resolve({ ok: true });
      h.connection.resolve({ ok: true, runId: 'held-composer' });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(h.api.prewarm).toHaveBeenCalledOnce();
    expect(mocks.startEngine).toHaveBeenCalledOnce();
    expect(mocks.engines[0].keepAlive).toBe(false);
    expect(h.result.current.state).toBe('listening');
    await act(async () => {
      gesture.release();
    });
    expect(mocks.stopEngine).toHaveBeenCalled();
    expect(h.result.current.state).toBe('done');
    gesture.dispose();
  });

  it('ends before the microphone produces its first frame and closes the late microphone', async () => {
    const h = mount();
    const device = deferred<void>();
    mocks.startEngine.mockReturnValue(device.promise);
    const endCue = vi.fn();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start();
    });
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.stop({ onReadyForEndCue: endCue });
    });
    expect(h.result.current.state).toBe('done');
    expect(endCue).toHaveBeenCalledOnce();
    expect(h.api.stop).not.toHaveBeenCalled();
    await act(async () => {
      device.resolve();
      h.connection.resolve({ ok: true, runId: 'late-mic' });
      await starting;
    });
    expect(mocks.stopEngine).toHaveBeenCalledTimes(2);
    expect(h.result.current.state).toBe('done');
  });

  it('keeps cloud-recognized text even when local PCM is below the silence threshold', async () => {
    const h = mount();
    await act(async () => {
      h.mute.resolve({ ok: true });
      h.connection.resolve({ ok: true, runId: 'quiet-text' });
      await h.result.current.start();
      mocks.engines[0].emit(chunk(0, 1));
    });
    act(() =>
      h.api.onEvent.mock.calls.at(-1)![0]({
        type: 'draft',
        runId: 'quiet-text',
        text: '很轻的一句话',
        source: 'partial',
        segment: {
          id: 'segment',
          source: 'mic',
          status: 'draft',
          text: '很轻的一句话',
          updatedAt: 0,
        },
      }),
    );
    let stopping!: Promise<void>;
    await act(async () => {
      stopping = h.result.current.stop();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
      await stopping;
    });
    expect(h.api.stop).toHaveBeenCalledOnce();
    expect(h.api.cancel).not.toHaveBeenCalled();
  });

  it('finishes silent capture without waiting for a pending cloud connection, and cancels a late run', async () => {
    const h = mount();
    const endCue = vi.fn();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start();
    });
    act(() => mocks.engines[0].emit(chunk(0, 0)));
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.stop({ onReadyForEndCue: endCue, waitForRefinement: true });
    });
    expect(h.result.current.state).toBe('done');
    expect(h.api.stop).not.toHaveBeenCalled();
    expect(h.api.appendAudio).not.toHaveBeenCalled();
    expect(h.api.restoreSystemAudio).toHaveBeenCalled();
    expect(endCue).toHaveBeenCalledOnce();
    await act(async () => {
      h.connection.resolve({ ok: true, runId: 'late-silent' });
      await starting;
    });
    expect(h.api.cancel).toHaveBeenCalledWith({ runId: 'late-silent' });
    expect(h.result.current.state).toBe('done');
  });

  it('skips ASR finalization for connected silence and resets detection for the next recording', async () => {
    const h = mount();
    await act(async () => {
      h.mute.resolve({ ok: true });
      h.connection.resolve({ ok: true, runId: 'run' });
      await h.result.current.start();
      mocks.engines[0].emit(chunk(0));
      await h.result.current.cancel();
      await h.result.current.start();
      mocks.engines[1].emit(chunk(0, 12));
      await h.result.current.stop();
    });
    expect(h.api.stop).not.toHaveBeenCalled();
    expect(h.api.cancel).toHaveBeenLastCalledWith({ runId: 'run' });
    expect(h.result.current.state).toBe('done');
  });

  it('preserves quiet sound present only in the final drained sub-chunk', async () => {
    const h = mount();
    await act(async () => {
      h.mute.resolve({ ok: true });
      h.connection.resolve({ ok: true, runId: 'tail' });
      await h.result.current.start();
      mocks.engines[0].emit(chunk(0, 0));
    });
    mocks.drainEngine.mockImplementationOnce((emit: (frame: PcmChunk) => void) =>
      emit(chunk(1, 40)),
    );
    let stopping!: Promise<void>;
    await act(async () => {
      stopping = h.result.current.stop();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
      await stopping;
    });
    expect(h.api.stop).toHaveBeenCalledOnce();
    expect(h.api.cancel).not.toHaveBeenCalled();
    expect(h.api.appendAudio).toHaveBeenLastCalledWith(chunk(1, 40));
  });

  // Regression, 2026-11-11: the cue used to start together with the microphone
  // request. Starting idle speakers delayed the first captured audio by about
  // 450 ms, so the cue now follows the first retained PCM.
  it('retains all 8 seconds while both cloud and system mute are pending; signals ready and plays the cue only after PCM', async () => {
    const h = mount();
    const cue = vi.fn();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start({ onStartFeedback: cue });
    });
    expect(mocks.startEngine).toHaveBeenCalledTimes(1);
    expect(cue).not.toHaveBeenCalled();
    expect(h.result.current.isCaptureReady).toBe(false);
    const frames = Array.from({ length: 200 }, (_, i) => chunk(i));
    await act(async () => {
      for (const frame of frames) mocks.engines[0].emit(frame);
    });
    expect(cue).toHaveBeenCalledTimes(1);
    expect(h.result.current.isCaptureReady).toBe(true);
    expect(h.api.appendAudio).not.toHaveBeenCalled();
    await act(async () => {
      h.connection.resolve({ ok: true, runId: 'run' });
      await starting;
    });
    expect(h.api.appendAudio.mock.calls.map(([frame]) => frame)).toEqual(frames);
    act(() => mocks.engines[0].emit(chunk(200)));
    expect(h.api.appendAudio).toHaveBeenLastCalledWith(chunk(200));
    h.mute.resolve({ ok: true });
  });

  it('starts local capture before a slow preflight, and stops it if preflight declines', async () => {
    const h = mount();
    const preflight = deferred<boolean>();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start({ beforeStart: () => preflight.promise });
    });
    expect(mocks.startEngine).toHaveBeenCalledTimes(1);
    expect(h.api.start).not.toHaveBeenCalled();
    // System mute touches the speakers too: without a cue it still waits for
    // the microphone, which has not produced a frame yet.
    expect(h.api.muteSystemAudio).not.toHaveBeenCalled();
    await act(async () => {
      h.mute.resolve({ ok: true });
      preflight.resolve(false);
      await starting;
    });
    expect(mocks.stopEngine).toHaveBeenCalled();
    expect(h.result.current.isBusy).toBe(false);
    expect(h.api.start).not.toHaveBeenCalled();
  });

  it('holds feedback and mute for the microphone, but only up to the cap when it is slow', async () => {
    const h = mount();
    const device = deferred<void>();
    mocks.startEngine.mockReturnValue(device.promise);
    const cue = vi.fn();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start({ onStartFeedback: cue });
    });
    expect(mocks.startEngine).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_CUE_CAPTURE_WAIT_MS - 1);
    });
    expect(cue).not.toHaveBeenCalled();
    expect(h.api.muteSystemAudio).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(cue).toHaveBeenCalledTimes(1);
    expect(h.api.muteSystemAudio).toHaveBeenCalledTimes(1);
    expect(h.result.current.isCaptureReady).toBe(false);
    await act(async () => {
      device.resolve();
      h.mute.resolve({ ok: true });
      h.connection.resolve({ ok: true, runId: 'slow-microphone' });
      await starting;
      mocks.engines[0].emit(chunk(0));
    });
    expect(h.api.appendAudio).toHaveBeenCalledExactlyOnceWith(chunk(0));
    expect(cue).toHaveBeenCalledTimes(1);
  });

  it('retains PCM during the start cue and mutes only after playback finishes', async () => {
    const h = mount();
    const cue = deferred<void>();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start({ onStartFeedback: () => cue.promise });
    });
    await act(async () => {
      mocks.engines[0].emit(chunk(0));
    });
    expect(h.api.muteSystemAudio).not.toHaveBeenCalled();
    await act(async () => {
      mocks.engines[0].emit(chunk(1));
      cue.resolve();
    });
    expect(h.api.muteSystemAudio).toHaveBeenCalledOnce();
    await act(async () => {
      h.connection.resolve({ ok: true, runId: 'run' });
      h.mute.resolve({ ok: true });
      await starting;
    });
    expect(h.api.appendAudio.mock.calls.map(([frame]) => frame)).toEqual([chunk(0), chunk(1)]);
  });

  it('closes a late microphone after cancellation, never plays the start cue and restores audio without waiting for the cap', async () => {
    const h = mount();
    const device = deferred<void>();
    mocks.startEngine.mockReturnValue(device.promise);
    const cue = vi.fn();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start({ onStartFeedback: cue });
    });
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.cancel();
    });
    await act(async () => {
      device.resolve();
      h.connection.resolve({ ok: true, runId: 'cancelled-run' });
      await starting;
      mocks.engines[0].emit(chunk(0));
    });
    expect(mocks.stopEngine).toHaveBeenCalledTimes(2);
    expect(cue).not.toHaveBeenCalled();
    expect(h.api.restoreSystemAudio).toHaveBeenCalledOnce();
    expect(h.api.appendAudio).not.toHaveBeenCalled();
    expect(h.result.current.isBusy).toBe(false);
    expect(h.api.cancel).toHaveBeenCalledWith({ runId: 'cancelled-run' });
  });

  it('uses the capture permission failure for recovery without a second microphone open', async () => {
    const h = mount();
    mocks.startEngine.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.start();
    });
    expect(mocks.startEngine).toHaveBeenCalledTimes(1);
    expect(h.permissionRequired).toHaveBeenCalled();
    expect(h.api.setRendererMicrophonePermissionVerified).toHaveBeenCalledWith(false);
    expect(h.result.current.isCaptureReady).toBe(false);
    h.connection.resolve({ ok: true, runId: 'failed-capture' });
  });

  it('preserves buffered opening audio when Stop is pressed before cloud connects', async () => {
    const h = mount();
    let starting!: boolean;
    await act(async () => {
      starting = h.result.current.start();
    });
    const frames = Array.from({ length: 25 }, (_, i) => chunk(i));
    act(() => {
      for (const frame of frames) mocks.engines[0].emit(frame);
    });
    let stopping!: Promise<void>;
    await act(async () => {
      h.mute.resolve({ ok: true });
      stopping = h.result.current.stop();
    });
    expect(h.result.current.isCaptureReady).toBe(false);
    expect(h.api.stop).not.toHaveBeenCalled();
    await act(async () => {
      h.connection.resolve({ ok: true, runId: 'stopped-before-connect' });
      await starting;
      await vi.advanceTimersByTimeAsync(1100);
      await stopping;
    });
    expect(h.api.appendAudio.mock.calls.map(([frame]) => frame)).toEqual(frames);
    expect(h.api.stop).toHaveBeenCalledTimes(1);
    expect(h.api.appendAudio.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.api.stop.mock.invocationCallOrder[0],
    );
    expect(h.result.current.isBusy).toBe(false);
  });

  it('ignores the old connection after cancel and immediate restart', async () => {
    const h = mount();
    let oldStart!: boolean;
    await act(async () => {
      oldStart = h.result.current.start();
    });
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.cancel();
    });
    const nextConnection = deferred<{ ok: true; runId: string }>();
    h.api.start.mockReturnValue(nextConnection.promise);
    let nextStart!: boolean;
    await act(async () => {
      nextStart = h.result.current.start();
    });
    const stopCount = mocks.stopEngine.mock.calls.length;
    await act(async () => {
      h.connection.resolve({ ok: true, runId: 'old' });
      await oldStart;
      mocks.engines[1].emit(chunk(0));
    });
    expect(mocks.stopEngine).toHaveBeenCalledTimes(stopCount);
    expect(h.result.current.isCaptureReady).toBe(true);
    await act(async () => {
      nextConnection.resolve({ ok: true, runId: 'new' });
      await nextStart;
    });
    expect(h.api.appendAudio).toHaveBeenCalledExactlyOnceWith(chunk(0));
  });

  // 测试价值：真实 useVoiceInput 连续 start/stop 后必须仍能停止当前麦克风。
  // 依据：2026-11-09 旧 done 把新输入置为 done，后续 start 覆盖仍在采集的 engine。
  // 缺口：已有 immediate-restart 测试只模拟旧 start 返回，没有旧 run 的 IPC 事件。
  // 最小输入：A stop → B start → A done → B start 返回 → B stop；另保留早到 auth。
  // tier: unit，mock 设备/IPC、假时钟；修复前定向墙钟 1.47s（16 过/1 失败）。
  it('ignores a cancelled run finishing while the next microphone is already open', async () => {
    const h = mount();
    await act(async () => { h.result.current.start(); });
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.stop();
    });
    const nextConnection = deferred<{ ok: true; runId: string }>();
    h.api.start.mockReturnValue(nextConnection.promise);
    await act(async () => { h.result.current.start(); });
    const stopCount = mocks.stopEngine.mock.calls.length;
    await act(async () => {
      // main can finish the cancelled connection after the next capture starts.
      h.connection.resolve({ ok: true, runId: 'old' });
    });
    act(() => {
      h.api.onEvent.mock.calls.at(-1)![0]({ type: 'state', runId: 'old', state: 'done' });
    });
    expect(h.result.current.state).toBe('listening');
    expect(mocks.stopEngine).toHaveBeenCalledTimes(stopCount);
    await act(async () => { nextConnection.resolve({ ok: true, runId: 'new' }); });
    expect(h.result.current.state).toBe('listening');
    await act(async () => { await h.result.current.stop(); });
    expect(mocks.stopEngine).toHaveBeenCalledTimes(stopCount + 1);
    expect(h.result.current.state).toBe('done');
  });

  it('delivers an early auth event only after the matching start owns the run', async () => {
    const h = mount();
    await act(async () => { h.result.current.start(); });
    act(() => {
      h.api.onEvent.mock.calls.at(-1)![0]({
        type: 'auth-required', runId: 'current', provider: 'codex', reason: 'expired',
      });
    });
    expect(mocks.promptExpired).not.toHaveBeenCalled();
    await act(async () => { h.connection.resolve({ ok: true, runId: 'current' }); });
    expect(mocks.promptExpired).toHaveBeenCalledExactlyOnceWith('expired');
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.cancel();
    });
  });

  it('cleans up local capture when readiness IPC rejects', async () => {
    const h = mount();
    h.api.getReadinessCached.mockReturnValue({ ok: false });
    h.api.getReadiness.mockRejectedValue(new Error('IPC unavailable'));
    await act(async () => {
      h.mute.resolve({ ok: true });
      await h.result.current.start();
    });
    expect(mocks.stopEngine).toHaveBeenCalled();
    expect(h.result.current.isCaptureReady).toBe(false);
    expect(h.result.current.isBusy).toBe(false);
    expect(h.api.start).not.toHaveBeenCalled();
  });
});
