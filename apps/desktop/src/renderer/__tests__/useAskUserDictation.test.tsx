// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';

import { useAskUserDictation } from '../components/new-chat/useAskUserDictation';
import { resolveVoiceInputStartGuards } from '@/voice-input/startGuards';
import { startVoiceInputCaptureSession } from '@/voice-input/captureSession';

vi.mock('@/voice-input/startGuards', () => ({
  resolveVoiceInputStartGuards: vi.fn(async () => ({
    ok: true,
    permission: { ok: true, status: 'granted' },
    readiness: { ok: true },
  })),
}));

vi.mock('@/voice-input/captureSession', () => ({
  startVoiceInputCaptureSession: vi.fn(async (options: { setEngine: (engine: unknown) => void }) => {
    options.setEngine({
      drainBufferedAudio: async () => undefined,
      stop: async () => undefined,
    });
    return { ok: true, drainPendingChunks: () => undefined };
  }),
}));

vi.mock('@/voice-input/startCue', () => ({
  prepareVoiceInputCues: vi.fn(),
  playVoiceInputStartCue: vi.fn(async () => undefined),
  playVoiceInputEndCue: vi.fn(),
}));

vi.mock('@/voice-input/workletUrl', () => ({
  getVoiceInputWorkletUrl: () => '/worklet.js',
}));

describe('useAskUserDictation', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // Unit: real hook, delayed readiness/IPC. Existing coverage only delivered
  // transcripts after startup; it missed lost opening words and late captures
  // continuing after Escape/unmount in the question answer field. PR #7438:
  // submitting before startup settles must also unlock when cancelled.
  it.each(['cancel', 'unmount'] as const)('captures before readiness and ignores a late service start after %s', async (action) => {
    let onEvent: ((event: VoiceInputRendererEvent) => void) | undefined;
    let check!: (value: Awaited<ReturnType<typeof resolveVoiceInputStartGuards>>) => void;
    vi.mocked(resolveVoiceInputStartGuards).mockImplementationOnce(() => new Promise((resolve) => { check = resolve; }));
    let connected!: (value: { ok: true; runId: string }) => void;
    const cancel = vi.fn(async () => ({ ok: true }));
    const start = vi.fn(() => new Promise((resolve) => { connected = resolve; }));
    const setText = vi.fn();
    window.electronAPI = {
      platform: 'darwin',
      voiceInput: {
        onEvent: (callback: typeof onEvent) => { onEvent = callback; return () => { onEvent = undefined; }; },
        getDataSnapshot: () => ({ settings: { playInteractionSound: false, muteSystemAudio: false, refinementEnabled: false, dictionaryEntries: [], language: 'auto', refinementInstructions: '' } }),
        getHistoryForRefinement: () => [],
        start, cancel, drainAudioQueue: async () => ({ ok: true }),
      },
    } as unknown as typeof window.electronAPI;
    const hook = renderHook(() => useAskUserDictation({
      getText: () => '已有回答', setText,
      getSelection: () => ({ start: 2, end: 2 }), focus: () => {},
    }));
    act(() => { hook.result.current.start(); });
    expect(startVoiceInputCaptureSession).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    await act(async () => { check({ ok: true, permission: { ok: true, status: 'granted' }, readiness: { ok: true } } as Awaited<ReturnType<typeof resolveVoiceInputStartGuards>>); });
    expect(start).toHaveBeenCalledOnce();
    act(() => onEvent?.({ type: 'draft', runId: 'late-run', text: '未提交语音', source: 'partial' } as VoiceInputRendererEvent));
    expect(hook.result.current.liveText).toBe('已有未提交语音回答');
    let stopped: boolean | undefined;
    await act(async () => { void hook.result.current.stop().then((ok) => { stopped = ok; }); });
    expect(stopped).toBeUndefined();
    if (action === 'cancel') {
      await act(async () => { await hook.result.current.cancel(); });
      expect(hook.result.current.isBusy).toBe(false);
      expect(hook.result.current.liveText).toBeNull();
    } else {
      hook.unmount();
    }
    await act(async () => {});
    expect(stopped).toBe(false);
    await act(async () => { connected({ ok: true, runId: 'late-run' }); });
    act(() => onEvent?.({ type: 'submitted', runId: 'late-run', text: '迟到的结果' } as VoiceInputRendererEvent));
    expect(cancel).toHaveBeenCalledWith({ runId: 'late-run' });
    expect(setText).not.toHaveBeenCalled();
    hook.unmount();
  });

  // PR #7438, unit: cancel during a pending stop must not allow a new take
  // until that IPC settles. Startup-cancel tests never reached this phase.
  it.each(['success', 'failure', 'reject'] as const)('keeps the stop lock through cancellation and ignores a late %s', async (outcome) => {
    let onEvent: ((event: VoiceInputRendererEvent) => void) | undefined;
    let settleStop!: (value: { ok: true } | { ok: false; error: string }) => void;
    let rejectStop!: (error: Error) => void;
    let run = 0;
    const start = vi.fn(async () => ({ ok: true, runId: `run-${++run}` }));
    const stop = vi.fn(() => new Promise<{ ok: true } | { ok: false; error: string }>((resolve, reject) => {
      settleStop = resolve;
      rejectStop = reject;
    }));
    const setText = vi.fn();
    window.electronAPI = {
      platform: 'darwin',
      voiceInput: {
        onEvent: (callback: typeof onEvent) => { onEvent = callback; return () => { onEvent = undefined; }; },
        getDataSnapshot: () => ({ settings: { playInteractionSound: false, muteSystemAudio: false, refinementEnabled: false, dictionaryEntries: [], language: 'auto', refinementInstructions: '' } }),
        getHistoryForRefinement: () => [],
        start, stop, cancel: async () => ({ ok: true }), drainAudioQueue: async () => ({ ok: true }),
      },
    } as unknown as typeof window.electronAPI;
    const hook = renderHook(() => useAskUserDictation({
      getText: () => '已有', setText,
      getSelection: () => ({ start: 2, end: 2 }), focus: () => {},
    }));
    await act(async () => { expect(hook.result.current.start()).toBe(true); });
    let stopping!: Promise<boolean>;
    await act(async () => { stopping = hook.result.current.stop(); });
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => { await hook.result.current.cancel(); });
    expect(hook.result.current.isBusy).toBe(false);
    act(() => { expect(hook.result.current.start()).toBe(false); });
    expect(start).toHaveBeenCalledOnce();
    await act(async () => {
      if (outcome === 'reject') rejectStop(new Error('old stop failed'));
      else settleStop(outcome === 'success' ? { ok: true } : { ok: false, error: 'old stop failed' });
      expect(await stopping).toBe(false);
    });
    expect(hook.result.current.state).toBe('idle');
    expect(hook.result.current.lastError).toBeNull();
    await act(async () => { expect(hook.result.current.start()).toBe(true); });
    expect(start).toHaveBeenCalledTimes(2);
    act(() => onEvent?.({ type: 'state', runId: 'run-1', state: 'error' } as VoiceInputRendererEvent));
    expect(hook.result.current.state).toBe('listening');
    act(() => onEvent?.({ type: 'draft', runId: 'run-2', text: '新回答', source: 'partial' } as VoiceInputRendererEvent));
    expect(hook.result.current.liveText).toBe('已有新回答');
    expect(setText).not.toHaveBeenCalled();
    hook.unmount();
  });

  it.each(['done', 'error'] as const)('keeps the final text and reports terminal %s to the submitter', async (terminal) => {
    let onEvent: ((event: VoiceInputRendererEvent) => void) | undefined;
    let text = '已有';
    const setText = vi.fn((value: string) => { text = value; });
    window.electronAPI = {
      platform: 'darwin',
      voiceInput: {
        onEvent: (callback: typeof onEvent) => {
          onEvent = callback;
          return () => { onEvent = undefined; };
        },
        getDataSnapshot: () => ({ settings: { shortcut: null, playInteractionSound: false, muteSystemAudio: false, refinementEnabled: false, language: 'auto', fastActivationEnabled: false, microphoneDeviceId: null, dictionaryEntries: [], refinementInstructions: '' } }),
        start: async () => ({ ok: true, runId: 'run-1' }),
        stop: async () => ({ ok: true }),
        cancel: async () => ({ ok: true }),
        appendAudio: () => undefined,
        drainAudioQueue: async () => ({ ok: true }),
        muteSystemAudio: async () => ({ ok: true }),
        restoreSystemAudio: async () => ({ ok: true }),
        recordHistory: () => 'hist-1',
        updateHistoryEntry: () => undefined,
        getHistoryForRefinement: () => [],
      },
    } as unknown as typeof window.electronAPI;

    const hook = renderHook(() => useAskUserDictation({
      getText: () => text,
      setText,
      getSelection: () => ({ start: text.length, end: text.length }),
      focus: () => undefined,
    }));

    act(() => expect(hook.result.current.start()).toBe(true));
    await waitFor(() => expect(onEvent).toBeTypeOf('function'));
    act(() => onEvent?.({
      type: 'draft',
      runId: 'run-1',
      text: '补充',
      source: 'partial',
      segment: { id: 'seg-1', text: '补充', source: 'partial', status: 'partial', updatedAt: 1 },
    } as unknown as VoiceInputRendererEvent));
    await waitFor(() => expect(hook.result.current.liveText).toBe('已有补充'));

    act(() => onEvent?.({
      type: 'submitted',
      runId: 'run-1',
      text: '补充',
      segment: { id: 'seg-1', text: '补充', basedOnText: '补充', source: 'stable', status: 'final', updatedAt: 2 },
    } as unknown as VoiceInputRendererEvent));
    await waitFor(() => expect(setText).toHaveBeenCalledWith('已有补充'));

    // #6785, unit: an IPC acknowledgement alone is not a completed answer.
    // The final refinement may arrive later; submit must await the terminal event.
    let completed = false;
    let stopping!: Promise<boolean>;
    await act(async () => {
      stopping = hook.result.current.stop().then((ok) => { completed = true; return ok; });
    });
    expect(completed).toBe(false);
    expect(hook.result.current.state).toBe('submitting');
    act(() => onEvent?.({ type: 'state', runId: 'run-1', state: 'listening' } as VoiceInputRendererEvent));
    expect(hook.result.current.state).toBe('submitting');

    act(() => onEvent?.({
      type: 'refined',
      runId: 'run-1',
      text: '补充说明',
      segment: { id: 'seg-1', text: '补充说明', basedOnText: '补充', source: 'stable', status: 'final', updatedAt: 3 },
      range: { segmentIds: ['seg-1'], start: 2, end: 4 },
    } as unknown as VoiceInputRendererEvent));
    await waitFor(() => expect(text).toBe('已有补充说明'));
    expect(completed).toBe(false);
    act(() => onEvent?.({ type: 'state', runId: 'run-1', state: terminal } as VoiceInputRendererEvent));
    await expect(stopping).resolves.toBe(terminal === 'done');
    expect(text).toBe('已有补充说明');
  });
});
