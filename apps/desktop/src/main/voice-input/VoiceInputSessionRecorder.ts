import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { createLogger } from '../logger.js';

const log = createLogger('voice-input:recorder');

// Same resolution rule as the file logger: in dev __dirname points inside
// apps/desktop/.vite/build, so two levels up is apps/desktop/. In packaged
// builds we'd write into the asar bundle which is read-only — but we never
// instantiate a recorder in packaged builds (the env var is dev-only).
function recordingsRoot(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'voice-input-recordings')
    : path.resolve(__dirname, '../../logs/voice-input-recordings');
}

// Per-message size cap on the ws.jsonl payload trim — anything bigger gets
// replaced with a length marker so the recording stays small without losing
// the cadence/order of messages.
const WS_FIELD_INLINE_MAX_BYTES = 8 * 1024;
const WS_FIELD_TRUNCATE_BYTES = 256;

export type RecorderInitMeta = {
  runId?: string;
  providerKind: string;
  model?: string;
  sourceLanguage?: string;
  inputSampleRate?: number;
  startedAtIso: string;
};

export type RecorderWsDirection = 'outbound' | 'inbound';

/**
 * Per-session recorder for offline voice-input debugging.
 *
 * Writes raw PCM (input rate, mono PCM16) plus a JSONL of every WS message
 * exchanged with the upstream realtime API, plus a meta.json describing the
 * run. finalize() converts the raw PCM to a WAV with a proper RIFF header.
 *
 * Gated by env: only instantiated when XDT_VOICE_INPUT_RECORD is truthy.
 * Failure to write to disk degrades silently (dev-only artifact, never
 * blocks the live audio path).
 */
export class VoiceInputSessionRecorder {
  private readonly dir: string;
  private readonly pcmPath: string;
  private readonly wsPath: string;
  private readonly metaPath: string;
  private pcmStream?: fs.WriteStream;
  private wsStream?: fs.WriteStream;
  private inputSampleRate?: number;
  private pcmBytesWritten = 0;
  private finalized = false;
  private meta?: RecorderInitMeta;

  constructor(public readonly sessionId: string) {
    this.dir = path.join(recordingsRoot(), sessionId);
    this.pcmPath = path.join(this.dir, 'audio.pcm');
    this.wsPath = path.join(this.dir, 'ws.jsonl');
    this.metaPath = path.join(this.dir, 'meta.json');
  }

  init(meta: RecorderInitMeta): void {
    this.meta = meta;
    this.inputSampleRate = meta.inputSampleRate;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.pcmStream = fs.createWriteStream(this.pcmPath);
      this.wsStream = fs.createWriteStream(this.wsPath, { flags: 'a' });
      this.attachStreamErrorHandler('pcm', this.pcmStream);
      this.attachStreamErrorHandler('ws', this.wsStream);
      fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
      log.debug('session recording started', { dir: this.dir });
    } catch (error) {
      log.warn('failed to initialize session recorder', {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recordAudio(chunk: Buffer, sampleRate: number): void {
    if (!this.pcmStream) return;
    if (this.inputSampleRate === undefined) this.inputSampleRate = sampleRate;
    if (this.inputSampleRate !== sampleRate) {
      // Mixing sample rates would corrupt the WAV header. Surface the
      // divergence once and keep recording at the original rate; the WS
      // log is still authoritative for what the server received.
      log.warn('sample rate changed mid-recording', {
        expected: this.inputSampleRate,
        seen: sampleRate,
      });
    }
    try {
      this.pcmStream.write(chunk);
      this.pcmBytesWritten += chunk.length;
    } catch (error) {
      log.debug('pcm write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recordWs(direction: RecorderWsDirection, message: unknown): void {
    if (!this.wsStream) return;
    const entry = {
      t: Date.now(),
      dir: direction,
      ...summarizeWsMessage(message),
    };
    try {
      this.wsStream.write(`${JSON.stringify(entry)}\n`);
    } catch (error) {
      log.debug('ws write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async finalize(extraMeta?: Record<string, unknown>): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const closes: Array<Promise<void>> = [];
    if (this.pcmStream) closes.push(closeStream(this.pcmStream));
    if (this.wsStream) closes.push(closeStream(this.wsStream));
    try {
      await Promise.all(closes);
    } catch (error) {
      log.debug('stream close failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.pcmBytesWritten > 0 && this.inputSampleRate) {
      try {
        const wavPath = path.join(this.dir, 'audio.wav');
        await pcmToWav(this.pcmPath, wavPath, this.inputSampleRate);
      } catch (error) {
        log.debug('wav conversion failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (extraMeta || this.meta) {
      try {
        const merged = {
          ...(this.meta ?? {}),
          ...(extraMeta ?? {}),
          finalizedAtIso: new Date().toISOString(),
          pcmBytes: this.pcmBytesWritten,
        };
        fs.writeFileSync(this.metaPath, JSON.stringify(merged, null, 2));
      } catch (error) {
        log.debug('meta write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    log.debug('session recording finalized', {
      dir: this.dir,
      pcmBytes: this.pcmBytesWritten,
    });
  }

  private attachStreamErrorHandler(kind: 'pcm' | 'ws', stream: fs.WriteStream): void {
    stream.on('error', (error) => {
      if (kind === 'pcm' && this.pcmStream === stream) this.pcmStream = undefined;
      if (kind === 'ws' && this.wsStream === stream) this.wsStream = undefined;
      log.warn('session recorder stream error', {
        dir: this.dir,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export function isVoiceInputRecordingEnabled(): boolean {
  if (app.isPackaged) return false;
  const value = process.env.XDT_VOICE_INPUT_RECORD;
  if (!value) return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}

export function makeRecorderSessionId(): string {
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  // CSPRNG 4 bytes = 8 hex chars ≈ 32 bits entropy (CodeQL js/insecure-randomness)
  const suffix = randomBytes(4).toString('hex');
  return `${stamp}-${suffix}`;
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

// Strip noisy/large fields from WS messages before logging. Audio appends
// can be hundreds of KB of base64 — useless to keep verbatim, but the type
// and cadence are exactly what we need for stall diagnosis.
function summarizeWsMessage(message: unknown): Record<string, unknown> {
  if (typeof message === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return { raw: truncateString(message, WS_FIELD_INLINE_MAX_BYTES) };
    }
    return summarizeWsMessage(parsed);
  }
  if (Buffer.isBuffer(message)) {
    return { binary: true, bytes: message.length };
  }
  if (!message || typeof message !== 'object') {
    return { value: message };
  }
  const obj = message as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'audio' && typeof value === 'string') {
      summary.audio_b64_len = value.length;
      continue;
    }
    if (typeof value === 'string' && value.length > WS_FIELD_TRUNCATE_BYTES) {
      summary[key] = `${value.slice(0, WS_FIELD_TRUNCATE_BYTES)}…<+${value.length - WS_FIELD_TRUNCATE_BYTES}>`;
      continue;
    }
    summary[key] = value;
  }
  return summary;
}

function truncateString(value: string, maxBytes: number): string {
  if (value.length <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}…<+${value.length - maxBytes}>`;
}

// Streams the raw PCM into a WAV with a proper RIFF header. Done as a
// post-step so the streaming write path never has to back-patch the header.
async function pcmToWav(pcmPath: string, wavPath: string, sampleRate: number): Promise<void> {
  const pcm = await fs.promises.readFile(pcmPath);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const chunkSize = 36 + dataSize;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  await fs.promises.writeFile(wavPath, Buffer.concat([header, pcm]));
}
