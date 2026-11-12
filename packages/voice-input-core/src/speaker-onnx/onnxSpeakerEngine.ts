import { SPEAKER_GATE_SAMPLE_RATE, SPEAKER_GATE_VAD_FRAME, type SpeakerGateEngine } from '../SpeakerGate';
import type { SpeakerEnrollmentEngine } from '../speakerEnrollment';
import { computeKaldiFbank, KALDI_FBANK_DIM, subtractFbankMean } from './kaldiFbank';

export type OnnxTensor = {
  data: Float32Array;
  dims: number[];
};

/**
 * Runs one of the two speaker models with float32 tensors. Mobile implements
 * it with onnxruntime in a native module; tests use onnxruntime-node.
 */
export interface SpeakerOnnxRunner {
  run(model: 'vad' | 'embedding', inputs: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
}

/**
 * VAD settings, identical to the desktop worker's sherpa-onnx config so both
 * platforms gate the same audio the same way.
 */
const VAD = {
  threshold: 0.5,
  minSpeechSamples: 0.25 * SPEAKER_GATE_SAMPLE_RATE,
  minSilenceSamples: 0.25 * SPEAKER_GATE_SAMPLE_RATE,
  maxSpeechSamples: 20 * SPEAKER_GATE_SAMPLE_RATE,
  // Applied once one utterance exceeds maxSpeechSamples, as sherpa-onnx does.
  longThreshold: 0.9,
  longMinSilenceSamples: 0.1 * SPEAKER_GATE_SAMPLE_RATE,
} as const;

const LSTM_STATE_DIMS = [2, 1, 64];
const LSTM_STATE_SIZE = 2 * 64;

/**
 * Port of sherpa-onnx's SileroVadModel (k2-fsa export: inputs x/h/c) and
 * VoiceActivityDetector, frame for frame. `push` takes exactly one 512-sample
 * frame and reports whether speech is currently detected, the same flag the
 * desktop worker reads with `isDetected()` after each frame.
 */
export class SileroVadDetector {
  private h = new Float32Array(LSTM_STATE_SIZE);
  private c = new Float32Array(LSTM_STATE_SIZE);
  // SileroVadModel state.
  private triggered = false;
  private currentSample = 0;
  private tempStart = 0;
  private tempEnd = 0;
  private threshold: number = VAD.threshold;
  private minSilenceSamples: number = VAD.minSilenceSamples;
  // VoiceActivityDetector state: absolute sample indices of its ring buffer.
  private head = 0;
  private tail = 0;
  private start = -1;
  private readonly segments: Array<[number, number]> = [];

  constructor(private readonly runner: SpeakerOnnxRunner) {}

  reset(): void {
    this.h = new Float32Array(LSTM_STATE_SIZE);
    this.c = new Float32Array(LSTM_STATE_SIZE);
    this.triggered = false;
    this.currentSample = 0;
    this.tempStart = 0;
    this.tempEnd = 0;
    this.head = 0;
    this.tail = 0;
    this.start = -1;
    this.segments.length = 0;
  }

  get detected(): boolean {
    return this.start !== -1;
  }

  /** Finished speech segments as [start, end) absolute sample indices. */
  takeSegments(): Array<[number, number]> {
    return this.segments.splice(0);
  }

  async push(frame: Float32Array): Promise<boolean> {
    if (frame.length !== SPEAKER_GATE_VAD_FRAME) throw new Error(`VAD frame must be ${SPEAKER_GATE_VAD_FRAME} samples`);
    if (this.tail - this.head > VAD.maxSpeechSamples) {
      this.minSilenceSamples = VAD.longMinSilenceSamples;
      this.threshold = VAD.longThreshold;
    } else {
      this.minSilenceSamples = VAD.minSilenceSamples;
      this.threshold = VAD.threshold;
    }

    this.tail += SPEAKER_GATE_VAD_FRAME;
    const isSpeech = this.isSpeech(await this.probability(frame));

    if (isSpeech) {
      if (this.start === -1) {
        this.start = Math.max(this.tail - 2 * SPEAKER_GATE_VAD_FRAME - VAD.minSpeechSamples, this.head);
      }
    } else {
      if (this.start !== -1 && this.tail > this.head) {
        const end = this.tail - this.minSilenceSamples;
        this.segments.push([this.start, end]);
        this.head = end;
      }
      if (this.start === -1) {
        const end = this.tail - 2 * SPEAKER_GATE_VAD_FRAME - VAD.minSpeechSamples;
        this.head += Math.max(0, end - this.head);
      }
      this.start = -1;
    }
    return this.detected;
  }

  /** Closes an open segment at the end of input. */
  flush(): void {
    if (this.start === -1 || this.tail === this.head) return;
    if (this.tail <= this.start) return;
    this.segments.push([this.start, this.tail]);
    this.head = this.tail;
    this.start = -1;
  }

  private async probability(frame: Float32Array): Promise<number> {
    const out = await this.runner.run('vad', {
      x: { data: frame, dims: [1, SPEAKER_GATE_VAD_FRAME] },
      h: { data: this.h, dims: LSTM_STATE_DIMS },
      c: { data: this.c, dims: LSTM_STATE_DIMS },
    });
    this.h = Float32Array.from(out.new_h.data);
    this.c = Float32Array.from(out.new_c.data);
    return out.prob.data[0];
  }

  private isSpeech(prob: number): boolean {
    const threshold = this.threshold;
    this.currentSample += SPEAKER_GATE_VAD_FRAME;
    if (prob > threshold && this.tempEnd !== 0) this.tempEnd = 0;
    if (prob > threshold && this.tempStart === 0) {
      // Speech must last minSpeechSamples before it counts.
      this.tempStart = this.currentSample;
      return false;
    }
    if (prob > threshold && this.tempStart !== 0 && !this.triggered) {
      if (this.currentSample - this.tempStart < VAD.minSpeechSamples) return false;
      this.triggered = true;
      return true;
    }
    if (prob < threshold && !this.triggered) {
      this.tempStart = 0;
      this.tempEnd = 0;
      return false;
    }
    const negThreshold = Math.max(threshold - 0.15, 0.01);
    if (prob > negThreshold && this.triggered) return true;
    if (prob > threshold && !this.triggered) {
      this.triggered = true;
      return true;
    }
    if (prob < threshold && this.triggered) {
      if (this.tempEnd === 0) this.tempEnd = this.currentSample;
      if (this.currentSample - this.tempEnd < this.minSilenceSamples) return true;
      this.tempStart = 0;
      this.tempEnd = 0;
      this.triggered = false;
      return false;
    }
    return false;
  }
}

/** Speaker embedding of 16 kHz samples, null when the clip is too short. */
export async function computeSpeakerEmbedding(
  runner: SpeakerOnnxRunner,
  samples: Float32Array,
): Promise<Float32Array | null> {
  const features = computeKaldiFbank(samples);
  if (features.numFrames === 0) return null;
  subtractFbankMean(features);
  const out = await runner.run('embedding', {
    x: { data: features.data, dims: [1, features.numFrames, KALDI_FBANK_DIM] },
  });
  return Float32Array.from(out.embedding.data);
}

/** Gate engine for one dictation run; each run owns its VAD state. */
export function createOnnxSpeakerGateEngine(runner: SpeakerOnnxRunner): SpeakerGateEngine {
  const vad = new SileroVadDetector(runner);
  return {
    resetVad: async () => vad.reset(),
    detectSpeech: async (samples) => {
      const frames = Math.floor(samples.length / SPEAKER_GATE_VAD_FRAME);
      const flags: boolean[] = [];
      for (let i = 0; i < frames; i += 1) {
        flags.push(await vad.push(samples.subarray(i * SPEAKER_GATE_VAD_FRAME, (i + 1) * SPEAKER_GATE_VAD_FRAME)));
        // Only the per-frame flag is used; finished segments would pile up.
        vad.takeSegments();
      }
      return flags;
    },
    embed: (samples) => computeSpeakerEmbedding(runner, samples),
  };
}

export function createOnnxSpeakerEnrollmentEngine(runner: SpeakerOnnxRunner): SpeakerEnrollmentEngine {
  return {
    extractSpeech: (samples) => extractSpeech(runner, samples),
    embed: (samples) => computeSpeakerEmbedding(runner, samples),
  };
}

/** Speech-only samples of a clip: VAD segments joined, silence dropped. */
export async function extractSpeech(runner: SpeakerOnnxRunner, samples: Float32Array): Promise<Float32Array> {
  const vad = new SileroVadDetector(runner);
  const segments: Array<[number, number]> = [];
  const frames = Math.floor(samples.length / SPEAKER_GATE_VAD_FRAME);
  for (let i = 0; i < frames; i += 1) {
    await vad.push(samples.subarray(i * SPEAKER_GATE_VAD_FRAME, (i + 1) * SPEAKER_GATE_VAD_FRAME));
    segments.push(...vad.takeSegments());
  }
  vad.flush();
  segments.push(...vad.takeSegments());
  const total = segments.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const [from, to] of segments) {
    if (to <= from) continue;
    out.set(samples.subarray(from, to), offset);
    offset += to - from;
  }
  return out;
}
