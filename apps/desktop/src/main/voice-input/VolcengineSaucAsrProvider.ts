import WebSocket from 'ws';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';
import { createLogger } from '../logger.js';
import { resamplePcm16 } from './RealtimeAsrWebSocketProvider.js';
import { mergeRecoveredTranscript } from './transcriptMerge.js';
import { describeAsrHandshakeTraceId, describeAsrWebSocketTarget } from './voiceInputAsrConfig.js';

type VolcengineSaucAsrProviderOptions = {
  proxyApiKey?: string;
  baseUrl?: string;
  endpointPath?: string;
  connectionProvider?: () => Promise<{ websocketUrl: string; authorizationToken: string }>;
  resourceId: string;
  sourceLanguage?: string;
  pcmSampleRate?: number;
  connectTimeoutMs?: number;
  missingCredentialMessage?: string;
  errorFallbackMessage?: string;
};

const log = createLogger('voice-input:volcengine-sauc-asr');
const DEFAULT_PCM_SAMPLE_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 5_000;
const FLUSH_TIMEOUT_MS = 4_000;
const RECOVER_TIMEOUT_MS = 5_000;
const KEEPALIVE_PING_INTERVAL_MS = 25_000;
const KEEPALIVE_PONG_TIMEOUT_MS = 8_000;
const MODEL_NAME = 'bigmodel';
const NONSTREAM_END_WINDOW_MS = 300;
const MAX_REPLAY_AUDIO_MS = 60_000;
const CONFIRMED_AUDIO_RETENTION_MS = 1_500;

const PROTOCOL_VERSION = 0x1;
const HEADER_SIZE_WORDS = 0x1;
const SERIALIZATION_NONE = 0x0;
const SERIALIZATION_JSON = 0x1;
const COMPRESSION_NONE = 0x0;
const COMPRESSION_GZIP = 0x1;

const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1;
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0x9;
const MESSAGE_TYPE_SERVER_ACK = 0xb;
const MESSAGE_TYPE_SERVER_ERROR = 0xf;

const FLAG_NO_SEQUENCE = 0x0;
const FLAG_POSITIVE_SEQUENCE = 0x1;
const FLAG_NEGATIVE_SEQUENCE = 0x3;

type ParsedVolcengineMessage = {
  messageType: number;
  flags: number;
  sequence?: number;
  payload?: unknown;
  payloadText?: string;
};

type ReplayAudioChunk = {
  pcm: Buffer;
  durationMs: number;
  addedAt: number;
  sent: boolean;
};

/**
 * Volcengine SAUC streaming ASR provider routed through XD LiteLLM.
 *
 * This is intentionally separate from RealtimeAsrWebSocketProvider: the
 * endpoint is provider-native (`/volcengine/api/v3/sauc/bigmodel_async`), has
 * no model id, and uses Volcengine's compressed binary websocket protocol
 * instead of OpenAI-compatible realtime JSON events.
 */
export class VolcengineSaucAsrProvider implements AsrProvider {
  private readonly proxyApiKey?: string;
  private readonly baseUrl?: string;
  private readonly endpointPath?: string;
  private readonly connectionProvider?: () => Promise<{ websocketUrl: string; authorizationToken: string }>;
  private readonly resourceId: string;
  private readonly sourceLanguage: string;
  private readonly pcmSampleRate: number;
  private readonly connectTimeoutMs: number;
  private readonly missingCredentialMessage: string;
  private readonly errorFallbackMessage: string;
  private socket?: WebSocket;
  private callback: (event: AsrEvent) => void = () => {};
  private connected = false;
  private started = false;
  private sequence = 1;
  private sentAudioMs = 0;
  private pendingFinalAudioChunk?: ReplayAudioChunk;
  private lastTranscript = '';
  private sessionTranscriptPrefix = '';
  private unconfirmedAudio: ReplayAudioChunk[] = [];
  private unconfirmedAudioMs = 0;
  private flushResolvers: Array<() => void> = [];
  private finalRequested = false;
  private stableEmitted = false;
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private pongTimeoutTimer?: ReturnType<typeof setTimeout>;
  private recoveryPromise?: Promise<void>;
  private stopRequested = false;
  private startResolve?: () => void;
  private startReject?: (error: Error) => void;

  constructor(options: VolcengineSaucAsrProviderOptions) {
    this.proxyApiKey = options.proxyApiKey;
    this.baseUrl = options.baseUrl;
    this.endpointPath = options.endpointPath;
    this.connectionProvider = options.connectionProvider;
    this.resourceId = options.resourceId;
    this.sourceLanguage = options.sourceLanguage ?? 'auto';
    this.pcmSampleRate = options.pcmSampleRate ?? DEFAULT_PCM_SAMPLE_RATE;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.missingCredentialMessage = options.missingCredentialMessage ?? 'API key is required for Volcengine SAUC ASR.';
    this.errorFallbackMessage = options.errorFallbackMessage ?? 'Volcengine SAUC transcription failed.';
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (!this.connectionProvider && !this.proxyApiKey) throw new Error(this.missingCredentialMessage);
    if (!this.connectionProvider && !this.baseUrl) throw new Error('Missing XD Gateway base URL');
    this.resetState();
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    const connection = this.connectionProvider
      ? await this.connectionProvider()
      : {
          websocketUrl: toWebSocketUrl(this.baseUrl!, this.endpointPath!),
          authorizationToken: this.proxyApiKey!,
        };
    if (this.stopRequested) throw new Error('Volcengine SAUC ASR connection stopped.');
    const socket = new WebSocket(connection.websocketUrl, {
      headers: {
        Authorization: `Bearer ${connection.authorizationToken}`,
        'X-Api-Resource-Id': this.resourceId,
        'X-Api-Connect-Id': buildConnectId(),
      },
    });
    this.socket = socket;
    this.attachSocketHandlers(socket);
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
          this.started = false;
        }
        if (terminateSocket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          socket.terminate();
        }
        reject(error);
      };
      // Do not let provider-native WebSocket startup hang forever. Renderer
      // waits for voice-input:start before it can stop normally; a bounded
      // connect failure keeps the UI from falling back to its generic
      // "did not finish starting" watchdog.
      const connectTimer = setTimeout(() => {
        log.warn('volcengine sauc connection timed out before ready', {
          timeoutMs: this.connectTimeoutMs,
        });
        fail(new Error(`Volcengine SAUC ASR connection timed out after ${this.connectTimeoutMs}ms`), true);
      }, this.connectTimeoutMs);
      const onOpen = (): void => {
        if (settled) return;
        if (this.stopRequested) {
          fail(new Error('Volcengine SAUC ASR connection opened after stop.'), true);
          return;
        }
        this.startKeepAlive();
        this.sendInitialRequest();
      };
      const onError = (error: Error): void => {
        fail(error, false);
      };
      const onClose = (): void => {
        fail(new Error('Volcengine SAUC ASR connection closed before it was ready.'), false);
      };
      const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage): void => {
        response.resume();
        const statusCode = response.statusCode ?? 'unknown';
        const statusMessage = response.statusMessage ? ` ${response.statusMessage}` : '';
        // Include the dialed host/path + gateway trace id: a handshake 404
        // against a gateway missing the ASR passthrough route is otherwise
        // indistinguishable from an upstream failure (issue #220).
        const traceId = describeAsrHandshakeTraceId(response.headers);
        const target = describeAsrWebSocketTarget(connection.websocketUrl);
        fail(new Error(
          `Volcengine SAUC ASR handshake failed: HTTP ${statusCode}${statusMessage} (${target}${traceId ? `, ${traceId}` : ''})`,
        ), true);
      };
      this.startResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.connected = true;
        this.started = true;
        this.callback({ type: 'connected', at: Date.now() });
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
    if (!this.started) return;
    const inputRate = trace?.sampleRate ?? DEFAULT_PCM_SAMPLE_RATE;
    const pcm = resamplePcm16(Buffer.from(chunk), inputRate, this.pcmSampleRate);
    if (pcm.length === 0) return;
    const durationMs = trace?.durationMs ?? estimatePcmDurationMs(chunk.byteLength, inputRate);
    this.sentAudioMs += durationMs;
    const entry = this.addUnconfirmedAudio(pcm, durationMs);
    const socket = this.socket;
    if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) return;
    // Volcengine's binary protocol marks the last audio packet via the
    // message-type flag. Keep one chunk back so flush can send that real final
    // audio packet with a negative sequence instead of sending an empty final
    // marker that may cut off the tail.
    if (this.pendingFinalAudioChunk) {
      this.sendAudioEntry(this.pendingFinalAudioChunk, socket);
    }
    this.pendingFinalAudioChunk = entry;
  }

  async flushAudio(): Promise<void> {
    if (this.stopRequested || !this.started || this.finalRequested) return;
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise,
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (this.sentAudioMs <= 0) return;
    this.finalRequested = true;
    if (this.pendingFinalAudioChunk) {
      this.sendAudioEntry(this.pendingFinalAudioChunk, socket);
    }
    this.pendingFinalAudioChunk = undefined;
    // SAUC's two-pass mode finalizes utterances through VAD. Send a short
    // silence packet as the protocol-level final audio packet so the last
    // spoken word has a chance to enter the definite result instead of being
    // cut off by an empty final marker.
    const finalChunk = silencePcm16(this.pcmSampleRate, NONSTREAM_END_WINDOW_MS);
    socket.send(encodeAudioOnlyRequest(finalChunk, -this.nextSequence()));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      this.flushResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.lastTranscript && !this.stableEmitted) {
      this.callback({ type: 'stable', text: this.lastTranscript, at: Date.now() });
      this.stableEmitted = true;
    }
  }

  async recover(): Promise<void> {
    if (this.stopRequested || !this.started) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.performRecover().finally(() => {
      this.recoveryPromise = undefined;
    });
    return this.recoveryPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.started = false;
    this.connected = false;
    this.startReject?.(new Error('Volcengine SAUC stopped before the protocol was ready.'));
    this.pendingFinalAudioChunk = undefined;
    this.clearUnconfirmedAudio();
    this.sessionTranscriptPrefix = '';
    this.teardownSocketForReconnect();
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    this.teardownSocketForReconnect();
    this.callback({ type: 'disconnected', at: Date.now() });
  }

  private resetState(): void {
    this.stopRequested = false;
    this.stopKeepAlive();
    // The initial full client request is auto-assigned sequence 1 by
    // Volcengine SAUC, so the first audio-only request must start at 2.
    this.sequence = 1;
    this.sentAudioMs = 0;
    this.pendingFinalAudioChunk = undefined;
    this.lastTranscript = '';
    this.sessionTranscriptPrefix = '';
    this.clearUnconfirmedAudio();
    this.finalRequested = false;
    this.stableEmitted = false;
    this.startResolve = undefined;
    this.startReject = undefined;
    this.resolveFlushWaiters();
  }

  private async performRecover(): Promise<void> {
    const prefix = this.lastTranscript;
    const initialReplayMs = this.unconfirmedAudioMs;
    const startedAt = Date.now();

    log.info('recover: reconnecting Volcengine SAUC and replaying unconfirmed audio', {
      replayChunks: this.unconfirmedAudio.length,
      replayMs: Math.round(initialReplayMs),
      prefixChars: prefix.length,
    });

    this.teardownSocketForReconnect();
    // A recovered SAUC websocket is a new provider-native session, but its
    // transcript must visually continue the old one. Preserve the delivered
    // prefix and replay audio that has not yet been confirmed, plus a tiny
    // recently-confirmed tail so network recovery cannot drop words that were
    // sent just before the partial transcript arrived.
    this.sequence = 1;
    this.pendingFinalAudioChunk = undefined;
    this.finalRequested = false;
    this.stableEmitted = false;
    this.sessionTranscriptPrefix = prefix;

    // openSocket() owns the provider startup boundary, including connect
    // timeout and handshake failure. Reusing that single boundary here keeps
    // recovery failure logs consistent with first-start failures.
    await this.openSocket();
    if (this.stopRequested) {
      this.teardownSocketForReconnect();
      return;
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Volcengine SAUC ASR recover reconnected without an open socket.');
    }
    const replay = [...this.unconfirmedAudio];
    const replayMs = replay.reduce((sum, item) => sum + item.durationMs, 0);
    for (const entry of replay) {
      socket.send(encodeAudioOnlyRequest(entry.pcm, this.nextSequence()));
      entry.sent = true;
    }

    log.info('recover: Volcengine SAUC replay complete', {
      replayChunks: replay.length,
      replayMs: Math.round(replayMs),
      elapsedMs: Date.now() - startedAt,
    });
  }

  private teardownSocketForReconnect(): void {
    this.connected = false;
    this.stopKeepAlive();
    this.resolveFlushWaiters();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      this.handleMessage(rawDataToBuffer(data));
    });
    socket.on('pong', () => {
      if (this.socket !== socket) return;
      this.clearPongTimeout();
    });
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      log.debug('volcengine sauc connection closed', {
        code,
        reason: reason.toString('utf8'),
      });
      this.connected = false;
      this.stopKeepAlive();
      this.resolveFlushWaiters();
      this.callback({ type: 'disconnected', at: Date.now() });
    });
    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      log.warn('volcengine sauc connection error', { error: error.message });
      this.connected = false;
      this.stopKeepAlive();
      this.resolveFlushWaiters();
      this.callback({ type: 'error', message: error.message || this.errorFallbackMessage, at: Date.now() });
    });
  }

  private sendInitialRequest(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeFullClientRequest({
      user: {
        uid: 'xdt-maker',
      },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: this.pcmSampleRate,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: MODEL_NAME,
        result_type: 'full',
        show_utterances: true,
        enable_nonstream: true,
        end_window_size: NONSTREAM_END_WINDOW_MS,
        enable_punc: true,
        enable_itn: true,
        ...(this.sourceLanguage && this.sourceLanguage.toLowerCase() !== 'auto'
          ? { language: this.sourceLanguage }
          : {}),
      },
    }));
  }

  private handleMessage(data: Buffer): void {
    let message: ParsedVolcengineMessage;
    try {
      message = decodeVolcengineMessage(data);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      log.warn('failed to decode volcengine sauc message', { error: messageText });
      this.callback({ type: 'error', message: this.errorFallbackMessage, at: Date.now() });
      this.startReject?.(new Error(this.errorFallbackMessage));
      this.resolveFlushWaiters();
      return;
    }
    if (message.messageType === MESSAGE_TYPE_SERVER_ERROR) {
      const errorMessage = extractErrorMessage(message.payload) ?? message.payloadText ?? this.errorFallbackMessage;
      this.callback({ type: 'error', message: errorMessage, at: Date.now() });
      this.startReject?.(new Error(errorMessage));
      this.resolveFlushWaiters();
      return;
    }
    if (message.messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE && message.messageType !== MESSAGE_TYPE_SERVER_ACK) {
      return;
    }
    this.startResolve?.();

    const rawTranscript = extractTranscript(message.payload);
    const transcript = mergeRecoveredTranscript(this.sessionTranscriptPrefix, rawTranscript);
    // `definite` is a two-pass utterance marker. It can stabilize visible text,
    // but only the protocol last-response flag means stop-time ASR finalization is complete.
    const isDefinite = hasDefiniteUtterance(message.payload);
    const isLastResponse = isProtocolLastResponse(message);
    if (rawTranscript) {
      this.clearConfirmedAudio(Date.now() - CONFIRMED_AUDIO_RETENTION_MS);
    }
    if (transcript && transcript !== this.lastTranscript) {
      this.lastTranscript = transcript;
      this.callback({
        type: isDefinite ? 'stable' : 'partial',
        text: transcript,
        at: Date.now(),
      });
      if (isDefinite) {
        this.stableEmitted = true;
      }
    }
    if (this.finalRequested && isLastResponse) {
      this.resolveFlushWaiters();
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private sendAudioEntry(entry: ReplayAudioChunk, socket: WebSocket): void {
    socket.send(encodeAudioOnlyRequest(entry.pcm, this.nextSequence()));
    entry.sent = true;
  }

  private addUnconfirmedAudio(pcm: Buffer, durationMs: number): ReplayAudioChunk {
    const entry: ReplayAudioChunk = {
      pcm,
      durationMs,
      addedAt: Date.now(),
      sent: false,
    };
    this.unconfirmedAudio.push(entry);
    this.unconfirmedAudioMs += durationMs;
    this.pruneReplayAudio();
    return entry;
  }

  private clearConfirmedAudio(cutoffMs: number): void {
    if (this.unconfirmedAudio.length === 0) return;
    this.unconfirmedAudio = this.unconfirmedAudio.filter((entry) => !entry.sent || entry.addedAt >= cutoffMs);
    this.unconfirmedAudioMs = this.unconfirmedAudio.reduce((sum, entry) => sum + entry.durationMs, 0);
  }

  private clearUnconfirmedAudio(): void {
    this.unconfirmedAudio = [];
    this.unconfirmedAudioMs = 0;
  }

  private pruneReplayAudio(): void {
    while (this.unconfirmedAudioMs > MAX_REPLAY_AUDIO_MS && this.unconfirmedAudio.length > 1) {
      const removed = this.unconfirmedAudio.shift();
      if (!removed) break;
      this.unconfirmedAudioMs -= removed.durationMs;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.ping();
        this.armPongTimeout(socket);
      } catch (error) {
        log.debug('volcengine sauc keepalive ping failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, KEEPALIVE_PING_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== undefined) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    this.clearPongTimeout();
  }

  private armPongTimeout(socket: WebSocket): void {
    this.clearPongTimeout();
    this.pongTimeoutTimer = setTimeout(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      log.warn('volcengine sauc keepalive pong timeout, terminating socket');
      socket.terminate();
    }, KEEPALIVE_PONG_TIMEOUT_MS);
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer === undefined) return;
    clearTimeout(this.pongTimeoutTimer);
    this.pongTimeoutTimer = undefined;
  }

  private resolveFlushWaiters(): void {
    this.flushResolvers.splice(0).forEach((resolve) => resolve());
  }
}

export function encodeFullClientRequest(payload: Record<string, unknown>): Buffer {
  return encodeVolcengineRequest({
    messageType: MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    flags: FLAG_NO_SEQUENCE,
    serialization: SERIALIZATION_JSON,
    compression: COMPRESSION_GZIP,
    payload: Buffer.from(JSON.stringify(payload), 'utf8'),
  });
}

export function encodeAudioOnlyRequest(pcm: Buffer, sequence: number): Buffer {
  const hasPayload = pcm.length > 0;
  return encodeVolcengineRequest({
    messageType: MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    flags: sequence < 0
      ? FLAG_NEGATIVE_SEQUENCE
      : FLAG_POSITIVE_SEQUENCE,
    sequence,
    serialization: SERIALIZATION_NONE,
    compression: hasPayload ? COMPRESSION_GZIP : COMPRESSION_NONE,
    payload: pcm,
  });
}

function encodeVolcengineRequest(input: {
  messageType: number;
  flags: number;
  sequence?: number;
  serialization: number;
  compression: number;
  payload: Buffer;
}): Buffer {
  const compressedPayload = input.compression === COMPRESSION_GZIP ? gzipSync(input.payload) : input.payload;
  const header = Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
    (input.messageType << 4) | input.flags,
    (input.serialization << 4) | input.compression,
    0x00,
  ]);
  const sequence = input.flags === FLAG_NO_SEQUENCE ? Buffer.alloc(0) : Buffer.alloc(4);
  if (sequence.length > 0) sequence.writeInt32BE(input.sequence ?? 0, 0);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(compressedPayload.length, 0);
  return Buffer.concat([header, sequence, payloadSize, compressedPayload]);
}

export function decodeVolcengineMessage(data: Buffer): ParsedVolcengineMessage {
  if (data.length < 4) {
    return { messageType: 0, flags: 0 };
  }
  const headerSize = (data[0] & 0x0f) * 4;
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let offset = headerSize;
  let sequence: number | undefined;
  if (messageType === MESSAGE_TYPE_SERVER_ERROR) {
    if (data.length < offset + 8) return { messageType, flags };
    const code = data.readInt32BE(offset);
    offset += 4;
    const payloadSize = data.readUInt32BE(offset);
    offset += 4;
    if (payloadSize <= 0 || data.length < offset + payloadSize) {
      return { messageType, flags, payload: { code } };
    }
    let payloadBuffer = data.subarray(offset, offset + payloadSize);
    if (compression === COMPRESSION_GZIP) {
      payloadBuffer = gunzipSync(payloadBuffer);
    }
    const payloadText = payloadBuffer.toString('utf8');
    return { messageType, flags, payload: { code, message: payloadText }, payloadText };
  }
  if (flags === FLAG_POSITIVE_SEQUENCE || flags === FLAG_NEGATIVE_SEQUENCE) {
    if (data.length < offset + 4) return { messageType, flags };
    sequence = data.readInt32BE(offset);
    offset += 4;
  }
  if (data.length < offset + 4) return { messageType, flags, sequence };
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  if (payloadSize <= 0 || data.length < offset + payloadSize) {
    return { messageType, flags, sequence };
  }
  let payloadBuffer = data.subarray(offset, offset + payloadSize);
  if (compression === COMPRESSION_GZIP) {
    payloadBuffer = gunzipSync(payloadBuffer);
  }
  const payloadText = payloadBuffer.toString('utf8');
  if (serialization === SERIALIZATION_JSON || looksLikeJson(payloadText)) {
    try {
      return { messageType, flags, sequence, payload: JSON.parse(payloadText), payloadText };
    } catch {
      return { messageType, flags, sequence, payloadText };
    }
  }
  return { messageType, flags, sequence, payloadText };
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function extractTranscript(payload: unknown): string {
  const values = collectStringFields(payload, new Set(['text', 'transcript', 'sentence', 'asr_text']));
  const best = values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  return best ?? '';
}

function extractErrorMessage(payload: unknown): string | undefined {
  const values = collectStringFields(payload, new Set(['message', 'error', 'reason']));
  return values.map((value) => value.trim()).find(Boolean);
}

function hasDefiniteUtterance(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some((item) => hasDefiniteUtterance(item));
  if (!isRecord(payload)) return false;
  if (payload.definite === true) return true;
  return Object.values(payload).some((value) => hasDefiniteUtterance(value));
}

function isProtocolLastResponse(message: ParsedVolcengineMessage): boolean {
  return message.messageType === MESSAGE_TYPE_FULL_SERVER_RESPONSE
    && message.flags === FLAG_NEGATIVE_SEQUENCE;
}

function collectStringFields(value: unknown, keys: Set<string>): string[] {
  if (typeof value === 'string') return [];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStringFields(item, keys));
  const result: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof child === 'string') {
      result.push(child);
    }
    result.push(...collectStringFields(child, keys));
  }
  return result;
}

function toWebSocketUrl(baseUrl: string, endpointPath: string): string {
  const url = new URL(`${trimTrailingSlashes(baseUrl.trim())}/${trimLeadingSlashes(endpointPath.trim())}`);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start += 1;
  return value.slice(start);
}

function buildConnectId(): string {
  return `xdt-maker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function estimatePcmDurationMs(byteLength: number, sampleRate: number): number {
  return byteLength / (sampleRate * 2 / 1000);
}

function silencePcm16(sampleRate: number, durationMs: number): Buffer {
  const sampleCount = Math.max(0, Math.round(sampleRate * durationMs / 1000));
  return Buffer.alloc(sampleCount * 2);
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
