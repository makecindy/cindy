let audioContext: AudioContext | null = null;

type VoiceInputCue = {
  fromFrequency: number;
  toFrequency: number;
  rampAt: number;
  duration: number;
  volume: number;
  bodyVolume: number;
  decayAt: number;
  delay?: number;
  attack?: number;
};

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

export function prepareVoiceInputCues(): void {
  try {
    getAudioContext();
  } catch {
    // Audio feedback is optional; recording must not depend on it.
  }
}

function playVoiceInputCue(cue: VoiceInputCue): Promise<void> {
  return new Promise((resolve) => {
    let oscillator: OscillatorNode | undefined;
    let gain: GainNode | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (oscillator) {
        oscillator.onended = null;
        try {
          oscillator.stop();
        } catch {
          /* Already ended or never started. */
        }
        oscillator.disconnect();
      }
      gain?.disconnect();
      resolve();
    };
    // A suspended audio context must not delay system mute indefinitely or
    // play a stale start cue when it eventually resumes.
    const timer = setTimeout(finish, Math.ceil(((cue.delay ?? 0) + cue.duration) * 1000) + 200);
    try {
      const context = getAudioContext();
      const startedAt = context.currentTime + 0.005 + (cue.delay ?? 0);
      const endedAt = startedAt + cue.duration;
      oscillator = context.createOscillator();
      gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(cue.fromFrequency, startedAt);
      oscillator.frequency.exponentialRampToValueAtTime(cue.toFrequency, startedAt + cue.rampAt);
      gain.gain.setValueAtTime(0.0001, startedAt);
      gain.gain.exponentialRampToValueAtTime(cue.volume, startedAt + (cue.attack ?? 0.01));
      // Keep a round, audible body after the soft attack, then a short bell-like
      // decay. One sine oscillator avoids harsh upper harmonics and extra nodes.
      gain.gain.exponentialRampToValueAtTime(cue.bodyVolume, startedAt + cue.decayAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, endedAt);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = finish;
      oscillator.start(startedAt);
      oscillator.stop(endedAt);
      if (context.state === 'suspended') void context.resume().catch(finish);
    } catch {
      // Feedback is optional. Never block capture or mute on a playback error.
      finish();
    }
  });
}

// Both cues use the same note, envelope and pitch gesture. The end cue repeats
// the start note, then answers a minor third lower.
const interactionNote: VoiceInputCue = {
  fromFrequency: 880,
  toFrequency: 987.77,
  rampAt: 0.032,
  duration: 0.11,
  volume: 0.18,
  bodyVolume: 0.065,
  decayAt: 0.04,
  attack: 0.008,
};

export function playVoiceInputStartCue(): Promise<void> {
  return playVoiceInputCue(interactionNote);
}

/**
 * Longest the start cue waits for the microphone. An uncontended microphone
 * opens in roughly 60-110 ms; one slower than this cap gets the cue at the cap
 * rather than an open-ended wait.
 */
export const START_CUE_CAPTURE_WAIT_MS = 300;

export type StartCueGate = {
  /**
   * Settles exactly once: `true` when the cue should play (capture is retaining
   * audio, or the cap elapsed), `false` when the attempt ended first.
   */
  released: Promise<boolean>;
  /** Capture is retaining audio: play the cue now. */
  release: () => void;
  /** The attempt ended (stopped, cancelled or failed): settle without a cue. */
  abandon: () => void;
};

/**
 * Holds speaker-side startup work (the start cue, then system mute) until the
 * microphone is open.
 *
 * Started together, the microphone opens behind the speaker work. On speakers
 * that had gone idle (the browser releases a silent output after about 30 s)
 * that delayed real captured audio from about 0.6 s to about 1.0 s after the
 * trigger; with the microphone first it opens as fast as it does alone.
 * Measurements: the 2026-11-11 section of
 * docs/voice-optimization-summary-2026-09-25.md.
 *
 * Every path that ends an attempt must call `abandon()`: otherwise a start
 * that fails or is cancelled before capture is ready keeps mute and restore
 * waiting for the cap.
 */
export function createStartCueGate(waitMs = START_CUE_CAPTURE_WAIT_MS): StartCueGate {
  let settle!: (play: boolean) => void;
  const released = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), waitMs);
    settle = (play) => {
      clearTimeout(timer);
      resolve(play);
    };
  });
  return { released, release: () => settle(true), abandon: () => settle(false) };
}

export function playVoiceInputEndCue(): void {
  // Schedule both immediately; playback never gates recognition or capture.
  void playVoiceInputCue(interactionNote);
  const lowerPitchRatio = 2 ** (-3 / 12);
  void playVoiceInputCue({
    ...interactionNote,
    fromFrequency: interactionNote.fromFrequency * lowerPitchRatio,
    toFrequency: interactionNote.toFrequency * lowerPitchRatio,
    delay: 0.14,
  });
}
