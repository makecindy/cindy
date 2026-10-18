// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';

import { useAskUserDictation } from '../components/new-chat/useAskUserDictation';

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
    vi.unstubAllGlobals();
  });

  it('writes the submitted transcript into the answer and applies an unedited refinement', async () => {
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

    expect(hook.result.current.start()).toBe(true);
    await waitFor(() => expect(onEvent).toBeTypeOf('function'));
    onEvent?.({
      type: 'draft',
      runId: 'run-1',
      text: '补充',
      source: 'partial',
      segment: { id: 'seg-1', text: '补充', source: 'partial', status: 'partial', updatedAt: 1 },
    } as unknown as VoiceInputRendererEvent);
    await waitFor(() => expect(hook.result.current.liveText).toBe('已有补充'));

    onEvent?.({
      type: 'submitted',
      runId: 'run-1',
      text: '补充',
      segment: { id: 'seg-1', text: '补充', basedOnText: '补充', source: 'stable', status: 'final', updatedAt: 2 },
    } as unknown as VoiceInputRendererEvent);
    await waitFor(() => expect(setText).toHaveBeenCalledWith('已有补充'));

    onEvent?.({
      type: 'refined',
      runId: 'run-1',
      text: '补充说明',
      segment: { id: 'seg-1', text: '补充说明', basedOnText: '补充', source: 'stable', status: 'final', updatedAt: 3 },
      range: { segmentIds: ['seg-1'], start: 2, end: 4 },
    } as unknown as VoiceInputRendererEvent);
    await waitFor(() => expect(text).toBe('已有补充说明'));
  });
});
