// eslint-disable-next-line no-restricted-imports -- dedicated non-DB worker entry for local offline ASR inference.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import os from 'node:os';

import {
  localAsrModelSpecKey,
  type LocalAsrModelSpec,
  type LocalAsrWorkerRequest,
  type LocalAsrWorkerResponse,
} from './localAsrWorkerProtocol.js';

/*
 * Local offline ASR inference thread. sherpa-onnx runs ONNX models synchronously
 * on CPU, so inference lives in this dedicated worker thread rather than blocking
 * Electron main. Requests are processed strictly sequentially.
 */

const SAMPLE_RATE = 16_000;
/** Cap single offline decode window so 30s-bounded models (Whisper / SenseVoice) never truncate. */
const MAX_DECODE_CHUNK_SAMPLES = 28 * SAMPLE_RATE;

type SherpaOfflineStream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
};

type SherpaOfflineRecognizer = {
  createStream(): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  getResult(stream: SherpaOfflineStream): { text?: string };
};

type SherpaModule = {
  OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizer;
};

const port = parentPort;
if (!port) throw new Error('Local ASR worker must run in a worker thread.');

let sherpa: SherpaModule | null = null;
let recognizer: SherpaOfflineRecognizer | null = null;
let loadedKey = '';

function loadSherpa(): SherpaModule {
  if (!sherpa) {
    // Native addon: shipped unpacked next to the app, never bundled.
    sherpa = createRequire(__filename)('sherpa-onnx-node') as SherpaModule;
  }
  return sherpa;
}

function normalizeLanguageHint(language: string | undefined): string {
  if (!language) return '';
  const lower = language.trim().toLowerCase();
  if (!lower || lower === 'auto') return '';
  const base = lower.split(/[-_]/)[0] ?? '';
  return base;
}

function buildRecognizerConfig(spec: LocalAsrModelSpec, language?: string): Record<string, unknown> {
  const numThreads = Math.max(1, Math.min(4, os.cpus().length || 2));
  const normalizedLang = normalizeLanguageHint(language);
  const modelConfig: Record<string, unknown> = {
    tokens: spec.tokens,
    numThreads,
    provider: 'cpu',
    debug: 0,
  };

  if (spec.kind === 'sensevoice') {
    const supportedSenseVoiceLangs = new Set(['zh', 'en', 'ja', 'ko', 'yue']);
    modelConfig.senseVoice = {
      model: spec.model,
      language: supportedSenseVoiceLangs.has(normalizedLang) ? normalizedLang : '',
      useInverseTextNormalization: 1,
    };
  } else if (spec.kind === 'paraformer') {
    modelConfig.paraformer = {
      model: spec.model,
    };
  } else if (spec.kind === 'whisper') {
    modelConfig.whisper = {
      encoder: spec.encoder,
      decoder: spec.decoder,
      language: normalizedLang,
      task: 'transcribe',
    };
  } else if (spec.kind === 'transducer') {
    modelConfig.transducer = {
      encoder: spec.encoder,
      decoder: spec.decoder,
      joiner: spec.joiner,
    };
  }

  return {
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: 80,
    },
    modelConfig,
  };
}

function cleanRecognizedText(raw: string | undefined): string {
  if (!raw) return '';
  // Strip SenseVoice / Whisper special control markers such as <|zh|>, <|NEUTRAL|>, <|Speech|>.
  return raw.replace(/<\|[^|>]+\|>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeSamples(samples: Float32Array, sampleRate: number): string {
  if (!recognizer) throw new Error('Local offline ASR model is not loaded.');
  if (samples.length === 0) return '';
  const effectiveRate = sampleRate > 0 ? sampleRate : SAMPLE_RATE;
  const maxChunkSamples = Math.max(effectiveRate * 10, Math.round((MAX_DECODE_CHUNK_SAMPLES / SAMPLE_RATE) * effectiveRate));
  const parts: string[] = [];

  for (let offset = 0; offset < samples.length; offset += maxChunkSamples) {
    const slice = samples.subarray(offset, Math.min(samples.length, offset + maxChunkSamples));
    if (slice.length === 0) continue;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: effectiveRate, samples: slice });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = cleanRecognizedText(result?.text);
    if (text) parts.push(text);
  }

  return parts.join(' ').trim();
}

function handle(request: LocalAsrWorkerRequest): LocalAsrWorkerResponse {
  switch (request.op) {
    case 'init': {
      const nextKey = localAsrModelSpecKey(request.spec, normalizeLanguageHint(request.language));
      if (recognizer && loadedKey === nextKey) {
        return { id: request.id, ok: true };
      }
      const mod = loadSherpa();
      recognizer = new mod.OfflineRecognizer(buildRecognizerConfig(request.spec, request.language));
      loadedKey = nextKey;
      return { id: request.id, ok: true };
    }
    case 'transcribe': {
      const text = decodeSamples(request.samples, request.sampleRate);
      return { id: request.id, ok: true, text };
    }
    case 'dispose': {
      recognizer = null;
      loadedKey = '';
      return { id: request.id, ok: true };
    }
  }
}

port.on('message', (request: LocalAsrWorkerRequest) => {
  try {
    port.postMessage(handle(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ id: request.id, ok: false, error: message } satisfies LocalAsrWorkerResponse);
  }
});
