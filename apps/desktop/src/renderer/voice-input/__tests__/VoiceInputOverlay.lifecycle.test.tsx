// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  prompt: () => false,
  settings: { language: 'auto', refinementEnabled: false, refinementInstructions: '', dictionaryEntries: [], muteSystemAudio: true, fastActivationEnabled: false, playInteractionSound: false, shortcut: '' },
  capture: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t, i18n: { language: 'en-US' } }) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({ useCodexSessionExpiredPrompt: () => mocks.prompt, isCodexSessionExpiredError: () => false }));
vi.mock('@/hooks/useCodexAuth', () => ({ useCodexAuth: () => ({ state: { kind: 'disconnected' } }), isChatGptConnectionConnected: () => false }));
vi.mock('@/hooks/useVoiceInputSettings', () => ({ getVoiceInputSettings: () => mocks.settings, subscribeVoiceInputSettings: () => () => {}, adviseAndRecordVoiceInputDictionaryLearning: vi.fn() }));
vi.mock('@/hooks/useVoiceInputHistory', () => ({ recordVoiceInputHistory: () => null, updateVoiceInputHistoryEntry: vi.fn() }));
vi.mock('@/hooks/useVoiceInputUsageStats', () => ({ recordVoiceInputUsage: vi.fn(), recordVoiceInputRefinementUsage: vi.fn() }));
vi.mock('../workletUrl', () => ({ getVoiceInputWorkletUrl: () => '' }));
vi.mock('../audioContextPool', () => ({ prewarmVoiceInputAudio: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../WebMicAudioEngine', () => ({ WebMicAudioEngine: class {}, disposeKeepAliveVoiceInputMicrophone: vi.fn().mockResolvedValue(undefined), isMicrophoneDeviceUnavailableError: () => false, isSelectedMicrophoneUnavailableError: () => false, prewarmVoiceInputBenchmarkFixture: vi.fn().mockResolvedValue(undefined), prewarmVoiceInputMicrophoneWithAutomaticFallback: vi.fn() }));
vi.mock('../captureSession', () => ({ startVoiceInputCaptureSession: mocks.capture }));
vi.mock('../startGuards', () => ({ requestRendererMicrophonePermission: vi.fn(), resolveVoiceInputStartGuards: async () => ({ ok: true, permission: { ok: true }, accessibility: { ok: true }, readiness: { ok: true } }) }));
vi.mock('../useVoiceInputOverlayDrag', () => ({ useVoiceInputOverlayDrag: () => ({}) }));
vi.mock('../VoiceInputMicWaveIcon', () => ({ VoiceInputMicWaveIcon: () => null }));

import { VoiceInputOverlay } from '../VoiceInputOverlay';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function draft(runId: string, text: string): VoiceInputRendererEvent {
  return { type: 'draft', runId, text, source: 'partial', segment: {
    id: `${runId}-segment`, source: 'mic', status: 'draft', text, updatedAt: 0,
  } };
}

function mount() {
  let command!: (value: { type: 'start' | 'submit' | 'cancel' }) => void;
  let receive!: (value: VoiceInputRendererEvent) => void;
  const engines: Array<{ stop: ReturnType<typeof vi.fn>; drainBufferedAudio: ReturnType<typeof vi.fn> }> = [];
  mocks.capture.mockImplementation(async (options) => {
    const engine = { stop: vi.fn().mockResolvedValue(undefined), drainBufferedAudio: vi.fn().mockResolvedValue(undefined) };
    engines.push(engine);
    options.setEngine(engine);
    // Model retained PCM so the real start-cue gate releases this recording's mute.
    options.onCaptureReady?.();
    options.onSoundDetected();
    return { ok: true, drainPendingChunks: vi.fn() };
  });
  let run = 0;
  const api = {
    onGlobalOverlayCommand: vi.fn((listener) => { command = listener; return () => {}; }),
    onEvent: vi.fn((listener) => { receive = listener; return () => {}; }),
    onDictionaryLearningEvidence: vi.fn(() => () => {}),
    notifyGlobalOverlayReady: vi.fn(), prewarm: vi.fn().mockResolvedValue(undefined),
    getReadiness: vi.fn().mockResolvedValue({ ok: true }), showGlobalOverlay: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockImplementation(async () => ({ ok: true, runId: `run-${++run}` })),
    stop: vi.fn().mockResolvedValue({ ok: true }), cancel: vi.fn().mockResolvedValue({ ok: true }),
    closeGlobalOverlay: vi.fn().mockResolvedValue({ ok: true }),
    muteSystemAudio: vi.fn().mockResolvedValue({ ok: true }), restoreSystemAudio: vi.fn().mockResolvedValue({ ok: true }),
    appendAudio: vi.fn(), drainAudioQueue: vi.fn().mockResolvedValue({ ok: true }),
    pasteIntoFocusedTarget: vi.fn().mockResolvedValue({ ok: true }),
  };
  vi.stubGlobal('electronAPI', { platform: 'darwin', voiceInput: api });
  const view = render(<VoiceInputOverlay />);
  return { ...view, api, engines, command: (type: 'start' | 'submit' | 'cancel') => command({ type }), receive: (event: VoiceInputRendererEvent) => receive(event) };
}

beforeEach(() => { vi.useFakeTimers(); mocks.capture.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('cached global overlay cancellation (#6656 / discussion_r4526952168)', () => {
  // Unit: the real overlay's native command/Escape/event entry points. Existing
  // source guards never render the cached window or delay provider replies.
  // Hardware capture/ASR are simulated; no Electron or OS audio claim is made.
  it('hides on Escape before a queued provider stop/cancel settles', async () => {
    const h = mount();
    const stop = deferred<{ ok: true }>();
    const cancel = deferred<{ ok: true }>();
    h.api.stop.mockReturnValue(stop.promise);
    h.api.cancel.mockReturnValue(cancel.promise);
    await act(async () => h.command('start'));
    await act(async () => h.command('submit'));
    expect(h.api.stop).toHaveBeenCalledOnce();
    await act(async () => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(h.api.closeGlobalOverlay).toHaveBeenCalledOnce();
    await act(async () => { stop.resolve({ ok: true }); cancel.resolve({ ok: true }); });
    expect(h.api.pasteIntoFocusedTarget).not.toHaveBeenCalled();
  });

  it('keeps a reopened recording isolated from old stop, audio restore and close acknowledgements', async () => {
    const h = mount();
    const stop = deferred<{ ok: true }>();
    const cancel = deferred<{ ok: true }>();
    const hidden = deferred<{ ok: true }>();
    const oldMute = deferred<{ ok: true }>();
    h.api.stop.mockReturnValueOnce(stop.promise);
    h.api.cancel.mockReturnValueOnce(cancel.promise);
    h.api.closeGlobalOverlay.mockReturnValueOnce(hidden.promise);
    h.api.muteSystemAudio.mockReturnValueOnce(oldMute.promise);
    await act(async () => h.command('start'));
    const oldRecording = h.api.start.mock.calls[0][0];
    await act(async () => h.command('submit'));
    await act(async () => h.command('cancel'));
    expect(h.api.closeGlobalOverlay).toHaveBeenCalledOnce();
    await act(async () => h.command('start'));
    expect(h.api.start).toHaveBeenCalledTimes(2);
    const newRecording = h.api.start.mock.calls[1][0];
    expect(oldRecording.recordingId).toEqual(expect.any(String));
    expect(newRecording.recordingId).not.toBe(oldRecording.recordingId);
    expect(h.api.muteSystemAudio).toHaveBeenLastCalledWith({ recordingId: newRecording.recordingId });
    await act(async () => { oldMute.resolve({ ok: true }); hidden.resolve({ ok: true }); stop.resolve({ ok: true }); cancel.resolve({ ok: true }); });
    await act(async () => {
      h.receive(draft('run-1', 'discarded old words'));
      h.receive({ type: 'state', runId: 'run-1', state: 'done' });
      h.receive(draft('run-2', 'new recording'));
    });
    expect(h.getByText('new recording')).toBeTruthy();
    await act(async () => {
      h.receive(draft('run-2', ''));
      h.receive({ type: 'error', runId: 'run-2', message: 'new recording failed' });
    });
    expect((h.getByRole('button', { name: 'voiceInputOverlay.retry' }) as HTMLButtonElement).disabled).toBe(false);
    expect(h.api.pasteIntoFocusedTarget).not.toHaveBeenCalled();
    expect(h.api.restoreSystemAudio.mock.calls.every(([owner]) => owner?.recordingId === oldRecording.recordingId)).toBe(true);
    await act(async () => h.command('cancel'));
    expect(h.api.restoreSystemAudio).toHaveBeenLastCalledWith({ recordingId: newRecording.recordingId });
  });

  it('hides during pending startup without waiting for device shutdown', async () => {
    const h = mount();
    const start = deferred<{ ok: true; runId: string }>();
    const shutdown = deferred<void>();
    h.api.start.mockReturnValueOnce(start.promise);
    await act(async () => h.command('start'));
    h.engines[0].stop.mockReturnValueOnce(shutdown.promise);
    await act(async () => h.command('cancel'));
    expect(h.api.closeGlobalOverlay).toHaveBeenCalledOnce();
    await act(async () => { start.resolve({ ok: true, runId: 'late-start' }); shutdown.resolve(); });
    expect(h.api.cancel).toHaveBeenCalledWith({ runId: 'late-start' });
    expect(h.api.pasteIntoFocusedTarget).not.toHaveBeenCalled();
  });

  it('closes and permits a fresh start even when provider cancellation rejects', async () => {
    const h = mount();
    const cancel = deferred<{ ok: true }>();
    h.api.cancel.mockReturnValueOnce(cancel.promise);
    await act(async () => h.command('start'));
    await act(async () => h.command('cancel'));
    expect(h.api.closeGlobalOverlay).toHaveBeenCalledOnce();
    await act(async () => cancel.reject(new Error('provider stop failed')));
    await act(async () => h.command('start'));
    expect(h.api.start).toHaveBeenCalledTimes(2);
  });

  // A cached window can reopen while its old show acknowledgement is pending.
  // Advancing fake time exposes an obsolete error-close timer without real waits.
  it('does not close a new recording when an old startup failure show acknowledges late', async () => {
    const h = mount();
    const shown = deferred<{ ok: true }>();
    h.api.start.mockResolvedValueOnce({ ok: false, error: 'provider failed' });
    h.api.showGlobalOverlay.mockReturnValueOnce(shown.promise);
    await act(async () => h.command('start'));
    expect(h.api.showGlobalOverlay).toHaveBeenCalledOnce();
    await act(async () => h.command('cancel'));
    expect(h.api.closeGlobalOverlay).toHaveBeenCalledOnce();
    await act(async () => h.command('start'));
    expect(h.api.start).toHaveBeenCalledTimes(2);
    await act(async () => { shown.resolve({ ok: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(h.api.closeGlobalOverlay).toHaveBeenCalledOnce();
  });
});
