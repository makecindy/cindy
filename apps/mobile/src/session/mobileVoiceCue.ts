import { createAudioPlayer } from 'expo-audio';

export type MobileVoiceCue = {
  fromFrequency: number;
  toFrequency: number;
  rampAt: number;
  duration: number;
  volume: number;
  bodyVolume: number;
  decayAt: number;
  attack: number;
  delay?: number;
};

const SAMPLE_RATE = 44_100;
const SILENCE_TAIL_SECONDS = 0.025;
// Fallback release if the player never reports completion (cue is ~0.3 s).
const CUE_RELEASE_TIMEOUT_MS = 3_000;
// Web Audio exponential ramps cannot start from 0; desktop starts and ends here.
const SILENT_GAIN = 0.0001;

// Same note and envelope as desktop apps/desktop/src/renderer/voice-input/startCue.ts:
// a soft attack, a round body, then a short bell-like decay.
export const MOBILE_VOICE_INTERACTION_NOTE: MobileVoiceCue = {
  fromFrequency: 880,
  toFrequency: 987.77,
  rampAt: 0.032,
  duration: 0.11,
  volume: 0.18,
  bodyVolume: 0.065,
  decayAt: 0.04,
  attack: 0.008,
};

// Desktop's end cue: repeat the note, then answer a minor third lower.
const LOWER_PITCH_RATIO = 2 ** (-3 / 12);
export const MOBILE_VOICE_END_CUES: readonly MobileVoiceCue[] = [
  MOBILE_VOICE_INTERACTION_NOTE,
  {
    ...MOBILE_VOICE_INTERACTION_NOTE,
    fromFrequency: MOBILE_VOICE_INTERACTION_NOTE.fromFrequency * LOWER_PITCH_RATIO,
    toFrequency: MOBILE_VOICE_INTERACTION_NOTE.toFrequency * LOWER_PITCH_RATIO,
    delay: 0.14,
  },
];

const END_CUE = buildCueDataUri(MOBILE_VOICE_END_CUES);

/**
 * Plays the optional end-of-dictation feedback, matching desktop's end cue.
 *
 * NOTE: there is intentionally NO start cue on mobile. Playing a cue through
 * expo-audio (`createAudioPlayer().play()`) re-activates the shared iOS
 * AVAudioSession, which silently stalls the concurrent AVAudioEngine capture tap
 * — the tap stops delivering PCM after ~300ms with no interruption / route /
 * configuration-change notification, so the recording captures nothing and the
 * ASR server times out waiting for packets. The end cue is safe because it only
 * plays after capture has stopped. Do NOT reintroduce a start cue through
 * expo-audio during capture; if start feedback is ever wanted, it must be played
 * natively in a way that does not touch the active record session.
 *
 * Audio feedback is intentionally best-effort: recording and transcription must
 * not depend on a platform accepting the generated data URI.
 */
export function playMobileVoiceInputEndCue(): void {
  playCue(END_CUE);
}

// Players stay referenced until playback ends. expo-audio tears the native
// player down when its JS object is garbage-collected; an unreferenced player
// could be collected mid-cue during the UI updates that follow stop, cutting
// the sound off after its first note.
const playingCues = new Set<{ release(): void }>();

function playCue(uri: string): void {
  try {
    const player = createAudioPlayer(uri);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { remove(): void } | undefined;
    const entry = {
      release() {
        if (!playingCues.delete(entry)) return;
        if (timer) clearTimeout(timer);
        subscription?.remove();
        try {
          player.release();
        } catch {
          // Already released.
        }
      },
    };
    playingCues.add(entry);
    subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish) entry.release();
    });
    timer = setTimeout(() => entry.release(), CUE_RELEASE_TIMEOUT_MS);
    player.play();
  } catch {
    // Optional feedback only.
  }
}

function buildCueDataUri(cues: readonly MobileVoiceCue[]): string {
  const duration = cues.reduce((max, cue) => Math.max(max, (cue.delay ?? 0) + cue.duration), 0)
    + SILENCE_TAIL_SECONDS;
  const sampleCount = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const samples = new Int16Array(sampleCount);
  for (const cue of cues) {
    mixCue(samples, cue);
  }
  return `data:audio/wav;base64,${encodeBase64(buildWav(samples))}`;
}

/** Gain at `t` seconds into a cue, reproducing desktop's exponential ramps. */
export function mobileVoiceCueGain(cue: MobileVoiceCue, t: number): number {
  const ramp = (from: number, to: number, start: number, end: number): number =>
    from * ((to / from) ** Math.min(1, Math.max(0, (t - start) / (end - start))));
  if (t < cue.attack) return ramp(SILENT_GAIN, cue.volume, 0, cue.attack);
  if (t < cue.decayAt) return ramp(cue.volume, cue.bodyVolume, cue.attack, cue.decayAt);
  return ramp(cue.bodyVolume, SILENT_GAIN, cue.decayAt, cue.duration);
}

function mixCue(samples: Int16Array, cue: MobileVoiceCue): void {
  const startSample = Math.max(0, Math.floor((cue.delay ?? 0) * SAMPLE_RATE));
  const durationSamples = Math.max(1, Math.floor(cue.duration * SAMPLE_RATE));
  const rampSamples = Math.max(1, Math.floor(cue.rampAt * SAMPLE_RATE));
  let phase = 0;

  for (let i = 0; i < durationSamples && startSample + i < samples.length; i += 1) {
    const frequencyProgress = Math.min(1, i / rampSamples);
    const frequency = cue.fromFrequency * ((cue.toFrequency / cue.fromFrequency) ** frequencyProgress);
    const envelope = mobileVoiceCueGain(cue, i / SAMPLE_RATE);
    phase += (2 * Math.PI * frequency) / SAMPLE_RATE;
    const next = samples[startSample + i] + Math.round(Math.sin(phase) * envelope * 32767);
    samples[startSample + i] = Math.max(-32768, Math.min(32767, next));
  }
}

function buildWav(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const sample of samples) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') return btoa(binary);
  return encodeBase64Binary(binary);
}

function encodeBase64Binary(binary: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let i = 0; i < binary.length; i += 3) {
    const byte1 = binary.charCodeAt(i);
    const byte2 = i + 1 < binary.length ? binary.charCodeAt(i + 1) : Number.NaN;
    const byte3 = i + 2 < binary.length ? binary.charCodeAt(i + 2) : Number.NaN;
    const triplet = (byte1 << 16)
      | ((Number.isNaN(byte2) ? 0 : byte2) << 8)
      | (Number.isNaN(byte3) ? 0 : byte3);
    output += alphabet[(triplet >> 18) & 0x3f];
    output += alphabet[(triplet >> 12) & 0x3f];
    output += Number.isNaN(byte2) ? '=' : alphabet[(triplet >> 6) & 0x3f];
    output += Number.isNaN(byte3) ? '=' : alphabet[triplet & 0x3f];
  }
  return output;
}
