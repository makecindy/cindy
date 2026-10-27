import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultVoiceInputSettings, type VoiceInputDataSnapshot } from '../../../shared/voiceInputData';
import * as mod from '../WebMicAudioEngine';
import * as pool from '../audioContextPool';

vi.mock('../audioContextPool', () => ({
  PCM16K_WORKLET_NAME: 'pcm16k-worklet',
  prewarmVoiceInputAudio: vi.fn(),
}));

type PowerCallback = (payload: { reason: 'system_suspend' | 'screen_locked' }) => void;

const WORKLET_URL = 'https://app.local/pcm16k-worklet.js';
const IDLE_TTL_MS = 30 * 60 * 1000;

type FakeTrack = MediaStreamTrack & { stopped: boolean };

function createFakeTrack(): FakeTrack {
  const track = {
    label: 'keep-alive microphone',
    enabled: true,
    muted: false,
    readyState: 'live',
    stopped: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ deviceId: 'default' }),
    stop: (): void => undefined,
  };
  track.stop = (): void => {
    track.stopped = true;
  };
  return track as unknown as FakeTrack;
}

/**
 * Load the engine once. Exercise its real power release and HMR disposal at
 * teardown so streams, use windows and subscriptions cannot leak across cases.
 */
describe('keep-alive microphone idle window', () => {
  let track: FakeTrack;
  let sink: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; gain: { value: number } };
  let destination: object;
  let powerCallback: PowerCallback | undefined;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    track = createFakeTrack();
    powerCallback = undefined;
    getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [track],
      getTracks: () => [track],
    }));
    sink = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
    destination = { connect: vi.fn(), disconnect: vi.fn() };

    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'default' }]),
        getUserMedia,
        addEventListener: vi.fn(),
      },
    });
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      electronAPI: {
        voiceInput: {
          onPowerStateChange: (callback: PowerCallback) => {
            powerCallback = callback;
            return () => undefined;
          },
        },
      },
    });
    vi.stubGlobal('AudioWorkletNode', vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      port: { close: vi.fn(), postMessage: vi.fn(), onmessage: null },
    })));

    vi.mocked(pool.prewarmVoiceInputAudio).mockResolvedValue({
      context: {
        currentTime: 0,
        state: 'running',
        destination,
        createGain: vi.fn(() => sink),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        resume: vi.fn(async () => undefined),
      } as unknown as AudioContext,
      workletReady: Promise.resolve(),
      workletUrl: WORKLET_URL,
    });
  });

  afterEach(async () => {
    powerCallback?.({ reason: 'screen_locked' });
    await mod.disposeVoiceInputAudioModuleForHmr();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases the warm microphone once the idle window elapses', async () => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);

    expect(track.stopped).toBe(true);
  });

  it('terminates a direct processor before closing its port on stop', async () => {
    const engine = new mod.WebMicAudioEngine({ workletUrl: WORKLET_URL, keepAlive: false });
    await engine.start();
    const worklet = vi.mocked(AudioWorkletNode).mock.results[0].value as AudioWorkletNode;
    await engine.stop();
    await engine.stop();

    const messages = vi.mocked(worklet.port.postMessage).mock;
    const disposalIndex = messages.calls.findIndex(([message]) => message.type === 'dispose');
    expect(messages.calls.filter(([message]) => message.type === 'dispose')).toHaveLength(1);
    expect(messages.invocationCallOrder[disposalIndex]).toBeLessThan(
      vi.mocked(worklet.port.close).mock.invocationCallOrder[0],
    );
    expect(track.stopped).toBe(true);
  });

  it('reuses a paused keep-alive processor and only terminates it at final disposal', async () => {
    const first = new mod.WebMicAudioEngine({ workletUrl: WORKLET_URL, keepAlive: true });
    await first.start();
    const worklet = vi.mocked(AudioWorkletNode).mock.results[0].value as AudioWorkletNode;
    await first.stop();
    expect(worklet.port.postMessage).not.toHaveBeenCalledWith({ type: 'dispose' });

    const second = new mod.WebMicAudioEngine({ workletUrl: WORKLET_URL, keepAlive: true });
    await second.start();
    expect(AudioWorkletNode).toHaveBeenCalledTimes(1);
    expect(worklet.port.postMessage).toHaveBeenLastCalledWith({
      type: 'setActive', active: true, reset: true,
    });
    await second.stop();
    await mod.disposeKeepAliveVoiceInputMicrophone('test_final_dispose');

    const messages = vi.mocked(worklet.port.postMessage).mock;
    const disposalIndex = messages.calls.findIndex(([message]) => message.type === 'dispose');
    expect(disposalIndex).toBeGreaterThanOrEqual(0);
    expect(messages.invocationCallOrder[disposalIndex]).toBeLessThan(
      vi.mocked(worklet.port.close).mock.invocationCallOrder[0],
    );
    expect(track.stopped).toBe(true);
  });

  it('does not open the microphone for a mount-time prewarm before any dictation', async () => {
    // Mounting a ChatInput or the overlay is bookkeeping, not use. The AudioContext
    // and worklet may warm up, but the capture device — and the OS privacy
    // indicator — must stay off until the user asks to dictate.
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('clears enable intent on a power release before the first capture', async () => {
    // Settings can enable fast activation before any capture engine is built.
    // That intent must already observe lock/suspend, or a later chat mount
    // would open the device after the user has walked away.
    mod.noteVoiceInputUse();
    expect(powerCallback).toBeDefined();
    powerCallback?.({ reason: 'screen_locked' });
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each([0, 60 * 1000])('does not relight the microphone %i ms after the idle release', async (delay) => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
    expect(track.stopped).toBe(true);
    getUserMedia.mockClear();

    // Past the window the user stopped dictating: remounting the ChatInput (a new
    // task, a settings change) must not start a fresh 30-minute window, otherwise
    // the indicator never goes out while the user just keeps working.
    await vi.advanceTimersByTimeAsync(delay);
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps the original deadline when the session is rebuilt late in the window', async () => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);

    // A devicechange released the warm session 29 minutes in. The next mount may
    // rebuild it, but the window still ends 30 minutes after the last dictation —
    // anchoring to "now" would keep the indicator lit until minute 59 for a user
    // who never spoke again.
    await mod.disposeKeepAliveVoiceInputMicrophone('devicechange');
    track.stopped = false;
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(59 * 1000);
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(2 * 1000);
    expect(track.stopped).toBe(true);
  });

  it('refreshes the window when a direct capture recording ends', async () => {
    mod.noteVoiceInputUse();
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

    const engine = new mod.WebMicAudioEngine({ workletUrl: WORKLET_URL, keepAlive: false });
    await engine.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await engine.stop();

    // 35 minutes after that recording *started*, but only 20 after it ended: the
    // window must have been refreshed by the stop, or fast activation would have
    // silently expired. The use timestamp used to move only on the
    // keep-alive-stays branch.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('keeps an existing warm microphone until 30 minutes after a direct recording ends', async () => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    const directTrack = createFakeTrack();
    getUserMedia.mockImplementationOnce(async () => ({
      getAudioTracks: () => [directTrack],
      getTracks: () => [directTrack],
    }));
    const engine = new mod.WebMicAudioEngine({ workletUrl: WORKLET_URL, keepAlive: false });
    await engine.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await engine.stop();
    expect(directTrack.stopped).toBe(true);

    // Cross the original warm session's deadline without remounting. Its
    // existing timer must follow the same last-use timestamp as future prewarm.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(track.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(track.stopped).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('reopens the warm microphone from a later mount inside the use window', async () => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // A devicechange released the warm session, but the user dictated moments
    // ago: the next mount may warm the new configuration right away.
    await mod.disposeKeepAliveVoiceInputMicrophone('devicechange');
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not replace a recording still awaiting microphone permission after 60 seconds', async () => {
    mod.noteVoiceInputUse();
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));
    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    void starting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    // A permission prompt has no fixed response deadline. A mount must neither
    // replace the owner's pending request nor cause a later cold fallback.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });
    await starting;
    expect(track.stopped).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it('warms on an enable broadcast but not on repeated or newly mounted settings snapshots', async () => {
    const { subscribeVoiceInputSettings } = await import('../../hooks/useVoiceInputSettings');
    let settings = { ...getDefaultVoiceInputSettings('darwin'), fastActivationEnabled: false };
    const listeners = new Set<(snapshot: VoiceInputDataSnapshot) => void>();
    Object.assign(window.electronAPI.voiceInput, {
      getDataSnapshot: () => ({ settings, history: [] }),
      onDataChanged: (listener: (snapshot: VoiceInputDataSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const warming: Promise<void>[] = [];
    const subscribe = () => subscribeVoiceInputSettings(() => {
      warming.push(mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL }));
    });
    const emit = async (enabled: boolean) => {
      settings = { ...settings, fastActivationEnabled: enabled };
      listeners.forEach((listener) => listener({ settings, history: [] } as VoiceInputDataSnapshot));
      await Promise.all(warming.splice(0));
    };
    let unsubscribe = subscribe();
    try {
      await emit(true);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
      expect(track.stopped).toBe(true);
      await emit(true);
      expect(getUserMedia).toHaveBeenCalledTimes(1);

      // A renderer subscribing after the switch is already on must not infer a
      // new activation from that initial snapshot or a history-only broadcast.
      unsubscribe();
      unsubscribe = subscribe();
      await emit(true);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      await emit(false);
      await emit(true);
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it('does not extend the idle window when prewarm re-asserts keep-alive intent', async () => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    // A ChatInput mounting (or an unrelated voice setting changing) 20 minutes
    // in must not buy the microphone another full window — that regression kept
    // the device open indefinitely on a machine the user was simply working in.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(track.stopped).toBe(true);
  });

  it('restarts the full window after real dictation ends', async () => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    await engine.start();
    await engine.stop();

    // 20 minutes into the previous window + 25 more: only a refreshed deadline
    // keeps the device alive here.
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(track.stopped).toBe(true);
  });

  it('releases the microphone when the machine suspends or the screen locks', async () => {
    mod.noteVoiceInputUse();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);

    expect(track.stopped).toBe(true);
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('stops a stream that arrives after the session was released mid-startup', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    mod.noteVoiceInputUse();
    const prewarming = mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    // Let start() reach the pending getUserMedia await.
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    // Screen locks while the device handshake is still in flight: dispose()
    // cannot stop a track that does not exist yet.
    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);

    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });
    await prewarming;

    // The late stream must not survive as an unreachable live microphone.
    expect(track.stopped).toBe(true);
  });

  it('does not fall back to a cold stream when startup is cancelled by a power release', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);
    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });

    // The release must surface as cancellation. Treating it as "keep-alive
    // unavailable" would fall through to the cold getUserMedia() path and open
    // a second stream *after* the lock event — with nothing left to close it.
    await expect(starting).rejects.toThrow(/disposed/i);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
  });

  it('keeps an in-flight recording when the microphone config changes', async () => {
    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    await engine.start();
    expect(track.stopped).toBe(false);

    // The user switches microphone in settings while still dictating. Rebuilding
    // the session now would stop the very track they are speaking into.
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL, deviceId: 'another-device' });

    expect(track.stopped).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // The new config is honoured once dictation actually ends.
    await engine.stop();
    expect(track.stopped).toBe(true);
  });

  it('rejects startup when a release lands during context resume', async () => {
    let resolveResume: () => void = () => undefined;
    const pool = await import('../audioContextPool');
    vi.mocked(pool.prewarmVoiceInputAudio).mockResolvedValue({
      context: {
        currentTime: 0,
        // A suspended shared context makes startup await resume() — the last
        // await before the session reports success.
        state: 'suspended',
        destination,
        createGain: vi.fn(() => sink),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        resume: vi.fn(() => new Promise<void>((resolve) => {
          resolveResume = () => resolve();
        })),
      } as unknown as AudioContext,
      workletReady: Promise.resolve(),
      workletUrl: WORKLET_URL,
    });

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'system_suspend' });
    await vi.advanceTimersByTimeAsync(0);
    resolveResume();

    // Reporting success here would hand the caller a session whose nodes were
    // already torn down: it emits no PCM and dies on the stall watchdog.
    await expect(starting).rejects.toThrow(/disposed/i);
    expect(track.stopped).toBe(true);
  });

  it('does not replace a session a recording is still starting on', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    mod.noteVoiceInputUse();
    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);

    // The recording has not reached activate() yet, so the session is not
    // "active" — but it is being started *for* that recording. A prewarm with a
    // different device must not send it down the replace path.
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL, deviceId: 'another-device' });

    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });
    await starting;

    expect(track.stopped).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('replaces a prewarm-only session when the config changes mid warm-up', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    mod.noteVoiceInputUse();
    const first = mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    await vi.advanceTimersByTimeAsync(0);

    // No recording is waiting on this background warm-up, so a config change
    // must actually swap it. Deferring here would strand the old device until
    // the idle timeout while the new one never gets warmed at all.
    const second = mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL, deviceId: 'default' });

    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });
    await first;
    await second;

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('reports cancellation when getUserMedia rejects after a release', async () => {
    let rejectStream: (error: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectStream = reject;
    }));

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'system_suspend' });
    await vi.advanceTimersByTimeAsync(0);

    // Suspending the machine typically makes the pending request reject rather
    // than resolve. That must still read as cancellation, not as a device
    // failure worth retrying with a fresh cold stream.
    rejectStream(Object.assign(new Error('The request is not allowed'), { name: 'AbortError' }));

    await expect(starting).rejects.toThrow(/disposed/i);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('interrupts an active recording when a power release disposes the session', async () => {
    const onInterrupted = vi.fn();
    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted,
    });
    await engine.start();

    powerCallback?.({ reason: 'system_suspend' });
    await vi.advanceTimersByTimeAsync(0);

    // Without this the renderer stays in 'listening' and main keeps owning the
    // ASR run until the audio watchdog fires — which during suspend does not
    // happen until the machine wakes up.
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
    // The UI stops the interrupted engine after the power notification. That
    // cleanup must not create a fresh use window when the window remounts.
    await engine.stop();
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('reports cancellation when the shared context fails after a release', async () => {
    let rejectPool: (error: unknown) => void = () => undefined;
    const pool = await import('../audioContextPool');
    vi.mocked(pool.prewarmVoiceInputAudio).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectPool = reject;
      }) as ReturnType<typeof pool.prewarmVoiceInputAudio>,
    );

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);
    // Suspend can make AudioContext/worklet init reject too, not just resolve.
    rejectPool(new Error('AudioContext unavailable'));

    await expect(starting).rejects.toThrow(/disposed/i);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('falls through to the cold path when a non-power release cancels startup', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);

    // Turning the setting off also releases the session — but the user is still
    // here and still dictating, so this must not abandon the attempt the way a
    // suspend/lock does.
    await mod.disposeKeepAliveVoiceInputMicrophone('setting_disabled');
    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });

    await starting;
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not let a second recording steal the keep-alive session', async () => {
    const engineA = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const engineB = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    await engineA.start();

    // A session carries exactly one PCM callback. B must not take it over — it
    // falls back to its own cold stream instead, leaving A's audio flowing.
    await engineB.start();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(track.stopped).toBe(false);
  });

  it('does not open the microphone when enumeration outlives a power release', async () => {
    let resolveEnumerate: (value: unknown) => void = () => undefined;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(() => new Promise((resolve) => {
          resolveEnumerate = resolve;
        })),
        getUserMedia,
        addEventListener: vi.fn(),
      },
    });

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      deviceId: 'specific-device',
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);
    // Enumeration succeeds *after* the release, reporting the device as present.
    resolveEnumerate([{ kind: 'audioinput', deviceId: 'specific-device' }]);

    await expect(starting).rejects.toThrow(/disposed/i);
    // The one-shot event has passed; nothing may reopen the device now.
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('does not report an error when a release hits a still-starting capture', async () => {
    let resolvePool: (value: unknown) => void = () => undefined;
    const pool = await import('../audioContextPool');
    vi.mocked(pool.prewarmVoiceInputAudio).mockReturnValue(
      new Promise((resolve) => {
        resolvePool = resolve as (value: unknown) => void;
      }) as ReturnType<typeof pool.prewarmVoiceInputAudio>,
    );
    const onInterrupted = vi.fn();

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      onInterrupted,
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);

    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);

    // The device must be closed, but a capture that never reached `ready` has
    // to surface as a silent cancellation: both UIs route onInterrupted to
    // their active-recording failure path, and that error would outlive the
    // cancellation that follows.
    expect(track.stopped).toBe(true);
    expect(onInterrupted).not.toHaveBeenCalled();

    resolvePool({
      context: {
        currentTime: 0,
        state: 'running',
        destination,
        createGain: vi.fn(() => sink),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        resume: vi.fn(async () => undefined),
      },
      workletReady: Promise.resolve(),
      workletUrl: WORKLET_URL,
    });
    await expect(starting).rejects.toThrow(/disposed/i);
  });

  it('can release a stream acquired before context warmup settles', async () => {
    let resolvePool: (value: unknown) => void = () => undefined;
    const pool = await import('../audioContextPool');
    vi.mocked(pool.prewarmVoiceInputAudio).mockReturnValue(
      new Promise((resolve) => {
        resolvePool = resolve as (value: unknown) => void;
      }) as ReturnType<typeof pool.prewarmVoiceInputAudio>,
    );

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    // getUserMedia has resolved; the shared context warmup is still pending and
    // could stay that way for the whole suspend.
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'system_suspend' });
    await vi.advanceTimersByTimeAsync(0);

    // The device is already open, so the release must reach it now rather than
    // waiting for warmup to settle.
    expect(track.stopped).toBe(true);

    resolvePool({
      context: {
        currentTime: 0,
        state: 'running',
        destination,
        createGain: vi.fn(() => sink),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        resume: vi.fn(async () => undefined),
      },
      workletReady: Promise.resolve(),
      workletUrl: WORKLET_URL,
    });
    await starting.catch(() => undefined);
  });

  it('reports cancellation when direct getUserMedia rejects after a release', async () => {
    let rejectStream: (error: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectStream = reject;
    }));

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'system_suspend' });
    await vi.advanceTimersByTimeAsync(0);
    // Suspend routinely makes the pending request reject rather than resolve.
    // That must read as cancellation, not as a device failure worth surfacing.
    rejectStream(Object.assign(new Error('The request is not allowed'), { name: 'AbortError' }));

    await expect(starting).rejects.toThrow(/disposed/i);
  });

  it('stops the direct stream when a later startup step fails', async () => {
    const pool = await import('../audioContextPool');
    vi.mocked(pool.prewarmVoiceInputAudio).mockResolvedValue({
      context: {
        currentTime: 0,
        state: 'suspended',
        destination,
        createGain: vi.fn(() => sink),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        resume: vi.fn(async () => {
          throw new Error('resume failed');
        }),
      } as unknown as AudioContext,
      workletReady: Promise.resolve(),
      workletUrl: WORKLET_URL,
    });

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      onInterrupted: vi.fn(),
    });

    // The device is already open by the time this step fails. Whether or not
    // the engine reached the registry, the failure path has to close it.
    await expect(engine.start()).rejects.toThrow(/resume failed/i);
    expect(track.stopped).toBe(true);
  });

  it('aborts a direct startup interrupted by a power release', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(powerCallback).toBeDefined();

    // The lock lands while the device handshake is still pending, so this
    // engine is not in the registry yet and the one-shot callback cannot see
    // it. Startup must abort itself rather than come up after the event.
    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);
    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });

    await expect(starting).rejects.toThrow(/disposed/i);
    expect(track.stopped).toBe(true);
  });

  it('stops a direct stream that arrives after an HMR swap', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);

    // Vite swaps the module while the device handshake is still pending. The
    // engine has not reached the registry, so releasing the registry alone
    // would let the stream arrive afterwards and open the microphone inside a
    // module whose power listener is already gone.
    await mod.disposeVoiceInputAudioModuleForHmr();
    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });

    await expect(starting).rejects.toThrow(/disposed/i);
    expect(track.stopped).toBe(true);
  });

  it('releases a direct capture stream on a power event', async () => {
    const onInterrupted = vi.fn();
    // fast activation off: this capture never touches the keep-alive session,
    // so only the direct-engine registry can close it on suspend/lock.
    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: false,
      onInterrupted,
    });
    await engine.start();
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'system_suspend' });
    await vi.advanceTimersByTimeAsync(0);

    expect(onInterrupted).toHaveBeenCalled();
    expect(track.stopped).toBe(true);
  });

  it('shares one startup between concurrent callers', async () => {
    let resolveStream: (value: unknown) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStream = resolve;
    }));

    // A recording start and a prewarm reach the same session while it is still
    // coming up. Each one re-entering start() would open a second MediaStream;
    // the first would then be overwritten by `this.stream` and never stopped.
    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    const starting = engine.start();
    await vi.advanceTimersByTimeAsync(0);
    const prewarming = mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    await vi.advanceTimersByTimeAsync(0);

    resolveStream({ getAudioTracks: () => [track], getTracks: () => [track] });
    await starting;
    await prewarming;

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps the audio output path detached while merely warm', async () => {
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    // Warm but idle: dictation needs the input path only. Staying connected to
    // the destination is what made a warm microphone also hold a CoreAudio
    // output stream for the whole window.
    expect(sink.connect).not.toHaveBeenCalled();

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    await engine.start();
    expect(sink.connect).toHaveBeenCalledWith(destination);

    await engine.stop();
    expect(sink.disconnect).toHaveBeenCalled();
  });
});
