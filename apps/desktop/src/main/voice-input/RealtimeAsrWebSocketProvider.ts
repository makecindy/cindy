import WebSocket from 'ws';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';
import type { VoiceInputRealtimeProtocolProfile } from '../../shared/voiceInputAsrProfiles.js';
import { createLogger } from '../logger.js';
import { createOutboundHttpAgent } from '../maker-host/outbound-fetch.js';
import { openAiLanguageCode } from './language.js';
import { describeAsrHandshakeTraceId, describeAsrWebSocketTarget } from './voiceInputAsrConfig.js';
import {
  VoiceInputSessionRecorder,
  isVoiceInputRecordingEnabled,
  makeRecorderSessionId,
} from './VoiceInputSessionRecorder.js';

export type RealtimeAsrWebSocketProviderOptions = {
  accessTokenProvider: () => Promise<string | null>;
  connectionProvider?: () => Promise<{ websocketUrl: string; authorizationToken: string }>;
  sourceLanguage?: string;
  model?: string;
  realtimeUrl?: string;
  extraHeaders?: Record<string, string>;
  /** Non-secret identity used to prevent warm-socket reuse across credentials. */
  credentialCacheKey?: string;
  pcmSampleRate?: number;
  protocolProfile?: VoiceInputRealtimeProtocolProfile;
  providerKind?: string;
  connectTimeoutMs?: number;
  missingCredentialMessage?: string;
  errorFallbackMessage?: string;
  /** Replace upstream application error text with errorFallbackMessage. */
  redactUpstreamErrors?: boolean;
};

const OPENAI_REALTIME_TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const OPENAI_REALTIME_WHISPER_MODEL = 'gpt-realtime-whisper';
const DEFAULT_REALTIME_PCM_SAMPLE_RATE = 24_000;
const CONNECT_TIMEOUT_MS = 5_000;
const FLUSH_TIMEOUT_MS = 4_000;
const MIN_COMMIT_AUDIO_MS = 100;
const QWEN_SERVER_VAD_THRESHOLD = 0.0;
const QWEN_SERVER_VAD_SILENCE_DURATION_MS = 400;
// Throttle how often we report appendAudio queueing to keep dev logs readable
// when the transport is reconnecting and chunks arrive every ~40ms.
const APPEND_QUEUE_LOG_THROTTLE_MS = 2_000;
// Cap on the unacknowledged-audio replay buffer used during transport
// recover(). 60s of 24 kHz mono PCM16 is ~2.88 MB — well within
// main-process budget — and long enough to cover reconnect windows while
// bounded enough to not pile up indefinitely if the upstream transport stays
// unavailable.
const MAX_REPLAY_BUFFER_MS = 60_000;
const RECOVER_TIMEOUT_MS = 8_000;
// Send a WebSocket ping every 25s. Many corporate NATs / Wi-Fi APs silently
// reap idle TCP connections after 30-60s; a 25s ping keeps the upstream
// firewall map fresh and gives us a way to detect a dead peer that is not
// otherwise surfacing as a close event.
const KEEPALIVE_PING_INTERVAL_MS = 25_000;
const KEEPALIVE_PONG_TIMEOUT_MS = 8_000;
// When a partial arrives, audio sent more than this many milliseconds ago is
// almost certainly already processed on the server side and safe to drop from
// the replay buffer. Audio newer than this might still be in the server's
// pre-partial pipeline and would be LOST when the socket closes — keeping it
// in the replay buffer means a transport recovery re-sends those last frames
// into the fresh session instead of leaving a gap. The cost is a small amount
// of duplicate text at the recovery seam (typically <1 character of overlap),
// which is far less surprising to the user than silently swallowed syllables.
const PARTIAL_CONFIRMATION_LATENCY_MS = 1_500;
// Diagnostic summary cadence. We emit a single "transport_health" debug line
// every N ms while a session is active so post-mortem log inspection can
// answer "were we sending audio? was the server responding?" without having
// to enable the full recorder. Cheap (one log line per interval).
const TRANSPORT_HEALTH_LOG_INTERVAL_MS = 5_000;
const log = createLogger('voice-input:realtime-asr-websocket');

type WarmRealtimeSession = {
  socket: WebSocket;
  connectionKey: string;
  credentialCacheKey: string;
  model: string;
  languageCode: string | undefined;
  pcmSampleRate: number;
  protocolProfile: VoiceInputRealtimeProtocolProfile;
  createdAt: number;
  ready: boolean;
  // Resolves when session.updated has been received (so the socket is
  // actually usable for transcription), rejects on handshake error / close.
  // Stored so a second prewarm call with matching config awaits the existing
  // handshake instead of returning Promise.resolve() while the socket is
  // still in CONNECTING — which used to mislead benchmark + production paths
  // into thinking prewarm was complete when it wasn't.
  readyPromise: Promise<void>;
  detach: () => void;
  close: () => void;
};

type TakenWarmRealtimeSession = {
  socket: WebSocket;
  needsSessionUpdate: boolean;
  ageMs: number;
};

let warmRealtimeSession: WarmRealtimeSession | null = null;
let warmRealtimeSessionGeneration = 0;
// Same-key in-flight dedup: a second prewarm for the SAME (model, language)
// returned the same in-flight promise immediately. Kept for callers that
// want fast same-config short-circuit before the chain serializer below.
const inFlightWarmPrewarms = new Map<string, Promise<void>>();
// Different-key serializer: all createWarmRealtimeSession calls are
// queued through this chain so two concurrent prewarms with different
// configs (e.g. user toggles language inside 200ms) cannot both open a
// socket and race to assign warmRealtimeSession. Each link re-checks the
// world after its turn — if a previously queued prewarm already settled a
// matching warm session, the later link returns without creating another.
let warmPrewarmChain: Promise<void> = Promise.resolve();

export function invalidatePrewarmedRealtimeAsrWebSocketSession(): void {
  warmRealtimeSessionGeneration += 1;
  inFlightWarmPrewarms.clear();
  warmRealtimeSession?.close();
  warmRealtimeSession = null;
}

type RealtimeConnectionConfig = {
  realtimeUrl: string;
  extraHeaders: Record<string, string>;
  connectionKey: string;
};

function resolveRealtimeConnectionConfig(options: RealtimeAsrWebSocketProviderOptions): RealtimeConnectionConfig {
  const realtimeUrl = options.realtimeUrl ?? OPENAI_REALTIME_TRANSCRIPTION_URL;
  const extraHeaders = normalizeExtraHeaders(options.extraHeaders);
  return {
    realtimeUrl,
    extraHeaders,
    connectionKey: realtimeConnectionKey(realtimeUrl, extraHeaders),
  };
}

function normalizeExtraHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerName = key.trim();
    const headerValue = value.trim();
    if (!headerName || !headerValue) continue;
    normalized[headerName] = headerValue;
  }
  return normalized;
}

function realtimeConnectionKey(realtimeUrl: string, extraHeaders: Record<string, string>): string {
  const headerKey = Object.entries(extraHeaders)
    .map(([key, value]) => `${key.toLowerCase()}=${value}`)
    .sort()
    .join('&');
  return `${realtimeUrl}::${headerKey}`;
}

function realtimeHeaders(accessToken: string, extraHeaders: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extraHeaders,
  };
}

function warmConfigKey(
  connectionKey: string,
  credentialCacheKey: string,
  model: string,
  languageCode: string | undefined,
  pcmSampleRate: number,
  protocolProfile: VoiceInputRealtimeProtocolProfile,
): string {
  return `${connectionKey}::credential-${credentialCacheKey}::${model}::${languageCode ?? ''}::pcm-${pcmSampleRate}::${protocolProfile}`;
}

function isExistingWarmMatch(
  existing: WarmRealtimeSession | null,
  connectionKey: string,
  credentialCacheKey: string,
  model: string,
  languageCode: string | undefined,
  pcmSampleRate: number,
  protocolProfile: VoiceInputRealtimeProtocolProfile,
): boolean {
  if (!existing) return false;
  if (existing.connectionKey !== connectionKey) return false;
  if (existing.credentialCacheKey !== credentialCacheKey) return false;
  if (existing.model !== model) return false;
  if (existing.languageCode !== languageCode) return false;
  if (existing.pcmSampleRate !== pcmSampleRate) return false;
  if (existing.protocolProfile !== protocolProfile) return false;
  if (existing.socket.readyState === WebSocket.CLOSING) return false;
  if (existing.socket.readyState === WebSocket.CLOSED) return false;
  return true;
}

export function prewarmRealtimeAsrWebSocketSession(options: RealtimeAsrWebSocketProviderOptions): Promise<void> {
  const generation = warmRealtimeSessionGeneration;
  const model = options.model ?? OPENAI_REALTIME_WHISPER_MODEL;
  const sourceLanguage = options.sourceLanguage ?? 'auto';
  const languageCode = openAiLanguageCode(sourceLanguage);
  const pcmSampleRate = options.pcmSampleRate ?? DEFAULT_REALTIME_PCM_SAMPLE_RATE;
  const protocolProfile = options.protocolProfile ?? 'openai-transcription-manual';
  const credentialCacheKey = options.credentialCacheKey ?? '';
  const connection = resolveRealtimeConnectionConfig(options);
  const configKey = warmConfigKey(
    connection.connectionKey,
    credentialCacheKey,
    model,
    languageCode,
    pcmSampleRate,
    protocolProfile,
  );

  // Fast-path 1: an existing warm session already matches.
  if (isExistingWarmMatch(
    warmRealtimeSession,
    connection.connectionKey,
    credentialCacheKey,
    model,
    languageCode,
    pcmSampleRate,
    protocolProfile,
  )) {
    // Return the existing readiness promise — if the socket is still mid-
    // handshake, callers wait for session.updated before treating the warm
    // session as usable. Treat readyPromise rejections as "not warmed" so
    // the caller's broader prewarm flow can fall through gracefully.
    return warmRealtimeSession!.readyPromise.catch(() => undefined);
  }
  // Fast-path 2: a same-key prewarm is already queued — share its promise.
  const inFlightSameKey = inFlightWarmPrewarms.get(configKey);
  if (inFlightSameKey) return inFlightSameKey;

  // Queue on the global chain so any different-key prewarm finishes (and
  // potentially supersedes our need) before we create another socket.
  const next = warmPrewarmChain.then(async () => {
    if (generation !== warmRealtimeSessionGeneration) return;
    // Re-check after the wait — a prior queued prewarm may have created
    // exactly the warm session we wanted, in which case we're done.
    if (isExistingWarmMatch(
      warmRealtimeSession,
      connection.connectionKey,
      credentialCacheKey,
      model,
      languageCode,
      pcmSampleRate,
      protocolProfile,
    )) {
      return;
    }
    // Otherwise tear down whatever's there (different config) and create
    // ours. createWarmRealtimeSession returns a promise that settles when
    // session.updated arrives; awaiting here keeps the chain serialized.
    warmRealtimeSession?.close();
    await createWarmRealtimeSession(
      options,
      connection,
      generation,
      credentialCacheKey,
      model,
      sourceLanguage,
      languageCode,
      pcmSampleRate,
      protocolProfile,
    );
  });
  warmPrewarmChain = next.catch(() => undefined);
  inFlightWarmPrewarms.set(configKey, next);
  void next.finally(() => {
    if (inFlightWarmPrewarms.get(configKey) === next) {
      inFlightWarmPrewarms.delete(configKey);
    }
  });
  return next;
}

function takeWarmRealtimeSession(
  connectionKey: string,
  credentialCacheKey: string,
  model: string,
  sourceLanguage: string,
  pcmSampleRate: number,
  protocolProfile: VoiceInputRealtimeProtocolProfile,
): TakenWarmRealtimeSession | null {
  const warm = warmRealtimeSession;
  if (!warm) return null;
  if (!warm.ready || warm.socket.readyState !== WebSocket.OPEN) return null;
  if (warm.connectionKey !== connectionKey) {
    warm.close();
    return null;
  }
  if (warm.credentialCacheKey !== credentialCacheKey) {
    warm.close();
    return null;
  }
  if (warm.model !== model) {
    warm.close();
    return null;
  }
  if (warm.pcmSampleRate !== pcmSampleRate) {
    warm.close();
    return null;
  }
  if (warm.protocolProfile !== protocolProfile) {
    warm.close();
    return null;
  }
  warmRealtimeSession = null;
  warm.detach();
  const languageCode = openAiLanguageCode(sourceLanguage);
  return {
    socket: warm.socket,
    needsSessionUpdate: warm.languageCode !== languageCode,
    ageMs: Date.now() - warm.createdAt,
  };
}

function createWarmRealtimeSession(
  options: RealtimeAsrWebSocketProviderOptions,
  connection: RealtimeConnectionConfig,
  generation: number,
  credentialCacheKey: string,
  model: string,
  sourceLanguage: string,
  languageCode: string | undefined,
  pcmSampleRate: number,
  protocolProfile: VoiceInputRealtimeProtocolProfile,
): Promise<void> {
  // Capture the readiness promise here so the warm session object can store
  // a reference to it (see WarmRealtimeSession.readyPromise). A subsequent
  // prewarm call with matching config can then await this exact handshake
  // instead of returning Promise.resolve() while the socket is still in
  // CONNECTING / pre-session.updated state.
  const readyPromise: Promise<void> = (async (): Promise<void> => {
    const accessToken = await options.accessTokenProvider();
    if (!accessToken) return;
    if (generation !== warmRealtimeSessionGeneration) return;

    // `ws` 不吃系统代理;直连时 agent 为 undefined,行为与不传一致。
    const wsAgent = await createOutboundHttpAgent(connection.realtimeUrl);
    // 代理解析是一次异步往返,期间预热世代可能已经翻篇(用户开录 / 换配置),
    // 那就别再建这条预热连接 —— 它不会被任何人回收。
    if (generation !== warmRealtimeSessionGeneration) return;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(connection.realtimeUrl, {
        headers: realtimeHeaders(accessToken, connection.extraHeaders),
        agent: wsAgent,
      });
      let settled = false;
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
      let pongTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => rejectOnce(new Error('prewarm realtime session timed out')), RECOVER_TIMEOUT_MS);

      const clearPongTimeout = (): void => {
        if (pongTimeoutTimer !== undefined) clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = undefined;
      };
      const clearKeepAlive = (): void => {
        if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
        clearPongTimeout();
      };
      const cleanup = (): void => {
        clearKeepAlive();
        clearTimeout(timer);
        socket.off('open', onOpen);
        socket.off('message', onMessage);
        socket.off('pong', onPong);
        socket.off('close', onClose);
        socket.off('error', onError);
      };
      const detach = (): void => {
        cleanup();
      };
      const close = (): void => {
        if (!settled) {
          settled = true;
          if (warmRealtimeSession?.socket === socket) warmRealtimeSession = null;
          clearKeepAlive();
          clearTimeout(timer);
          socket.off('open', onOpen);
          socket.off('message', onMessage);
          socket.off('pong', onPong);
          reject(new Error('prewarm realtime session invalidated'));
        } else {
          clearKeepAlive();
          clearTimeout(timer);
        }
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        } else {
          cleanup();
        }
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (warmRealtimeSession?.socket === socket) warmRealtimeSession = null;
        cleanup();
        // A readiness failure can happen after the upgrade succeeds. Do not
        // leave that unauthenticated/idle socket alive after its promise has
        // rejected; it can otherwise linger until the upstream closes it.
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
        reject(error);
      };
      const resolveOnce = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Keep the socket and its keepalive alive for reuse, but remove the
        // one-shot readiness listeners. `detach()` later clears keepalive when
        // the provider takes ownership.
        socket.on('pong', onPong);
        socket.on('close', onClose);
        socket.on('error', onError);
        startKeepAlive();
        resolve();
      };
      const startKeepAlive = (): void => {
        clearKeepAlive();
        keepAliveTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          try {
            socket.ping();
            clearPongTimeout();
            pongTimeoutTimer = setTimeout(() => {
              log.debug('prewarm keepalive pong timeout, closing warm socket');
              if (warmRealtimeSession?.socket === socket) warmRealtimeSession = null;
              close();
            }, KEEPALIVE_PONG_TIMEOUT_MS);
          } catch (error) {
            log.debug('prewarm keepalive ping failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }, KEEPALIVE_PING_INTERVAL_MS);
      };
      const onOpen = (): void => {
        socket.send(JSON.stringify(buildSessionUpdateMessage(model, sourceLanguage, pcmSampleRate, protocolProfile)));
      };
      const onPong = (): void => {
        clearPongTimeout();
      };
      const onMessage = (data: WebSocket.RawData): void => {
        let event: unknown;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (!isRecord(event) || typeof event.type !== 'string') return;
        if (event.type === 'session.updated') {
          const warm = warmRealtimeSession;
          if (warm?.socket === socket) warm.ready = true;
          log.debug('prewarmed realtime session ready', {
            model,
            languageCode,
            elapsedMs: Date.now() - (warm?.createdAt ?? Date.now()),
          });
          resolveOnce();
        } else if (event.type === 'error') {
          rejectOnce(new Error(realtimeErrorMessage(
            event,
            options.errorFallbackMessage ?? 'OpenAI realtime transcription failed.',
            options.redactUpstreamErrors,
          )));
        }
      };
      const onClose = (): void => {
        if (warmRealtimeSession?.socket === socket) warmRealtimeSession = null;
        if (!settled) rejectOnce(new Error('prewarm realtime session closed before ready'));
        else cleanup();
      };
      const onError = (error: Error): void => {
        log.debug('prewarm realtime session failed', { error: error.message });
        if (settled) {
          if (warmRealtimeSession?.socket === socket) warmRealtimeSession = null;
          cleanup();
          return;
        }
        rejectOnce(error);
      };

      if (generation !== warmRealtimeSessionGeneration) {
        settled = true;
        cleanup();
        socket.on('error', () => undefined);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        resolve();
        return;
      }
      const nextWarmSession: WarmRealtimeSession = {
        socket,
        connectionKey: connection.connectionKey,
        credentialCacheKey,
        model,
        languageCode,
        pcmSampleRate,
        protocolProfile,
        createdAt: Date.now(),
        ready: false,
        readyPromise,
        detach,
        close,
      };
      socket.on('open', onOpen);
      socket.on('message', onMessage);
      socket.on('pong', onPong);
      socket.on('close', onClose);
      socket.on('error', onError);
      if (generation !== warmRealtimeSessionGeneration) {
        close();
        return;
      }
      warmRealtimeSession = nextWarmSession;
    });
  })().catch((error) => {
    log.debug('prewarm realtime session unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return readyPromise;
}

export function buildSessionUpdateMessage(
  model: string,
  sourceLanguage: string,
  pcmSampleRate = DEFAULT_REALTIME_PCM_SAMPLE_RATE,
  protocolProfile: VoiceInputRealtimeProtocolProfile = 'openai-transcription-manual',
): Record<string, unknown> {
  const language = openAiLanguageCode(sourceLanguage);
  if (protocolProfile === 'qwen-asr-server-vad') {
    // DashScope realtime ASR is not wire-compatible with OpenAI's nested
    // transcription session schema. It also uses DashScope's audio format
    // label (`pcm`) rather than OpenAI's `pcm16`; LiteLLM passes this value
    // through and Qwen rejects `pcm16`. The service runs in server-VAD mode:
    // it emits speech_started/speech_stopped and commits audio on its own, so
    // this profile deliberately does not use client-side
    // input_audio_buffer.commit on stop.
    return {
      event_id: buildRealtimeEventId('session_update'),
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        sample_rate: pcmSampleRate,
        input_audio_transcription: {
          ...(language ? { language } : {}),
        },
        turn_detection: {
          type: 'server_vad',
          threshold: QWEN_SERVER_VAD_THRESHOLD,
          silence_duration_ms: QWEN_SERVER_VAD_SILENCE_DURATION_MS,
        },
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: pcmSampleRate },
          transcription: {
            model,
            ...(language ? { language } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
}

function buildAppendAudioMessage(
  audioBase64: string,
  protocolProfile: VoiceInputRealtimeProtocolProfile,
): Record<string, unknown> {
  return {
    ...(protocolProfile === 'qwen-asr-server-vad' ? { event_id: buildRealtimeEventId('append') } : {}),
    type: 'input_audio_buffer.append',
    audio: audioBase64,
  };
}

function buildFinishSessionMessage(protocolProfile: VoiceInputRealtimeProtocolProfile): Record<string, unknown> {
  return {
    ...(protocolProfile === 'qwen-asr-server-vad' ? { event_id: buildRealtimeEventId('finish') } : {}),
    type: 'session.finish',
  };
}

function buildRealtimeEventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Realtime transcription provider for OpenAI-compatible ASR sockets.
 *
 * The renderer still owns microphone capture. This main-process provider keeps
 * credentials private, converts 16 kHz PCM to the upstream-required sample
 * rate, and emits aggregate transcript drafts as realtime deltas arrive. The
 * protocol profile decides whether stop finalizes by client commit (OpenAI) or
 * by server-VAD session finish (Qwen/DashScope).
 */
export class RealtimeAsrWebSocketProvider implements AsrProvider {
  private readonly accessTokenProvider: () => Promise<string | null>;
  private readonly connectionProvider?: () => Promise<{ websocketUrl: string; authorizationToken: string }>;
  private readonly sourceLanguage: string;
  private readonly model: string;
  private readonly realtimeUrl: string;
  private activeRealtimeUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly connectionKey: string;
  private readonly credentialCacheKey: string;
  private readonly pcmSampleRate: number;
  private readonly protocolProfile: VoiceInputRealtimeProtocolProfile;
  private readonly providerKind: string;
  private readonly connectTimeoutMs: number;
  private readonly missingCredentialMessage: string;
  private readonly errorFallbackMessage: string;
  private readonly redactUpstreamErrors: boolean;
  private socket?: WebSocket;
  private callback: (event: AsrEvent) => void = () => {};
  private connected = false;
  private sessionReady = false;
  private bufferedMs = 0;
  private pendingCommitCount = 0;
  private flushResolvers: Array<() => void> = [];
  private startResolve?: () => void;
  private startReject?: (error: Error) => void;
  private itemOrder: string[] = [];
  private partialsByItem = new Map<string, string>();
  private finalsByItem = new Map<string, string>();
  private intentionalClose = false;
  // Diagnostics: appendAudio is called every ~40ms. If the socket is not OPEN
  // we still keep the chunk in the replay buffer, but it did not leave on the
  // live WebSocket. Track that queued-not-sent-live amount so logs don't make
  // replayable audio look like lost audio.
  private queuedAppendCount = 0;
  private queuedAppendMs = 0;
  private lastQueueLogAt = 0;
  // Application-level keepalive. Even with TCP keepalive, intermediate NATs
  // sometimes drop the connection without the kernel noticing. A periodic WS
  // ping (and a pong deadline) lets us actively confirm the peer is reachable.
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private pongTimeoutTimer?: ReturnType<typeof setTimeout>;
  // Audio that we have shipped to the server but the server has not yet
  // acknowledged with a partial/completed transcription event. Used by
  // recover() to replay into a fresh session after an explicit transport
  // failure, without treating ordinary partial gaps as failures.
  //
  // Stored in the same encoding we send (provider-specific PCM mono format) to
  // avoid re-resampling on replay.
  private unconfirmedAudio: Array<{ pcm: Buffer; durationMs: number; addedAt: number }> = [];
  private unconfirmedAudioMs = 0;
  // Set during recover(); blocks resetTranscriptState from clearing the
  // replay buffer when the helper start() inside recover runs.
  private inRecovery = false;
  private recoveryPromise?: Promise<void>;
  private stopRequested = false;
  // Diagnostic counters reset on every fresh start() (live + recover). Used
  // by the periodic transport_health summary so we can tell post-hoc whether
  // we were sending audio and whether the upstream was responding.
  private sentChunkCount = 0;
  private sentAudioMs = 0;
  private inboundMsgCount = 0;
  private lastInboundType: string | undefined;
  private lastInboundAt = 0;
  private lastSendAt = 0;
  private serverVadFinishRequested = false;
  private healthLogTimer?: ReturnType<typeof setInterval>;
  private inboundTypesSeenThisSession = new Set<string>();
  // Optional full-fidelity recording of audio + WS messages, gated by
  // XDT_VOICE_INPUT_RECORD. One recorder per provider instance.
  private readonly recorder: VoiceInputSessionRecorder | null;

  constructor(options: RealtimeAsrWebSocketProviderOptions) {
    this.accessTokenProvider = options.accessTokenProvider;
    this.connectionProvider = options.connectionProvider;
    this.sourceLanguage = options.sourceLanguage ?? 'auto';
    this.model = options.model ?? OPENAI_REALTIME_WHISPER_MODEL;
    this.pcmSampleRate = options.pcmSampleRate ?? DEFAULT_REALTIME_PCM_SAMPLE_RATE;
    this.protocolProfile = options.protocolProfile ?? 'openai-transcription-manual';
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const connection = resolveRealtimeConnectionConfig(options);
    this.realtimeUrl = connection.realtimeUrl;
    this.activeRealtimeUrl = connection.realtimeUrl;
    this.extraHeaders = connection.extraHeaders;
    this.connectionKey = connection.connectionKey;
    this.credentialCacheKey = options.credentialCacheKey ?? '';
    this.providerKind = options.providerKind ?? 'openai-realtime-whisper';
    this.missingCredentialMessage =
      options.missingCredentialMessage ?? 'Codex ChatGPT login is required for realtime voice input.';
    this.errorFallbackMessage = options.errorFallbackMessage ?? 'OpenAI realtime transcription failed.';
    this.redactUpstreamErrors = options.redactUpstreamErrors === true;
    this.recorder = isVoiceInputRecordingEnabled()
      ? new VoiceInputSessionRecorder(makeRecorderSessionId())
      : null;
    if (this.recorder) {
      this.recorder.init({
        providerKind: this.providerKind,
        model: this.model,
        sourceLanguage: this.sourceLanguage,
        startedAtIso: new Date().toISOString(),
        redactSensitiveWs: this.redactUpstreamErrors,
      });
      log.info('voice input session recording enabled', {
        sessionId: this.recorder.sessionId,
      });
    }
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  async start(options?: { recovering?: boolean }): Promise<void> {
    if (!options?.recovering) this.stopRequested = false;
    const dynamicConnection = this.connectionProvider
      ? await this.connectionProvider()
      : null;
    if (this.stopRequested) throw new Error('Realtime ASR connection stopped.');
    const accessToken = dynamicConnection?.authorizationToken ?? await this.accessTokenProvider();
    if (!accessToken) throw new Error(this.missingCredentialMessage);
    const realtimeUrl = dynamicConnection?.websocketUrl ?? this.realtimeUrl;
    this.activeRealtimeUrl = realtimeUrl;
    this.resetTranscriptState();

    const warm = dynamicConnection ? null : takeWarmRealtimeSession(
      this.connectionKey,
      this.credentialCacheKey,
      this.model,
      this.sourceLanguage,
      this.pcmSampleRate,
      this.protocolProfile,
    );
    if (warm) {
      const socket = warm.socket;
      this.socket = socket;
      this.attachSocketHandlers(socket);
      this.connected = true;
      this.startKeepAlive();
      this.startHealthLog();
      log.debug('using prewarmed realtime session', {
        ageMs: warm.ageMs,
        needsSessionUpdate: warm.needsSessionUpdate,
      });
      if (!warm.needsSessionUpdate) {
        this.sessionReady = true;
        this.callback({ type: 'connected', at: Date.now() });
        return;
      }
      await this.waitForSessionReady(socket, () => this.sendSessionUpdate());
      return;
    }

    const wsAgent = await createOutboundHttpAgent(realtimeUrl);
    // 代理解析期间可能已停录:复查后再建连,不留没人回收的 socket。
    if (this.stopRequested) throw new Error('Realtime ASR connection stopped.');
    const socket = new WebSocket(realtimeUrl, {
      headers: realtimeHeaders(accessToken, this.extraHeaders),
      agent: wsAgent,
    });
    this.socket = socket;
    this.attachSocketHandlers(socket);

    await this.waitForSessionReady(socket, () => {
      socket.once('open', () => {
        this.connected = true;
        this.startKeepAlive();
        this.startHealthLog();
        this.sendSessionUpdate();
      });
    });
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      this.handleMessage(data.toString());
    });
    socket.on('pong', () => {
      if (this.socket !== socket) return;
      // Pong cleared the in-flight timeout. The next ping arms a fresh one.
      this.clearPongTimeout();
    });
    socket.on('close', (code, reason) => {
      const isStale = this.socket !== socket;
      log.debug('connection closed', {
        code,
        reason: reason.toString('utf8'),
        intentional: this.intentionalClose,
        isStale,
        pendingCommitCount: this.pendingCommitCount,
        bufferedMs: Math.round(this.bufferedMs),
        queuedAppendCount: this.queuedAppendCount,
        queuedAppendMs: Math.round(this.queuedAppendMs),
      });
      if (isStale) {
        // recover()/restart() already replaced this socket. The instance
        // fields (intentionalClose, startReject, connected, sessionReady) now
        // belong to the new session — touching them or emitting a disconnect
        // would tear down the live session that just superseded us.
        return;
      }
      const wasIntentional = this.intentionalClose;
      this.connected = false;
      this.sessionReady = false;
      this.stopKeepAlive();
      this.startReject?.(new Error('OpenAI realtime transcription connection closed before it was ready.'));
      this.resolveFlushWaiters();
      if (!wasIntentional) {
        this.callback({ type: 'disconnected', at: Date.now() });
      }
    });
    socket.on('error', (error) => {
      const isStale = this.socket !== socket;
      log.warn('connection error', { error: error.message, isStale });
      if (isStale) return;
      // Force the session into a disconnected shape so appendAudio stops
      // pretending to send and the controller surfaces the failure. Without
      // this, an errored-but-still-OPEN socket would keep accepting appendAudio
      // calls that only pile up in the replay buffer until the user gives up.
      this.connected = false;
      this.sessionReady = false;
      this.stopKeepAlive();
      this.callback({ type: 'error', message: error.message, at: Date.now() });
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    });
  }

  private async waitForSessionReady(socket: WebSocket, begin: () => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(connectTimer);
        socket.off('error', onError);
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
          this.sessionReady = false;
          this.stopKeepAlive();
          this.stopHealthLog();
        }
        if (terminateSocket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          socket.terminate();
        }
        reject(error);
      };
      // All OpenAI-compatible realtime ASR providers wait for the same
      // start barrier: socket open + session.updated. Surface a precise start
      // failure here instead of letting renderer watchdogs show the generic
      // "did not finish starting" message.
      const connectTimer = setTimeout(() => {
        log.warn('realtime asr connection timed out before ready', {
          providerKind: this.providerKind,
          timeoutMs: this.connectTimeoutMs,
        });
        fail(new Error(`Realtime ASR connection timed out after ${this.connectTimeoutMs}ms`), true);
      }, this.connectTimeoutMs);
      const onError = (error: Error): void => {
        fail(error, false);
      };
      const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage): void => {
        response.resume();
        const statusCode = response.statusCode ?? 'unknown';
        if (this.redactUpstreamErrors) {
          const statusSuffix = typeof statusCode === 'number' ? ` (HTTP ${statusCode})` : '';
          fail(new Error(`${this.errorFallbackMessage}${statusSuffix}`), true);
          return;
        }
        const statusMessage = response.statusMessage ? ` ${response.statusMessage}` : '';
        // Include the dialed host/path + gateway trace id: a handshake 404
        // against a gateway missing the ASR passthrough route is otherwise
        // indistinguishable from an upstream failure (issue #220).
        const traceId = describeAsrHandshakeTraceId(response.headers);
        const target = describeAsrWebSocketTarget(this.activeRealtimeUrl);
        fail(new Error(
          `Realtime ASR handshake failed: HTTP ${statusCode}${statusMessage} (${target}${traceId ? `, ${traceId}` : ''})`,
        ), true);
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
      socket.once('error', onError);
      socket.once('unexpected-response', onUnexpectedResponse);
      begin();
    });
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    const inputRate = trace?.sampleRate ?? 16_000;
    const durationMs = trace?.durationMs ?? estimatePcmDurationMs(chunk.byteLength, inputRate);

    // Mirror the original input chunk to disk before any resampling so the
    // recording captures exactly what the mic produced. Cheap when recorder
    // is null; never throws upstream.
    if (this.recorder) {
      this.recorder.recordAudio(Buffer.from(chunk), inputRate);
    }

    // Resample once. We need the provider-specific PCM form for both the live
    // send and the replay buffer, so doing it here avoids a second resample on
    // recover.
    const pcmForProvider = resamplePcm16(Buffer.from(chunk), inputRate, this.pcmSampleRate);
    if (pcmForProvider.length === 0) return;

    // Always retain audio in the unconfirmed-replay buffer, even when the
    // socket is currently down. Transport recovery will dial a fresh session
    // and replay this buffer; chunks captured during the brief reconnect
    // window would otherwise be lost.
    this.bufferUnconfirmedAudio(pcmForProvider, durationMs);

    if (!this.connected || !this.sessionReady || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.queuedAppendCount += 1;
      this.queuedAppendMs += durationMs;
      const now = Date.now();
      if (now - this.lastQueueLogAt >= APPEND_QUEUE_LOG_THROTTLE_MS) {
        this.lastQueueLogAt = now;
        log.debug('appendAudio queued: socket not ready for live transmission', {
          queuedAppendCount: this.queuedAppendCount,
          queuedAppendMs: Math.round(this.queuedAppendMs),
          unconfirmedAudioMs: Math.round(this.unconfirmedAudioMs),
          connected: this.connected,
          sessionReady: this.sessionReady,
          socketReadyState: this.socket?.readyState,
        });
      }
      return;
    }

    this.sendWs(buildAppendAudioMessage(pcmForProvider.toString('base64'), this.protocolProfile));
    this.bufferedMs += durationMs;
    this.sentChunkCount += 1;
    this.sentAudioMs += durationMs;
    this.lastSendAt = Date.now();
  }

  // Single send path so the recorder + per-message logging see EVERY outbound
  // message (sessionUpdate, append, commit) without each call site having to
  // remember to record. Returns true if the message left the socket.
  private sendWs(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    if (this.recorder) {
      this.recorder.recordWs('outbound', message);
    }
    return true;
  }

  private bufferUnconfirmedAudio(pcm: Buffer, durationMs: number): void {
    this.unconfirmedAudio.push({ pcm, durationMs, addedAt: Date.now() });
    this.unconfirmedAudioMs += durationMs;
    while (this.unconfirmedAudioMs > MAX_REPLAY_BUFFER_MS && this.unconfirmedAudio.length > 1) {
      const dropped = this.unconfirmedAudio.shift();
      if (!dropped) break;
      this.unconfirmedAudioMs -= dropped.durationMs;
    }
  }

  private clearUnconfirmedAudio(): void {
    this.unconfirmedAudio = [];
    this.unconfirmedAudioMs = 0;
  }

  // Drop chunks whose `addedAt` is older than `cutoffMs`. Used after a partial
  // event: audio sent more than ~PARTIAL_CONFIRMATION_LATENCY_MS ago is almost
  // certainly already inside the server's transcription pipeline. Newer audio
  // might still be queued and would be lost on socket close, so we keep it in
  // the replay buffer for recover().
  private trimUnconfirmedAudioOlderThan(cutoffMs: number): void {
    while (this.unconfirmedAudio.length > 0 && this.unconfirmedAudio[0].addedAt < cutoffMs) {
      const dropped = this.unconfirmedAudio.shift();
      if (!dropped) break;
      this.unconfirmedAudioMs -= dropped.durationMs;
    }
  }

  async flushAudio(): Promise<void> {
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise,
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    if (this.protocolProfile === 'qwen-asr-server-vad') {
      const finished = this.finishServerVadSession('flush');
      if (!finished) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        this.flushResolvers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return;
    }
    const committed = this.commitBufferedAudio('flush');
    if (!committed) return;
    if (this.pendingCommitCount === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      this.flushResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await this.stopSocket({ forRecovery: false });
  }

  private async stopSocket(options: { forRecovery: boolean }): Promise<void> {
    if (!options.forRecovery) this.stopRequested = true;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.sessionReady = false;
    this.intentionalClose = true;
    this.stopKeepAlive();
    this.stopHealthLog();
    if (this.queuedAppendCount > 0) {
      log.debug('session ended with queued audio that was not sent live', {
        queuedAppendCount: this.queuedAppendCount,
        queuedAppendMs: Math.round(this.queuedAppendMs),
      });
    }
    this.resolveFlushWaiters();
    this.startReject?.(new Error('Realtime ASR stopped before the session was ready.'));
    this.startResolve = undefined;
    this.startReject = undefined;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
    if (!options.forRecovery && this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
      this.teardownRecoveredSocketAfterStop();
    }
    // Recovery also tears down the socket between re-dials; keep the recorder
    // open across that boundary so the WS log captures the full lifetime of
    // the run including replay. Final flush + WAV happens when the controller
    // is done with this provider, signalled by dispose().
  }

  private teardownRecoveredSocketAfterStop(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.sessionReady = false;
    this.stopKeepAlive();
    this.stopHealthLog();
    this.resolveFlushWaiters();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }

  // Called by the IPC handler when the run truly ends (after stop() and any
  // pending refines). Ensures the recorder flushes its WAV/meta before the
  // provider is GC'd.
  async dispose(): Promise<void> {
    // Fallback candidates can be disposed directly when their start attempt
    // times out or loses a hedge. Make dispose self-contained so a provider
    // cannot leave a connecting websocket alive when the wrapper skips it.
    if (!this.stopRequested) await this.stop();
    this.stopHealthLog();
    if (this.recorder) {
      await this.recorder.finalize({
        sentChunkCountFinal: this.sentChunkCount,
        sentAudioMsFinal: Math.round(this.sentAudioMs),
        queuedAppendCountFinal: this.queuedAppendCount,
        queuedAppendMsFinal: Math.round(this.queuedAppendMs),
        inboundMsgCountFinal: this.inboundMsgCount,
        inboundTypesSeen: Array.from(this.inboundTypesSeenThisSession),
      });
    }
  }

  private sendSessionUpdate(): void {
    this.sendWs(buildSessionUpdateMessage(
      this.model,
      this.sourceLanguage,
      this.pcmSampleRate,
      this.protocolProfile,
    ));
  }

  private finishServerVadSession(reason: string): boolean {
    if (this.sentAudioMs <= 0 && this.bufferedMs <= 0) return false;
    log.debug('finish server-vad realtime session', {
      reason,
      bufferedMs: Math.round(this.bufferedMs),
      sentAudioMs: Math.round(this.sentAudioMs),
    });
    const sent = this.sendWs(buildFinishSessionMessage(this.protocolProfile));
    if (sent) {
      this.bufferedMs = 0;
      this.serverVadFinishRequested = true;
    }
    return sent;
  }

  private commitBufferedAudio(reason: string): boolean {
    if (this.bufferedMs <= 0) return false;
    if (this.bufferedMs < MIN_COMMIT_AUDIO_MS) {
      log.debug('skip commit: buffered audio too short', { reason, bufferedMs: Math.round(this.bufferedMs) });
      this.bufferedMs = 0;
      return false;
    }
    log.debug('commit input audio buffer', { reason, bufferedMs: Math.round(this.bufferedMs) });
    if (!this.sendWs({ type: 'input_audio_buffer.commit' })) return false;
    this.bufferedMs = 0;
    this.pendingCommitCount += 1;
    return true;
  }

  private handleMessage(raw: string): void {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(event) || typeof event.type !== 'string') return;
    // Record EVERY inbound message before dispatching. The recorder strips
    // bulky payloads (transcript text included for delta events because it's
    // small enough to keep) so the JSONL stays inspectable. Diagnostic
    // counters are updated in lockstep so the periodic health log can answer
    // "is the server actually responding right now?".
    if (this.recorder) {
      this.recorder.recordWs('inbound', event);
    }
    this.inboundMsgCount += 1;
    this.lastInboundType = event.type;
    this.lastInboundAt = Date.now();
    if (!this.inboundTypesSeenThisSession.has(event.type)) {
      this.inboundTypesSeenThisSession.add(event.type);
      // First time seeing each type per session: log once at debug. delta
      // events are noisy if logged every time but the FIRST one is the most
      // valuable signal post-mortem ("did transcription start at all?").
      log.debug('inbound message type seen', {
        type: event.type,
        sinceConnectMs: this.lastInboundAt - (this.lastSendAt || this.lastInboundAt),
      });
    }

    switch (event.type) {
      case 'session.updated':
        this.sessionReady = true;
        this.callback({ type: 'connected', at: Date.now() });
        this.startResolve?.();
        break;
      case 'input_audio_buffer.committed':
        if (typeof event.item_id === 'string') this.registerItem(event.item_id);
        if (this.protocolProfile === 'qwen-asr-server-vad') this.bufferedMs = 0;
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this.handleDelta(event);
        break;
      case 'conversation.item.input_audio_transcription.text':
        this.handleText(event);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.handleCompleted(event);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        {
          const message = realtimeErrorMessage(
            event,
            this.errorFallbackMessage,
            this.redactUpstreamErrors,
          );
          this.callback({ type: 'error', message, at: Date.now() });
          this.resolveFlushWaiters();
        }
        break;
      case 'error':
        {
          const upstreamMessage = realtimeErrorMessage(event, this.errorFallbackMessage);
          if (this.isNonFatalServerVadFinishError(upstreamMessage)) {
            log.debug('ignore non-fatal server-vad finish error', {
              message: this.redactUpstreamErrors ? this.errorFallbackMessage : upstreamMessage,
              aggregateChars: this.aggregateTranscript().length,
            });
            this.resolveFlushWaiters();
            break;
          }
          const message = this.redactUpstreamErrors
            ? this.errorFallbackMessage
            : upstreamMessage;
          if (!this.sessionReady && this.startReject) {
            this.startReject(new Error(message));
          } else {
            this.callback({ type: 'error', message, at: Date.now() });
          }
        }
        this.resolveFlushWaiters();
        break;
      case 'session.finished':
        this.resolveFlushWaiters();
        break;
    }
  }

  private handleDelta(event: Record<string, unknown>): void {
    if (typeof event.item_id !== 'string' || typeof event.delta !== 'string') return;
    this.registerItem(event.item_id);
    const next = `${this.partialsByItem.get(event.item_id) ?? ''}${event.delta}`;
    this.partialsByItem.set(event.item_id, next);
    // Trim — not clear — the replay buffer. The partial event reflects audio
    // that the server's transcription pipeline has already consumed, but we
    // don't know exactly which frames; the safe assumption is "anything older
    // than the typical pipeline latency". Audio newer than that may still be
    // queued inside the server and would be lost on a transport-recovery
    // socket close. Keeping it in the buffer means recover() re-sends those
    // last frames into the fresh session, at the cost of <1 character of
    // duplicate text at the seam — which is fine, dropping syllables is not.
    this.trimUnconfirmedAudioOlderThan(Date.now() - PARTIAL_CONFIRMATION_LATENCY_MS);
    this.callback({ type: 'partial', text: this.aggregateTranscript(), at: Date.now() });
  }

  private handleText(event: Record<string, unknown>): void {
    if (typeof event.item_id !== 'string' || typeof event.text !== 'string') return;
    this.registerItem(event.item_id);
    // DashScope qwen3-asr-flash-realtime sends `.text` as the current full
    // hypothesis and `.stash` as the unstable preview tail for the item, while
    // OpenAI sends `.delta` as append-only chunks. Store text + stash as a
    // replaceable partial so realtime display tracks upstream corrections
    // without duplicating text on every event; completed.transcript remains the
    // final source of truth.
    const preview = `${event.text}${typeof event.stash === 'string' ? event.stash : ''}`;
    this.partialsByItem.set(event.item_id, preview);
    this.trimUnconfirmedAudioOlderThan(Date.now() - PARTIAL_CONFIRMATION_LATENCY_MS);
    this.callback({ type: 'partial', text: this.aggregateTranscript(), at: Date.now() });
  }

  private isNonFatalServerVadFinishError(message: string): boolean {
    if (this.protocolProfile !== 'qwen-asr-server-vad') return false;
    if (!this.serverVadFinishRequested) return false;
    if (!this.aggregateTranscript()) return false;
    // Official DashScope/Qwen realtime ASR server-VAD mode disables manual
    // input_audio_buffer.commit; stop is finalized with session.finish. Some
    // LiteLLM/DashScope passthrough responses can still surface a late commit
    // buffer error after finish even though transcription text has already
    // arrived. Treat that specific stop-time error as non-fatal so the
    // controller can keep waiting for refinement instead of pasting raw ASR.
    return /input_audio_buffer|commit/i.test(message);
  }

  private handleCompleted(event: Record<string, unknown>): void {
    const itemTranscript = typeof event.transcript === 'string'
      ? event.transcript
      : typeof event.text === 'string'
        ? event.text
        : undefined;
    if (typeof event.item_id !== 'string' || typeof itemTranscript !== 'string') return;
    const partial = this.partialsByItem.get(event.item_id) ?? '';
    const aggregateBefore = this.aggregateTranscript();
    this.registerItem(event.item_id);
    this.finalsByItem.set(event.item_id, itemTranscript);
    this.partialsByItem.delete(event.item_id);
    if (this.pendingCommitCount > 0) this.pendingCommitCount -= 1;
    // A completed item means the server consumed that utterance, not
    // necessarily audio already sent for the next utterance in server-VAD mode.
    // Keep the same short latency tail as partial updates so recover() can
    // replay newer audio if the transport drops right after completion.
    this.trimUnconfirmedAudioOlderThan(Date.now() - PARTIAL_CONFIRMATION_LATENCY_MS);
    const aggregateTranscript = this.aggregateTranscript();
    log.debug('transcription completed', {
      item_id: event.item_id,
      transcriptChars: itemTranscript.length,
      partialChars: partial.length,
      changedFromPartial: partial !== itemTranscript,
      aggregateChars: aggregateTranscript.length,
      changedAggregate: aggregateBefore !== aggregateTranscript,
      pendingCommitCount: this.pendingCommitCount,
    });
    if (aggregateTranscript) this.callback({ type: 'stable', text: aggregateTranscript, at: Date.now() });
    if (this.pendingCommitCount === 0) this.resolveFlushWaiters();
  }

  private registerItem(itemId: string): void {
    if (this.itemOrder.includes(itemId)) return;
    this.itemOrder.push(itemId);
  }

  private aggregateTranscript(): string {
    return this.itemOrder
      .map((itemId) => this.finalsByItem.get(itemId) ?? this.partialsByItem.get(itemId) ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private resetTranscriptState(): void {
    this.connected = false;
    this.sessionReady = false;
    this.bufferedMs = 0;
    this.pendingCommitCount = 0;
    this.flushResolvers = [];
    this.startResolve = undefined;
    this.startReject = undefined;
    this.intentionalClose = false;
    this.queuedAppendCount = 0;
    this.queuedAppendMs = 0;
    this.lastQueueLogAt = 0;
    this.sentChunkCount = 0;
    this.sentAudioMs = 0;
    this.inboundMsgCount = 0;
    this.lastInboundType = undefined;
    this.lastInboundAt = 0;
    this.lastSendAt = 0;
    this.serverVadFinishRequested = false;
    this.inboundTypesSeenThisSession = new Set();
    this.stopKeepAlive();
    this.stopHealthLog();
    // Brand-new external session: drop everything. Replay buffer AND already-
    // delivered transcript text must survive recover()'s internal start() call,
    // so the new session's items append to the same itemOrder and the user
    // sees one continuous transcription instead of a hard reset.
    if (!this.inRecovery) {
      this.itemOrder = [];
      this.partialsByItem = new Map();
      this.finalsByItem = new Map();
      this.clearUnconfirmedAudio();
    }
  }

  async recover(): Promise<void> {
    if (this.stopRequested) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.performRecover().finally(() => {
      this.recoveryPromise = undefined;
    });
    return this.recoveryPromise;
  }

  private async performRecover(): Promise<void> {
    if (this.inRecovery) return;
    this.inRecovery = true;
    const startedAt = Date.now();
    const replayMs = this.unconfirmedAudioMs;
    // Freeze any in-progress item before tearing the session down. Its partial
    // text was already delivered to the controller (and on to the renderer),
    // so dropping it here would make the visible draft suddenly shrink. The
    // audio that would have extended this item lives in the unconfirmed
    // replay buffer; the new session will assign NEW item_ids to that audio,
    // which simply append to itemOrder and produce a continuous transcript.
    let frozenPartialItems = 0;
    for (const [itemId, partialText] of this.partialsByItem) {
      if (partialText && !this.finalsByItem.has(itemId)) {
        this.finalsByItem.set(itemId, partialText);
        frozenPartialItems += 1;
      }
    }
    this.partialsByItem.clear();
    log.info('recover: tearing down failed transport and replaying unconfirmed audio', {
      replayMs: Math.round(replayMs),
      replayChunks: this.unconfirmedAudio.length,
      frozenPartialItems,
      preservedItemCount: this.itemOrder.length,
    });
    try {
      await this.stopSocket({ forRecovery: true });
      if (this.stopRequested) return;
      // Internal recovery intentionally closes the old socket. Its close
      // handler checks socket identity before touching instance state, so the
      // reconnect cannot emit a stale disconnect into the controller.
      const startPromise = this.start({ recovering: true });
      const startResult = await Promise.race<'ok' | 'timeout'>([
        startPromise.then(() => 'ok' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), RECOVER_TIMEOUT_MS)),
      ]);
      if (startResult === 'timeout') {
        this.teardownRecoveredSocketAfterStop();
        throw new Error(`recover: reconnect did not become ready within ${RECOVER_TIMEOUT_MS}ms`);
      }
      if (this.stopRequested) {
        this.teardownRecoveredSocketAfterStop();
        return;
      }
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || !this.sessionReady) {
        throw new Error('recover: socket not ready after reconnect');
      }
      // Replay every unacknowledged chunk into the new session, in order. We do
      // not finalize here: OpenAI/manual sessions are committed by flush(), and
      // Qwen/server-VAD sessions are finished by flush(). The next
      // partial/completed event drains the replay buffer.
      let replayedMs = 0;
      for (const { pcm, durationMs } of this.unconfirmedAudio) {
        // Don't double-count replay against sentChunkCount/sentAudioMs — the
        // health summary tracks original mic flow, replay is a separate signal.
        // Recorder still gets the message so the WS log captures the replay.
        socket.send(JSON.stringify(buildAppendAudioMessage(pcm.toString('base64'), this.protocolProfile)));
        if (this.recorder) {
          this.recorder.recordWs('outbound', { type: 'input_audio_buffer.append', audio_b64_len: Math.ceil(pcm.length * 4 / 3), replay: true });
        }
        this.bufferedMs += durationMs;
        replayedMs += durationMs;
      }
      log.info('recover: replay complete', {
        replayedMs: Math.round(replayedMs),
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      this.inRecovery = false;
    }
  }

  // Periodic transport_health log: cheap, always-on debug line that gives
  // post-mortem visibility into "did we send audio in the last 5s? did the
  // server send anything?". The original symptom was a long no-delta window
  // with ZERO log lines from the provider — making it impossible to tell
  // whether the upstream stopped responding or our send path stopped firing.
  // This closes that gap without requiring full XDT_VOICE_INPUT_RECORD recording.
  private startHealthLog(): void {
    this.stopHealthLog();
    let prevSent = this.sentChunkCount;
    let prevSentMs = this.sentAudioMs;
    let prevQueued = this.queuedAppendCount;
    let prevInbound = this.inboundMsgCount;
    this.healthLogTimer = setInterval(() => {
      const now = Date.now();
      const sent = this.sentChunkCount - prevSent;
      const sentMs = Math.round(this.sentAudioMs - prevSentMs);
      const queued = this.queuedAppendCount - prevQueued;
      const inbound = this.inboundMsgCount - prevInbound;
      prevSent = this.sentChunkCount;
      prevSentMs = this.sentAudioMs;
      prevQueued = this.queuedAppendCount;
      prevInbound = this.inboundMsgCount;
      log.debug('transport_health', {
        sentChunks: sent,
        sentMs,
        queuedChunks: queued,
        inboundMsgs: inbound,
        bufferedMs: Math.round(this.bufferedMs),
        unconfirmedAudioMs: Math.round(this.unconfirmedAudioMs),
        connected: this.connected,
        sessionReady: this.sessionReady,
        socketReadyState: this.socket?.readyState,
        msSinceLastSend: this.lastSendAt ? now - this.lastSendAt : null,
        msSinceLastInbound: this.lastInboundAt ? now - this.lastInboundAt : null,
        lastInboundType: this.lastInboundType,
      });
    }, TRANSPORT_HEALTH_LOG_INTERVAL_MS);
  }

  private stopHealthLog(): void {
    if (this.healthLogTimer === undefined) return;
    clearInterval(this.healthLogTimer);
    this.healthLogTimer = undefined;
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
        log.debug('keepalive ping failed', {
          error: error instanceof Error ? error.message : String(error),
          socketReadyState: socket.readyState,
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
      log.warn('keepalive pong timeout, terminating socket', {
        timeoutMs: KEEPALIVE_PONG_TIMEOUT_MS,
      });
      // terminate() bypasses the close handshake. We treat pong-timeout as a
      // dead transport: graceful close would just stall waiting for a peer
      // that already proved it cannot answer.
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

export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  if (input.length < 2 || fromRate <= 0 || toRate <= 0) return Buffer.alloc(0);

  const inputSamples = Math.floor(input.length / 2);
  const outputSamples = Math.max(1, Math.round(inputSamples * (toRate / fromRate)));
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourceIndex = index * (fromRate / toRate);
    const low = Math.floor(sourceIndex);
    const high = Math.min(low + 1, inputSamples - 1);
    const ratio = sourceIndex - low;
    const lowSample = input.readInt16LE(low * 2);
    const highSample = input.readInt16LE(high * 2);
    const sample = Math.round(lowSample + (highSample - lowSample) * ratio);
    output.writeInt16LE(clampPcm16(sample), index * 2);
  }
  return output;
}

function estimatePcmDurationMs(byteLength: number, sampleRate: number): number {
  return byteLength / (sampleRate * 2 / 1000);
}

function clampPcm16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

export function realtimeErrorMessage(
  event: Record<string, unknown>,
  fallbackMessage: string,
  redactUpstreamErrors = false,
): string {
  if (redactUpstreamErrors) return fallbackMessage;
  const error = event.error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return fallbackMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
