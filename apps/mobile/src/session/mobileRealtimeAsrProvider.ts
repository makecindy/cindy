import type { AsrEvent, AsrProvider, AudioTrace } from '@cindy/voice-input-core';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { redactMobileVoiceCredentialText } from '@/session/mobileVoiceCredentialRedaction';
import { gzip, ungzip } from 'pako';
import { i18n } from '@/i18n';

type MobileRealtimeProtocolProfile =
  | 'openai-transcription-manual'
  | 'qwen-asr-server-vad';

type MobileRealtimeAsrProviderOptions = {
  credential: StoredMobileVoiceCredential;
  sourceLanguage?: string;
  websocketFactory?: WebSocketFactory;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
  connectionProvider?: (provider: string) => Promise<{
    websocketUrl: string;
    authorizationToken: string;
  }>;
};

type WebSocketFactory = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

type WebSocketLike = {
  readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string; error?: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
};

const OPEN = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 4_000;
const RECOVER_TIMEOUT_MS = 3_000;
const MIN_COMMIT_AUDIO_MS = 100;
const CONFIRMED_AUDIO_RETENTION_MS = 1_500;
const QWEN_SERVER_VAD_THRESHOLD = 0.0;
const QWEN_SERVER_VAD_SILENCE_DURATION_MS = 400;
const LOCAL_TURN_VOICED_RMS_THRESHOLD = 300;
const VOLCENGINE_MODEL_NAME = 'bigmodel';
const VOLCENGINE_NONSTREAM_END_WINDOW_MS = 300;
const CLOSED = 3;

const VOLC_PROTOCOL_VERSION = 0x1;
const VOLC_HEADER_SIZE_WORDS = 0x1;
const VOLC_SERIALIZATION_NONE = 0x0;
const VOLC_SERIALIZATION_JSON = 0x1;
const VOLC_COMPRESSION_NONE = 0x0;
const VOLC_COMPRESSION_GZIP = 0x1;
const VOLC_MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1;
const VOLC_MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2;
const VOLC_MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0x9;
const VOLC_MESSAGE_TYPE_SERVER_ACK = 0xb;
const VOLC_MESSAGE_TYPE_SERVER_ERROR = 0xf;
const VOLC_FLAG_NO_SEQUENCE = 0x0;
const VOLC_FLAG_POSITIVE_SEQUENCE = 0x1;
const VOLC_FLAG_NEGATIVE_SEQUENCE = 0x3;

type ParsedVolcengineMessage = {
  messageType: number;
  flags: number;
  sequence?: number;
  payload?: unknown;
  payloadText?: string;
};

type RealtimeReplayAudioChunk = {
  audioBase64: string;
  durationMs: number;
  addedAt: number;
  sent: boolean;
  localTurnId?: number;
  commitId?: number;
};

type VolcengineReplayAudioChunk = {
  pcm: Uint8Array;
  durationMs: number;
  addedAt: number;
  sent: boolean;
  localTurnId?: number;
};

type PendingConnect = {
  reject(error: Error): void;
};

export function createMobileAsrProvider(
  credential: StoredMobileVoiceCredential,
  options: Omit<MobileRealtimeAsrProviderOptions, 'credential'> = {},
): AsrProvider {
  const chain = mobileAsrCredentialChain(credential);
  if (chain.length > 1) {
    return new MobileFallbackAsrProvider(
      chain.map((asr) => ({
        provider: asr.provider,
        create: () => createSingleMobileAsrProvider({ ...credential, asr }, options),
      })),
    );
  }
  return createSingleMobileAsrProvider({ ...credential, asr: chain[0] ?? credential.asr }, options);
}

function createSingleMobileAsrProvider(
  credential: StoredMobileVoiceCredential,
  options: Omit<MobileRealtimeAsrProviderOptions, 'credential'> = {},
): AsrProvider {
  if (credential.asr.mode === 'realtime-websocket') {
    return new MobileRealtimeAsrProvider({ ...options, credential });
  }
  if (credential.asr.mode === 'provider-native-websocket' && credential.asr.protocolProfile === 'volcengine-sauc-duration') {
    return new MobileVolcengineSaucAsrProvider({ ...options, credential });
  }
  throw new Error(i18n.t('composer.voice.realtimeUnsupported', { detail: `${credential.asr.mode} / ${credential.asr.protocolProfile ?? 'unknown'}` }));
}

type MobileAsrCandidate = {
  provider: string;
  create: () => AsrProvider;
};

class MobileFallbackAsrProvider implements AsrProvider {
  private readonly candidates: MobileAsrCandidate[];
  private readonly callbacks: Array<(event: AsrEvent) => void> = [];
  private active: AsrProvider | null = null;
  private pending: AsrProvider | null = null;
  private activeProvider = '';
  private stopped = false;

  recover?: () => Promise<void>;

  constructor(candidates: MobileAsrCandidate[]) {
    if (candidates.length === 0) throw new Error('Mobile ASR fallback requires at least one candidate.');
    this.candidates = candidates;
  }

  async start(): Promise<void> {
    this.stopped = false;
    let lastError: unknown = null;
    for (const candidate of this.candidates) {
      if (this.stopped) throw new Error('Mobile ASR fallback provider stopped.');
      const provider = candidate.create();
      this.pending = provider;
      provider.onEvent((event) => {
        if (this.active === provider) this.callbacks.forEach((callback) => callback(event));
      });
      try {
        await provider.start();
      } catch (err) {
        if (this.pending === provider) this.pending = null;
        lastError = err;
        await provider.dispose?.().catch(() => undefined);
        if (this.stopped) throw err;
        continue;
      }
      if (this.pending === provider) this.pending = null;
      if (this.stopped) {
        await provider.stop().catch(() => undefined);
        throw new Error('Mobile ASR fallback provider stopped.');
      }
      this.active = provider;
      this.activeProvider = candidate.provider;
      this.recover = provider.recover ? () => provider.recover!() : undefined;
      return;
    }
    throw lastError instanceof Error ? lastError : new Error('All mobile ASR providers failed to start.');
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    this.active?.appendAudio(chunk, trace);
  }

  async flushAudio(): Promise<void> {
    await this.active?.flushAudio();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const providers = new Set([this.pending, this.active]);
    await Promise.all([...providers].map((provider) => provider?.stop()));
  }

  async dispose(): Promise<void> {
    await this.stop();
    const providers = new Set([this.pending, this.active]);
    await Promise.all([...providers].map((provider) => provider?.dispose?.()));
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callbacks.push(callback);
  }

  get activeProviderKind(): string {
    return this.activeProvider;
  }
}

function mobileAsrCredentialChain(
  credential: StoredMobileVoiceCredential,
): Array<StoredMobileVoiceCredential['asr']> {
  const chain = credential.asrProviderChain?.length ? credential.asrProviderChain : [credential.asr];
  const seen = new Set<string>();
  const result: Array<StoredMobileVoiceCredential['asr']> = [];
  for (const item of chain) {
    if (seen.has(item.provider)) continue;
    seen.add(item.provider);
    result.push(item);
  }
  return result;
}

export class MobileRealtimeAsrProvider implements AsrProvider {
  private readonly credential: StoredMobileVoiceCredential;
  private readonly sourceLanguage: string;
  private readonly websocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly protocolProfile: MobileRealtimeProtocolProfile;
  private readonly pcmSampleRate: number;
  private readonly connectionProvider?: MobileRealtimeAsrProviderOptions['connectionProvider'];
  private callback: (event: AsrEvent) => void = () => {};
  private socket: WebSocketLike | null = null;
  private sessionReady = false;
  private bufferedMs = 0;
  private pendingCommitCount = 0;
  private nextAudioCommitId = 1;
  private pendingAudioCommitIds: number[] = [];
  private audioCommitIdsByItem = new Map<string, number>();
  private unboundAudioItemTurnIds = new Map<string, number>();
  private currentLocalAudioTurnId = 1;
  private localTurnHasVoice = false;
  private localTurnSilenceMs = 0;
  private unconfirmedAudio: RealtimeReplayAudioChunk[] = [];
  private flushResolvers: Array<() => void> = [];
  private itemOrder: string[] = [];
  private partialsByItem = new Map<string, string>();
  private finalsByItem = new Map<string, string>();
  private serverVadFinishRequested = false;
  private stopped = false;
  private inRecovery = false;
  private recoveryPromise?: Promise<void>;
  private pendingConnect?: PendingConnect;

  constructor(options: MobileRealtimeAsrProviderOptions) {
    this.credential = options.credential;
    this.sourceLanguage = options.sourceLanguage ?? this.credential.settings?.language ?? 'auto';
    this.websocketFactory = options.websocketFactory ?? (globalThis.WebSocket as unknown as WebSocketFactory);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.protocolProfile = readRealtimeProtocolProfile(this.credential);
    this.pcmSampleRate = this.credential.asr.pcmSampleRate ?? 16_000;
    this.connectionProvider = options.connectionProvider;
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (this.credential.asr.mode !== 'realtime-websocket') {
      throw new Error(i18n.t('composer.voice.realtimeUnsupported', { detail: this.credential.asr.mode }));
    }
    if (this.credential.asr.auth !== 'api-key') {
      throw new Error(i18n.t('composer.voice.realtimeAuthUnsupported', { auth: this.credential.asr.auth }));
    }
    this.resetTranscriptState();
    this.stopped = false;

    await this.connect();
  }

  private async connect(): Promise<void> {
    // 托管 ticket 是唯一建连方式:BYOK/穿透 key 直拨上游的路径已删除。
    if (!this.connectionProvider) {
      throw new Error(i18n.t('composer.voice.missingConnectionProvider'));
    }
    const dynamicConnection = await this.connectionProvider(this.credential.asr.provider);
    if (this.stopped) throw new Error('Realtime ASR connection stopped.');
    const { websocketUrl, authorizationToken } = dynamicConnection;

    await new Promise<void>((resolve, reject) => {
      const socket = new this.websocketFactory(
        websocketUrl,
        null,
        { headers: { Authorization: `Bearer ${authorizationToken}` } },
      );
      this.socket = socket;
      let settled = false;
      let pendingConnect: PendingConnect | undefined;
      let pendingConnectError: Error | null = null;
      let pendingConnectErrorTimer: ReturnType<typeof setTimeout> | null = null;
      const timer = setTimeout(() => {
        fail(new Error(`Realtime ASR connection timed out after ${this.connectTimeoutMs}ms`));
        socket.close();
      }, this.connectTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (pendingConnect && this.pendingConnect === pendingConnect) this.pendingConnect = undefined;
        if (pendingConnectErrorTimer) clearTimeout(pendingConnectErrorTimer);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.socket = null;
        this.sessionReady = false;
        reject(error);
      };
      const ready = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      pendingConnect = { reject: fail };
      this.pendingConnect = pendingConnect;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.sendSessionUpdate();
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        this.handleMessage(String(event.data), ready);
      };
      socket.onerror = (event) => {
        if (this.socket !== socket) return;
        const { message, specific } = webSocketErrorMessage(event, 'Realtime ASR connection failed.');
        const redacted = this.redactError(message);
        if (!settled) {
          pendingConnectError = new Error(redacted);
          if (specific) {
            fail(pendingConnectError);
          } else {
            pendingConnectErrorTimer = setTimeout(() => {
              if (pendingConnectError) fail(pendingConnectError);
            }, 250);
          }
        } else {
          this.sessionReady = false;
          this.resolveFlushWaiters();
          this.callback({ type: 'error', message: redacted, at: Date.now() });
        }
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.sessionReady = false;
        this.resolveFlushWaiters();
        if (!settled) {
          fail(new Error(this.redactError(webSocketCloseBeforeReadyMessage(
            event,
            'Realtime ASR connection closed before it was ready.',
            pendingConnectError?.message,
          ))));
        } else if (!this.stopped) this.callback({ type: 'disconnected', at: Date.now() });
      };
    });
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    const durationMs = trace?.durationMs ?? estimatePcmDurationMs(chunk.byteLength, trace?.sampleRate ?? this.pcmSampleRate);
    const entry = this.bufferUnconfirmedAudio(
      arrayBufferToBase64(chunk),
      durationMs,
      this.assignRealtimeAudioTurnId(chunk, durationMs),
    );
    this.sendRealtimeAudioEntry(entry);
  }

  async flushAudio(): Promise<void> {
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    if (this.protocolProfile === 'qwen-asr-server-vad') {
      const sent = this.sendWs(buildFinishSessionMessage(this.protocolProfile));
      if (sent) {
        this.bufferedMs = 0;
        this.serverVadFinishRequested = true;
        await this.waitForFlush();
      }
      return;
    }
    if (this.bufferedMs < MIN_COMMIT_AUDIO_MS) {
      this.bufferedMs = 0;
      return;
    }
    if (this.sendWs({ type: 'input_audio_buffer.commit' })) {
      this.queueRealtimeAudioCommit();
      this.pendingCommitCount += 1;
      this.bufferedMs = 0;
      await this.waitForFlush();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.sessionReady = false;
    this.resolveFlushWaiters();
    this.clearUnconfirmedAudio();
    const socket = this.socket;
    this.pendingConnect?.reject(new Error('Realtime ASR connection stopped.'));
    this.socket = null;
    if (socket && socket.readyState !== CLOSED) socket.close();
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    this.callback({ type: 'disconnected', at: Date.now() });
  }

  async recover(): Promise<void> {
    if (this.stopped) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.performRecover().finally(() => {
      this.recoveryPromise = undefined;
    });
    return this.recoveryPromise;
  }

  private sendSessionUpdate(): void {
    this.sendWs(buildSessionUpdateMessage(
      this.credential.asr.model,
      this.sourceLanguage,
      this.pcmSampleRate,
      this.protocolProfile,
    ));
  }

  private sendWs(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || (!this.sessionReady && message.type !== 'session.update')) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private sendRealtimeAudioEntry(entry: RealtimeReplayAudioChunk): boolean {
    if (!this.sessionReady) return false;
    const sent = this.sendWs(buildAppendAudioMessage(entry.audioBase64, this.protocolProfile));
    if (!sent) return false;
    entry.sent = true;
    this.bufferedMs += entry.durationMs;
    return true;
  }

  private flushPendingRealtimeAudio(): void {
    for (const entry of this.unconfirmedAudio) {
      if (!entry.sent) this.sendRealtimeAudioEntry(entry);
    }
  }

  private handleMessage(raw: string, markReady?: () => void): void {
    const event = parseJsonObject(raw);
    if (!isRecord(event) || typeof event.type !== 'string') return;

    switch (event.type) {
      case 'session.updated':
        this.sessionReady = true;
        this.callback({ type: 'connected', at: Date.now() });
        markReady?.();
        if (!this.inRecovery) this.flushPendingRealtimeAudio();
        break;
      case 'input_audio_buffer.committed':
        if (typeof event.item_id === 'string') {
          this.registerItem(event.item_id);
          this.bindCommittedAudioToItem(event.item_id);
        }
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
        this.callback({ type: 'error', message: this.redactError(realtimeErrorMessage(event, i18n.t('composer.voice.realtimeAsrFailed'))), at: Date.now() });
        this.resolveFlushWaiters();
        break;
      case 'error': {
        const message = this.redactError(realtimeErrorMessage(event, i18n.t('composer.voice.realtimeAsrFailed')));
        if (this.isNonFatalServerVadFinishError(message)) {
          this.resolveFlushWaiters();
          break;
        }
        this.callback({ type: 'error', message, at: Date.now() });
        this.resolveFlushWaiters();
        break;
      }
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
    this.callback({ type: 'partial', text: this.aggregateTranscript(), at: Date.now() });
  }

  private handleText(event: Record<string, unknown>): void {
    if (typeof event.item_id !== 'string' || typeof event.text !== 'string') return;
    this.registerItem(event.item_id);
    const preview = `${event.text}${typeof event.stash === 'string' ? event.stash : ''}`;
    this.partialsByItem.set(event.item_id, preview);
    this.callback({ type: 'partial', text: this.aggregateTranscript(), at: Date.now() });
  }

  private handleCompleted(event: Record<string, unknown>): void {
    const itemTranscript = typeof event.transcript === 'string'
      ? event.transcript
      : typeof event.text === 'string'
        ? event.text
        : undefined;
    if (typeof event.item_id !== 'string' || typeof itemTranscript !== 'string') return;
    this.registerItem(event.item_id);
    this.finalsByItem.set(event.item_id, itemTranscript);
    this.partialsByItem.delete(event.item_id);
    if (this.pendingCommitCount > 0) this.pendingCommitCount -= 1;
    const aggregate = this.aggregateTranscript();
    if (aggregate) this.callback({ type: 'stable', text: aggregate, at: Date.now() });
    this.clearConfirmedRealtimeAudio(event.item_id);
    if (this.pendingCommitCount === 0) this.resolveFlushWaiters();
  }

  private async performRecover(): Promise<void> {
    if (this.inRecovery || this.stopped) return;
    this.inRecovery = true;
    const partialOnlyItemIds = new Set(this.partialsByItem.keys());
    this.itemOrder = this.itemOrder.filter((itemId) => !partialOnlyItemIds.has(itemId) || this.finalsByItem.has(itemId));
    this.partialsByItem.clear();
    this.sessionReady = false;
    this.bufferedMs = 0;
    this.pendingCommitCount = 0;
    this.pendingAudioCommitIds = [];
    this.audioCommitIdsByItem.clear();
    this.unboundAudioItemTurnIds.clear();
    this.serverVadFinishRequested = false;
    this.resolveFlushWaiters();
    this.resetUnconfirmedAudioForReplay();

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === OPEN) socket.close();

    try {
      await this.connect();
      if (this.stopped) return;
      for (const entry of this.unconfirmedAudio) {
        if (!this.sendRealtimeAudioEntry(entry)) {
          throw new Error('Realtime ASR recovery replay failed.');
        }
      }
    } finally {
      this.inRecovery = false;
    }
  }

  private isNonFatalServerVadFinishError(message: string): boolean {
    if (this.protocolProfile !== 'qwen-asr-server-vad') return false;
    if (!this.serverVadFinishRequested) return false;
    if (!this.aggregateTranscript()) return false;
    return /input_audio_buffer|commit/i.test(message);
  }

  private registerItem(itemId: string): void {
    if (!this.itemOrder.includes(itemId)) this.itemOrder.push(itemId);
  }

  private aggregateTranscript(): string {
    return this.itemOrder
      .map((itemId) => this.finalsByItem.get(itemId) ?? this.partialsByItem.get(itemId) ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private waitForFlush(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.flushTimeoutMs);
      this.flushResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private resolveFlushWaiters(): void {
    this.flushResolvers.splice(0).forEach((resolve) => resolve());
  }

  private bufferUnconfirmedAudio(
    audioBase64: string,
    durationMs: number,
    localTurnId?: number,
  ): RealtimeReplayAudioChunk {
    const entry: RealtimeReplayAudioChunk = {
      audioBase64,
      durationMs,
      addedAt: Date.now(),
      sent: false,
      localTurnId,
    };
    this.unconfirmedAudio.push(entry);
    return entry;
  }

  private queueRealtimeAudioCommit(maxAddedAt?: number, localTurnId?: number): number | undefined {
    const commitId = this.nextAudioCommitId;
    let hasAudio = false;
    for (const entry of this.unconfirmedAudio) {
      if (!entry.sent || entry.commitId !== undefined) continue;
      if (maxAddedAt !== undefined && entry.addedAt > maxAddedAt) continue;
      if (localTurnId !== undefined && entry.localTurnId !== localTurnId) continue;
      entry.commitId = commitId;
      hasAudio = true;
    }
    if (!hasAudio) return undefined;
    this.nextAudioCommitId += 1;
    this.pendingAudioCommitIds.push(commitId);
    return commitId;
  }

  private bindCommittedAudioToItem(itemId: string): void {
    const committedAt = Date.now();
    let committedTurnId: number | undefined;
    let commitId = this.pendingAudioCommitIds.shift();
    if (commitId === undefined) {
      if (this.protocolProfile === 'qwen-asr-server-vad') {
        committedTurnId = this.oldestUncommittedSentAudioTurnId();
        commitId = this.queueRealtimeAudioCommit(
          committedAt - CONFIRMED_AUDIO_RETENTION_MS,
          committedTurnId,
        );
      } else {
        commitId = this.queueRealtimeAudioCommit();
      }
    }
    if (commitId !== undefined) {
      this.audioCommitIdsByItem.set(itemId, commitId);
      this.unboundAudioItemTurnIds.delete(itemId);
      if (committedTurnId !== undefined) this.advanceLocalAudioTurnAfterServerCommit(committedTurnId);
    } else {
      const turnId = this.oldestUncommittedSentAudioTurnId();
      if (turnId !== undefined) {
        this.unboundAudioItemTurnIds.set(itemId, turnId);
        this.advanceLocalAudioTurnAfterServerCommit(turnId);
      }
    }
  }

  private clearConfirmedRealtimeAudio(itemId: string): void {
    let commitId = this.audioCommitIdsByItem.get(itemId);
    if (commitId === undefined) {
      const turnId = this.unboundAudioItemTurnIds.get(itemId);
      if (turnId !== undefined) {
        this.unboundAudioItemTurnIds.delete(itemId);
        this.clearUnboundRealtimeAudioTurn(turnId);
        return;
      }
      commitId = this.pendingAudioCommitIds.shift();
    }
    if (commitId === undefined) {
      this.trimUnconfirmedAudioOlderThan(Date.now() - CONFIRMED_AUDIO_RETENTION_MS);
      return;
    }
    this.audioCommitIdsByItem.delete(itemId);
    this.unboundAudioItemTurnIds.delete(itemId);
    this.pendingAudioCommitIds = this.pendingAudioCommitIds.filter((id) => id !== commitId);
    this.unconfirmedAudio = this.unconfirmedAudio.filter((entry) => entry.commitId !== commitId);
  }

  private clearUnboundRealtimeAudioTurn(turnId: number): void {
    this.unconfirmedAudio = this.unconfirmedAudio.filter((entry) => {
      if (!entry.sent || entry.commitId !== undefined) return true;
      return entry.localTurnId !== turnId;
    });
  }

  private oldestUncommittedSentAudioTurnId(): number | undefined {
    return this.unconfirmedAudio.find((entry) => (
      entry.sent
      && entry.commitId === undefined
      && entry.localTurnId !== undefined
    ))?.localTurnId;
  }

  private assignRealtimeAudioTurnId(chunk: ArrayBuffer, durationMs: number): number | undefined {
    if (this.protocolProfile !== 'qwen-asr-server-vad') return undefined;
    const voiced = isPcm16ChunkVoiced(chunk);
    if (voiced && this.localTurnHasVoice && this.localTurnSilenceMs >= QWEN_SERVER_VAD_SILENCE_DURATION_MS) {
      this.currentLocalAudioTurnId += 1;
      this.localTurnHasVoice = false;
      this.localTurnSilenceMs = 0;
    }
    const turnId = this.currentLocalAudioTurnId;
    if (voiced) {
      this.localTurnHasVoice = true;
      this.localTurnSilenceMs = 0;
    } else if (this.localTurnHasVoice) {
      this.localTurnSilenceMs += durationMs;
    }
    return turnId;
  }

  private advanceLocalAudioTurnAfterServerCommit(turnId: number): void {
    if (this.currentLocalAudioTurnId > turnId) return;
    this.currentLocalAudioTurnId = turnId + 1;
    this.localTurnHasVoice = false;
    this.localTurnSilenceMs = 0;
  }

  private trimUnconfirmedAudioOlderThan(cutoffMs: number): void {
    while (this.unconfirmedAudio.length > 0 && this.unconfirmedAudio[0].sent && this.unconfirmedAudio[0].addedAt < cutoffMs) {
      const dropped = this.unconfirmedAudio.shift();
      if (!dropped) break;
    }
  }

  private clearUnconfirmedAudio(): void {
    this.unconfirmedAudio = [];
    this.pendingAudioCommitIds = [];
    this.audioCommitIdsByItem.clear();
    this.unboundAudioItemTurnIds.clear();
    this.currentLocalAudioTurnId = 1;
    this.localTurnHasVoice = false;
    this.localTurnSilenceMs = 0;
  }

  private resetUnconfirmedAudioForReplay(): void {
    for (const entry of this.unconfirmedAudio) {
      entry.sent = false;
      entry.commitId = undefined;
    }
  }

  private resetTranscriptState(): void {
    this.sessionReady = false;
    this.bufferedMs = 0;
    this.pendingCommitCount = 0;
    this.nextAudioCommitId = 1;
    this.pendingAudioCommitIds = [];
    this.audioCommitIdsByItem = new Map();
    this.unboundAudioItemTurnIds = new Map();
    this.currentLocalAudioTurnId = 1;
    this.localTurnHasVoice = false;
    this.localTurnSilenceMs = 0;
    this.flushResolvers = [];
    this.itemOrder = [];
    this.partialsByItem = new Map();
    this.finalsByItem = new Map();
    this.serverVadFinishRequested = false;
    this.clearUnconfirmedAudio();
  }

  private redactError(message: string): string {
    return redactMobileVoiceCredentialText(message, this.credential);
  }
}

export class MobileVolcengineSaucAsrProvider implements AsrProvider {
  private readonly credential: StoredMobileVoiceCredential;
  private readonly sourceLanguage: string;
  private readonly websocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly pcmSampleRate: number;
  private readonly connectionProvider?: MobileRealtimeAsrProviderOptions['connectionProvider'];
  private callback: (event: AsrEvent) => void = () => {};
  private socket: WebSocketLike | null = null;
  private connected = false;
  private sequence = 1;
  private sentAudioMs = 0;
  private pendingFinalAudioChunk: VolcengineReplayAudioChunk | null = null;
  private lastTranscript = '';
  private finalizedTranscript = '';
  private sessionTranscriptPrefix = '';
  private unconfirmedAudio: VolcengineReplayAudioChunk[] = [];
  private currentLocalAudioTurnId = 1;
  private localTurnHasVoice = false;
  private localTurnSilenceMs = 0;
  private finalRequested = false;
  private stableEmitted = false;
  private flushResolvers: Array<() => void> = [];
  private stopped = false;
  private recoveryPromise?: Promise<void>;
  private pendingConnect?: PendingConnect;

  constructor(options: MobileRealtimeAsrProviderOptions) {
    this.credential = options.credential;
    this.sourceLanguage = options.sourceLanguage ?? this.credential.settings?.language ?? 'auto';
    this.websocketFactory = options.websocketFactory ?? (globalThis.WebSocket as unknown as WebSocketFactory);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.pcmSampleRate = this.credential.asr.pcmSampleRate ?? 16_000;
    this.connectionProvider = options.connectionProvider;
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (this.credential.asr.auth !== 'api-key') {
      throw new Error(i18n.t('composer.voice.volcengineAuthUnsupported', { auth: this.credential.asr.auth }));
    }
    if (!this.credential.asr.resourceId) throw new Error(i18n.t('composer.voice.volcengineMissingResourceId'));
    const resourceId = this.credential.asr.resourceId;
    this.resetState();

    await this.openSocket(resourceId);
  }

  private async openSocket(resourceId: string): Promise<void> {
    // 托管 ticket 是唯一建连方式:BYOK/穿透 key 直拨上游的路径已删除。
    if (!this.connectionProvider) {
      throw new Error(i18n.t('composer.voice.missingConnectionProvider'));
    }
    const dynamicConnection = await this.connectionProvider(this.credential.asr.provider);
    if (this.stopped) throw new Error('Volcengine SAUC ASR connection stopped.');
    const { websocketUrl, authorizationToken } = dynamicConnection;
    await new Promise<void>((resolve, reject) => {
      const socket = new this.websocketFactory(
        websocketUrl,
        null,
        {
          headers: {
            Authorization: `Bearer ${authorizationToken}`,
            'X-Api-Resource-Id': resourceId,
            'X-Api-Connect-Id': buildConnectId(),
          },
        },
      );
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let settled = false;
      let pendingConnect: PendingConnect | undefined;
      let pendingConnectError: Error | null = null;
      let pendingConnectErrorTimer: ReturnType<typeof setTimeout> | null = null;
      const timer = setTimeout(() => {
        fail(new Error(`Volcengine SAUC ASR connection timed out after ${this.connectTimeoutMs}ms`));
        socket.close();
      }, this.connectTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (pendingConnect && this.pendingConnect === pendingConnect) this.pendingConnect = undefined;
        if (pendingConnectErrorTimer) clearTimeout(pendingConnectErrorTimer);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.socket = null;
        reject(error);
      };
      pendingConnect = { reject: fail };
      this.pendingConnect = pendingConnect;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        if (settled) return;
        settled = true;
        cleanup();
        this.connected = true;
        this.sendInitialRequest();
        this.callback({ type: 'connected', at: Date.now() });
        resolve();
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        this.handleMessage(event.data);
      };
      socket.onerror = (event) => {
        if (this.socket !== socket) return;
        const { message, specific } = webSocketErrorMessage(event, 'Volcengine SAUC ASR connection failed.');
        const redacted = this.redactError(message);
        if (!settled) {
          pendingConnectError = new Error(redacted);
          if (specific) {
            fail(pendingConnectError);
          } else {
            pendingConnectErrorTimer = setTimeout(() => {
              if (pendingConnectError) fail(pendingConnectError);
            }, 250);
          }
        } else {
          this.connected = false;
          this.resolveFlushWaiters();
          this.callback({ type: 'error', message: redacted, at: Date.now() });
        }
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.connected = false;
        this.resolveFlushWaiters();
        if (!settled) {
          fail(new Error(this.redactError(webSocketCloseBeforeReadyMessage(
            event,
            'Volcengine SAUC ASR connection closed before it was ready.',
            pendingConnectError?.message,
          ))));
        } else if (!this.stopped) this.callback({ type: 'disconnected', at: Date.now() });
      };
    });
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    const durationMs = trace?.durationMs ?? estimatePcmDurationMs(chunk.byteLength, trace?.sampleRate ?? this.pcmSampleRate);
    const entry = this.addUnconfirmedAudio(
      new Uint8Array(chunk),
      durationMs,
      this.assignVolcengineAudioTurnId(chunk, durationMs),
    );
    this.sentAudioMs += durationMs;
    const socket = this.socket;
    if (this.connected && socket?.readyState === OPEN && this.pendingFinalAudioChunk) {
      this.sendVolcengineAudioEntry(this.pendingFinalAudioChunk, socket);
    }
    this.pendingFinalAudioChunk = entry;
  }

  async flushAudio(): Promise<void> {
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    if (!this.connected || this.finalRequested || this.sentAudioMs <= 0) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    this.finalRequested = true;
    if (this.pendingFinalAudioChunk) {
      this.sendVolcengineAudioEntry(this.pendingFinalAudioChunk, socket);
    }
    this.pendingFinalAudioChunk = null;
    sendBinary(socket, encodeVolcengineAudioOnlyRequest(silencePcm16(this.pcmSampleRate, VOLCENGINE_NONSTREAM_END_WINDOW_MS), -this.nextSequence()));
    await this.waitForFlush();
    if (this.lastTranscript && !this.stableEmitted) {
      this.finalizedTranscript = this.lastTranscript;
      this.callback({ type: 'stable', text: this.lastTranscript, at: Date.now() });
      this.stableEmitted = true;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.resolveFlushWaiters();
    this.clearUnconfirmedAudio();
    this.sessionTranscriptPrefix = '';
    const socket = this.socket;
    this.pendingConnect?.reject(new Error('Volcengine SAUC ASR connection stopped.'));
    this.socket = null;
    if (socket && socket.readyState !== CLOSED) socket.close();
    if (this.recoveryPromise) {
      await Promise.race([
        this.recoveryPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, RECOVER_TIMEOUT_MS)),
      ]);
    }
    this.callback({ type: 'disconnected', at: Date.now() });
  }

  async recover(): Promise<void> {
    if (this.stopped) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.performRecover().finally(() => {
      this.recoveryPromise = undefined;
    });
    return this.recoveryPromise;
  }

  private sendInitialRequest(): void {
    const socket = this.socket;
    if (!socket) return;
    sendBinary(socket, encodeVolcengineFullClientRequest({
      user: { uid: 'xdt-maker' },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: this.pcmSampleRate,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: VOLCENGINE_MODEL_NAME,
        result_type: 'full',
        show_utterances: true,
        enable_nonstream: true,
        end_window_size: VOLCENGINE_NONSTREAM_END_WINDOW_MS,
        enable_punc: true,
        enable_itn: true,
        ...(this.sourceLanguage && this.sourceLanguage.toLowerCase() !== 'auto'
          ? { language: this.sourceLanguage }
          : {}),
      },
    }));
  }

  private handleMessage(data: unknown): void {
    const message = decodeVolcengineMessage(rawDataToBytes(data));
    if (message.messageType === VOLC_MESSAGE_TYPE_SERVER_ERROR) {
      const errorMessage = this.redactError(
        extractErrorMessage(message.payload) ?? message.payloadText ?? 'Volcengine SAUC ASR failed.',
      );
      this.callback({ type: 'error', message: errorMessage, at: Date.now() });
      this.resolveFlushWaiters();
      return;
    }
    if (message.messageType !== VOLC_MESSAGE_TYPE_FULL_SERVER_RESPONSE && message.messageType !== VOLC_MESSAGE_TYPE_SERVER_ACK) {
      return;
    }

    const rawTranscript = extractTranscript(message.payload);
    const transcript = mergeRecoveredTranscript(this.sessionTranscriptPrefix, rawTranscript);
    const isDefinite = hasDefiniteUtterance(message.payload);
    const isLastResponse = isVolcengineProtocolLastResponse(message);
    if (transcript && (isDefinite || isLastResponse)) {
      this.finalizedTranscript = transcript;
      this.clearConfirmedVolcengineAudio();
    }
    if (transcript && transcript !== this.lastTranscript) {
      this.lastTranscript = transcript;
      this.callback({ type: isDefinite ? 'stable' : 'partial', text: transcript, at: Date.now() });
      if (isDefinite) this.stableEmitted = true;
    }
    if (this.finalRequested && isLastResponse) this.resolveFlushWaiters();
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private sendVolcengineAudioEntry(entry: VolcengineReplayAudioChunk, socket: WebSocketLike): boolean {
    if (socket.readyState !== OPEN) return false;
    sendBinary(socket, encodeVolcengineAudioOnlyRequest(entry.pcm, this.nextSequence()));
    entry.sent = true;
    return true;
  }

  private addUnconfirmedAudio(pcm: Uint8Array, durationMs: number, localTurnId?: number): VolcengineReplayAudioChunk {
    const entry: VolcengineReplayAudioChunk = {
      pcm,
      durationMs,
      addedAt: Date.now(),
      sent: false,
      localTurnId,
    };
    this.unconfirmedAudio.push(entry);
    return entry;
  }

  private clearUnconfirmedAudio(): void {
    this.unconfirmedAudio = [];
    this.currentLocalAudioTurnId = 1;
    this.localTurnHasVoice = false;
    this.localTurnSilenceMs = 0;
  }

  private assignVolcengineAudioTurnId(chunk: ArrayBuffer, durationMs: number): number {
    const voiced = isPcm16ChunkVoiced(chunk);
    if (voiced && this.localTurnHasVoice && this.localTurnSilenceMs >= VOLCENGINE_NONSTREAM_END_WINDOW_MS) {
      this.currentLocalAudioTurnId += 1;
      this.localTurnHasVoice = false;
      this.localTurnSilenceMs = 0;
    }
    const turnId = this.currentLocalAudioTurnId;
    if (voiced) {
      this.localTurnHasVoice = true;
      this.localTurnSilenceMs = 0;
    } else if (this.localTurnHasVoice) {
      this.localTurnSilenceMs += durationMs;
    }
    return turnId;
  }

  private clearConfirmedVolcengineAudio(): void {
    const confirmedTurnId = this.unconfirmedAudio.find((entry) => entry.sent)?.localTurnId;
    if (confirmedTurnId !== undefined) {
      this.unconfirmedAudio = this.unconfirmedAudio.filter((entry) => entry.localTurnId !== confirmedTurnId);
      if (this.currentLocalAudioTurnId <= confirmedTurnId) {
        this.currentLocalAudioTurnId = confirmedTurnId + 1;
        this.localTurnHasVoice = false;
        this.localTurnSilenceMs = 0;
      }
    } else {
      this.trimConfirmedVolcengineAudioOlderThan(Date.now() - CONFIRMED_AUDIO_RETENTION_MS);
    }
    if (this.pendingFinalAudioChunk && !this.unconfirmedAudio.includes(this.pendingFinalAudioChunk)) {
      this.pendingFinalAudioChunk = null;
    }
  }

  private trimConfirmedVolcengineAudioOlderThan(cutoffMs: number): void {
    while (this.unconfirmedAudio.length > 0 && this.unconfirmedAudio[0].sent && this.unconfirmedAudio[0].addedAt < cutoffMs) {
      this.unconfirmedAudio.shift();
    }
  }

  private async performRecover(): Promise<void> {
    const resourceId = this.credential.asr.resourceId;
    if (!resourceId) throw new Error(i18n.t('composer.voice.volcengineMissingResourceId'));

    const prefix = this.finalizedTranscript;
    this.sessionTranscriptPrefix = prefix;
    this.connected = false;
    this.sequence = 1;
    this.pendingFinalAudioChunk = null;
    this.finalRequested = false;
    this.stableEmitted = false;
    this.resolveFlushWaiters();

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === OPEN) socket.close();

    await this.openSocket(resourceId);
    if (this.stopped) return;
    const nextSocket = this.currentOpenSocket();
    if (!nextSocket) {
      throw new Error('Volcengine SAUC ASR recover reconnected without an open socket.');
    }
    const replay = [...this.unconfirmedAudio];
    for (const entry of replay) {
      if (!this.sendVolcengineAudioEntry(entry, nextSocket)) {
        throw new Error('Volcengine SAUC ASR recovery replay failed.');
      }
    }
    this.pendingFinalAudioChunk = null;
  }

  private currentOpenSocket(): WebSocketLike | null {
    const socket = this.socket;
    return socket && socket.readyState === OPEN ? socket : null;
  }

  private waitForFlush(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.flushTimeoutMs);
      this.flushResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private resolveFlushWaiters(): void {
    this.flushResolvers.splice(0).forEach((resolve) => resolve());
  }

  private resetState(): void {
    this.stopped = false;
    this.connected = false;
    this.sequence = 1;
    this.sentAudioMs = 0;
    this.pendingFinalAudioChunk = null;
    this.lastTranscript = '';
    this.finalizedTranscript = '';
    this.sessionTranscriptPrefix = '';
    this.clearUnconfirmedAudio();
    this.finalRequested = false;
    this.stableEmitted = false;
    this.resolveFlushWaiters();
  }

  private redactError(message: string): string {
    return redactMobileVoiceCredentialText(message, this.credential);
  }
}

export function buildSessionUpdateMessage(
  model: string,
  sourceLanguage: string,
  pcmSampleRate: number,
  protocolProfile: MobileRealtimeProtocolProfile,
): Record<string, unknown> {
  const language = openAiLanguageCode(sourceLanguage);
  if (protocolProfile === 'qwen-asr-server-vad') {
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
  protocolProfile: MobileRealtimeProtocolProfile,
): Record<string, unknown> {
  return {
    ...(protocolProfile === 'qwen-asr-server-vad' ? { event_id: buildRealtimeEventId('append') } : {}),
    type: 'input_audio_buffer.append',
    audio: audioBase64,
  };
}

function buildFinishSessionMessage(protocolProfile: MobileRealtimeProtocolProfile): Record<string, unknown> {
  return {
    ...(protocolProfile === 'qwen-asr-server-vad' ? { event_id: buildRealtimeEventId('finish') } : {}),
    type: 'session.finish',
  };
}

function readRealtimeProtocolProfile(credential: StoredMobileVoiceCredential): MobileRealtimeProtocolProfile {
  if (
    credential.asr.protocolProfile === 'openai-transcription-manual'
    || credential.asr.protocolProfile === 'qwen-asr-server-vad'
  ) {
    return credential.asr.protocolProfile;
  }
  throw new Error(i18n.t('composer.voice.realtimeProtocolUnsupported', { detail: credential.asr.protocolProfile ?? credential.asr.mode }));
}

function openAiLanguageCode(sourceLanguage: string): string | undefined {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;

  switch (normalized) {
    case 'chinese':
    case 'mandarin':
    case 'simplified chinese':
    case 'traditional chinese':
      return 'zh';
    case 'cantonese':
      return 'yue';
    case 'english':
      return 'en';
    case 'japanese':
      return 'ja';
    case 'korean':
      return 'ko';
  }

  const primary = normalized.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  if (typeof btoa === 'function') return btoa(binary);
  return encodeBase64(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? alphabet[triple & 63] : '=';
  }
  return output;
}

function estimatePcmDurationMs(byteLength: number, sampleRate: number): number {
  return byteLength / (sampleRate * 2 / 1000);
}

function isPcm16ChunkVoiced(chunk: ArrayBuffer): boolean {
  if (chunk.byteLength < 2) return false;
  const view = new DataView(chunk);
  let sumSquares = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < chunk.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    sumSquares += sample * sample;
    samples += 1;
  }
  if (samples === 0) return false;
  return Math.sqrt(sumSquares / samples) >= LOCAL_TURN_VOICED_RMS_THRESHOLD;
}

function realtimeErrorMessage(event: Record<string, unknown>, fallbackMessage: string): string {
  const error = event.error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return fallbackMessage;
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildRealtimeEventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function encodeVolcengineFullClientRequest(payload: Record<string, unknown>): Uint8Array {
  return encodeVolcengineRequest({
    messageType: VOLC_MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    flags: VOLC_FLAG_NO_SEQUENCE,
    serialization: VOLC_SERIALIZATION_JSON,
    compression: VOLC_COMPRESSION_GZIP,
    payload: textToBytes(JSON.stringify(payload)),
  });
}

export function encodeVolcengineAudioOnlyRequest(pcm: Uint8Array, sequence: number): Uint8Array {
  const hasPayload = pcm.length > 0;
  return encodeVolcengineRequest({
    messageType: VOLC_MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    flags: sequence < 0 ? VOLC_FLAG_NEGATIVE_SEQUENCE : VOLC_FLAG_POSITIVE_SEQUENCE,
    sequence,
    serialization: VOLC_SERIALIZATION_NONE,
    compression: hasPayload ? VOLC_COMPRESSION_GZIP : VOLC_COMPRESSION_NONE,
    payload: pcm,
  });
}

function encodeVolcengineRequest(input: {
  messageType: number;
  flags: number;
  sequence?: number;
  serialization: number;
  compression: number;
  payload: Uint8Array;
}): Uint8Array {
  const compressedPayload = input.compression === VOLC_COMPRESSION_GZIP
    ? gzip(input.payload)
    : input.payload;
  const sequenceBytes = input.flags === VOLC_FLAG_NO_SEQUENCE ? new Uint8Array(0) : new Uint8Array(4);
  if (sequenceBytes.length > 0) {
    new DataView(sequenceBytes.buffer).setInt32(0, input.sequence ?? 0, false);
  }
  const payloadSize = new Uint8Array(4);
  new DataView(payloadSize.buffer).setUint32(0, compressedPayload.length, false);
  return concatBytes(
    new Uint8Array([
      (VOLC_PROTOCOL_VERSION << 4) | VOLC_HEADER_SIZE_WORDS,
      (input.messageType << 4) | input.flags,
      (input.serialization << 4) | input.compression,
      0x00,
    ]),
    sequenceBytes,
    payloadSize,
    compressedPayload,
  );
}

export function decodeVolcengineMessage(data: Uint8Array): ParsedVolcengineMessage {
  if (data.length < 4) return { messageType: 0, flags: 0 };
  const headerSize = (data[0] & 0x0f) * 4;
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let offset = headerSize;

  if (messageType === VOLC_MESSAGE_TYPE_SERVER_ERROR) {
    if (data.length < offset + 8) return { messageType, flags };
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const code = view.getInt32(offset, false);
    offset += 4;
    const payloadSize = view.getUint32(offset, false);
    offset += 4;
    if (payloadSize <= 0 || data.length < offset + payloadSize) {
      return { messageType, flags, payload: { code } };
    }
    const payloadBytes = decodeVolcenginePayload(data.slice(offset, offset + payloadSize), compression);
    const payloadText = bytesToText(payloadBytes);
    return { messageType, flags, payload: { code, message: payloadText }, payloadText };
  }

  let sequence: number | undefined;
  if (flags === VOLC_FLAG_POSITIVE_SEQUENCE || flags === VOLC_FLAG_NEGATIVE_SEQUENCE) {
    if (data.length < offset + 4) return { messageType, flags };
    sequence = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(offset, false);
    offset += 4;
  }
  if (data.length < offset + 4) return { messageType, flags, sequence };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const payloadSize = view.getUint32(offset, false);
  offset += 4;
  if (payloadSize <= 0 || data.length < offset + payloadSize) {
    return { messageType, flags, sequence };
  }
  const payloadBytes = decodeVolcenginePayload(data.slice(offset, offset + payloadSize), compression);
  const payloadText = bytesToText(payloadBytes);
  if (serialization === VOLC_SERIALIZATION_JSON || looksLikeJson(payloadText)) {
    try {
      return { messageType, flags, sequence, payload: JSON.parse(payloadText), payloadText };
    } catch {
      return { messageType, flags, sequence, payloadText };
    }
  }
  return { messageType, flags, sequence, payloadText };
}

function decodeVolcenginePayload(payload: Uint8Array, compression: number): Uint8Array {
  return compression === VOLC_COMPRESSION_GZIP ? ungzip(payload) : payload;
}

function rawDataToBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return concatBytes(...data.map(rawDataToBytes));
  if (typeof data === 'string') return textToBytes(data);
  return new Uint8Array(0);
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

const ASCII_WORD_CHARACTER_PATTERN = /[A-Za-z0-9]/;

function isAsciiWordCharacter(character: string | undefined): boolean {
  return character !== undefined && ASCII_WORD_CHARACTER_PATTERN.test(character);
}

function canMergeRecoveredTranscriptOverlap(prefix: string, transcript: string, overlapLength: number): boolean {
  const overlap = transcript.slice(0, overlapLength);
  if (!ASCII_WORD_CHARACTER_PATTERN.test(overlap)) return true;

  const prefixOverlapStart = prefix.length - overlapLength;
  const prefixBeforeOverlap = prefixOverlapStart > 0 ? prefix.at(prefixOverlapStart - 1) : undefined;
  return !isAsciiWordCharacter(prefixBeforeOverlap) && !isAsciiWordCharacter(transcript.at(overlapLength));
}

function mergeRecoveredTranscript(prefix: string, transcript: string): string {
  const normalizedPrefix = prefix.trim();
  const normalizedTranscript = transcript.trim();
  if (!normalizedPrefix) return normalizedTranscript;
  if (!normalizedTranscript) return normalizedPrefix;
  if (
    normalizedTranscript.startsWith(normalizedPrefix)
    && canMergeRecoveredTranscriptOverlap(normalizedPrefix, normalizedTranscript, normalizedPrefix.length)
  ) {
    return normalizedTranscript;
  }

  const maxOverlap = Math.min(normalizedPrefix.length, normalizedTranscript.length);
  for (let length = maxOverlap; length >= 1; length -= 1) {
    if (
      normalizedPrefix.endsWith(normalizedTranscript.slice(0, length))
      && canMergeRecoveredTranscriptOverlap(normalizedPrefix, normalizedTranscript, length)
    ) {
      return normalizedPrefix + normalizedTranscript.slice(length);
    }
  }

  const left = normalizedPrefix.at(-1) ?? '';
  const right = normalizedTranscript.at(0) ?? '';
  if (isAsciiWordCharacter(left) && isAsciiWordCharacter(right)) {
    return `${normalizedPrefix} ${normalizedTranscript}`;
  }
  return normalizedPrefix + normalizedTranscript;
}

function hasDefiniteUtterance(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some((item) => hasDefiniteUtterance(item));
  if (!isRecord(payload)) return false;
  if (payload.definite === true) return true;
  return Object.values(payload).some((value) => hasDefiniteUtterance(value));
}

function isVolcengineProtocolLastResponse(message: ParsedVolcengineMessage): boolean {
  return message.messageType === VOLC_MESSAGE_TYPE_FULL_SERVER_RESPONSE
    && message.flags === VOLC_FLAG_NEGATIVE_SEQUENCE;
}

function collectStringFields(value: unknown, keys: Set<string>): string[] {
  if (typeof value === 'string') return [];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStringFields(item, keys));
  const result: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof child === 'string') result.push(child);
    result.push(...collectStringFields(child, keys));
  }
  return result;
}

function silencePcm16(sampleRate: number, durationMs: number): Uint8Array {
  const sampleCount = Math.max(0, Math.round(sampleRate * durationMs / 1000));
  return new Uint8Array(sampleCount * 2);
}

function buildConnectId(): string {
  return `xdt-maker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function sendBinary(socket: WebSocketLike, bytes: Uint8Array): void {
  socket.send(toExactArrayBuffer(bytes));
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return view as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function webSocketErrorMessage(
  event: { message?: string; error?: unknown },
  fallbackMessage: string,
): { message: string; specific: boolean } {
  if (typeof event.message === 'string' && event.message.trim()) {
    return { message: event.message, specific: true };
  }
  if (event.error instanceof Error && event.error.message.trim()) {
    return { message: event.error.message, specific: true };
  }
  return { message: fallbackMessage, specific: false };
}

function webSocketCloseBeforeReadyMessage(
  event: { code?: number; reason?: string },
  fallbackMessage: string,
  pendingMessage?: string,
): string {
  const closeStatus = webSocketAuthStatus(event);
  if (closeStatus) {
    return i18n.t('composer.voice.sessionExpiredOrForbidden', { status: closeStatus });
  }
  if (event.reason?.trim()) return `${fallbackMessage} (${event.reason.trim()})`;
  return pendingMessage ?? fallbackMessage;
}

function webSocketAuthStatus(event: { code?: number; reason?: string }): string | null {
  const text = `${event.code ?? ''} ${event.reason ?? ''}`;
  const match = text.match(/\b(401|403)\b/);
  return match?.[1] ?? null;
}
