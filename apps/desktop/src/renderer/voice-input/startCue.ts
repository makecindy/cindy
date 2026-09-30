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
