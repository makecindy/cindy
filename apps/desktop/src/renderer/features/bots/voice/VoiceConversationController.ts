import type {
  VoiceConversationApi,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import type { ChatMessage } from '@/lib/makerChatStore';
import { createLogger } from '@/lib/logger';
import type { PcmChunk } from '@/voice-input/WebMicAudioEngine';
import type { SpeechPlayer } from './PcmSpeechPlayer';
import { speechChunks, VoiceReplyTracker } from './VoiceReplyTracker';
import { SpeechPlaybackQueue } from './SpeechPlaybackQueue';
import { microphoneDiagnostic } from './microphoneDiagnostics';

const log = createLogger('voice-conversation');

export type VoicePhase =
  | 'idle'
  | 'connecting'
  | 'microphone'
  | 'listening'
  | 'thinking'
  | 'preparing'
  | 'speaking'
  | 'paused'
  | 'error';
export type VoiceSnapshot = {
  phase: VoicePhase;
  transcript: string;
  unsent: string;
  level: number;
  error: 'connection' | 'microphone' | 'send' | 'speech' | null;
  muted: boolean;
  microphonePending: boolean;
  microphoneError: boolean;
};
interface Microphone {
  onPcm16k(callback: (chunk: PcmChunk) => void): void;
  start(): Promise<void>;
  stop(): Promise<unknown>;
}

/** Call-local orchestration. It never stops the companion task or answers permission prompts. */
export class VoiceConversationController {
  private state: VoiceSnapshot = {
    phase: 'idle',
    transcript: '',
    unsent: '',
    level: 0,
    error: null,
    muted: false,
    microphonePending: false,
    microphoneError: false,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private speechEpoch = 0;
  private callId: string | null = null;
  private microphone: Microphone | null = null;
  private player: SpeechPlayer | null = null;
  private unsubscribe?: () => void;
  private selection?: VoiceConversationSelection;
  private blocked = false;
  private enabled = false;
  private tracker = new VoiceReplyTracker();
  private pendingInput: string | null = null;
  private latestMessages: readonly ChatMessage[] = [];
  private sending = false;
  private inFlight: Promise<void> = Promise.resolve();
  private queued: string[] = [];
  private pendingStart: Promise<unknown> = Promise.resolve();
  private teardown: Promise<unknown> = Promise.resolve();
  private speechCandidate = false;
  private replyPhase: 'thinking' | 'preparing' | 'speaking' | null = null;
  private sentencePlayback = true;
  private replyComplete = false;
  private deferringSpeech = false;
  private playback: SpeechPlaybackQueue | null = null;
  private replyStartedAt = 0;
  private phaseStartedAt = Date.now();
  private candidateStartedAt = 0;
  private captureVersion = 0;
  private inputGeneration = 0;
  private resumingInput = false;
  private inputChange: Promise<void> = Promise.resolve();
  private pendingCapture: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      api: VoiceConversationApi;
      botId: string;
      sessionId: string;
      microphone(
        onInterrupted: () => void,
        onStateChange: (event: string, details?: Record<string, unknown>) => void,
      ): Microphone;
      player(onLevel: (level: number) => void): SpeechPlayer;
      send(
        text: string,
        onCreated: (id: string) => void,
        isCurrent: () => boolean,
      ): Promise<boolean>;
    },
  ) {}

  getSnapshot = (): VoiceSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private patch(patch: Partial<VoiceSnapshot>): void {
    if (patch.phase && patch.phase !== this.state.phase) {
      log.info('phase changed', {
        callId: this.callId,
        from: this.state.phase,
        to: patch.phase,
        elapsedMs: Date.now() - this.phaseStartedAt,
        muted: patch.muted ?? this.state.muted,
      });
      this.phaseStartedAt = Date.now();
    }
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(
    selection: VoiceConversationSelection,
    sentencePlayback = this.sentencePlayback,
  ): Promise<void> {
    if (this.blocked || this.callId || this.state.phase === 'connecting') return;
    this.selection = selection;
    this.sentencePlayback = sentencePlayback;
    this.enabled = true;
    const epoch = ++this.epoch;
    this.inputGeneration = 0;
    this.patch({
      phase: 'connecting',
      error: null,
      muted: false,
      microphonePending: false,
      microphoneError: false,
    });
    const current = () => this.enabled && epoch === this.epoch && !this.blocked;
    try {
      this.player = this.deps.player((level) => {
        if (current() && this.state.phase === 'speaking') this.patch({ level });
      });
      await this.teardown;
      if (!current()) return;
      this.unsubscribe = this.deps.api.onEvent(({ callId, inputGeneration = 0, event }) => {
        if (!current() || callId !== this.callId) return;
        if (event.type === 'ended') {
          this.end();
          return;
        }
        if (inputGeneration !== this.inputGeneration) return;
        if (this.state.muted) {
          // ASR can disconnect after its resume handshake while getUserMedia is
          // still pending. Do not report listening when that input is gone.
          if (event.type === 'error' && this.resumingInput) this.patch({ microphoneError: true });
          return;
        }
        if (event.type === 'speech-started') {
          // An acoustic onset can be noise. Pause playback without consuming
          // the reply; only a finalized, nonempty utterance replaces its owner.
          if (!this.speechCandidate) {
            this.speechCandidate = true;
            this.candidateStartedAt = Date.now();
            this.player?.pause();
            this.playback?.pause();
            log.info('reply held for possible speech', { callId, pendingInput: this.pendingInput });
            this.patch({ phase: 'listening', level: 0 });
          }
        } else if (event.type === 'speech-idle') {
          if (this.speechCandidate) {
            this.speechCandidate = false;
            this.player?.resume();
            this.playback?.resume();
            log.info('reply resumed after empty speech', {
              callId,
              pendingInput: this.pendingInput,
              heldMs: Date.now() - this.candidateStartedAt,
            });
            this.setReplyPhase(this.replyPhase);
            this.updateMessages(this.latestMessages);
          }
        } else if (event.type === 'draft') {
          this.patch({ transcript: event.text });
        } else if (event.type === 'utterance') {
          this.queued.push(event.text);
          if ([this.state.unsent, ...this.queued].join(' ').length > 16_000) this.fail('send');
          else void this.drain(epoch);
        } else if (event.type === 'error') {
          this.fail('connection', event.text);
        }
      });
      // Reserve a call id before IPC so End can cancel an in-flight ASR dial.
      this.callId = crypto.randomUUID();
      const opening = this.deps.api.start({
        ...selection,
        callId: this.callId,
        botId: this.deps.botId,
        sessionId: this.deps.sessionId,
      });
      this.pendingStart = opening
        .then(async (result) => {
          if (!current()) await this.deps.api.end(result.callId);
        })
        .catch(() => undefined);
      const result = await opening;
      if (!current()) {
        await this.pendingStart;
        return;
      }
      this.callId = result.callId;
      this.patch({ phase: 'microphone' });
      try {
        const capturing = this.openMicrophone(epoch);
        this.pendingCapture = capturing.catch(() => undefined);
        await capturing;
      } catch {
        if (current()) this.fail('microphone');
        return;
      }
      if (!current()) return;
      this.setReplyPhase(this.pendingInput ? 'thinking' : null);
      this.updateMessages(this.latestMessages);
    } catch {
      if (current()) this.fail('connection');
    }
  }

  private async openMicrophone(epoch: number): Promise<void> {
    const version = ++this.captureVersion;
    const startedAt = Date.now();
    const current = () =>
      this.enabled && epoch === this.epoch && version === this.captureVersion && !this.blocked;
    let firstFrame = true;
    let interrupted = false;
    const mic = this.deps.microphone(
      () => {
        if (!current()) return;
        interrupted = true;
        // During unmute, the caller restores the muted state without stopping TTS.
        if (!this.state.muted) this.fail('microphone');
      },
      (event, details) => {
        if (!current()) return;
        const safe = microphoneDiagnostic(event, details);
        if (safe)
          log.info('microphone capture', {
            callId: this.callId,
            elapsedMs: Date.now() - startedAt,
            ...safe,
          });
      },
    );
    this.microphone = mic;
    mic.onPcm16k(({ pcm16k }) => {
      if (!current() || !this.callId || this.state.muted) return;
      if (firstFrame) {
        firstFrame = false;
        log.info('microphone first frame', {
          callId: this.callId,
          inputGeneration: this.inputGeneration,
          elapsedMs: Date.now() - startedAt,
        });
      }
      this.deps.api.audio({
        callId: this.callId,
        pcm: pcm16k,
        inputGeneration: this.inputGeneration,
      });
      if (this.state.phase !== 'speaking') {
        const samples = new Int16Array(pcm16k);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length),
        );
        this.patch({ level: Math.min(1, rms / 5000) });
      }
    });
    try {
      await mic.start();
      if (interrupted) throw new Error('microphone_interrupted');
      if (current())
        log.info('microphone ready', { callId: this.callId, elapsedMs: Date.now() - startedAt });
    } finally {
      // getUserMedia can resolve after End. Its eventual tracks still need stopping.
      if (!current()) await mic.stop();
    }
  }

  private setReplyPhase(phase: typeof this.replyPhase): void {
    this.replyPhase = phase;
    this.patch({ phase: this.speechCandidate ? 'listening' : (phase ?? 'listening'), level: 0 });
  }

  /** Explicit stop or a committed new utterance permanently relinquishes the old reply. */
  interrupt(reason: 'user_stop' | 'new_utterance' = 'user_stop'): void {
    log.info('reply interrupted', {
      callId: this.callId,
      reason,
      pendingInput: this.pendingInput,
      ...(this.speechCandidate ? { heldMs: Date.now() - this.candidateStartedAt } : {}),
    });
    ++this.speechEpoch;
    this.playback?.cancel();
    this.playback = null;
    this.replyComplete = false;
    this.deferringSpeech = false;
    this.speechCandidate = false;
    this.replyPhase = null;
    this.tracker.interrupt();
    this.pendingInput = null;
    this.player?.cancel();
    this.player?.resume();
    if (this.callId) void this.deps.api.interrupt(this.callId).catch(() => undefined);
    if (
      this.state.phase === 'speaking' ||
      this.state.phase === 'preparing' ||
      this.state.phase === 'thinking'
    )
      this.patch({ phase: 'listening', level: 0 });
  }

  private async submit(text: string, epoch: number): Promise<void> {
    const captureVersion = this.captureVersion;
    const current = () => this.enabled && epoch === this.epoch && !this.blocked;
    const canEnqueue = () => current() && captureVersion === this.captureVersion;
    if (!current()) return;
    this.interrupt('new_utterance');
    this.setReplyPhase('thinking');
    this.patch({ transcript: '', unsent: '' });
    const replyEpoch = this.speechEpoch;
    let clientId: string | null = null;
    try {
      const accepted = await this.deps.send(
        text,
        (id) => {
          clientId = id;
        },
        canEnqueue,
      );
      if (!current()) {
        // A permission/mute boundary can cancel preflight before enqueue. Wait
        // for its outcome before resuming, retaining only genuinely unsent text.
        if (!accepted && this.enabled)
          this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
        return;
      }
      if (!accepted || !clientId) {
        if (!canEnqueue()) {
          this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
          this.setReplyPhase(null);
          return;
        }
        this.fail('send', text);
        return;
      }
      if (replyEpoch !== this.speechEpoch) return;
      log.info('voice input accepted', { callId: this.callId, clientId, characters: text.length });
      this.pendingInput = clientId;
      this.replyStartedAt = Date.now();
      this.tracker.expect(clientId);
      this.updateMessages(this.latestMessages);
    } catch {
      if (canEnqueue()) this.fail('send', text);
      else if (this.enabled) {
        this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
        if (current() && replyEpoch === this.speechEpoch) this.setReplyPhase(null);
      }
    }
  }

  private async drain(epoch: number): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queued.length && this.enabled && epoch === this.epoch && !this.blocked) {
        // A muted preflight can settle after input has resumed. Merge retained
        // text here so a newer queued utterance cannot erase that late result.
        const text = [this.state.unsent, this.queued.shift()!].filter(Boolean).join(' ');
        this.inFlight = this.submit(text, epoch);
        await this.inFlight;
      }
    } finally {
      this.sending = false;
      if (this.queued.length && this.callId && this.enabled && !this.blocked)
        void this.drain(this.epoch);
    }
  }

  updateMessages(messages: readonly ChatMessage[]): void {
    this.latestMessages = messages;
    if (
      !this.enabled ||
      !this.callId ||
      this.blocked ||
      !this.pendingInput ||
      this.speechCandidate ||
      this.deferringSpeech
    )
      return;
    const inputIndex = messages.findIndex((message) => message.clientId === this.pendingInput);
    if (
      inputIndex >= 0 &&
      messages.slice(inputIndex + 1).some((message) => message.role === 'user')
    ) {
      this.interrupt();
      return;
    }
    const reply = this.tracker.take(messages, this.sentencePlayback);
    if (!reply) {
      if (!this.tracker.hasPendingReply && !this.replyComplete) {
        log.info('reply ownership superseded', {
          callId: this.callId,
          pendingInput: this.pendingInput,
        });
        this.interrupt();
      }
      return;
    }
    if (reply.invalidated) {
      log.info('speech prefix replaced', { callId: this.callId, replyId: reply.id });
      this.interrupt();
      return;
    }
    this.replyComplete = reply.complete;
    log.info('reply speech available', {
      callId: this.callId,
      replyId: reply.id,
      characters: reply.text.length,
      complete: reply.complete,
      elapsedMs: Date.now() - this.replyStartedAt,
    });
    if (!this.playback) this.playback = this.createPlayback();
    this.playback?.append(
      speechChunks(reply.text, this.sentencePlayback ? 500 : 3_500),
      reply.complete,
    );
  }

  private createPlayback(): SpeechPlaybackQueue | null {
    const epoch = this.epoch;
    const speechEpoch = ++this.speechEpoch;
    const callId = this.callId;
    const player = this.player;
    if (!callId || !player) return null;
    const current = () =>
      epoch === this.epoch && speechEpoch === this.speechEpoch && this.enabled && !this.blocked;
    return new SpeechPlaybackQueue({
      api: this.deps.api,
      callId,
      prefix: String(speechEpoch),
      player,
      prefetch: this.sentencePlayback,
      phase: (phase) => {
        if (current()) this.setReplyPhase(phase);
      },
      drained: () => {
        if (!current()) return;
        this.pendingInput = null;
        this.playback = null;
      },
      deferred: (alreadyPlayed) => {
        if (!current()) return;
        if (alreadyPlayed || !this.pendingInput) {
          this.interrupt();
          return;
        }
        ++this.speechEpoch;
        this.playback = null;
        this.replyComplete = false;
        this.deferringSpeech = true;
        this.tracker.expect(this.pendingInput);
        this.tracker.deferUntilComplete();
        this.setReplyPhase('thinking');
        const deferredEpoch = this.speechEpoch;
        void this.deps.api
          .interrupt(callId)
          .then(() => {
            if (epoch === this.epoch && deferredEpoch === this.speechEpoch) {
              this.deferringSpeech = false;
              this.updateMessages(this.latestMessages);
            }
          })
          .catch(() => {
            if (epoch === this.epoch && deferredEpoch === this.speechEpoch) this.fail('speech');
          });
      },
      failed: () => {
        if (current()) this.fail('speech');
      },
      diagnostic: (event, details) => {
        if (current())
          log.info(event, { callId, elapsedMs: Date.now() - this.replyStartedAt, ...details });
      },
    });
  }

  finishUtterance(): void {
    const epoch = this.epoch;
    if (this.callId && !this.state.muted && !this.state.microphonePending)
      void this.deps.api.finishUtterance(this.callId).catch(() => {
        if (epoch === this.epoch) this.fail('connection');
      });
  }

  setBlocked(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    if (blocked && this.enabled) {
      const unsent = [this.state.unsent, ...this.queued, this.state.transcript]
        .filter(Boolean)
        .join(' ');
      this.release();
      this.patch({
        phase: 'paused',
        unsent,
        transcript: '',
        level: 0,
        microphonePending: false,
        microphoneError: false,
      });
    }
    // Confirmation completion does not silently restart a microphone.
  }

  toggleMute(): Promise<void> {
    if (
      !this.callId ||
      this.state.microphonePending ||
      ['connecting', 'microphone'].includes(this.state.phase)
    )
      return this.inputChange;
    const epoch = this.epoch;
    const callId = this.callId;
    const unmuting = this.state.muted;
    this.resumingInput = unmuting;
    const startedAt = Date.now();
    const current = () =>
      this.enabled && epoch === this.epoch && this.callId === callId && !this.blocked;
    this.patch({ microphonePending: true, microphoneError: false });
    if (!unmuting) {
      ++this.captureVersion;
      const unsent = [this.state.unsent, ...this.queued, this.state.transcript]
        .filter(Boolean)
        .join(' ');
      this.queued = [];
      this.patch({ muted: true, transcript: '', unsent });
      // A possible interruption can no longer be confirmed with the mic closed.
      // Restore the held reply instead of discarding its playback/ownership.
      if (this.speechCandidate) {
        this.speechCandidate = false;
        this.player?.resume();
        this.playback?.resume();
        log.info('reply resumed on microphone mute', {
          callId,
          heldMs: Date.now() - this.candidateStartedAt,
        });
      }
      this.setReplyPhase(this.replyPhase);
      this.updateMessages(this.latestMessages);
    }
    const mic = this.microphone;
    if (!unmuting) this.microphone = null;
    this.inputChange = (async () => {
      let stage: 'asr' | 'microphone' = 'asr';
      try {
        if (!unmuting) {
          const [result] = await Promise.all([
            this.deps.api.setInputMuted(callId, true),
            mic?.stop().catch(() => {
              // Tracks and PCM forwarding stop before AudioContext cleanup.
              // A failed context close must not silence the companion's reply.
              log.warn('microphone cleanup failed', { callId });
            }),
          ]);
          if (current()) this.inputGeneration = result.inputGeneration;
        } else {
          const result = await this.deps.api.setInputMuted(callId, false);
          if (!current()) return;
          this.inputGeneration = result.inputGeneration;
          stage = 'microphone';
          await this.openMicrophone(epoch);
          if (!current()) return;
          if (this.state.microphoneError) {
            stage = 'asr';
            throw new Error('input_ended');
          }
          this.patch({ muted: false });
        }
        if (current())
          log.info('microphone mute changed', {
            callId,
            muted: !unmuting,
            elapsedMs: Date.now() - startedAt,
          });
      } catch {
        if (!current()) return;
        if (!unmuting) {
          this.fail('connection');
          return;
        }
        // Failure to restore capture must not cancel the reply the user is hearing.
        ++this.captureVersion;
        const failedMic = this.microphone;
        this.microphone = null;
        this.patch({ muted: true, microphoneError: true });
        await Promise.allSettled([failedMic?.stop(), this.deps.api.setInputMuted(callId, true)]);
        log.warn('microphone resume failed', { callId, stage, elapsedMs: Date.now() - startedAt });
      } finally {
        if (current()) {
          this.resumingInput = false;
          this.patch({ microphonePending: false });
        }
      }
    })();
    return this.inputChange;
  }

  retryUnsent(): void {
    if (!this.state.unsent || !this.callId || this.blocked) return;
    const text = this.state.unsent;
    this.patch({ unsent: '' });
    this.queued.push(text);
    void this.drain(this.epoch);
  }

  private fail(error: VoiceSnapshot['error'], text?: string): void {
    log.warn('voice mode failed', { callId: this.callId, phase: this.state.phase, reason: error });
    const unsent = [text || this.state.transcript || this.state.unsent, ...this.queued]
      .filter(Boolean)
      .join(' ');
    this.release();
    this.patch({
      phase: 'error',
      error,
      unsent,
      transcript: '',
      level: 0,
      microphonePending: false,
      microphoneError: false,
    });
  }

  private release(): void {
    ++this.epoch;
    this.resumingInput = false;
    ++this.captureVersion;
    ++this.speechEpoch;
    if (this.playback) {
      this.playback.cancel();
      this.playback = null;
      this.tracker.interrupt();
      this.pendingInput = null;
    }
    this.replyComplete = false;
    this.deferringSpeech = false;
    this.speechCandidate = false;
    this.replyPhase = null;
    this.queued = [];
    const callId = this.callId;
    const microphone = this.microphone;
    this.callId = null;
    this.microphone = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.player?.close();
    this.player = null;
    this.teardown = Promise.allSettled([
      this.teardown,
      this.pendingStart,
      this.pendingCapture,
      this.inputChange,
      this.inFlight,
      microphone?.stop(),
      callId ? this.deps.api.end(callId) : undefined,
    ]);
  }

  end(): void {
    this.enabled = false;
    this.release();
    this.tracker.interrupt();
    this.pendingInput = null;
    this.patch({
      phase: 'idle',
      transcript: '',
      level: 0,
      muted: false,
      microphonePending: false,
      microphoneError: false,
    });
  }
}
