// eslint-disable-next-line no-restricted-imports -- dedicated non-DB worker entry for speaker-gate inference.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';

import type { SpeakerWorkerRequest, SpeakerWorkerResponse } from './speakerWorkerProtocol';

/*
 * Speaker-gate inference thread. sherpa-onnx runs ONNX models synchronously,
 * so it lives here instead of on Electron main. Requests are handled strictly
 * one at a time in arrival order; the host relies on that ordering.
 */

const SAMPLE_RATE = 16_000;
const VAD_FRAME = 512;
// Gate runs keep their own VAD state. Old runs are evicted instead of freed
// explicitly, so a run that ended without cleanup cannot leak.
const MAX_VAD_SESSIONS = 4;

type SherpaVad = {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
  reset(): void;
};

type SherpaStream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
};

type SherpaExtractor = {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  compute(stream: SherpaStream, enableExternalBuffer?: boolean): Float32Array;
};

type SherpaModule = {
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
  SpeakerEmbeddingExtractor: new (config: unknown) => SherpaExtractor;
};

const port = parentPort;
if (!port) throw new Error('Speaker gate worker must run in a worker thread.');

let sherpa: SherpaModule | null = null;
let vadModelPath = '';
let extractor: SherpaExtractor | null = null;
const vadSessions = new Map<string, SherpaVad>();

function loadSherpa(): SherpaModule {
  if (!sherpa) {
    // Native addon: shipped unpacked next to the app, never bundled.
    sherpa = createRequire(__filename)('sherpa-onnx-node') as SherpaModule;
  }
  return sherpa;
}

function createVad(): SherpaVad {
  return new (loadSherpa().Vad)(
    {
      sileroVad: {
        model: vadModelPath,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: VAD_FRAME,
      },
      sampleRate: SAMPLE_RATE,
      debug: 0,
      numThreads: 1,
    },
    30,
  );
}

function requireExtractor(): SherpaExtractor {
  if (!extractor) throw new Error('speaker models are not loaded');
  return extractor;
}

function sessionVad(session: string): SherpaVad {
  let vad = vadSessions.get(session);
  if (vad) {
    // Keep recently used sessions at the end for eviction order.
    vadSessions.delete(session);
  } else {
    vad = createVad();
  }
  vadSessions.set(session, vad);
  while (vadSessions.size > MAX_VAD_SESSIONS) {
    const oldest = vadSessions.keys().next().value;
    if (oldest === undefined) break;
    vadSessions.delete(oldest);
  }
  return vad;
}

function drain(vad: SherpaVad, into?: Float32Array[]): void {
  while (!vad.isEmpty()) {
    if (into) into.push(Float32Array.from(vad.front(false).samples));
    vad.pop();
  }
}

function embed(samples: Float32Array): Float32Array | null {
  const engine = requireExtractor();
  const stream = engine.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  if (!engine.isReady(stream)) return null;
  return Float32Array.from(engine.compute(stream, false));
}

function extractSpeech(samples: Float32Array): Float32Array {
  const vad = createVad();
  const parts: Float32Array[] = [];
  for (let i = 0; i < samples.length; i += VAD_FRAME) {
    vad.acceptWaveform(samples.subarray(i, Math.min(i + VAD_FRAME, samples.length)));
    drain(vad, parts);
  }
  vad.flush();
  drain(vad, parts);
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function handle(request: SpeakerWorkerRequest): SpeakerWorkerResponse {
  switch (request.op) {
    case 'init': {
      const module = loadSherpa();
      vadModelPath = request.vadModel;
      vadSessions.clear();
      extractor = new module.SpeakerEmbeddingExtractor({
        model: request.embeddingModel,
        numThreads: 1,
        debug: 0,
        provider: 'cpu',
      });
      return { id: request.id, ok: true };
    }
    case 'vad-reset': {
      if (!vadModelPath) throw new Error('speaker models are not loaded');
      sessionVad(request.session).reset();
      return { id: request.id, ok: true };
    }
    case 'vad': {
      if (!vadModelPath) throw new Error('speaker models are not loaded');
      const vad = sessionVad(request.session);
      const frames = Math.floor(request.samples.length / VAD_FRAME);
      const flags = new Uint8Array(frames);
      for (let i = 0; i < frames; i += 1) {
        vad.acceptWaveform(request.samples.subarray(i * VAD_FRAME, (i + 1) * VAD_FRAME));
        flags[i] = vad.isDetected() ? 1 : 0;
        // Only the per-frame flag is used; finished segments would pile up.
        drain(vad);
      }
      return { id: request.id, ok: true, flags };
    }
    case 'embed':
      return { id: request.id, ok: true, embedding: embed(request.samples) };
    case 'speech':
      return { id: request.id, ok: true, samples: extractSpeech(request.samples) };
  }
}

port.on('message', (request: SpeakerWorkerRequest) => {
  let response: SpeakerWorkerResponse;
  try {
    response = handle(request);
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const transfer: ArrayBuffer[] = [];
  if (response.ok) {
    for (const value of [response.flags, response.embedding, response.samples]) {
      if (value) transfer.push(value.buffer as ArrayBuffer);
    }
  }
  port.postMessage(response, transfer);
});
