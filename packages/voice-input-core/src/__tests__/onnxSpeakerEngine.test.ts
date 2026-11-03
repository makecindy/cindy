import { describe, expect, it } from 'vitest';

import {
  computeKaldiFbank,
  fbankFrameCount,
  KALDI_FBANK_DIM,
  subtractFbankMean,
} from '../speaker-onnx/kaldiFbank.js';
import {
  computeSpeakerEmbedding,
  createOnnxSpeakerGateEngine,
  extractSpeech,
  SileroVadDetector,
  type OnnxTensor,
  type SpeakerOnnxRunner,
} from '../speaker-onnx/onnxSpeakerEngine.js';

/*
 * The real models are not available in CI. Equivalence with sherpa-onnx
 * (embeddings, per-frame VAD flags, extracted speech) was measured against
 * the desktop engine on the real models; these tests pin the logic around
 * the models with a scripted runner.
 */

function scriptedRunner(probabilities: number[]): SpeakerOnnxRunner & { calls: Record<string, OnnxTensor>[] } {
  let index = 0;
  const calls: Record<string, OnnxTensor>[] = [];
  return {
    calls,
    async run(model, inputs): Promise<Record<string, OnnxTensor>> {
      calls.push(inputs);
      if (model === 'embedding') {
        const frames = inputs.x.dims[1];
        return { embedding: { data: Float32Array.from({ length: 4 }, (_, i) => frames + i), dims: [1, 4] } };
      }
      const prob = probabilities[index] ?? 0;
      index += 1;
      return {
        prob: { data: Float32Array.of(prob), dims: [1, 1] },
        new_h: { data: new Float32Array(128).fill(index), dims: [2, 1, 64] },
        new_c: { data: new Float32Array(128).fill(-index), dims: [2, 1, 64] },
      };
    },
  };
}

const FRAME = 512;
const frames = (count: number) => new Float32Array(count * FRAME);

describe('kaldi fbank', () => {
  it('counts frames like kaldi without snipping edges', () => {
    expect(fbankFrameCount(0)).toBe(0);
    expect(fbankFrameCount(79)).toBe(0);
    expect(fbankFrameCount(80)).toBe(1);
    expect(fbankFrameCount(16_000)).toBe(100);
    expect(computeKaldiFbank(new Float32Array(16_000)).numFrames).toBe(100);
  });

  it('puts a pure tone in the mel bin around its frequency', () => {
    const samples = Float32Array.from({ length: 16_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 16_000));
    const { data, numFrames } = computeKaldiFbank(samples);
    const middle = Math.floor(numFrames / 2) * KALDI_FBANK_DIM;
    let peak = 0;
    for (let b = 1; b < KALDI_FBANK_DIM; b += 1) if (data[middle + b] > data[middle + peak]) peak = b;
    // 1 kHz is mel 1000; with 80 bins from 20 Hz to 7600 Hz that is bin 28.
    expect(peak).toBeGreaterThanOrEqual(27);
    expect(peak).toBeLessThanOrEqual(29);
  });

  it('floors silence at log(FLT_EPSILON) instead of -Infinity', () => {
    const { data } = computeKaldiFbank(new Float32Array(1_600));
    expect(Array.from(data).every((value) => Number.isFinite(value))).toBe(true);
  });

  it('subtracts the per-bin mean over frames', () => {
    const samples = Float32Array.from({ length: 8_000 }, (_, i) => Math.sin(i / 7) * 0.2 + Math.sin(i / 3) * 0.1);
    const features = computeKaldiFbank(samples);
    subtractFbankMean(features);
    for (let b = 0; b < KALDI_FBANK_DIM; b += 1) {
      let sum = 0;
      for (let f = 0; f < features.numFrames; f += 1) sum += features.data[f * KALDI_FBANK_DIM + b];
      expect(Math.abs(sum / features.numFrames)).toBeLessThan(1e-4);
    }
  });
});

describe('SileroVadDetector', () => {
  it('needs 0.25 s of speech before it reports speech, then holds through short pauses', async () => {
    // The first loud frame starts the clock; speech counts once 4000 samples
    // passed since then, i.e. on the 9th loud frame.
    const probs = [...Array(10).fill(0.9), ...Array(5).fill(0.1), ...Array(5).fill(0.9), ...Array(12).fill(0.1)];
    const vad = new SileroVadDetector(scriptedRunner(probs));
    const flags: boolean[] = [];
    for (let i = 0; i < probs.length; i += 1) flags.push(await vad.push(new Float32Array(FRAME)));
    expect(flags.slice(0, 8)).toEqual(Array(8).fill(false));
    // A 5-frame dip (2560 samples) is shorter than the 4000-sample silence.
    expect(flags.slice(8, 20)).toEqual(Array(12).fill(true));
    // Speech ends once silence lasted 4000 samples: 8 frames still count.
    expect(flags.slice(20, 28)).toEqual(Array(8).fill(true));
    expect(flags[28]).toBe(false);
  });

  it('carries the LSTM state from one frame to the next and resets it', async () => {
    const runner = scriptedRunner([0, 0, 0]);
    const vad = new SileroVadDetector(runner);
    await vad.push(new Float32Array(FRAME));
    await vad.push(new Float32Array(FRAME));
    expect(runner.calls[0].h.data[0]).toBe(0);
    expect(runner.calls[1].h.data[0]).toBe(1);
    expect(runner.calls[1].c.data[0]).toBe(-1);
    vad.reset();
    await vad.push(new Float32Array(FRAME));
    expect(runner.calls[2].h.data[0]).toBe(0);
  });

  it('rejects frames of the wrong size', async () => {
    await expect(new SileroVadDetector(scriptedRunner([])).push(new Float32Array(100))).rejects.toThrow();
  });
});

describe('ONNX speaker engines', () => {
  it('extracts speech segments with the same padding as sherpa-onnx', async () => {
    const probs = [...Array(20).fill(0.1), ...Array(20).fill(0.9), ...Array(20).fill(0.1)];
    const samples = frames(60);
    const speech = await extractSpeech(scriptedRunner(probs), samples);
    // Start: detected at frame 28 (tail 14848) minus 2 frames and 4000 samples;
    // end: 4000 samples after the first frame silence was confirmed.
    const start = 29 * FRAME - 2 * FRAME - 4000;
    const end = 48 * FRAME - 4000 + FRAME;
    expect(speech.length).toBe(end - start);
  });

  it('flushes a segment still open at the end of the clip', async () => {
    const probs = [...Array(4).fill(0.1), ...Array(30).fill(0.9)];
    const speech = await extractSpeech(scriptedRunner(probs), frames(34));
    expect(speech.length).toBeGreaterThan(0);
  });

  it('returns no embedding for a clip without a single frame', async () => {
    const runner = scriptedRunner([]);
    expect(await computeSpeakerEmbedding(runner, new Float32Array(10))).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it('feeds mean-normalized fbank frames to the embedding model', async () => {
    const runner = scriptedRunner([]);
    const embedding = await computeSpeakerEmbedding(runner, Float32Array.from({ length: 16_000 }, (_, i) => Math.sin(i)));
    expect(runner.calls[0].x.dims).toEqual([1, 100, KALDI_FBANK_DIM]);
    expect(Array.from(embedding ?? [])).toEqual([100, 101, 102, 103]);
  });

  it('gives each gate run its own VAD flags, one per whole frame', async () => {
    const engine = createOnnxSpeakerGateEngine(scriptedRunner(Array(20).fill(0.9)));
    await engine.resetVad();
    const flags = await engine.detectSpeech(new Float32Array(10 * FRAME + 100));
    expect(flags).toHaveLength(10);
    expect(flags[9]).toBe(true);
  });
});
