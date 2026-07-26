import WebSocket from 'ws';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';
import { createLogger } from '../logger.js';
import { elevenLabsLanguageCode } from './language.js';
import { mergeRecoveredTranscript } from './transcriptMerge.js';

type ElevenLabsScribeProviderOptions = {
  apiKey?: string;
  proxyApiKey?: string;
  baseUrl?: string;
  sourceLanguage?: string;
  vadSilenceThresholdSecs?: number;
  connectTimeoutMs?: number;
};

const ELEVENLABS_REALTIME_BASE_URL = 'https://api.elevenlabs.io';
const SCRIBE_REALTIME_MODEL = 'scribe_v2_realtime';
const FLUSH_SEND_TIMEOUT_MS = 1_500;
const FLUSH_STABLE_TIMEOUT_MS = 2_000;
const STOP_DRAIN_TIMEOUT_MS = 1_000;
const RECOVER_TIMEOUT_MS = 5_000;
const MIN_AUDIO_BEFORE_COMMIT_MS = 2_100;
const FLUSH_SILENCE_CHUNK_MS = 500;
const PCM_16K_BYTES_PER_MS = 32;
const MAX_REPLAY_AUDIO_MS = 60_000;
const CONFIRMED_AUDIO_RETENTION_MS = 1_500;
const CONNECT_TIMEOUT_MS = 5_000;
const log = createLogger('voice-input:elevenlabs-scribe');

type ReplayAudioChunk = {
  pcm: Buffer;
  durationMs: number;
  addedAt: number;
};

/**
 * Main-process ElevenLabs Scribe realtime provider.
 *
 * The provider treats Scribe `partial_transcript` messages as mutable snapshots
 * of the current uncommitted segment, then exposes one provider-neutral draft:
 * committed prefix plus the latest partial snapshot.
 */
export class ElevenLabsScribeProvider implements AsrProvider {
  private readonly apiKey?: string;
  private readonly proxyApiKey?: string;
  private readonly baseUrl: string;
  private readonly sourceLanguage: string;
  private readonly vadSilenceThresholdSecs: number;
  private readonly connectTimeoutMs: number;
  private socket?: WebSocket;
  private callback: (event: AsrEvent) => void = () => {};
  private connected = false;
  private sendTail: Promise<void> = Promise.resolve();
  private committedSegments: string[] = [];
  private currentPartial = '';
  private recoveryPartialPrefix = '';
  private lastStable?: { text: string; at: number };
  private sentAudioMs = 0;
  private uncommittedAudio: ReplayAudioChunk[] = [];
  private uncommittedAudioMs = 0;
  private stableResolvers: Array<(text: string | undefined) => void> = [];
  private recoveryPromise?: Promise<void>;
  private stopRequested = false;
  private startResolve?: () => void;
  private startReject?: (error: Error) => void;

  constructor(options: ElevenLabsScribeProviderOptions) {
    this.apiKey = options.apiKey;
    this.proxyApiKey = options.proxyApiKey;
    this.baseUrl = options.baseUrl ?? ELEVENLABS_REALTIME_BASE_URL;
    this.sourceLanguage = options.sourceLanguage ?? 'auto';
    this.vadSilenceThresholdSecs = options.vadSilenceThresholdSecs ?? 1.5;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (!this.apiKey && !this.proxyApiKey) throw new Error('Missing ElevenLabs or XD Gateway API key');
    if (!this.baseUrl) throw new Error('Missing ElevenLabs or XD Gateway base URL');
    if (this.socket) return;
    this.resetTranscriptState();

    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    const url = this.buildUrl();
    log.debug('connect', {
      host: safeUrlHost(url),
      language: elevenLabsLanguageCode(this.sourceLanguage) ?? 'auto',
      credential: this.apiKey ? 'elevenlabs-api-key' : 'proxy-api-key',
    });

    const socket = new WebSocket(url, {
      headers: this.buildHeaders(),
    });
    this.socket = socket;

    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      this.handleMessage(data.toString());
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.resolveStableWaiters(undefined);
      this.callback({ type: 'disconnected', at: Date.now() });
    });
    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      this.callback({ type: 'error', message: error.message, at: Date.now() });
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(connectTimer);
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
        socket.off('unexpected-response', onUnexpectedResponse);
        this.startResolve = undefined;
        this.startReject = undefined;
      };
      const fail = (error: Error, terminateSocket: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.socket === socket) {
          this.socket = undefined;
          this.connected = false;
        }
        if (terminateSocket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          socket.terminate();
        }
        reject(error);
      };
      // Match the other realtime ASR providers: startup must either reach the
      // provider's ready barrier or fail with a concrete network/handshake
      // reason before renderer falls back to its generic start watchdog.
      const connectTimer = setTimeout(() => {
        log.warn('elevenlabs scribe connection timed out before ready', {
          timeoutMs: this.connectTimeoutMs,
        });
        fail(new Error(`ElevenLabs Scribe connection timed out after ${this.connectTimeoutMs}ms`), true);
      }, this.connectTimeoutMs);
      const onOpen = (): void => {
        if (settled) return;
        if (this.stopRequested) {
          fail(new Error('ElevenLabs Scribe connection opened after stop.'), true);
        }
      };
      const onError = (error: Error): void => {
        fail(error, false);
      };
      const onClose = (): void => {
        fail(new Error('ElevenLabs Scribe connection closed before it was ready.'), false);
      };
      const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage): void => {
        response.resume();
        const statusCode = response.statusCode ?? 'unknown';
        const statusMessage = response.statusMessage ? ` ${response.statusMessage}` : '';
        fail(new Error(`ElevenLabs Scribe handshake failed: HTTP ${statusCode}${statusMessage}`), true);
      };
      this.startResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      this.startReject = (error) => {
        fail(error, true);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.once('unexpected-response', onUnexpectedResponse);
    });
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    const pcm = Buffer.from(chunk);
    const durationMs = trace?.durationMs ?? estimatePcm16kDurationMs(chunk.byteLength);
    if (!this.connected || !this.socket) {
      if (this.socket || this.recoveryPromise) this.addUncommittedAudio(pcm, durationMs);
      return;
    }
    this.sentAudioMs += durationMs;
    this.addUncommittedAudio(pcm, durationMs);
    void this.enqueueAudioChunk(pcm, false);
  }

  private enqueueAudioChunk(pcm: Buffer, commit: boolean): Promise<void> {
    return this.enqueue({
      message_type: 'input_audio_chunk',
      audio_base_64: pcm.toString('base64'),
      commit,
      sample_rate: 16000,
    });
  }

  async flushAudio(): Promise<void> {
    if (this.stopRequested) return;
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise,
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    if (!this.connected || !this.socket) return;
    const waitForStable = hasSpeechContent(this.currentPartial);
    const paddingMs = Math.max(FLUSH_SILENCE_CHUNK_MS, MIN_AUDIO_BEFORE_COMMIT_MS - this.sentAudioMs);
    const paddingChunks = Math.ceil(paddingMs / FLUSH_SILENCE_CHUNK_MS);

    for (let index = 0; index < paddingChunks; index += 1) {
      const remainingMs = paddingMs - index * FLUSH_SILENCE_CHUNK_MS;
      const chunkMs = Math.min(FLUSH_SILENCE_CHUNK_MS, remainingMs);
      const silence = Buffer.alloc(Math.ceil(chunkMs * PCM_16K_BYTES_PER_MS));
      const sent = await settleWithin(this.enqueueAudioChunk(silence, index === paddingChunks - 1), FLUSH_SEND_TIMEOUT_MS);
      if (!sent) return;
      this.sentAudioMs += chunkMs;
    }

    log.debug('commit requested', {
      sentAudioMs: Math.round(this.sentAudioMs),
      hadPartial: waitForStable,
    });
    if (waitForStable) await this.waitForStable(FLUSH_STABLE_TIMEOUT_MS);
  }

  async recover(): Promise<void> {
    if (this.stopRequested) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.performRecover().finally(() => {
      this.recoveryPromise = undefined;
    });
    return this.recoveryPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.connected = false;
    this.startReject?.(new Error('ElevenLabs Scribe stopped before the session was ready.'));
    this.recoveryPartialPrefix = '';
    this.clearUncommittedAudio();
    this.resolveStableWaiters(undefined);
    try {
      await settleWithin(this.sendTail, STOP_DRAIN_TIMEOUT_MS);
    } catch {
      // sendTail errors are already reported through the ASR event callback.
    }
    this.sendTail = Promise.resolve();
    this.teardownSocketForReconnect();
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    this.teardownSocketForReconnect();
  }

  private async performRecover(): Promise<void> {
    const replay = [...this.uncommittedAudio];
    const replayMs = replay.reduce((sum, chunk) => sum + chunk.durationMs, 0);
    const committedText = composeScribeTranscript(this.committedSegments, '');
    const partialPrefix = this.currentPartial;
    const startedAt = Date.now();

    log.info('recover: reconnecting ElevenLabs Scribe and replaying uncommitted audio', {
      replayChunks: replay.length,
      replayMs: Math.round(replayMs),
      committedChars: committedText.length,
      partialChars: this.currentPartial.length,
    });

    this.teardownSocketForReconnect();
    this.sendTail = Promise.resolve();
    this.recoveryPartialPrefix = partialPrefix;
    // openSocket() owns the provider startup boundary, including connect
    // timeout and handshake failure. Reusing that single boundary here keeps
    // recovery failure logs consistent with first-start failures.
    await this.openSocket();
    if (this.stopRequested) {
      this.teardownSocketForReconnect();
      return;
    }

    for (const chunk of [...this.uncommittedAudio]) {
      await this.enqueueAudioChunk(chunk.pcm, false);
    }

    log.info('recover: ElevenLabs Scribe replay complete', {
      replayChunks: this.uncommittedAudio.length,
      replayMs: Math.round(this.uncommittedAudioMs),
      elapsedMs: Date.now() - startedAt,
    });
  }

  private teardownSocketForReconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.resolveStableWaiters(undefined);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }

  private buildUrl(): string {
    return buildElevenLabsScribeRealtimeUrl({
      baseUrl: this.baseUrl,
      sourceLanguage: this.sourceLanguage,
      vadSilenceThresholdSecs: this.vadSilenceThresholdSecs,
    });
  }

  private buildHeaders(): Record<string, string> {
    if (this.apiKey) {
      return { 'xi-api-key': this.apiKey };
    }
    return { Authorization: `Bearer ${this.proxyApiKey ?? ''}` };
  }

  private enqueue(payload: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve();
    const text = JSON.stringify(payload);

    const sendJob = this.sendTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          socket.send(text, (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.sendTail = sendJob.catch((error) => {
      this.callback({ type: 'error', message: error instanceof Error ? error.message : String(error), at: Date.now() });
    });
    return sendJob;
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    switch (message.message_type) {
      case 'session_started':
        log.debug('session started');
        if (!this.connected) {
          this.connected = true;
          this.callback({ type: 'connected', at: Date.now() });
        }
        this.startResolve?.();
        break;
      case 'partial_transcript':
        if (typeof message.text === 'string') {
          this.handlePartial(message.text);
        }
        break;
      case 'committed_transcript':
      case 'committed_transcript_with_timestamps':
        if (typeof message.text === 'string') {
          this.handleCommitted(message.text, String(message.message_type));
        }
        break;
      case 'error':
      case 'auth_error':
      case 'quota_exceeded':
      case 'rate_limited':
      case 'queue_overflow':
      case 'resource_exhausted':
      case 'session_time_limit_exceeded':
      case 'commit_throttled':
      case 'insufficient_audio_activity':
      case 'invalid_request':
      case 'unaccepted_terms':
      case 'input_error':
      case 'chunk_size_exceeded':
      case 'transcriber_error':
        {
          const eventMessage = typeof message.error === 'string' ? message.error : String(message.message_type);
          this.callback({
            type: 'error',
            message: eventMessage,
            at: Date.now(),
          });
          this.startReject?.(new Error(eventMessage));
        }
        this.resolveStableWaiters(undefined);
        break;
    }
  }

  private handlePartial(text: string): void {
    const partial = mergeRecoveredTranscript(this.recoveryPartialPrefix, text);
    if (!hasSpeechContent(partial)) return;
    const previous = this.currentPartial;
    this.currentPartial = partial;
    const draft = composeScribeTranscript(this.committedSegments, this.currentPartial);
    log.debug('partial snapshot', {
      partialChars: partial.length,
      changedFromPrevious: previous !== partial,
      draftChars: draft.length,
    });
    this.callback({ type: 'partial', text: draft, at: Date.now() });
  }

  private handleCommitted(text: string, eventType: string): void {
    const committed = mergeRecoveredTranscript(this.recoveryPartialPrefix, text);
    if (!hasSpeechContent(committed) || this.isDuplicateStable(committed)) return;

    this.committedSegments.push(committed);
    this.currentPartial = '';
    this.recoveryPartialPrefix = '';
    const stable = composeScribeTranscript(this.committedSegments, '');
    this.lastStable = { text: committed, at: Date.now() };
    this.trimUncommittedAudioOlderThan(Date.now() - CONFIRMED_AUDIO_RETENTION_MS);
    log.debug('committed transcript', {
      eventType,
      committedChars: committed.length,
      stableChars: stable.length,
      segments: this.committedSegments.length,
    });
    this.callback({ type: 'stable', text: stable, at: Date.now() });
    this.resolveStableWaiters(stable);
  }

  private isDuplicateStable(text: string): boolean {
    const previous = this.lastStable;
    if (!previous) return false;
    return previous.text === text && Date.now() - previous.at < 250;
  }

  private waitForStable(timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const resolver = (text: string | undefined): void => {
        clearTimeout(timer);
        this.stableResolvers = this.stableResolvers.filter((item) => item !== resolver);
        resolve(text);
      };
      const timer = setTimeout(() => {
        this.stableResolvers = this.stableResolvers.filter((item) => item !== resolver);
        resolve(undefined);
      }, timeoutMs);
      this.stableResolvers.push(resolver);
    });
  }

  private resolveStableWaiters(text: string | undefined): void {
    this.stableResolvers.splice(0).forEach((resolve) => resolve(text));
  }

  private resetTranscriptState(): void {
    this.stopRequested = false;
    this.connected = false;
    this.sendTail = Promise.resolve();
    this.committedSegments = [];
    this.currentPartial = '';
    this.recoveryPartialPrefix = '';
    this.lastStable = undefined;
    this.sentAudioMs = 0;
    this.startResolve = undefined;
    this.startReject = undefined;
    this.clearUncommittedAudio();
    this.resolveStableWaiters(undefined);
  }

  private addUncommittedAudio(pcm: Buffer, durationMs: number): void {
    this.uncommittedAudio.push({ pcm, durationMs, addedAt: Date.now() });
    this.uncommittedAudioMs += durationMs;
    while (this.uncommittedAudioMs > MAX_REPLAY_AUDIO_MS && this.uncommittedAudio.length > 1) {
      const removed = this.uncommittedAudio.shift();
      if (!removed) break;
      this.uncommittedAudioMs -= removed.durationMs;
    }
  }

  private clearUncommittedAudio(): void {
    this.uncommittedAudio = [];
    this.uncommittedAudioMs = 0;
  }

  private trimUncommittedAudioOlderThan(cutoffMs: number): void {
    while (this.uncommittedAudio.length > 1 && this.uncommittedAudio[0]!.addedAt < cutoffMs) {
      const removed = this.uncommittedAudio.shift();
      if (!removed) break;
      this.uncommittedAudioMs = Math.max(0, this.uncommittedAudioMs - removed.durationMs);
    }
  }
}

export function buildElevenLabsScribeRealtimeUrl(input: {
  baseUrl: string;
  sourceLanguage?: string;
  vadSilenceThresholdSecs?: number;
}): string {
  const url = new URL(joinProxyPath(input.baseUrl, '/v1/speech-to-text/realtime'));
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('model_id', SCRIBE_REALTIME_MODEL);
  url.searchParams.set('audio_format', 'pcm_16000');
  url.searchParams.set('commit_strategy', 'vad');
  url.searchParams.set('include_timestamps', 'false');
  url.searchParams.set('include_language_detection', 'true');
  url.searchParams.set('vad_silence_threshold_secs', (input.vadSilenceThresholdSecs ?? 1.5).toFixed(2));

  const language = elevenLabsLanguageCode(input.sourceLanguage ?? 'auto');
  if (language) url.searchParams.set('language_code', language);
  return url.toString();
}

export function composeScribeTranscript(committedSegments: string[], partial: string): string {
  return [...committedSegments, partial]
    .map((text) => text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?，。！？；;：:])/g, '$1')
    .replace(/([，。！？；：])\s+/g, '$1')
    .replace(/([\p{Script=Han}])\s+([\p{Script=Han}])/gu, '$1$2')
    .trim();
}

function joinProxyPath(baseUrl: string, endpointPath: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${endpointPath.trim().replace(/^\/+/, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasSpeechContent(text: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(text);
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function estimatePcm16kDurationMs(byteLength: number): number {
  return byteLength / PCM_16K_BYTES_PER_MS;
}

function safeUrlHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return 'unknown';
  }
}
