/**
 * Log mel filterbank features, computed exactly as sherpa-onnx feeds its
 * speaker embedding models (kaldi-native-fbank with sherpa's defaults):
 * 16 kHz, 25 ms frames every 10 ms, edges reflected instead of snipped,
 * DC removed, pre-emphasis 0.97, Povey window, 512-point FFT, power
 * spectrum, 80 mel bins between 20 Hz and 7600 Hz, natural log.
 *
 * Desktop runs sherpa-onnx itself; mobile runs the same ONNX models through
 * onnxruntime with these features, so both produce the same voiceprints.
 */

const SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const NUM_FFT_BINS = FFT_SIZE / 2;
const PREEMPH = 0.97;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2 - 400;
const FLT_EPSILON = 1.1920928955078125e-7;

export const KALDI_FBANK_DIM = 80;

export type FbankFeatures = {
  /** Row-major [numFrames, KALDI_FBANK_DIM]. */
  data: Float32Array;
  numFrames: number;
};

type MelBin = { offset: number; weights: Float32Array };

let povey: Float64Array | null = null;
let melBins: MelBin[] | null = null;
let twiddles: { cos: Float64Array; sin: Float64Array; bitReverse: Uint16Array } | null = null;

function poveyWindow(): Float64Array {
  if (povey) return povey;
  const window = new Float64Array(FRAME_LENGTH);
  const a = (2 * Math.PI) / (FRAME_LENGTH - 1);
  for (let i = 0; i < FRAME_LENGTH; i += 1) window[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  povey = window;
  return window;
}

function melScale(freq: number): number {
  return 1127 * Math.log(1 + freq / 700);
}

function melBanks(): MelBin[] {
  if (melBins) return melBins;
  const fftBinWidth = SAMPLE_RATE / FFT_SIZE;
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(HIGH_FREQ);
  const delta = (melHigh - melLow) / (KALDI_FBANK_DIM + 1);
  const bins: MelBin[] = [];
  for (let bin = 0; bin < KALDI_FBANK_DIM; bin += 1) {
    const left = melLow + bin * delta;
    const center = left + delta;
    const right = center + delta;
    let first = -1;
    let last = -1;
    const weights = new Float32Array(NUM_FFT_BINS);
    for (let i = 0; i < NUM_FFT_BINS; i += 1) {
      const mel = melScale(fftBinWidth * i);
      if (mel > left && mel < right) {
        weights[i] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
        if (first < 0) first = i;
        last = i;
      }
    }
    bins.push(first < 0 ? { offset: 0, weights: new Float32Array(0) } : { offset: first, weights: weights.slice(first, last + 1) });
  }
  melBins = bins;
  return bins;
}

function fftTables() {
  if (twiddles) return twiddles;
  const cos = new Float64Array(FFT_SIZE / 2);
  const sin = new Float64Array(FFT_SIZE / 2);
  for (let i = 0; i < FFT_SIZE / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE);
    sin[i] = -Math.sin((2 * Math.PI * i) / FFT_SIZE);
  }
  const bits = Math.log2(FFT_SIZE);
  const bitReverse = new Uint16Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    let reversed = 0;
    for (let b = 0; b < bits; b += 1) reversed |= ((i >> b) & 1) << (bits - 1 - b);
    bitReverse[i] = reversed;
  }
  twiddles = { cos, sin, bitReverse };
  return twiddles;
}

/** In-place radix-2 FFT of a real frame; writes the power spectrum into `power`. */
function powerSpectrum(frame: Float64Array, re: Float64Array, im: Float64Array, power: Float64Array): void {
  const { cos, sin, bitReverse } = fftTables();
  for (let i = 0; i < FFT_SIZE; i += 1) {
    re[bitReverse[i]] = frame[i];
    im[i] = 0;
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let i = 0; i <= NUM_FFT_BINS; i += 1) power[i] = re[i] * re[i] + im[i] * im[i];
}

/** Number of frames for `numSamples` once input is finished (kaldi, snip_edges=false). */
export function fbankFrameCount(numSamples: number): number {
  return Math.floor((numSamples + FRAME_SHIFT / 2) / FRAME_SHIFT);
}

/** Fbank features of 16 kHz mono samples in [-1, 1]. */
export function computeKaldiFbank(samples: Float32Array): FbankFeatures {
  const numSamples = samples.length;
  const numFrames = numSamples === 0 ? 0 : fbankFrameCount(numSamples);
  const data = new Float32Array(numFrames * KALDI_FBANK_DIM);
  if (numFrames === 0) return { data, numFrames };

  const window = poveyWindow();
  const bins = melBanks();
  const frame = new Float64Array(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const power = new Float64Array(NUM_FFT_BINS + 1);

  for (let f = 0; f < numFrames; f += 1) {
    const begin = FRAME_SHIFT * f + FRAME_SHIFT / 2 - FRAME_LENGTH / 2;
    let mean = 0;
    for (let s = 0; s < FRAME_LENGTH; s += 1) {
      let index = begin + s;
      // Reflect around the edges, as kaldi does when not snipping them.
      while (index < 0 || index >= numSamples) {
        index = index < 0 ? -index - 1 : 2 * numSamples - 1 - index;
      }
      frame[s] = samples[index];
      mean += frame[s];
    }
    mean /= FRAME_LENGTH;
    for (let s = 0; s < FRAME_LENGTH; s += 1) frame[s] -= mean;
    for (let s = FRAME_LENGTH - 1; s > 0; s -= 1) frame[s] -= PREEMPH * frame[s - 1];
    frame[0] -= PREEMPH * frame[0];
    for (let s = 0; s < FRAME_LENGTH; s += 1) frame[s] *= window[s];
    frame.fill(0, FRAME_LENGTH);

    powerSpectrum(frame, re, im, power);

    const row = f * KALDI_FBANK_DIM;
    for (let b = 0; b < KALDI_FBANK_DIM; b += 1) {
      const { offset, weights } = bins[b];
      let energy = 0;
      for (let i = 0; i < weights.length; i += 1) energy += weights[i] * power[offset + i];
      data[row + b] = Math.log(Math.max(energy, FLT_EPSILON));
    }
  }
  return { data, numFrames };
}

/** Subtracts each mel bin's mean over all frames (3D-Speaker "global-mean"). */
export function subtractFbankMean(features: FbankFeatures): void {
  const { data, numFrames } = features;
  if (numFrames === 0) return;
  for (let b = 0; b < KALDI_FBANK_DIM; b += 1) {
    let sum = 0;
    for (let f = 0; f < numFrames; f += 1) sum += data[f * KALDI_FBANK_DIM + b];
    const mean = sum / numFrames;
    for (let f = 0; f < numFrames; f += 1) data[f * KALDI_FBANK_DIM + b] -= mean;
  }
}
